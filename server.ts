// server.ts — Express server with Vite middleware for RAG / STAIR Research Studio.
import express from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
dotenv.config();

import { registry } from './src/server/harness/registry.ts';
import { verifyModelLive } from './src/server/harness/verifier.ts';
import { routeWithArgon } from './src/server/harness/router.ts';
import { evaluateWithJudge } from './src/server/harness/judge.ts';
import { runResearchDiscovery } from './src/server/harness/research.ts';
import { taskManager } from './src/server/harness/taskManager.ts';
import { indexCache } from './src/server/indexCache.ts';
import {
  getCorpusData,
  saveCorpusData,
  getBenchmarkQuestions,
  runCanonicalBm25Evaluation,
  runChunkingStrategyComparison,
} from './src/server/evalRunner.ts';
import { searchBm25 } from './src/lib/bm25.mjs';

const app = express();
const PORT = 3000;

app.use(express.json());

// 1. Model Registry & Verification Endpoints
app.get('/api/harness/registry', (req, res) => {
  res.json({
    models: registry.getAllRegistrations(),
    telemetry: registry.getTelemetryLogs().slice(0, 50),
  });
});

app.post('/api/harness/verify', async (req, res) => {
  const { role } = req.body;
  if (!role) return res.status(400).json({ error: 'Missing role' });
  try {
    const updated = await verifyModelLive(role);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/harness/config', (req, res) => {
  const { role, configuredIdentifier, systemPrompt } = req.body;
  if (!role) return res.status(400).json({ error: 'Missing role' });
  try {
    const updated = registry.updateRegistration(role, {
      ...(configuredIdentifier ? { configuredIdentifier, verificationState: 'unverified' } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 2. Specialized Harness Invocation Endpoints
app.post('/api/harness/router', async (req, res) => {
  try {
    const result = await routeWithArgon(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/harness/judge', async (req, res) => {
  try {
    const result = await evaluateWithJudge(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 3. Autonomous Research Acquisition Agent Endpoints
app.post('/api/research/start', async (req, res) => {
  const { query, venues } = req.body;
  if (!query) return res.status(400).json({ error: 'Query is required' });
  try {
    const targetVenues = Array.isArray(venues) && venues.length ? venues : ['arXiv', 'Google Research'];
    const task = taskManager.createTask(query, targetVenues);
    // Pass existing task.taskId so background runner updates the exact same task!
    runResearchDiscovery(query, targetVenues, task.taskId).catch((err) => {
      console.error('Research task failed:', err);
    });
    res.json(task);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/research/tasks', (req, res) => {
  res.json({ tasks: taskManager.getAllTasks() });
});

app.get('/api/research/tasks/:id', (req, res) => {
  const task = taskManager.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// Human Ingestion Approval Gate
app.post('/api/research/approve', (req, res) => {
  const { taskId, paperId, action } = req.body; // action: 'approved' | 'rejected'
  if (!taskId || !paperId || !action) {
    return res.status(400).json({ error: 'taskId, paperId, and action are required' });
  }

  try {
    const paper = taskManager.setPaperStatus(taskId, paperId, action);
    if (action === 'approved') {
      const corpus = getCorpusData();
      if (!corpus.docs.some((d: any) => d.doc_id === paper.id)) {
        corpus.docs.push({
          doc_id: paper.id,
          title: paper.title,
          sha256: paper.sha256,
          text: paper.extractedMarkdown,
          sections: paper.sections,
          metadata: {
            authors: paper.authors,
            year: paper.year,
            venue: paper.venue,
            url: paper.url,
            acquisitionMode: paper.acquisitionMode,
          },
        });
        saveCorpusData(corpus);
      }
    }
    res.json({ success: true, paper });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 4. Corpus, Questions & Multi-Arm Retrieval Endpoints
app.get('/api/corpus', (req, res) => {
  const corpus = getCorpusData();
  const questions = getBenchmarkQuestions(corpus);
  res.json({ ...corpus, questionCount: questions.length });
});

app.get('/api/questions', (req, res) => {
  const corpus = getCorpusData();
  res.json({ questions: getBenchmarkQuestions(corpus) });
});

app.post('/api/retrieval/query', async (req, res) => {
  const {
    query,
    arm = 'bm25',
    k = 5,
    chunking = 'fixed512',
    minTailFraction = 0.25,
  } = req.body;
  if (!query) return res.status(400).json({ error: 'Query is required' });

  const startMs = Date.now();
  try {
    const corpus = getCorpusData();
    const { entry, cacheHit } = await indexCache.getOrBuildIndex(
      corpus.docs,
      chunking,
      Number(minTailFraction ?? 0.25)
    );

    const enrichResult = (r: any) => {
      const doc = entry.docsMap.get(r.doc_id);
      const sec = doc?.sections?.find((s: any) => s.section_id === r.section_id);
      const snippet = doc ? doc.text.slice(r.char_start, r.char_end) : '';
      return {
        ...r,
        heading: sec?.heading ?? r.section_id,
        snippet,
      };
    };

    if (arm === 'bm25') {
      const rawResults = entry.bm25Index.query(query, Number(k));
      const results = rawResults.map((r: any) =>
        enrichResult({
          chunk_id: r.id,
          ...r.metadata,
          score: Number(r.score.toFixed(6)),
        })
      );
      return res.json({
        arm: 'bm25',
        chunking,
        indexCached: cacheHit,
        queryLatencyMs: Date.now() - startMs,
        invariants: entry.invariants,
        results,
      });
    }

    if (arm === 'stair' || arm === 'hybrid') {
      // Build ToC strictly without document bodies for Argon
      const toc = corpus.docs.map((d: any) => ({
        doc_id: d.doc_id,
        title: d.title,
        sections: (d.sections || []).map((s: any) => ({
          section_id: s.section_id,
          heading: s.heading,
          level: s.level || 1,
        })),
      }));

      const routing = await routeWithArgon({ query, toc });
      if (arm === 'stair') {
        const routedResults = routing.selected_section_ids.map((qualId: string, idx: number) => {
          const [doc_id, section_id] = qualId.split('::');
          const doc = entry.docsMap.get(doc_id);
          const sec = doc?.sections?.find((s: any) => s.section_id === section_id);
          return enrichResult({
            chunk_id: `${doc_id}::section::${section_id}`,
            doc_id,
            section_id,
            char_start: sec?.char_start ?? 0,
            char_end: sec?.char_end ?? 0,
            score: Number((1 - idx * 0.08).toFixed(4)),
          });
        });

        return res.json({
          arm: 'stair',
          chunking,
          indexCached: cacheHit,
          queryLatencyMs: Date.now() - startMs,
          routing,
          results: routedResults,
        });
      }

      // Hybrid (Arm D): Filter chunks inside Argon's routed sections, then rank with BM25 + global fallback fill
      const routedSet = new Set(routing.selected_section_ids);
      const inRouteChunks = entry.chunks.filter((c: any) =>
        routedSet.has(`${c.doc_id}::${c.section_id}`)
      );

      const primaryHits =
        inRouteChunks.length > 0
          ? searchBm25({
              chunks: inRouteChunks,
              questions: [{ qid: 'user_q', question: query }],
              depth: Number(k),
              docsMap: entry.docsMap as any,
            })[0]?.retrieved ?? []
          : [];

      const seenChunkIds = new Set(primaryHits.map((h: any) => h.chunk_id));
      let combined = [...primaryHits];

      if (combined.length < Number(k)) {
        const fallbackHits = entry.bm25Index
          .query(query, Number(k) * 2)
          .map((r: any) => ({
            chunk_id: r.id,
            ...r.metadata,
            score: Number((r.score * 0.85).toFixed(6)),
          }))
          .filter((h: any) => !seenChunkIds.has(h.chunk_id));
        combined = [...combined, ...fallbackHits].slice(0, Number(k));
      }

      return res.json({
        arm: 'hybrid',
        chunking,
        indexCached: cacheHit,
        queryLatencyMs: Date.now() - startMs,
        routing,
        results: combined.map(enrichResult),
      });
    }

    // Arm A: Dense mock (explicitly flagged non-evaluative)
    return res.json({
      arm: 'dense',
      chunking,
      indexCached: cacheHit,
      queryLatencyMs: Date.now() - startMs,
      nonEvaluative: true,
      note: 'Mock infrastructure mode (non-evaluative; live EmbeddingGemma 2 endpoint unavailable)',
      results: entry.chunks.slice(0, Number(k)).map((c: any, i: number) =>
        enrichResult({
          chunk_id: c.chunk_id,
          doc_id: c.doc_id,
          section_id: c.section_id,
          char_start: c.char_start,
          char_end: c.char_end,
          n_tokens: c.n_tokens,
          score: Number((0.92 - i * 0.05).toFixed(4)),
        })
      ),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 5. Canonical Deterministic Evaluation Endpoint (executes eval.mjs)
app.post('/api/retrieval/evaluate', async (req, res) => {
  const { chunking = 'fixed512', minTailFraction = 0.25 } = req.body ?? {};
  try {
    const evalOutput = await runCanonicalBm25Evaluation(chunking, Number(minTailFraction ?? 0.25));
    res.json(evalOutput);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/retrieval/performance-trends', async (req, res) => {
  try {
    const trends = await runChunkingStrategyComparison();
    res.json({ trends });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Setup Vite dev server middlewares
async function startServer() {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });

  app.use(vite.middlewares);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RAG / STAIR Research Studio dev server running on port ${PORT}`);
  });
}

startServer();

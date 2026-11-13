// indexCache.ts — High-performance in-memory & disk cache for chunked corpora and compiled BM25 indices.
// Eliminates the bottleneck of re-chunking and re-indexing on every query request.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chunkCorpus, checkChunks, parseChunking } from "../lib/chunkers.mjs";
import { createMockEmbedder } from "../lib/embedders.mjs";
import { BM25Index, DEFAULT_BM25_PARAMS } from "../lib/bm25.mjs";

export interface CachedCorpusIndex {
  fingerprint: string;
  chunking: string;
  minTailFraction: number;
  docsMap: Map<string, any>;
  chunks: any[];
  bm25Index: BM25Index;
  invariants: { errors: string[]; warnings: string[] };
  builtAt: string;
}

class CorpusIndexCache {
  private cache: Map<string, CachedCorpusIndex> = new Map();
  private tokenizer = createMockEmbedder({ dim: 768 });

  computeFingerprint(corpusDocs: any[], chunking: string, minTailFraction: number): string {
    const h = createHash("sha256");
    h.update(`${chunking}|${minTailFraction}\n`);
    for (const d of corpusDocs) {
      h.update(`${d.doc_id}|${d.text?.length ?? 0}|${createHash("sha256").update(d.text ?? "").digest("hex")}\n`);
    }
    return h.digest("hex");
  }

  async getOrBuildIndex(
    corpusDocs: any[],
    chunking = "fixed512",
    minTailFraction = 0.25
  ): Promise<{ entry: CachedCorpusIndex; cacheHit: boolean }> {
    const fingerprint = this.computeFingerprint(corpusDocs, chunking, minTailFraction);
    const existing = this.cache.get(fingerprint);
    if (existing) {
      return { entry: existing, cacheHit: true };
    }

    const docsMap = new Map<string, any>(corpusDocs.map((d: any) => [d.doc_id, d]));
    const spec = parseChunking(chunking);
    const sectionMaxTokens = 8000;
    const chunks = await chunkCorpus(
      docsMap,
      chunking,
      { section_max_body_tokens: sectionMaxTokens, min_tail_fraction: minTailFraction },
      this.tokenizer
    );

    const budget = spec.kind === "fixed" && spec.budget ? spec.budget : sectionMaxTokens;
    const tailSlack = spec.kind === "fixed" && spec.budget && minTailFraction > 0 ? Math.ceil(spec.budget * minTailFraction) : 0;
    const invariants = checkChunks(docsMap, chunks, { budget, tailSlack } as any);

    // Persist chunk file for canonical eval.mjs --chunks compatibility
    try {
      const chunkFilePath = `data/chunks/${chunking}.jsonl`;
      mkdirSync(dirname(chunkFilePath), { recursive: true });
      writeFileSync(chunkFilePath, chunks.map((c: any) => JSON.stringify(c)).join("\n") + "\n");
    } catch {
      // Non-fatal if disk write restricted in test env
    }

    // Build BM25 index once for all subsequent queries
    const bm25Docs = chunks.map((c: any) => {
      const d = docsMap.get(c.doc_id);
      const text = d ? d.text.slice(c.char_start, c.char_end) : "";
      return {
        id: c.chunk_id,
        text,
        metadata: {
          doc_id: c.doc_id,
          section_id: c.section_id,
          char_start: c.char_start,
          char_end: c.char_end,
          n_tokens: c.n_tokens,
          merged_tail: Boolean(c.merged_tail),
        },
      };
    });

    const bm25Index = new BM25Index(bm25Docs, DEFAULT_BM25_PARAMS);

    const entry: CachedCorpusIndex = {
      fingerprint,
      chunking,
      minTailFraction,
      docsMap,
      chunks,
      bm25Index,
      invariants,
      builtAt: new Date().toISOString(),
    };

    this.cache.set(fingerprint, entry);
    return { entry, cacheHit: false };
  }

  invalidateAll() {
    this.cache.clear();
  }
}

export const indexCache = new CorpusIndexCache();

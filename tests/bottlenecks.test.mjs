import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { indexCache } from "../src/server/indexCache.ts";
import { filterValidToCSections } from "../src/server/harness/router.ts";
import { buildStructuredMarkdownDocument } from "../src/server/harness/research.ts";
import {
  getCorpusData,
  getBenchmarkQuestions,
  runCanonicalBm25Evaluation,
} from "../src/server/evalRunner.ts";
import { chunkDocument, checkChunks } from "../src/lib/chunkers.mjs";
import { createMockEmbedder } from "../src/lib/embedders.mjs";

test("indexCache builds once, validates invariants, and hits cache on subsequent queries", async () => {
  indexCache.invalidateAll();
  const corpus = getCorpusData();

  const first = await indexCache.getOrBuildIndex(corpus.docs, "fixed512", 0.25);
  assert.equal(first.cacheHit, false, "First call builds the index");
  assert.deepEqual(first.entry.invariants.errors, [], "Zero chunk invariant errors");
  assert.ok(first.entry.chunks.length >= 10, "Chunks generated across all sections");

  const second = await indexCache.getOrBuildIndex(corpus.docs, "fixed512", 0.25);
  assert.equal(second.cacheHit, true, "Second call hits the in-memory cache without re-chunking");
  assert.equal(first.entry.fingerprint, second.entry.fingerprint);

  // Different chunking spec builds a separate entry
  const sectionIdx = await indexCache.getOrBuildIndex(corpus.docs, "section", 0.25);
  assert.equal(sectionIdx.cacheHit, false);
  assert.deepEqual(sectionIdx.entry.invariants.errors, []);
});

test("filterValidToCSections strips hallucinated section IDs and records them in invalid", () => {
  const toc = [
    {
      doc_id: "doc_a",
      title: "Doc A",
      sections: [
        { section_id: "s1", heading: "Intro", level: 1 },
        { section_id: "s2", heading: "Methods", level: 1 },
      ],
    },
  ];

  const { valid, invalid } = filterValidToCSections(toc, [
    "doc_a::s2",
    "doc_a::s99_hallucinated",
    "doc_a::s2", // duplicate
    "unknown_doc::s1",
  ]);

  assert.deepEqual(valid, ["doc_a::s2"]);
  assert.deepEqual(invalid, ["doc_a::s99_hallucinated", "unknown_doc::s1"]);
});

test("buildStructuredMarkdownDocument preserves exact UTF-16 offsets and passes checkChunks", async () => {
  const { markdown, sha256, sections } = buildStructuredMarkdownDocument(
    "Test Paper Title\r\n",
    [
      { heading: "Abstract", body: "This is the verbatim abstract.\r\nLine two of abstract.", level: 1 },
      { heading: "1. Introduction", body: "Real extracted introduction paragraph from URL.", level: 1 },
    ]
  );

  assert.equal(markdown.includes("\r"), false, "CRLF must be normalized to LF");
  assert.equal(sections.length, 2);
  assert.ok(sha256.length === 64);

  const doc = { doc_id: "test_paper", title: "Test Paper Title", text: markdown, sha256, sections };
  const docsMap = new Map([[doc.doc_id, doc]]);
  const tok = createMockEmbedder();
  const chunks = await chunkDocument(doc, "fixed512", { section_max_body_tokens: 8000, min_tail_fraction: 0.25 }, tok);
  const check = checkChunks(docsMap, chunks, { budget: 512, tailSlack: 128 });
  assert.deepEqual(check.errors, []);
});

test("canonical eval.mjs validate and score succeed with zero errors on benchmark corpus", async () => {
  const corpus = getCorpusData();
  const questions = getBenchmarkQuestions(corpus);
  assert.ok(questions.length >= 6);

  const valProc = spawnSync(
    process.execPath,
    ["eval.mjs", "validate", "--questions", "data/questions.jsonl", "--corpus", "data/corpus.json"],
    { encoding: "utf8" }
  );
  assert.equal(valProc.status, 0, `eval.mjs validate failed: ${valProc.stdout}\n${valProc.stderr}`);
  assert.ok(valProc.stdout.includes("valid"));

  const evalResult = await runCanonicalBm25Evaluation("fixed512", 0.25);
  assert.deepEqual(evalResult.invariants.errors, []);
  assert.equal(evalResult.report.overall.n, 5, "5 answerable questions scored");
  assert.equal(evalResult.report.unanswerable.n, 1, "1 unanswerable question tracked separately");
  assert.ok(evalResult.report.overall.hit >= 0.8, `Expected high BM25 Hit@5 on benchmark, got ${evalResult.report.overall.hit}`);
  assert.ok(Array.isArray(evalResult.report.overall.hit_ci95), "Bootstrap 95% CI computed");
});

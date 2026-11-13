// node --test ingest/test_tail_merge.mjs      (run from the rag-eval root)
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkDocument, checkChunks } from "./chunkers.mjs";
import { createMockEmbedder } from "./embedders.mjs";
import { loadCorpus } from "./ingest.mjs";
import { runBm25 } from "../stair/retrieve.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = "stair/fixtures/corpus.toc.example.json";
const sh = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
const jsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const tok = createMockEmbedder(); // regex tokenizer: every "w12"-style word is exactly one token
const char4 = { id: "char4", countBatch: async (ts) => ts.map((t) => Math.ceil(t.length / 4)) }; // deliberately non-additive

const oneSection = (nWords) => {
  const text = Array.from({ length: nWords }, (_, i) => `w${i}`).join(" ");
  return { doc_id: "d", title: "D", text, sections: [{ section_id: "s1", heading: "S", char_start: 0, char_end: text.length }] };
};
const docsOf = (d) => new Map([[d.doc_id, d]]);
const run = (doc, chunking, frac, t = tok, extra = {}) => chunkDocument(doc, chunking, { section_max_body_tokens: 8000, ...(frac === undefined ? {} : { min_tail_fraction: frac }), ...extra }, t);
const sizes = (chunks) => chunks.map((c) => c.n_tokens);

test("a short trailing fragment is absorbed into the previous window; offsets stay exact", async () => {
  const d = oneSection(22); // fixed10 -> windows of 10, 10 and a 2-token tail; minTail = ceil(10 * 0.25) = 3
  const off = await run(d, "fixed10", 0), on = await run(d, "fixed10", 0.25);
  assert.deepEqual(sizes(off), [10, 10, 2], "old behavior: a 2-token fragment");
  assert.deepEqual(sizes(on), [10, 12]);
  assert.deepEqual(on.map((c) => !!c.merged_tail), [false, true]);
  assert.equal(on[1].char_start, off[1].char_start, "the merged chunk starts exactly where the previous window started");
  assert.equal(on[1].char_end, off[2].char_end, "and ends exactly where the tail ended");
  assert.equal(on[0].char_start, off[0].char_start); assert.equal(on[0].char_end, off[0].char_end, "earlier windows are untouched");
  for (const c of on) assert.equal(d.text.slice(c.char_start, c.char_end), d.text.slice(c.char_start, c.char_end).trim());
  assert.equal(d.text.slice(on[1].char_start, on[1].char_end).split(" ").length, 12);
  assert.ok(on.at(-1).chunk_id.endsWith("::w1"), "ids stay sequential");
  assert.deepEqual(checkChunks(docsOf(d), on, { budget: 10, tailSlack: 3 }).errors, []);
  assert.equal(checkChunks(docsOf(d), on, { budget: 10, tailSlack: 3 }).warnings.length, 0);
});

test("a one-word tail is absorbed (the case that distorts BM25)", async () => {
  const on = await run(oneSection(21), "fixed10", 0.25);
  assert.deepEqual(sizes(on), [10, 11]);
});

test("normal chunk boundaries are untouched: tails at or above the threshold stay separate", async () => {
  assert.deepEqual(sizes(await run(oneSection(25), "fixed10", 0.25)), [10, 10, 5], "5-token tail");
  assert.deepEqual(sizes(await run(oneSection(23), "fixed10", 0.25)), [10, 10, 3], "tail exactly at the threshold is kept (strictly-less-than rule)");
  assert.deepEqual(sizes(await run(oneSection(22), "fixed10", 0.25)), [10, 12], "one below the threshold is merged");
  assert.deepEqual(sizes(await run(oneSection(20), "fixed10", 0.25)), [10, 10], "evenly divisible: nothing to merge");
  const exact = await run(oneSection(30), "fixed10", 0.25);
  assert.deepEqual(exact.map((c) => !!c.merged_tail), [false, false, false]);
});

test("a section that fits in a single window is never merged or altered", async () => {
  const on = await run(oneSection(2), "fixed10", 0.9);
  assert.deepEqual([sizes(on), on[0].merged_tail], [[2], undefined]);
  assert.equal((await run(oneSection(10), "fixed10", 0.25)).length, 1);
});

test("works with overlapping windows", async () => {
  const d = oneSection(18); // fixed10o3: windows 10, 10 (overlapping by 3) and a 4-token tail; minTail = ceil(10 * 0.5) = 5
  const off = await run(d, "fixed10o3", 0), on = await run(d, "fixed10o3", 0.5);
  assert.deepEqual(sizes(off), [10, 10, 4]);
  assert.deepEqual(sizes(on), [10, 11]);
  assert.equal(on[1].char_start, off[1].char_start); assert.equal(on[1].char_end, off[2].char_end);
  assert.ok(on[1].char_start < on[0].char_end, "the overlap between the first two windows is preserved");
  assert.deepEqual(checkChunks(docsOf(d), on, { budget: 10, tailSlack: 5 }).errors, [], "no text lost");
});

test("oversize-section splitting is never merged (its cap is a hard limit)", async () => {
  const d = oneSection(22);
  const on = await run(d, "section", 0.25, tok, { section_max_body_tokens: 10 });
  assert.deepEqual(sizes(on), [10, 10, 2]);
  assert.ok(on.every((c) => c.oversize_split && !c.merged_tail && c.n_tokens <= 10));
});

test("off by default and invalid values are rejected", async () => {
  const d = oneSection(22);
  assert.deepEqual(await run(d, "fixed10", undefined), await run(d, "fixed10", 0), "no option = old behavior exactly");
  for (const bad of [-0.1, 1, 2, "banana"]) await assert.rejects(run(d, "fixed10", bad), /min_tail_fraction/, String(bad));
});

test("n_tokens is the real count even with a non-additive tokenizer, and no text is lost", async () => {
  const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const d = { doc_id: "d", title: "D", text, sections: [{ section_id: "s1", heading: "S", char_start: 0, char_end: text.length }] };
  const on = await run(d, "fixed12", 0.25, char4);
  for (const c of on) assert.equal(c.n_tokens, Math.ceil(d.text.slice(c.char_start, c.char_end).length / 4));
  const minTail = 3;
  assert.deepEqual(checkChunks(docsOf(d), on, { budget: 12, tailSlack: minTail }).errors, []);
  assert.ok(on.every((c) => c.n_tokens <= 12 + minTail));
});

test("checkChunks: slack applies only to merged chunks", () => {
  const d = oneSection(30);
  const mk = (extra) => [{ chunk_id: "d::x::s1::w0", doc_id: "d", section_id: "s1", char_start: 0, char_end: d.text.length, n_tokens: 12, chunking: "fixed10", ...extra }];
  assert.equal(checkChunks(docsOf(d), mk({ merged_tail: true }), { budget: 10, tailSlack: 3 }).warnings.length, 0);
  assert.equal(checkChunks(docsOf(d), mk({ merged_tail: true }), { budget: 10, tailSlack: 0 }).warnings.length, 1);
  assert.equal(checkChunks(docsOf(d), mk({}), { budget: 10, tailSlack: 3 }).warnings.length, 1, "an ordinary over-budget chunk still warns");
});

test("fixture papers: no fragments left in multi-chunk sections; unaffected chunkings are identical", async () => {
  const docs = loadCorpus(join(ROOT, FIXTURE));
  for (const [chunking, budget] of [["fixed12", 12], ["fixed16", 16], ["fixed24", 24]]) {
    const minTail = Math.ceil(budget * 0.25);
    let merged = 0;
    for (const doc of docs.values()) {
      const on = await run(doc, chunking, 0.25);
      const bySection = new Map();
      for (const c of on) bySection.set(c.section_id, [...(bySection.get(c.section_id) ?? []), c]);
      for (const cs of bySection.values()) if (cs.length > 1) for (const c of cs) assert.ok(c.n_tokens >= minTail, `${c.chunk_id} has only ${c.n_tokens} tokens`);
      merged += on.filter((c) => c.merged_tail).length;
      assert.deepEqual(checkChunks(docsOf(doc), on, { budget, tailSlack: minTail }).errors, [], `${doc.doc_id} ${chunking}`);
      assert.ok(on.length <= (await run(doc, chunking, 0)).length, "merging can only reduce the chunk count");
    }
    assert.ok(merged > 0, `${chunking}: the fixtures contain short tails, so something must merge`);
  }
  for (const doc of docs.values()) for (const chunking of ["section", "fixed512"])
    assert.deepEqual(await run(doc, chunking, 0.25), await run(doc, chunking, 0), `${doc.doc_id}/${chunking}: nothing short, nothing changes`);
});

test("BM25 no longer ranks a 2-token fragment first for a one-word query", async () => {
  const docs = loadCorpus(join(ROOT, FIXTURE));
  const allChunks = async (frac) => (await Promise.all([...docs.values()].map((d) => run(d, "fixed12", frac)))).flat();
  const top = (chunks, q) => runBm25({ docs, chunks, questions: [{ qid: "x", type: "direct", question: q, evidence: [] }], prependTitle: false, scope: "open", sidecar: {}, params: {}, depth: 1, headerParts: [] }).rows[0].retrieved[0];
  const [oldChunks, newChunks] = [await allChunks(0), await allChunks(0.25)];
  for (const q of ["Merrow", "hectare", "tides"]) {
    const before = top(oldChunks, q), after = top(newChunks, q);
    assert.ok(oldChunks.find((c) => c.chunk_id === before.chunk_id).n_tokens <= 2, `old chunks: "${q}" is won by a fragment`);
    assert.ok(newChunks.find((c) => c.chunk_id === after.chunk_id).n_tokens >= 3, `new chunks: "${q}" is won by a real passage`);
  }
});

test("CLI: the shared chunk file has no fragments, passes `check`, and the setting is recorded", () => {
  const tmp = mkdtempSync(join(tmpdir(), "tail-"));
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, "ingest/ingest.config.json"), "utf8"));
    assert.equal(cfg.min_tail_fraction, 0.25, "shipped default");
    let r = sh(["ingest/ingest.mjs", "chunk", "--chunking", "fixed12", "--embedder", "mock", "--corpus", FIXTURE, "--out", tmp]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.includes("exceeds budget"), false, "merged chunks are not flagged as over budget");
    const chunks = jsonl(join(tmp, "chunks", "fixed12.jsonl"));
    assert.equal(chunks.length, 50);
    assert.ok(chunks.some((c) => c.merged_tail));
    const per = new Map();
    for (const c of chunks) per.set(`${c.doc_id}|${c.section_id}`, (per.get(`${c.doc_id}|${c.section_id}`) ?? 0) + 1);
    assert.ok(chunks.filter((c) => per.get(`${c.doc_id}|${c.section_id}`) > 1).every((c) => c.n_tokens >= 3));
    r = sh(["ingest/ingest.mjs", "check", "--chunks", join(tmp, "chunks", "fixed12.jsonl"), "--corpus", FIXTURE]);
    assert.equal(r.status, 0, r.stdout);
    r = sh(["ingest/ingest.mjs", "build", "--embedder", "mock", "--corpus", FIXTURE, "--out", tmp, "--runs", "d768_fixed12_t1"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(readFileSync(join(tmp, "vectors", "d768_fixed12_t1.meta.json"), "utf8")).min_tail_fraction, 0.25);

    const off = join(tmp, "off.config.json");
    writeFileSync(off, JSON.stringify({ ...cfg, min_tail_fraction: 0 }));
    r = sh(["ingest/ingest.mjs", "chunk", "--chunking", "fixed12", "--embedder", "mock", "--corpus", FIXTURE, "--config", off, "--out", join(tmp, "old")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(jsonl(join(tmp, "old", "chunks", "fixed12.jsonl")).length, 57, "setting it to 0 restores the old chunking");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

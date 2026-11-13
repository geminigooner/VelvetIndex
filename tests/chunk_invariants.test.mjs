import test from "node:test";
import assert from "node:assert/strict";
import { chunkDocument, checkChunks } from "../src/lib/chunkers.mjs";
import { createMockEmbedder } from "../src/lib/embedders.mjs";

const tok = createMockEmbedder();
const char4 = { id: "char4", countBatch: async (ts) => ts.map((t) => Math.ceil(t.length / 4)) };

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
  assert.equal(on[0].char_start, off[0].char_start);
  assert.equal(on[0].char_end, off[0].char_end, "earlier windows are untouched");
  for (const c of on) assert.equal(d.text.slice(c.char_start, c.char_end), d.text.slice(c.char_start, c.char_end).trim());
  assert.equal(d.text.slice(on[1].char_start, on[1].char_end).split(" ").length, 12);
  assert.ok(on.at(-1).chunk_id.endsWith("::w1"), "ids stay sequential");
  assert.deepEqual(checkChunks(docsOf(d), on, { budget: 10, tailSlack: 3 }).errors, []);
  assert.equal(checkChunks(docsOf(d), on, { budget: 10, tailSlack: 3 }).warnings.length, 0);
});

test("a one-word tail is absorbed into the previous window", async () => {
  const on = await run(oneSection(21), "fixed10", 0.25);
  assert.deepEqual(sizes(on), [10, 11]);
  assert.ok(on[1].merged_tail);
});

test("normal chunk boundaries are untouched when tail is above threshold", async () => {
  assert.deepEqual(sizes(await run(oneSection(25), "fixed10", 0.25)), [10, 10, 5], "5-token tail retained");
  assert.deepEqual(sizes(await run(oneSection(23), "fixed10", 0.25)), [10, 10, 3], "tail at exact threshold is kept");
  assert.deepEqual(sizes(await run(oneSection(22), "fixed10", 0.25)), [10, 12], "tail below threshold is merged");
  assert.deepEqual(sizes(await run(oneSection(20), "fixed10", 0.25)), [10, 10], "evenly divisible");
});

test("a section that fits in a single window is never merged or altered", async () => {
  const on = await run(oneSection(2), "fixed10", 0.9);
  assert.deepEqual([sizes(on), on[0].merged_tail], [[2], undefined]);
});

test("n_tokens is exact even with non-additive tokenizer and no text is lost", async () => {
  const text = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const d = { doc_id: "d", title: "D", text, sections: [{ section_id: "s1", heading: "S", char_start: 0, char_end: text.length }] };
  const on = await run(d, "fixed12", 0.25, char4);
  for (const c of on) assert.equal(c.n_tokens, Math.ceil(d.text.slice(c.char_start, c.char_end).length / 4));
  const minTail = 3;
  assert.deepEqual(checkChunks(docsOf(d), on, { budget: 12, tailSlack: minTail }).errors, []);
  assert.ok(on.every((c) => c.n_tokens <= 12 + minTail));
});

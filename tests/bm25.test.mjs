import test from "node:test";
import assert from "node:assert/strict";
import { BM25Index, searchBm25, DEFAULT_BM25_PARAMS } from "../src/lib/bm25.mjs";

test("BM25 scores match independently hand-calculated values to 1e-5", () => {
  // Toy corpus of 2 documents
  // Doc 1: "ocean tides kelp" -> 3 tokens
  // Doc 2: "kelp farming harvest kelp" -> 4 tokens
  // avgdl = 3.5, k1 = 1.2, b = 0.75
  const docs = [
    { id: "doc1", text: "ocean tides kelp" },
    { id: "doc2", text: "kelp farming harvest kelp" },
  ];

  const index = new BM25Index(docs, DEFAULT_BM25_PARAMS);

  // Hand-derived values for query "ocean kelp":
  // Term "ocean":
  //   n = 1, N = 2 -> IDF = ln(1 + 1.5/1.5) = ln(2) = 0.6931471805599453
  //   Doc 1 (|D|=3):
  //     K = 1.2 * (0.25 + 0.75 * (3/3.5)) = 1.0714285714285714
  //     TF = (1 * 2.2) / (1 + 1.0714285714285714) = 1.0620689655172412
  //     Score = 0.6931471805599453 * 1.0620689655172412 = 0.7361699066699709
  // Term "kelp":
  //   n = 2, N = 2 -> IDF = ln(1 + 0.5/2.5) = ln(1.2) = 0.1823215567939546
  //   Doc 1 (|D|=3):
  //     TF = 1.0620689655172412
  //     Score = 0.1823215567939546 * 1.0620689655172412 = 0.1936380695027581
  // Total Doc 1 = 0.7361699066699709 + 0.1936380695027581 = 0.929807976172729
  //
  // Doc 2 (|D|=4):
  //   ocean: f=0 -> 0
  //   kelp: f=2
  //     K = 1.2 * (0.25 + 0.75 * (4/3.5)) = 1.3285714285714287
  //     TF = (2 * 2.2) / (2 + 1.3285714285714287) = 1.3218884120171674
  //     Score = 0.1823215567939546 * 1.3218884120171674 = 0.24100877995116742

  const results = index.query("ocean kelp", 10);
  assert.equal(results.length, 2);
  assert.equal(results[0].id, "doc1");
  assert.equal(results[1].id, "doc2");

  const score1 = results[0].score;
  const score2 = results[1].score;

  const expected1 = 0.929807976172729;
  const expected2 = 0.24100877995116742;

  assert.ok(Math.abs(score1 - expected1) < 1e-5, `Doc 1 score ${score1} expected ${expected1}`);
  assert.ok(Math.abs(score2 - expected2) < 1e-5, `Doc 2 score ${score2} expected ${expected2}`);
});

test("searchBm25 conforms to eval.mjs results schema", () => {
  const chunks = [
    { chunk_id: "c1", doc_id: "d1", section_id: "s1", char_start: 0, char_end: 15, text: "tidal energy generator" },
    { chunk_id: "c2", doc_id: "d1", section_id: "s2", char_start: 16, char_end: 35, text: "marine current turbine" },
  ];

  const questions = [
    { qid: "q001", question: "turbine marine current" },
  ];

  const res = searchBm25({ chunks, questions, depth: 5 });
  assert.equal(res.length, 1);
  assert.equal(res[0].qid, "q001");
  assert.equal(res[0].retrieved[0].chunk_id, "c2");
  assert.equal(res[0].retrieved[0].doc_id, "d1");
  assert.equal(res[0].retrieved[0].section_id, "s2");
  assert.ok(typeof res[0].retrieved[0].score === "number");
});

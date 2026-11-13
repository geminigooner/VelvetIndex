import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("reproduce and verify eval.mjs score output directory creation", () => {
  const tmp = mkdtempSync(join(tmpdir(), "eval-test-"));
  try {
    const qFile = join(tmp, "q.jsonl");
    const rFile = join(tmp, "r.jsonl");
    const outFile = join(tmp, "nested", "sub", "report.json");

    // Minimal questions line
    writeFileSync(qFile, JSON.stringify({
      qid: "q001",
      type: "direct",
      question: "What is testing?",
      expected_answer: "Verification of software",
      evidence: [{ doc_id: "d1", section_id: "s1", char_start: 0, char_end: 10, quote: "Testing is" }]
    }) + "\n");

    // Minimal results line
    writeFileSync(rFile, JSON.stringify({
      qid: "q001",
      retrieved: [{ chunk_id: "c1", doc_id: "d1", section_id: "s1", char_start: 0, char_end: 10, score: 0.99 }]
    }) + "\n");

    const r = spawnSync(process.execPath, [
      "eval.mjs",
      "score",
      "--questions", qFile,
      "--results", rFile,
      "--run-id", "test_run",
      "--out", outFile
    ], { encoding: "utf8" });

    assert.equal(r.status, 0, `Expected status 0 but got ${r.status}. Stderr: ${r.stderr}`);
    assert.ok(existsSync(outFile), "Output file should exist");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

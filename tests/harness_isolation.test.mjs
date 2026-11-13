import test from "node:test";
import assert from "node:assert/strict";
import { InvocationCache } from "../src/server/harness/cache.ts";
import { ResearchTaskManager } from "../src/server/harness/taskManager.ts";

test("cache isolation: distinct models and inputs yield isolated cache entries", () => {
  const cache = new InvocationCache();
  const inputA = { query: "What is RAG?", toc: [] };
  const inputB = { query: "What is BM25?", toc: [] };

  cache.set("gemini-4-argon", "v1.0.0", inputA, { selected_section_ids: ["sec1"] });

  assert.equal(cache.has("gemini-4-argon", "v1.0.0", inputA), true);
  assert.equal(cache.has("gemini-4-argon", "v1.0.0", inputB), false);
  assert.equal(cache.has("gemini-3.8-flash", "v1.0.0", inputA), false);
  assert.equal(cache.has("gemini-4-argon", "v2.0.0", inputA), false);
});

test("task state persistence and human approval gate", () => {
  const tm = new ResearchTaskManager();
  const task = tm.createTask("Structure-aware RAG", ["arXiv"]);

  assert.equal(task.status, "idle");
  assert.equal(task.papers.length, 0);

  // Add a paper candidate
  tm.updateTask(task.taskId, {
    status: "staged",
    papers: [
      {
        id: "p1",
        title: "Hierarchical Document Routing",
        authors: ["A. Researcher"],
        year: 2026,
        url: "https://arxiv.org/abs/2601.0001",
        venue: "arXiv",
        abstract: "A study on ToC routing",
        isFullTextAvailable: true,
        status: "discovered",
      },
    ],
  });

  // Verify that before approval, getApprovedPapers returns empty
  assert.equal(tm.getApprovedPapers(task.taskId).length, 0);

  // Explicit user approval
  tm.setPaperStatus(task.taskId, "p1", "approved");

  const approved = tm.getApprovedPapers(task.taskId);
  assert.equal(approved.length, 1);
  assert.equal(approved[0].id, "p1");
  assert.equal(approved[0].status, "approved");
});

test("Argon permission validator rejects payloads containing document bodies or answers", () => {
  function validateArgonInput(input) {
    if (!input || typeof input !== "object") throw new Error("Invalid input");
    if (!input.query || typeof input.query !== "string") throw new Error("Missing query");
    if (!Array.isArray(input.toc)) throw new Error("Missing or invalid ToC");

    // Strict boundary checks
    if ("document_body" in input || "body" in input || "text" in input) {
      throw new Error("SECURITY_VIOLATION: Argon cannot access document bodies");
    }
    if ("answer" in input || "reference_answer" in input || "gold_evidence" in input) {
      throw new Error("SECURITY_VIOLATION: Argon cannot access evaluation answers or gold evidence");
    }

    for (const doc of input.toc) {
      for (const sec of doc.sections ?? []) {
        if ("body" in sec || "text" in sec) {
          throw new Error("SECURITY_VIOLATION: Section bodies must not be passed to Argon");
        }
      }
    }
    return true;
  }

  // Valid payload
  assert.ok(validateArgonInput({
    query: "Methodology of experiment",
    toc: [{
      doc_id: "doc1",
      title: "Paper Title",
      sections: [{ section_id: "sec1", heading: "1. Intro", level: 1 }]
    }]
  }));

  // Attempting to pass document body
  assert.throws(() => {
    validateArgonInput({
      query: "Test",
      toc: [],
      document_body: "Full text content here..."
    });
  }, /SECURITY_VIOLATION/);

  // Attempting to pass section text
  assert.throws(() => {
    validateArgonInput({
      query: "Test",
      toc: [{
        doc_id: "doc1",
        title: "Paper Title",
        sections: [{ section_id: "sec1", heading: "1. Intro", level: 1, text: "Secret text" }]
      }]
    });
  }, /SECURITY_VIOLATION/);
});

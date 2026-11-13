#!/usr/bin/env node
// ingest.mjs — chunk -> embed -> truncate/normalize -> vectors, plus brute-force query for the eval.
// Run from the rag-eval root so eval.mjs and ingest.mjs share corpus.json / config.json / results/.
//
//   node ingest/ingest.mjs runs  [--runs baseline|grid|id1,id2]
//   node ingest/ingest.mjs chunk --chunking section --embedder mock|http [--corpus corpus.json] [--out out]
//   node ingest/ingest.mjs check --chunks out/chunks/section.jsonl [--corpus corpus.json]
//   node ingest/ingest.mjs build --embedder mock|http [--runs ...] [--corpus ...] [--out out] [--no-cache]
//   node ingest/ingest.mjs query --embedder mock|http [--runs ...] [--questions questions.jsonl]
//                                [--depth 10] [--out out] [--results-dir results] [--split dev|test]
//
// http embedder env: EMBED_URL, EMBED_API_KEY (optional), HF_TOKEN (only if the Space is private)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chunkCorpus, checkChunks, parseChunking } from "./chunkers.mjs";
import { buildTitle, formatDocument, formatQuery } from "./format.mjs";
import { truncateAndNormalize, topK } from "./vectors.mjs";
import { createMockEmbedder, createHttpEmbedder, withCache } from "./embedders.mjs";
import { resolveRuns } from "./plan.mjs";

// ---------- small helpers ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2), next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(argv[i]);
  }
  return out;
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readJsonl = (p) =>
  readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { throw new Error(`${p}:${i + 1} invalid JSON: ${e.message}`); }
  });
const writeJsonl = (p, rows) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "_");

const EVAL_DEFAULTS = {
  factors: { dimensions: [768, 512, 256], chunking: ["section", "fixed512"], prepend_title: [true, false] },
  baseline: { dimensions: 768, chunking: "section", prepend_title: true },
};
const INGEST_CONFIG_PATH = fileURLToPath(new URL("./ingest.config.json", import.meta.url));

function loadIngestConfig(args) {
  return readJson(args.config ?? INGEST_CONFIG_PATH);
}
function loadEvalConfig(args) {
  const p = args["eval-config"] ?? "config.json";
  return existsSync(p) ? { ...EVAL_DEFAULTS, ...readJson(p) } : EVAL_DEFAULTS;
}

// Same corpus contract as eval.mjs (inline `text` or `file`), plus the integrity checks gold offsets rely on.
export function loadCorpus(path) {
  const base = dirname(resolve(path));
  const docs = new Map();
  for (const d of readJson(path).docs) {
    const text = d.text ?? readFileSync(resolve(base, d.file), "utf8");
    if (text.includes("\r")) throw new Error(`${d.doc_id}: text must use LF newlines only`);
    if (d.sha256 && d.sha256 !== sha256(text)) throw new Error(`${d.doc_id}: sha256 mismatch; the text changed since it was labeled`);
    docs.set(d.doc_id, { ...d, text });
  }
  return docs;
}

// The ONLY place an embedded string is assembled. Body is always the exact source slice.
export function embedText(docs, chunk, prependTitle, cfg) {
  const d = docs.get(chunk.doc_id);
  const sec = d.sections.find((s) => s.section_id === chunk.section_id);
  const title = prependTitle ? buildTitle({ docTitle: d.title, sectionHeading: sec?.heading }, cfg.header_parts) : null;
  return formatDocument(title, d.text.slice(chunk.char_start, chunk.char_end));
}

async function makeEmbedder(args, cfg) {
  let base;
  if (args.embedder === "mock") {
    base = createMockEmbedder({ dim: cfg.native_dim });
    console.log("NOTE: mock embedder. Vectors are hashed bag-of-words: good for plumbing tests, meaningless for quality.");
  } else if (args.embedder === "http") {
    base = await createHttpEmbedder({
      url: args.url ?? process.env.EMBED_URL,
      apiKey: process.env.EMBED_API_KEY,
      hfToken: process.env.HF_TOKEN,
      batchSize: cfg.batch_size,
      nativeDim: cfg.native_dim,
    });
  } else throw new Error("pass --embedder mock|http");
  const cachePath = args["no-cache"] ? null : `${args.out ?? "out"}/cache/${slug(base.id)}.jsonl`;
  return withCache(base, cachePath);
}

// ---------- commands ----------
async function chunkOne(docs, chunking, cfg, emb) {
  const spec = parseChunking(chunking);
  const chunks = await chunkCorpus(docs, chunking, cfg, emb);
  const { errors, warnings } = checkChunks(docs, chunks, { budget: spec.kind === "fixed" ? spec.budget : cfg.section_max_body_tokens });
  warnings.forEach((w) => console.log(`warn: [${chunking}] ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.log(`ERROR: [${chunking}] ${e}`));
    throw new Error(`chunk invariants failed for "${chunking}"`);
  }
  return chunks;
}

async function cmdChunk(args) {
  const cfg = loadIngestConfig(args), docs = loadCorpus(args.corpus ?? "corpus.json");
  const emb = await makeEmbedder(args, cfg);
  const chunking = args.chunking ?? "section";
  const chunks = await chunkOne(docs, chunking, cfg, emb);
  const p = `${args.out ?? "out"}/chunks/${chunking}.jsonl`;
  writeJsonl(p, chunks);
  console.log(`${chunking}: ${chunks.length} chunks, mean ${mean(chunks.map((c) => c.n_tokens)).toFixed(1)} tokens -> ${p}`);
}

function cmdCheck(args) {
  const docs = loadCorpus(args.corpus ?? "corpus.json");
  const chunks = readJsonl(args.chunks);
  const { errors, warnings } = checkChunks(docs, chunks);
  warnings.forEach((w) => console.log(`warn:  ${w}`));
  errors.forEach((e) => console.log(`ERROR: ${e}`));
  console.log(errors.length ? `${errors.length} error(s)` : `ok: ${chunks.length} chunks satisfy the offset invariants`);
  if (errors.length) process.exitCode = 1;
}

async function cmdBuild(args) {
  const cfg = loadIngestConfig(args), docs = loadCorpus(args.corpus ?? "corpus.json");
  const runs = resolveRuns(args.runs, loadEvalConfig(args));
  const out = args.out ?? "out";
  const emb = await makeEmbedder(args, cfg);
  console.log(`embedder ${emb.id}; ${runs.length} run(s)`);

  const chunksBy = new Map();
  for (const chunking of new Set(runs.map((r) => r.chunking))) {
    const chunks = await chunkOne(docs, chunking, cfg, emb);
    writeJsonl(`${out}/chunks/${chunking}.jsonl`, chunks);
    chunksBy.set(chunking, chunks);
    console.log(`chunked ${chunking}: ${chunks.length} chunks, mean ${mean(chunks.map((c) => c.n_tokens)).toFixed(1)} tokens`);
  }

  // One embedding pass per (chunking, prepend_title); every dimension is derived from the full vector.
  const groups = new Map();
  for (const r of runs) {
    const k = `${r.chunking}|${r.prepend_title}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const corpusSha = Object.fromEntries([...docs].map(([id, d]) => [id, sha256(d.text)]));
  const round = (x) => Number(x.toFixed(cfg.vector_decimals));

  for (const group of groups.values()) {
    const { chunking, prepend_title } = group[0];
    const chunks = chunksBy.get(chunking);
    const texts = chunks.map((c) => embedText(docs, c, prepend_title, cfg));
    const counts = await emb.countBatch(texts);
    const tooLong = chunks.filter((_, i) => counts[i] > cfg.max_embed_tokens);
    if (tooLong.length) throw new Error(`${tooLong.length} embedded string(s) exceed ${cfg.max_embed_tokens} tokens (first: ${tooLong[0].chunk_id})`);

    const full = await emb.embed(texts);
    for (const run of group) {
      const rows = chunks.map((c, i) => ({
        id: c.chunk_id, // Vectorize NDJSON shape: { id, values, metadata }
        values: Array.from(truncateAndNormalize(full[i], run.dimensions, cfg.native_dim), (x) => round(x)),
        metadata: { doc_id: c.doc_id, section_id: c.section_id, char_start: c.char_start, char_end: c.char_end },
      }));
      writeJsonl(`${out}/vectors/${run.run_id}.jsonl`, rows);
      writeFileSync(`${out}/vectors/${run.run_id}.meta.json`, JSON.stringify({
        run_id: run.run_id, chunking, dimensions: run.dimensions, prepend_title,
        header_parts: prepend_title ? cfg.header_parts : [],
        embedder_id: emb.id, model_id: cfg.model_id, native_dim: cfg.native_dim,
        document_format: "title: {title|none} | text: {body}", query_format: "task: search result | query: {query}",
        normalization: "l2 after truncation", n_vectors: rows.length, corpus_sha256: corpusSha,
      }, null, 2) + "\n");
      console.log(`wrote ${run.run_id}: ${rows.length} vectors x ${run.dimensions} dims`);
    }
  }
  console.log(`embedding cache: ${emb.stats.hits} hit(s), ${emb.stats.misses} miss(es)`);
}

async function cmdQuery(args) {
  const cfg = loadIngestConfig(args);
  const runs = resolveRuns(args.runs, loadEvalConfig(args));
  const out = args.out ?? "out", resultsDir = args["results-dir"] ?? "results";
  const depth = Number(args.depth ?? cfg.default_depth);
  let questions = readJsonl(args.questions ?? "questions.jsonl");
  if (args.split) questions = questions.filter((q) => (q.split ?? "dev") === args.split);
  const emb = await makeEmbedder(args, cfg);

  const qFull = await emb.embed(questions.map((q) => formatQuery(q.question)));
  for (const run of runs) {
    const meta = readJson(`${out}/vectors/${run.run_id}.meta.json`);
    if (meta.embedder_id !== emb.id) throw new Error(`${run.run_id}: vectors were built with "${meta.embedder_id}" but queries use "${emb.id}"; mixing models gives garbage`);
    const items = readJsonl(`${out}/vectors/${run.run_id}.jsonl`);
    if (items.some((it) => it.values.length !== meta.dimensions)) throw new Error(`${run.run_id}: stored vector length != ${meta.dimensions}`);

    const rows = questions.map((q, i) => {
      const qv = truncateAndNormalize(qFull[i], meta.dimensions, meta.native_dim); // identical treatment as documents
      return {
        qid: q.qid,
        retrieved: topK(qv, items, depth).map(({ item, score }) => ({
          chunk_id: item.id, ...item.metadata, score: Number(score.toFixed(6)),
        })),
      };
    });
    writeJsonl(`${resultsDir}/${run.run_id}.jsonl`, rows);
    console.log(`wrote ${resultsDir}/${run.run_id}.jsonl (${rows.length} questions, top ${depth})`);
  }
}

function cmdRuns(args) {
  for (const r of resolveRuns(args.runs, loadEvalConfig(args)))
    console.log(`${r.run_id.padEnd(22)} dims=${r.dimensions} chunking=${r.chunking} prepend_title=${r.prepend_title}`);
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmds = { chunk: cmdChunk, check: cmdCheck, build: cmdBuild, query: cmdQuery, runs: cmdRuns };
  const fn = cmds[args._[0]];
  if (!fn) { console.log("usage: node ingest/ingest.mjs <chunk|check|build|query|runs> [options]  (see header comment)"); process.exit(1); }
  try { await fn(args); } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

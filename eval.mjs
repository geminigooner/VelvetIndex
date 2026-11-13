#!/usr/bin/env node
// eval.mjs — zero-dependency retrieval eval for the RAG project. Node 18+.
//
//   node eval.mjs validate --questions questions.jsonl --corpus corpus.json
//   node eval.mjs runs [--grid]
//   node eval.mjs score --questions questions.jsonl --results results/RUN.jsonl \
//        --run-id RUN [--chunks chunks.jsonl] [--split dev|test] [--out reports/RUN.json]
//   node eval.mjs compare reports/baseline.json reports/variant.json
//
// Gold labels live at the SOURCE-SPAN level (doc_id + section_id + char range),
// never at chunk-ID level, so every chunking strategy is scored against the same truth.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

// ---------- helpers ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(argv[i]);
  }
  return out;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const readJsonl = (p) =>
  readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); }
    catch (e) { throw new Error(`${p}:${i + 1} invalid JSON: ${e.message}`); }
  });

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const f3 = (x) => (x == null ? "  -  " : x.toFixed(3));
const ci = (c) => (c ? ` [${f3(c[0])}, ${f3(c[1])}]` : "");

const DEFAULTS = {
  k: 5,
  mrr_depth: 10,
  min_overlap_chars: 50,
  bootstrap: { iterations: 2000, seed: 1337 },
  factors: {
    dimensions: [768, 512, 256],
    chunking: ["section", "fixed512"],
    prepend_title: [true, false]
  },
  baseline: {
    dimensions: 768,
    chunking: "section",
    prepend_title: true
  },
};

const loadConfig = (p) =>
  (existsSync(p) ? { ...DEFAULTS, ...readJson(p) } : DEFAULTS);

function loadCorpus(path) {
  const base = dirname(resolve(path));
  const docs = new Map();

  for (const d of readJson(path).docs) {
    const text = d.text ?? readFileSync(resolve(base, d.file), "utf8");
    docs.set(d.doc_id, { ...d, text });
  }

  return docs;
}

// ---------- span matching ----------
const overlap = (a0, a1, b0, b1) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

function matches(chunk, ev, minOverlap) {
  if (chunk.doc_id !== ev.doc_id) return false;

  const need = Math.min(
    minOverlap,
    Math.ceil((ev.char_end - ev.char_start) / 2)
  );

  return overlap(
    chunk.char_start,
    chunk.char_end,
    ev.char_start,
    ev.char_end
  ) >= need;
}

// ---------- validate ----------
const TYPES = ["direct", "paraphrase", "multi_chunk", "unanswerable"];

const RECOMMENDED = {
  direct: 15,
  paraphrase: 10,
  multi_chunk: 5,
  unanswerable: 10
};

const toks = (s) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

function jaccard(a, b) {
  const A = toks(a), B = toks(b);
  let i = 0;

  for (const t of A) if (B.has(t)) i++;

  return i / (A.size + B.size - i || 1);
}

function validate(questions, docs) {
  const errors = [], warnings = [];
  const counts = {};
  const byId = new Map();

  for (const d of docs.values()) {
    if (d.text.includes("\r")) {
      errors.push(`${d.doc_id}: text must use LF newlines only`);
    }

    const sha = createHash("sha256").update(d.text).digest("hex");

    if (!d.sha256) {
      warnings.push(`${d.doc_id}: no sha256 in corpus manifest (add ${sha})`);
    } else if (d.sha256 !== sha) {
      errors.push(`${d.doc_id}: sha256 mismatch — text changed, gold offsets may be stale`);
    }

    const secs = [...d.sections].sort(
      (a, b) => a.char_start - b.char_start
    );

    secs.forEach((s, i) => {
      if (s.char_start >= s.char_end || s.char_end > d.text.length) {
        errors.push(`${d.doc_id}/${s.section_id}: bad section range`);
      }

      if (i > 0 && s.char_start < secs[i - 1].char_end) {
        errors.push(`${d.doc_id}/${s.section_id}: overlaps previous section`);
      }
    });
  }

  for (const q of questions) {
    const err = (m) => errors.push(`${q.qid ?? "?"}: ${m}`);

    if (!/^q\d{3,}$/.test(q.qid ?? "")) err("qid must look like q001");

    if (byId.has(q.qid)) err("duplicate qid");

    byId.set(q.qid, q);

    if (!TYPES.includes(q.type)) {
      err(`bad type "${q.type}"`);
      continue;
    }

    counts[q.type] = (counts[q.type] ?? 0) + 1;

    if (typeof q.question !== "string" || q.question.length < 8) {
      err("question too short");
    }

    if (q.split && !["dev", "test"].includes(q.split)) {
      err('split must be "dev" or "test"');
    }

    const ev = q.evidence ?? [];

    if (q.type === "unanswerable") {
      if (ev.length) err("unanswerable must have no evidence");
      if (q.expected_answer !== null) {
        err("unanswerable expected_answer must be null");
      }
    } else {
      if (typeof q.expected_answer !== "string" || !q.expected_answer) {
        err("expected_answer required");
      }

      if (q.type === "multi_chunk" ? ev.length < 2 : ev.length !== 1) {
        err(`${q.type} needs ${q.type === "multi_chunk" ? "2+" : "exactly 1"} evidence item(s)`);
      }
    }

    ev.forEach((e, i) => {
      const w = `evidence[${i}]`;
      const d = docs.get(e.doc_id);

      if (!d) return err(`${w}: unknown doc_id "${e.doc_id}"`);

      const s = d.sections.find((x) => x.section_id === e.section_id);

      if (!s) return err(`${w}: unknown section_id "${e.section_id}"`);

      if (!(Number.isInteger(e.char_start) &&
            Number.isInteger(e.char_end) &&
            e.char_start < e.char_end)) {
        return err(`${w}: bad char span`);
      }

      if (e.char_start < s.char_start || e.char_end > s.char_end) {
        err(`${w}: span falls outside section ${s.section_id}`);
      }

      if (d.text.slice(e.char_start, e.char_end) !== e.quote) {
        err(`${w}: quote does not match text at span`);
      }
    });

    if (
      q.type === "multi_chunk" &&
      new Set(ev.map((e) => `${e.doc_id}|${e.section_id}`)).size < 2
    ) {
      warnings.push(
        `${q.qid}: multi_chunk evidence all sits in one section; prefer spanning sections`
      );
    }

    if (q.type === "paraphrase") {
      const src = byId.get(q.paraphrase_of);

      if (!src || src.type !== "direct") {
        err("paraphrase_of must reference an earlier direct question");
      }

      if (ev[0] && jaccard(q.question, ev[0].quote) > 0.4) {
        warnings.push(
          `${q.qid}: paraphrase shares a lot of wording with its source; reword it`
        );
      }
    }
  }

  for (const [t, n] of Object.entries(RECOMMENDED)) {
    if ((counts[t] ?? 0) < n) {
      warnings.push(
        `only ${counts[t] ?? 0}/${n} recommended "${t}" questions so far`
      );
    }
  }

  return { errors, warnings, counts };
}

// ---------- runs ----------
function expandRuns(cfg, grid) {
  const mk = (p) => ({
    run_id: `d${p.dimensions}_${p.chunking}_t${p.prepend_title ? 1 : 0}`,
    ...p
  });

  if (grid) {
    let combos = [{}];

    for (const [k, vals] of Object.entries(cfg.factors)) {
      combos = combos.flatMap((c) =>
        vals.map((v) => ({ ...c, [k]: v }))
      );
    }

    return combos.map(mk);
  }

  const runs = [
    { ...mk(cfg.baseline), varies: "(baseline)" }
  ];

  for (const [k, vals] of Object.entries(cfg.factors)) {
    for (const v of vals) {
      if (v !== cfg.baseline[k]) {
        runs.push({
          ...mk({ ...cfg.baseline, [k]: v }),
          varies: k
        });
      }
    }
  }

  return runs;
}

// ---------- scoring ----------
function evalQuestion(q, retrieved, k, minOv) {
  const ranks = q.evidence.map((e) => {
    const i = retrieved.findIndex((c) => matches(c, e, minOv));
    return i < 0 ? null : i + 1;
  });

  const found = ranks.filter((r) => r !== null);
  const first = found.length ? Math.min(...found) : null;
  const inK = ranks.filter((r) => r !== null && r <= k).length;

  return {
    qid: q.qid,
    type: q.type,
    ranks,
    hit: inK === ranks.length ? 1 : 0,
    hit_any: first !== null && first <= k ? 1 : 0,
    recall: inK / ranks.length,
    mrr: first ? 1 / first : 0
  };
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;

    let t = Math.imul(a ^ (a >>> 15), 1 | a);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapCI(values, { iterations, seed }) {
  if (values.length < 2) return null;

  const rnd = mulberry32(seed);
  const n = values.length;
  const means = [];

  for (let i = 0; i < iterations; i++) {
    let s = 0;

    for (let j = 0; j < n; j++) {
      s += values[Math.floor(rnd() * n)];
    }

    means.push(s / n);
  }

  means.sort((a, b) => a - b);

  return [
    means[Math.floor(0.025 * iterations)],
    means[Math.floor(0.975 * iterations) - 1]
  ];
}

function aggregate(rows, bs) {
  const out = { n: rows.length };

  for (const m of ["hit", "hit_any", "recall", "mrr"]) {
    const v = rows.map((r) => r[m]);

    out[m] = mean(v);

    if (m === "hit" || m === "mrr") {
      out[`${m}_ci95`] = bootstrapCI(v, bs);
    }
  }

  return out;
}

function score({ questions, results, cfg, runId, chunks }) {
  const {
    k,
    mrr_depth: depth,
    min_overlap_chars: minOv,
    bootstrap
  } = cfg;

  const byQid = new Map(
    results.map((r) => [
      r.qid,
      (r.retrieved ?? []).slice(0, depth)
    ])
  );

  const warnings = [], rows = [], unans = [], lens = [];

  for (const q of questions) {
    const got = byQid.get(q.qid);

    if (!got) {
      warnings.push(`${q.qid}: no results line (counted as miss)`);
    }

    const retrieved = got ?? [];

    retrieved.slice(0, k).forEach((c) => {
      lens.push(c.char_end - c.char_start);
    });

    const top1 = retrieved[0]?.score ?? null;

    if (q.type === "unanswerable") {
      unans.push(top1);
      continue;
    }

    const row = evalQuestion(q, retrieved, k, minOv);
    row.top1 = top1;

    if (chunks) {
      row.gold_chunk_ids = q.evidence.map((e) =>
        chunks
          .filter((c) => matches(c, e, minOv))
          .map((c) => c.chunk_id)
      );

      row.gold_chunk_ids.forEach((ids, i) => {
        if (!ids.length) {
          warnings.push(
            `${q.qid}: evidence[${i}] matches no chunk (this chunking cannot reach gold)`
          );
        }
      });
    }

    rows.push(row);
  }

  const byType = {};

  for (const t of TYPES.filter((t) => t !== "unanswerable")) {
    const r = rows.filter((x) => x.type === t);

    if (r.length) {
      byType[t] = aggregate(r, bootstrap);
    }
  }

  const ansTop = rows.map((r) => r.top1).filter((x) => x != null);
  const unTop = unans.filter((x) => x != null);
  const sweep = [];

  if (ansTop.length && unTop.length) {
    const all = [...ansTop, ...unTop];
    const lo = Math.min(...all);
    const hi = Math.max(...all);

    for (let i = 0; i <= 10; i++) {
      const t = lo + ((hi - lo) * i) / 10;

      sweep.push({
        threshold: +t.toFixed(4),
        abstain_on_unanswerable:
          unTop.filter((s) => s < t).length / unTop.length,
        answer_on_answerable:
          ansTop.filter((s) => s >= t).length / ansTop.length
      });
    }
  }

  return {
    run_id: runId ?? "unnamed",
    k,
    mrr_depth: depth,
    min_overlap_chars: minOv,
    mean_chunk_chars: mean(lens),
    overall: aggregate(rows, bootstrap),
    by_type: byType,
    unanswerable: {
      n: unans.length,
      top1_mean: mean(unTop),
      top1_max: unTop.length ? Math.max(...unTop) : null,
      threshold_sweep: sweep
    },
    warnings,
    per_question: rows
  };
}

function printSummary(r) {
  console.log(
    `run: ${r.run_id}   k=${r.k}   (answerable n=${r.overall.n})`
  );

  console.log(
    `  Hit@${r.k} ${f3(r.overall.hit)}${ci(r.overall.hit_ci95)}   MRR ${f3(r.overall.mrr)}${ci(r.overall.mrr_ci95)}   mean chunk chars ${Math.round(r.mean_chunk_chars ?? 0)}`
  );

  for (const [t, a] of Object.entries(r.by_type)) {
    console.log(
      `  ${t.padEnd(12)} n=${String(a.n).padStart(2)}  hit ${f3(a.hit)}  any ${f3(a.hit_any)}  recall ${f3(a.recall)}  mrr ${f3(a.mrr)}`
    );
  }

  const u = r.unanswerable;

  if (u.n) {
    console.log(
      `  unanswerable n=${u.n}  top-1 score mean ${f3(u.top1_mean)}  max ${f3(u.top1_max)}  (threshold sweep in --out JSON)`
    );
  }

  r.warnings.forEach((w) => console.log(`  warn: ${w}`));
}

function compare(a, b, bs) {
  const mb = new Map(b.per_question.map((r) => [r.qid, r]));

  const pairs = a.per_question
    .filter((r) => mb.has(r.qid))
    .map((r) => [r, mb.get(r.qid)]);

  console.log(
    `${a.run_id}  ->  ${b.run_id}   (paired on ${pairs.length} answerable questions)`
  );

  for (const m of ["hit", "mrr"]) {
    const d = pairs.map(([x, y]) => y[m] - x[m]);
    const c = bootstrapCI(d, bs);

    const verdict =
      c && (c[0] > 0 || c[1] < 0)
        ? "distinguishable from noise"
        : "NOT distinguishable from noise";

    console.log(
      `  ${m.padEnd(4)} ${f3(mean(pairs.map((p) => p[0][m])))} -> ${f3(mean(pairs.map((p) => p[1][m])))}   delta ${f3(mean(d))}${ci(c)}  ${verdict}`
    );
  }
}

// ---------- main ----------
const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const cfg = loadConfig(args.config ?? "config.json");

if (cmd === "validate") {
  const questions = readJsonl(args.questions ?? "questions.jsonl");

  const {
    errors,
    warnings,
    counts
  } = validate(
    questions,
    loadCorpus(args.corpus ?? "corpus.json")
  );

  console.log(
    `questions: ${questions.length}  ${JSON.stringify(counts)}`
  );

  warnings.forEach((w) => console.log(`warn:  ${w}`));
  errors.forEach((e) => console.log(`ERROR: ${e}`));

  console.log(
    errors.length ? `${errors.length} error(s)` : "valid"
  );

  process.exit(errors.length ? 1 : 0);

} else if (cmd === "runs") {

  for (const r of expandRuns(cfg, !!args.grid)) {
    console.log(
      `${r.run_id.padEnd(22)} dims=${r.dimensions} chunking=${r.chunking} prepend_title=${r.prepend_title}${r.varies ? `   varies: ${r.varies}` : ""}`
    );
  }

} else if (cmd === "score") {

  let questions = readJsonl(
    args.questions ?? "questions.jsonl"
  );

  if (args.split) {
    questions = questions.filter(
      (q) => (q.split ?? "dev") === args.split
    );
  }

  const report = score({
    questions,
    results: readJsonl(args.results),
    cfg,
    runId: args["run-id"],
    chunks: args.chunks ? readJsonl(args.chunks) : null
  });

  printSummary(report);

  if (args.out) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(
      args.out,
      JSON.stringify(report, null, 2)
    );

    console.log(`wrote ${args.out}`);
  }

} else if (cmd === "compare") {

  compare(
    readJson(args._[1]),
    readJson(args._[2]),
    cfg.bootstrap
  );

} else {

  console.log(
    "usage: node eval.mjs <validate|runs|score|compare> [options]  (see header comment)"
  );

  process.exit(1);
}

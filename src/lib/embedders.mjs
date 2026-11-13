// embedders.mjs — every embedder exposes:
//   id                      string that names the model + format; stored with vectors, checked at query time
//   native_dim              number
//   embed(texts)            -> Promise<number[][]>   FULL native-dim vectors for already-formatted strings
//   countBatch(texts)       -> Promise<number[]>     token counts (also serves as the chunking tokenizer)
// Truncation and normalization are NOT done here; see vectors.mjs.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { l2normalize } from "./vectors.mjs";

// ---------- mock (plumbing tests only; its scores say nothing about model quality) ----------
const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
};
const words = (t) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function createMockEmbedder({ dim = 768 } = {}) {
  const featurize = (text) => {
    const v = new Float64Array(dim);
    let body = text;
    let title = "";
    const doc = /^title: (.*?) \| text: ([\s\S]*)$/.exec(text);
    if (doc) { title = doc[1] === "none" ? "" : doc[1]; body = doc[2]; }
    else body = text.replace(/^task: [^|]+ \| query: /, "");
    const ws = [...words(title), ...words(body)];
    const feats = [...ws, ...ws.slice(1).map((w, i) => `${ws[i]} ${w}`)];
    for (const f of feats) v[fnv(f) % dim] += (fnv("s" + f) & 1 ? 1 : -1) * (f.includes(" ") ? 0.5 : 1);
    if (!v.some((x) => x !== 0)) v[0] = 1;
    return Array.from(l2normalize(v));
  };
  return {
    id: `mock-hash-${dim}@v1`,
    native_dim: dim,
    async embed(texts) { return texts.map(featurize); },
    async countBatch(texts) { return texts.map((t) => (t.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []).length); },
  };
}

// ---------- http (talks to embed_server/app.py running EmbeddingGemma 2) ----------
export async function createHttpEmbedder({ url, apiKey, hfToken, batchSize = 32, nativeDim = 768, timeoutMs = 120000, retries = 3 }) {
  if (!url) throw new Error("http embedder needs EMBED_URL");
  const base = url.replace(/\/+$/, "");
  const headers = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey; // our own gate
  if (hfToken) headers.authorization = `Bearer ${hfToken}`; // only needed if the Space is private

  async function call(path, body) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(base + path, {
          method: body ? "POST" : "GET",
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return await res.json();
        const text = await res.text().catch(() => "");
        if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`), { fatal: true });
        lastErr = new Error(`${path} -> HTTP ${res.status}`);
      } catch (e) {
        if (e.fatal) throw e;
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    throw new Error(`${path} failed after ${retries + 1} attempts: ${lastErr?.message}`);
  }

  const health = await call("/health");
  if (health.dim !== nativeDim) throw new Error(`server reports dim ${health.dim}, expected ${nativeDim}`);
  if (health.prompt_ok === false)
    throw new Error(`server prompt self-check FAILED (cosine ${health.prompt_cosine}); a double or missing "title: ... | text:" prefix would corrupt every vector`);

  const batches = (xs) => { const out = []; for (let i = 0; i < xs.length; i += batchSize) out.push(xs.slice(i, i + batchSize)); return out; };

  return {
    id: `${health.model}@${health.dim}`,
    native_dim: health.dim,
    health,
    async embed(texts) {
      const out = [];
      for (const batch of batches(texts)) {
        const r = await call("/embed", { texts: batch });
        if (!Array.isArray(r.embeddings) || r.embeddings.length !== batch.length) throw new Error("embed: wrong number of vectors returned");
        if (r.truncated?.some(Boolean)) throw new Error("embed: server truncated an input; the chunk is longer than the model context, so its span would overstate what was embedded");
        for (const v of r.embeddings) { if (v.length !== nativeDim) throw new Error(`embed: got ${v.length} dims, expected ${nativeDim}`); out.push(v); }
      }
      return out;
    },
    async countBatch(texts) {
      const out = [];
      for (const batch of batches(texts)) {
        const r = await call("/count", { texts: batch });
        if (!Array.isArray(r.counts) || r.counts.length !== batch.length) throw new Error("count: wrong number of counts returned");
        out.push(...r.counts);
      }
      return out;
    },
  };
}

// ---------- disk cache so re-running a build never re-embeds unchanged chunks ----------
export function withCache(embedder, path) {
  const cache = new Map();
  if (path && existsSync(path))
    for (const line of readFileSync(path, "utf8").split("\n")) if (line.trim()) { const { k, v } = JSON.parse(line); cache.set(k, v); }
  const key = (t) => createHash("sha256").update(`${embedder.id}\n${t}`).digest("hex");
  return {
    ...embedder,
    stats: { hits: 0, misses: 0 },
    async embed(texts) {
      const keys = texts.map(key);
      const need = [...new Set(keys.filter((k) => !cache.has(k)))];
      this.stats.hits += texts.length - need.length;
      this.stats.misses += need.length;
      if (need.length) {
        const first = new Map(keys.map((k, i) => [k, i]));
        const vecs = await embedder.embed(need.map((k) => texts[first.get(k)]));
        if (path) mkdirSync(dirname(path), { recursive: true });
        need.forEach((k, i) => { cache.set(k, vecs[i]); if (path) appendFileSync(path, JSON.stringify({ k, v: vecs[i] }) + "\n"); });
      }
      return keys.map((k) => cache.get(k));
    },
  };
}

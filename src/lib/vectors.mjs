// vectors.mjs — pure math, no Node APIs, so the SAME code can run in ingest and in the Cloudflare query Worker.
// Matryoshka rule (EmbeddingGemma 2): keep the first d dims, then re-normalize to unit length.
// Documents and queries MUST both go through truncateAndNormalize with the same d.

export const ALLOWED_DIMS = [768, 512, 256, 128];

export function l2norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

export function l2normalize(v) {
  const n = l2norm(v);
  if (!(n > 0) || !Number.isFinite(n)) throw new Error("cannot normalize a zero or non-finite vector");
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function truncateAndNormalize(v, d, nativeDim = 768) {
  if (!ALLOWED_DIMS.includes(d) || d > nativeDim) throw new Error(`unsupported dimension ${d} (allowed: ${ALLOWED_DIMS.join(", ")})`);
  if (v.length < d) throw new Error(`vector has ${v.length} dims, need at least ${d}`);
  return l2normalize(Array.prototype.slice.call(v, 0, d));
}

export function cosine(a, b) {
  if (a.length !== b.length) throw new Error(`dimension mismatch ${a.length} vs ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// items: [{ id, values, metadata }]. Brute force is plenty for a resume-scale corpus.
export function topK(query, items, k) {
  return items
    .map((item) => ({ item, score: cosine(query, item.values) }))
    .sort((x, y) => y.score - x.score || (x.item.id < y.item.id ? -1 : 1))
    .slice(0, k);
}

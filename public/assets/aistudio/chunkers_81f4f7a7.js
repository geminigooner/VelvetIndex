// chunkers.mjs — pure (no fs). Tokenizer interface: { id, countBatch(texts) => Promise<number[]> }.
//
// Contract: every chunk is { chunk_id, doc_id, section_id, char_start, char_end, n_tokens, chunking }
// where doc.text.slice(char_start, char_end) is the chunk BODY, byte-for-byte, trimmed of outer whitespace.
// Offsets index the original document text. Nothing here knows about titles or prompts.
//
// Chunking ids:  "section"  |  "fixed<N>"  |  "fixed<N>o<M>"  (N-token windows, M-token overlap)
// Windows never cross a section boundary, so every chunk has exactly one section_id.
//
// Tail merge (opts.min_tail_fraction, default 0 = off): if a section's LAST window has fewer than ceil(budget * fraction) tokens,
// it is absorbed into the previous window (flag merged_tail) instead of standing alone as a fragment such as a single word.
// The previous chunk may then be up to (1 + fraction) x the budget. Spans are only extended, never shifted, so offsets stay exact.
// Oversize-section splitting never merges: its token cap is a hard limit.

export function parseChunking(id) {
  if (id === "section") return { kind: "section" };
  const m = /^fixed(\d+)(?:o(\d+))?$/.exec(id);
  if (!m) throw new Error(`unknown chunking "${id}" (use section | fixed<N> | fixed<N>o<M>)`);
  const budget = Number(m[1]), overlap = Number(m[2] ?? 0);
  if (budget < 1) throw new Error(`chunking "${id}": window must be >= 1 token`);
  if (overlap >= budget) throw new Error(`chunking "${id}": overlap must be smaller than the window`);
  return { kind: "fixed", budget, overlap };
}

export function trimSpan(text, start, end) {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

function safeCut(text, pos) {
  const hi = text.charCodeAt(pos - 1), lo = text.charCodeAt(pos);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff ? pos + 1 : pos; // never split a surrogate pair
}

// A single whitespace-free run longer than the budget (a URL, a hash) gets cut proportionally.
function splitUnit(text, u, tokens, budget) {
  const len = u.end - u.start;
  const n = Math.ceil(tokens / budget);
  const size = Math.max(2, Math.ceil(len / n));
  const pieces = [];
  let s = u.start;
  while (s < u.end) {
    let e = Math.min(u.end, s + size);
    if (e < u.end) e = safeCut(text, e);
    pieces.push({ unit: { start: s, end: e }, tokens: Math.min(budget, Math.max(1, Math.ceil((tokens * (e - s)) / len))) });
    s = e;
  }
  return pieces;
}

// Greedy token windows over text[rangeStart, rangeEnd). Per-unit counts drive the greedy fill, then each
// window is re-counted with the real tokenizer and shrunk if tokenization turned out non-additive.
export async function windows(text, rangeStart, rangeEnd, budget, overlap, tok, minTailTokens = 0) {
  const { start: s0, end: e0 } = trimSpan(text, rangeStart, rangeEnd);
  if (e0 <= s0) return [];

  const raw = [];
  for (const m of text.slice(s0, e0).matchAll(/\S+\s*/g)) raw.push({ start: s0 + m.index, end: s0 + m.index + m[0].length });
  const counts = await tok.countBatch(raw.map((u) => text.slice(u.start, u.end).trimEnd()));

  const U = [], C = [];
  raw.forEach((u, i) => {
    if (counts[i] <= budget) { U.push(u); C.push(Math.max(1, counts[i])); }
    else for (const p of splitUnit(text, u, counts[i], budget)) { U.push(p.unit); C.push(p.tokens); }
  });

  const spanOf = (a, b) => {
    const start = U[a].start;
    return { start, end: start + text.slice(start, U[b - 1].end).trimEnd().length };
  };

  const out = [];
  let i = 0;
  while (i < U.length) {
    let j = i, sum = 0;
    while (j < U.length && (j === i || sum + C[j] <= budget)) { sum += C[j]; j++; }

    let b = j, span, n, refined = false;
    for (;;) {
      span = spanOf(i, b);
      n = (await tok.countBatch([text.slice(span.start, span.end)]))[0];
      if (n <= budget) break;
      if (b - i > 1) { b = Math.max(i + 1, b - Math.max(1, Math.floor((b - i) * 0.1))); continue; }
      const u = U[i]; // one unit alone is still too big: halve it and re-run the fill
      if (u.end - u.start > 2) {
        const mid = safeCut(text, u.start + Math.floor((u.end - u.start) / 2));
        const half = Math.max(1, Math.ceil(C[i] / 2));
        U.splice(i, 1, { start: u.start, end: mid }, { start: mid, end: u.end });
        C.splice(i, 1, half, half);
        refined = true;
      }
      break;
    }
    if (refined) continue;
    out.push({ ...span, n_tokens: n });
    if (b >= U.length) break;

    let k = b, acc = 0; // step back to create the requested overlap
    while (k > i + 1 && acc + C[k - 1] <= overlap) { k--; acc += C[k]; }
    i = Math.max(k, i + 1);
  }

  if (minTailTokens > 0 && out.length >= 2 && out[out.length - 1].n_tokens < minTailTokens) {
    const last = out.pop(), prev = out.pop();
    const span = { start: prev.start, end: last.end }; // last.end >= prev.end, so this only extends the previous window
    out.push({ ...span, n_tokens: (await tok.countBatch([text.slice(span.start, span.end)]))[0], merged_tail: true });
  }
  return out;
}

export async function chunkDocument(doc, chunkingId, opts, tok) {
  const spec = parseChunking(chunkingId);
  const cap = opts.section_max_body_tokens;
  const tailFraction = Number(opts.min_tail_fraction ?? 0);
  if (!(tailFraction >= 0 && tailFraction < 1)) throw new Error(`min_tail_fraction must be in [0, 1) (got ${opts.min_tail_fraction})`);
  const out = [];
  const sections = [...doc.sections].sort((a, b) => a.char_start - b.char_start);

  for (const sec of sections) {
    const { start, end } = trimSpan(doc.text, sec.char_start, sec.char_end);
    if (end <= start) continue;
    const base = { doc_id: doc.doc_id, section_id: sec.section_id, chunking: chunkingId };

    if (spec.kind === "section") {
      const [n] = await tok.countBatch([doc.text.slice(start, end)]);
      if (n <= cap) {
        out.push({ chunk_id: `${doc.doc_id}::section::${sec.section_id}`, ...base, char_start: start, char_end: end, n_tokens: n });
        continue;
      }
      // Section too long to embed whole: split so the model never silently truncates a chunk.
      const ws = await windows(doc.text, start, end, cap, 0, tok);
      ws.forEach((w, k) =>
        out.push({ chunk_id: `${doc.doc_id}::section::${sec.section_id}::w${k}`, ...base, char_start: w.start, char_end: w.end, n_tokens: w.n_tokens, oversize_split: true }));
    } else {
      const minTail = tailFraction > 0 ? Math.ceil(spec.budget * tailFraction) : 0;
      const ws = await windows(doc.text, start, end, spec.budget, spec.overlap, tok, minTail);
      ws.forEach((w, k) =>
        out.push({ chunk_id: `${doc.doc_id}::${chunkingId}::${sec.section_id}::w${k}`, ...base, char_start: w.start, char_end: w.end, n_tokens: w.n_tokens, ...(w.merged_tail ? { merged_tail: true } : {}) }));
    }
  }
  return out;
}

export async function chunkCorpus(docs, chunkingId, opts, tok) {
  const all = [];
  for (const doc of docs.values()) all.push(...(await chunkDocument(doc, chunkingId, opts, tok)));
  return all;
}

// Invariants that make gold-span scoring valid. Run on every chunk file before anything is embedded.
export function checkChunks(docs, chunks, { budget = null, maxIdBytes = 64, tailSlack = 0 } = {}) {
  const errors = [], warnings = [];
  const seen = new Set();
  const enc = new TextEncoder();
  const bySection = new Map();

  for (const c of chunks) {
    const err = (m) => errors.push(`${c.chunk_id}: ${m}`);
    if (seen.has(c.chunk_id)) err("duplicate chunk_id");
    seen.add(c.chunk_id);
    if (enc.encode(c.chunk_id).length > maxIdBytes)
      warnings.push(`${c.chunk_id}: id is longer than ${maxIdBytes} bytes (Vectorize may reject it)`);
    const d = docs.get(c.doc_id);
    if (!d) { err("unknown doc_id"); continue; }
    const s = d.sections.find((x) => x.section_id === c.section_id);
    if (!s) { err("unknown section_id"); continue; }
    if (!(Number.isInteger(c.char_start) && Number.isInteger(c.char_end) && c.char_start < c.char_end)) { err("bad span"); continue; }
    if (c.char_start < s.char_start || c.char_end > s.char_end) err("crosses its section boundary");
    const body = d.text.slice(c.char_start, c.char_end);
    if (body !== body.trim()) err("body has leading or trailing whitespace");
    const allowed = budget == null ? null : budget + (c.merged_tail ? tailSlack : 0); // a merged tail may stretch its chunk by up to tailSlack
    if (allowed != null && c.n_tokens > allowed) warnings.push(`${c.chunk_id}: ${c.n_tokens} tokens exceeds budget ${allowed}`);
    const key = `${c.doc_id}|${c.section_id}`;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(c);
  }

  for (const d of docs.values()) {
    for (const s of d.sections) {
      const cs = (bySection.get(`${d.doc_id}|${s.section_id}`) ?? []).sort((a, b) => a.char_start - b.char_start);
      let cursor = s.char_start;
      for (const c of cs) {
        if (c.char_start > cursor && d.text.slice(cursor, c.char_start).trim() !== "")
          errors.push(`${d.doc_id}/${s.section_id}: text not covered by any chunk at ${cursor}-${c.char_start}`);
        cursor = Math.max(cursor, c.char_end);
      }
      if (cursor < s.char_end && d.text.slice(cursor, s.char_end).trim() !== "")
        errors.push(`${d.doc_id}/${s.section_id}: text not covered by any chunk at ${cursor}-${s.char_end}`);
    }
  }
  return { errors, warnings };
}

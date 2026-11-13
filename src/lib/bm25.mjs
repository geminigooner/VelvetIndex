// bm25.mjs — pure, deterministic Okapi BM25 implementation for Arm B.
// Zero dependencies, Node 18+ and browser compatible.
// Equation:
//   IDF(q) = ln(1 + (N - n(q) + 0.5) / (n(q) + 0.5))
//   TF(q, D) = (f(q, D) * (k1 + 1)) / (f(q, D) + k1 * (1 - b + b * (|D| / avgdl)))
//   Score(D, Q) = sum_{q in Q} IDF(q) * TF(q, D)

export const DEFAULT_BM25_PARAMS = {
  k1: 1.2,
  b: 0.75,
};

export function defaultTokenizer(text) {
  if (!text) return [];
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

export class BM25Index {
  constructor(docs, opts = {}) {
    this.k1 = opts.k1 ?? DEFAULT_BM25_PARAMS.k1;
    this.b = opts.b ?? DEFAULT_BM25_PARAMS.b;
    this.tokenizer = opts.tokenizer ?? defaultTokenizer;

    this.docs = []; // { id, metadata, tokens, len, tfMap }
    this.df = new Map(); // term -> count of docs containing term
    this.N = 0;
    this.totalLen = 0;
    this.avgdl = 0;

    if (docs) this.build(docs);
  }

  build(documents) {
    this.docs = [];
    this.df.clear();
    this.totalLen = 0;

    for (const d of documents) {
      const tokens = this.tokenizer(d.text ?? "");
      const len = tokens.length;
      const tfMap = new Map();
      for (const t of tokens) {
        tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
      }

      for (const term of tfMap.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }

      this.docs.push({
        id: d.id,
        metadata: d.metadata ?? {},
        tokens,
        len,
        tfMap,
      });

      this.totalLen += len;
    }

    this.N = this.docs.length;
    this.avgdl = this.N > 0 ? this.totalLen / this.N : 0;
  }

  idf(term) {
    const n = this.df.get(term) ?? 0;
    if (this.N === 0) return 0;
    return Math.log(1 + (this.N - n + 0.5) / (n + 0.5));
  }

  scoreDoc(docIndex, queryTerms) {
    const d = this.docs[docIndex];
    if (this.avgdl === 0 || d.len === 0) return 0;

    const K = this.k1 * (1 - this.b + this.b * (d.len / this.avgdl));
    let score = 0;

    for (const q of queryTerms) {
      const f = d.tfMap.get(q) ?? 0;
      if (f === 0) continue;
      const idf = this.idf(q);
      const tf = (f * (this.k1 + 1)) / (f + K);
      score += idf * tf;
    }

    return score;
  }

  query(queryString, k = 10) {
    const terms = this.tokenizer(queryString);
    if (terms.length === 0 || this.N === 0) return [];

    const scored = [];
    for (let i = 0; i < this.docs.length; i++) {
      const score = this.scoreDoc(i, terms);
      scored.push({
        id: this.docs[i].id,
        metadata: this.docs[i].metadata,
        score,
      });
    }

    // Sort descending by score, tie-break deterministically by ID ascending
    return scored
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, k);
  }
}

/**
 * Execute BM25 retrieval over a collection of chunks for questions.
 * Conforms to the exact retrieval results shape for eval.mjs:
 * { qid, retrieved: [{ chunk_id, doc_id, section_id, char_start, char_end, score }] }
 */
export function searchBm25({ chunks, questions, params = {}, depth = 10, docsMap = null }) {
  const index = new BM25Index(
    chunks.map((c) => {
      let text = "";
      if (docsMap && docsMap.has(c.doc_id)) {
        const d = docsMap.get(c.doc_id);
        text = d.text.slice(c.char_start, c.char_end);
      } else {
        text = c.text ?? "";
      }
      return {
        id: c.chunk_id,
        text,
        metadata: {
          doc_id: c.doc_id,
          section_id: c.section_id,
          char_start: c.char_start,
          char_end: c.char_end,
        },
      };
    }),
    params
  );

  return questions.map((q) => {
    const results = index.query(q.question, depth);
    return {
      qid: q.qid,
      retrieved: results.map((r) => ({
        chunk_id: r.id,
        ...r.metadata,
        score: Number(r.score.toFixed(6)),
      })),
    };
  });
}

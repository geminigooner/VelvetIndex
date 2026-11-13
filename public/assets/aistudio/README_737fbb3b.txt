readme.me tag 


RAG retrieval eval

Zero dependencies, Node 18+. One CLI (eval.mjs), plain JSON/JSONL files.

Design rules

	1.	Gold lives at the source-span level, not the chunk level. Each question points at doc_id + section_id + a character range (plus the verbatim quote). A retrieved chunk counts as a hit if it overlaps that span, so section-based and fixed-size chunking are scored against the same truth.
	2.	One factor at a time. config.json defines a baseline and the factor values (dimensions, chunking, prepend_title). node eval.mjs runs lists the baseline plus one-factor ablations (5 runs). --grid lists all 12 combos.
	3.	Retrieval first. Hit@k and MRR come before any LLM judge. Add the judge only after retrieval numbers look sane.
	4.	Dev/test split. Tune on dev. Run --split test once at the end.

Files

|File                     |Purpose                                                 |
|-------------------------|--------------------------------------------------------|
|`schema.json`            |JSON Schema for one question                            |
|`questions.example.jsonl`|One question of each type, on a toy corpus              |
|`corpus.example.json`    |Corpus manifest: docs, sections with char ranges, sha256|
|`results.example.jsonl`  |Example retrieval output                                |
|`config.json`            |k, MRR depth, overlap rule, bootstrap seed, factor grid |
|`eval.mjs`               |`validate`, `runs`, `score`, `compare`                  |

Contracts your pipeline must follow

Corpus text: UTF-8, LF newlines, never edited after labeling (validate checks sha256). Offsets are JS string indices (UTF-16 units). If you port to Python, expect mismatches on emoji and other astral characters.

Chunk record (also store this as Vectorize metadata so eval needs no D1 lookup):

```json
{"chunk_id":"doc::section::s01","doc_id":"doc","section_id":"s01","char_start":0,"char_end":175}
```

char_start/char_end must point at the body text span in the original document. When prepend_title is on, the prepended title is not counted in the offsets.

Results line (one per question, best first, retrieve at least 10):

```json
{"qid":"q001","retrieved":[{"chunk_id":"...","doc_id":"...","section_id":"...","char_start":0,"char_end":175,"score":0.69}]}
```

score is cosine similarity, higher is better.

Workflow

```
node eval.mjs validate --questions questions.jsonl --corpus corpus.json
node eval.mjs runs
node eval.mjs score --questions questions.jsonl --results results/d768_section_t1.jsonl \
     --run-id d768_section_t1 --chunks chunks/section.jsonl --out reports/d768_section_t1.json
node eval.mjs compare reports/d768_section_t1.json reports/d512_section_t1.json
```

--chunks is optional. It resolves gold chunk IDs per question and warns when a chunking strategy cannot reach a gold span at all.

Metrics

	●	Hit@k (hit): all gold evidence appears in the top k. For single-evidence questions this is plain Hit@k. For multi-chunk it is the strict version. hit_any and recall show partial credit.
	●	MRR: reciprocal rank of the first gold hit within mrr_depth (10).
	●	95% CIs: seeded bootstrap, so reruns match.
	●	compare: paired bootstrap on per-question deltas. “NOT distinguishable from noise” means the CI includes 0.
	●	Unanswerable: excluded from Hit/MRR. The report gives top-1 score stats and a threshold sweep (abstain rate on unanswerable vs answer rate on answerable). Pick the threshold on dev only.

Caveats

	●	Chunk size flatters Hit@k. Bigger chunks overlap gold more easily. Check mean_chunk_chars next to every comparison.
	●	Small n is noisy. With about 30 answerable questions, differences under roughly 10 points usually won’t survive compare.
	●	Paraphrase questions should avoid the source’s wording. validate warns above 0.4 token overlap.
	●	Dimension ablation: embed once at 768, truncate to the first N dims, re-normalize (confirm the Matryoshka procedure on the model card). A Vectorize index has a fixed dimension count, so use one index per size, or score the truncated vectors offline.
	●	Editing a corpus file breaks gold offsets. validate catches it via sha256.

Ingest

chunk -> format -> embed (full 768) -> truncate + L2 renormalize -> vectors, then brute-force query that writes results/<run>.jsonl in the exact format eval.mjs score reads. The eval framework is untouched (ingest/eval.sha256 pins it).

Run everything from the rag-eval root so both tools share corpus.json, config.json, results/.

The offset rule

Every chunk record is {chunk_id, doc_id, section_id, char_start, char_end, n_tokens, chunking} where doc.text.slice(char_start, char_end) is the chunk body, exactly, with no outer whitespace. Titles and section headings exist only in the string sent to the model (embedText in ingest.mjs, the single place it is assembled). checkChunks re-verifies on every build that spans sit inside their section, cover all non-whitespace text, and have no duplicate IDs. If any invariant fails, the build stops before anything is embedded.

Chunking ids

|id           |meaning                              |
|-------------|-------------------------------------|
|`section`    |one chunk per manifest section       |
|`fixed512`   |512-token windows inside each section|
|`fixed512o64`|same, with 64-token overlap          |

	●	Windows never cross a section boundary, so each chunk has exactly one section_id.
	●	The token budget applies to the body only. The header adds a few tokens on top, and the combined string is checked against the model’s 8,192-token context.
	●	Short tails are merged. If a section’s last window has fewer than min_tail_fraction (0.25) of the window size in tokens, it is absorbed into the previous window (merged_tail: true) instead of becoming a fragment such as a single word. That chunk can then reach 1.25x the window size. Offsets stay exact (spans are only extended). Set min_tail_fraction to 0 for the old behavior. The setting is recorded in each vectors meta file. Dense, BM25 and the evidence-level scorer all read the same chunk file, so the change applies to every arm equally.
	●	A section over section_max_body_tokens (8000) is split into ...::wN chunks flagged oversize_split. Nothing is left for the model to truncate silently.
	●	Token counts come from the model’s own tokenizer (server /count). The mock embedder uses a regex approximation.
	●	Each window is recounted after the greedy fill and shrunk if tokenization turned out non-additive.

Title prepending (t1 vs t0)

It uses EmbeddingGemma 2’s native document format:

	●	t0: title: none | text: BODY (the model’s default document prompt)
	●	t1: title: DOC TITLE > SECTION HEADING | text: BODY

Queries use task: search result | query: .... Header parts are configurable in ingest.config.json (header_parts). Pipes and newlines in titles are sanitized so the body can always be recovered after the first | text: .

Note: manifest section ranges include the heading line, so a section chunk’s body already starts with its heading. With t1 the heading appears twice for those chunks. That is intentional and keeps section chunking identical to eval’s section ranges.

Dimensions

Embed once at 768 per (chunking, prepend) pair. Each dimension (768 / 512 / 256, and 128 if you want it) is first d values -> L2 normalize in vectors.mjs. Queries go through the same function. That file has no Node APIs, so the Cloudflare query Worker can import it unchanged. Vectors are stored with 8 decimals and stay unit length to within 1e-6.

Outputs

	●	out/chunks/<chunking>.jsonl — chunk records (this is eval’s --chunks file)
	●	out/vectors/<run_id>.jsonl — Vectorize NDJSON shape {id, values, metadata:{doc_id, section_id, char_start, char_end}}
	●	out/vectors/<run_id>.meta.json — provenance (embedder id, formats, corpus hashes). query refuses to run if the embedder id differs.
	●	results/<run_id>.jsonl — retrieval output for eval.mjs
	●	out/cache/*.jsonl — embedding cache, so rebuilds only embed what changed

Commands

Toy corpus, mock embedder (plumbing only; scores are meaningless):

```
node ingest/ingest.mjs build --embedder mock --corpus corpus.example.json
node ingest/ingest.mjs query --embedder mock --questions questions.example.jsonl
mkdir -p reports
for r in $(node eval.mjs runs | cut -d' ' -f1); do
  c=$(echo $r | cut -d_ -f2)
  node eval.mjs score --questions questions.example.jsonl --results results/$r.jsonl \
    --run-id $r --chunks out/chunks/$c.jsonl --out reports/$r.json
done
node eval.mjs compare reports/d768_section_t1.json reports/d768_section_t0.json
```

Real model:

```
export EMBED_URL=https://<owner>-<space-name>.hf.space EMBED_API_KEY=<secret>
export HF_TOKEN=<token>        # only if the Space is private
node ingest/ingest.mjs build --embedder http --corpus corpus.json
node ingest/ingest.mjs query --embedder http --questions questions.jsonl
```

--runs takes baseline (default), grid, or ids like d768_fixed512o64_t1,d256_section_t0. node ingest/ingest.mjs runs prints the plan.

Deploy the embedding Space

	1.	On Hugging Face create a new Space: SDK Docker (blank template), CPU hardware is enough for the 270M text path.
	2.	Upload app.py, Dockerfile, requirements.txt and README.md from ingest/embed_server/.
	3.	In the Space settings add the secret EMBED_API_KEY. Add HF_TOKEN only if the model download asks for auth.
	4.	When it is running, open <space-url>/health. You want "dim": 768 and "prompt_ok": true. If prompt_ok is false or null, stop. The server’s check compares encode("title: none | text: X") with encode_document("X"), and the client refuses a server that fails it.

Tests

```
node --test ingest/test.mjs                              # 22 tests
python3 -m unittest ingest/embed_server/test_app.py      # 7 tests, model stubbed
```

If you deliberately change an eval file, regenerate the pin:
sha256sum eval.mjs schema.json config.json questions.example.jsonl corpus.example.json results.example.jsonl README.md > ingest/eval.sha256

Not verified here

Hugging Face is outside this sandbox’s network allowlist, so the real model and tokenizer were never loaded. Everything except the model itself was exercised: the real FastAPI app ran with a stubbed model and the Node client drove it end to end. Still unconfirmed against the real thing:

	●	the sentence-transformers calls in app.py (model_kwargs={"dtype": ...}, encode_document, model.tokenizer) and the sentence-transformers>=6.1 pin
	●	token counts from the real Gemma tokenizer
	●	speed and memory on CPU basic hardware

The /health self-check covers prompt handling. Run build on the toy corpus against the live Space first, then compare its chunk token counts with what you expect.

STAIR-inspired retrieval extension

Arms C and D are STAIR-inspired, untrained approximations. They are not a reproduction of STAIR, which fine-tunes a 7B model per corpus (paper: arXiv 2609.03874). Nothing here measures how STAIR itself would perform on your corpus.

Nothing in eval.mjs, ingest/, the delivered schemas, or ingest/eval.sha256 was modified. Everything lives in stair/.

Arms and tracks

|Arm|What it is                                                                                                             |
|---|-----------------------------------------------------------------------------------------------------------------------|
|A  |Dense retrieval (EmbeddingGemma 2 via `ingest/`), unchanged                                                            |
|B  |BM25 over the same chunk file (k1, b, stopwords configurable; recorded in meta)                                        |
|C  |An LLM reads the ToC and selects document-qualified section ids; ids are validated against the ToC; explicit abstention|
|D  |C’s routes, then dense retrieval inside the routed sections, then global fallback fill                                 |

	●	Track S (section level): whole-section spans; a hit means the gold evidence lies inside a returned section. A, B, C compete here.
	●	Track E (evidence level): passage spans under eval.mjs’s overlap rule. A, B, D compete here.
	●	A nearby section earns nothing. Section routing accuracy (Track S) and evidence retrieval (Track E) are reported separately and never merged.
	●	Gold labels are still source-document character spans. Paths and headings exist only inside prompts and embedded strings, never in any offset.
	●	Pre-declared primary tests: H1 = C vs A on Track S (open corpus). H2 = D (fallback) vs A on Track E (open corpus). Everything else is exploratory.

Roles (stair/config.json; every model id is configurable)

|Role            |Default               |Notes                                                                                                   |
|----------------|----------------------|--------------------------------------------------------------------------------------------------------|
|Arm C router    |gemini-4-argon        |thinking level `low`; same model as the diagnostic judge (stated in every diagnostic prompt and in meta)|
|Answer generator|gemini-3.8-flash      |identical config for every arm (fingerprinted); arm-blind prompt                                        |
|Primary judge   |gemini-3.1-pro-preview|blinded rubric scoring                                                                                  |
|Diagnostic judge|gemini-4-argon        |triggered cases only; descriptive, not for hypothesis tests                                             |

Deterministic retrieval metrics (Hit@5, MRR, recall, bootstrap, paired comparison) come only from eval.mjs. No LLM output influences them. judge/crosscheck.py is an optional Python re-implementation used purely to test eval.mjs.

temperature is unset by default (Google recommends leaving Gemini 3 at its default). Reproducibility comes from the content-addressed caches, the repeats, and recorded model versions, not from temperature 0.

Quick start

Everything from the rag-eval root.

```
# 1. dress rehearsal on the toy corpus (mock embedder + mock LLM, seconds, no network)
node stair/experiment.mjs run --corpus stair/fixtures/corpus.toc.example.json --questions stair/fixtures/questions.toc.example.jsonl \
     --oracle stair/fixtures/oracle_docs.example.json --split dev --run-dir runs/rehearsal --embedder mock --llm mock --repeats 2
# 2. your corpus: markdown/text with headings -> manifest with ToC
node stair/extract.mjs --in my_docs/ --out corpus.toc.json
node stair/toc.mjs validate --corpus corpus.toc.json
node stair/toc.mjs stats --corpus corpus.toc.json          # how generic are the headings?
# 3. questions: prefilled gold spans, you write question + expected_answer
node stair/qtools.mjs sample --corpus corpus.toc.json --per-leaf 2 --paraphrase-rate 0.5 --multi 15 --unanswerable 30 --out questions.todo.jsonl
node stair/qtools.mjs split --questions questions.jsonl --out questions.split.jsonl     # once; refuses to reshuffle
# 4. inspect, then run the real DEV experiment
export EMBED_URL=... EMBED_API_KEY=... GEMINI_API_KEY=...
node stair/experiment.mjs plan --corpus corpus.toc.json --questions questions.jsonl --oracle oracle_docs.json --split dev --run-dir runs/dev1 --embedder http --llm gemini
node stair/experiment.mjs run  (same flags)                 # resumable: add --resume after a failure
# 5. when dev tuning is finished: lock, then the single test run
node stair/prereg.mjs lock --questions questions.jsonl --corpus corpus.toc.json --oracle oracle_docs.json --note "dev tuning done"
node stair/experiment.mjs run --split test --run-dir runs/test1 (same flags)
```

The test split refuses to run without an intact lock, refuses a second use (a deliberate rerun needs --allow-test-rerun "reason", logged to tests/test_runs.jsonl), and allows resuming the same run directory after a crash. The questions file contains both splits; dev runs only score dev questions, but if you want test question text kept out of sight during tuning, keep it in a separate file.

What a run produces (runs/NAME/)

summary.md and summary.json are the entry point. Behind them: reports/ (eval.mjs reports, comparisons, budget, abstention, variance, judge aggregate), routes/, results/, telemetry/ (tokens, latency, finish reason, model version, timestamps), answers/, judgments/, out/ (chunks, vectors, caches, run metadata). Every LLM call is cached by content, so re-running costs nothing for identical requests.

Tests

```
node --test stair/test/*.test.mjs                  # 53 tests (Node)
python3 -m unittest stair/judge/test_judge.py      # 33 tests (Python, stdlib only)
node --test ingest/test.mjs ; python3 -m unittest ingest/embed_server/test_app.py
```

Each stage was also mutation-tested: deliberately injected bugs must make a test fail. Several initially did not, which exposed real test gaps (fixed). Remaining blind spots are listed below.

Not verified here (read before trusting a real run)

	●	No live API was ever called. The Gemini client, Space server, and prompts were exercised against stub servers that mimic the documented request/response shapes. Confirm on the first real call: the model id strings (gemini-4-argon and gemini-3.1-pro-preview appear in Google docs/listings; confirm gemini-3.8-flash yourself), the thinkingLevel value spelling (low/medium/high), and that responseJsonSchema is accepted (set schema_field to responseSchema in config if not).
	●	Argon pricing was inconsistent across sources and one source tied standard pricing to Nov 30, 2026. Check Google’s pricing page before budgeting.
	●	Real EmbeddingGemma 2 and its tokenizer were never loaded (Hugging Face is outside this sandbox). See ingest/README.md.
	●	Mock embedder and mock LLM results are meaningless. They test plumbing only.
	●	Small question sets make every interval wide; summary.md warns below 30 answerable questions per arm. Aim for 100+.

Observations worth knowing

	●	ingest/embedders.mjs’s mock can produce a zero 256-dim prefix for one-word chunks (not an issue for a real model). Not modified, per your rule.
	●	Greedy token windows used to leave tiny tail chunks (one or two words), which distorted BM25. Fixed: a section’s last window shorter than min_tail_fraction (0.25) of the window size is merged into the previous one (ingest/ingest.config.json; 0 restores the old behavior). Dense, BM25 and the scorer share the one chunk file, so it applies to every arm equally.
	●	eval.mjs score --out does not create its output directory; the driver creates reports/ itself.
	●	Section results for Arm C are whole sections (up to 5), so retrieved characters per query differ greatly by arm. That is why the summary prints retrieved characters beside every Hit@5, and why generation uses one uniform evidence character budget.

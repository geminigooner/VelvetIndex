"""EmbeddingGemma 2 embedding API for the RAG pipeline (text only).

Endpoints
  GET  /health  model, dim, and a startup self-check that no prompt prefix is doubled or missing
  POST /embed   {"texts": [...]} -> full 768-dim vectors for ALREADY-FORMATTED strings
                (the client sends "title: ... | text: ..." / "task: search result | query: ...")
  POST /count   {"texts": [...]} -> token counts with the model's own tokenizer (used for chunking)

The server never truncates dimensions. Matryoshka truncation + re-normalization happens client-side
(ingest/vectors.mjs), identically for documents and queries.
"""
import hmac
import os
import threading
from typing import List, Optional

import numpy as np
import torch
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_ID = os.environ.get("MODEL_ID", "google/embeddinggemma-2")
DTYPE_NAME = os.environ.get("DTYPE", "float32")  # never float16: this model's activations overflow in fp16
MAX_SEQ_LEN = int(os.environ.get("MAX_SEQ_LEN", "8192"))
MAX_BATCH = int(os.environ.get("MAX_BATCH", "64"))
API_KEY = os.environ.get("EMBED_API_KEY")  # optional shared secret, sent as the x-api-key header

DTYPES = {"float32": torch.float32, "bfloat16": torch.bfloat16}
if DTYPE_NAME not in DTYPES:
    raise SystemExit(f"DTYPE must be one of {sorted(DTYPES)}")

model = SentenceTransformer(MODEL_ID, model_kwargs={"dtype": DTYPES[DTYPE_NAME]}, token=os.environ.get("HF_TOKEN"))
model.max_seq_length = MAX_SEQ_LEN
_lock = threading.Lock()  # one forward pass at a time on a small CPU Space


def _find_tokenizer():
    tok = getattr(model, "tokenizer", None)
    if tok is None:
        tok = getattr(getattr(model, "processor", None), "tokenizer", None)
    if tok is None:
        raise SystemExit("could not locate the model's tokenizer")
    return tok


tokenizer = _find_tokenizer()
DIM = int(np.asarray(model.encode("dimension probe", convert_to_numpy=True)).shape[-1])


def _prompt_check():
    """encode('title: none | text: X') must equal encode_document('X'); otherwise a prefix is doubled or dropped."""
    try:
        a = model.encode("title: none | text: hello world", normalize_embeddings=True, convert_to_numpy=True)
        b = model.encode_document("hello world", normalize_embeddings=True, convert_to_numpy=True)
        cos = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
        return cos > 0.999, cos, None
    except Exception as exc:  # older sentence-transformers without encode_document, etc.
        return None, None, str(exc)


PROMPT_OK, PROMPT_COS, PROMPT_ERR = _prompt_check()
if PROMPT_OK is False:
    print(f"!! PROMPT SELF-CHECK FAILED (cosine {PROMPT_COS:.4f}); clients will refuse to use this server")

app = FastAPI(title="EmbeddingGemma 2 embed API")


class Texts(BaseModel):
    texts: List[str]


def _guard(key: Optional[str], texts: List[str]):
    if API_KEY and not hmac.compare_digest((key or "").encode(), API_KEY.encode()):
        raise HTTPException(status_code=401, detail="bad or missing x-api-key")
    if not texts:
        raise HTTPException(status_code=422, detail="texts must be non-empty")
    if len(texts) > MAX_BATCH:
        raise HTTPException(status_code=413, detail=f"at most {MAX_BATCH} texts per request")


def _lengths(texts: List[str], special: bool) -> List[int]:
    enc = tokenizer(texts, add_special_tokens=special, truncation=False)
    return [len(ids) for ids in enc["input_ids"]]


@app.get("/health")
def health():
    return {
        "model": MODEL_ID,
        "dim": DIM,
        "max_seq_len": MAX_SEQ_LEN,
        "dtype": DTYPE_NAME,
        "prompt_ok": PROMPT_OK,
        "prompt_cosine": PROMPT_COS,
        "prompt_check_error": PROMPT_ERR,
    }


@app.post("/embed")
def embed(req: Texts, x_api_key: Optional[str] = Header(default=None)):
    _guard(x_api_key, req.texts)
    lengths = _lengths(req.texts, special=True)
    with _lock:
        vecs = model.encode(req.texts, batch_size=8, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    return {
        "model": MODEL_ID,
        "dim": DIM,
        "embeddings": np.asarray(vecs, dtype=np.float32).tolist(),
        "n_tokens": lengths,
        "truncated": [n > MAX_SEQ_LEN for n in lengths],
    }


@app.post("/count")
def count(req: Texts, x_api_key: Optional[str] = Header(default=None)):
    _guard(x_api_key, req.texts)
    return {"counts": _lengths(req.texts, special=False)}

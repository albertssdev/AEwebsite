#!/usr/bin/env python3
"""
Build sermon/embeddings.json — sentence-embedding vectors for semantic search
on the /sermon page. Run after build_sermons_json.py.

Model: sentence-transformers/all-MiniLM-L6-v2 (384-dim). The browser uses the
same model via transformers.js (Xenova/all-MiniLM-L6-v2), so the query vector
and these document vectors live in the same space.

Vectors are L2-normalised, quantised to int8, and packed base64 — ~220 KB for
~600 sermons, versus ~900 KB as raw float32.

    pip install sentence-transformers
    python scripts/build_embeddings.py
"""
import base64
import json
import pathlib

import numpy as np

REPO = pathlib.Path(__file__).resolve().parent.parent
SERMONS = REPO / "sermon" / "sermons.json"
OUT = REPO / "sermon" / "embeddings.json"
MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def doc_text(s: dict) -> str:
    parts = [s.get("title", ""), s.get("title_alt", ""), s.get("speaker", ""),
             s.get("summary", "")]
    for k in ("scripture", "themes", "topics", "keywords"):
        v = s.get(k)
        if v:
            parts.append(", ".join(v))
    return " . ".join(p for p in parts if p).strip()


def main():
    sermons = json.loads(SERMONS.read_text(encoding="utf-8"))
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(MODEL)
    docs = [doc_text(s) for s in sermons]
    print(f"embedding {len(docs)} sermons with {MODEL} ...")
    vecs = model.encode(docs, batch_size=64, normalize_embeddings=True,
                        show_progress_bar=True).astype(np.float32)

    dim = vecs.shape[1]
    q = np.clip(np.round(vecs * 127.0), -127, 127).astype(np.int8)
    OUT.write_text(json.dumps({
        "model": "Xenova/all-MiniLM-L6-v2",
        "dim": dim,
        "quant": "int8",
        "scale": 1.0 / 127.0,
        "ids": [s["id"] for s in sermons],
        "data": base64.b64encode(q.tobytes()).decode("ascii"),
    }), encoding="utf-8")
    kb = OUT.stat().st_size / 1024
    print(f"wrote {OUT}  ({kb:,.0f} KB, dim {dim})")


if __name__ == "__main__":
    main()

"""Build a local embeddings index for profile_chunks.json.

This lets you do 'mini-RAG' without any database: the app ships with a JSON file
containing embeddings for each chunk.

Usage (from repo root):
  export GEMINI_API_KEY=...
  python backend/scripts/build_profile_index.py

It will write: backend/app/profile_index.json
"""

import json
import os
import time
from typing import Any, Dict, List, Optional


CHUNKS_PATH = os.path.join(os.path.dirname(__file__), "..", "app", "profile_chunks.json")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "app", "profile_index.json")

EMBED_MODEL = os.getenv("PROFILE_EMBED_MODEL", "gemini-embedding-001")
OUTPUT_DIM = int(os.getenv("PROFILE_EMBED_DIM", "256"))


def _extract_vector(embed_result: Any) -> Optional[List[float]]:
    # Mirrors backend/app/retrieval.py
    if embed_result is None:
        return None

    if isinstance(embed_result, dict):
        if "embedding" in embed_result and isinstance(embed_result["embedding"], dict):
            v = embed_result["embedding"].get("values")
            if isinstance(v, list):
                return [float(x) for x in v]
        if "embeddings" in embed_result and isinstance(embed_result["embeddings"], list) and embed_result["embeddings"]:
            e0 = embed_result["embeddings"][0]
            if isinstance(e0, dict) and "values" in e0:
                return [float(x) for x in e0["values"]]

    if hasattr(embed_result, "embedding"):
        emb = getattr(embed_result, "embedding")
        if hasattr(emb, "values"):
            return [float(x) for x in list(getattr(emb, "values"))]
        if isinstance(emb, dict) and "values" in emb:
            return [float(x) for x in emb["values"]]

    if hasattr(embed_result, "embeddings"):
        embs = getattr(embed_result, "embeddings")
        if isinstance(embs, list) and embs:
            e0 = embs[0]
            if hasattr(e0, "values"):
                return [float(x) for x in list(getattr(e0, "values"))]
            if isinstance(e0, dict) and "values" in e0:
                return [float(x) for x in e0["values"]]

    return None


def main() -> None:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("Missing GEMINI_API_KEY")

    from google import genai
    from google.genai import types

    with open(CHUNKS_PATH, "r", encoding="utf-8") as f:
        chunks: List[Dict[str, str]] = json.load(f)

    client = genai.Client(api_key=api_key)

    items: List[Dict[str, Any]] = []
    for c in chunks:
        title = (c.get("title") or "").strip()
        text = (c.get("text") or "").strip()
        if not text:
            continue

        # Prefer retrieval-aware embeddings for documents.
        cfg_kwargs: Dict[str, Any] = {
            "task_type": "RETRIEVAL_DOCUMENT",
            "output_dimensionality": OUTPUT_DIM,
        }
        if title:
            # Title is supported for RETRIEVAL_DOCUMENT and can improve quality.
            cfg_kwargs["title"] = title

        try:
            cfg = types.EmbedContentConfig(**cfg_kwargs)
        except TypeError:
            # Fallback for older SDKs
            cfg = types.EmbedContentConfig()

        res = client.models.embed_content(model=EMBED_MODEL, contents=text, config=cfg)
        vec = _extract_vector(res)
        if not vec:
            raise RuntimeError(f"Failed to embed chunk: {c.get('id')}")

        # Keep file smaller: round floats a bit (good enough for similarity search).
        vec = [round(float(x), 8) for x in vec]

        items.append({
            "id": c.get("id"),
            "title": title,
            "text": text,
            "embedding": vec,
        })

        time.sleep(0.05)  # gentle pacing

    out = {
        "model": EMBED_MODEL,
        "output_dimensionality": OUTPUT_DIM,
        "created_unix": int(time.time()),
        "items": items,
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    print(f"Wrote {OUT_PATH} with {len(items)} items (model={EMBED_MODEL}, dim={OUTPUT_DIM}).")


if __name__ == "__main__":
    main()

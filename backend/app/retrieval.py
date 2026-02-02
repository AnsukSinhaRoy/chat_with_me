import json
import math
import os
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple


HERE = os.path.dirname(__file__)
CHUNKS_PATH = os.path.join(HERE, "profile_chunks.json")
INDEX_PATH = os.path.join(HERE, "profile_index.json")


def _cosine(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return -1.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return -1.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


@lru_cache(maxsize=1)
def load_chunks() -> List[Dict[str, Any]]:
    with open(CHUNKS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def load_index() -> Optional[Dict[str, Any]]:
    """Load precomputed embeddings index if it exists."""
    if not os.path.exists(INDEX_PATH):
        return None
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _extract_vector(embed_result: Any) -> Optional[List[float]]:
    """Extract a float vector from google-genai embed_content result.

    The SDK response shape can vary a bit by version. We handle common shapes.
    """
    if embed_result is None:
        return None

    # dict-ish shapes
    if isinstance(embed_result, dict):
        if "embedding" in embed_result and isinstance(embed_result["embedding"], dict):
            v = embed_result["embedding"].get("values")
            if isinstance(v, list):
                return [float(x) for x in v]
        if "embeddings" in embed_result and isinstance(embed_result["embeddings"], list) and embed_result["embeddings"]:
            e0 = embed_result["embeddings"][0]
            if isinstance(e0, dict) and "values" in e0:
                return [float(x) for x in e0["values"]]

    # object shapes
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


def build_context_from_index(
    query_vec: List[float],
    index: Dict[str, Any],
    k: int = 3,
    min_score: float = 0.15,
    max_chars: int = 2800,
) -> str:
    items = index.get("items") or []
    scored: List[Tuple[float, Dict[str, Any]]] = []
    for it in items:
        vec = it.get("embedding")
        if not isinstance(vec, list):
            continue
        s = _cosine(query_vec, vec)
        scored.append((s, it))
    scored.sort(key=lambda x: x[0], reverse=True)

    picked = [it for s, it in scored[:k] if s >= min_score]
    if not picked:
        return ""

    blocks = []
    for it in picked:
        title = (it.get("title") or "").strip()
        text = (it.get("text") or "").strip()
        if not text:
            continue
        if title:
            blocks.append(f"### {title}\n{text}")
        else:
            blocks.append(text)

    out = "\n\n".join(blocks).strip()
    return out[:max_chars]


def build_profile_context(
    *,
    client,
    question_text: str,
    embed_model: str = "gemini-embedding-001",
    output_dimensionality: int = 256,
    k: int = 3,
    min_score: float = 0.15,
    max_chars: int = 2800,
) -> str:
    """Return a short FACTS CONTEXT block relevant to the question.

    Uses a precomputed on-disk index when available; otherwise returns empty.
    (You can generate the index with backend/scripts/build_profile_index.py)
    """
    idx = load_index()
    if not idx:
        return ""

    try:
        # Query embedding (RETRIEVAL_QUERY)
        from google.genai import types

        q = (question_text or "").strip()
        if not q:
            return ""

        def _try_embed(config_kwargs: Dict[str, Any]):
            try:
                cfg = types.EmbedContentConfig(**config_kwargs) if config_kwargs else None
                return client.models.embed_content(model=embed_model, contents=q, config=cfg)
            except TypeError:
                # Some SDK versions may not support one of the config fields.
                cfg = types.EmbedContentConfig() if config_kwargs else None
                return client.models.embed_content(model=embed_model, contents=q, config=cfg)

        # Prefer retrieval-aware embeddings + smaller vectors.
        res = _try_embed({
            "task_type": "RETRIEVAL_QUERY",
            "output_dimensionality": output_dimensionality,
        })
        qvec = _extract_vector(res)
        if not qvec:
            return ""
        return build_context_from_index(qvec, idx, k=k, min_score=min_score, max_chars=max_chars)
    except Exception:
        # Retrieval is a bonus; never break chat.
        return ""

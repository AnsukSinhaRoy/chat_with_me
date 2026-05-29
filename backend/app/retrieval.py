import json
import math
import os
import re
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple


HERE = os.path.dirname(__file__)
CHUNKS_PATH = os.path.join(HERE, "profile_chunks.json")
INDEX_PATH = os.path.join(HERE, "profile_index.json")

_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
    "he", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our", "that", "the", "this",
    "to", "was", "we", "what", "when", "where", "which", "who", "why", "with", "you", "your",
}


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
    """Load the legacy embedding index if it exists.

    The Runtime no longer depends on this file. It is kept only so older
    local tooling does not break if it imports load_index().
    """
    if not os.path.exists(INDEX_PATH):
        return None
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _tokens(text: str) -> List[str]:
    return [
        token
        for token in re.findall(r"[a-zA-Z0-9]+", (text or "").lower())
        if len(token) > 2 and token not in _STOPWORDS
    ]


def _keyword_score(query_tokens: List[str], item: Dict[str, Any]) -> float:
    title = item.get("title") or ""
    text = item.get("text") or ""
    haystack = f"{title} {text}".lower()
    if not query_tokens:
        return 0.0
    score = 0.0
    for token in query_tokens:
        # Exact-ish keyword hits are sufficient because the profile corpus is tiny.
        count = haystack.count(token)
        if count:
            score += 1.0 + min(count, 4) * 0.25
    return score / max(len(query_tokens), 1)


def _always_include(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    important_ids = {"identity", "education", "current_role", "internship"}
    return [item for item in items if item.get("id") in important_ids]


def build_context_from_index(
    query_vec: List[float],
    index: Dict[str, Any],
    k: int = 3,
    min_score: float = 0.15,
    max_chars: int = 2800,
) -> str:
    """Legacy vector-index context builder retained for old scripts/tests."""
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
    return _format_blocks(picked, max_chars=max_chars)


def _format_blocks(items: List[Dict[str, Any]], max_chars: int) -> str:
    blocks = []
    seen = set()
    for item in items:
        item_id = item.get("id") or item.get("title") or item.get("text")
        if item_id in seen:
            continue
        seen.add(item_id)
        title = (item.get("title") or "").strip()
        text = (item.get("text") or "").strip()
        if not text:
            continue
        blocks.append(f"### {title}\n{text}" if title else text)
    return "\n\n".join(blocks).strip()[:max_chars]


def build_profile_context(
    *,
    question_text: str,
    client: Any = None,
    embed_model: str = "",
    output_dimensionality: int = 256,
    k: int = 4,
    min_score: float = 0.10,
    max_chars: int = 2800,
) -> str:
    """Return a short FACTS CONTEXT block relevant to the question.

    This version intentionally avoids a second paid embedding API call. The
    profile corpus is small, so lexical matching is good enough and cheaper for
    a Vercel deployment.
    """
    try:
        items = load_chunks()
    except Exception:
        return ""

    query_tokens = _tokens(question_text)
    scored = [(_keyword_score(query_tokens, item), item) for item in items]
    scored.sort(key=lambda pair: pair[0], reverse=True)

    picked: List[Dict[str, Any]] = []
    picked.extend(_always_include(items)[:2])
    picked.extend(item for score, item in scored if score >= min_score)

    if not picked:
        picked = _always_include(items)[:2] or items[:2]

    return _format_blocks(picked[: max(k, 1) + 2], max_chars=max_chars)

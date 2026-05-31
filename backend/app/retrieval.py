import json
import math
import os
import re
from functools import lru_cache
from typing import Any, Dict, Iterable, List, Optional, Tuple


HERE = os.path.dirname(__file__)
CHUNKS_PATH = os.path.join(HERE, "profile_chunks.json")
INDEX_PATH = os.path.join(HERE, "profile_index.json")

_STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
    "for", "from", "had", "has", "have", "he", "how", "i", "in", "into", "is", "it",
    "me", "my", "of", "on", "or", "our", "so", "that", "the", "their", "this", "to",
    "was", "we", "were", "what", "when", "where", "which", "who", "why", "with", "you", "your",
}

# These anchors make short interview prompts work. Example: "tell me about your RL work"
# should still retrieve the Nokia chunk even if the prompt does not say "Nokia".
_QUERY_EXPANSIONS = {
    "rl": ["reinforcement", "drl", "nokia", "dqn", "rrm"],
    "drl": ["reinforcement", "nokia", "dqn", "rrm", "beam"],
    "reinforcement": ["drl", "nokia", "dqn", "rrm"],
    "dqn": ["dueling", "double", "nokia", "per", "action", "masking"],
    "beam": ["nokia", "rrm", "throughput", "interference"],
    "internship": ["nokia", "applied", "machine", "learning", "rrm", "outcome", "evaluation", "generalizability"],
    "experience": ["nokia", "hermis", "thesis", "hackathon"],
    "project": ["hermis", "thesis", "portfolio", "nokia"],
    "research": ["thesis", "portfolio", "online", "learning", "oco"],
    "thesis": ["portfolio", "sparse", "switching", "ftrl", "pgd", "supervisor", "guide", "samrat"],
    "portfolio": ["sparse", "switching", "online", "ftrl", "risk"],
    "optimization": ["online", "convex", "ftrl", "pgd", "simplex"],
    "oco": ["online", "convex", "ftrl", "portfolio"],
    "objective": ["return", "covariance", "switching", "penalty", "risk"],
    "loss": ["objective", "covariance", "switching", "penalty", "risk"],
    "algorithm": ["support", "selection", "pgd", "simplex", "hessian"],
    "sparsity": ["sparse", "cardinality", "simplex", "long", "only"],
    "cgpa": ["education", "mtech", "iit", "dhanbad"],
    "education": ["mtech", "btech", "iit", "uem", "cgpa"],
    "guide": ["supervisor", "samrat", "mukhopadhyay", "mtech", "thesis"],
    "supervisor": ["guide", "samrat", "mukhopadhyay", "mtech", "thesis"],
    "outcome": ["nokia", "internship", "evaluation", "generalizability", "fine", "tuning"],
    "evaluation": ["nokia", "internship", "outcome", "generalizability", "simulations"],
    "generalizability": ["nokia", "internship", "continual", "learning", "fine", "tuning"],
    "leadership": ["spr", "placement", "hackathon", "team", "lead"],
    "placement": ["spr", "responsibility", "iit"],
    "100x": ["assessment", "ai", "agent", "voicebot", "rag", "memory", "shipping", "owner"],
    "hundredx": ["100x", "assessment", "ai", "agent", "voicebot", "rag", "memory", "shipping", "owner"],
    "assessment": ["100x", "stage", "voicebot", "web", "app", "user", "friendly", "rag"],
    "stage": ["100x", "assessment", "voicebot", "web", "app"],
    "voicebot": ["voice", "bot", "100x", "assessment", "ai", "twin", "rag", "web", "app"],
    "voice": ["voicebot", "100x", "assessment", "speech", "chat", "input"],
    "agent": ["agents", "100x", "autonomous", "memory", "workflow", "backend", "conversation"],
    "agents": ["agent", "100x", "autonomous", "memory", "workflow", "backend", "conversation"],
    "rag": ["retrieval", "knowledge", "base", "context", "100x", "assessment"],
    "memory": ["chat", "history", "localstorage", "conversation", "100x", "agent"],
    "localstorage": ["local", "memory", "chat", "history", "conversation"],
    "shipping": ["ship", "fast", "weekly", "iteration", "feedback", "product", "100x"],
    "ship": ["shipping", "fast", "weekly", "iteration", "feedback", "product", "100x"],
    "owner": ["ownership", "accountability", "100x", "shipping", "decision"],
    "ownership": ["owner", "accountability", "100x", "shipping", "decision"],
    "customer": ["user", "product", "feedback", "conversational", "improvements", "100x"],
    "fit": ["100x", "role", "agent", "ownership", "shipping", "nokia", "hermis", "assessment"],
    "role": ["100x", "fit", "agent", "ownership", "shipping", "nokia", "hermis", "assessment"],
    "hire": ["100x", "fit", "agent", "ownership", "shipping", "assessment"],
    "sales": ["100x", "agent", "playbook", "closer", "operational", "workflow"],
    "operations": ["100x", "agent", "playbook", "operational", "workflow", "assistant"],
    "playbook": ["workflow", "sales", "operations", "100x", "agent"],
    "superpower": ["ownership", "ambiguity", "shipping", "nokia", "hermis", "assessment", "behavioral"],
    "strength": ["superpower", "ownership", "nokia", "hermis", "assessment"],
    "growth": ["learning", "weakness", "areas", "100x", "agent", "sales", "playbook"],
    "misconception": ["coworkers", "behavioral", "ownership", "communication", "nokia"],
    "coworkers": ["misconception", "behavioral", "team", "nokia", "spr"],
    "boundaries": ["limits", "ownership", "debugging", "nokia", "thesis", "hermis", "shipping"],
    "limits": ["boundaries", "ownership", "debugging", "nokia", "thesis", "hermis", "shipping"],
    "story": ["life", "identity", "education", "nokia", "thesis", "hermis"],
    "life": ["story", "identity", "education", "nokia", "thesis", "hermis"],
}

_PINNED_IDS = ("identity", "current_status_education", "answer_policy")
_DEFAULT_CONTEXT_IDS = ("nokia_internship", "thesis_overview", "hermis_project")


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
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("profile_chunks.json must contain a list of chunks")
    return data


@lru_cache(maxsize=1)
def load_index() -> Optional[Dict[str, Any]]:
    """Load the legacy embedding index if it exists.

    The chat runtime does not depend on this file. It is retained only so older
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
        if len(token) > 1 and token not in _STOPWORDS
    ]


def _dedupe(items: Iterable[str]) -> List[str]:
    seen = set()
    out = []
    for item in items:
        if item and item not in seen:
            out.append(item)
            seen.add(item)
    return out


def _expanded_query_tokens(question_text: str) -> List[str]:
    base = _tokens(question_text)
    expanded = list(base)
    for token in base:
        expanded.extend(_QUERY_EXPANSIONS.get(token, []))
    return _dedupe(expanded)


def _chunk_parts(item: Dict[str, Any]) -> Tuple[str, str, str]:
    title = str(item.get("title") or "")
    tags = " ".join(str(t) for t in item.get("tags") or [])
    text = str(item.get("text") or "")
    return title.lower(), tags.lower(), text.lower()


def _keyword_score(query_tokens: List[str], raw_question: str, item: Dict[str, Any]) -> float:
    """Score a tiny personal-profile corpus without a paid embedding call.

    Scoring intentionally favors tags/title over long body text, then adds a
    small priority prior. This keeps stable identity facts present while still
    letting topical chunks win when the user asks about Nokia, thesis, Hermis,
    etc.
    """
    if not query_tokens:
        return 0.0

    title, tags, text = _chunk_parts(item)
    score = 0.0

    for token in query_tokens:
        if token in title:
            score += 2.4
        if token in tags:
            score += 1.8
        count = text.count(token)
        if count:
            score += 0.8 + min(count, 5) * 0.15

    # Reward exact phrase hits for multi-word project/entity names.
    raw = (raw_question or "").lower()
    haystack = f"{title} {tags} {text}"
    important_phrases = [
        "nokia standards", "internship outcome", "site based fine tuning", "dueling double dqn", "prioritized experience replay",
        "action masking", "sparse online portfolio learning", "sparse switching",
        "windowed ftrl", "projected gradient descent", "cardinality constrained simplex",
        "hermis", "inter iit", "student placement representative", "dr samrat mukhopadhyay",
        "100x", "ai agent", "ai agents", "voice bot", "voicebot", "ai twin", "stage 1 assessment",
        "basic memory stack", "chat history", "local storage", "localstorage", "production ready",
        "customer-facing conversational improvements", "weekly releases", "sales playbook", "operational role",
    ]
    for phrase in important_phrases:
        if phrase in raw and phrase in haystack:
            score += 4.0

    priority = float(item.get("priority") or 0.0)
    score += min(max(priority, 0.0), 100.0) / 100.0 * 0.35
    return score / max(len(query_tokens), 1)


def _items_by_id(items: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {str(item.get("id")): item for item in items if item.get("id")}


def _pinned_context(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_id = _items_by_id(items)
    return [by_id[item_id] for item_id in _PINNED_IDS if item_id in by_id]


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
    k: int = 5,
    min_score: float = 0.18,
    max_chars: int = 4200,
) -> str:
    """Return a compact FACTS CONTEXT block relevant to the latest question.

    The profile corpus is intentionally small and curated, so deterministic
    lexical retrieval is more reliable and cheaper than making a second model
    call for embeddings on every chat request.
    """
    try:
        items = load_chunks()
    except Exception:
        return ""

    by_id = _items_by_id(items)
    query_tokens = _expanded_query_tokens(question_text)
    scored = [(_keyword_score(query_tokens, question_text, item), item) for item in items]
    scored.sort(key=lambda pair: pair[0], reverse=True)

    picked: List[Dict[str, Any]] = []
    picked.extend(_pinned_context(items))
    picked.extend(item for score, item in scored if score >= min_score)

    if len(picked) <= len(_PINNED_IDS):
        picked.extend(by_id[item_id] for item_id in _DEFAULT_CONTEXT_IDS if item_id in by_id)

    topical_limit = max(k, 1) + len(_PINNED_IDS)
    return _format_blocks(picked[:topical_limit], max_chars=max_chars)

import os
import hashlib
import random
from typing import List, Dict, Any, Optional, Tuple

from .prompts import SYSTEM_PROMPT_BASE
from .retrieval import build_profile_context

# =====================================================================
# VERCEL SERVERLESS OPTIMIZATION: GLOBAL STATE
# This memory persists across requests on "warm" Vercel instances.
# Both chat and audio endpoints share this memory to instantly skip 
# keys that have exhausted their quotas, eliminating the "latency tax".
# =====================================================================
_dead_keys_memory = set()

def _get_api_keys() -> List[str]:
    """Retrieves and parses multiple API keys from the environment."""
    keys_str = os.getenv("GEMINI_API_KEYS", os.getenv("GEMINI_API_KEY", ""))
    return [k.strip() for k in keys_str.split(",") if k.strip()]

def _guess_mime(audio_bytes: bytes, declared_mime: Optional[str] = None) -> str:
    mime = "audio/wav"
    if declared_mime and "/" in declared_mime:
        mime = declared_mime.split(";")[0]
    elif audio_bytes[:4] == b"RIFF":
        mime = "audio/wav"
    elif audio_bytes[:4] == b"OggS":
        mime = "audio/ogg"
    elif audio_bytes[:4] == b"\x1a\x45\xdf\xa3":
        mime = "video/webm" 
        
    # FIX: Browsers send audio/webm or audio/mp4, which Gemini rejects.
    # By mapping them to video equivalents, Gemini successfully extracts the audio.
    if mime == "audio/webm":
        mime = "video/webm"
    elif mime == "audio/mp4":
        mime = "video/mp4"
        
    return mime

def _chat_mode_config(app_mode: str) -> Tuple[List[str], int, int, int]:
    app_mode = (app_mode or "quota_saver").lower()
    
    if app_mode == "quota_saver":
        return (
            ["gemini-2.5-flash-lite", "gemini-2.0-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"],
            512,  # max_output_tokens
            1,    # max_hops
            6,    # history_turns
        )
        
    if app_mode == "quality":
        # Free-tier friendly models to avoid instant rate-limits
        return (
            ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"],
            1400,
            2,
            10,
        )
        
    # normal
    return (
        ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.0-flash-lite"],
        900,
        2,
        10,
    )

# Stable flash models for audio ingestion
TRANSCRIBE_MODEL_CANDIDATES = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
]

def build_gemini_history(messages: List[Dict[str, Any]], history_turns: int) -> List[Dict[str, Any]]:
    raw: List[Tuple[str, str]] = []
    for m in messages[-history_turns:]:
        role = "user" if m.get("role") == "user" else "model"
        text = (m.get("content") or "").strip()
        if not text:
            continue
        raw.append((role, text))

    merged: List[Tuple[str, str]] = []
    for role, text in raw:
        if merged and merged[-1][0] == role:
            merged[-1] = (role, merged[-1][1].rstrip() + "\n" + text)
        else:
            merged.append((role, text))

    contents = [{"role": r, "parts": [{"text": t}]} for r, t in merged]

    while contents and contents[0]["role"] != "user":
        contents.pop(0)

    return contents

def needs_continue(t: str) -> bool:
    t = (t or "").strip()
    if not t:
        return False
    if t.endswith("[CONTINUE]"):
        return True
    if len(t) > 80 and t[-1] not in ".?!\"'”":
        return True
    return False

def strip_continue_token(t: str) -> str:
    t = (t or "").strip()
    if t.endswith("[CONTINUE]"):
        return t[:-10].rstrip()
    return t

def _generate_with_key_and_model_fallback(api_keys: List[str], model_candidates: List[str], contents, config):
    global _dead_keys_memory
    last_errors = []
    last_tried = None

    from google import genai

    # 1. Filter out dead keys
    alive_keys = [k for k in api_keys if k not in _dead_keys_memory]
    if not alive_keys:
        _dead_keys_memory.clear() # All died, reset cache to try again
        alive_keys = api_keys.copy()

    # 2. Round-Robin Load Balancing
    random.shuffle(alive_keys)

    for key in alive_keys:
        try:
            client = genai.Client(api_key=key)
        except Exception as e:
            last_errors.append(f"Init Error: {repr(e)}")
            continue

        for m in model_candidates:
            try:
                last_tried = m
                resp = client.models.generate_content(model=m, contents=contents, config=config)
                return resp, m, last_tried, last_errors
            except Exception as e:
                err_msg = str(e)
                last_errors.append(f"Key(...{key[-4:]}) Model({m}): {err_msg}")
                print(f"Chat Error [Key: ...{key[-4:]} | Model: {m}]: {err_msg}")
                
                # 3. Mark key as dead instantly if quota is hit
                if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg or "quota" in err_msg.lower():
                    _dead_keys_memory.add(key)
                    break 
                continue

    raise RuntimeError(last_errors[-1] if last_errors else "All keys and models failed")

def chat_reply(messages: List[Dict[str, Any]], app_mode: str = "quota_saver") -> Dict[str, Any]:
    global _dead_keys_memory
    api_keys = _get_api_keys()
    if not api_keys:
        raise RuntimeError("Missing GEMINI_API_KEYS environment variable.")

    try:
        from google import genai
        from google.genai import types
    except Exception as exc:
        raise RuntimeError("google-genai is not installed or could not be imported.") from exc

    candidates, max_output_tokens, max_hops, history_turns = _chat_mode_config(app_mode)

    last_user_text = ""
    for m in reversed(messages or []):
        if m.get("role") == "user" and (m.get("content") or "").strip():
            last_user_text = (m.get("content") or "").strip()
            break

    # Use a healthy key for embeddings to ensure RAG doesn't fail unnecessarily 
    alive_keys = [k for k in api_keys if k not in _dead_keys_memory]
    if not alive_keys:
        _dead_keys_memory.clear()
        alive_keys = api_keys.copy()
        
    embed_client = genai.Client(api_key=random.choice(alive_keys))

    facts_block = build_profile_context(
        client=embed_client,
        question_text=last_user_text,
        embed_model=os.getenv("PROFILE_EMBED_MODEL", "gemini-embedding-001"),
        output_dimensionality=int(os.getenv("PROFILE_EMBED_DIM", "256")),
        k=int(os.getenv("PROFILE_TOP_K", "3")),
        min_score=float(os.getenv("PROFILE_MIN_SCORE", "0.15")),
        max_chars=int(os.getenv("PROFILE_MAX_CONTEXT_CHARS", "2800")),
    )

    system_instruction = SYSTEM_PROMPT_BASE
    if facts_block:
        system_instruction = (
            SYSTEM_PROMPT_BASE
            + "\n\nFACTS CONTEXT (use this as truth; do not invent details):\n"
            + facts_block
        )

    gen_config = types.GenerateContentConfig(
        system_instruction=system_instruction,
        temperature=0.6,
        max_output_tokens=max_output_tokens,
    )

    hist = build_gemini_history(messages, history_turns)

    if not hist:
        hist = [{"role": "user", "parts": [{"text": last_user_text or "Hello"}]}]

    resp, used_model, last_tried, errors = _generate_with_key_and_model_fallback(
        api_keys, candidates, hist, gen_config
    )
    
    bot_text = strip_continue_token((resp.text or "").strip()) or "I didn’t catch that fully — can you say it again?"

    hops_used = 0
    for _ in range(max_hops):
        if not needs_continue(bot_text):
            break
        hops_used += 1
        continue_prompt = "Continue exactly from where you left off. Do not repeat earlier text."
        hist2 = hist + [
            {"role": "model", "parts": [{"text": bot_text}]},
            {"role": "user", "parts": [{"text": continue_prompt}]},
        ]
        try:
            resp2, used_model2, last_tried2, errors2 = _generate_with_key_and_model_fallback(
                api_keys, candidates, hist2, gen_config
            )
            used_model = used_model2
            last_tried = last_tried2
            errors = errors + errors2
            cont = strip_continue_token((resp2.text or "").strip())
            if not cont:
                break
            bot_text = bot_text.rstrip() + " " + cont
        except Exception:
            break

    return {
        "reply": bot_text,
        "used_model": used_model,
        "last_tried_model": last_tried,
        "model_errors": errors[-8:],
        "hops_used": hops_used,
        "history_sig": hashlib.sha1(str(hist).encode("utf-8")).hexdigest(),
    }

def transcribe(audio_bytes: bytes, declared_mime: Optional[str] = None) -> Dict[str, Any]:
    global _dead_keys_memory
    api_keys = _get_api_keys()
    
    if not api_keys:
        raise RuntimeError("Missing GEMINI_API_KEYS environment variable.")

    if not audio_bytes or len(audio_bytes) < 1000:
        return {"text": "", "used_model": None}

    try:
        from google import genai
        from google.genai import types
    except Exception as exc:
        raise RuntimeError("google-genai is not installed or could not be imported.") from exc

    mime = _guess_mime(audio_bytes, declared_mime)
    prompt = "Transcribe the user's speech accurately. Return ONLY the transcript."
    config = types.GenerateContentConfig(temperature=0.0, max_output_tokens=512)

    # 1. Skip dead keys via shared memory
    alive_keys = [k for k in api_keys if k not in _dead_keys_memory]
    if not alive_keys:
        _dead_keys_memory.clear()
        alive_keys = api_keys.copy()

    # 2. Round-Robin Load Balancing
    random.shuffle(alive_keys)

    for key in alive_keys:
        try:
            client = genai.Client(api_key=key)
        except Exception:
            continue
            
        for m in TRANSCRIBE_MODEL_CANDIDATES:
            try:
                resp = client.models.generate_content(
                    model=m,
                    contents=[types.Part.from_bytes(data=audio_bytes, mime_type=mime), prompt],
                    config=config,
                )
                text = (resp.text or "").strip().strip('"').strip()
                if text:
                    return {"text": text, "used_model": m}
            except Exception as e:
                err_msg = str(e)
                print(f"Transcribe Error [Key: ...{key[-4:]} | Model: {m} | MIME: {mime}]: {err_msg}")
                
                # 3. Instantly mark as dead so chat_reply avoids this key too!
                if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg or "quota" in err_msg.lower():
                    _dead_keys_memory.add(key)
                    break 
                continue

    return {"text": "", "used_model": None}
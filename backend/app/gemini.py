import os
import hashlib
import random
from typing import List, Dict, Any, Optional, Tuple

# =====================================================================
# VERCEL SERVERLESS OPTIMIZATION: GLOBAL STATE
# Shared memory for API keys. If a key dies (429 Quota), it is blacklisted
# instantly for both text and audio routes, eliminating latency tax.
# =====================================================================
_dead_keys_memory = set()

from .prompts import SYSTEM_PROMPT_BASE
from .retrieval import build_profile_context

def _get_api_keys() -> List[str]:
    """Retrieves and parses multiple API keys from the environment."""
    keys_str = os.getenv("GEMINI_API_KEYS", os.getenv("GEMINI_API_KEY", ""))
    return [k.strip() for k in keys_str.split(",") if k.strip()]

def _guess_mime(audio_bytes: bytes, declared_mime: Optional[str] = None) -> str:
    # Safely extract the raw MIME type from the browser (e.g., audio/webm;codecs=opus -> audio/webm)
    mime = "audio/webm"
    if declared_mime and "/" in declared_mime:
        mime = declared_mime.split(";")[0]
    elif audio_bytes[:4] == b"RIFF":
        mime = "audio/wav"
    elif audio_bytes[:4] == b"OggS":
        mime = "audio/ogg"
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
        return (
            ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"],
            1400,
            2,
            10,
        )
        
    return (
        ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.0-flash-lite"],
        900,
        2,
        10,
    )

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

    alive_keys = [k for k in api_keys if k not in _dead_keys_memory]
    if not alive_keys:
        _dead_keys_memory.clear() 
        alive_keys = api_keys.copy()

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
        hist2 = hist + [
            {"role": "model", "parts": [{"text": bot_text}]},
            {"role": "user", "parts": [{"text": "Continue exactly from where you left off. Do not repeat earlier text."}]},
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

    # FIX 1: Dropped file size limit from 1000 down to 50 bytes. 
    # Browser Opus WebM aggressively compresses short 1-2 second clips. 
    if not audio_bytes or len(audio_bytes) < 50:
        return {"text": "", "used_model": None}

    try:
        from google import genai
        from google.genai import types
    except Exception as exc:
        raise RuntimeError("google-genai is not installed or could not be imported.") from exc

    mime = _guess_mime(audio_bytes, declared_mime)
    
    # FIX 2: Explicit instructions. If Gemini hears nothing, it will output [NO_SPEECH] 
    # so we can cleanly identify it rather than guessing.
    prompt = (
        "You are an expert transcription AI. Transcribe the user's speech accurately. "
        "If there is only noise or silence, reply with exactly: [NO_SPEECH]"
    )
    config = types.GenerateContentConfig(temperature=0.0, max_output_tokens=512)

    alive_keys = [k for k in api_keys if k not in _dead_keys_memory]
    if not alive_keys:
        _dead_keys_memory.clear()
        alive_keys = api_keys.copy()

    random.shuffle(alive_keys)

    # FIX 3: 1.5-flash is prioritized. It handles raw browser audio better than 2.0/2.5.
    audio_models = [
        "gemini-1.5-flash",
        "gemini-2.0-flash-lite",
        "gemini-2.0-flash",
        "gemini-2.5-flash"
    ]
    
    last_errors = []

    for key in alive_keys:
        try:
            client = genai.Client(api_key=key)
        except Exception:
            continue
            
        for m in audio_models:
            try:
                resp = client.models.generate_content(
                    model=m,
                    contents=[types.Part.from_bytes(data=audio_bytes, mime_type=mime), prompt],
                    config=config,
                )
                text = (resp.text or "").strip().strip('"').strip()
                
                # Check for explicit silence marker
                if "[NO_SPEECH]" in text.upper():
                    return {"text": "", "used_model": m}
                    
                if text:
                    return {"text": text, "used_model": m}
                    
                last_errors.append(f"Model {m} returned empty response text.")
                
            except Exception as e:
                err_msg = str(e)
                last_errors.append(f"Key(...{key[-4:]}) Model({m}): {err_msg}")
                
                if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg or "quota" in err_msg.lower():
                    _dead_keys_memory.add(key)
                    break 
                continue 

    # FIX 4: If ALL keys and models fail, throw an actual 500 error!
    # This prevents the UI from hiding API crashes behind a generic "Try again closer to the mic" message.
    error_summary = " | ".join(last_errors[-3:]) if last_errors else "Unknown failure"
    raise RuntimeError(f"Transcription completely failed. Last error: {error_summary}")
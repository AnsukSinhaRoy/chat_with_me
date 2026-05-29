import os
import hashlib
import random
import time
from typing import List, Dict, Any, Optional, Tuple

# Global memory to track exhausted keys
_dead_keys_memory = {} # key -> expiry_timestamp

from .prompts import SYSTEM_PROMPT_BASE
from .retrieval import build_profile_context

def _comma_env(name: str) -> List[str]:
    return [item.strip() for item in os.getenv(name, "").split(",") if item.strip()]

def _get_api_keys() -> List[str]:
    keys_str = os.getenv("GEMINI_API_KEYS", os.getenv("GEMINI_API_KEY", ""))
    return [k.strip() for k in keys_str.split(",") if k.strip()]

def _is_key_dead(key: str) -> bool:
    if key not in _dead_keys_memory: return False
    if time.time() > _dead_keys_memory[key]:
        del _dead_keys_memory[key]
        return False
    return True

def _guess_mime(audio_bytes: bytes, declared_mime: Optional[str] = None) -> str:
    mime = "audio/webm"
    if declared_mime and "/" in declared_mime:
        mime = declared_mime.split(";")[0]
    elif audio_bytes[:4] == b"RIFF": mime = "audio/wav"
    elif audio_bytes[:4] == b"OggS": mime = "audio/ogg"
    return mime

def _chat_mode_config(app_mode: str) -> Tuple[List[str], int, int, int]:
    # UPDATED MODEL STRINGS FOR MAY 2026
    # 3.5 Flash is now GA. 2.5 Flash is the stable workhorse.
    app_mode = (app_mode or "quota_saver").lower()
    
    if app_mode == "quota_saver":
        return (
            _comma_env("GEMINI_CHAT_MODEL_CANDIDATES") or ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"],
            512, 1, 6,
        )
        
    return (
        _comma_env("GEMINI_CHAT_MODEL_CANDIDATES") or ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"],
        1200, 2, 10,
    )

def build_gemini_history(messages: List[Dict[str, Any]], history_turns: int) -> List[Dict[str, Any]]:
    raw = []
    for m in messages[-history_turns:]:
        role = "user" if m.get("role") == "user" else "model"
        text = (m.get("content") or "").strip()
        if text: raw.append((role, text))
    merged = []
    for role, text in raw:
        if merged and merged[-1][0] == role:
            merged[-1] = (role, merged[-1][1].rstrip() + "\n" + text)
        else: merged.append((role, text))
    contents = [{"role": r, "parts": [{"text": t}]} for r, t in merged]
    while contents and contents[0]["role"] != "user": contents.pop(0)
    return contents

def _generate_with_key_and_model_fallback(api_keys: List[str], model_candidates: List[str], contents, config):
    last_errors = []
    from google import genai

    alive_keys = [k for k in api_keys if not _is_key_dead(k)]
    if not alive_keys:
        alive_keys = api_keys.copy()

    random.shuffle(alive_keys)

    for key in alive_keys:
        try:
            client = genai.Client(api_key=key)
            for m in model_candidates:
                try:
                    resp = client.models.generate_content(model=m, contents=contents, config=config)
                    return resp, m, m, last_errors
                except Exception as e:
                    err_msg = str(e)
                    last_errors.append(f"Key(...{key[-4:]}) {m}: {err_msg}")
                    if "429" in err_msg or "QUOTA" in err_msg.upper():
                        # Blacklist key for 60 seconds
                        _dead_keys_memory[key] = time.time() + 60
                        break 
                    if "404" in err_msg: continue # Model not found, try next model
                    continue
        except Exception: continue

    raise RuntimeError(" | ".join(last_errors[-2:]) if last_errors else "All keys failed.")

def chat_reply(messages: List[Dict[str, Any]], app_mode: str = "quota_saver") -> Dict[str, Any]:
    api_keys = _get_api_keys()
    if not api_keys:
        raise RuntimeError("Missing GEMINI_API_KEYS or GEMINI_API_KEY")

    from google import genai
    from google.genai import types

    candidates, max_out, max_hops, turns = _chat_mode_config(app_mode)
    last_user_text = ""
    for m in reversed(messages or []):
        if m.get("role") == "user" and m.get("content"):
            last_user_text = m.get("content").strip()
            break

    # Retrieval
    embed_key = next((k for k in api_keys if not _is_key_dead(k)), api_keys[0])
    embed_client = genai.Client(api_key=embed_key)
    facts = build_profile_context(
        client=embed_client, question_text=last_user_text,
        embed_model="gemini-embedding-001", output_dimensionality=256
    )

    sys_inst = SYSTEM_PROMPT_BASE
    if facts: sys_inst += f"\n\nFACTS CONTEXT:\n{facts}"

    gen_config = types.GenerateContentConfig(
        system_instruction=sys_inst, temperature=0.7, max_output_tokens=max_out
    )
    hist = build_gemini_history(messages, turns) or [{"role": "user", "parts": [{"text": last_user_text or "Hi"}]}]

    resp, used, last_m, errs = _generate_with_key_and_model_fallback(api_keys, candidates, hist, gen_config)
    return {"reply": (resp.text or "").strip(), "used_model": used, "model_errors": errs[-5:]}

def transcribe(audio_bytes: bytes, declared_mime: Optional[str] = None) -> Dict[str, Any]:
    api_keys = _get_api_keys()
    if not api_keys:
        raise RuntimeError("Missing GEMINI_API_KEYS or GEMINI_API_KEY")
    if not audio_bytes or len(audio_bytes) < 1000:
        return {"text": "", "used_model": None}

    from google.genai import types
    mime = _guess_mime(audio_bytes, declared_mime)

    audio_models = _comma_env("GEMINI_TRANSCRIBE_MODEL_CANDIDATES") or [
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
    ]

    prompt = (
        "Transcribe only the human speech in the attached audio. "
        "Return only the transcript text, with no quotes, no explanation, and no punctuation cleanup beyond normal text. "
        "Do not guess, infer, or use sample sentences. If the audio is silent, unclear, corrupt, or contains no speech, return exactly [NO_SPEECH]."
    )
    config = types.GenerateContentConfig(temperature=0.0, max_output_tokens=300)

    last_errors = []
    alive_keys = [k for k in api_keys if not _is_key_dead(k)]
    if not alive_keys: alive_keys = api_keys.copy()
    random.shuffle(alive_keys)

    for key in alive_keys:
        try:
            from google import genai
            client = genai.Client(api_key=key)
            for m in audio_models:
                try:
                    resp = client.models.generate_content(
                        model=m,
                        contents=[
                            prompt,
                            types.Part.from_bytes(data=audio_bytes, mime_type=mime),
                        ],
                        config=config,
                    )
                    text = (resp.text or "").strip()
                    if "[NO_SPEECH]" in text.upper():
                        return {"text": "", "used_model": m}
                    if text:
                        return {"text": text, "used_model": m}
                except Exception as e:
                    err_msg = str(e)
                    last_errors.append(f"{m}: {err_msg}")
                    if "429" in err_msg or "QUOTA" in err_msg.upper():
                        _dead_keys_memory[key] = time.time() + 60
                        break
                    continue
        except Exception: continue

    error_summary = " | ".join(last_errors[-2:])
    raise RuntimeError(f"Transcription failed. Quota exhausted or models unavailable. {error_summary}")
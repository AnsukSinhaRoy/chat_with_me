import os
import hashlib
from typing import List, Dict, Any, Tuple

from google import genai
from google.genai import types

from .prompts import SYSTEM_PROMPT

def _guess_mime(audio_bytes: bytes) -> str:
    if audio_bytes[:4] == b"RIFF":
        return "audio/wav"
    if audio_bytes[:4] == b"OggS":
        return "audio/ogg"
    if audio_bytes[:4] == b"\x1a\x45\xdf\xa3":
        return "audio/webm"
    return "audio/wav"

def _chat_mode_config(app_mode: str) -> Tuple[List[str], int, int, int]:
    app_mode = (app_mode or "quota_saver").lower()
    if app_mode == "quota_saver":
        return (
            [
                "models/gemini-flash-lite-latest",
                "models/gemini-2.0-flash-lite-001",
                "models/gemini-2.0-flash",
                "models/gemma-3-12b-it",
            ],
            512,  # max_output_tokens
            1,    # max_hops
            6,    # history_turns
        )
    if app_mode == "quality":
        return (
            [
                "models/gemini-2.5-pro",
                "models/gemini-pro-latest",
                "models/gemini-2.5-flash",
                "models/gemini-2.0-flash-001",
            ],
            1400,
            2,
            10,
        )
    # normal
    return (
        [
            "models/gemini-2.0-flash-001",
            "models/gemini-2.0-flash",
            "models/gemini-flash-latest",
            "models/gemini-2.0-flash-lite-001",
            "models/gemini-flash-lite-latest",
            "models/gemma-3-12b-it",
        ],
        900,
        2,
        10,
    )

TRANSCRIBE_MODEL_CANDIDATES = [
    "models/gemini-2.5-flash-native-audio-latest",
    "models/gemini-2.5-flash-native-audio-preview-09-2025",
    "models/gemini-2.5-flash-native-audio-preview-12-2025",
    "models/gemini-2.0-flash",
    "models/gemini-2.0-flash-lite",
]

def build_gemini_history(messages: List[Dict[str, Any]], history_turns: int) -> List[Dict[str, Any]]:
    contents = []
    for m in messages[-history_turns:]:
        role = "user" if m["role"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})
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

def _generate_with_fallback(client: genai.Client, model_candidates: List[str], contents, config):
    last_errors = []
    last_tried = None
    for m in model_candidates:
        try:
            last_tried = m
            resp = client.models.generate_content(model=m, contents=contents, config=config)
            return resp, m, last_tried, last_errors
        except Exception as e:
            last_errors.append(f"{m}: {repr(e)}")
            continue
    raise RuntimeError(last_errors[-1] if last_errors else "All models failed")

def chat_reply(messages: List[Dict[str, Any]], app_mode: str = "quota_saver") -> Dict[str, Any]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing GEMINI_API_KEY")

    client = genai.Client(api_key=api_key)

    candidates, max_output_tokens, max_hops, history_turns = _chat_mode_config(app_mode)

    gen_config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        temperature=0.6,
        max_output_tokens=max_output_tokens,
    )

    hist = build_gemini_history(messages, history_turns)

    resp, used_model, last_tried, errors = _generate_with_fallback(client, candidates, hist, gen_config)
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
            resp2, used_model2, last_tried2, errors2 = _generate_with_fallback(client, candidates, hist2, gen_config)
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

def transcribe(audio_bytes: bytes) -> Dict[str, Any]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing GEMINI_API_KEY")

    if not audio_bytes or len(audio_bytes) < 1000:
        return {"text": "", "used_model": None}

    client = genai.Client(api_key=api_key)
    mime = _guess_mime(audio_bytes)
    prompt = "Transcribe the user's speech accurately. Return ONLY the transcript."
    config = types.GenerateContentConfig(temperature=0.0, max_output_tokens=512)

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
        except Exception:
            continue

    return {"text": "", "used_model": None}

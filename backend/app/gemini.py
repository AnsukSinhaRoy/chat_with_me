import os
import hashlib
import random
import time
from typing import List, Dict, Any, Optional, Tuple, Callable

# Global memory to track briefly exhausted keys. This is intentionally short-lived:
# a key that hits a per-minute limit should recover quickly, especially when the
# app has multiple free-tier keys configured.
_dead_keys_memory = {}  # key -> expiry_timestamp

from .prompts import SYSTEM_PROMPT_BASE
from .retrieval import build_profile_context


def _comma_env(name: str) -> List[str]:
    return [item.strip() for item in os.getenv(name, "").split(",") if item.strip()]


def _get_api_keys() -> List[str]:
    keys_str = os.getenv("GEMINI_API_KEYS", os.getenv("GEMINI_API_KEY", ""))
    return [k.strip() for k in keys_str.split(",") if k.strip()]


def _is_key_dead(key: str) -> bool:
    if key not in _dead_keys_memory:
        return False
    if time.time() > _dead_keys_memory[key]:
        del _dead_keys_memory[key]
        return False
    return True


def _guess_mime(audio_bytes: bytes, declared_mime: Optional[str] = None) -> str:
    mime = "audio/webm"
    if declared_mime and "/" in declared_mime:
        mime = declared_mime.split(";")[0]
    elif audio_bytes[:4] == b"RIFF":
        mime = "audio/wav"
    elif audio_bytes[:4] == b"OggS":
        mime = "audio/ogg"
    return mime


def _dedupe_models(models: List[str]) -> List[str]:
    """Keep fallback order while removing duplicate model names."""
    seen = set()
    deduped = []
    for model in models:
        if model and model not in seen:
            deduped.append(model)
            seen.add(model)
    return deduped


def _chat_mode_config(app_mode: str) -> Tuple[List[str], int, int, int, str]:
    """Return model fallbacks, max tokens, continuation hops, history turns, thinking level.

    Important free-tier reality: Gemini 3.1 Pro Preview is available in AI Studio,
    but it does not have a Gemini API free tier. So the default Quality mode uses
    the strongest currently documented free API path first: Gemini 3 Flash Preview.

    Mode-specific environment variables override the defaults:
      - GEMINI_QUOTA_SAVER_MODEL_CANDIDATES
      - GEMINI_QUALITY_MODEL_CANDIDATES

    GEMINI_CHAT_MODEL_CANDIDATES remains as a legacy global override. Avoid
    setting it on Vercel unless you intentionally want both modes to use the
    exact same fallback list.
    """
    mode = (app_mode or "quota_saver").lower()
    legacy_global = _comma_env("GEMINI_CHAT_MODEL_CANDIDATES")

    if mode == "quality":
        candidates = (
            _comma_env("GEMINI_QUALITY_MODEL_CANDIDATES")
            or legacy_global
            or ["gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-flash"]
        )
        return _dedupe_models(candidates), 2600, 3, 16, "high"

    candidates = (
        _comma_env("GEMINI_QUOTA_SAVER_MODEL_CANDIDATES")
        or legacy_global
        or ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.0-flash-lite"]
    )
    return _dedupe_models(candidates), 1200, 2, 10, "minimal"


def _supports_thinking_level(model: str) -> bool:
    # Gemini 3-series models support thinking_level. Older models may use older
    # thinking controls, so do not attach this setting to them by default.
    return model.startswith("gemini-3")


def _make_generation_config(types: Any, model: str, mode: str, max_output_tokens: int, system_instruction: str, thinking_level: str):
    kwargs: Dict[str, Any] = {
        "system_instruction": system_instruction,
        "temperature": 0.72 if mode == "quality" else 0.55,
        "max_output_tokens": max_output_tokens,
    }
    if _supports_thinking_level(model):
        try:
            kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=thinking_level)
        except Exception:
            # Older google-genai versions may not expose ThinkingConfig yet.
            # The request will still work; it just will not get explicit thinking control.
            pass
    return types.GenerateContentConfig(**kwargs)


def _make_generation_config_without_thinking(types: Any, max_output_tokens: int, system_instruction: str, mode: str):
    return types.GenerateContentConfig(
        system_instruction=system_instruction,
        temperature=0.72 if mode == "quality" else 0.55,
        max_output_tokens=max_output_tokens,
    )


def _looks_like_model_access_error(err_msg: str) -> bool:
    text = err_msg.upper()
    # Free-tier Pro commonly fails as resource/quota/access rather than a neat
    # "not free" message. Treat these as model-candidate failures first, not as
    # reason to abandon the whole key before trying cheaper candidates.
    return any(token in text for token in [
        "MODEL", "NOT_FOUND", "404", "PERMISSION", "403", "FAILED_PRECONDITION",
        "INVALID_ARGUMENT", "NOT AVAILABLE", "UNSUPPORTED", "RESOURCE_EXHAUSTED", "429", "QUOTA",
    ])


def build_gemini_history(messages: List[Dict[str, Any]], history_turns: int) -> List[Dict[str, Any]]:
    raw = []
    for m in messages[-history_turns:]:
        role = "user" if m.get("role") == "user" else "model"
        text = (m.get("content") or "").strip()
        if text:
            raw.append((role, text))
    merged = []
    for role, text in raw:
        if merged and merged[-1][0] == role:
            merged[-1] = (role, merged[-1][1].rstrip() + "\n" + text)
        else:
            merged.append((role, text))
    contents = [{"role": r, "parts": [{"text": t}]} for r, t in merged]
    while contents and contents[0]["role"] != "user":
        contents.pop(0)
    return contents




def _needs_continue(text: str) -> bool:
    text = (text or "").strip()
    if not text:
        return False
    if text.endswith("[CONTINUE]"):
        return True
    # If the model hit the output cap without the explicit token, the text often
    # ends mid-sentence. Continue once rather than returning a broken answer.
    if len(text) > 120 and text[-1] not in ".?!\"'”’):]}":
        return True
    return False


def _strip_continue_token(text: str) -> str:
    text = (text or "").strip()
    while text.endswith("[CONTINUE]"):
        text = text[:-10].rstrip()
    return text


def _merge_text(prefix: str, continuation: str) -> str:
    prefix = (prefix or "").rstrip()
    continuation = (continuation or "").lstrip()
    if not prefix:
        return continuation
    if not continuation:
        return prefix
    # Avoid double spaces after punctuation while still joining interrupted words
    # reasonably when the first response ended mid-sentence.
    joiner = "" if prefix.endswith(("-", "/", "(", "[", "{")) else " "
    return prefix + joiner + continuation


def _add_continuation_turn(contents: List[Dict[str, Any]], partial_answer: str) -> List[Dict[str, Any]]:
    cleaned = _strip_continue_token(partial_answer)
    next_contents = list(contents)
    if cleaned:
        next_contents.append({"role": "model", "parts": [{"text": cleaned}]})
    next_contents.append({
        "role": "user",
        "parts": [{
            "text": (
                "Continue exactly from where the previous answer stopped. "
                "Do not repeat earlier text. Finish the answer cleanly. "
                "Only end with [CONTINUE] if another continuation is still absolutely required."
            )
        }],
    })
    return next_contents


def _is_rate_limit_error(err_msg: str) -> bool:
    text = err_msg.upper()
    return any(token in text for token in ["429", "QUOTA", "RESOURCE_EXHAUSTED", "RATE LIMIT", "RATE_LIMIT"])

def _generate_with_key_and_model_fallback(
    api_keys: List[str],
    model_candidates: List[str],
    contents,
    config_factory: Callable[[str], Any],
    config_without_thinking: Callable[[], Any],
):
    last_errors = []
    last_tried = None
    from google import genai

    alive_keys = [k for k in api_keys if not _is_key_dead(k)]
    if not alive_keys:
        alive_keys = api_keys.copy()

    random.shuffle(alive_keys)

    for key in alive_keys:
        key_had_success_possible = False
        try:
            client = genai.Client(api_key=key)
            for model in model_candidates:
                last_tried = model
                try:
                    resp = client.models.generate_content(
                        model=model,
                        contents=contents,
                        config=config_factory(model),
                    )
                    return resp, model, last_tried, last_errors
                except Exception as first_exc:
                    err_msg = str(first_exc)

                    # Some deployed google-genai/API combinations may reject the new
                    # thinking_level field. Retry the same model once without it before
                    # declaring the model unavailable.
                    if "thinking" in err_msg.lower() or "ThinkingConfig" in err_msg:
                        try:
                            resp = client.models.generate_content(
                                model=model,
                                contents=contents,
                                config=config_without_thinking(),
                            )
                            last_errors.append(
                                f"Key(...{key[-4:]}) {model}: thinking_config rejected; retried without explicit thinking"
                            )
                            return resp, model, last_tried, last_errors
                        except Exception as retry_exc:
                            err_msg = str(retry_exc)

                    last_errors.append(f"Key(...{key[-4:]}) {model}: {err_msg}")

                    # Do not kill a free key just because one stronger model is not
                    # available. Try the next candidate; if every candidate fails with
                    # quota/capacity, briefly cool down the key after this loop.
                    if _looks_like_model_access_error(err_msg):
                        continue
                    continue
        except Exception as client_exc:
            last_errors.append(f"Key(...{key[-4:]}) client init: {client_exc}")
            continue

        recent_for_key = [e.upper() for e in last_errors[-len(model_candidates):]]
        if recent_for_key and all(("429" in e or "QUOTA" in e or "RESOURCE_EXHAUSTED" in e) for e in recent_for_key):
            _dead_keys_memory[key] = time.time() + 60

    raise RuntimeError(" | ".join(last_errors[-4:]) if last_errors else "All keys failed.")


def chat_reply(messages: List[Dict[str, Any]], app_mode: str = "quota_saver") -> Dict[str, Any]:
    api_keys = _get_api_keys()
    if not api_keys:
        raise RuntimeError("Missing GEMINI_API_KEYS or GEMINI_API_KEY")

    from google import genai
    from google.genai import types

    mode = (app_mode or "quota_saver").lower()
    candidates, max_out, max_hops, turns, thinking_level = _chat_mode_config(mode)
    last_user_text = ""
    for m in reversed(messages or []):
        if m.get("role") == "user" and m.get("content"):
            last_user_text = m.get("content").strip()
            break

    # Retrieval
    embed_key = next((k for k in api_keys if not _is_key_dead(k)), api_keys[0])
    embed_client = genai.Client(api_key=embed_key)
    facts = build_profile_context(
        client=embed_client,
        question_text=last_user_text,
        embed_model="gemini-embedding-001",
        output_dimensionality=256,
    )

    sys_inst = SYSTEM_PROMPT_BASE
    if facts:
        sys_inst += f"\n\nFACTS CONTEXT:\n{facts}"

    hist = build_gemini_history(messages, turns) or [{"role": "user", "parts": [{"text": last_user_text or "Hi"}]}]

    resp, used, last_m, errs = _generate_with_key_and_model_fallback(
        api_keys=api_keys,
        model_candidates=candidates,
        contents=hist,
        config_factory=lambda model: _make_generation_config(types, model, mode, max_out, sys_inst, thinking_level),
        config_without_thinking=lambda: _make_generation_config_without_thinking(types, max_out, sys_inst, mode),
    )

    bot_text = _strip_continue_token(resp.text or "")
    hops_used = 0
    continuation_contents = hist

    for _ in range(max_hops):
        if not _needs_continue((resp.text or "").strip()) and not _needs_continue(bot_text):
            break
        hops_used += 1
        continuation_contents = _add_continuation_turn(continuation_contents, bot_text)
        try:
            resp2, used2, last_m2, errs2 = _generate_with_key_and_model_fallback(
                api_keys=api_keys,
                model_candidates=candidates,
                contents=continuation_contents,
                config_factory=lambda model: _make_generation_config(types, model, mode, max_out, sys_inst, thinking_level),
                config_without_thinking=lambda: _make_generation_config_without_thinking(types, max_out, sys_inst, mode),
            )
            used = used2
            last_m = last_m2
            errs.extend(errs2)
            continuation = _strip_continue_token(resp2.text or "")
            if not continuation:
                break
            bot_text = _merge_text(bot_text, continuation)
            resp = resp2
        except Exception as exc:
            errs.append(f"Continuation failed: {exc}")
            break

    return {
        "reply": bot_text.strip() or "I didn’t catch that fully — can you say it again?",
        "used_model": used,
        "last_tried_model": last_m,
        "model_errors": errs[-8:],
        "mode_detail": f"{mode}; thinking={thinking_level}; max_output_tokens={max_out}",
        "candidate_models": candidates,
        "hops_used": hops_used,
    }


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
    if not alive_keys:
        alive_keys = api_keys.copy()
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
                    # Continue through audio fallbacks first; only cool down the key
                    # if every audio model is exhausted.
                    continue
        except Exception:
            continue

        recent_for_key = [e.upper() for e in last_errors[-len(audio_models):]]
        if recent_for_key and all(("429" in e or "QUOTA" in e or "RESOURCE_EXHAUSTED" in e) for e in recent_for_key):
            _dead_keys_memory[key] = time.time() + 60

    error_summary = " | ".join(last_errors[-2:])
    raise RuntimeError(f"Transcription failed. Quota exhausted or models unavailable. {error_summary}")

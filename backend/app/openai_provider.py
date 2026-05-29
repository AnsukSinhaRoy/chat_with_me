import hashlib
import io
import os
from typing import Any, Dict, List, Optional, Tuple

from .prompts import SYSTEM_PROMPT_BASE
from .retrieval import build_profile_context


def _comma_env(name: str) -> List[str]:
    return [item.strip() for item in os.getenv(name, "").split(",") if item.strip()]


def _chat_mode_config(app_mode: str) -> Tuple[List[str], int, int, int]:
    """Return model fallback list, max output tokens, continuation hops, history turns.

    OPENAI_MODEL_CANDIDATES overrides every mode and is useful on Vercel when
    your API account has access to a different model set.
    """
    env_candidates = _comma_env("OPENAI_MODEL_CANDIDATES")
    if env_candidates:
        candidates = env_candidates
    else:
        primary = os.getenv("OPENAI_CHAT_MODEL", "gpt-4.1-mini").strip() or "gpt-4.1-mini"
        app_mode = (app_mode or "quota_saver").lower()
        if app_mode == "quality":
            candidates = [primary, "gpt-5.4-mini", "gpt-4.1", "gpt-4.1-mini"]
        elif app_mode == "normal":
            candidates = [primary, "gpt-5.4-mini", "gpt-4.1-mini", "gpt-4.1-nano"]
        else:
            candidates = [primary, "gpt-4.1-mini", "gpt-4.1-nano"]

    # Keep order but remove duplicates.
    seen = set()
    deduped = []
    for model in candidates:
        if model not in seen:
            deduped.append(model)
            seen.add(model)

    mode = (app_mode or "quota_saver").lower()
    if mode == "quality":
        return deduped, 1400, 2, 10
    if mode == "normal":
        return deduped, 900, 2, 10
    return deduped, 512, 1, 6


def _last_user_text(messages: List[Dict[str, Any]]) -> str:
    for message in reversed(messages or []):
        if message.get("role") == "user" and (message.get("content") or "").strip():
            return (message.get("content") or "").strip()
    return ""


def _build_transcript(messages: List[Dict[str, Any]], history_turns: int) -> str:
    """Build a compact text transcript for the Responses API.

    The frontend stores an initial assistant greeting. We drop leading assistant
    turns so the model focuses on user-provided conversation history instead of
    treating the greeting as a previous generated answer.
    """
    raw: List[Tuple[str, str]] = []
    for message in (messages or [])[-history_turns:]:
        role = "Assistant" if message.get("role") == "assistant" else "User"
        text = (message.get("content") or "").strip()
        if text:
            raw.append((role, text))

    while raw and raw[0][0] != "User":
        raw.pop(0)

    merged: List[Tuple[str, str]] = []
    for role, text in raw:
        if merged and merged[-1][0] == role:
            merged[-1] = (role, merged[-1][1].rstrip() + "\n" + text)
        else:
            merged.append((role, text))

    if not merged:
        last_user = _last_user_text(messages)
        merged = [("User", last_user or "Hello")]

    body = "\n\n".join(f"{role}: {text}" for role, text in merged)
    return (
        "Conversation so far:\n"
        f"{body}\n\n"
        "Reply to the latest user message as Ansuk. Do not repeat the transcript."
    )


def needs_continue(text: str) -> bool:
    text = (text or "").strip()
    if not text:
        return False
    if text.endswith("[CONTINUE]"):
        return True
    if len(text) > 80 and text[-1] not in ".?!\"'”":
        return True
    return False


def strip_continue_token(text: str) -> str:
    text = (text or "").strip()
    if text.endswith("[CONTINUE]"):
        return text[:-10].rstrip()
    return text


def _response_text(response: Any) -> str:
    text = getattr(response, "output_text", None)
    if isinstance(text, str) and text.strip():
        return text.strip()

    # Defensive fallback for older/newer SDK response shapes.
    chunks: List[str] = []
    for item in getattr(response, "output", []) or []:
        for content in getattr(item, "content", []) or []:
            value = getattr(content, "text", None)
            if isinstance(value, str):
                chunks.append(value)
    return "".join(chunks).strip()


def _generate_with_fallback(client: Any, model_candidates: List[str], instructions: str, input_text: str, max_output_tokens: int):
    last_errors: List[str] = []
    last_tried = None
    for model in model_candidates:
        last_tried = model
        try:
            response = client.responses.create(
                model=model,
                instructions=instructions,
                input=input_text,
                max_output_tokens=max_output_tokens,
                temperature=0.6,
            )
            return response, model, last_tried, last_errors
        except Exception as exc:
            # Some models/accounts may reject temperature. Retry once without it.
            try:
                response = client.responses.create(
                    model=model,
                    instructions=instructions,
                    input=input_text,
                    max_output_tokens=max_output_tokens,
                )
                return response, model, last_tried, last_errors
            except Exception as retry_exc:
                last_errors.append(f"{model}: {repr(retry_exc or exc)}")
                continue
    raise RuntimeError(last_errors[-1] if last_errors else "All OpenAI models failed")


def chat_reply(messages: List[Dict[str, Any]], app_mode: str = "quota_saver") -> Dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY")

    try:
        from openai import OpenAI
    except Exception as exc:
        raise RuntimeError("openai is not installed or could not be imported.") from exc

    client = OpenAI(api_key=api_key)
    candidates, max_output_tokens, max_hops, history_turns = _chat_mode_config(app_mode)

    last_user_text = _last_user_text(messages)
    facts_block = build_profile_context(
        question_text=last_user_text,
        k=int(os.getenv("PROFILE_TOP_K", "4")),
        min_score=float(os.getenv("PROFILE_MIN_SCORE", "0.10")),
        max_chars=int(os.getenv("PROFILE_MAX_CONTEXT_CHARS", "2800")),
    )

    instructions = SYSTEM_PROMPT_BASE
    if facts_block:
        instructions = (
            SYSTEM_PROMPT_BASE
            + "\n\nFACTS CONTEXT (use this as truth; do not invent details):\n"
            + facts_block
        )

    transcript = _build_transcript(messages, history_turns)
    response, used_model, last_tried, errors = _generate_with_fallback(
        client, candidates, instructions, transcript, max_output_tokens
    )
    bot_text = strip_continue_token(_response_text(response)) or "I didn’t catch that fully — can you say it again?"

    hops_used = 0
    continuation_input = transcript
    for _ in range(max_hops):
        if not needs_continue(bot_text):
            break
        hops_used += 1
        continuation_input = (
            continuation_input
            + "\n\nAssistant partial answer:\n"
            + bot_text
            + "\n\nContinue exactly from where the partial answer stopped. Do not repeat earlier text."
        )
        try:
            response2, used_model2, last_tried2, errors2 = _generate_with_fallback(
                client, candidates, instructions, continuation_input, max_output_tokens
            )
            used_model = used_model2
            last_tried = last_tried2
            errors = errors + errors2
            continuation = strip_continue_token(_response_text(response2))
            if not continuation:
                break
            bot_text = bot_text.rstrip() + " " + continuation
        except Exception:
            break

    return {
        "reply": bot_text,
        "used_model": used_model,
        "last_tried_model": last_tried,
        "model_errors": errors[-8:],
        "hops_used": hops_used,
        "history_sig": hashlib.sha1(transcript.encode("utf-8")).hexdigest(),
    }


def _suffix_for_mime(declared_mime: Optional[str]) -> str:
    mime = (declared_mime or "").split(";")[0].strip().lower()
    return {
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/mp4": ".mp4",
        "audio/x-m4a": ".m4a",
        "audio/m4a": ".m4a",
        "audio/wav": ".wav",
        "audio/webm": ".webm",
        "audio/ogg": ".ogg",
    }.get(mime, ".webm")


def transcribe(audio_bytes: bytes, declared_mime: Optional[str] = None) -> Dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY")

    if not audio_bytes or len(audio_bytes) < 1000:
        return {"text": "", "used_model": None}

    try:
        from openai import OpenAI
    except Exception as exc:
        raise RuntimeError("openai is not installed or could not be imported.") from exc

    client = OpenAI(api_key=api_key)
    candidates = _comma_env("OPENAI_TRANSCRIBE_MODEL_CANDIDATES") or [
        os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe").strip() or "gpt-4o-mini-transcribe",
        "gpt-4o-transcribe",
        "whisper-1",
    ]

    suffix = _suffix_for_mime(declared_mime)
    prompt = "Transcribe accurately. Preserve spoken wording and punctuation."

    for model in candidates:
        try:
            audio_file = io.BytesIO(audio_bytes)
            audio_file.name = f"speech{suffix}"
            transcription = client.audio.transcriptions.create(
                model=model,
                file=audio_file,
                prompt=prompt,
            )
            text = getattr(transcription, "text", transcription)
            text = (text or "").strip().strip('"').strip()
            if text:
                return {"text": text, "used_model": model}
        except Exception:
            continue

    return {"text": "", "used_model": None}

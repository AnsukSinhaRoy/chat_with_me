import os
from typing import Any, Dict, List, Literal, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

# Changed this line to use Gemini instead of OpenAI
from .gemini import chat_reply, transcribe

Role = Literal["user", "assistant"]
MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", str(12 * 1024 * 1024)))


class Message(BaseModel):
    role: Role
    content: str = Field(min_length=1, max_length=12000)
    ts: Optional[str] = None


class ChatRequest(BaseModel):
    messages: List[Message] = Field(default_factory=list, max_length=30)
    app_mode: str = Field(default_factory=lambda: os.getenv("APP_MODE", "quota_saver"))


class ChatResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    reply: str
    used_model: Optional[str] = None
    last_tried_model: Optional[str] = None
    model_errors: List[str] = Field(default_factory=list)
    hops_used: int = 0
    history_sig: Optional[str] = None


class TranscribeResponse(BaseModel):
    text: str
    used_model: Optional[str] = None


app = FastAPI(title="Talk to Ansuk API", version="0.2.0")

cors_origins = os.getenv("CORS_ORIGINS", "*")
origins = [origin.strip() for origin in cors_origins.split(",") if origin.strip()] or ["*"]
allow_all_origins = origins == ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=not allow_all_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/")
def root() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "Talk to Ansuk API",
        "message": "Backend is running. Use /healthz for health checks, /api/chat for chat, and /api/transcribe for voice transcription.",
    }


@app.get("/healthz")
def healthz() -> Dict[str, bool]:
    return {"ok": True}


@app.get("/api/healthz")
def api_healthz() -> Dict[str, bool]:
    return {"ok": True}


@app.post("/api/chat", response_model=ChatResponse)
def api_chat(payload: ChatRequest) -> Dict[str, Any]:
    usable_messages = [m for m in payload.messages if m.content.strip()]
    if not usable_messages:
        raise HTTPException(status_code=400, detail="At least one non-empty message is required.")

    try:
        return chat_reply([m.model_dump() for m in usable_messages], payload.app_mode)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Chat generation failed.") from exc


@app.post("/api/transcribe", response_model=TranscribeResponse)
async def api_transcribe(file: UploadFile = File(...)) -> Dict[str, Any]:
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio upload.")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio file is too large.")

    try:
        return transcribe(audio_bytes, declared_mime=file.content_type)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Transcription failed.") from exc
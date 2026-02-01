import os
from typing import List, Literal, Optional, Dict, Any

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .gemini import chat_reply, transcribe

Role = Literal["user", "assistant"]

class Message(BaseModel):
    role: Role
    content: str
    ts: Optional[str] = None

class ChatRequest(BaseModel):
    messages: List[Message] = Field(default_factory=list)
    app_mode: str = Field(default_factory=lambda: os.getenv("APP_MODE", "quota_saver"))

class ChatResponse(BaseModel):
    reply: str
    used_model: Optional[str] = None
    last_tried_model: Optional[str] = None
    model_errors: List[str] = Field(default_factory=list)
    hops_used: int = 0
    history_sig: Optional[str] = None

class TranscribeResponse(BaseModel):
    text: str
    used_model: Optional[str] = None

app = FastAPI(title="Talk to Ansuk API")

cors_origins = os.getenv("CORS_ORIGINS", "*")
origins = [o.strip() for o in cors_origins.split(",")] if cors_origins else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins if origins != ["*"] else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.post("/api/chat", response_model=ChatResponse)
def api_chat(payload: ChatRequest):
    try:
        out = chat_reply([m.model_dump() for m in payload.messages], payload.app_mode)
        return out
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/transcribe", response_model=TranscribeResponse)
async def api_transcribe(file: UploadFile = File(...)):
    try:
        audio_bytes = await file.read()
        out = transcribe(audio_bytes)
        return out
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Chat With Me

A browser-based “AI twin” chat app built with **Next.js** and **FastAPI**. The frontend provides a responsive ChatGPT-style interface with text and voice input. The backend exposes Gemini-powered chat and transcription endpoints, with a lightweight profile-retrieval layer from local JSON files.

## What it does now

- Chat UI for desktop and phone browsers.
- Text input with auto-growing composer, quick prompts, export, and debug view.
- Voice input with microphone permission handling, real-time waveform/amplitude bars, auto-stop after silence, browser transcript preview when available, backend transcription fallback, and automatic send after transcription.
- FastAPI backend with `/healthz`, `/api/chat`, and `/api/transcribe`.
- Small local RAG-like profile retrieval using `backend/app/profile_chunks.json` and `backend/app/profile_index.json`.
- Safer backend request validation for empty chat messages and oversized audio uploads.
- Docker setup for local frontend/backend runs.

## Project layout

```text
backend/
  app/main.py                 FastAPI routes and request validation
  app/gemini.py               Gemini chat/transcription wrapper
  app/retrieval.py            Local profile-index retrieval
  app/profile_chunks.json     Editable profile facts
  app/profile_index.json      Precomputed profile embeddings index
  scripts/build_profile_index.py
frontend/
  app/page.tsx                App shell
  app/globals.css             Responsive UI styling
  components/Chat.tsx         Chat, voice recording, transcript, composer
```

## Local development

You can run npm commands either from `frontend/` or from the repository root. The root package forwards frontend commands so Vercel does not fail on `npm install`.

```bash
# from repo root
npm install
npm run typecheck
npm run build
```


### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env          # then set GEMINI_API_KEY
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

## Build and checks

```bash
# Frontend
cd frontend
npm run typecheck
npm run build
npm audit --omit=dev

# Backend
cd backend
python -m compileall -q app
python - <<'PY'
from fastapi.testclient import TestClient
from app.main import app
client = TestClient(app)
assert client.get('/healthz').status_code == 200
assert client.post('/api/chat', json={'messages': []}).status_code == 400
print('backend smoke checks passed')
PY
```

## Updating the knowledge base later

Edit `backend/app/profile_chunks.json`, then rebuild the local embedding index:

```bash
cd backend
export GEMINI_API_KEY=replace_me
python scripts/build_profile_index.py
```

Commit the updated `profile_chunks.json` and `profile_index.json` together.

## Deployment notes

### Vercel

The repository now supports root-level Vercel deployment. The root `package.json` and `vercel.json` forward install/build commands to `frontend/`, so Vercel no longer fails with `npm install` at the repository root.

Recommended setup: deploy the frontend with Root Directory `frontend`; deploy the backend separately, then set `NEXT_PUBLIC_API_BASE_URL` in the frontend deployment. This frontend is exported as a static site, so do not rely on Next.js rewrites for backend proxying on Vercel. See `VERCEL_DEPLOYMENT.md` for exact steps.

### Docker Compose

```bash
cp backend/.env.example backend/.env
# set GEMINI_API_KEY in your shell or compose environment
docker compose up --build
```

Then open `http://localhost:3000`.

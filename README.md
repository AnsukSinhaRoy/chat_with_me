# Chat With Me (Next.js + FastAPI)

This repo is a small monorepo:
- `frontend/` — Next.js UI (Gemini-style landing + mic button)
- `backend/` — FastAPI API (`/api/chat`, `/api/transcribe`) using Gemini via `google-genai`

## Deploy on Vercel (recommended)

### Option A: Two Vercel Projects (cleanest)

Create **two** Vercel projects from the same Git repo:

1) **Backend project**
- Root Directory: `backend`
- Env vars:
  - `GEMINI_API_KEY` (required)
  - `CORS_ORIGINS` (optional, default `*`)
  - `APP_MODE` (optional)

Vercel detects `backend/app/index.py` and deploys the FastAPI app. (See Vercel FastAPI docs.)

2) **Frontend project**
- Root Directory: `frontend`
- Env vars (recommended proxy setup):
  - `BACKEND_URL` = your backend deployment base URL (e.g. `https://<backend>.vercel.app`)
  - (optional) `NEXT_PUBLIC_APP_MODE` = `quota_saver` / `normal` / `quality`

With `BACKEND_URL` set, the Next.js app proxies same-origin requests `/api/*` → your backend, avoiding CORS.

### Option B: Frontend-only deploy

If you only deploy the frontend, you must point it at some hosted backend:
- Set `NEXT_PUBLIC_API_BASE_URL` (e.g. `https://your-api.example.com`)

## Local development

### Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt
export GEMINI_API_KEY=...
uvicorn app.main:app --reload --port 8000
```

### Frontend
```bash
cd frontend
npm install
# Local dev talks directly to backend:
export NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
npm run dev
```

Open `http://localhost:3000`.

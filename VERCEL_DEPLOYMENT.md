# Vercel deployment guide

This repository contains two apps:

- `frontend/`: Next.js browser app.
- `backend/`: FastAPI service for Gemini chat/transcription and profile retrieval.

## Why the previous deployment failed

The repository root did not have a `package.json`, so Vercel ran `npm install` at the wrong level and failed before it reached the real Next.js app in `frontend/`.

This version fixes that in two ways:

1. The repo root now has a small `package.json` and `vercel.json` that forward install/build commands to `frontend/`.
2. `frontend/` also has its own `vercel.json`, so setting Vercel's Root Directory to `frontend` also works.

## Recommended deployment

### Option A: deploy only the frontend on Vercel

Use this if your backend is hosted elsewhere.

1. Import the repo in Vercel.
2. Set **Root Directory** to `frontend`.
3. Set environment variables:
   - `NEXT_PUBLIC_API_BASE_URL=https://your-backend-url`
4. Build command: `NEXT_TELEMETRY_DISABLED=1 NEXT_PRIVATE_BUILD_WORKER=0 node ./node_modules/next/dist/bin/next build --turbopack`
5. Install command: `npm install`.
6. Output directory: `out`.

This frontend is exported as a static site, so the backend URL must be available through `NEXT_PUBLIC_API_BASE_URL`.

### Option B: deploy from the repo root

This is supported now.

Vercel will use root `vercel.json`:

```json
{
  "installCommand": "npm --prefix frontend install",
  "buildCommand": "node scripts/build-frontend.cjs",
  "outputDirectory": "frontend/out"
}
```

This avoids the `npm install` root failure and serves the exported static frontend from `frontend/out`.

## Backend note

The frontend alone will render, but chat and voice transcription require a running backend with `GEMINI_API_KEY`. If the backend is not deployed, the UI will load but messages/transcription will fail when it calls `/api/chat` or `/api/transcribe`.

For local backend testing:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

For local frontend testing:

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

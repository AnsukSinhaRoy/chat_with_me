# Vercel deployment guide

Do **not** deploy the repository root as the backend. This project contains two different apps. Deploy them as two separate Vercel projects.

## Frontend project

Vercel settings:

- Root Directory: `frontend`
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: `out`

Environment variable:

```bash
NEXT_PUBLIC_API_BASE_URL=https://YOUR_BACKEND_DOMAIN
```

## Backend project

Vercel settings:

- Root Directory: `backend`
- Framework Preset: FastAPI / Other
- Install Command: leave blank so Vercel auto-installs from `requirements.txt`
- Build Command: leave blank
- Output Directory: leave blank

Environment variables:

```bash
GEMINI_API_KEY=your_key_here
CORS_ORIGINS=https://YOUR_FRONTEND_DOMAIN
APP_MODE=quota_saver
```

Health check after deployment:

```text
https://YOUR_BACKEND_DOMAIN/healthz
```

Expected response:

```json
{"ok": true}
```

Then set `NEXT_PUBLIC_API_BASE_URL` in the frontend project to the backend domain and redeploy the frontend.

## Why the previous backend deployment failed

The previous package had root-level Vercel/NPM config intended for frontend deployment. When you tried to deploy the backend, Vercel still ran:

```bash
cd frontend && npm install
```

That is wrong for a Python/FastAPI backend. This version removes root-level Vercel/NPM config and makes `frontend/` and `backend/` independently deployable.

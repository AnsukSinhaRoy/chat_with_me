# Backend deployment

This folder is a standalone FastAPI service for Vercel.

Vercel settings:

- Root Directory: `backend`
- Install Command: leave blank / auto-detect
- Build Command: leave blank
- Output Directory: leave blank

Required environment variables:

```bash
GEMINI_API_KEY=your_key_here
CORS_ORIGINS=https://YOUR_FRONTEND_DOMAIN
APP_MODE=quota_saver
```

Health check:

```text
/healthz
```

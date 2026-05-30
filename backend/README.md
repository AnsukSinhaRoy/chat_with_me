# Backend deployment

Deploy this folder as a separate Vercel project.

Recommended Vercel settings:

- Root Directory: leave blank if uploading this backend-only zip, or `backend` if deploying the full repo
- Framework Preset: Other
- Install Command: leave blank
- Build Command: leave blank
- Output Directory: leave blank

Environment variables:

```text
GEMINI_API_KEY=your_key
# Or: GEMINI_API_KEYS=key_1,key_2,key_3
CORS_ORIGINS=https://your-frontend-vercel-domain
APP_MODE=quota_saver

# Optional mode-specific model overrides
GEMINI_QUOTA_SAVER_MODEL_CANDIDATES=gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-2.0-flash-lite
GEMINI_QUALITY_MODEL_CANDIDATES=gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-2.5-flash
```

After deployment, check:

```text
https://your-backend-domain/healthz
```

Expected response:

```json
{"ok": true}
```

The Vercel entrypoint is `api/index.py`. Do not change the `functions` glob to `app/**/*.py`; Vercel's Python function configuration expects function files under `api/`.


The backend root `/` now returns a small JSON status message instead of a confusing 404. `/healthz` and `/api/healthz` both return `{ "ok": true }`.

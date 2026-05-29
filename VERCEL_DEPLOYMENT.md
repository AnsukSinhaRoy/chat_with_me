# Vercel deployment

Deploy the frontend and backend as **two separate Vercel projects**. Do not deploy the repository root as a single mixed project.

## Frontend project

Use these Vercel settings:

```text
Root Directory: frontend
Install Command: npm install
Build Command: NEXT_TELEMETRY_DISABLED=1 NEXT_PRIVATE_BUILD_WORKER=0 node ./node_modules/next/dist/bin/next build --turbopack
Output Directory: out
```

Set:

```text
NEXT_PUBLIC_API_BASE_URL=https://your-backend-vercel-domain
```

## Backend project

Use these Vercel settings:

```text
Root Directory: backend
Framework Preset: Other
Install Command: leave blank
Build Command: leave blank
Output Directory: leave blank
```

Set:

```text
GEMINI_API_KEY=your_key
CORS_ORIGINS=https://your-frontend-vercel-domain
APP_MODE=quota_saver
```

Backend Vercel entrypoint:

```text
backend/api/index.py
```

Do **not** use a `functions` glob like `app/**/*.py`. Vercel's Python function configuration expects function files under `api/`, so this project re-exports the FastAPI app from `api/index.py`.

Smoke test after backend deployment:

```text
https://your-backend-vercel-domain/healthz
```

Expected:

```json
{"ok": true}
```

## Important runtime checks

After deploying the backend, open:

```text
https://your-backend-domain/
```

Expected: a JSON message saying the backend is running. Also check:

```text
https://your-backend-domain/healthz
```

Expected:

```json
{"ok": true}
```

For the frontend deployment, set this environment variable before building/redeploying:

```text
NEXT_PUBLIC_API_BASE_URL=https://your-backend-domain
```

Do not point `NEXT_PUBLIC_API_BASE_URL` to the frontend domain. If it is missing or wrong, the app will now show `Backend not configured`, `Backend offline`, or a clear 404/CORS/Gemini-key error instead of pretending to be online.

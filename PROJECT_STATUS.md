# Project status after cleanup

## Current purpose

This is a browser-based AI twin/chat application. The frontend is a Next.js app that supports typed and voice questions. The backend is a FastAPI service that sends chat requests and audio transcription requests to OpenAI, optionally enriching prompts with facts selected from a local profile index.

## Important fixes made

- Removed unresolved Git merge-conflict markers from frontend code/config.
- Fixed `frontend/package.json` so npm commands work again.
- Updated Next.js to `15.5.18` and added a PostCSS override so `npm audit --omit=dev` reports zero known production vulnerabilities.
- Rebuilt the voice input UX:
  - real-time waveform/amplitude bars while recording,
  - clearer recording/transcribing states,
  - browser speech-recognition transcript preview when supported,
  - backend transcription fallback,
  - auto-stop after silence,
  - better microphone permission/error handling,
  - safer disabling of text/send controls during voice capture.
- Improved mobile/browser responsiveness with `100dvh`, safe-area composer spacing, compact mobile controls, and scroll containment.
- Added backend request validation for empty messages and oversized audio uploads.
- Fixed CORS behavior so wildcard origins do not combine with credentials.
- Added `.env.example` files for frontend/backend.
- Updated Docker setup to use same-origin frontend proxying to the backend service.
- Removed the useless root-level `package-lock.json` that confused Next.js workspace detection.

## Checks run

```bash
cd frontend
npm run typecheck
npm run build
npm audit --omit=dev
```

Result: passed. Build output route `/` is static; first-load JS is about 119 kB.

```bash
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

Result: passed.


## Vercel deployment fix

The previous package failed on Vercel because the repository root had no `package.json`, while the actual Next.js app lived in `frontend/`. This version adds:

- root `package.json` forwarding npm commands to `frontend/`,
- root `vercel.json` with explicit install/build/output settings,
- `frontend/vercel.json` for the cleaner Root Directory = `frontend` deployment path,
- public npm registry configuration via `.npmrc`,
- sanitized package locks without private/internal registry URLs.

## Remaining honest limitations

- I did not test live OpenAI chat/transcription because that requires a real `OPENAI_API_KEY` at runtime.
- I did not update `profile_chunks.json` content yet, because you said you will share detailed personal documents later.
- Browser speech recognition support differs by browser. Chrome/Edge usually work best; Safari/Firefox may rely more on backend transcription.

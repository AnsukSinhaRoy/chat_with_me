# Vercel deployment fix

The deployment was failing because `frontend/package-lock.json` contained tarball URLs from an internal OpenAI Artifactory registry, for example:

```text
https://packages.applied-caas-gateway1.internal.api.openai.org/artifactory/api/npm/npm-public/...
```

Vercel cannot access that internal host, so dependency installation timed out. After install failed, the build tried to run Next.js and produced:

```text
Cannot find module '/vercel/path0/frontend/node_modules/next/dist/bin/next'
```

That missing `next` error was a consequence, not the root cause.

## What changed

- Replaced all internal registry tarball URLs in `frontend/package-lock.json` with `https://registry.npmjs.org/`.
- Changed Vercel install commands to use `npm ci` so Vercel installs exactly from the lockfile.
- Removed the root `postinstall` script. Running `npm install` from inside another `npm install` is fragile and was likely contributing to `npm error Exit handler never called!`.
- Simplified the frontend build to `next build` instead of calling `node ./node_modules/next/dist/bin/next build --turbopack` directly.
- Pinned deployment to Node 20.x / npm 10.x instead of an open-ended `>=20.9.0` range.

## Recommended Vercel settings

You can deploy either from the repository root or from `frontend/`.

### If Vercel Root Directory is repository root

Use the root `vercel.json`. It now runs:

```bash
npm --prefix frontend ci --no-audit --no-fund
npm --prefix frontend run build
```

Output directory:

```text
frontend/out
```

### If Vercel Root Directory is `frontend`

Use `frontend/vercel.json`. It now runs:

```bash
npm ci --no-audit --no-fund
npm run build
```

Output directory:

```text
out
```

## Environment variables needed after the build works

For frontend runtime chat to work, set this in the frontend Vercel project:

```text
NEXT_PUBLIC_API_BASE_URL=https://your-backend-vercel-domain.vercel.app
NEXT_PUBLIC_APP_MODE=quota_saver
NEXT_PUBLIC_VOICE_TRANSCRIPTION_MODE=browser
NEXT_PUBLIC_BROWSER_STT_LANG=en-IN
NEXT_PUBLIC_BROWSER_STT_PROCESS_LOCALLY=false
NEXT_PUBLIC_AUTO_SEND_VOICE=true
```

For backend deployment, set your real Gemini key(s) only in Vercel environment variables, not in committed files.

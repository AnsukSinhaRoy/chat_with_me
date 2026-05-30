# Frontend Vercel install + mobile keyboard fixes

## Vercel install failure

The previous frontend `package-lock.json` contained `resolved` tarball URLs pointing at an internal OpenAI/CaaS npm mirror. Vercel cannot reach that host, so `npm install` timed out on packages such as `caniuse-lite`.

Changes:

- Removed the deprecated `always-auth=false` npm config from `frontend/.npmrc`.
- Kept the registry pinned to `https://registry.npmjs.org/`.
- Updated the root `postinstall` script to install frontend packages with an explicit public npm registry.
- Updated `scripts/build-frontend.cjs` to do the same if frontend dependencies are missing.
- Removed the frontend lockfile from the deliverable so Vercel regenerates it against the public npm registry instead of the stale internal mirror.
- Pinned frontend Node to `20.x` to avoid Vercel's open-ended engine warning.

## Mobile keyboard/composer behavior

The fixed composer now cooperates with the mobile keyboard instead of staying pinned behind it.

Changes:

- Added `interactiveWidget: "resizes-content"` to the Next viewport config.
- Added a VisualViewport fallback for mobile browsers where the keyboard overlays the layout viewport.
- The composer gets a dynamic `--keyboard-inset` when the textarea is focused.
- The bottom chat spacer now accounts for the keyboard inset, so the last message is not hidden behind the composer/keyboard.

# Frontend Animation Update

This patch focuses on frontend polish only. The backend/model/retrieval changes from the previous package are preserved.

## What changed

- Added animated ambient background layers behind the app.
- Added entrance motion for the top bar, hero copy, quick-prompt chips, debug panels, voice panels, menus, and chat bubbles.
- Added composer focus glow and subtle sweep animation when focused or busy.
- Added richer hover/press micro-interactions for buttons, chips, mode selector, and action buttons.
- Added a visual distinction for Quality mode in the model selector.
- Improved chat bubble entrance direction: user bubbles enter from the right, assistant bubbles from the left.
- Improved typing/analysis state styling.
- Improved voice/listening panel with scanning waveform background.
- Preserved `prefers-reduced-motion` support so users who request reduced motion are not forced into heavy animations.

## Validation

Run from `frontend/`:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
```

Both `typecheck` and production `build` passed in the validation environment.

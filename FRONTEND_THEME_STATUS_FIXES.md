# Frontend theme, status, and layout fixes

## Changes

- Replaced the visible backend status pill with a small header connection dot next to `Talk to Ansuk`.
  - Green/checking state means the service is reachable or being checked.
  - Red state means offline or missing configuration.
  - Hovering the red dot shows `backend offline`.
- Removed the backend status pill from the chat action row.
- Renamed `Details` to `Model details`.
- Removed `Backend URL` from the model details panel.
- Added a dark/light theme toggle in the top-right header.
  - Theme is persisted in localStorage.
  - Initial theme follows system preference if no saved theme exists.
  - Light mode uses a warmer, softer gradient instead of reusing the dark purple/green background.
- Removed the composer helper text: `Enter to send • Shift+Enter for newline • Mic records until Done, then transcribes and sends`.
- Added a dismiss button to voice notifications/errors.
- Made the chat bottom spacer track the actual fixed composer height with ResizeObserver so the gap changes with textarea/voice panel size.

## Validation

- `npm run typecheck` passed.
- `npm run build` passed.

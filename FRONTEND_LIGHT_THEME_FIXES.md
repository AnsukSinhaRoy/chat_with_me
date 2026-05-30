# Frontend light-theme refinement fixes

This patch builds on the theme/status update and focuses on visual correctness in light mode.

## Changes

- Increased the light-theme textarea placeholder contrast, including focused composer state.
- Fixed low-contrast labels inside the Model details panel, especially rows such as Voice mode.
- Improved light-theme voice notification contrast for normal and error states.
- Improved light-theme shimmer visibility for pending chat bubbles and waveform scanning.
- Removed the broad sweep animation from general buttons/chips/mode buttons/icon buttons.
- Kept restrained motion where it makes sense: title sheen, pending response shimmer, waveform scan, entrance animations, and focus glow.

## Validation

```bash
npm run typecheck
npm run build
```

Both commands passed.

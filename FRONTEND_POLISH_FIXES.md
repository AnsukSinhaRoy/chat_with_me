# Frontend polish fixes

This patch addresses the visual issues reported after the animation update.

## Changes

- Removed the composer sweep animation over the input box.
- Kept the message pending shimmer, but clipped it inside the message bubble.
- Removed the decorative bubble tails that caused mismatched corner colors.
- Removed the landing/new-chat Status button.
- Moved backend status visibility into the active chat window only.
- Renamed the debug toggle from Status to Details to avoid confusion with backend status.

## Validation

- `npm run typecheck` passed.
- `npm run build` passed.

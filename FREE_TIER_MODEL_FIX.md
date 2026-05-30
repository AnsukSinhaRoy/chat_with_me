# Free-tier model routing fix

## Problem

Both `quota_saver` and `quality` could show `gemini-3.1-flash-lite` as the last used model. That happened for two reasons:

1. `gemini-3.1-pro-preview` has no Gemini API free tier, so free API keys cannot reliably use it through the backend.
2. The old fallback path could silently collapse both modes to the same Lite model without showing whether the request used minimal or high thinking.

## New defaults

```text
GEMINI_QUOTA_SAVER_MODEL_CANDIDATES=gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-2.0-flash-lite
GEMINI_QUALITY_MODEL_CANDIDATES=gemini-3-flash-preview,gemini-3.1-flash-lite,gemini-2.5-flash
```

## Behavior

- `quota_saver` uses free-tier Lite models with `thinking=minimal`, lower temperature, shorter context, and lower output cap.
- `quality` first tries `gemini-3-flash-preview`, then falls back to `gemini-3.1-flash-lite` with `thinking=high`, larger context, higher output cap, and slightly higher temperature.
- If both modes land on `gemini-3.1-flash-lite`, they are still no longer equivalent: the debug panel now shows `Mode detail` and `Candidate models`.
- The fallback loop now tries the next model before abandoning a free key, instead of treating one unavailable stronger model as a whole-key failure.

## Important Vercel note

Do not set `GEMINI_CHAT_MODEL_CANDIDATES` unless you intentionally want both modes to share the same fallback list. It overrides the separation between modes.

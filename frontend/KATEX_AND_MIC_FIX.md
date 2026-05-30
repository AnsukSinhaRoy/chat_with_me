# KaTeX CSS and Voice Button Fix

- Replaced the bare `@import "katex/dist/katex.min.css"` with a local stylesheet import: `@import "./katex.min.css"`.
- Copied KaTeX font files into `frontend/public/katex/fonts` and rewrote the stylesheet URLs to use `/katex/fonts/...`.
- This prevents Vercel/Next builds from failing with `Module not found: Can't resolve 'katex/dist/katex.min.css'` while keeping math rendering styled.
- Replaced the emoji microphone glyph with a CSS-drawn voice waveform icon.

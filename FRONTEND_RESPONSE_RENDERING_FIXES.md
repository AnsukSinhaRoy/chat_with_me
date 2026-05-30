# Frontend Response Rendering Fixes

This patch improves how assistant messages are displayed in the chat window.

## Changes

- Added Markdown rendering for assistant responses using `react-markdown`.
- Added GitHub-flavored Markdown support via `remark-gfm`.
- Added LaTeX/math rendering via `remark-math`, `rehype-katex`, and KaTeX CSS.
- Kept user messages as plain text so user input is not unexpectedly reformatted.
- Added styled rendering for paragraphs, bold text, lists, blockquotes, inline code, code blocks, tables, links, and equations.
- Improved bubble width rules so assistant responses are more readable on mobile and desktop.
- Changed wrapping behavior from aggressive anywhere-breaking to normal word breaking, with scroll handling for long code/math/table content.
- Added light-theme-specific Markdown contrast rules.

## Validation

- `npm run typecheck` passed.
- `npm run build` passed.

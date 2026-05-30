# Frontend rendering dependency fix

- Removed the `react-markdown`, `remark-gfm`, `remark-math`, `rehype-katex`, and `katex` runtime imports.
- Replaced them with a small local Markdown renderer in `frontend/components/Chat.tsx`.
- Assistant responses still support paragraphs, headings, bold, italic, links, inline code, fenced code blocks, lists, blockquotes, basic Markdown tables, and styled inline/display math.
- User messages remain plain text.
- Removed the local KaTeX CSS/font payload because it is no longer needed.
- Made `scripts/build-frontend.cjs` install frontend dependencies if `frontend/node_modules` is missing, so root-level Vercel builds do not fail when the frontend install step was skipped.

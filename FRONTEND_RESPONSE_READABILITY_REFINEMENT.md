# Frontend response readability refinement

This patch improves assistant response rendering without adding third-party Markdown or KaTeX runtime dependencies.

Changes:
- Converts common LaTeX fragments into readable Unicode math text locally.
- Makes inline math look like normal typeset math instead of green code pills.
- Keeps display equations in a clean horizontally scrollable math panel.
- Widens assistant bubbles slightly for technical explanations.
- Improves mobile wrapping so long formulas do not destroy the layout.
- Keeps user messages as plain text.

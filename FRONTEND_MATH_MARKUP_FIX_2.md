# Frontend Math Markup Fix 2

This patch improves the dependency-free math formatter used inside assistant messages.

Fixes:
- Adds missing `kappa` -> `κ` conversion.
- Handles bare `frac{...}{...}`, `tfrac{...}{...}`, and `dfrac{...}{...}` when model output loses the leading backslash.
- Handles bare text wrappers such as `text{risk}` and `mathrm{...}` inside math.
- Keeps nested subscript/superscript conversion for expressions like `lambda_{text{risk}}` and `kappa_{text{switch}}`.

Validation:
- `npm run typecheck`
- `npm run build`

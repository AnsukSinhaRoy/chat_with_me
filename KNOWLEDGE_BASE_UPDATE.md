# Knowledge base update

Implemented after approval.

## Updated facts

- M.Tech status updated to IIT (ISM) Dhanbad, 2024-2026, CGPA 8.27/10.
- Nokia Standards internship updated to Aug 2025-Feb 2026.
- Nokia description replaced with the resume-backed version: discrete-action RRM beam selection, continual-learning Deep RL, Dueling Double DQN with residual Q-network, Prioritized Experience Replay, constraint-aware action masking, 15-35% throughput improvement, and selective actor/critic fine-tuning.
- Thesis knowledge base reframed around Sparse Online Portfolio Learning / Sparse Switching Portfolio Allocation, windowed FTRL-style framing, risk control, temporal stability, cardinality-constrained simplex, support selection plus restricted PGD, evaluation metrics, backtest caveats, and future market-exposure control.
- Hermis, THE ARCHITECT, skills, and SPR responsibility refreshed from the resume.

## Retrieval changes

- Runtime retrieval now uses tags, chunk priority, phrase boosts, and query expansion.
- Stale embedding index content was replaced with metadata-only entries so old facts cannot leak through legacy files.
- Pinned context now uses identity, current education/status, and answer policy, instead of the old missing `current_role` key.

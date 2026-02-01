"""Vercel entrypoint.

Vercel's FastAPI runtime detects an `app` variable in common entrypoints
(e.g., app/index.py) and deploys the whole FastAPI app as a single function.

See: Vercel docs "FastAPI on Vercel".
"""

from .main import app  # re-export

"""Vercel Serverless entrypoint for the FastAPI backend.

Vercel's Python function configuration only matches files in the `api/`
directory. Keep the real application code in `app/` and re-export the ASGI
`app` object here.
"""

from app.main import app

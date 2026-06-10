"""Vercel serverless entrypoint. Exposes the Flask `app` as `app`/`handler`."""

import os
import sys

# Make the project root importable so `app` package resolves on Vercel.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app  # noqa: E402

# Vercel's @vercel/python looks for a WSGI callable named `app` (or `handler`).
handler = app

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)

"""Runtime dataset loader.

Loads `app/stocks.json` (produced by `scripts/fetch_prices.py`) if present,
otherwise falls back to the editorial catalog's seed multiples. Exposes the same
interface the game engine expects: ERAS, INDUSTRIES, STOCKS, cell().
"""

import json
import os

from . import catalog
from .catalog import ERAS, INDUSTRIES  # noqa: F401  (re-exported)

_JSON_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stocks.json")


def _from_catalog():
    """Build the STOCKS map straight from the editorial catalog (seed multiples)."""
    return {
        industry: {era: [dict(s) for s in stocks] for era, stocks in eras.items()}
        for industry, eras in catalog.CATALOG.items()
    }


def _load():
    if os.path.exists(_JSON_PATH):
        try:
            with open(_JSON_PATH, encoding="utf-8") as f:
                data = json.load(f)
            if data.get("stocks"):
                return data["stocks"]
        except (json.JSONDecodeError, OSError, KeyError):
            pass
    return _from_catalog()


STOCKS = _load()


def cell(industry, era):
    """Return the list of pickable stocks for an (industry, era) cell."""
    return STOCKS[industry][era]

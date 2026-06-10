#!/usr/bin/env python3
"""Fetch real 5-year stock multiples from Stooq and write app/stocks.json.

Stooq serves free, no-API-key historical CSVs and is split-adjusted. For each
stock in the editorial catalog we pull monthly closes over its era window and
compute multiple = last_close / first_close. Anything we can't fetch (delisted,
bankrupt, or a ticker that now points at a different company) falls back to the
seed multiple in app/catalog.py.

Run from anywhere with open internet:

    python scripts/fetch_prices.py
"""

import csv
import io
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app import catalog  # noqa: E402

OUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "stocks.json")
USER_AGENT = "Mozilla/5.0 (100xPortfolio data fetcher)"
REQUEST_DELAY = 0.4  # seconds between requests, be polite

# Display ticker -> Stooq symbol when they differ.
STOOQ_SYMBOL = {"BRK": "brk-b", "FB": "meta"}

# Tickers we never fetch: delisted/bankrupt, or the symbol now belongs to a
# different company (e.g. PETS = PetMed Express today, not Pets.com). Use seed.
FORCE_SEED = {
    "PETS", "ENE", "LEH", "SUNW", "DNA", "GMCR", "KKD", "SIVB", "DELL", "GM",
}


def stooq_url(ticker, era):
    start, end = era.split("-")
    sym = STOOQ_SYMBOL.get(ticker, ticker).lower()
    return f"https://stooq.com/q/d/l/?s={sym}.us&d1={start}0101&d2={end}1231&i=m"


def fetch_multiple(ticker, era):
    """Return (multiple, source) or (None, reason) on failure."""
    if ticker in FORCE_SEED:
        return None, "forced-seed"
    url = stooq_url(ticker, era)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as resp:
            text = resp.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 - network is best-effort
        return None, f"http-error:{type(e).__name__}"

    closes = []
    for row in csv.DictReader(io.StringIO(text)):
        raw = (row.get("Close") or "").strip()
        try:
            val = float(raw)
        except ValueError:
            continue
        if val > 0:
            closes.append(val)

    if len(closes) < 2:
        return None, "no-data"
    return round(closes[-1] / closes[0], 2), "stooq"


def main():
    stocks = {}
    fetched = seeded = 0
    for industry, eras in catalog.CATALOG.items():
        stocks[industry] = {}
        for era, entries in eras.items():
            out = []
            for s in entries:
                mult, source = fetch_multiple(s["ticker"], era)
                if mult is None:
                    mult, source = s["multiple"], "seed"
                    seeded += 1
                else:
                    fetched += 1
                    time.sleep(REQUEST_DELAY)
                out.append(
                    {
                        "ticker": s["ticker"],
                        "name": s["name"],
                        "blurb": s["blurb"],
                        "multiple": mult,
                        "source": source,
                    }
                )
                print(f"  {industry:18} {era}  {s['ticker']:6} {mult:>7}x  [{source}]")
            stocks[industry][era] = out

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "stooq",
        "note": "multiple = 5y total return (split-adjusted close). seed = curated fallback.",
        "stocks": stocks,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    print(f"\nWrote {OUT_PATH}\n  fetched from Stooq: {fetched}   seeded fallback: {seeded}")


if __name__ == "__main__":
    main()

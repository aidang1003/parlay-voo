#!/usr/bin/env python3
"""Fetch real 5-year stock multiples and write app/stocks.json.

For each stock in the editorial catalog we pull monthly closes over its era
window and compute multiple = last_close / first_close. Providers are tried in
order: yfinance (Yahoo, dividend+split adjusted) -> Stooq (no key, split
adjusted) -> seed (curated fallback in app/catalog.py). Anything we can't fetch
(delisted, bankrupt, or a ticker that now points at a different company) keeps
its seed multiple.

Run from anywhere with open internet (locally, or via the GitHub Action):

    pip install yfinance        # optional but preferred
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

try:
    import yfinance  # type: ignore

    _HAS_YF = True
except ImportError:
    _HAS_YF = False

OUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app", "stocks.json")
USER_AGENT = "Mozilla/5.0 (100xPortfolio data fetcher)"
REQUEST_DELAY = 0.4  # seconds between network requests, be polite

# Display ticker -> data-provider symbol when they differ.
SYMBOL = {"BRK": "BRK-B", "FB": "META"}

# Tickers we never fetch: delisted/bankrupt, or the symbol now belongs to a
# different company (e.g. PETS = PetMed Express today, not Pets.com). Use seed.
FORCE_SEED = {
    "PETS", "ENE", "LEH", "SUNW", "DNA", "GMCR", "KKD", "SIVB", "DELL", "GM",
}


def _window(era):
    start, end = era.split("-")
    return f"{start}-01-01", f"{end}-12-31"


def try_yfinance(ticker, era):
    if not _HAS_YF:
        return None
    sym = SYMBOL.get(ticker, ticker)
    start, end = _window(era)
    try:
        df = yfinance.download(
            sym, start=start, end=end, interval="1mo",
            auto_adjust=True, progress=False, threads=False,
        )
        closes = [float(x) for x in df["Close"].dropna().values.ravel() if float(x) > 0]
    except Exception:  # noqa: BLE001 - network is best-effort
        return None
    if len(closes) < 2:
        return None
    return round(closes[-1] / closes[0], 2)


def try_stooq(ticker, era):
    sym = SYMBOL.get(ticker, ticker).lower().replace("-", "-")
    start, end = era.split("-")
    url = f"https://stooq.com/q/d/l/?s={sym}.us&d1={start}0101&d2={end}1231&i=m"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=20) as resp:
            text = resp.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        return None
    closes = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            val = float((row.get("Close") or "").strip())
        except ValueError:
            continue
        if val > 0:
            closes.append(val)
    if len(closes) < 2:
        return None
    return round(closes[-1] / closes[0], 2)


def fetch_multiple(ticker, era):
    """Return (multiple, source). Falls back to seed via caller on None."""
    if ticker in FORCE_SEED:
        return None, "forced-seed"
    mult = try_yfinance(ticker, era)
    if mult is not None:
        return mult, "yfinance"
    time.sleep(REQUEST_DELAY)
    mult = try_stooq(ticker, era)
    if mult is not None:
        return mult, "stooq"
    return None, "no-data"


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

"""
market_data.py — Live quote fetcher for Alpha

Primary:  Alpaca Markets Data API (free tier, no credit card)
Fallback: yfinance (zero-key, best-effort delayed data)

Supported symbols (auto-mapped):
  MNQ, MES, MYM, M2K  → Micro futures via yfinance continuous contract
  ES, NQ, RTY, YM     → E-mini futures
  VIX                 → CBOE Volatility Index
  SPY, QQQ, etc.      → Equities / ETFs
"""

import os
import asyncio
from datetime import datetime, timezone
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

ALPACA_API_KEY = os.getenv("ALPACA_API_KEY", "")
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY", "")

# yfinance ticker map for futures (continuous front-month contracts)
YFINANCE_MAP: dict[str, str] = {
    # Micro futures
    "MNQ": "MNQ=F",
    "MES": "MES=F",
    "MYM": "MYM=F",
    "M2K": "M2K=F",
    # E-mini futures
    "NQ":  "NQ=F",
    "ES":  "ES=F",
    "RTY": "RTY=F",
    "YM":  "YM=F",
    # Indices / volatility
    "VIX": "^VIX",
    "SPX": "^GSPC",
    "NDX": "^NDX",
    "DJI": "^DJI",
    "RUT": "^RUT",
}


def _yf_quote(symbol: str) -> Optional[dict]:
    """Fetch a quote using yfinance. Returns None on failure."""
    try:
        import yfinance as yf
        yt = YFINANCE_MAP.get(symbol.upper(), symbol.upper())
        ticker = yf.Ticker(yt)
        info = ticker.fast_info
        price = getattr(info, "last_price", None) or getattr(info, "regularMarketPrice", None)
        prev  = getattr(info, "previous_close", None) or getattr(info, "regularMarketPreviousClose", None)
        if price is None:
            return None
        change     = round(price - prev, 2) if prev else 0.0
        change_pct = round((change / prev) * 100, 2) if prev else 0.0
        return {
            "symbol":     symbol.upper(),
            "price":      round(float(price), 2),
            "change":     change,
            "change_pct": change_pct,
            "prev_close": round(float(prev), 2) if prev else None,
            "source":     "yfinance",
            "timestamp":  datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        return None


def _alpaca_quote(symbol: str) -> Optional[dict]:
    """Fetch a stock/ETF quote from Alpaca Data API (free tier)."""
    if not ALPACA_API_KEY or not ALPACA_SECRET_KEY:
        return None
    try:
        import httpx
        headers = {
            "APCA-API-KEY-ID":     ALPACA_API_KEY,
            "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
        }
        url = f"https://data.alpaca.markets/v2/stocks/{symbol.upper()}/quotes/latest"
        r = httpx.get(url, headers=headers, timeout=5)
        if r.status_code != 200:
            return None
        data  = r.json()
        quote = data.get("quote", {})
        ap    = quote.get("ap")  # ask price
        bp    = quote.get("bp")  # bid price
        if ap is None or bp is None:
            return None
        mid = round((ap + bp) / 2, 2)
        return {
            "symbol":    symbol.upper(),
            "price":     mid,
            "ask":       ap,
            "bid":       bp,
            "change":    None,
            "change_pct": None,
            "source":    "alpaca",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    except Exception:
        return None


def get_quote(symbol: str) -> dict:
    """
    Get a live quote for a symbol. Tries Alpaca first for equities/ETFs,
    falls back to yfinance for futures and when Alpaca is unconfigured.
    Returns a dict with price, change, change_pct, source, timestamp.
    On failure returns an error dict.
    """
    sym = symbol.upper().strip()
    is_futures = sym in YFINANCE_MAP or sym.endswith("=F")

    # Futures: yfinance is more reliable
    if is_futures:
        q = _yf_quote(sym)
        if q:
            return q

    # Equities/ETFs: try Alpaca first
    if ALPACA_API_KEY:
        q = _alpaca_quote(sym)
        if q:
            return q

    # Universal fallback
    q = _yf_quote(sym)
    if q:
        return q

    return {
        "symbol":  sym,
        "error":   f"Could not fetch quote for {sym}. Check symbol or market hours.",
        "source":  "none",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


async def get_quote_async(symbol: str) -> dict:
    """Async wrapper for get_quote."""
    return await asyncio.get_event_loop().run_in_executor(None, get_quote, symbol)


async def get_market_snapshot() -> dict:
    """
    Fetch quotes for the default Alpha watchlist in parallel.
    Returns { symbol: quote_dict, ... }
    """
    symbols = ["MNQ", "MES", "VIX"]
    tasks   = [get_quote_async(s) for s in symbols]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    snapshot = {}
    for sym, res in zip(symbols, results):
        if isinstance(res, Exception):
            snapshot[sym] = {"symbol": sym, "error": str(res), "source": "none"}
        else:
            snapshot[sym] = res
    return snapshot

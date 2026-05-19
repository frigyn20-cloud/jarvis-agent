"""
backfill.py — Startup candle backfill for Alpha

Fetches recent historical OHLCV candles from yfinance on startup
so the PB Blake engine has context immediately, before TradingView
webhooks start flowing in.

Buffer sizes (per your design decision — fewer candles on higher TFs):
  4H  → 30 candles
  1H  → 50 candles
  30M → 75 candles
  15M → 100 candles
  5M  → 150 candles
  1M  → 200 candles
"""

import datetime
from typing import Optional
from pb_blake import CANDLE_STORE, Candle

# Symbols to backfill
SYMBOLS = ["MNQ", "MES"]

# Per-timeframe candle count and yfinance interval/period mapping
# format: timeframe -> (candle_count, yf_interval, yf_period)
TF_CONFIG: dict[str, tuple[int, str, str]] = {
    "4H":  (30,  "1h",  "60d"),   # yf has no 4h; use 1h and resample
    "1H":  (50,  "1h",  "30d"),
    "30M": (75,  "30m", "15d"),
    "15M": (100, "15m", "8d"),
    "5M":  (150, "5m",  "5d"),
    "1M":  (200, "1m",  "2d"),
}

# yfinance ticker map
YF_MAP = {
    "MNQ": "MNQ=F",
    "MES": "MES=F",
    "NQ":  "NQ=F",
    "ES":  "ES=F",
}


def _resample_to_4h(candles_1h: list[Candle]) -> list[Candle]:
    """Resample 1H candles into 4H candles."""
    if not candles_1h:
        return []
    result: list[Candle] = []
    bucket: list[Candle] = []

    def flush(b: list[Candle]) -> Optional[Candle]:
        if not b:
            return None
        return Candle(
            symbol=b[0].symbol,
            timeframe="4H",
            open=b[0].open,
            high=max(c.high for c in b),
            low=min(c.low for c in b),
            close=b[-1].close,
            volume=sum(c.volume for c in b),
            timestamp=b[-1].timestamp,
        )

    # Group by 4-hour blocks
    current_block_hour: Optional[int] = None
    for c in candles_1h:
        try:
            dt = datetime.datetime.fromisoformat(c.timestamp.replace("Z", "+00:00"))
            block_hour = (dt.hour // 4) * 4
            if current_block_hour is None:
                current_block_hour = block_hour
            if block_hour != current_block_hour:
                fc = flush(bucket)
                if fc:
                    result.append(fc)
                bucket = [c]
                current_block_hour = block_hour
            else:
                bucket.append(c)
        except Exception:
            bucket.append(c)

    fc = flush(bucket)
    if fc:
        result.append(fc)
    return result


def _fetch_yf_candles(symbol: str, interval: str, period: str, limit: int) -> list[Candle]:
    """Fetch candles from yfinance and convert to Candle objects."""
    try:
        import yfinance as yf
        yf_ticker = YF_MAP.get(symbol.upper(), symbol.upper())
        ticker = yf.Ticker(yf_ticker)
        df = ticker.history(interval=interval, period=period)
        if df is None or df.empty:
            return []

        candles: list[Candle] = []
        for ts, row in df.iterrows():
            try:
                candles.append(Candle(
                    symbol=symbol.upper(),
                    timeframe=interval.upper(),
                    open=float(row["Open"]),
                    high=float(row["High"]),
                    low=float(row["Low"]),
                    close=float(row["Close"]),
                    volume=float(row.get("Volume", 0)),
                    timestamp=ts.isoformat(),
                ))
            except Exception:
                continue

        # Return the most recent `limit` candles
        return candles[-limit:]
    except Exception as e:
        print(f"[backfill] yfinance error for {symbol} {interval}: {e}")
        return []


def backfill_symbol(symbol: str) -> dict:
    """Backfill all timeframes for one symbol. Returns summary dict."""
    summary: dict[str, int] = {}

    for tf, (limit, yf_interval, yf_period) in TF_CONFIG.items():
        if tf == "4H":
            # Fetch 1H and resample
            candles_1h = _fetch_yf_candles(symbol, "1h", "60d", limit * 4)
            # Fix timeframe label before resampling
            for c in candles_1h:
                c.timeframe = "1H"
            candles = _resample_to_4h(candles_1h)[-limit:]
        else:
            candles = _fetch_yf_candles(symbol, yf_interval, yf_period, limit)
            # Normalise timeframe label to match PB Blake keys (e.g. "30m" -> "30M")
            for c in candles:
                c.timeframe = tf

        for c in candles:
            CANDLE_STORE.push(c)

        summary[tf] = len(candles)
        print(f"[backfill] {symbol}@{tf}: {len(candles)} candles loaded")

    return summary


def run_backfill() -> dict:
    """
    Run full backfill for all symbols.
    Called once on startup from main.py.
    Returns {symbol: {timeframe: count}} summary.
    """
    results: dict = {}
    for symbol in SYMBOLS:
        print(f"[backfill] Starting backfill for {symbol}...")
        results[symbol] = backfill_symbol(symbol)
        print(f"[backfill] {symbol} done: {results[symbol]}")
    return results

"""
pb_blake.py  —  PB Blake ICT Setup Detector

Pipeline (runs on every candle close received via TradingView webhook):
  1. Store candle in rolling in-memory store (per symbol, per timeframe)
  2. Determine 4H/1H bias  (HH/HL = bullish | LH/LL = bearish)
  3. Scan 15m-1H for liquidity draw  (nearest swing point not yet swept)
  4. Scan 5m/1m for FVG  (three-candle gap in bias direction)
  5. Detect iFVG  (FVG that was subsequently crossed and has now re-entered)
  6. Score setup  (0-3 conditions met)
  7. If score == 3  →  push spoken alert text to alert queue

All logic is pure-python with no external dependencies.
"""

from __future__ import annotations
import datetime
from collections import deque
from dataclasses import dataclass, field
from typing import Literal, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MAX_CANDLES = 200          # rolling window per (symbol, tf)
BIAS_TF     = ["4H", "1H"]  # timeframes for bias
LIQ_TF      = ["1H", "15M"] # timeframes for liquidity draw scan
ENTRY_TF    = ["5M", "1M"]  # timeframes for FVG/iFVG

Swing = Literal["high", "low"]
Bias  = Literal["bullish", "bearish", "neutral"]


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------
@dataclass
class Candle:
    symbol:    str
    timeframe: str
    open:      float
    high:      float
    low:       float
    close:     float
    volume:    float
    timestamp: str   # ISO string from TradingView


@dataclass
class FVG:
    direction: Bias      # bullish gap or bearish gap
    top:       float     # upper edge of gap
    bottom:    float     # lower edge of gap
    formed_at: str       # candle timestamp
    inversed:  bool = False  # True once price traded through it
    timeframe: str = ""

    @property
    def midpoint(self) -> float:
        return (self.top + self.bottom) / 2


@dataclass
class LiquidityLevel:
    price:     float
    kind:      Swing
    timeframe: str
    swept:     bool  = False
    formed_at: str   = ""


@dataclass
class SetupScore:
    symbol:       str
    bias:         Bias
    score:        int           # 0-3
    bias_details: str  = ""
    liq_draw:     Optional[LiquidityLevel] = None
    entry_fvg:    Optional[FVG]            = None
    alert_text:   str  = ""
    timestamp:    str  = ""

    @property
    def is_valid(self) -> bool:
        return self.score >= 3


# ---------------------------------------------------------------------------
# Candle store
# ---------------------------------------------------------------------------
class CandleStore:
    """In-memory rolling candle buffer — keyed by (symbol, timeframe)."""

    def __init__(self):
        self._data: dict[tuple[str, str], deque[Candle]] = {}

    def push(self, candle: Candle) -> None:
        key = (candle.symbol.upper(), candle.timeframe.upper())
        if key not in self._data:
            self._data[key] = deque(maxlen=MAX_CANDLES)
        self._data[key].append(candle)

    def get(self, symbol: str, timeframe: str, n: int = MAX_CANDLES) -> list[Candle]:
        key = (symbol.upper(), timeframe.upper())
        buf = self._data.get(key, deque())
        candles = list(buf)
        return candles[-n:] if n else candles

    def has(self, symbol: str, timeframe: str, minimum: int = 3) -> bool:
        return len(self.get(symbol, timeframe)) >= minimum

    def summary(self) -> dict:
        return {
            f"{sym}@{tf}": len(list(buf))
            for (sym, tf), buf in self._data.items()
        }


# Singleton — shared across the whole backend process
CANDLE_STORE = CandleStore()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _swing_highs(candles: list[Candle], lookback: int = 3) -> list[float]:
    """Simple swing-high detector (pivot high)."""
    highs = []
    for i in range(lookback, len(candles) - lookback):
        h = candles[i].high
        if all(h >= candles[j].high for j in range(i - lookback, i + lookback + 1) if j != i):
            highs.append(h)
    return highs


def _swing_lows(candles: list[Candle], lookback: int = 3) -> list[float]:
    """Simple swing-low detector (pivot low)."""
    lows = []
    for i in range(lookback, len(candles) - lookback):
        l = candles[i].low
        if all(l <= candles[j].low for j in range(i - lookback, i + lookback + 1) if j != i):
            lows.append(l)
    return lows


def _detect_fvgs(candles: list[Candle], direction: Bias) -> list[FVG]:
    """
    Bullish FVG: candle[i+2].low > candle[i].high  (gap up — three-candle structure)
    Bearish FVG: candle[i+2].high < candle[i].low  (gap down)
    """
    fvgs: list[FVG] = []
    tf = candles[0].timeframe if candles else ""
    for i in range(len(candles) - 2):
        a, b, c = candles[i], candles[i + 1], candles[i + 2]
        if direction == "bullish" and c.low > a.high:
            fvgs.append(FVG(
                direction="bullish",
                top=c.low,
                bottom=a.high,
                formed_at=c.timestamp,
                timeframe=tf,
            ))
        elif direction == "bearish" and c.high < a.low:
            fvgs.append(FVG(
                direction="bearish",
                top=a.low,
                bottom=c.high,
                formed_at=c.timestamp,
                timeframe=tf,
            ))
    return fvgs


def _find_ifvg(fvgs: list[FVG], candles: list[Candle], direction: Bias) -> Optional[FVG]:
    """
    An iFVG is a FVG that price traded through (inversed) and has since
    retraced back into the gap — creating an entry zone.
    Bullish iFVG: bearish FVG that was broken to the upside;
                  current price pulling back into it.
    Bearish iFVG: bullish FVG that was broken to the downside;
                  current price pulling back into it.
    """
    if not candles or not fvgs:
        return None
    current_price = candles[-1].close

    for fvg in reversed(fvgs):  # most recent first
        if direction == "bullish":
            # We need a bearish FVG (price gapped down) that has since been
            # broken upward and current price is retesting into it.
            if fvg.direction == "bearish":
                # Check if any candle after formation broke above the top
                formed_idx = next(
                    (i for i, c in enumerate(candles) if c.timestamp == fvg.formed_at), None
                )
                if formed_idx is None:
                    continue
                after = candles[formed_idx + 1:]
                if any(c.high > fvg.top for c in after):   # broken upward
                    if fvg.bottom <= current_price <= fvg.top:  # pulling back in
                        fvg.inversed = True
                        return fvg
        else:  # bearish setup
            if fvg.direction == "bullish":
                formed_idx = next(
                    (i for i, c in enumerate(candles) if c.timestamp == fvg.formed_at), None
                )
                if formed_idx is None:
                    continue
                after = candles[formed_idx + 1:]
                if any(c.low < fvg.bottom for c in after):  # broken downward
                    if fvg.bottom <= current_price <= fvg.top:  # pulling back in
                        fvg.inversed = True
                        return fvg
    return None


# ---------------------------------------------------------------------------
# Bias engine
# ---------------------------------------------------------------------------
def determine_bias(symbol: str) -> tuple[Bias, str]:
    """
    Checks 4H then 1H structure.
    HH + HL + bullish FVG respect  →  bullish
    LH + LL + bearish FVG respect  →  bearish
    Returns (bias, description_string).
    """
    votes: list[Bias] = []
    details_parts: list[str] = []

    for tf in BIAS_TF:
        candles = CANDLE_STORE.get(symbol, tf, n=30)
        if len(candles) < 6:
            details_parts.append(f"{tf}: insufficient data ({len(candles)} candles)")
            continue

        highs = _swing_highs(candles, lookback=2)
        lows  = _swing_lows(candles,  lookback=2)

        if len(highs) >= 2 and len(lows) >= 2:
            hh = highs[-1] > highs[-2]
            hl = lows[-1]  > lows[-2]
            lh = highs[-1] < highs[-2]
            ll = lows[-1]  < lows[-2]

            if hh and hl:
                votes.append("bullish")
                details_parts.append(f"{tf}: HH+HL structure — bullish")
            elif lh and ll:
                votes.append("bearish")
                details_parts.append(f"{tf}: LH+LL structure — bearish")
            else:
                details_parts.append(f"{tf}: mixed structure — neutral")
        else:
            details_parts.append(f"{tf}: not enough swings yet")

    if votes.count("bullish") >= len(votes) / 2 and votes:
        return "bullish", " | ".join(details_parts)
    if votes.count("bearish") >= len(votes) / 2 and votes:
        return "bearish", " | ".join(details_parts)
    return "neutral", " | ".join(details_parts)


# ---------------------------------------------------------------------------
# Liquidity draw scanner
# ---------------------------------------------------------------------------
def find_liquidity_draw(symbol: str, bias: Bias) -> Optional[LiquidityLevel]:
    """
    Bullish bias  →  look for equal lows / buy-side liquidity above
    Bearish bias  →  look for equal highs / sell-side liquidity below
    Returns the nearest unswept level.
    """
    if bias == "neutral":
        return None

    for tf in LIQ_TF:
        candles = CANDLE_STORE.get(symbol, tf, n=50)
        if len(candles) < 6:
            continue

        current_price = candles[-1].close

        if bias == "bullish":
            # Nearest swing high above current price (draw on liquidity)
            highs = sorted(_swing_highs(candles, lookback=2), reverse=True)
            for h in highs:
                if h > current_price:
                    return LiquidityLevel(
                        price=round(h, 2),
                        kind="high",
                        timeframe=tf,
                        swept=False,
                        formed_at=candles[-1].timestamp,
                    )
        else:
            lows = sorted(_swing_lows(candles, lookback=2))
            for l in lows:
                if l < current_price:
                    return LiquidityLevel(
                        price=round(l, 2),
                        kind="low",
                        timeframe=tf,
                        swept=False,
                        formed_at=candles[-1].timestamp,
                    )
    return None


# ---------------------------------------------------------------------------
# Entry FVG / iFVG scanner
# ---------------------------------------------------------------------------
def find_entry_fvg(symbol: str, bias: Bias) -> Optional[FVG]:
    """Scan 5M then 1M for the highest-timeframe iFVG in the direction of bias."""
    if bias == "neutral":
        return None

    for tf in ENTRY_TF:
        candles = CANDLE_STORE.get(symbol, tf, n=50)
        if len(candles) < 3:
            continue

        fvgs = _detect_fvgs(candles, bias)
        ifvg = _find_ifvg(fvgs, candles, bias)
        if ifvg:
            ifvg.timeframe = tf
            return ifvg

    return None


# ---------------------------------------------------------------------------
# Main setup evaluator
# ---------------------------------------------------------------------------
def evaluate_setup(symbol: str) -> SetupScore:
    """
    Full PB Blake pipeline for one symbol.
    Returns a SetupScore with score 0-3 and an alert_text if score == 3.
    """
    now = datetime.datetime.utcnow().isoformat()

    bias, bias_details = determine_bias(symbol)

    if bias == "neutral":
        return SetupScore(
            symbol=symbol, bias="neutral", score=0,
            bias_details=bias_details, timestamp=now,
        )

    score = 1  # bias is condition 1

    liq   = find_liquidity_draw(symbol, bias)
    if liq:
        score += 1

    fvg   = find_entry_fvg(symbol, bias)
    if fvg:
        score += 1

    alert_text = ""
    if score == 3:
        direction_word = "long" if bias == "bullish" else "short"
        liq_price = f"{liq.price:,.2f}" if liq else "unknown"
        fvg_tf    = fvg.timeframe if fvg else "unknown"
        fvg_zone  = f"{fvg.bottom:,.2f} to {fvg.top:,.2f}" if fvg else "unknown"
        alert_text = (
            f"Sir, a {symbol} {direction_word} setup is forming. "
            f"{bias.capitalize()} bias confirmed on the higher timeframes. "
            f"Liquidity draw at {liq_price}. "
            f"{fvg_tf} inverse fair value gap between {fvg_zone}. "
            f"All three conditions of the P B Blake model are met."
        )

    return SetupScore(
        symbol=symbol, bias=bias, score=score,
        bias_details=bias_details,
        liq_draw=liq, entry_fvg=fvg,
        alert_text=alert_text, timestamp=now,
    )


# ---------------------------------------------------------------------------
# Alert queue  (frontend polls /setup/alerts)
# ---------------------------------------------------------------------------
_alert_queue: deque[dict] = deque(maxlen=20)
_last_alerted: dict[str, str] = {}   # symbol -> timestamp of last alert pushed


def push_alert_if_new(score: SetupScore) -> bool:
    """Push to queue only if this is a new alert (not repeated for same candle)."""
    if not score.is_valid or not score.alert_text:
        return False
    last = _last_alerted.get(score.symbol, "")
    if last == score.timestamp:
        return False
    _last_alerted[score.symbol] = score.timestamp
    _alert_queue.append({
        "symbol":     score.symbol,
        "bias":       score.bias,
        "score":      score.score,
        "alert_text": score.alert_text,
        "liq_price":  score.liq_draw.price if score.liq_draw else None,
        "fvg_zone":   f"{score.entry_fvg.bottom:.2f}-{score.entry_fvg.top:.2f}" if score.entry_fvg else None,
        "fvg_tf":     score.entry_fvg.timeframe if score.entry_fvg else None,
        "timestamp":  score.timestamp,
    })
    return True


def get_pending_alerts() -> list[dict]:
    alerts = list(_alert_queue)
    _alert_queue.clear()
    return alerts


def get_setup_status(symbol: str) -> dict:
    """Human-readable setup status for a symbol — used by /setup/status endpoint."""
    score = evaluate_setup(symbol)
    return {
        "symbol":        symbol,
        "bias":          score.bias,
        "score":         score.score,
        "conditions": {
            "bias":      score.score >= 1,
            "liq_draw":  score.score >= 2,
            "ifvg":      score.score >= 3,
        },
        "liq_draw":      {
            "price":     score.liq_draw.price     if score.liq_draw else None,
            "kind":      score.liq_draw.kind       if score.liq_draw else None,
            "timeframe": score.liq_draw.timeframe  if score.liq_draw else None,
        } if score.liq_draw else None,
        "entry_fvg":     {
            "top":       score.entry_fvg.top       if score.entry_fvg else None,
            "bottom":    score.entry_fvg.bottom    if score.entry_fvg else None,
            "timeframe": score.entry_fvg.timeframe if score.entry_fvg else None,
            "inversed":  score.entry_fvg.inversed  if score.entry_fvg else None,
        } if score.entry_fvg else None,
        "alert_text":    score.alert_text,
        "bias_details":  score.bias_details,
        "candle_counts": CANDLE_STORE.summary(),
        "timestamp":     score.timestamp,
    }

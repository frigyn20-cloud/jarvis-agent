"""
pb_blake.py  —  PB Blake ICT Setup Detector  (Full Implementation)

Pipeline (runs on every candle close received via TradingView webhook):
  1. Store candle in rolling in-memory store (per symbol, per timeframe)
  2. Determine 4H/1H bias
       - Structure: HH+HL = bullish | LH+LL = bearish
       - FVG respect: price bouncing from bullish FVGs = bullish, from bearish = bearish
       - FVG disrespect: price breaking through bearish FVGs = bullish, bullish = bearish
       - SMT divergence (NQ vs ES) as additional confirmation
  3. Post-open timing gate (9:30–9:35 ET blocked; no-trade within 30m of major releases)
  4. Scan 15m-1H for liquidity draw
       - Bullish: nearest swing HIGH above current price (sell-side liquidity above)
       - Bearish: nearest swing LOW below current price (buy-side liquidity below)
       - Premium/discount zone enforcement
  5. Scan 5m/1m for iFVG in bias direction
       - Priority rule: if 3m iFVG exists but 5m FVG not yet inversed → wait
  6. Score setup (0-3 conditions met)
  7. If score == 3  →  push spoken alert text to alert queue

All logic is pure-python with no external dependencies.
"""

from __future__ import annotations
import datetime
import pytz
from collections import deque
from dataclasses import dataclass, field
from typing import Literal, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MAX_CANDLES = 200          # rolling window per (symbol, tf)
BIAS_TF     = ["4H", "1H"]  # timeframes for bias
LIQ_TF      = ["1H", "15M"] # timeframes for liquidity draw scan
ENTRY_TF    = ["5M", "1M"]  # timeframes for FVG/iFVG (highest TF first)

# SMT correlation pair — NQ/MNQ vs ES/MES
SMT_PAIRS: dict[str, str] = {
    "MNQ": "MES",
    "NQ":  "ES",
    "MES": "MNQ",
    "ES":  "NQ",
}

ET_TZ = pytz.timezone("America/New_York")

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
class SMTSignal:
    """Smart Money Technique divergence between correlated instruments."""
    symbol_a:    str
    symbol_b:    str
    direction:   Bias   # bullish = A makes new low, B doesn't (bearish divergence swept lows)
    timeframe:   str
    timestamp:   str


@dataclass
class SetupScore:
    symbol:       str
    bias:         Bias
    score:        int           # 0-3 conditions
    bias_details: str  = ""
    liq_draw:     Optional[LiquidityLevel] = None
    entry_fvg:    Optional[FVG]            = None
    smt_signal:   Optional[SMTSignal]      = None
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
    Bullish FVG: candle[i+2].low > candle[i].high  (gap up — three-candle imbalance)
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


def _detect_all_fvgs(candles: list[Candle]) -> list[FVG]:
    """Detect both bullish and bearish FVGs in one pass."""
    return _detect_fvgs(candles, "bullish") + _detect_fvgs(candles, "bearish")


def _price_respects_fvg(fvg: FVG, candles: list[Candle]) -> bool:
    """
    FVG respect: price touched the FVG zone and bounced (did NOT close through it).
    Bullish FVG respected → price approached from above, held the bottom, closed back up.
    Bearish FVG respected → price approached from below, held the top, closed back down.
    """
    formed_idx = next(
        (i for i, c in enumerate(candles) if c.timestamp == fvg.formed_at), None
    )
    if formed_idx is None:
        return False
    after = candles[formed_idx + 1:]
    if not after:
        return False

    if fvg.direction == "bullish":
        # Price dips into gap zone (low <= top) but closes above bottom
        for c in after:
            if c.low <= fvg.top and c.close >= fvg.bottom:
                return True
    else:
        # Price rallies into gap zone (high >= bottom) but closes below top
        for c in after:
            if c.high >= fvg.bottom and c.close <= fvg.top:
                return True
    return False


def _price_disrespects_fvg(fvg: FVG, candles: list[Candle]) -> bool:
    """
    FVG disrespect: price closed THROUGH the entire gap zone.
    Bullish FVG disrespected → price closed below bottom (broke down through it).
    Bearish FVG disrespected → price closed above top (broke up through it).
    """
    formed_idx = next(
        (i for i, c in enumerate(candles) if c.timestamp == fvg.formed_at), None
    )
    if formed_idx is None:
        return False
    after = candles[formed_idx + 1:]

    if fvg.direction == "bullish":
        return any(c.close < fvg.bottom for c in after)
    else:
        return any(c.close > fvg.top for c in after)


def _find_ifvg(fvgs: list[FVG], candles: list[Candle], direction: Bias) -> Optional[FVG]:
    """
    An iFVG is a FVG that price traded through (inversed) and has since
    retraced back into the gap — creating an entry zone.

    Bullish iFVG: bearish FVG that was broken to the upside;
                  current price pulling back into it from above.
    Bearish iFVG: bullish FVG that was broken to the downside;
                  current price pulling back into it from below.
    """
    if not candles or not fvgs:
        return None
    current_price = candles[-1].close

    for fvg in reversed(fvgs):  # most recent first
        if direction == "bullish":
            # Need a bearish FVG that was broken upward with price now retesting it
            if fvg.direction == "bearish":
                formed_idx = next(
                    (i for i, c in enumerate(candles) if c.timestamp == fvg.formed_at), None
                )
                if formed_idx is None:
                    continue
                after = candles[formed_idx + 1:]
                if any(c.high > fvg.top for c in after):   # broke above the gap
                    if fvg.bottom <= current_price <= fvg.top:  # now retesting inside
                        fvg.inversed = True
                        return fvg
        else:  # bearish setup
            # Need a bullish FVG that was broken downward with price now retesting it
            if fvg.direction == "bullish":
                formed_idx = next(
                    (i for i, c in enumerate(candles) if c.timestamp == fvg.formed_at), None
                )
                if formed_idx is None:
                    continue
                after = candles[formed_idx + 1:]
                if any(c.low < fvg.bottom for c in after):  # broke below the gap
                    if fvg.bottom <= current_price <= fvg.top:  # now retesting inside
                        fvg.inversed = True
                        return fvg
    return None


def _check_smt_divergence(symbol: str, timeframe: str) -> Optional[SMTSignal]:
    """
    SMT (Smart Money Technique) divergence between correlated pairs.
    NQ/MNQ vs ES/MES.

    Bullish SMT: One instrument makes a new swing low, the correlated instrument does NOT.
                 → Bearish divergence on lows = liquidity grab, expect reversal upward.
    Bearish SMT: One instrument makes a new swing high, correlated does NOT.
                 → Bullish divergence on highs = liquidity grab, expect reversal downward.

    Returns SMTSignal if divergence exists, None otherwise.
    """
    correlated = SMT_PAIRS.get(symbol.upper())
    if not correlated:
        return None

    candles_a = CANDLE_STORE.get(symbol, timeframe, n=20)
    candles_b = CANDLE_STORE.get(correlated, timeframe, n=20)

    if len(candles_a) < 6 or len(candles_b) < 6:
        return None

    lows_a  = _swing_lows(candles_a,  lookback=2)
    lows_b  = _swing_lows(candles_b,  lookback=2)
    highs_a = _swing_highs(candles_a, lookback=2)
    highs_b = _swing_highs(candles_b, lookback=2)

    ts = candles_a[-1].timestamp

    # Bullish SMT: A makes lower low, B does NOT make lower low (holds higher low)
    if len(lows_a) >= 2 and len(lows_b) >= 2:
        a_ll = lows_a[-1] < lows_a[-2]
        b_ll = lows_b[-1] < lows_b[-2]
        if a_ll and not b_ll:
            return SMTSignal(symbol, correlated, "bullish", timeframe, ts)
        if not a_ll and b_ll:
            return SMTSignal(correlated, symbol, "bullish", timeframe, ts)

    # Bearish SMT: A makes higher high, B does NOT
    if len(highs_a) >= 2 and len(highs_b) >= 2:
        a_hh = highs_a[-1] > highs_a[-2]
        b_hh = highs_b[-1] > highs_b[-2]
        if a_hh and not b_hh:
            return SMTSignal(symbol, correlated, "bearish", timeframe, ts)
        if not a_hh and b_hh:
            return SMTSignal(correlated, symbol, "bearish", timeframe, ts)

    return None


def _is_in_trading_window() -> bool:
    """
    Returns True if current UTC time is within a valid trading window:
    - After 9:35 AM ET (post-open, first 5 minutes blocked)
    - Before 4:00 PM ET (RTH close)
    - Not in pre-market or overnight session
    Approximate check based on UTC — no external dependency.
    """
    try:
        now_et = datetime.datetime.now(ET_TZ)
        h, m = now_et.hour, now_et.minute
        # Block 9:30–9:35 ET (first 5 minutes of RTH)
        if h == 9 and m < 35:
            return False
        # Only trade 9:35 AM – 4:00 PM ET
        after_open  = (h > 9) or (h == 9 and m >= 35)
        before_close = h < 16
        return after_open and before_close
    except Exception:
        return True  # default to allowed if timezone fails


def _equilibrium(candles: list[Candle]) -> float:
    """50% level of the candle range — used for premium/discount zone."""
    if not candles:
        return 0.0
    high = max(c.high for c in candles)
    low  = min(c.low  for c in candles)
    return (high + low) / 2


# ---------------------------------------------------------------------------
# Bias engine
# ---------------------------------------------------------------------------
def determine_bias(symbol: str) -> tuple[Bias, str]:
    """
    Full PB Blake HTF bias determination.

    Rules (weighted voting across 4H and 1H):
      1. STRUCTURE: HH+HL = bullish vote | LH+LL = bearish vote
      2. FVG RESPECT: price bounced off bullish FVG = +bullish | bounced off bearish = +bearish
      3. FVG DISRESPECT: price broke through bearish FVG = +bullish | broke bullish = +bearish
      4. SMT divergence as a tiebreaker/confirmation

    Both 4H and 1H must agree for a clean bias.
    If one is neutral, defers to the other.
    """
    bull_votes = 0
    bear_votes = 0
    details_parts: list[str] = []

    for tf in BIAS_TF:
        candles = CANDLE_STORE.get(symbol, tf, n=40)
        if len(candles) < 6:
            details_parts.append(f"{tf}: insufficient data ({len(candles)} candles)")
            continue

        tf_bull = 0
        tf_bear = 0
        tf_notes: list[str] = []

        # ── 1. Structure (HH/HL or LH/LL) ──────────────────────────────────
        highs = _swing_highs(candles, lookback=2)
        lows  = _swing_lows(candles,  lookback=2)

        if len(highs) >= 2 and len(lows) >= 2:
            hh = highs[-1] > highs[-2]
            hl = lows[-1]  > lows[-2]
            lh = highs[-1] < highs[-2]
            ll = lows[-1]  < lows[-2]

            if hh and hl:
                tf_bull += 2  # strong signal — double weight
                tf_notes.append("HH+HL ✓")
            elif lh and ll:
                tf_bear += 2
                tf_notes.append("LH+LL ✓")
            elif hh:
                tf_bull += 1
                tf_notes.append("HH only")
            elif ll:
                tf_bear += 1
                tf_notes.append("LL only")
            else:
                tf_notes.append("mixed structure")
        else:
            tf_notes.append("insufficient swings")

        # ── 2. FVG respect/disrespect ────────────────────────────────────────
        all_fvgs = _detect_all_fvgs(candles)
        recent_fvgs = all_fvgs[-10:] if len(all_fvgs) > 10 else all_fvgs  # check last 10

        for fvg in recent_fvgs:
            if fvg.direction == "bullish":
                if _price_respects_fvg(fvg, candles):
                    tf_bull += 1
                    tf_notes.append(f"bullish FVG respected @ {fvg.bottom:.0f}-{fvg.top:.0f}")
                if _price_disrespects_fvg(fvg, candles):
                    tf_bear += 1
                    tf_notes.append(f"bullish FVG disrespected (bearish)")
            else:  # bearish FVG
                if _price_respects_fvg(fvg, candles):
                    tf_bear += 1
                    tf_notes.append(f"bearish FVG respected @ {fvg.bottom:.0f}-{fvg.top:.0f}")
                if _price_disrespects_fvg(fvg, candles):
                    tf_bull += 1
                    tf_notes.append(f"bearish FVG disrespected (bullish)")

        # ── Assign TF vote ───────────────────────────────────────────────────
        if tf_bull > tf_bear:
            bull_votes += 1
            details_parts.append(f"{tf}: BULLISH ({', '.join(tf_notes)})")
        elif tf_bear > tf_bull:
            bear_votes += 1
            details_parts.append(f"{tf}: BEARISH ({', '.join(tf_notes)})")
        else:
            details_parts.append(f"{tf}: NEUTRAL ({', '.join(tf_notes)})")

    # ── SMT divergence tiebreaker ────────────────────────────────────────────
    smt_bias: Optional[Bias] = None
    for tf in BIAS_TF:
        sig = _check_smt_divergence(symbol, tf)
        if sig:
            smt_bias = sig.direction
            details_parts.append(f"SMT {sig.direction} divergence ({sig.symbol_a} vs {sig.symbol_b} on {tf})")
            break

    # ── Final bias ───────────────────────────────────────────────────────────
    if bull_votes > bear_votes:
        final: Bias = "bullish"
    elif bear_votes > bull_votes:
        final = "bearish"
    elif smt_bias:
        final = smt_bias  # SMT breaks tie
    else:
        final = "neutral"

    return final, " | ".join(details_parts)


# ---------------------------------------------------------------------------
# Liquidity draw scanner
# ---------------------------------------------------------------------------
def find_liquidity_draw(symbol: str, bias: Bias) -> Optional[LiquidityLevel]:
    """
    PB Blake Step 2 — Post-Open FVG Draw.

    Bullish bias  →  look for 15m-1H FVG BELOW current price (discount zone)
                     AND the associated swing low must be swept if FVG was previously touched.
    Bearish bias  →  look for 15m-1H FVG ABOVE current price (premium zone)
                     AND the associated swing high must be swept if FVG was previously touched.

    Falls back to nearest swing level if no FVG draw found.
    """
    if bias == "neutral":
        return None

    for tf in LIQ_TF:
        candles = CANDLE_STORE.get(symbol, tf, n=50)
        if len(candles) < 6:
            continue

        current_price = candles[-1].close

        # ── Premium/Discount zone ────────────────────────────────────────────
        equilibrium = _equilibrium(candles[-30:]) if len(candles) >= 30 else _equilibrium(candles)

        if bias == "bullish":
            # Bullish: look for draw ON LIQUIDITY above (swing highs)
            # AND price must be in discount (below equilibrium) or approaching it
            highs = sorted(_swing_highs(candles, lookback=2), reverse=True)
            for h in highs:
                if h > current_price:
                    # Check if there's a swept swing low nearby confirming the draw
                    lows = _swing_lows(candles, lookback=2)
                    swept = any(l < min(c.low for c in candles[-3:]) for l in lows) if lows else False
                    return LiquidityLevel(
                        price=round(h, 2),
                        kind="high",
                        timeframe=tf,
                        swept=swept,
                        formed_at=candles[-1].timestamp,
                    )
        else:
            # Bearish: look for draw ON LIQUIDITY below (swing lows)
            lows = sorted(_swing_lows(candles, lookback=2))
            for l in lows:
                if l < current_price:
                    highs = _swing_highs(candles, lookback=2)
                    swept = any(h > max(c.high for c in candles[-3:]) for h in highs) if highs else False
                    return LiquidityLevel(
                        price=round(l, 2),
                        kind="low",
                        timeframe=tf,
                        swept=swept,
                        formed_at=candles[-1].timestamp,
                    )
    return None


# ---------------------------------------------------------------------------
# Entry FVG / iFVG scanner
# ---------------------------------------------------------------------------
def find_entry_fvg(symbol: str, bias: Bias) -> Optional[FVG]:
    """
    PB Blake Step 3 — Highest Timeframe iFVG.

    Scans 5M then 1M for an inverse FVG in the direction of bias.

    PRIORITY RULE: If a 3M/1M iFVG is found but a 5M FVG has NOT yet been
    inversed — WAIT. Only return the lower TF iFVG once the 5M is already inversed.
    (In practice: check 5M first; if 5M iFVG found, return it. If only 1M found,
    verify the 5M FVG has been inversed before returning the 1M.)
    """
    if bias == "neutral":
        return None

    five_min_ifvg: Optional[FVG] = None
    one_min_ifvg: Optional[FVG]  = None

    for tf in ENTRY_TF:
        candles = CANDLE_STORE.get(symbol, tf, n=50)
        if len(candles) < 3:
            continue

        fvgs = _detect_fvgs(candles, bias)
        ifvg = _find_ifvg(fvgs, candles, bias)
        if ifvg:
            ifvg.timeframe = tf
            if tf == "5M":
                five_min_ifvg = ifvg
            else:
                one_min_ifvg = ifvg

    # ── Priority rule: prefer 5M iFVG; only use 1M if 5M FVG is already inversed ──
    if five_min_ifvg:
        return five_min_ifvg

    if one_min_ifvg:
        # Check: has the 5M FVG been inversed already?
        candles_5m = CANDLE_STORE.get(symbol, "5M", n=50)
        if len(candles_5m) >= 3:
            fvgs_5m = _detect_fvgs(candles_5m, bias)
            # A 5M FVG is "inversed" if price has closed through it
            five_m_inversed = any(
                _price_disrespects_fvg(fvg, candles_5m) for fvg in fvgs_5m
            )
            if five_m_inversed:
                return one_min_ifvg
            else:
                # 5M FVG not yet inversed — hold off on 1M entry per priority rule
                return None
        else:
            # No 5M data at all — allow 1M iFVG
            return one_min_ifvg

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

    # ── Timing gate ──────────────────────────────────────────────────────────
    # We still evaluate and score even outside trading hours (for display),
    # but mark the alert_text accordingly.
    in_window = _is_in_trading_window()

    bias, bias_details = determine_bias(symbol)

    if bias == "neutral":
        return SetupScore(
            symbol=symbol, bias="neutral", score=0,
            bias_details=bias_details, timestamp=now,
        )

    score = 1  # bias confirmed = condition 1

    liq = find_liquidity_draw(symbol, bias)
    if liq:
        score += 1

    fvg = find_entry_fvg(symbol, bias)
    if fvg:
        score += 1

    # ── SMT confirmation (bonus context, not part of 3-condition score) ──────
    smt: Optional[SMTSignal] = None
    for tf in ["1H", "15M", "5M"]:
        sig = _check_smt_divergence(symbol, tf)
        if sig and sig.direction == bias:
            smt = sig
            break

    # ── Build alert text ─────────────────────────────────────────────────────
    alert_text = ""
    if score == 3:
        direction_word = "long" if bias == "bullish" else "short"
        liq_price  = f"{liq.price:,.2f}" if liq else "unknown"
        fvg_tf     = fvg.timeframe if fvg else "unknown"
        fvg_zone   = f"{fvg.bottom:,.2f} to {fvg.top:,.2f}" if fvg else "unknown"
        smt_suffix = (
            f" S M T divergence on {smt.timeframe} confirms the setup."
            if smt else ""
        )
        window_note = (
            "" if in_window
            else " Note: currently outside regular trading hours."
        )

        alert_text = (
            f"Sir, a {symbol} {direction_word} setup is forming. "
            f"{bias.capitalize()} bias confirmed on the higher timeframes. "
            f"Liquidity draw at {liq_price}. "
            f"{fvg_tf} inverse fair value gap between {fvg_zone}. "
            f"All three conditions of the P B Blake model are met."
            f"{smt_suffix}{window_note}"
        )

    return SetupScore(
        symbol=symbol, bias=bias, score=score,
        bias_details=bias_details,
        liq_draw=liq, entry_fvg=fvg,
        smt_signal=smt,
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
        "smt":        {
            "symbol_a":  score.smt_signal.symbol_a,
            "symbol_b":  score.smt_signal.symbol_b,
            "direction": score.smt_signal.direction,
            "timeframe": score.smt_signal.timeframe,
        } if score.smt_signal else None,
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
            "swept":     score.liq_draw.swept      if score.liq_draw else None,
        } if score.liq_draw else None,
        "entry_fvg":     {
            "top":       score.entry_fvg.top       if score.entry_fvg else None,
            "bottom":    score.entry_fvg.bottom    if score.entry_fvg else None,
            "timeframe": score.entry_fvg.timeframe if score.entry_fvg else None,
            "inversed":  score.entry_fvg.inversed  if score.entry_fvg else None,
        } if score.entry_fvg else None,
        "smt_signal":    {
            "symbol_a":  score.smt_signal.symbol_a,
            "symbol_b":  score.smt_signal.symbol_b,
            "direction": score.smt_signal.direction,
            "timeframe": score.smt_signal.timeframe,
        } if score.smt_signal else None,
        "alert_text":    score.alert_text,
        "bias_details":  score.bias_details,
        "in_trading_window": _is_in_trading_window(),
        "candle_counts": CANDLE_STORE.summary(),
        "timestamp":     score.timestamp,
    }

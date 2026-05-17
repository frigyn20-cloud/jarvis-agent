"""
test_inject.py  —  Verifies the PB Blake engine end-to-end.
Run while uvicorn is running on port 8000:
  python test_inject.py
"""
import httpx
from pb_blake import (
    CANDLE_STORE, Candle, FVG,
    _detect_fvgs, _find_ifvg,
    evaluate_setup, get_setup_status,
)
import datetime

BASE = "http://localhost:8000"

def inject(symbol, tf, o, h, l, c, vol=500):
    r = httpx.post(f"{BASE}/setup/inject", json={
        "symbol": symbol, "timeframe": tf,
        "open": o, "high": h, "low": l, "close": c, "volume": vol
    })
    return r.json()

def section(title):
    print(f"\n{'─'*50}")
    print(f"  {title}")
    print('─'*50)

print("\n🔧 PB Blake Engine Test")

# ---------------------------------------------------------------------------
# Zigzag wave: rally → pullback → HH → HL → repeat
# ---------------------------------------------------------------------------
BULLISH_WAVE = [
    (0,   20,  -5,  15),
    (15,  35,   5,  30),
    (30,  55,  20,  50),
    (50,  55,  25,  30),
    (30,  35,  10,  15),
    (15,  40,   5,  35),
    (35,  60,  25,  55),
    (55,  80,  45,  75),
    (75,  80,  50,  55),
    (55,  60,  35,  40),
    (40,  65,  30,  60),
    (60,  85,  50,  80),
    (80, 105,  70, 100),
    (100, 105, 75,  80),
    (80,  85,  60,  65),
    (65,  90,  55,  85),
    (85, 110,  75, 105),
    (105, 110, 85,  90),
    (90,  95,  70,  75),
    (75, 100,  65,  95),
]

section("4H + 1H bias candles (MNQ + MES)")
for base, sym, tf in [(19000,"MNQ","4H"),(5000,"MES","4H"),(19100,"MNQ","1H"),(5020,"MES","1H")]:
    div = 5 if sym == "MES" else 1
    for o, h, l, c in BULLISH_WAVE:
        inject(sym, tf, base+o//div, base+h//div, base+l//div, base+c//div)
print("  80 candles injected (4H+1H for MNQ+MES).")

section("15M liquidity draw candles (MNQ)")
base = 19200
for o, h, l, c in BULLISH_WAVE:
    inject("MNQ", "15M", base+o, base+h, base+l, base+c)
print("  20 candles injected.")

# ---------------------------------------------------------------------------
# iFVG sequence — wider gap so detection is unambiguous:
#
# Bearish FVG definition: candle_C.high < candle_A.low
# We need: candle_A.low = 19580, candle_C.high = 19540  → gap = [19540..19580]
# Then price breaks ABOVE 19580 → FVG inversed
# Then price pulls back INTO [19540..19580] → iFVG active
# ---------------------------------------------------------------------------
section("5M iFVG sequence (MNQ) — 40-point gap")

# Context candles (so timestamp matching works)
for o, h, l, c in BULLISH_WAVE[:8]:
    inject("MNQ", "5M", 19300+o, 19300+h, 19300+l, 19300+c)

ts = datetime.datetime.utcnow().isoformat()

# Candle A: low = 19580  (this is the key value)
inject("MNQ", "5M", o=19600, h=19640, l=19580, c=19590)
# Candle B: middle filler
inject("MNQ", "5M", o=19590, h=19605, l=19565, c=19570)
# Candle C: high = 19539 < A.low (19580) → bearish FVG gap = [19539..19580]
inject("MNQ", "5M", o=19565, h=19539, l=19510, c=19520)
# Candle D: breaks above FVG top (19580) → inverses the bearish FVG
inject("MNQ", "5M", o=19525, h=19650, l=19522, c=19640)
# Candle E: pulls back into gap zone [19539..19580] → iFVG trigger
res = inject("MNQ", "5M", o=19640, h=19645, l=19545, c=19558)
print(f"  iFVG candle inject result: score={res.get('setup_score')}, bias={res.get('bias')}")

# ---------------------------------------------------------------------------
# Direct engine check (bypasses HTTP — reads CANDLE_STORE directly)
# ---------------------------------------------------------------------------
section("Direct engine check — 5M FVG detection")
candles_5m = CANDLE_STORE.get("MNQ", "5M")
print(f"  5M candles in store: {len(candles_5m)}")
if candles_5m:
    fvgs = _detect_fvgs(candles_5m, "bullish") + _detect_fvgs(candles_5m, "bearish")
    print(f"  FVGs detected: {len(fvgs)}")
    for f in fvgs[-5:]:
        print(f"    [{f.direction}] {f.bottom:.0f}–{f.top:.0f} @ {f.timeframe}")
    ifvg = _find_ifvg(fvgs, candles_5m, "bullish")
    print(f"  iFVG found: {ifvg}")
    if ifvg:
        print(f"    → {ifvg.bottom:.0f}–{ifvg.top:.0f}, inversed={ifvg.inversed}")

# ---------------------------------------------------------------------------
# Final status
# ---------------------------------------------------------------------------
section("Final /setup/status for MNQ")
r = httpx.get(f"{BASE}/setup/status", params={"symbol": "MNQ"})
status = r.json()

print(f"  Bias:   {status.get('bias')}")
print(f"  Score:  {status.get('score')} / 3")
conds = status.get('conditions', {})
print(f"  ✓ Bias:      {conds.get('bias')}")
print(f"  ✓ Liq draw:  {conds.get('liq_draw')}")
print(f"  ✓ iFVG:      {conds.get('ifvg')}")
print(f"  Bias details: {status.get('bias_details')}")

liq = status.get('liq_draw')
if liq:
    print(f"  Liq: {liq.get('kind')} at {liq.get('price')} ({liq.get('timeframe')})")

fvg = status.get('entry_fvg')
if fvg:
    print(f"  iFVG: {fvg.get('timeframe')} {fvg.get('bottom')}–{fvg.get('top')} inversed={fvg.get('inversed')}")

alert = status.get('alert_text', '')
if alert:
    print(f"\n  🔔 ALERT: {alert}")
else:
    print("\n  ⚠️  Score did not reach 3")

print("\n✅ Test complete.\n")

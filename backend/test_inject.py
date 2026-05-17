"""
test_inject.py  —  Verifies the PB Blake engine end-to-end.

Run while uvicorn is running on port 8000:
  python test_inject.py
"""
import httpx

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
print("Injecting zigzag bullish structure (HH+HL)...")

# ---------------------------------------------------------------------------
# Zigzag candle sequence that produces clear swing highs and swing lows.
# Pattern: rally → pullback → higher rally → higher pullback → higher rally
# This creates: HH1, HL1, HH2, HL2 — unmistakable bullish structure.
# Lookback=2 means we need at least 5 candles around each pivot.
# We inject 20 candles per timeframe in a wave pattern.
# ---------------------------------------------------------------------------

# Wave pattern: prices go up/down in a zigzag around a rising baseline
# Each "wave" = 5 candles: 2 up, 1 peak (swing high), 2 down to a higher low
BULLISH_WAVE = [
    # (open_offset, high_offset, low_offset, close_offset)  — relative to base
    # Wave 1 up
    (0,   20,  -5,  15),
    (15,  35,   5,  30),
    (30,  55,  20,  50),   # <-- swing high candidate
    (50,  55,  25,  30),
    (30,  35,  10,  15),   # <-- swing low candidate
    # Wave 2 up (higher)
    (15,  40,   5,  35),
    (35,  60,  25,  55),
    (55,  80,  45,  75),   # <-- higher swing high
    (75,  80,  50,  55),
    (55,  60,  35,  40),   # <-- higher swing low
    # Wave 3 up (even higher)
    (40,  65,  30,  60),
    (60,  85,  50,  80),
    (80, 105,  70, 100),   # <-- even higher swing high
    (100, 105, 75,  80),
    (80,  85,  60,  65),   # <-- even higher swing low
    # Wave 4 continuation
    (65,  90,  55,  85),
    (85, 110,  75, 105),
    (105, 110, 85,  90),
    (90,  95,  70,  75),
    (75, 100,  65,  95),   # recovery
]

section("4H candles — MNQ (HH+HL zigzag bullish)")
base = 19000
for o, h, l, c in BULLISH_WAVE:
    inject("MNQ", "4H", base+o, base+h, base+l, base+c)
print("  20 candles injected.")

section("4H candles — MES (correlated, for SMT)")
base = 5000
for o, h, l, c in BULLISH_WAVE:
    inject("MES", "4H", base + o//5, base + h//5, base + l//5, base + c//5)
print("  20 candles injected.")

section("1H candles — MNQ (same zigzag)")
base = 19100
for o, h, l, c in BULLISH_WAVE:
    inject("MNQ", "1H", base+o, base+h, base+l, base+c)
print("  20 candles injected.")

section("1H candles — MES")
base = 5020
for o, h, l, c in BULLISH_WAVE:
    inject("MES", "1H", base + o//5, base + h//5, base + l//5, base + c//5)
print("  20 candles injected.")

section("15M candles — MNQ (swing high above for liquidity draw)")
base = 19200
for o, h, l, c in BULLISH_WAVE:
    inject("MNQ", "15M", base+o, base+h, base+l, base+c)
print("  20 candles injected.")

# ---------------------------------------------------------------------------
# 5M: bearish FVG → inversed → iFVG retest
# Candle A high=19610, Candle C high < A.low → bearish gap
# Then price breaks above → inversed → pulls back into gap
# ---------------------------------------------------------------------------
section("5M candles — MNQ (iFVG sequence)")

# Build up some context candles first
for o, h, l, c in BULLISH_WAVE[:10]:
    inject("MNQ", "5M", 19300+o, 19300+h, 19300+l, 19300+c)

# Now the FVG sequence:
# Candle A
inject("MNQ", "5M", o=19600, h=19620, l=19585, c=19590)
# Candle B (middle)
inject("MNQ", "5M", o=19590, h=19600, l=19575, c=19580)
# Candle C: high (19579) < A.low (19585) → bearish FVG gap [19579..19585]
inject("MNQ", "5M", o=19572, h=19579, l=19555, c=19560)
# Candle D: breaks ABOVE gap top (19585) → inverses the bearish FVG
inject("MNQ", "5M", o=19565, h=19630, l=19563, c=19620)
# Candle E: pulls back INTO gap zone [19579..19585] → iFVG active
res = inject("MNQ", "5M", o=19620, h=19625, l=19578, c=19582)
print(f"  iFVG candle result: score={res.get('setup_score')}, bias={res.get('bias')}")

# ---------------------------------------------------------------------------
# Final status
# ---------------------------------------------------------------------------
section("Final /setup/status for MNQ")
r = httpx.get(f"{BASE}/setup/status", params={"symbol": "MNQ"})
status = r.json()

print(f"  Bias:   {status.get('bias')}")
print(f"  Score:  {status.get('score')} / 3")
conds = status.get('conditions', {})
print(f"  ✓ Bias confirmed:  {conds.get('bias')}")
print(f"  ✓ Liquidity draw:  {conds.get('liq_draw')}")
print(f"  ✓ iFVG entry:      {conds.get('ifvg')}")
print(f"  Bias details: {status.get('bias_details')}")

liq = status.get('liq_draw')
if liq:
    print(f"  Liq draw: {liq.get('kind')} at {liq.get('price')} ({liq.get('timeframe')})")

fvg = status.get('entry_fvg')
if fvg:
    print(f"  iFVG: {fvg.get('timeframe')} {fvg.get('bottom')} – {fvg.get('top')} (inversed={fvg.get('inversed')})")

smt = status.get('smt_signal')
if smt:
    print(f"  SMT: {smt.get('direction')} divergence ({smt.get('symbol_a')} vs {smt.get('symbol_b')})")

alert = status.get('alert_text', '')
if alert:
    print(f"\n  🔔 ALERT: {alert}")
else:
    print("\n  ⚠️  Score did not reach 3 — check bias_details above")

section("Alert queue (/setup/alerts)")
alerts = httpx.get(f"{BASE}/setup/alerts").json().get("alerts", [])
if alerts:
    for a in alerts:
        print(f"  [{a['symbol']}] score={a['score']} bias={a['bias']}")
        print(f"  {a['alert_text']}")
else:
    print("  Queue empty")

print("\n✅ Test complete.\n")

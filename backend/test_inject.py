"""
test_inject.py  —  Verifies the PB Blake engine end-to-end.

Run while uvicorn is running on port 8000:
  python test_inject.py

Builds a synthetic bullish MNQ + MES setup:
  - 4H and 1H: HH+HL structure
  - 15M: swing high above price (liquidity draw)
  - 5M: bearish FVG that gets inversed (iFVG entry zone)
Expects score == 3 and a spoken alert_text.
"""
import httpx
import time

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
print("Injecting synthetic bullish MNQ + MES setup...")

# ── 4H candles: ascending HH + HL structure ─────────────────────────────────
section("4H candles — MNQ (HH+HL bullish structure)")
base = 19000
for i in range(12):
    step = i * 60
    res = inject("MNQ", "4H",
        o=base + step,
        h=base + step + 40,
        l=base + step - 20,
        c=base + step + 30)
print(f"  Last inject result: score={res.get('setup_score')}, bias={res.get('bias')}")

section("4H candles — MES (for SMT)")
base_mes = 5000
for i in range(12):
    step = i * 15
    inject("MES", "4H",
        o=base_mes + step,
        h=base_mes + step + 10,
        l=base_mes + step - 5,
        c=base_mes + step + 8)
print("  Done.")

# ── 1H candles: same bullish structure ──────────────────────────────────────
section("1H candles — MNQ")
base = 19200
for i in range(12):
    step = i * 25
    inject("MNQ", "1H",
        o=base + step,
        h=base + step + 18,
        l=base + step - 8,
        c=base + step + 14)
print("  Done.")

section("1H candles — MES")
base_mes = 5050
for i in range(12):
    step = i * 7
    inject("MES", "1H",
        o=base_mes + step,
        h=base_mes + step + 5,
        l=base_mes + step - 2,
        c=base_mes + step + 4)
print("  Done.")

# ── 15M candles: swing high above current price (liquidity draw) ─────────────
section("15M candles — MNQ (liquidity draw above)")
bases = [19500, 19480, 19510, 19530, 19520, 19560, 19540, 19580]
for b in bases:
    inject("MNQ", "15M", o=b, h=b+25, l=b-10, c=b+18)
print("  Done.")

# ── 5M candles: bearish FVG → inversed → iFVG retest ────────────────────────
section("5M candles — MNQ (bearish FVG that gets inversed)")

# Candle A: high=19610
inject("MNQ", "5M", o=19600, h=19610, l=19585, c=19590)
# Candle B: middle
inject("MNQ", "5M", o=19590, h=19598, l=19575, c=19580)
# Candle C: high < A.low (= 19585) → creates bearish FVG gap [19580 .. 19585]
inject("MNQ", "5M", o=19572, h=19579, l=19560, c=19565)
# Candle D: breaks ABOVE gap top (19585) — inverses the bearish FVG
inject("MNQ", "5M", o=19570, h=19620, l=19568, c=19612)
# Candle E: pulls back INTO the gap zone → iFVG active
res = inject("MNQ", "5M", o=19612, h=19615, l=19578, c=19582)
print(f"  Last inject: score={res.get('setup_score')}, bias={res.get('bias')}")

# ── Final status check ───────────────────────────────────────────────────────
section("Final /setup/status for MNQ")
r = httpx.get(f"{BASE}/setup/status", params={"symbol": "MNQ"})
status = r.json()

print(f"  Bias:   {status.get('bias')}")
print(f"  Score:  {status.get('score')} / 3")
conds = status.get('conditions', {})
print(f"  ✓ Bias confirmed:  {conds.get('bias')}")
print(f"  ✓ Liquidity draw:  {conds.get('liq_draw')}")
print(f"  ✓ iFVG entry:      {conds.get('ifvg')}")

liq = status.get('liq_draw')
if liq:
    print(f"  Liq draw: {liq.get('kind')} at {liq.get('price')} ({liq.get('timeframe')})")

fvg = status.get('entry_fvg')
if fvg:
    print(f"  iFVG: {fvg.get('timeframe')} {fvg.get('bottom')} – {fvg.get('top')}")

smt = status.get('smt_signal')
if smt:
    print(f"  SMT: {smt.get('direction')} divergence ({smt.get('symbol_a')} vs {smt.get('symbol_b')})")

alert = status.get('alert_text', '')
if alert:
    print(f"\n  🔔 ALERT: {alert}")
else:
    print("\n  ⚠️  No alert text — score did not reach 3")
    print("  Check bias_details below:")
    print(f"  {status.get('bias_details')}")

# ── Alert queue ──────────────────────────────────────────────────────────────
section("Alert queue (/setup/alerts)")
alerts = httpx.get(f"{BASE}/setup/alerts").json().get("alerts", [])
if alerts:
    for a in alerts:
        print(f"  [{a['symbol']}] score={a['score']} bias={a['bias']}")
        print(f"  {a['alert_text']}")
else:
    print("  Queue empty (alert may have already been consumed or score < 3)")

print("\n✅ Test complete.\n")

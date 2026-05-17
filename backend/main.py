import os
import base64
from fastapi import FastAPI, UploadFile, File, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from typing import Optional, Any
from dotenv import load_dotenv
from agent import run_agent
from trading_state import get_session, reset_session, TradingSessionState
from voice import text_to_speech, speech_to_text
from market_data import get_market_snapshot
import datetime

load_dotenv()

app = FastAPI(title="Alpha Trading Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:3000"), "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── In-memory store for TradingView webhook prices ──────────────────────────────────
# TradingView pushes here; /market/live merges these with yfinance fallback.
_tv_prices: dict[str, dict] = {}


class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []
    image_base64: Optional[str] = None


class TTSRequest(BaseModel):
    text: str


@app.get("/health")
def health():
    return {"status": "ok", "service": "alpha-trading-assistant"}


@app.post("/chat")
async def chat(req: ChatRequest):
    result = await run_agent(req.message, req.history, image_base64=req.image_base64)
    return result


# ─── TradingView Webhook ───────────────────────────────────────────────────────────

@app.post("/market/webhook")
async def market_webhook(request: Request):
    """
    Receives price alerts from TradingView.

    TradingView Alert Message format (set this in the alert's Message box):
    {
      "symbol": "{{ticker}}",
      "price": {{close}},
      "open": {{open}},
      "high": {{high}},
      "low": {{low}},
      "volume": {{volume}},
      "time": "{{time}}"
    }

    Webhook URL to put in TradingView:  http://YOUR_IP:8000/market/webhook
    (Use ngrok or similar if testing locally without a public IP)
    """
    try:
        body: Any = await request.json()
    except Exception:
        # TradingView sometimes sends plain text — try to parse price from string
        text = (await request.body()).decode("utf-8", errors="ignore")
        return {"status": "error", "detail": f"Could not parse JSON: {text[:200]}"}

    sym = str(body.get("symbol", "")).upper().strip()
    if not sym:
        return {"status": "error", "detail": "Missing 'symbol' field"}

    price = body.get("price") or body.get("close")
    if price is None:
        return {"status": "error", "detail": "Missing 'price' or 'close' field"}

    try:
        price = float(price)
    except (TypeError, ValueError):
        return {"status": "error", "detail": f"Invalid price value: {price}"}

    prev = _tv_prices.get(sym, {}).get("price")
    change = round(price - prev, 2) if prev is not None else None
    change_pct = round((change / prev) * 100, 2) if (prev and change is not None) else None

    _tv_prices[sym] = {
        "symbol":     sym,
        "price":      round(price, 2),
        "change":     change,
        "change_pct": change_pct,
        "high":       body.get("high"),
        "low":        body.get("low"),
        "open":       body.get("open"),
        "volume":     body.get("volume"),
        "source":     "tradingview",
        "timestamp":  body.get("time") or datetime.datetime.utcnow().isoformat(),
    }

    return {"status": "ok", "symbol": sym, "price": price}


@app.get("/market/webhook/prices")
def get_webhook_prices():
    """Returns all prices currently stored from TradingView webhooks."""
    return _tv_prices


# ─── Market live endpoint ─────────────────────────────────────────────────────────

@app.get("/market/live")
async def market_live():
    """
    Returns live quotes for MNQ, MES, VIX.
    Priority: TradingView webhook (real-time, your paid data)
              > yfinance fallback (15-min delayed)
    Frontend polls every 30s.
    """
    snapshot = await get_market_snapshot()
    # Overlay webhook prices — these are your real-time paid data from TradingView
    for sym, tv_data in _tv_prices.items():
        snapshot[sym] = tv_data
    return snapshot


# ─── Voice endpoints ───────────────────────────────────────────────────────────

@app.post("/voice/tts")
async def tts(req: TTSRequest):
    audio_bytes = await text_to_speech(req.text)
    return Response(content=audio_bytes, media_type="audio/mpeg")


@app.post("/voice/stt")
async def stt(audio: UploadFile = File(...)):
    text = await speech_to_text(audio)
    return {"text": text}


# ─── Session State endpoints ───────────────────────────────────────────────────

@app.get("/session", response_model=TradingSessionState)
def get_session_state():
    return get_session()


@app.post("/session/reset")
def reset_session_state(symbol: str = "MNQ"):
    session = reset_session(symbol)
    return {"status": "reset", "symbol": session.symbol, "date": session.session_date}


@app.patch("/session")
def update_session(updates: dict):
    session = get_session()
    for key, value in updates.items():
        if hasattr(session, key):
            setattr(session, key, value)
    session.last_updated = datetime.datetime.now().strftime("%H:%M:%S")
    return session


@app.post("/session/note")
def add_session_note(note: str):
    session = get_session()
    session.add_note(note)
    return {"status": "added", "notes": session.session_notes}

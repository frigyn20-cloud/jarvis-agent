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
from pb_blake import (
    CANDLE_STORE, Candle,
    evaluate_setup, get_setup_status,
    push_alert_if_new, get_pending_alerts,
)
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

# ─── In-memory TradingView webhook prices ────────────────────────────────────
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


# ─── TradingView Webhook ──────────────────────────────────────────────────────
@app.post("/market/webhook")
async def market_webhook(request: Request):
    """
    Receives OHLCV candle closes from TradingView.
    TradingView alert Message format:
    {
      "symbol": "{{ticker}}",
      "timeframe": "{{interval}}",
      "price": {{close}},
      "open": {{open}},
      "high": {{high}},
      "low": {{low}},
      "volume": {{volume}},
      "time": "{{time}}"
    }
    """
    try:
        body: Any = await request.json()
    except Exception:
        text = (await request.body()).decode("utf-8", errors="ignore")
        return {"status": "error", "detail": f"Could not parse JSON: {text[:200]}"}

    sym = str(body.get("symbol", "")).upper().strip()
    if not sym:
        return {"status": "error", "detail": "Missing 'symbol' field"}

    price = body.get("price") or body.get("close")
    if price is None:
        return {"status": "error", "detail": "Missing price"}

    try:
        price = float(price)
    except (TypeError, ValueError):
        return {"status": "error", "detail": f"Invalid price: {price}"}

    # ── Update live price store ──
    prev = _tv_prices.get(sym, {}).get("price")
    change     = round(price - prev, 2) if prev is not None else None
    change_pct = round((change / prev) * 100, 2) if (prev and change is not None) else None
    ts = body.get("time") or datetime.datetime.utcnow().isoformat()

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
        "timestamp":  ts,
    }

    # ── Feed candle into PB Blake detector ──
    timeframe = str(body.get("timeframe") or body.get("tf") or "").upper().strip()
    if timeframe and body.get("open") is not None:
        try:
            candle = Candle(
                symbol=sym,
                timeframe=timeframe,
                open=float(body["open"]),
                high=float(body["high"]),
                low=float(body["low"]),
                close=price,
                volume=float(body.get("volume") or 0),
                timestamp=ts,
            )
            CANDLE_STORE.push(candle)

            # Run detector and push alert if setup is complete
            setup_score = evaluate_setup(sym)
            alerted     = push_alert_if_new(setup_score)

        except Exception as e:
            pass  # never let detector crash the webhook

    return {"status": "ok", "symbol": sym, "price": price}


@app.get("/market/webhook/prices")
def get_webhook_prices():
    return _tv_prices


# ─── Market live endpoint ─────────────────────────────────────────────────────
@app.get("/market/live")
async def market_live():
    snapshot = await get_market_snapshot()
    for sym, tv_data in _tv_prices.items():
        snapshot[sym] = tv_data
    return snapshot


# ─── PB Blake Setup endpoints ────────────────────────────────────────────────

@app.get("/setup/status")
def setup_status(symbol: str = "MNQ"):
    """Full setup status for one symbol — all three conditions checked."""
    return get_setup_status(symbol)


@app.get("/setup/alerts")
def setup_alerts():
    """
    Returns pending spoken alerts (score==3 setups) and clears the queue.
    Frontend polls this every 15 seconds.
    """
    return {"alerts": get_pending_alerts()}


@app.get("/setup/candles")
def setup_candles():
    """Debug: how many candles are stored per (symbol, timeframe)."""
    return CANDLE_STORE.summary()


@app.post("/setup/inject")
async def inject_candle(request: Request):
    """
    Manual candle injection for testing.
    Body: {symbol, timeframe, open, high, low, close, volume, timestamp}
    """
    try:
        body: Any = await request.json()
        candle = Candle(
            symbol=str(body["symbol"]).upper(),
            timeframe=str(body["timeframe"]).upper(),
            open=float(body["open"]),
            high=float(body["high"]),
            low=float(body["low"]),
            close=float(body["close"]),
            volume=float(body.get("volume", 0)),
            timestamp=body.get("timestamp", datetime.datetime.utcnow().isoformat()),
        )
        CANDLE_STORE.push(candle)
        score = evaluate_setup(candle.symbol)
        return {
            "status":      "ok",
            "symbol":      candle.symbol,
            "timeframe":   candle.timeframe,
            "candle_count": len(CANDLE_STORE.get(candle.symbol, candle.timeframe)),
            "setup_score": score.score,
            "bias":        score.bias,
            "alert_text":  score.alert_text,
        }
    except Exception as e:
        return {"status": "error", "detail": str(e)}


# ─── Voice endpoints ─────────────────────────────────────────────────────────
@app.post("/voice/tts")
async def tts(req: TTSRequest):
    audio_bytes = await text_to_speech(req.text)
    return Response(content=audio_bytes, media_type="audio/mpeg")


@app.post("/voice/stt")
async def stt(audio: UploadFile = File(...)):
    text = await speech_to_text(audio)
    return {"text": text}


# ─── Session State endpoints ──────────────────────────────────────────────────
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

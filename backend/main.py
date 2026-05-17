import os
import base64
from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from typing import Optional
from dotenv import load_dotenv
from agent import run_agent
from trading_state import get_session, reset_session, TradingSessionState
from voice import text_to_speech, speech_to_text
from market_data import get_market_snapshot

load_dotenv()

app = FastAPI(title="Alpha Trading Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:3000"), "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


# ─── Market data endpoint ──────────────────────────────────────────────────────

@app.get("/market/live")
async def market_live():
    """
    Returns live quotes for MNQ, MES, VIX.
    Frontend polls this every 30 seconds to update the header tickers.
    """
    snapshot = await get_market_snapshot()
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
    session.last_updated = __import__('datetime').datetime.now().strftime("%H:%M:%S")
    return session


@app.post("/session/note")
def add_session_note(note: str):
    session = get_session()
    session.add_note(note)
    return {"status": "added", "notes": session.session_notes}

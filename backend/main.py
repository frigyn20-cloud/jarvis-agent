import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from agent import run_agent
from trading_state import get_session, reset_session, TradingSessionState

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


@app.get("/health")
def health():
    return {"status": "ok", "service": "alpha-trading-assistant"}


@app.post("/chat")
async def chat(req: ChatRequest):
    result = await run_agent(req.message, req.history)
    return result


# ─── Session State endpoints ──────────────────────────────────────────────────

@app.get("/session", response_model=TradingSessionState)
def get_session_state():
    """Get the current trading session state."""
    return get_session()


@app.post("/session/reset")
def reset_session_state(symbol: str = "MNQ"):
    """Reset session for a new trading day."""
    session = reset_session(symbol)
    return {"status": "reset", "symbol": session.symbol, "date": session.session_date}


@app.patch("/session")
def update_session(updates: dict):
    """Partially update session state fields."""
    session = get_session()
    for key, value in updates.items():
        if hasattr(session, key):
            setattr(session, key, value)
    session.last_updated = __import__('datetime').datetime.now().strftime("%H:%M:%S")
    return session


@app.post("/session/note")
def add_session_note(note: str):
    """Add a timestamped note to the session."""
    session = get_session()
    session.add_note(note)
    return {"status": "added", "notes": session.session_notes}

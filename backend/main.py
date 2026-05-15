from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os
from agent import run_agent
from memory import get_all_memories, save_memory, delete_memory

load_dotenv()

app = FastAPI(title="Jarvis Agent API")

# CORS — allow your Next.js frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:3000")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []  # [{"role": "user"|"assistant", "content": "..."}]


class MemoryRequest(BaseModel):
    key: str
    value: str


# ─── Health check ────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "model": os.getenv("OLLAMA_MODEL", "llama3")}


# ─── Main chat endpoint ───────────────────────────────────────────────────────

@app.post("/chat")
async def chat(req: ChatRequest):
    """
    Send a message to Jarvis. The agent decides whether to answer
    directly or use a tool (calculator, summarizer, memory, etc.).
    """
    try:
        result = await run_agent(req.message, req.history)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Memory endpoints ─────────────────────────────────────────────────────────

@app.get("/memory")
async def list_memory():
    return {"memories": get_all_memories()}


@app.post("/memory")
async def add_memory(req: MemoryRequest):
    save_memory(req.key, req.value)
    return {"status": "saved", "key": req.key}


@app.delete("/memory/{key}")
async def remove_memory(key: str):
    delete_memory(key)
    return {"status": "deleted", "key": key}

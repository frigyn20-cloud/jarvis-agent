# 🤖 Jarvis Agent

A free, local-first AI personal assistant inspired by Jarvis. Built with:

- **Brain**: [Ollama](https://ollama.com) — run local LLMs for free
- **Agent Logic**: [LangGraph](https://github.com/langchain-ai/langgraph) — stateful, tool-using agent
- **Backend**: Python FastAPI
- **Frontend**: Next.js + TypeScript chat UI
- **Voice (optional)**: Whisper STT + XTTS-v2 TTS
- **Memory**: SQLite

---

## 📁 Project Structure

```
jarvis-agent/
├── backend/          ← Python FastAPI + LangGraph agent
│   ├── main.py
│   ├── agent.py
│   ├── tools.py
│   ├── memory.py
│   ├── requirements.txt
│   └── .env.example
├── frontend/         ← Next.js TypeScript chat UI
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx
│   │   │   ├── layout.tsx
│   │   │   └── globals.css
│   │   └── components/
│   │       ├── ChatWindow.tsx
│   │       ├── MessageBubble.tsx
│   │       └── ToolBadge.tsx
│   ├── package.json
│   ├── tsconfig.json
│   └── next.config.ts
└── README.md
```

---

## 🚀 Quick Start

### Step 1 — Install Ollama

1. Go to [https://ollama.com](https://ollama.com) and download Ollama for your OS.
2. Open Terminal and pull a model:

```bash
ollama pull llama3
```

3. Start Ollama:

```bash
ollama serve
```

Ollama will run at `http://localhost:11434`.

---

### Step 2 — Set up the Backend

```bash
cd backend
python -m venv venv

# Windows:
venv\Scripts\activate
# Mac/Linux:
source venv/bin/activate

pip install -r requirements.txt

# Copy environment file
cp .env.example .env

# Start backend
uvicorn main:app --reload --port 8000
```

Backend will run at `http://localhost:8000`.

---

### Step 3 — Set up the Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend will open at `http://localhost:3000`.

---

## 🛠 Built-in Tools

| Tool | What it does |
|---|---|
| `calculator` | Evaluate math expressions |
| `summarizer` | Summarize any text you paste |
| `remember` | Save a fact to long-term memory |
| `recall` | Search your saved memory |
| `open_url` | Open a URL in the default browser |
| `get_time` | Return current date and time |

---

## 🗣 Voice (Optional — Phase 2)

Coming next:
- Whisper-style STT for speech input
- XTTS-v2 for speech output
- Push-to-talk button in the UI

---

## 🔒 Safety Rules

- Read-only tools run automatically
- Write/action tools ask for confirmation first
- All tool calls are logged in the UI
- Memory writes are always visible

---

## 📖 Tech Stack

| Layer | Tech |
|---|---|
| Local LLM runner | Ollama |
| Agent framework | LangGraph |
| Backend | Python 3.11 + FastAPI |
| Frontend | Next.js 14 + TypeScript |
| Memory | SQLite |
| Optional voice STT | Whisper (local) |
| Optional voice TTS | XTTS-v2 (Coqui) |

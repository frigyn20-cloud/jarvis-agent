# 🤖 Jarvis Agent

A free, local-first AI personal assistant inspired by Jarvis.

> **No Ollama or local GPU needed.** Uses the **Groq free API** — fastest free LLM inference available.

**Stack:**
- **Brain**: [Groq](https://console.groq.com) — free cloud LLM API, runs Llama 3 70B for free
- **Agent Logic**: [LangGraph](https://github.com/langchain-ai/langgraph) — stateful, tool-using agent
- **Backend**: Python FastAPI
- **Frontend**: Next.js + TypeScript chat UI
- **Memory**: SQLite (saved on your computer)

---

## 📁 Project Structure

```
jarvis-agent/
├── backend/
│   ├── main.py          ← FastAPI server
│   ├── agent.py         ← LangGraph agent (uses Groq)
│   ├── tools.py         ← calculator, timer, summarizer, memory, open_url
│   ├── memory.py        ← SQLite long-term memory
│   ├── requirements.txt
│   └── .env.example     ← copy this to .env and add your Groq key
└── frontend/
    └── src/
        ├── app/page.tsx        ← main chat UI
        └── components/
            ├── ChatWindow.tsx
            ├── MessageBubble.tsx
            └── ToolBadge.tsx
```

---

## 🚀 Quick Start

### Step 1 — Get a FREE Groq API Key

1. Go to **[console.groq.com](https://console.groq.com)**
2. Sign up (free, no credit card needed)
3. Click **API Keys** → **Create API Key**
4. Copy the key — it starts with `gsk_...`

---

### Step 2 — Clone the repo

```bash
git clone https://github.com/frigyn20-cloud/jarvis-agent.git
cd jarvis-agent
```

---

### Step 3 — Set up the Backend

```bash
cd backend
python -m venv venv

# Windows:
venv\Scripts\activate
# Mac/Linux:
source venv/bin/activate

pip install -r requirements.txt
```

Now create your `.env` file:

```bash
# Windows:
copy .env.example .env

# Mac/Linux:
cp .env.example .env
```

Open `backend/.env` in any text editor and replace `your_groq_api_key_here` with your real key:

```
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx
```

Start the backend:

```bash
uvicorn main:app --reload --port 8000
```

You should see: `Uvicorn running on http://0.0.0.0:8000`

---

### Step 4 — Set up the Frontend

Open a **second terminal window**:

```bash
cd frontend
npm install
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)** — Jarvis is running! 🎉

---

## 🛠 Built-in Tools

| Tool | What Jarvis can do |
|---|---|
| 🧮 `calculator` | Math: `"what is 1500 * 1.08?"` |
| 🕐 `get_time` | `"What time is it?"` |
| 📄 `summarize_text` | `"Summarize this: [paste text]"` |
| 💾 `remember` | `"Remember: my project is OmniTool Studio"` |
| 🔍 `recall` | `"What do you know about my project?"` |
| 🌐 `open_url` | `"Open https://google.com"` (asks confirmation first) |

---

## 🔑 Free Groq Models Available

| Model | Best for |
|---|---|
| `llama3-70b-8192` | Best quality (default) |
| `llama3-8b-8192` | Faster responses |
| `mixtral-8x7b-32768` | Long documents / large context |

Change the model anytime in `backend/.env` — no code changes needed.

---

## 🔒 Safety Rules

- Read-only tools run automatically
- `open_url` always asks for confirmation first
- All tool calls are shown as badges in the chat UI
- Memory is stored locally on your computer only
- Your API key is never sent to the frontend

---

## 🗣 Voice (Coming Next)

Phase 2 will add:
- Push-to-talk button
- Speech-to-text (Whisper)
- Text-to-speech (XTTS-v2)

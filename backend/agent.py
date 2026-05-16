import os
import logging
from dotenv import load_dotenv
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from typing import TypedDict, Annotated
import operator
from tools import ALL_TOOLS, CONFIRM_REQUIRED_TOOLS

load_dotenv()
logger = logging.getLogger(__name__)

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
GROQ_API_KEY      = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL        = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
CLAUDE_MODEL      = os.getenv("CLAUDE_MODEL", "claude-haiku-4-5")

# ─── Keywords that require Claude + full tools ───────────────────────────
CLAUDE_TRIGGERS = [
    "mnq", "mes", "nq", "es", "nasdaq", "s&p", "sp500", "spx", "ndx",
    "futures", "contract", "ticker",
    "analysis", "analyze", "analyse", "technical", "technicals",
    "setup", "trade", "entry", "exit", "target", "stop",
    "support", "resistance", "level", "levels",
    "trend", "bias", "breakout", "breakdown",
    "vwap", "rsi", "macd", "ema", "sma", "moving average",
    "volume", "momentum", "divergence",
    "price", "market", "chart", "candle", "session",
    "pre-market", "premarket", "after hours",
    "bull", "bear", "rally", "selloff", "sell off", "dip",
    "risk", "reward", "r:r", "position size", "pnl", "p&l",
    "loss", "profit", "drawdown", "leverage",
    "fomc", "fed", "cpi", "nfp", "gdp", "pce", "earnings",
    "economic", "calendar", "catalyst",
    "current", "today", "now", "live", "latest",
    "news", "report", "summarize", "summary",
    "what is", "what's", "whats", "explain", "why",
]

# ─── System prompts ────────────────────────────────────────────────────
ANALYSIS_PROMPT = """
You are Alpha, an AI-powered trading assistant specialized in US equity index futures — MNQ (Micro Nasdaq-100) and MES (Micro E-mini S&P 500).

Personality: precise, confident, professional. Speak like a seasoned trader. Lead with data. Be concise.

Tools available: web_search, calculator, get_time, summarize_text, remember, recall, open_url.

Rules:
- ALWAYS use web_search for current prices, news, live data, economic releases.
- Use calculator for P&L, position sizing, R:R math.
- Structure level answers: Trend → Key Levels → Bias → What to watch.
- Never give financial advice. Present analysis only.
- Lead with data. Skip filler.
"""

CHAT_PROMPT = """
You are Alpha, a sharp and friendly AI trading assistant. Right now the user is just chatting — not asking for market analysis.

Respond naturally and conversationally. Be warm but concise. Do NOT volunteer market data, prices, or trading info unless the user specifically asks.

If greeted, greet back simply. If asked what you can do, give a brief friendly summary. Keep it human.
"""


def needs_claude(message: str) -> bool:
    msg_lower = message.lower()
    return any(kw in msg_lower for kw in CLAUDE_TRIGGERS)


def get_claude_llm():
    if not ANTHROPIC_API_KEY:
        raise ValueError("ANTHROPIC_API_KEY not set")
    from langchain_anthropic import ChatAnthropic
    return ChatAnthropic(
        api_key=ANTHROPIC_API_KEY,
        model=CLAUDE_MODEL,
        temperature=0.2,
        max_tokens=4096,
    )


def get_groq_llm():
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY not set")
    from langchain_groq import ChatGroq
    return ChatGroq(api_key=GROQ_API_KEY, model=GROQ_MODEL, temperature=0.3)


class AgentState(TypedDict):
    messages: Annotated[list, operator.add]
    tool_calls_made: list[str]
    pending_confirmation: dict | None
    used_fallback: bool
    routed_to: str


def agent_node(state: AgentState):
    messages_in = state["messages"]
    last_human = next(
        (m.content for m in reversed(messages_in) if isinstance(m, HumanMessage)), ""
    )
    use_claude = needs_claude(last_human)
    routed_to = "groq"
    used_fallback = False
    response = None

    if use_claude:
        # — Claude: full tools + analysis prompt —
        try:
            system = SystemMessage(content=ANALYSIS_PROMPT)
            llm = get_claude_llm().bind_tools(ALL_TOOLS)
            response = llm.invoke([system] + messages_in)
            routed_to = "claude"
            logger.info(f"[Alpha] CLAUDE → {CLAUDE_MODEL} | {last_human[:60]}")
        except Exception as e:
            logger.warning(f"[Alpha] Claude failed: {e} — falling back to Groq")
            used_fallback = True
            use_claude = False

    if not use_claude:
        # — Groq: NO tools, lightweight chat prompt = fast response —
        try:
            system = SystemMessage(content=CHAT_PROMPT)
            llm = get_groq_llm()          # no .bind_tools() — much faster
            response = llm.invoke([system] + messages_in)
            routed_to = "groq"
            logger.info(f"[Alpha] GROQ → {GROQ_MODEL} | {last_human[:60]}")
        except Exception as e:
            logger.warning(f"[Alpha] Groq failed: {e}")
            raise

    return {
        "messages": [response],
        "tool_calls_made": state.get("tool_calls_made", []),
        "pending_confirmation": None,
        "used_fallback": used_fallback,
        "routed_to": routed_to,
    }


def should_continue(state: AgentState):
    last = state["messages"][-1]
    if hasattr(last, "tool_calls") and last.tool_calls:
        for tc in last.tool_calls:
            if tc["name"] in CONFIRM_REQUIRED_TOOLS:
                return "needs_confirmation"
        return "tools"
    return END


def confirmation_node(state: AgentState):
    last = state["messages"][-1]
    if hasattr(last, "tool_calls") and last.tool_calls:
        ct = [tc for tc in last.tool_calls if tc["name"] in CONFIRM_REQUIRED_TOOLS]
        if ct:
            return {**state, "pending_confirmation": ct[0]}
    return state


def build_graph():
    tool_node = ToolNode(ALL_TOOLS)
    g = StateGraph(AgentState)
    g.add_node("agent", agent_node)
    g.add_node("tools", tool_node)
    g.add_node("needs_confirmation", confirmation_node)
    g.set_entry_point("agent")
    g.add_conditional_edges(
        "agent", should_continue,
        {"tools": "tools", "needs_confirmation": "needs_confirmation", END: END}
    )
    g.add_edge("tools", "agent")
    g.add_edge("needs_confirmation", END)
    return g.compile()


APP_GRAPH = build_graph()


async def run_agent(message: str, history: list[dict]) -> dict:
    lc_messages = []
    for msg in history[-10:]:
        if msg["role"] == "user":        lc_messages.append(HumanMessage(content=msg["content"]))
        elif msg["role"] == "assistant": lc_messages.append(AIMessage(content=msg["content"]))
    lc_messages.append(HumanMessage(content=message))

    result = await APP_GRAPH.ainvoke({
        "messages": lc_messages,
        "tool_calls_made": [],
        "pending_confirmation": None,
        "used_fallback": False,
        "routed_to": "groq",
    })

    final_messages = result["messages"]
    last_ai = next((m for m in reversed(final_messages) if isinstance(m, AIMessage)), None)
    reply = last_ai.content if last_ai else "No response."

    tool_calls_log = []
    for msg in final_messages:
        if hasattr(msg, "tool_calls") and msg.tool_calls:
            for tc in msg.tool_calls:
                tool_calls_log.append({"tool": tc["name"], "input": tc.get("args", {})})

    routed_to  = result.get("routed_to", "groq")
    model_label = CLAUDE_MODEL if routed_to == "claude" else f"groq"

    return {
        "reply": reply,
        "tool_calls": tool_calls_log,
        "pending_confirmation": result.get("pending_confirmation"),
        "model": model_label,
        "routed_to": routed_to,
    }

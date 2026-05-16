import os
import logging
from dotenv import load_dotenv
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from typing import TypedDict, Annotated, Optional
import operator
from tools import ALL_TOOLS, CONFIRM_REQUIRED_TOOLS
from trading_state import get_session
from memory import get_all_memories

load_dotenv()
logger = logging.getLogger(__name__)

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
GROQ_API_KEY      = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL        = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
CLAUDE_MODEL      = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")

# ── Load strategy from file (hot-reloaded on every request) ─────────────────
STRATEGY_FILE = os.path.join(os.path.dirname(__file__), "strategy.md")

def load_strategy() -> str:
    """Read strategy.md from disk. Returns empty string if file missing."""
    try:
        with open(STRATEGY_FILE, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        logger.warning("strategy.md not found — strategy context will be empty.")
        return ""

# ── Auto-load all memories into prompt ──────────────────────────────────────
def load_memory_context() -> str:
    """Fetch all saved memories and format them for injection into the prompt."""
    try:
        memories = get_all_memories()
        if not memories:
            return ""
        lines = ["== LONG-TERM MEMORY (facts you know about the user and their preferences) =="]
        for m in memories:
            lines.append(f"- {m['key']}: {m['value']}")
        return "\n".join(lines)
    except Exception as e:
        logger.warning(f"Could not load memories: {e}")
        return ""

# ─── Claude triggers ─────────────────────────────────────────────────────────
CLAUDE_TRIGGERS = [
    "mnq", "mes", "nq futures", "es futures",
    "nasdaq futures", "s&p futures", "sp500", "spx", "ndx",
    "micro nasdaq", "micro s&p", "e-mini",
    "trade setup", "trade plan", "entry zone", "exit zone",
    "long setup", "short setup", "going long", "going short",
    "buy stop", "sell stop", "buy limit", "sell limit",
    "stop loss", "take profit", "trailing stop",
    "position size", "position sizing", "risk reward", "r:r", "r/r",
    "p&l", "pnl", "unrealized", "drawdown", "max loss",
    "vwap", "rsi", "macd", "ema", "sma", "moving average",
    "bollinger", "stochastic", "atr", "ichimoku",
    "support level", "resistance level", "key level",
    "fvg", "ifvg", "fair value gap", "inverse fvg",
    "order block", "ob", "breaker block",
    "smt", "smt divergence", "smart money",
    "market structure", "higher high", "lower low", "higher low", "lower high",
    "hh", "hl", "lh", "ll",
    "liquidity", "liquidity grab", "liquidity sweep", "swing high", "swing low",
    "sweep", "swept",
    "breakout", "breakdown", "fakeout",
    "trend line", "trendline", "channel", "wedge", "flag pattern",
    "premium", "discount", "equilibrium",
    "pre-market", "premarket", "after hours", "afterhours",
    "rth", "eth", "globex", "overnight session",
    "market open", "market close", "power hour",
    "gap up", "gap down", "opening range",
    "fomc", "federal reserve", "fed meeting", "rate decision",
    "cpi report", "pce report", "nfp", "jobs report",
    "gdp report", "earnings report", "economic calendar",
    "futures price", "futures level", "live price",
    "market outlook", "market analysis", "technical analysis",
    "price action", "price level",
    "bias", "bullish bias", "bearish bias",
    "1h", "4h", "15m", "5m", "1m", "3m",
    "timeframe", "htf", "ltf",
    "news", "latest", "today", "right now", "current", "live",
    "what happened", "what's happening", "what is happening",
    "breaking", "update", "updates", "headline", "headlines",
    "political", "politics", "election", "president", "congress", "senate",
    "tariff", "tariffs", "trade war", "sanctions",
    "inflation", "interest rate", "rate hike", "rate cut",
    "recession", "gdp", "unemployment", "jobs",
    "stock market", "market today", "market news",
    "crypto", "bitcoin", "ethereum",
    "oil price", "gold price", "dollar", "dxy",
    "research", "data", "report", "study", "statistics",
    "search", "look up", "find out", "tell me about",
    "what is", "who is", "where is", "when is", "how much",
    "weather", "forecast",
    "look at my screen", "what do you see", "analyze my chart",
    "check the chart", "what's on my screen", "read the chart",
    "look at this", "can you see", "chart analysis",
    "remember", "recall", "do you know", "my name", "my account",
    "my risk", "my strategy", "my preference",
]

# ─── Base personality shared by all prompts ──────────────────────────────────
BASE_PERSONALITY = """
You are Alpha, an AI-powered trading assistant and general assistant.
Personality: calm, confident, professional — like a trusted British butler who is also a seasoned trader.
Always address the user as "sir".
Speak in natural, conversational sentences. Never use bullet points, tables, pipe characters, or markdown formatting.
Be concise. Two to four sentences for most answers. Do not pad responses.
When uncertain, say so plainly. Do not fabricate data or price levels.
Respond as if speaking aloud — your words will be read by a text-to-speech engine.
"""


def build_system_prompt(include_strategy: bool = True, include_tools: bool = True, session_context: str = "") -> str:
    """Assemble the full system prompt dynamically on every request."""
    parts = [BASE_PERSONALITY]

    # ── Long-term memory (always injected) ──
    memory_ctx = load_memory_context()
    if memory_ctx:
        parts.append(memory_ctx)

    # ── Trading strategy ──
    if include_strategy:
        strategy = load_strategy()
        if strategy:
            parts.append(strategy)

    # ── Session state ──
    if session_context:
        parts.append(session_context)

    # ── Tool guidance ──
    if include_tools:
        parts.append("""
TOOLS AVAILABLE: web_search, calculator, get_time, summarize_text, remember, recall, open_url.
- ALWAYS use web_search for current prices, news, live data, economic releases.
- Use calculator for P&L, position sizing, R:R math.
- Use remember to save any new fact the user tells you (name, risk preference, account size, etc.).
- Use recall to look up anything the user has told you before.
- When asked about a setup: walk through the ICT model steps in plain spoken language.
- Never give financial advice. Present analysis only.
""")

    # ── Vision note ──
    parts.append("""
VISION: When an image is provided, it is a screenshot of the user's trading screen (likely TradingView).
Analyze it using the ICT model from the strategy. Walk through structure, FVGs, iFVGs, bias.
Speak as if describing the chart aloud. Be specific about visible price levels.
""")

    return "\n\n".join(parts)


def needs_claude(message: str, has_image: bool = False) -> bool:
    if has_image:
        return True
    msg_lower = message.lower()
    return any(trigger in msg_lower for trigger in CLAUDE_TRIGGERS)


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


def build_human_message(text: str, image_base64: Optional[str] = None) -> HumanMessage:
    if not image_base64:
        return HumanMessage(content=text)
    return HumanMessage(content=[
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": image_base64,
            },
        },
        {"type": "text", "text": text},
    ])


class AgentState(TypedDict):
    messages: Annotated[list, operator.add]
    tool_calls_made: list[str]
    pending_confirmation: dict | None
    used_fallback: bool
    routed_to: str


def agent_node(state: AgentState):
    messages_in = state["messages"]

    # Detect last human message text + image
    last_human = ""
    has_image  = False
    last_msg   = next((m for m in reversed(messages_in) if isinstance(m, HumanMessage)), None)
    if last_msg:
        if isinstance(last_msg.content, str):
            last_human = last_msg.content
        elif isinstance(last_msg.content, list):
            has_image  = any(c.get("type") == "image" for c in last_msg.content if isinstance(c, dict))
            last_human = " ".join(c.get("text", "") for c in last_msg.content if isinstance(c, dict) and c.get("type") == "text")

    use_claude   = needs_claude(last_human, has_image)
    routed_to    = "groq"
    used_fallback = False
    response     = None

    # Session state
    session = get_session()
    session_context = f"== CURRENT SESSION STATE ==\n{session.checklist_summary()}"

    # Build the full dynamic system prompt (memories + strategy + session)
    system_prompt = build_system_prompt(
        include_strategy=True,
        include_tools=use_claude,  # only give tool guidance to Claude (Groq may not support tools)
        session_context=session_context,
    )

    if use_claude:
        try:
            system  = SystemMessage(content=system_prompt)
            llm     = get_claude_llm().bind_tools(ALL_TOOLS)
            response = llm.invoke([system] + messages_in)
            routed_to = "claude"
            logger.info(f"[Alpha] CLAUDE -> {CLAUDE_MODEL} | vision={has_image} | {last_human[:60]}")
        except Exception as e:
            logger.warning(f"[Alpha] Claude failed: {e} — falling back to Groq")
            used_fallback = True
            use_claude    = False

    if not use_claude:
        try:
            # Groq gets full prompt too (strategy + memories) but no tool definitions
            system = SystemMessage(content=build_system_prompt(
                include_strategy=True,
                include_tools=False,
                session_context=session_context,
            ))
            llm = get_groq_llm()
            # Strip images for Groq (vision not supported)
            text_only = []
            for m in messages_in:
                if isinstance(m, HumanMessage) and isinstance(m.content, list):
                    text = " ".join(c.get("text", "") for c in m.content if isinstance(c, dict) and c.get("type") == "text")
                    text_only.append(HumanMessage(content=text))
                else:
                    text_only.append(m)
            response  = llm.invoke([system] + text_only)
            routed_to = "groq"
            logger.info(f"[Alpha] GROQ -> {GROQ_MODEL} | {last_human[:60]}")
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


async def run_agent(message: str, history: list[dict], image_base64: Optional[str] = None) -> dict:
    lc_messages = []
    for msg in history[-12:]:  # keep a bit more history
        if msg["role"] == "user":        lc_messages.append(HumanMessage(content=msg["content"]))
        elif msg["role"] == "assistant": lc_messages.append(AIMessage(content=msg["content"]))

    lc_messages.append(build_human_message(message, image_base64))

    result = await APP_GRAPH.ainvoke({
        "messages": lc_messages,
        "tool_calls_made": [],
        "pending_confirmation": None,
        "used_fallback": False,
        "routed_to": "groq",
    })

    final_messages = result["messages"]
    last_ai = next((m for m in reversed(final_messages) if isinstance(m, AIMessage)), None)
    reply   = last_ai.content if last_ai else "No response."

    tool_calls_log = []
    for msg in final_messages:
        if hasattr(msg, "tool_calls") and msg.tool_calls:
            for tc in msg.tool_calls:
                tool_calls_log.append({"tool": tc["name"], "input": tc.get("args", {})})

    routed_to   = result.get("routed_to", "groq")
    model_label = CLAUDE_MODEL if routed_to == "claude" else "groq"

    return {
        "reply":                reply,
        "tool_calls":           tool_calls_log,
        "pending_confirmation": result.get("pending_confirmation"),
        "model":                model_label,
        "routed_to":            routed_to,
    }

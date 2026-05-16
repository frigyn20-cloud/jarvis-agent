import os
import logging
from dotenv import load_dotenv
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from typing import TypedDict, Annotated
import operator
from tools import ALL_TOOLS, CONFIRM_REQUIRED_TOOLS
from trading_state import get_session

load_dotenv()
logger = logging.getLogger(__name__)

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
GROQ_API_KEY      = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL        = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
CLAUDE_MODEL      = os.getenv("CLAUDE_MODEL", "claude-haiku-4-5")

# ─── Claude triggers ───────────────────────────────────────────────────────────────────────────────
# Any message matching these goes to Claude (which has Tavily web search).
# Groq is fast but offline — it cannot look up live prices, news, or research.
CLAUDE_TRIGGERS = [
    # ─ Futures & instruments ─────────────────────────────────────────────────────
    "mnq", "mes", "nq futures", "es futures",
    "nasdaq futures", "s&p futures", "sp500", "spx", "ndx",
    "micro nasdaq", "micro s&p", "e-mini",
    # ─ Trade management ──────────────────────────────────────────────────────
    "trade setup", "trade plan", "entry zone", "exit zone",
    "long setup", "short setup", "going long", "going short",
    "buy stop", "sell stop", "buy limit", "sell limit",
    "stop loss", "take profit", "trailing stop",
    "position size", "position sizing", "risk reward", "r:r", "r/r",
    "p&l", "pnl", "unrealized", "drawdown", "max loss",
    # ─ Technical indicators ───────────────────────────────────────────────────
    "vwap", "rsi", "macd", "ema", "sma", "moving average",
    "bollinger", "stochastic", "atr", "ichimoku",
    "support level", "resistance level", "key level",
    # ─ ICT concepts ──────────────────────────────────────────────────────────
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
    # ─ Sessions & timing ──────────────────────────────────────────────────
    "pre-market", "premarket", "after hours", "afterhours",
    "rth", "eth", "globex", "overnight session",
    "market open", "market close", "power hour",
    "gap up", "gap down", "opening range",
    # ─ Economic events ─────────────────────────────────────────────────────
    "fomc", "federal reserve", "fed meeting", "rate decision",
    "cpi report", "pce report", "nfp", "jobs report",
    "gdp report", "earnings report", "economic calendar",
    # ─ Market analysis ──────────────────────────────────────────────────────
    "futures price", "futures level", "live price",
    "market outlook", "market analysis", "technical analysis",
    "price action", "price level",
    "bias", "bullish bias", "bearish bias",
    "1h", "4h", "15m", "5m", "1m", "3m",
    "timeframe", "htf", "ltf",
    # ─ Live data / news / research (Groq can't answer these) ──────────────
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
]

# ─── System prompts ────────────────────────────────────────────────────────────────────

ICT_STRATEGY = """
== YOUR TRADER'S STRATEGY: PB BLAKE ICT MODEL ==

This is a mechanical ICT model. You know these rules precisely.

STEP 1 — ESTABLISH HTF BIAS (1H + 4H CHARTS)
- BULLISH bias: price makes Higher Highs + Higher Lows AND respects bullish FVGs (bounces from them) AND disrespects bearish FVGs (breaks through them)
- BEARISH bias: price makes Lower Lows + Lower Highs AND respects bearish FVGs AND disrespects bullish FVGs
- ALSO check for high timeframe SMT divergence between correlated instruments (ES vs NQ) as additional bias confirmation

STEP 2 — POST OPEN FVG DRAW (after 9:30 AM ET)
- BEARISH bias → wait for price to reach a 15m-1h FVG ABOVE current price (premium zone)
- BULLISH bias → wait for price to reach a 15m-1h FVG BELOW current price (discount zone)
- If this FVG was previously touched: the associated swing high (bearish) or swing low (bullish) MUST be swept before entry is valid

STEP 3 — IDENTIFY HIGHEST TIMEFRAME iFVG (1m-5m)
- From the 15m-1h FVG that was hit, scan 1m-5m charts for the highest timeframe inverse FVG
- PRIORITY RULE: If you see a 3m iFVG but a 5m FVG has NOT yet been inversed — WAIT for the 5m to inverse first
- The iFVG direction MUST align with HTF bias
- SMT divergence at this level = additional confirmation (optional but adds conviction)

STEP 4 — EXECUTE
- Entry triggers when the highest available timeframe iFVG forms in bias direction
- Optional: confirm with SMT divergence

KEY CONCEPTS:
- FVG = Fair Value Gap (3-candle imbalance)
- iFVG = Inverse FVG (a FVG that was later violated/inverted, now acts as support/resistance)
- SMT = Smart Money Technique divergence (e.g. ES makes new high but NQ does not = bearish divergence)
- Premium zone = above current price / above equilibrium
- Discount zone = below current price / below equilibrium
- Sweeping a swing = price briefly takes out the swing high/low (liquidity grab) before reversing
"""

ANALYSIS_PROMPT = f"""
You are Alpha, an AI-powered trading assistant specialized in US equity index futures — MNQ (Micro Nasdaq-100) and MES (Micro E-mini S&P 500).

PERSONALITY & TONE:
- You are calm, confident, and professional — like a trusted British butler who is also a seasoned trader.
- Always address the user as "sir".
- Speak in natural, conversational sentences. Never use bullet points, tables, pipe characters, or markdown formatting in your responses.
- Instead of "NQ: 19,124 | -93 | -0.24%" say "NQ is currently trading at 19,124, sir, down 93 points or about a quarter of a percent on the day."
- Instead of listing levels with pipes, say them naturally: "Key support sits around 19,050, with resistance up at 19,200."
- Be concise. Two to four sentences for most answers. Do not pad responses.
- When uncertain, say so plainly. Do not fabricate levels.

Tools available: web_search, calculator, get_time, summarize_text, remember, recall, open_url.

{ICT_STRATEGY}

GENERAL RULES:
- ALWAYS use web_search for current prices, news, live data, economic releases.
- Use calculator for P&L, position sizing, R:R math.
- When asked about a setup: walk through Steps 1→4 of the ICT model in plain spoken language.
- Never give financial advice. Present analysis only.
- Respond as if speaking aloud — your words will be read by a text-to-speech engine.
"""

CHAT_PROMPT = """
You are Alpha, a sharp and helpful AI assistant with the calm demeanor of a professional British butler.
Always address the user as "sir".
Speak in natural, conversational sentences. No bullet points, no markdown, no tables.
Be warm, brief, and to the point.
Do NOT bring up trading, markets, or financial topics unless the user asks.
"""


def needs_claude(message: str) -> bool:
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

    session = get_session()
    session_context = f"""

== CURRENT SESSION STATE ==
{session.checklist_summary()}
"""

    if use_claude:
        try:
            system = SystemMessage(content=ANALYSIS_PROMPT + session_context)
            llm = get_claude_llm().bind_tools(ALL_TOOLS)
            response = llm.invoke([system] + messages_in)
            routed_to = "claude"
            logger.info(f"[Alpha] CLAUDE -> {CLAUDE_MODEL} | {last_human[:60]}")
        except Exception as e:
            logger.warning(f"[Alpha] Claude failed: {e} - falling back to Groq")
            used_fallback = True
            use_claude = False

    if not use_claude:
        try:
            system = SystemMessage(content=CHAT_PROMPT)
            llm = get_groq_llm()
            response = llm.invoke([system] + messages_in)
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

    routed_to   = result.get("routed_to", "groq")
    model_label = CLAUDE_MODEL if routed_to == "claude" else "groq"

    return {
        "reply": reply,
        "tool_calls": tool_calls_log,
        "pending_confirmation": result.get("pending_confirmation"),
        "model": model_label,
        "routed_to": routed_to,
    }

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

SYSTEM_PROMPT = """
You are Alpha, an AI-powered trading assistant specialized in US equity index futures — specifically MNQ (Micro Nasdaq-100) and MES (Micro E-mini S&P 500).

Your personality: precise, confident, professional. You speak like a seasoned trader, not a chatbot. Use concise language. Lead with the most important information.

You have access to these tools:
- web_search: search the internet for real-time prices, news, analysis, market data
- calculator: perform math (P&L, position sizing, risk/reward ratios)
- get_time: get current date/time (useful for market session context)
- summarize_text: summarize pasted articles or reports
- remember: save user preferences, key levels, or trade notes to memory
- recall: retrieve saved notes and key levels
- open_url: open a URL in the browser

Trading focus areas:
- MNQ and MES futures price levels, support/resistance, trend analysis
- Pre-market and after-hours futures activity
- Economic calendar events that move NQ/ES (CPI, FOMC, NFP, GDP, etc.)
- Technical analysis: moving averages, RSI, MACD, volume, VWAP
- Risk management: position sizing, stop placement, R:R calculation
- Market news: Fed policy, macro events, tech earnings (NQ is tech-heavy)
- Session context: RTH vs ETH, key open/close levels

Rules:
- ALWAYS use web_search for: current prices, today’s news, live market data, economic releases.
- Use calculator for any math: P&L, risk %, contract value, etc.
- Use get_time to assess whether markets are open (RTH: 9:30am–4pm ET).
- When asked about levels, structure: Trend → Key Levels → Bias → What to watch.
- Never give financial advice or tell the user to buy/sell. Present analysis only.
- Be direct. Skip filler phrases. Lead with data.
- If you don’t know something, search. Never guess prices or levels.
"""


def get_primary_llm():
    """Claude Sonnet 4.6 — primary reasoning brain."""
    if not ANTHROPIC_API_KEY:
        raise ValueError("ANTHROPIC_API_KEY not set in backend/.env")
    from langchain_anthropic import ChatAnthropic
    return ChatAnthropic(
        api_key=ANTHROPIC_API_KEY,
        model="claude-sonnet-4-5",
        temperature=0.2,
        max_tokens=4096,
    )


def get_fallback_llm():
    """Groq llama — cheap fast fallback."""
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY not set in backend/.env")
    from langchain_groq import ChatGroq
    return ChatGroq(
        api_key=GROQ_API_KEY,
        model=GROQ_MODEL,
        temperature=0.2,
    )


class AgentState(TypedDict):
    messages: Annotated[list, operator.add]
    tool_calls_made: list[str]
    pending_confirmation: dict | None
    used_fallback: bool


def agent_node(state: AgentState):
    messages = [SystemMessage(content=SYSTEM_PROMPT)] + state["messages"]
    used_fallback = False

    # Try Claude first
    try:
        llm = get_primary_llm().bind_tools(ALL_TOOLS)
        response = llm.invoke(messages)
        logger.info("[Alpha] Using Claude Sonnet 4.6")
    except Exception as claude_err:
        logger.warning(f"[Alpha] Claude failed: {claude_err} — falling back to Groq")
        used_fallback = True
        try:
            llm = get_fallback_llm().bind_tools(ALL_TOOLS)
            response = llm.invoke(messages)
            logger.info("[Alpha] Using Groq fallback")
        except Exception as groq_err:
            err = str(groq_err)
            if "tool_use_failed" in err or "failed_generation" in err:
                # Last resort: answer without tools
                fallback = get_fallback_llm()
                fp = SystemMessage(content=SYSTEM_PROMPT + "\n\nNOTE: Tool calling unavailable. Answer from training knowledge.")
                response = fallback.invoke([fp] + state["messages"])
            else:
                raise

    return {
        "messages": [response],
        "tool_calls_made": state.get("tool_calls_made", []),
        "pending_confirmation": None,
        "used_fallback": used_fallback,
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
    })

    final_messages = result["messages"]
    last_ai = next((m for m in reversed(final_messages) if isinstance(m, AIMessage)), None)
    reply = last_ai.content if last_ai else "No response."

    tool_calls_log = []
    for msg in final_messages:
        if hasattr(msg, "tool_calls") and msg.tool_calls:
            for tc in msg.tool_calls:
                tool_calls_log.append({"tool": tc["name"], "input": tc.get("args", {})})

    return {
        "reply": reply,
        "tool_calls": tool_calls_log,
        "pending_confirmation": result.get("pending_confirmation"),
        "model": "groq-fallback" if result.get("used_fallback") else "claude-sonnet-4-6",
    }

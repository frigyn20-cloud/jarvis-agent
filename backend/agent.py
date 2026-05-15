import os
from dotenv import load_dotenv
from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from typing import TypedDict, Annotated
import operator
from tools import ALL_TOOLS, CONFIRM_REQUIRED_TOOLS

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

SYSTEM_PROMPT = """
You are Jarvis, a smart and helpful personal AI assistant. You are concise, friendly, and practical.

You have access to these tools:
- web_search: search the internet for ANY information
- calculator: do math
- get_time: check current date/time
- summarize_text: summarize pasted text
- remember: save a fact to long-term memory
- recall: search long-term memory
- open_url: open a website in the browser

Rules:
- DEFAULT to using web_search for almost any factual question. Your training data has a cutoff, so search for anything about: people, places, companies, products, science, history, sports, news, weather, prices, how-to, definitions, or any topic where accuracy matters.
- ALWAYS use web_search for: current events, news, weather, stock prices, sports scores, recent releases, anything that changes over time.
- Use calculator for all math.
- Use get_time when asked about the current date or time.
- Use recall before answering personal questions about the user.
- Only answer from memory (without searching) for: simple greetings, basic math, and things you are absolutely certain about.
- If web_search returns results, summarize them clearly and cite the source URLs.
- Never make up facts. When unsure, search.
- Keep answers concise but complete.
- When using open_url, always confirm with the user before calling it.
"""


class AgentState(TypedDict):
    messages: Annotated[list, operator.add]
    tool_calls_made: list[str]
    pending_confirmation: dict | None


def get_llm_with_tools():
    if not GROQ_API_KEY:
        raise ValueError(
            "GROQ_API_KEY is not set. "
            "Get a free key at https://console.groq.com and add it to backend/.env"
        )
    llm = ChatGroq(
        api_key=GROQ_API_KEY,
        model=GROQ_MODEL,
        temperature=0.2,
    )
    return llm.bind_tools(ALL_TOOLS)


def agent_node(state: AgentState):
    llm = get_llm_with_tools()
    system_msg = SystemMessage(content=SYSTEM_PROMPT)
    messages = [system_msg] + state["messages"]
    response = llm.invoke(messages)
    return {
        "messages": [response],
        "tool_calls_made": state.get("tool_calls_made", []),
        "pending_confirmation": None,
    }


def should_continue(state: AgentState):
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        for tc in last_message.tool_calls:
            if tc["name"] in CONFIRM_REQUIRED_TOOLS:
                return "needs_confirmation"
        return "tools"
    return END


def confirmation_node(state: AgentState):
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        confirm_tools = [
            tc for tc in last_message.tool_calls
            if tc["name"] in CONFIRM_REQUIRED_TOOLS
        ]
        if confirm_tools:
            return {
                "messages": state["messages"],
                "tool_calls_made": state.get("tool_calls_made", []),
                "pending_confirmation": confirm_tools[0],
            }
    return state


def build_graph():
    tool_node = ToolNode(ALL_TOOLS)
    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    graph.add_node("needs_confirmation", confirmation_node)
    graph.set_entry_point("agent")
    graph.add_conditional_edges(
        "agent",
        should_continue,
        {
            "tools": "tools",
            "needs_confirmation": "needs_confirmation",
            END: END,
        },
    )
    graph.add_edge("tools", "agent")
    graph.add_edge("needs_confirmation", END)
    return graph.compile()


APP_GRAPH = build_graph()


async def run_agent(message: str, history: list[dict]) -> dict:
    lc_messages = []
    for msg in history[-10:]:
        if msg["role"] == "user":
            lc_messages.append(HumanMessage(content=msg["content"]))
        elif msg["role"] == "assistant":
            lc_messages.append(AIMessage(content=msg["content"]))

    lc_messages.append(HumanMessage(content=message))

    initial_state: AgentState = {
        "messages": lc_messages,
        "tool_calls_made": [],
        "pending_confirmation": None,
    }

    result = await APP_GRAPH.ainvoke(initial_state)

    final_messages = result["messages"]
    last_ai_message = None
    for msg in reversed(final_messages):
        if isinstance(msg, AIMessage):
            last_ai_message = msg
            break

    reply = last_ai_message.content if last_ai_message else "Sorry, I could not generate a response."

    tool_calls_log = []
    for msg in final_messages:
        if hasattr(msg, "tool_calls") and msg.tool_calls:
            for tc in msg.tool_calls:
                tool_calls_log.append({"tool": tc["name"], "input": tc.get("args", {})})

    return {
        "reply": reply,
        "tool_calls": tool_calls_log,
        "pending_confirmation": result.get("pending_confirmation"),
    }

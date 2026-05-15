import os
from dotenv import load_dotenv
from langchain_ollama import ChatOllama
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode
from typing import TypedDict, Annotated
import operator
from tools import ALL_TOOLS, CONFIRM_REQUIRED_TOOLS

load_dotenv()

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3")

# System prompt that gives the agent its Jarvis personality
SYSTEM_PROMPT = """
You are Jarvis, a smart and helpful personal AI assistant. You are concise, friendly, and practical.

You have access to these tools:
- calculator: do math
- get_time: check current date/time
- summarize_text: summarize pasted text
- remember: save a fact to long-term memory
- recall: search long-term memory
- open_url: open a website in the browser

Rules:
- Use tools when they help. Do not use them for simple conversational answers.
- For math, always use the calculator tool.
- For memory questions, use recall first.
- Never make up facts. If you don't know, say so.
- Keep answers short and clear.
- When using open_url, always confirm with the user before calling it.
"""


# ─── State definition ─────────────────────────────────────────────────────────

class AgentState(TypedDict):
    messages: Annotated[list, operator.add]
    tool_calls_made: list[str]
    pending_confirmation: dict | None  # tool call waiting for user approval


# ─── Build the LLM with tools ─────────────────────────────────────────────────

def get_llm_with_tools():
    llm = ChatOllama(
        model=OLLAMA_MODEL,
        base_url=OLLAMA_BASE_URL,
        temperature=0.2,
    )
    return llm.bind_tools(ALL_TOOLS)


# ─── Graph nodes ──────────────────────────────────────────────────────────────

def agent_node(state: AgentState):
    """The main LLM reasoning node."""
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
    """Decide whether to call tools or end."""
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        # Check if any tool needs confirmation
        for tc in last_message.tool_calls:
            if tc["name"] in CONFIRM_REQUIRED_TOOLS:
                return "needs_confirmation"
        return "tools"
    return END


def confirmation_node(state: AgentState):
    """Flag tools that need user confirmation."""
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


# ─── Build the graph ──────────────────────────────────────────────────────────

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


# ─── Main entry point ─────────────────────────────────────────────────────────

async def run_agent(message: str, history: list[dict]) -> dict:
    """
    Run the agent with a user message and conversation history.
    Returns: { reply, tool_calls, pending_confirmation }
    """
    # Convert history to LangChain messages
    lc_messages = []
    for msg in history[-10:]:  # Keep last 10 turns for context
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

    # Extract the final reply
    final_messages = result["messages"]
    last_ai_message = None
    for msg in reversed(final_messages):
        if isinstance(msg, AIMessage):
            last_ai_message = msg
            break

    reply = last_ai_message.content if last_ai_message else "Sorry, I could not generate a response."

    # Collect tool calls for display
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

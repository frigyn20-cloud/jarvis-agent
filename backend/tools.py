import numexpr
import datetime
import webbrowser
from zoneinfo import ZoneInfo
from langchain_core.tools import tool
from memory import save_memory, search_memory
from market_data import get_quote, get_market_snapshot
import asyncio
import os
from dotenv import load_dotenv
load_dotenv()

EASTERN = ZoneInfo("America/New_York")


def _do_search(query: str) -> str:
    """Search using Tavily (primary) with DuckDuckGo fallback."""
    tavily_key = os.getenv("TAVILY_API_KEY", "")

    if tavily_key:
        try:
            from tavily import TavilyClient
            client = TavilyClient(api_key=tavily_key)
            response = client.search(query, max_results=5)
            results = response.get("results", [])
            if results:
                parts = []
                for r in results:
                    parts.append(f"**{r['title']}**\n{r['url']}\n{r['content']}")
                return "\n\n".join(parts)
        except Exception:
            pass

    try:
        from ddgs import DDGS
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=5))
            if results:
                parts = [f"**{r['title']}**\n{r['href']}\n{r['body']}" for r in results]
                return "\n\n".join(parts)
    except Exception as e:
        return f"Search unavailable: {e}"

    return "No results found."


def _get_session_label(now_et: datetime.datetime) -> str:
    """Return a human-readable trading session label for a given ET datetime."""
    t = now_et.time()
    wd = now_et.weekday()  # 0=Mon, 6=Sun
    if wd >= 5:
        return "Weekend — futures only (Globex)"
    if t < datetime.time(4, 0):
        return "Overnight / Globex"
    if t < datetime.time(9, 30):
        return "Pre-Market"
    if t < datetime.time(16, 0):
        return "RTH (Regular Trading Hours) — market is OPEN"
    if t < datetime.time(20, 0):
        return "After-Hours"
    return "Overnight / Globex"


@tool
def get_time(_: str = "") -> str:
    """Return the current date and time in Eastern Time (ET), with trading session label."""
    now_et = datetime.datetime.now(tz=EASTERN)
    session = _get_session_label(now_et)
    return (
        f"{now_et.strftime('%A, %B %d %Y — %I:%M %p')} ET  |  Session: {session}"
    )


@tool
def calculator(expression: str) -> str:
    """
    Evaluate a math expression. Examples: '2 + 2', '100 * 1.08', 'sqrt(144)'.
    Returns the numeric result as a string.
    """
    try:
        result = numexpr.evaluate(expression)
        return str(float(result))
    except Exception as e:
        return f"Error evaluating expression: {e}"


@tool
def web_search(query: str) -> str:
    """
    Search the internet for any information — current events, news, weather,
    stock prices, sports scores, facts, people, places, products, how-to guides,
    science, history, definitions, recipes, or absolutely anything else.
    Use this tool whenever the user asks a factual question or anything
    you are not 100% certain about.
    Input: a plain search query string.
    Returns: top search results with titles, links, and content.
    """
    return _do_search(query)


@tool
def summarize_text(text: str) -> str:
    """
    Summarize a block of text. Pass the full text as input.
    Returns a concise summary.
    """
    if len(text.strip()) < 30:
        return "Text is too short to summarize."
    return f"[SUMMARIZE THIS TEXT]\n{text}"


@tool
def remember(fact: str) -> str:
    """
    Save an important fact to long-term memory.
    Input format: 'key: value' — e.g. 'project: OmniTool Studio'.
    """
    if ":" in fact:
        key, value = fact.split(":", 1)
        save_memory(key.strip(), value.strip())
        return f"Remembered: {key.strip()} = {value.strip()}"
    else:
        save_memory("note", fact.strip())
        return f"Remembered as note: {fact.strip()}"


@tool
def recall(query: str) -> str:
    """
    Search long-term memory for facts matching a query.
    Returns matching memories or 'Nothing found'.
    """
    results = search_memory(query)
    if not results:
        return "Nothing found in memory."
    lines = [f"- {r['key']}: {r['value']}" for r in results]
    return "From memory:\n" + "\n".join(lines)


@tool
def open_url(url: str) -> str:
    """
    Open a URL in the user's default browser.
    Only opens safe http/https URLs.
    Requires user confirmation before running.
    """
    if not url.startswith(("http://", "https://")):
        return "Invalid URL. Only http:// and https:// are allowed."
    try:
        webbrowser.open(url)
        return f"Opened: {url}"
    except Exception as e:
        return f"Could not open URL: {e}"


@tool
def get_market_quote(symbol: str) -> str:
    """
    Get a live market quote for a symbol.
    Supports futures (MNQ, MES, NQ, ES, MYM, M2K, YM, RTY),
    volatility (VIX), indices (SPX, NDX, DJI, RUT),
    and equities/ETFs (SPY, QQQ, AAPL, etc.).
    Input: ticker symbol as a string, e.g. 'MNQ', 'VIX', 'SPY'.
    Returns: price, change, % change, and data source.
    """
    q = get_quote(symbol)
    if "error" in q:
        return q["error"]
    sym   = q["symbol"]
    price = q["price"]
    chg   = q.get("change")
    pct   = q.get("change_pct")
    src   = q.get("source", "")
    ts    = q.get("timestamp", "")
    if chg is not None and pct is not None:
        direction = "▲" if chg >= 0 else "▼"
        return (
            f"{sym}: {price:,.2f}  {direction} {abs(chg):,.2f} ({abs(pct):.2f}%)  "
            f"[source: {src}  {ts[:16]}Z]"
        )
    return f"{sym}: {price:,.2f}  [source: {src}]"


@tool
def get_market_overview(_: str = "") -> str:
    """
    Get a live snapshot of the key Alpha watchlist: MNQ, MES, and VIX.
    Use this to give a quick market overview or when the user asks
    'what are the markets doing?' / 'how is futures trading?'
    No input needed.
    """
    try:
        snapshot = asyncio.run(get_market_snapshot())
    except RuntimeError:
        # Already inside an event loop (FastAPI) — run synchronously
        loop = asyncio.new_event_loop()
        snapshot = loop.run_until_complete(get_market_snapshot())
        loop.close()

    # Include current ET time and session in the snapshot
    now_et = datetime.datetime.now(tz=EASTERN)
    session = _get_session_label(now_et)
    header = f"Time: {now_et.strftime('%I:%M %p')} ET  |  Session: {session}"

    lines = [header]
    for sym, q in snapshot.items():
        if "error" in q:
            lines.append(f"{sym}: unavailable")
            continue
        price = q["price"]
        chg   = q.get("change")
        pct   = q.get("change_pct")
        if chg is not None and pct is not None:
            direction = "▲" if chg >= 0 else "▼"
            lines.append(f"{sym}: {price:,.2f}  {direction} {abs(chg):,.2f} ({abs(pct):.2f}%)")
        else:
            lines.append(f"{sym}: {price:,.2f}")
    return "Market snapshot:\n" + "\n".join(lines)


# Tools that require user confirmation before running
CONFIRM_REQUIRED_TOOLS = {"open_url"}

# All available tools
ALL_TOOLS = [
    calculator,
    get_time,
    web_search,
    summarize_text,
    remember,
    recall,
    open_url,
    get_market_quote,
    get_market_overview,
]

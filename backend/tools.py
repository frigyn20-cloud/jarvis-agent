import numexpr
import datetime
import webbrowser
from zoneinfo import ZoneInfo
from langchain_core.tools import tool
from memory import save_memory, search_memory
from market_data import get_quote, get_market_snapshot
from pb_blake import determine_bias, get_setup_status, CANDLE_STORE
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
        loop = asyncio.new_event_loop()
        snapshot = loop.run_until_complete(get_market_snapshot())
        loop.close()

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


@tool
def get_bias(symbol: str) -> str:
    """
    Determine the current HTF (Higher Timeframe) directional bias for a symbol
    using stored 4H and 1H candle data and the PB Blake ICT model.

    Analyzes: market structure (HH/HL vs LH/LL), FVG respect/disrespect,
    and SMT divergence between correlated pairs (MNQ/MES).

    Input: symbol string — e.g. 'MNQ' or 'MES'
    Returns: bias verdict (bullish/bearish/neutral) with detailed reasoning.

    Use this tool when the user asks about bias, direction, HTF structure,
    or 'what is the setup' — BEFORE giving any analysis.
    """
    symbol = symbol.upper().strip()
    counts = CANDLE_STORE.summary()
    has_data = any(symbol in k for k in counts)

    if not has_data:
        return (
            f"No candle data stored for {symbol} yet. "
            f"Candles arrive via TradingView webhooks or the /setup/backfill endpoint. "
            f"Current store: {counts or 'empty'}"
        )

    bias, details = determine_bias(symbol)
    candle_info = ", ".join(
        f"{tf}: {n} candles" for k, n in counts.items()
        if k.startswith(symbol)
        for tf in [k.split("@")[1]]
    )
    return (
        f"{symbol} HTF Bias: {bias.upper()}\n"
        f"Reasoning: {details}\n"
        f"Candle data: {candle_info or 'see store summary'}"
    )


@tool
def get_full_setup(symbol: str) -> str:
    """
    Run the complete PB Blake ICT setup evaluation for a symbol.

    This runs all three steps of the model:
      Step 1 — HTF bias (4H + 1H structure + FVG + SMT)
      Step 2 — Liquidity draw zone (15M/30M/1H FVG or swing level)
      Step 3 — Entry iFVG (5M/1M inverse FVG in bias direction)

    Input: symbol string — e.g. 'MNQ' or 'MES'
    Returns: full setup verdict with score (0-3), bias, draw target,
             entry zone, and alert text if all 3 conditions are met.

    Use this tool when the user says 'what is the setup', 'run the model',
    'give me the full analysis', or 'is there a trade' on MNQ or MES.
    Always call get_market_overview alongside this tool to add live price context.
    """
    symbol = symbol.upper().strip()
    counts = CANDLE_STORE.summary()
    has_data = any(symbol in k for k in counts)

    if not has_data:
        return (
            f"No candle data stored for {symbol} yet. "
            f"Run backfill first via /setup/backfill, or wait for TradingView webhooks. "
            f"Current store: {counts or 'empty'}"
        )

    s = get_setup_status(symbol)

    lines = [
        f"=== PB Blake Setup: {symbol} ===",
        f"Bias:  {s['bias'].upper()}",
        f"Score: {s['score']}/3 conditions met",
        f"  [1] Bias confirmed:    {'YES' if s['conditions']['bias']     else 'NO'}",
        f"  [2] Liquidity draw:    {'YES' if s['conditions']['liq_draw'] else 'NO'}",
        f"  [3] Entry iFVG:        {'YES' if s['conditions']['ifvg']     else 'NO'}",
    ]

    if s["liq_draw"]:
        ld = s["liq_draw"]
        swept_note = " (already swept — need new sweep or different level)" if ld["swept"] else " (not yet swept)"
        lines.append(f"Draw target: {ld['price']:,.2f} on {ld['timeframe']}{swept_note}")

    if s["entry_fvg"]:
        fvg = s["entry_fvg"]
        lines.append(f"Entry zone:  {fvg['bottom']:,.2f} – {fvg['top']:,.2f} ({fvg['timeframe']} iFVG)")

    if s["smt_signal"]:
        smt = s["smt_signal"]
        lines.append(f"SMT signal:  {smt['direction'].upper()} divergence — {smt['symbol_a']} vs {smt['symbol_b']} on {smt['timeframe']}")

    if s["alert_text"]:
        lines.append(f"\nALERT: {s['alert_text']}")
    elif s["score"] < 3:
        missing = []
        if not s["conditions"]["liq_draw"]: missing.append("waiting for price to reach the FVG draw zone")
        if not s["conditions"]["ifvg"]:     missing.append("no entry iFVG formed yet")
        lines.append(f"\nNo trade yet — {' and '.join(missing)}.")

    lines.append(f"\nBias reasoning: {s['bias_details']}")
    lines.append(f"In trading window: {'YES' if s['in_trading_window'] else 'NO'}")
    lines.append(f"Candle counts: {s['candle_counts']}")

    return "\n".join(lines)


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
    get_bias,
    get_full_setup,
]

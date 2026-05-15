import numexpr
import datetime
import webbrowser
import time
from langchain_core.tools import tool
from memory import save_memory, search_memory


def _do_search(query: str) -> str:
    """Search using ddgs (formerly duckduckgo-search)."""
    try:
        from ddgs import DDGS
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=5))
            if results:
                parts = [f"**{r['title']}**\n{r['href']}\n{r['body']}" for r in results]
                return "\n\n".join(parts)
    except Exception:
        pass

    # Fallback with delay
    try:
        from ddgs import DDGS
        time.sleep(1.5)
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=5, backend="lite"))
            if results:
                parts = [f"**{r['title']}**\n{r['href']}\n{r['body']}" for r in results]
                return "\n\n".join(parts)
    except Exception as e:
        return f"Search unavailable right now: {e}"

    return "No results found."


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
def get_time(_: str = "") -> str:
    """
    Return the current date and time.
    """
    now = datetime.datetime.now()
    return now.strftime("%A, %B %d %Y — %I:%M %p")


@tool
def web_search(query: str) -> str:
    """
    Search the internet for any information — current events, news, weather,
    stock prices, sports scores, facts, people, places, products, how-to guides,
    recent developments, or anything else.
    Use this tool whenever you are not 100% certain of an answer, or when the
    user asks about anything that may have changed or happened recently.
    Input: a plain search query string.
    Returns: top search results with titles, links, and descriptions.
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


# Tools that require user confirmation before running
CONFIRM_REQUIRED_TOOLS = {"open_url"}

# All available tools
ALL_TOOLS = [calculator, get_time, web_search, summarize_text, remember, recall, open_url]

import sqlite3
import os
from dotenv import load_dotenv

load_dotenv()

DB_PATH = os.getenv("MEMORY_DB_PATH", "./jarvis_memory.db")


def _get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create the memory table if it doesn't exist."""
    with _get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()


def save_memory(key: str, value: str):
    """Insert or update a memory entry."""
    init_db()
    with _get_conn() as conn:
        # Check if key already exists
        existing = conn.execute(
            "SELECT id FROM memory WHERE key = ?", (key,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE memory SET value = ?, created_at = CURRENT_TIMESTAMP WHERE key = ?",
                (value, key)
            )
        else:
            conn.execute(
                "INSERT INTO memory (key, value) VALUES (?, ?)",
                (key, value)
            )
        conn.commit()


def search_memory(query: str) -> list[dict]:
    """Search memories by key or value (case-insensitive)."""
    init_db()
    q = f"%{query.lower()}%"
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT key, value, created_at FROM memory WHERE LOWER(key) LIKE ? OR LOWER(value) LIKE ? ORDER BY created_at DESC LIMIT 10",
            (q, q)
        ).fetchall()
    return [{"key": r["key"], "value": r["value"], "created_at": r["created_at"]} for r in rows]


def get_all_memories() -> list[dict]:
    """Return all saved memories."""
    init_db()
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT key, value, created_at FROM memory ORDER BY created_at DESC"
        ).fetchall()
    return [{"key": r["key"], "value": r["value"], "created_at": r["created_at"]} for r in rows]


def delete_memory(key: str):
    """Delete a memory entry by key."""
    init_db()
    with _get_conn() as conn:
        conn.execute("DELETE FROM memory WHERE key = ?", (key,))
        conn.commit()

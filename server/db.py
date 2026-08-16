"""SQLite connection handling, shared by the trips and accounts modules."""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "bp.db"


@contextmanager
def connect():
    """`with sqlite3.connect(...)` commits but does *not* close, so the
    connection is closed explicitly here. WAL is set once at init, not per
    connection -- switching journal mode takes a lock every time.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    try:
        yield con
        con.commit()
    finally:
        con.close()


def columns(con: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}

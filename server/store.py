"""Server-side state.

Deliberately small: readings are never stored here. The only per-user data is
an opaque encrypted blob the server cannot read, plus reminder times and a
push subscription.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from .db import connect

log = logging.getLogger("bp.store")

SCHEMA = """
-- Ciphertext only. The key is derived in the browser from a passphrase the
-- server never sees, so a database leak yields nothing readable.
CREATE TABLE IF NOT EXISTS backups (
    device_id  INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    blob       BLOB NOT NULL,
    salt       TEXT NOT NULL,
    iv         TEXT NOT NULL,
    readings   INTEGER,          -- count only, so the UI can show something
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subs (
    id         INTEGER PRIMARY KEY,
    device_id  INTEGER UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
    endpoint   TEXT UNIQUE NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Reminder times, in the device's own timezone offset. The server knows when
-- to nudge, and nothing about what is measured.
CREATE TABLE IF NOT EXISTS reminders (
    device_id  INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    times      TEXT NOT NULL,    -- comma separated HH:MM
    tz_offset  INTEGER NOT NULL DEFAULT 0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    last_fired TEXT
);

CREATE TABLE IF NOT EXISTS ocr_usage (
    device_id  INTEGER NOT NULL,
    day        TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, day)
);
"""


def init() -> None:
    from . import accounts
    with connect() as con:
        con.execute("PRAGMA journal_mode = WAL")
        accounts.init_schema(con)
        con.executescript(SCHEMA)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# encrypted backup
# --------------------------------------------------------------------------
def _put_backup_blocking(device_id: int, blob: bytes, salt: str, iv: str,
                         readings: int | None) -> None:
    with connect() as con:
        con.execute(
            """INSERT INTO backups (device_id, blob, salt, iv, readings, updated_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(device_id) DO UPDATE SET blob=excluded.blob,
                     salt=excluded.salt, iv=excluded.iv,
                     readings=excluded.readings, updated_at=excluded.updated_at""",
            (device_id, blob, salt, iv, readings, _now()),
        )


async def put_backup(device_id: int, blob: bytes, salt: str, iv: str,
                     readings: int | None) -> None:
    await asyncio.to_thread(_put_backup_blocking, device_id, blob, salt, iv, readings)


def _get_backup_blocking(device_id: int) -> dict | None:
    with connect() as con:
        r = con.execute("SELECT * FROM backups WHERE device_id = ?", (device_id,)).fetchone()
        return dict(r) if r else None


async def get_backup(device_id: int) -> dict | None:
    return await asyncio.to_thread(_get_backup_blocking, device_id)


def _delete_backup_blocking(device_id: int) -> bool:
    with connect() as con:
        return con.execute("DELETE FROM backups WHERE device_id = ?",
                           (device_id,)).rowcount > 0


async def delete_backup(device_id: int) -> bool:
    return await asyncio.to_thread(_delete_backup_blocking, device_id)


# --------------------------------------------------------------------------
# OCR usage — server-side, because the Android app's client-side counter is
# editable in devtools once it becomes a browser
# --------------------------------------------------------------------------
def _bump_ocr_blocking(device_id: int, limit: int) -> tuple[bool, int]:
    day = datetime.now(timezone.utc).date().isoformat()
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute("SELECT count FROM ocr_usage WHERE device_id=? AND day=?",
                          (device_id, day)).fetchone()
        used = row["count"] if row else 0
        if used >= limit:
            return False, used
        con.execute(
            """INSERT INTO ocr_usage (device_id, day, count) VALUES (?,?,1)
               ON CONFLICT(device_id, day) DO UPDATE SET count = count + 1""",
            (device_id, day),
        )
        return True, used + 1


async def bump_ocr(device_id: int, limit: int) -> tuple[bool, int]:
    return await asyncio.to_thread(_bump_ocr_blocking, device_id, limit)


# --------------------------------------------------------------------------
# reminders + push
# --------------------------------------------------------------------------
def _save_sub_blocking(device_id: int, sub: dict) -> None:
    keys = sub.get("keys") or {}
    with connect() as con:
        con.execute("DELETE FROM push_subs WHERE endpoint = ? AND device_id IS NOT ?",
                    (sub["endpoint"], device_id))
        con.execute(
            """INSERT INTO push_subs (device_id, endpoint, p256dh, auth, created_at)
               VALUES (?,?,?,?,?)
               ON CONFLICT(device_id) DO UPDATE SET endpoint=excluded.endpoint,
                     p256dh=excluded.p256dh, auth=excluded.auth""",
            (device_id, sub["endpoint"], keys.get("p256dh", ""), keys.get("auth", ""), _now()),
        )


async def save_sub(device_id: int, sub: dict) -> None:
    await asyncio.to_thread(_save_sub_blocking, device_id, sub)


def _set_reminders_blocking(device_id: int, times: str, tz_offset: int, enabled: bool) -> None:
    with connect() as con:
        con.execute(
            """INSERT INTO reminders (device_id, times, tz_offset, enabled)
               VALUES (?,?,?,?)
               ON CONFLICT(device_id) DO UPDATE SET times=excluded.times,
                     tz_offset=excluded.tz_offset, enabled=excluded.enabled""",
            (device_id, times, tz_offset, int(enabled)),
        )


async def set_reminders(device_id: int, times: str, tz_offset: int, enabled: bool) -> None:
    await asyncio.to_thread(_set_reminders_blocking, device_id, times, tz_offset, enabled)


def _get_reminders_blocking(device_id: int) -> dict | None:
    with connect() as con:
        r = con.execute("SELECT * FROM reminders WHERE device_id = ?", (device_id,)).fetchone()
        return dict(r) if r else None


async def get_reminders(device_id: int) -> dict | None:
    return await asyncio.to_thread(_get_reminders_blocking, device_id)


def _due_blocking() -> list[dict]:
    """Reminders whose local time has just arrived, with a push target."""
    with connect() as con:
        return [dict(r) for r in con.execute(
            """SELECT r.*, p.endpoint, p.p256dh, p.auth
                 FROM reminders r
                 JOIN devices d ON d.id = r.device_id AND d.revoked = 0
                 JOIN push_subs p ON p.device_id = r.device_id
                WHERE r.enabled = 1""")]


async def due() -> list[dict]:
    return await asyncio.to_thread(_due_blocking)


def _mark_fired_blocking(device_id: int, stamp: str) -> None:
    with connect() as con:
        con.execute("UPDATE reminders SET last_fired = ? WHERE device_id = ?",
                    (stamp, device_id))


async def mark_fired(device_id: int, stamp: str) -> None:
    await asyncio.to_thread(_mark_fired_blocking, device_id, stamp)

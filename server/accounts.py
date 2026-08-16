"""Devices and invites.

There are no usernames or passwords. A device proves who it is with a random
token held in an HttpOnly cookie, issued when an invite is redeemed. One
invite registers exactly one device, which is what makes "two phones = two
invites" fall out naturally.

Tokens are stored hashed: a leaked database should not hand over working
credentials.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import secrets
import time
from datetime import datetime, timedelta, timezone

from .db import connect

log = logging.getLogger("bp.accounts")

COOKIE_NAME = "bp_device"
# Browsers clamp cookie lifetime to 400 days; asking for more is pointless.
COOKIE_MAX_AGE = 400 * 24 * 3600
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "true").lower() != "false"
INVITE_TTL = timedelta(days=int(os.getenv("INVITE_TTL_DAYS", "7")))
# An invite stays redeemable for this long after its FIRST use, re-binding the
# same device rather than creating another. Chat apps open links in their own
# browser, whose cookie jar the installed PWA cannot read, so the realistic
# flow is: redeem in WhatsApp's viewer, install properly, redeem again. The
# window is absolute -- it does not slide with each use -- so a forwarded link
# is not a week-long open door.
INVITE_REBIND = timedelta(minutes=int(os.getenv("INVITE_REBIND_MINUTES", "60")))

# Unambiguous alphabet: no I/1, no O/0, so a code can be read aloud or typed
# from a phone screen without confusion. 12 chars = ~60 bits.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_GROUPS = 3
_GROUP_LEN = 4

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    id         INTEGER PRIMARY KEY,
    token_hash TEXT UNIQUE NOT NULL,
    label      TEXT,
    created_at TEXT NOT NULL,
    last_seen  TEXT,
    revoked    INTEGER NOT NULL DEFAULT 0
);
-- Lives here rather than with the readings: a push subscription belongs to a
-- device, and devices are this module's business.
CREATE TABLE IF NOT EXISTS push_subs (
    id         INTEGER PRIMARY KEY,
    device_id  INTEGER UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
    endpoint   TEXT UNIQUE NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
    id         INTEGER PRIMARY KEY,
    code_hash  TEXT UNIQUE NOT NULL,
    label      TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    -- The code in the clear, kept ONLY while the invite is still usable so it
    -- can be re-shown or re-copied. Wiped on redemption, so the table never
    -- holds a plaintext credential that still works. code_hash stays the
    -- authority for redemption.
    code_plain TEXT,
    device_id  INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    -- When set before redemption, the invite binds an existing device rather
    -- than creating one. Used to hand an already-registered device back to
    -- its owner after the migration to cookie identity.
    adopt_id   INTEGER REFERENCES devices(id) ON DELETE CASCADE
);
"""


def init_schema(con) -> None:
    con.executescript(SCHEMA)
    have = {r["name"] for r in con.execute("PRAGMA table_info(invites)")}
    if "code_plain" not in have:
        con.execute("ALTER TABLE invites ADD COLUMN code_plain TEXT")
        log.info("migrated invites: added code_plain")


# --------------------------------------------------------------------------
# tokens
# --------------------------------------------------------------------------
def new_device_token() -> str:
    return secrets.token_urlsafe(32)


def new_invite_code() -> str:
    return "-".join(
        "".join(secrets.choice(_ALPHABET) for _ in range(_GROUP_LEN))
        for _ in range(_GROUPS)
    )


def normalise_code(raw: str) -> str:
    """Accept what a human types: lower case, missing or extra dashes."""
    cleaned = "".join(c for c in (raw or "").upper() if c in _ALPHABET)
    if len(cleaned) != _GROUPS * _GROUP_LEN:
        return ""
    return "-".join(
        cleaned[i : i + _GROUP_LEN] for i in range(0, len(cleaned), _GROUP_LEN)
    )


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# redemption throttle
# --------------------------------------------------------------------------
# Every request arrives from Caddy on loopback, so per-IP limiting is
# meaningless here. A global ceiling still makes guessing hopeless.
_REDEEM_WINDOW = 60.0
_REDEEM_MAX = int(os.getenv("REDEEM_MAX_PER_MIN", "20"))
_attempts: list[float] = []


def throttled() -> bool:
    now = time.monotonic()
    _attempts[:] = [t for t in _attempts if now - t < _REDEEM_WINDOW]
    if len(_attempts) >= _REDEEM_MAX:
        return True
    _attempts.append(now)
    return False


# --------------------------------------------------------------------------
# devices
# --------------------------------------------------------------------------
def _device_by_token_blocking(token: str) -> dict | None:
    with connect() as con:
        row = con.execute(
            "SELECT * FROM devices WHERE token_hash = ? AND revoked = 0",
            (_hash(token),),
        ).fetchone()
        if not row:
            return None
        con.execute("UPDATE devices SET last_seen = ? WHERE id = ?", (_now(), row["id"]))
        return dict(row)


async def device_by_token(token: str) -> dict | None:
    return await asyncio.to_thread(_device_by_token_blocking, token)


def _list_devices_blocking() -> list[dict]:
    with connect() as con:
        return [
            dict(r)
            for r in con.execute(
                """SELECT d.id, d.label, d.created_at, d.last_seen, d.revoked,
                          (SELECT COUNT(*) FROM push_subs p
                            WHERE p.device_id = d.id) AS has_push
                     FROM devices d ORDER BY d.id"""
            )
        ]


async def list_devices() -> list[dict]:
    return await asyncio.to_thread(_list_devices_blocking)


def _set_revoked_blocking(device_id: int, revoked: bool) -> bool:
    with connect() as con:
        cur = con.execute(
            "UPDATE devices SET revoked = ? WHERE id = ?", (1 if revoked else 0, device_id)
        )
        return cur.rowcount > 0


async def set_revoked(device_id: int, revoked: bool) -> bool:
    return await asyncio.to_thread(_set_revoked_blocking, device_id, revoked)


def _rename_blocking(device_id: int, label: str) -> bool:
    with connect() as con:
        cur = con.execute(
            "UPDATE devices SET label = ? WHERE id = ?", (label, device_id)
        )
        return cur.rowcount > 0


async def rename_device(device_id: int, label: str) -> bool:
    return await asyncio.to_thread(_rename_blocking, device_id, label)


def _delete_device_blocking(device_id: int) -> bool:
    """Removing a device takes its push subscription with it.

    Deleted explicitly rather than by cascade: this schema is created fresh so
    the constraint exists, but relying on it invites the bug that bit the
    sibling project, where an ALTER TABLE column silently carried none.
    """
    with connect() as con:
        con.execute("DELETE FROM push_subs WHERE device_id = ?", (device_id,))
        cur = con.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        return cur.rowcount > 0


async def delete_device(device_id: int) -> bool:
    return await asyncio.to_thread(_delete_device_blocking, device_id)


def _prune_devices_blocking() -> int:
    with connect() as con:
        con.execute(
            "DELETE FROM push_subs WHERE device_id IN "
            "(SELECT id FROM devices WHERE revoked = 1)"
        )
        cur = con.execute("DELETE FROM devices WHERE revoked = 1")
        return cur.rowcount


async def prune_devices() -> int:
    return await asyncio.to_thread(_prune_devices_blocking)


# --------------------------------------------------------------------------
# invites
# --------------------------------------------------------------------------
def _create_invite_blocking(label: str | None, adopt_id: int | None) -> str:
    code = new_invite_code()
    with connect() as con:
        con.execute(
            """INSERT INTO invites (code_hash, code_plain, label, created_at,
                                    expires_at, adopt_id)
               VALUES (?,?,?,?,?,?)""",
            (
                _hash(code),
                code,
                label,
                _now(),
                (datetime.now(timezone.utc) + INVITE_TTL).isoformat(timespec="seconds"),
                adopt_id,
            ),
        )
    return code


async def create_invite(label: str | None = None, adopt_id: int | None = None) -> str:
    return await asyncio.to_thread(_create_invite_blocking, label, adopt_id)


def _list_invites_blocking() -> list[dict]:
    with connect() as con:
        return [
            dict(r)
            for r in con.execute(
                """SELECT id, label, created_at, expires_at, used_at, device_id,
                          adopt_id, code_plain
                     FROM invites ORDER BY id DESC"""
            )
        ]


async def list_invites() -> list[dict]:
    return await asyncio.to_thread(_list_invites_blocking)


def _revoke_invite_blocking(invite_id: int) -> bool:
    with connect() as con:
        cur = con.execute(
            "DELETE FROM invites WHERE id = ? AND used_at IS NULL", (invite_id,)
        )
        return cur.rowcount > 0


async def revoke_invite(invite_id: int) -> bool:
    return await asyncio.to_thread(_revoke_invite_blocking, invite_id)


def _prune_invites_blocking() -> int:
    """Drop invites that can no longer register anything: already used, or
    expired unused. Pending ones are never touched."""
    now = _now()
    with connect() as con:
        cur = con.execute(
            "DELETE FROM invites WHERE used_at IS NOT NULL OR expires_at < ?", (now,)
        )
        return cur.rowcount


async def prune_invites() -> int:
    return await asyncio.to_thread(_prune_invites_blocking)


class InviteError(Exception):
    """Redemption refused. The message is safe to show the user."""


def _redeem_blocking(code: str) -> tuple[int, str]:
    """-> (device_id, device_token). Single-use, enforced under a write lock."""
    with connect() as con:
        con.execute("BEGIN IMMEDIATE")
        row = con.execute(
            "SELECT * FROM invites WHERE code_hash = ?", (_hash(code),)
        ).fetchone()
        if not row:
            raise InviteError("Codul de invitație nu este valid.")
        now = datetime.now(timezone.utc)
        if datetime.fromisoformat(row["expires_at"]) < now:
            raise InviteError("Invitația a expirat. Cere una nouă.")

        rebind_to = None
        if row["used_at"]:
            first = datetime.fromisoformat(row["used_at"])
            if now - first <= INVITE_REBIND and row["device_id"]:
                # Same device, new token: whichever browser redeems last wins,
                # and the earlier context is signed out by the rotation.
                rebind_to = row["device_id"]
            else:
                raise InviteError("Invitația a fost deja folosită.")

        token = new_device_token()
        if rebind_to or row["adopt_id"]:
            device_id = rebind_to or row["adopt_id"]
            con.execute(
                "UPDATE devices SET token_hash = ?, revoked = 0 WHERE id = ?",
                (_hash(token), device_id),
            )
        else:
            cur = con.execute(
                "INSERT INTO devices (token_hash, label, created_at) VALUES (?,?,?)",
                (_hash(token), row["label"], _now()),
            )
            device_id = cur.lastrowid

        # Keep the original used_at so the grace window stays absolute. The
        # plaintext is dropped at the same time -- after this the code can only
        # re-bind an existing device, and not at all once the window closes.
        con.execute(
            "UPDATE invites SET used_at = COALESCE(used_at, ?), device_id = ?, "
            "code_plain = NULL WHERE id = ?",
            (_now(), device_id, row["id"]),
        )
        return device_id, token


async def redeem(code: str) -> tuple[int, str]:
    return await asyncio.to_thread(_redeem_blocking, code)

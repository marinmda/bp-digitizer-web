"""Web Push (VAPID) sending.

The keypair is generated once and persisted to the data volume; regenerating
it would silently invalidate every existing browser subscription, so the file
is created only when absent.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
from pathlib import Path

import orjson
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pywebpush import WebPushException, webpush

log = logging.getLogger("bp.push")

DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
KEY_PATH = DATA_DIR / "vapid_private.pem"
VAPID_SUBJECT = os.getenv("VAPID_SUBJECT", "mailto:admin@example.invalid")

# Push services reject a subscription that is gone for good with these.
DEAD = (404, 410)


class Vapid:
    def __init__(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if not KEY_PATH.exists():
            key = ec.generate_private_key(ec.SECP256R1())
            KEY_PATH.write_bytes(
                key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                )
            )
            KEY_PATH.chmod(0o600)
            log.info("generated new VAPID keypair at %s", KEY_PATH)

        self._key = serialization.load_pem_private_key(KEY_PATH.read_bytes(), None)
        raw = self._key.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        # The browser wants the uncompressed P-256 point, base64url, unpadded.
        self.public_key = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


vapid = Vapid()


def _send_blocking(sub: dict, payload: dict) -> int:
    res = webpush(
        subscription_info=sub,
        data=orjson.dumps(payload),
        vapid_private_key=str(KEY_PATH),
        vapid_claims={"sub": VAPID_SUBJECT},
        ttl=3600,
    )
    return res.status_code


async def send(sub: dict, payload: dict) -> tuple[bool, int | None]:
    """-> (delivered, status). status in DEAD means: drop this subscription."""
    try:
        code = await asyncio.to_thread(_send_blocking, sub, payload)
        return True, code
    except WebPushException as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status in DEAD:
            log.info("subscription gone (%s), will be pruned", status)
        else:
            log.warning("push failed (%s): %s", status, exc)
        return False, status
    except Exception as exc:  # noqa: BLE001 - a bad sub must not kill the loop
        log.warning("push error: %s", exc)
        return False, None

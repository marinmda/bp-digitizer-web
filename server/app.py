"""Optional server for wBP Digitizer.

Everything here is optional. The PWA is a static directory that works with no
server at all; this adds three things a browser cannot do alone:

  * camera OCR, because the Gemini key must not live in a browser
  * encrypted backup, because clearing site data would otherwise lose history
  * reminders, because the web has no scheduled local notification API

Access is per-device by invite, the same model as the sibling projects. The
gate covers only these features -- it is never required to use the app.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import (Body, Depends, FastAPI, File, Form, Header, HTTPException,
                     Request, Response, UploadFile)
from fastapi.responses import ORJSONResponse

from . import accounts, ocr, push, store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("bp")

MAX_BACKUP = int(os.getenv("MAX_BACKUP_BYTES", str(4 * 1024 * 1024)))


async def current_device(request: Request) -> dict:
    token = request.cookies.get(accounts.COOKIE_NAME)
    device = await accounts.device_by_token(token) if token else None
    if not device:
        raise HTTPException(401, "This device is not registered for server features.")
    return device


def client_ip(request: Request) -> str:
    """The address the rate limiter counts against.

    Cloudflare sets CF-Connecting-IP from the connection it terminated and
    overwrites anything the client sent, and the origin is loopback-bound
    behind the tunnel, so nothing reaches here without passing through it.
    X-Forwarded-For is the fallback, first entry: Caddy appends its own peer,
    which is cloudflared on this host and tells us nothing.
    """
    cf = request.headers.get("cf-connecting-ip")
    if cf:
        return cf.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "?"


async def admin_only(x_admin: str | None = Header(None)) -> None:
    if x_admin != "1":
        raise HTTPException(404, "Not Found")


async def reminder_loop() -> None:
    """Fires within a minute of the requested local time.

    Not exact, and it cannot be: this is the compromise the web forces in
    place of AlarmManager. A device that is offline at the moment simply does
    not get the nudge.
    """
    while True:
        try:
            now = datetime.now(timezone.utc)
            for r in await store.due():
                local = now + timedelta(minutes=r["tz_offset"])
                hhmm = local.strftime("%H:%M")
                stamp = f"{local.date()}T{hhmm}"
                if hhmm not in [t.strip() for t in r["times"].split(",") if t.strip()]:
                    continue
                if r.get("last_fired") == stamp:
                    continue
                ok, status = await push.send(
                    {"endpoint": r["endpoint"],
                     "keys": {"p256dh": r["p256dh"], "auth": r["auth"]}},
                    {"title": "Blood pressure", "body": "Time to take a reading.",
                     "tag": "bp-reminder"})
                await store.mark_fired(r["device_id"], stamp)
                log.info("reminder %s -> device %s (ok=%s)", hhmm, r["device_id"], ok)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("reminder pass failed: %s", exc)
        await asyncio.sleep(30)


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init()
    task = asyncio.create_task(reminder_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="wBP Digitizer server", default_response_class=ORJSONResponse,
              lifespan=lifespan)


@app.get("/api/health")
async def health():
    return {"ok": True, "ocr": bool(ocr.API_KEY), "ocr_daily_limit": ocr.DAILY_LIMIT}


@app.get("/api/me")
async def me(device: dict = Depends(current_device)):
    return {"device": {"id": device["id"], "label": device["label"]},
            "features": {"ocr": bool(ocr.API_KEY), "backup": True, "reminders": True}}


@app.post("/api/invites/redeem")
async def redeem(request: Request, response: Response, payload: dict = Body(...)):
    if accounts.throttled(client_ip(request)):
        raise HTTPException(429, "Too many attempts. Wait a minute and try again.")
    code = accounts.normalise_code(payload.get("code") or "")
    if not code:
        raise HTTPException(400, "That does not look like a code.")
    try:
        device_id, token = await accounts.redeem(code)
    except accounts.InviteError as exc:
        raise HTTPException(400, str(exc))
    response.set_cookie(accounts.COOKIE_NAME, token, max_age=accounts.COOKIE_MAX_AGE,
                        httponly=True, secure=accounts.COOKIE_SECURE,
                        samesite="lax", path="/")
    return {"ok": True, "device_id": device_id}


# --------------------------------------------------------------------------
# OCR
# --------------------------------------------------------------------------
@app.post("/api/ocr")
async def read_monitor(image: UploadFile = File(...),
                       device: dict = Depends(current_device)):
    data = await image.read()
    if len(data) > ocr.MAX_BYTES:
        raise HTTPException(413, "Image too large.")
    allowed, used = await store.bump_ocr(device["id"], ocr.DAILY_LIMIT)
    if not allowed:
        raise HTTPException(429, f"Daily scan limit reached ({ocr.DAILY_LIMIT}).")
    try:
        result = await ocr.read_monitor(data, image.content_type or "image/jpeg")
    except ocr.OcrUnavailable:
        await store.refund_ocr(device["id"])
        raise HTTPException(503, "OCR is not configured on this server.")
    except ocr.OcrUpstreamError as exc:
        # Nothing was read, so the scan should not count against the day.
        await store.refund_ocr(device["id"])
        if exc.status == 429:
            raise HTTPException(503, f"Scanning is temporarily unavailable: {exc.message}")
        raise HTTPException(502, f"The scanning service refused the request: {exc.message}")
    except Exception as exc:  # noqa: BLE001
        log.warning("ocr failed: %r", exc)
        await store.refund_ocr(device["id"])
        raise HTTPException(502, "Could not read the display. Try another photo.")
    log.info("ocr for device %s (%d/%d today)", device["id"], used, ocr.DAILY_LIMIT)
    return {**result, "used_today": used, "daily_limit": ocr.DAILY_LIMIT}


# --------------------------------------------------------------------------
# encrypted backup — the server stores ciphertext and never a key
# --------------------------------------------------------------------------
@app.put("/api/backup")
async def put_backup(blob: UploadFile = File(...), salt: str = Form(...),
                     iv: str = Form(...), readings: int = Form(0),
                     device: dict = Depends(current_device)):
    data = await blob.read()
    if len(data) > MAX_BACKUP:
        raise HTTPException(413, "Backup too large.")
    await store.put_backup(device["id"], data, salt, iv, readings)
    return {"ok": True, "bytes": len(data), "readings": readings}


@app.get("/api/backup")
async def get_backup(device: dict = Depends(current_device)):
    row = await store.get_backup(device["id"])
    if not row:
        raise HTTPException(404, "No backup stored.")
    import base64
    return {"blob": base64.b64encode(row["blob"]).decode(), "salt": row["salt"],
            "iv": row["iv"], "readings": row["readings"], "updated_at": row["updated_at"]}


@app.get("/api/backup/info")
async def backup_info(device: dict = Depends(current_device)):
    row = await store.get_backup(device["id"])
    return {"exists": bool(row),
            "readings": row["readings"] if row else None,
            "updated_at": row["updated_at"] if row else None}


@app.delete("/api/backup")
async def drop_backup(device: dict = Depends(current_device)):
    return {"deleted": await store.delete_backup(device["id"])}


# --------------------------------------------------------------------------
# reminders
# --------------------------------------------------------------------------
@app.get("/api/vapid")
async def vapid(device: dict = Depends(current_device)):
    return {"publicKey": push.vapid.public_key}


@app.post("/api/push/subscribe")
async def subscribe(payload: dict = Body(...), device: dict = Depends(current_device)):
    sub = payload.get("subscription") or {}
    if not sub.get("endpoint") or not (sub.get("keys") or {}).get("auth"):
        raise HTTPException(400, "Incomplete push subscription.")
    await store.save_sub(device["id"], sub)
    return {"ok": True}


@app.get("/api/reminders")
async def get_reminders(device: dict = Depends(current_device)):
    r = await store.get_reminders(device["id"])
    return r or {"times": "", "tz_offset": 0, "enabled": 0}


@app.put("/api/reminders")
async def set_reminders(payload: dict = Body(...), device: dict = Depends(current_device)):
    times = [t.strip() for t in (payload.get("times") or "").split(",") if t.strip()]
    for t in times:
        if not (len(t) == 5 and t[2] == ":" and t[:2].isdigit() and t[3:].isdigit()):
            raise HTTPException(400, f"Bad time: {t}")
    await store.set_reminders(device["id"], ",".join(times),
                              int(payload.get("tz_offset") or 0),
                              bool(payload.get("enabled", True)))
    return {"ok": True, "times": times}


@app.post("/api/push/test")
async def push_test(payload: dict = Body(default={}),
                    device: dict = Depends(current_device)):
    sub = payload.get("subscription") or {}
    if not sub.get("endpoint"):
        raise HTTPException(400, "Subscription required.")
    ok, status = await push.send(sub, {
        "title": "wBP Digitizer", "body": "Reminders are working.", "tag": "test"})
    return {"delivered": ok, "status": status}


# --------------------------------------------------------------------------
# admin (tailnet only)
# --------------------------------------------------------------------------
@app.get("/api/admin/devices", dependencies=[Depends(admin_only)])
async def admin_devices():
    return {"devices": await accounts.list_devices()}


@app.post("/api/admin/devices/{device_id}/revoke", dependencies=[Depends(admin_only)])
async def admin_revoke(device_id: int, payload: dict = Body(default={})):
    if not await accounts.set_revoked(device_id, bool(payload.get("revoked", True))):
        raise HTTPException(404, "no such device")
    return {"id": device_id}


@app.delete("/api/admin/devices/{device_id}", dependencies=[Depends(admin_only)])
async def admin_delete(device_id: int):
    if not await accounts.delete_device(device_id):
        raise HTTPException(404, "no such device")
    return {"deleted": device_id}


@app.get("/api/admin/invites", dependencies=[Depends(admin_only)])
async def admin_invites():
    base = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    invites = await accounts.list_invites()
    for i in invites:
        code = i.pop("code_plain", None)
        i["code"] = code
        i["url"] = f"{base}/?code={code}" if code and base else None
    return {"invites": invites, "ttl_days": accounts.INVITE_TTL.days}


@app.post("/api/admin/invites", dependencies=[Depends(admin_only)])
async def admin_create_invite(payload: dict = Body(default={})):
    label = (payload.get("label") or "").strip()[:60] or None
    code = await accounts.create_invite(label)
    base = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    return {"code": code, "url": f"{base}/?code={code}" if base else None,
            "expires_in_days": accounts.INVITE_TTL.days, "label": label}


@app.post("/api/admin/invites/{invite_id}/revoke", dependencies=[Depends(admin_only)])
async def admin_revoke_invite(invite_id: int):
    if not await accounts.revoke_invite(invite_id):
        raise HTTPException(404, "no such unused invite")
    return {"revoked": invite_id}

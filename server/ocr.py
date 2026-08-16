"""Camera OCR, proxied.

The Android app calls Gemini from the device and protects it with Play
Integrity App Check. A browser has no equivalent, so the call moves here: the
API key stays server-side, and the daily limit is enforced in the database
rather than in localStorage, where anyone could edit it.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re

import httpx

log = logging.getLogger("bp.ocr")

API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
ENDPOINT = ("https://generativelanguage.googleapis.com/v1beta/models/"
            "{model}:generateContent")
DAILY_LIMIT = int(os.getenv("OCR_DAILY_LIMIT", "50"))
MAX_BYTES = int(os.getenv("OCR_MAX_BYTES", str(6 * 1024 * 1024)))

PROMPT = (
    "This is a photo of a digital blood pressure monitor. Read the display and "
    "return ONLY compact JSON, no prose and no code fence:\n"
    '{"systolic": int, "diastolic": int, "pulse": int|null, "confidence": 0..1}\n'
    "Systolic is the larger upper number, diastolic the smaller one below it, "
    "pulse is usually marked with a heart symbol or PUL/bpm. "
    "If a value is not legible use null. Do not guess plausible-looking values."
)

_JSON = re.compile(r"\{.*\}", re.S)


class OcrUnavailable(Exception):
    """No API key configured -- the feature is simply off on this deployment."""


async def read_monitor(image: bytes, mime: str = "image/jpeg") -> dict:
    if not API_KEY:
        raise OcrUnavailable()
    payload = {
        "contents": [{"parts": [
            {"text": PROMPT},
            {"inline_data": {"mime_type": mime,
                             "data": base64.b64encode(image).decode()}},
        ]}],
        # Deterministic: the same photo should not read differently twice.
        "generationConfig": {"temperature": 0, "maxOutputTokens": 200},
    }
    async with httpx.AsyncClient(timeout=45) as c:
        r = await c.post(ENDPOINT.format(model=MODEL),
                         params={"key": API_KEY}, json=payload)
        r.raise_for_status()
        data = r.json()

    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        log.warning("unexpected Gemini response shape: %s", json.dumps(data)[:300])
        raise ValueError("unreadable response")

    m = _JSON.search(text)
    if not m:
        raise ValueError("no JSON in response")
    out = json.loads(m.group(0))

    def num(v, lo, hi):
        try:
            n = int(v)
        except (TypeError, ValueError):
            return None
        return n if lo <= n <= hi else None

    # Range-check here as well as in the model: a hallucinated 999 must not
    # reach a chart that people read as their own health data.
    return {
        "systolic": num(out.get("systolic"), 50, 300),
        "diastolic": num(out.get("diastolic"), 30, 200),
        "pulse": num(out.get("pulse"), 25, 250),
        "confidence": out.get("confidence"),
    }

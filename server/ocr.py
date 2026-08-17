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
# httpx logs every request url at INFO. Even with the key moved to a header,
# keep that quiet so no future call can leak a secret through the log.
logging.getLogger("httpx").setLevel(logging.WARNING)

API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
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


class OcrUpstreamError(Exception):
    """Gemini refused the request. Carries its own words, which are usually
    actionable (billing, quota, key) in a way "try another photo" is not."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


async def read_monitor(image: bytes, mime: str = "image/jpeg") -> dict:
    if not API_KEY:
        raise OcrUnavailable()
    payload = {
        "contents": [{"parts": [
            {"text": PROMPT},
            {"inline_data": {"mime_type": mime,
                             "data": base64.b64encode(image).decode()}},
        ]}],
        "generationConfig": {
            # Deterministic: the same photo should not read differently twice.
            "temperature": 0,
            # Ask for JSON directly rather than hoping the prose contains some.
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "systolic": {"type": "INTEGER", "nullable": True},
                    "diastolic": {"type": "INTEGER", "nullable": True},
                    "pulse": {"type": "INTEGER", "nullable": True},
                    "confidence": {"type": "NUMBER", "nullable": True},
                },
                # Without `required` the model answers with whichever fields it
                # feels like and stops -- measured: it returned {"systolic":128}
                # alone and omitted the rest. Nullable still lets it say "not
                # legible" explicitly rather than inventing a number.
                "required": ["systolic", "diastolic", "pulse"],
                "propertyOrdering": ["systolic", "diastolic", "pulse", "confidence"],
            },
            # Reading three numbers off a display needs no deliberation, and on
            # a thinking model the reasoning eats the output budget before any
            # answer is emitted -- which returned empty text and no JSON.
            "thinkingConfig": {"thinkingBudget": 0},
            "maxOutputTokens": 800,
        },
    }
    async with httpx.AsyncClient(timeout=45) as c:
        # The key goes in a header, never the query string: httpx logs request
        # urls at INFO, which would write the key into the container log.
        r = await c.post(ENDPOINT.format(model=MODEL),
                         headers={"x-goog-api-key": API_KEY}, json=payload)
        if r.status_code != 200:
            # Surface Gemini's own explanation. A depleted balance and an
            # unreadable photo are both "it did not work" to the caller
            # otherwise, and only one of them is fixable by retaking the shot.
            try:
                err = r.json().get("error", {})
                detail = err.get("message") or r.text[:200]
            except ValueError:
                detail = r.text[:200]
            log.warning("gemini %s: %s", r.status_code, detail[:300])
            raise OcrUpstreamError(r.status_code, detail)
        data = r.json()

    cand = (data.get("candidates") or [{}])[0]
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        # finishReason tells us whether we were truncated, filtered or refused.
        log.warning("empty Gemini text: finishReason=%s usage=%s",
                    cand.get("finishReason"), data.get("usageMetadata"))
        raise ValueError("unreadable response")

    m = _JSON.search(text)
    if not m:
        log.warning("no JSON in Gemini text (finishReason=%s): %r",
                    cand.get("finishReason"), text[:200])
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

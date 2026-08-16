"""Convert Android strings.xml into flat JSON locale files.

The Android app already carries 284 strings in 12 languages. Retranslating
that would be both wasteful and worse -- these are already reviewed.
"""
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else
           "/home/opc/projects/BloodPressureMonitor/app/src/main/res")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "web/i18n")
OUT.mkdir(parents=True, exist_ok=True)

# Android positional args -> ICU-ish named slots the web side understands.
POSITIONAL = re.compile(r"%(\d+)\$[sd]")
BARE = re.compile(r"%[sd]")


def unescape(text: str) -> str:
    """Android escaping: \\' \\" \\n, and &amp; entities ElementTree handled."""
    return (text.replace("\\'", "'").replace('\\"', '"')
                .replace("\\n", "\n").replace("\\@", "@"))


def convert(text: str) -> str:
    text = unescape(text)
    text = POSITIONAL.sub(lambda m: "{" + str(int(m.group(1)) - 1) + "}", text)
    n = [0]

    def bare(_):
        i = n[0]
        n[0] += 1
        return "{" + str(i) + "}"

    return BARE.sub(bare, text)


def load(path: Path) -> dict:
    out = {}
    root = ET.parse(path).getroot()
    for el in root:
        name = el.get("name")
        if not name or el.get("translatable") == "false":
            continue
        if el.tag == "string":
            out[name] = convert("".join(el.itertext()))
        elif el.tag == "plurals":
            # The web side picks a form with Intl.PluralRules.
            out[name] = {it.get("quantity"): convert("".join(it.itertext()))
                         for it in el}
    return out


base = load(SRC / "values" / "strings.xml")
(OUT / "en.json").write_text(
    json.dumps(base, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
print(f"  en  {len(base):>4} strings")

total = len(base)
for d in sorted(SRC.glob("values-*")):
    f = d / "strings.xml"
    if not f.exists():
        continue
    lang = d.name.split("-", 1)[1]
    data = load(f)
    # Fall back to English for anything untranslated, so the UI never shows a key.
    merged = {**base, **data}
    (OUT / f"{lang}.json").write_text(
        json.dumps(merged, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    missing = len(base) - len(set(data) & set(base))
    print(f"  {lang:<3} {len(data):>4} translated"
          + (f", {missing} fall back to English" if missing else ", complete"))
    total += len(data)
print(f"  ---- {total} strings across {len(list(OUT.glob('*.json')))} locales")

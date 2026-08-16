# BP Digitizer — web

Log, chart and export blood pressure readings. **Local-first**: readings live in
your browser's IndexedDB and are never sent anywhere.

A web companion to the [Android app](https://github.com/marinmda/BloodPressureMonitor),
sharing its clinical logic and its translations. It exists because publishing a
health app to Google Play requires a company account — so the app cannot be
distributed there, and asking non-technical friends to sideload an APK is worse
than sending them a link.

## It runs with no server

Open the page, add readings, see charts, export a file. That is the whole app.
There is **no build step, no framework, and no backend requirement** — copy
`web/` onto any static host and you are done.

```bash
git clone https://github.com/marinmda/bp-digitizer-web
cd bp-digitizer-web
python3 -m http.server -d web 8080     # or any static host
```

An optional server adds three things, each of which you can decline:

| Optional | What it needs | What it gives |
|---|---|---|
| Camera OCR | a Gemini API key, held server-side | reads SYS/DIA/pulse from a photo of a monitor |
| Encrypted backup | somewhere to store an opaque blob | recovery if the browser's storage is cleared |
| Reminders | web push | a nudge at the times you choose |

Server features are gated by a code you generate (`./admin.sh invite "Ana"`),
because OCR costs money and backups cost storage. **The gate covers only those
three features** — the app itself never asks for a code.

The server never sees a reading in the clear. Backups are encrypted in the
browser with AES-GCM under a key derived from your passphrase by PBKDF2
(310,000 iterations); the server stores ciphertext, a salt and an IV, and
cannot recover your data if you forget the passphrase — which is the point.
Verified: the stored blob contains no plaintext field names, and a wrong
passphrase is rejected by AES-GCM's own authentication rather than silently
producing garbage.

The OCR daily limit lives in the database, not in `localStorage` as the
Android app's does — on the web that counter would be editable in devtools,
and the calls cost real money.

## What it does

- Manual entry with sliders seeded from your last reading
- AHA zones (Normal / Elevated / Stage 1 / Stage 2 / Crisis), MAP and pulse pressure
- Trend chart (systolic + diastolic, fixed 40–180 axis, 120/80 reference lines)
  and a systolic-vs-diastolic scatter coloured by zone
- 7 / 30 / 90 day and all-time ranges
- Risk assessment from your health profile — a port of the app's
  Framingham/ACC-AHA-derived scoring
- Context tags, notes
- CSV and JSON export, JSON/CSV import with timestamp deduplication
- **12 languages**, carried over from the Android app rather than re-translated
- Installs to the home screen; works offline

## What it deliberately does not do

Some things the Android app does cannot be done on the web, and pretending
otherwise would be worse than saying so:

- **Health Connect sync.** No web equivalent exists.
- **Exact offline reminders.** The web has no scheduled local notification API
  — `Notification Triggers` was proposed and never shipped. Reminders here are
  server-sent push: they need network at the moment they fire, and on iOS they
  only work from an installed PWA.
- **PDF export.** Not yet ported; CSV and JSON are there.

If you need those, use the Android app.

## Not medical advice

This is a logging tool. The risk assessment is a simplified adaptation of
published scoring and is informational only. It does not diagnose anything and
does not replace a clinician.

## Layout

```
web/
  index.html        the whole UI
  app.js            views, charts, entry, export
  bp.js             clinical logic — zones, MAP, BMI, risk scoring
  db.js             IndexedDB storage
  i18n.js           locale loading
  i18n/*.json       12 catalogues, converted from the Android strings.xml
tools/
  convert-strings.py  regenerates i18n/ from the Android repo
```

`bp.js` has no DOM or storage dependencies, so it can be diffed against the
Kotlin it was ported from and tested on its own.

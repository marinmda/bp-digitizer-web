# wBP Digitizer — web

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

`deploy.sh` copies `web/` to a directory and stamps a build hash into the
asset URLs, so a deploy reaches installed apps instead of waiting out their
caches. Serving `web/` raw works exactly the same, minus that cache-busting —
you would clear the service worker by hand after each change.

An optional server adds three things, each of which you can decline:

| Optional | What it needs | What it gives |
|---|---|---|
| Camera OCR | a Gemini API key, held server-side | reads SYS/DIA/pulse from a photo of a monitor |
| Encrypted backup | somewhere to store an opaque blob | recovery if the browser's storage is cleared |
| Reminders | web push | a nudge at the times you choose |

Server features are gated by a code you generate (`./admin.sh invite "Ana"`),
because OCR costs money and backups cost storage. **The gate covers only those
three features** — the app itself never asks for a code. Without one the camera
and bell wear a small lock and lead to the screen where a code goes, rather
than hiding and leaving the feature undiscoverable.

One code registers one device, and stays redeemable for seven days. Within an
hour of its first use it re-binds the *same* device instead of registering
another, because chat apps open links in their own browser, whose cookies the
installed PWA cannot read — the realistic flow is redeem in the viewer, install
properly, redeem again. That window is absolute rather than sliding, so a
forwarded link is not a week-long open door. Redemption is the one endpoint
that must answer before it knows who is asking, so it is rate limited per
address, with a global ceiling behind it.

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
- Trend chart (systolic + diastolic, 120/80 reference lines) and a
  systolic-vs-diastolic scatter. Both axes follow the data: the trend pads and
  snaps outward once a day of history exists, keeping the fixed 40–180 frame
  below that so a 3 mmHg wobble cannot fill the viewport. Scatter dots are
  coloured by recency, not severity — position against the guides already says
  how high a reading is
- 7 / 30 / 90 day and all-time ranges
- Burst averaging: readings taken back to back in one sitting collapse to a
  single point, which is what AHA/ACC guidance asks for. On by default; the
  history list and every export still show each reading
- Insights computed on the device — morning versus evening, 30-day trend, time
  in range, healthy streaks, weekday versus weekend, and which context tag
  moves your numbers most
- Risk assessment from your health profile — a port of the app's
  Framingham/ACC-AHA-derived scoring
- Context tags, notes
- CSV and JSON export, JSON/CSV import with timestamp deduplication
- **PDF report** — overview page (zone donut, systolic/diastolic scatter), a
  chart page per active range with numbered tag callouts and a stats bar, then
  the last 30 days as a table. Two ways out: through the browser's print
  dialog, which gives selectable, searchable text and fills whatever paper is
  chosen, or as a direct download that skips the dialog at the cost of pages
  being pictures
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
- **Selectable text in the *downloaded* PDF.** Writing PDF bytes in the
  browser means shipping fonts, and this app speaks twelve languages including
  Arabic, Devanagari and CJK — megabytes of glyphs for a local-first app. The
  download rasterises instead, so its text is pixels. The print route has real
  text; it just needs one more tap.

If you need those, use the Android app.

## Not medical advice

This is a logging tool. The risk assessment is a simplified adaptation of
published scoring and is informational only. It does not diagnose anything and
does not replace a clinician.

## Layout

```
web/
  index.html        the whole UI
  app.js            views, charts, entry, gestures, export
  bp.js             clinical logic — zones, MAP, BMI, risk scoring, enums
  insights.js       the patterns surfaced on the dashboard
  aggregate.js      burst averaging
  pdf.js            the printable report, and the rasterised download
  palette.js        chart colours shared by the dashboard and the report
  db.js             IndexedDB storage
  server.js         the optional server's client — every call may fail
  icons.js          inlined Material paths
  i18n.js           locale loading
  i18n/*.json       12 catalogues, converted from the Android strings.xml
  sw.js             offline shell
server/             the optional server: OCR proxy, backup, push reminders
bin/
  version-imports.py  stamps the build hash into ES module imports
tools/
  convert-strings.py  regenerates i18n/ from the Android repo
```

`bp.js`, `insights.js` and `aggregate.js` have no DOM or storage dependencies,
so they can be diffed against the Kotlin they were ported from and tested on
their own.

`version-imports.py` exists because `import './x.js'` resolves to an
*unversioned* URL: only the entry point carries the build hash, so a new
`app.js` would keep importing a week-old `server.js` from cache. That took
several days to find once.

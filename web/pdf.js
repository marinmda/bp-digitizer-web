/* The printable Blood Pressure Report, ported from ExportPdfUseCase.kt.

   Android draws into a PdfDocument canvas at a fixed 2x-A4 size. Here the
   browser's own print pipeline does the rendering and the user picks "Save as
   PDF" -- which is what makes the report work in all twelve locales. A bundled
   PDF writer would have to carry embedded CJK, Devanagari and Arabic fonts and
   its own bidi and shaping, for megabytes, where the browser already has both.
   Nothing leaves the device either way.

   The catch is that the print dialog, not this code, chooses the paper. Chrome
   on Android ignores the @page size descriptor entirely and shrinks any
   oversized page box to fit, so nothing here may assume a page's dimensions:

     - every page box is `height: 100vh`, which in paged media is exactly the
       printable area, whatever paper and orientation the dialog is set to;
     - the charts are SVG stretched with preserveAspectRatio="none", so they
       fill a box of any shape. Strokes carry vector-effect="non-scaling-stroke"
       so line weights stay put, dots are zero-length round-capped paths so they
       stay circular, and every label is HTML positioned in per-cent so no text
       is ever stretched;
     - the reading table flows across pages under the browser's own pagination
       with a repeating thead and tfoot, rather than being chopped into a fixed
       number of rows that only fits one paper size. */
'use strict';

import { t, locale } from './i18n.js';
import { TAGS, CATEGORIES, ZONE_KEY, meanArterialPressure, pulsePressure } from './bp.js';
import { collapseBursts } from './aggregate.js';
import { recencyColor, recencyGradient, recencyAt } from './palette.js';

const MS_DAY = 86400000;
/** Minimum readings in the last 90 days before the overview page is worth it. */
const OVERVIEW_MIN = 5;
const SITE_URL = 'zandaulion.com/bpdigitizer.html';

/* Print palette. Deliberately literal rather than the app's CSS variables:
   the report must look the same whether or not the device is in dark mode. */
const SYS_COLOR = '#d32f2f';
const DIA_COLOR = '#1976d2';
const ZONE_HEX = {
  NORMAL: '#2e7d32', ELEVATED: '#f9a825', STAGE_1: '#ef6c00',
  STAGE_2: '#d32f2f', HYPERTENSIVE_CRISIS: '#b71c1c',
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r0 = (n) => Math.round(n);
const pc = (n) => `${(n * 100).toFixed(3)}%`;

const tagsOf = (r) => String(r.tags || '').split(',').filter(Boolean);

/* ------------------------------------------------------------ formatting -- */

const dfDate = (ms) => new Date(ms).toLocaleDateString(locale(),
  { day: 'numeric', month: 'short', year: 'numeric' });
const dfDateTime = (ms) => `${dfDate(ms)}  ${new Date(ms).toLocaleTimeString(locale(),
  { hour: '2-digit', minute: '2-digit', hour12: false })}`;

/* Matches xDateFmt(): the wider the span, the coarser the axis label. */
function xLabelFmt(spanMs) {
  const opts = spanMs <= 14 * MS_DAY ? { month: 'short', day: 'numeric' }
             : spanMs <= 180 * MS_DAY ? { month: 'numeric', day: 'numeric' }
             : { month: '2-digit', year: '2-digit' };
  return (ms) => new Date(ms).toLocaleDateString(locale(), opts);
}

function dateSpan(rows) {
  const a = dfDate(rows[0].timestamp);
  const b = dfDate(rows[rows.length - 1].timestamp);
  return a === b ? a : `${a} – ${b}`;
}

const rangeHeading = (days) =>
  t(days === 7 ? 'pdf_range_7d' : days === 30 ? 'pdf_range_30d' : 'pdf_range_90d');

/* --------------------------------------------------------------- ranges --- */

/* One page per active range, skipping a range with fewer than two readings or
   one that would contain exactly the same readings as the range before it. */
function buildChartRanges(all) {
  if (all.length < 2) return [];
  const now = Date.now();
  const out = [];
  let prev = '';
  for (const days of [7, 30, 90]) {
    const slice = all.filter((r) => r.timestamp >= now - days * MS_DAY);
    const ids = slice.map((r) => r.id).join(',');
    if (slice.length >= 2 && ids !== prev) {
      out.push({ heading: `${rangeHeading(days)}  ·  ${dateSpan(slice)}`, rows: slice });
      prev = ids;
    }
  }
  return out;
}

/* ------------------------------------------------------- plot primitives -- */

/* Plot geometry is normalised: the SVG's viewBox is a 1000x1000 square that
   gets stretched to whatever shape the page leaves for it. Only shapes go in
   the SVG; labels are HTML siblings placed in per-cent, which is what keeps
   text upright and evenly sized however the box is stretched. */
const VB = 1000;
const svgLine = (x1, y1, x2, y2, cls) =>
  `<line class="${cls}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${
    x2.toFixed(1)}" y2="${y2.toFixed(1)}" vector-effect="non-scaling-stroke"/>`;
/* A zero-length subpath with a round cap draws a true circle of the stroke's
   width, so dots stay round in a stretched viewBox where <circle> would not. */
const svgDot = (x, y, colour, w) =>
  `<path d="M${x.toFixed(1)},${y.toFixed(1)}L${x.toFixed(1)},${y.toFixed(1)}" stroke="${
    colour}" stroke-width="${w}" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
const label = (cls, styles, s) =>
  `<span class="${cls}" style="${styles}">${esc(s)}</span>`;

/* ---------------------------------------------------------- line chart ---- */

function chartPlot(rows, badgeAt) {
  const first = rows[0].timestamp;
  const last = rows[rows.length - 1].timestamp;

  // Y bounds, same rule as the in-app chart: a sub-day span keeps the fixed
  // 40-180 frame so a 3 mmHg wobble cannot fill the page; a multi-day span
  // pads by 5 and snaps outward to the nearest 10.
  let yMin = 40, yMax = 180;
  if (last - first >= MS_DAY) {
    const lo = Math.min(...rows.map((r) => Math.min(r.systolic, r.diastolic)));
    const hi = Math.max(...rows.map((r) => Math.max(r.systolic, r.diastolic)));
    yMin = Math.floor((lo - 5) / 10) * 10;
    yMax = Math.ceil((hi + 5) / 10) * 10;
  }
  const ny = (v) => 1 - (v - yMin) / (yMax - yMin);            // 0 at top
  const nx = (ts) => (first === last ? 0.5 : (ts - first) / (last - first));
  const Y = (v) => ny(v) * VB;
  const X = (ts) => nx(ts) * VB;

  let svg = '', html = '';
  const step = (yMax - yMin) <= 80 ? 10 : 20;
  for (let v = yMin; v <= yMax; v += step) {
    svg += svgLine(0, Y(v), VB, Y(v), 'grid');
    html += label('yl', `top:${pc(ny(v))}`, v) + label('yr', `top:${pc(ny(v))}`, v);
  }
  for (const [v, text] of [[120, t('pdf_ref_sys', 120)], [80, t('pdf_ref_dia', 80)]]) {
    if (v < yMin || v > yMax) continue;
    svg += svgLine(0, Y(v), VB, Y(v), 'ref');
    html += label('rl', `top:${pc(ny(v))}`, text);
  }

  // Up to ten X labels, spaced evenly in real time rather than by index, so an
  // irregular measuring habit shows up in the chart.
  const fmt = xLabelFmt(last - first);
  const count = Math.min(10, rows.length);
  const denom = Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const ts = first + (last - first) * i / denom;
    html += label('xl', `left:${pc(nx(ts))}`, fmt(ts));
  }

  const path = (key, colour) => `<path class="serie" stroke="${colour}" vector-effect="non-scaling-stroke" d="${
    rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.timestamp).toFixed(1)},${Y(r[key]).toFixed(1)}`).join('')}"/>`;
  svg += path('diastolic', DIA_COLOR) + path('systolic', SYS_COLOR);

  const dotW = rows.length > 100 ? 3 : rows.length > 40 ? 5 : 7;
  rows.forEach((r, i) => {
    svg += svgDot(X(r.timestamp), Y(r.systolic), SYS_COLOR, dotW);
    svg += svgDot(X(r.timestamp), Y(r.diastolic), DIA_COLOR, dotW);
    if (badgeAt[i]) {
      const top = Math.min(ny(r.systolic), ny(r.diastolic));
      html += `<span class="cal" style="left:${pc(nx(r.timestamp))};top:${pc(top)}">${
        esc(badgeAt[i])}</span>`;
    }
  });

  svg += svgLine(0, 0, 0, VB, 'axis') + svgLine(0, VB, VB, VB, 'axis');
  return `<div class="plot"><div class="pa"><svg viewBox="0 0 ${VB} ${VB}"
    preserveAspectRatio="none">${svg}</svg>${html}</div></div>`;
}

/* ---------------------------------------------------------- stats bar ----- */

function statsBar(rows) {
  const sys = rows.map((r) => r.systolic);
  const dia = rows.map((r) => r.diastolic);
  const mapAvg = r0(avg(rows.map((r) => meanArterialPressure(r.systolic, r.diastolic))));
  const ppAvg = r0(avg(rows.map((r) => pulsePressure(r.systolic, r.diastolic))));
  const val = (k, v) => `<span class="sv"><b>${esc(k)}</b> ${esc(v)}</span>`;
  return `<div class="stats">
    <i style="background:${SYS_COLOR}"></i><span>${esc(t('pdf_stat_systolic'))}</span>
    <i style="background:${DIA_COLOR}"></i><span>${esc(t('pdf_stat_diastolic'))}</span>
    <em></em>
    ${val(t('pdf_stat_avg'), `${r0(avg(sys))} / ${r0(avg(dia))}`)}
    ${val(t('pdf_stat_min'), `${Math.min(...sys)} / ${Math.min(...dia)}`)}
    ${val(t('pdf_stat_max'), `${Math.max(...sys)} / ${Math.max(...dia)}`)}
    <em></em>
    ${val(t('pdf_stat_map'), mapAvg)}
    ${val(t('pdf_stat_pp'), ppAvg)}
  </div>`;
}

/* ---------------------------------------------------------- tag legend ---- */

const tagLegend = (tags) => (tags.length
  ? `<div class="legend">${tags.map((k, i) =>
      `<span class="lg"><b>${i + 1}</b>${esc(`${i + 1} = ${t(k)}`)}</span>`).join('')}</div>`
  : '');

/* ------------------------------------------------------------- overview --- */

/* The donut is intrinsically square, so this one keeps a uniform aspect ratio
   and sits in a square box; its legend is HTML beside it. */
function donut(rows) {
  const total = rows.length;
  const present = CATEGORIES.map((c) => [c, rows.filter((r) => r.category === c).length])
    .filter(([, n]) => n > 0);

  const cx = 150, cy = 150, r = 116, thickness = 44;
  const circ = 2 * Math.PI * r;
  let offset = 0, arcs = '';
  for (const [cat, n] of present) {
    const len = circ * n / total;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ZONE_HEX[cat]}"
      stroke-width="${thickness}" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += len;
  }
  arcs += `<text x="${cx}" y="${cy + 16}" text-anchor="middle" class="dn">${total}</text>`;

  const rowsHtml = present.map(([cat, n]) =>
    `<span class="zl"><i style="background:${ZONE_HEX[cat]}"></i>${
      esc(`${t(ZONE_KEY[cat])}    ${n}  (${Math.round(100 * n / total)}%)`)}</span>`).join('');

  return `<div class="zone">
    <div class="dbox"><svg viewBox="0 0 300 300">${arcs}</svg>
      <span class="dcap">${esc(t('pdf_readings_count', total))}</span></div>
    <div class="zleg">${rowsHtml}</div>
  </div>`;
}

function scatterPlot(rows) {
  const snapLo = (v) => Math.floor((v - 5) / 10) * 10;
  const snapHi = (v) => Math.ceil((v + 5) / 10) * 10;
  const sysMin = snapLo(Math.min(...rows.map((r) => r.systolic)));
  const sysMax = snapHi(Math.max(...rows.map((r) => r.systolic)));
  const diaMin = snapLo(Math.min(...rows.map((r) => r.diastolic)));
  const diaMax = snapHi(Math.max(...rows.map((r) => r.diastolic)));
  const nx = (d) => (d - diaMin) / (diaMax - diaMin || 1);
  const ny = (s) => 1 - (s - sysMin) / (sysMax - sysMin || 1);

  let svg = '', html = '';
  const yStep = (sysMax - sysMin) <= 80 ? 10 : 20;
  for (let v = sysMin; v <= sysMax; v += yStep) {
    svg += svgLine(0, ny(v) * VB, VB, ny(v) * VB, 'grid');
    html += label('yl', `top:${pc(ny(v))}`, v);
  }
  const xStep = (diaMax - diaMin) <= 80 ? 10 : 20;
  for (let v = diaMin; v <= diaMax; v += xStep) {
    svg += svgLine(nx(v) * VB, 0, nx(v) * VB, VB, 'grid');
    html += label('xc', `left:${pc(nx(v))}`, v);
  }
  if (sysMin <= 120 && 120 <= sysMax) svg += svgLine(0, ny(120) * VB, VB, ny(120) * VB, 'ref');
  if (diaMin <= 80 && 80 <= diaMax) svg += svgLine(nx(80) * VB, 0, nx(80) * VB, VB, 'ref');

  const tMin = Math.min(...rows.map((r) => r.timestamp));
  const tMax = Math.max(...rows.map((r) => r.timestamp));
  for (const r of rows) {
    svg += svgDot(nx(r.diastolic) * VB, ny(r.systolic) * VB,
                  recencyColor(recencyAt(r.timestamp, tMin, tMax)), 6);
  }
  svg += svgLine(0, 0, 0, VB, 'axis') + svgLine(0, VB, VB, VB, 'axis');

  return `<div class="plot scat">
    <span class="axt xt">${esc(t('pdf_stat_diastolic'))}</span>
    <span class="axt yt">${esc(t('pdf_stat_systolic'))}</span>
    <div class="pa"><svg viewBox="0 0 ${VB} ${VB}" preserveAspectRatio="none">${svg}</svg>${html}</div>
  </div>`;
}

const recencyKey = () => `<div class="reckey"><i></i>${esc(t('scatter_colour_time'))}</div>`;

/* ------------------------------------------------------------- assembly --- */

const header = (subtitle, right) => `<div class="hd">
    <div><h1>${esc(t('pdf_report_title'))}</h1><p>${esc(subtitle)}</p></div>
    <span>${esc(right)}</span>
  </div>`;

const footer = () => `<div class="ft">
    <span class="url">${esc(SITE_URL)}</span>
    <span>${esc(t('pdf_disclaimer'))}</span>
  </div>`;

const overviewPage = (rows) => `<section class="page">
    ${header(`${t('pdf_overview_subtitle')}  ·  ${dateSpan(rows)}`, t('pdf_exported', dfDate(Date.now())))}
    <h2>${esc(t('pdf_zone_distribution'))}</h2>
    ${donut(rows)}
    <h2>${esc(t('pdf_sys_vs_dia'))}</h2>
    ${recencyKey()}
    ${scatterPlot(rows)}
    ${footer()}
  </section>`;

function chartPage(range) {
  const rows = range.rows;
  // Each tag present in this range gets a number in enum order; a reading
  // tagged #2, #4 and #7 carries the badge "247".
  const present = TAGS.filter((k) => rows.some((r) => tagsOf(r).includes(k)));
  const number = new Map(present.map((k, i) => [k, i + 1]));
  const badgeAt = {};
  rows.forEach((r, i) => {
    const ns = tagsOf(r).map((k) => number.get(k)).filter(Boolean).sort((a, b) => a - b);
    if (ns.length) badgeAt[i] = ns.join('');
  });

  return `<section class="page">
    ${header(range.heading, t('pdf_exported', dfDate(Date.now())))}
    ${chartPlot(rows, badgeAt)}
    ${statsBar(rows)}
    ${tagLegend(present)}
    ${footer()}
  </section>`;
}

/** Notes cell: "[tag, tag] note", truncated the way the Kotlin truncates it. */
function notesCell(r) {
  const tags = tagsOf(r);
  const prefix = tags.length ? `[${tags.map((k) => t(k)).join(', ')}] ` : '';
  const full = prefix + (r.notes || '');
  return full.length > 52 ? `${full.slice(0, 49)}…` : full;
}

const tableHead = (rows) => `
    <thead>
      <tr class="tt"><th colspan="6"><div>
        <span>${esc(t('pdf_table_title'))}</span>
        <span class="tr">${esc(`${t('pdf_exported', dfDate(Date.now()))}  ·  ${
          t('pdf_readings_count', rows.length)}`)}</span>
      </div></th></tr>
      <tr>
        <th>${esc(t('pdf_col_datetime'))}</th><th>${esc(t('pdf_col_sys'))}</th>
        <th>${esc(t('pdf_col_dia'))}</th><th>${esc(t('pdf_col_pulse'))}</th>
        <th>${esc(t('pdf_col_category'))}</th><th>${esc(t('pdf_col_notes'))}</th>
      </tr>
    </thead>`;

const tableRows = (rows) => rows.map((r, i) => `<tr${i % 2 === 0 ? ' class="alt"' : ''}>
      <td>${esc(dfDateTime(r.timestamp))}</td><td>${r.systolic}</td><td>${r.diastolic}</td>
      <td>${r.pulse == null ? '—' : r.pulse}</td>
      <td style="color:${ZONE_HEX[r.category] || '#323232'}">${esc(t(ZONE_KEY[r.category] || ''))}</td>
      <td>${esc(notesCell(r))}</td></tr>`).join('');

/* 273 mm of content, less the 18 mm header, 8 mm column row and 12 mm footer,
   at 7 mm a row. Only the rasterised export needs this: there the page box is
   a known size and nothing paginates it for us. */
const ROWS_PER_PAGE = 33;

const tablePages = (rows) => {
  const out = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_PAGE) {
    out.push(`<section class="page">
      <table>${tableHead(rows)}<tbody>${tableRows(rows.slice(i, i + ROWS_PER_PAGE))}</tbody></table>
      ${footer()}
    </section>`);
  }
  return out.join('');
};

/* One flowing table rather than fixed-size chunks: the browser decides where
   the page breaks fall, so the rows fit whatever paper is loaded. thead and
   tfoot repeat on every page, which is how the title and the disclaimer stay
   on each one without knowing how many pages there will be. */
const tableSection = (rows) => `<table>
    ${tableHead(rows)}
    <tfoot><tr><td colspan="6"><div class="ft">
      <span class="url">${esc(SITE_URL)}</span>
      <span>${esc(t('pdf_disclaimer'))}</span>
    </div></td></tr></tfoot>
    <tbody>${tableRows(rows)}</tbody>
  </table>`;

/* ------------------------------------------------------------ print CSS --- */

const CSS = `
@page { margin: 12mm }
#bp-report { display: none }
@media print {
  html.bp-printing, html.bp-printing body { background: #fff !important; margin: 0; padding: 0 }
  html.bp-printing body > *:not(#bp-report) { display: none !important }
  html.bp-printing #bp-report { display: block }
}
/* Reset, not inherit: the app's own h1/h2/p rules would otherwise reach in
   (its h2 is uppercase small-caps, which is wrong for a section heading here). */
#bp-report, #bp-report * { box-sizing: border-box }
#bp-report h1, #bp-report h2, #bp-report p, #bp-report table, #bp-report span {
  margin: 0; padding: 0; font-weight: 400; text-transform: none; letter-spacing: 0;
  color: inherit; font-size: inherit; line-height: inherit }
#bp-report {
  color: #141414; background: #fff;
  font: 9pt/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}

/* 100vh is the printable area of whatever paper the dialog is set to, so a
   page box fills it exactly without this code knowing the paper size. */
#bp-report .page { height: 100vh; display: flex; flex-direction: column;
  break-after: page; overflow: hidden }
#bp-report .page:last-child { break-after: auto }

#bp-report .hd { flex: none; display: flex; align-items: flex-start;
  justify-content: space-between; gap: 8mm;
  border-bottom: .5mm solid #c8c8c8; padding-bottom: 2mm; margin-bottom: 3mm }
#bp-report .hd h1 { font-size: 15pt; font-weight: 700; line-height: 1.2 }
#bp-report .hd p  { font-size: 10pt; color: #3c3c3c; padding-top: 1mm }
#bp-report .hd > span { font-size: 8pt; color: #646464; white-space: nowrap; padding-top: 1mm }
#bp-report h2 { flex: none; font-size: 11pt; font-weight: 700; padding: 2mm 0 1.5mm }

#bp-report .ft { flex: none; margin-top: auto; border-top: .5mm solid #c8c8c8;
  padding-top: 1.5mm; display: flex; flex-direction: column; align-items: flex-start;
  font-size: 7pt; line-height: 1.3; color: #969696 }
#bp-report .ft .url, #bp-report tfoot .url { align-self: flex-end }

/* --- plots: a stretched square viewBox plus HTML labels around it --- */
#bp-report .plot { flex: 1; min-height: 0; position: relative }
#bp-report .pa { position: absolute; top: 4mm; right: 22mm; bottom: 11mm; left: 9mm }
#bp-report .pa > svg { position: absolute; inset: 0; width: 100%; height: 100%;
  overflow: visible }
#bp-report .pa span { position: absolute; white-space: nowrap;
  font-size: 7.5pt; color: #646464 }
#bp-report .grid  { stroke: #e8e8e8; stroke-width: 1 }
#bp-report .axis  { stroke: #969696; stroke-width: 1.5 }
#bp-report .ref   { stroke: #a0a0a0; stroke-width: 1.2; stroke-dasharray: 5 3 }
#bp-report .serie { fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round }
#bp-report .yl { left: 0; margin-left: -2mm; transform: translate(-100%, -50%) }
#bp-report .yr { left: 100%; margin-left: 2mm; transform: translateY(-50%) }
#bp-report .rl { left: 100%; margin-left: 10mm; transform: translateY(-50%);
  font-size: 6.5pt; color: #8c8c8c }
#bp-report .xl { top: 100%; margin-top: 1.5mm; transform-origin: left top; transform: rotate(40deg) }
#bp-report .xc { top: 100%; margin-top: 1.5mm; transform: translateX(-50%) }
#bp-report .cal { transform: translate(-50%, -140%); background: #ffe632;
  border: .25mm solid #a07800; color: #3c2800; border-radius: 2mm;
  padding: .2mm 1mm; font-size: 6pt; font-weight: 700; line-height: 1.5 }
#bp-report .scat .pa { right: 4mm; left: 16mm; bottom: 13mm; top: 2mm }
#bp-report .axt { position: absolute; font-size: 7.5pt; color: #505050 }
#bp-report .xt { bottom: 0; left: 50%; transform: translateX(-50%) }
#bp-report .yt { left: 3mm; top: 50%; transform: translate(-50%, -50%) rotate(-90deg) }

/* --- overview --- */
#bp-report .zone { flex: none; height: 46mm; display: flex; gap: 8mm; align-items: center }
#bp-report .dbox { height: 100%; aspect-ratio: 1; position: relative;
  display: flex; flex-direction: column; align-items: center; justify-content: center }
#bp-report .dbox svg { width: 100%; height: 100%; min-height: 0 }
#bp-report .dcap { font-size: 7pt; color: #787878; padding-top: 1mm }
#bp-report .dn { font-size: 34px; font-weight: 700; fill: #141414 }
#bp-report .zleg { display: flex; flex-direction: column; gap: 2mm; font-size: 8.5pt }
#bp-report .zl { display: flex; align-items: center; gap: 2mm; white-space: nowrap }
#bp-report .zl i, #bp-report .stats i { width: 3mm; height: 3mm; flex: none }
#bp-report .reckey { flex: none; display: flex; align-items: center; gap: 2mm;
  font-size: 7.5pt; color: #282828; padding-bottom: 1mm }
#bp-report .reckey i { width: 16mm; height: 3mm; flex: none;
  background: ${recencyGradient()} }

/* --- stats bar and tag legend --- */
#bp-report .stats { flex: none; display: flex; align-items: center; gap: 2mm;
  padding-top: 2mm; font-size: 8pt; color: #3c3c3c; flex-wrap: wrap }
#bp-report .stats em { width: .4mm; height: 4mm; background: #c8c8c8; margin: 0 1mm; flex: none }
#bp-report .stats .sv { font-variant-numeric: tabular-nums; white-space: nowrap; margin-right: 2mm }
#bp-report .legend { flex: none; display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 0 4mm; border-top: .3mm solid #e8e8e8; margin-top: 1.5mm; padding-top: 1.5mm }
#bp-report .lg { display: flex; align-items: center; gap: 1.5mm; height: 5mm;
  font-size: 7.5pt; color: #323232; overflow: hidden; white-space: nowrap }
#bp-report .lg b { display: inline-flex; align-items: center; justify-content: center;
  min-width: 4mm; height: 3.4mm; padding: 0 .8mm; border-radius: 1.7mm; font-size: 6pt;
  background: #ffe632; border: .25mm solid #a07800; color: #3c2800; flex: none }

/* --- reading table --- */
#bp-report table { width: 100%; border-collapse: collapse; font-size: 8.5pt; table-layout: fixed }
#bp-report thead { display: table-header-group }
#bp-report tfoot { display: table-footer-group }
#bp-report .tt th { border-bottom: .5mm solid #c8c8c8; padding-bottom: 2mm }
#bp-report .tt th div { display: flex; align-items: baseline;
  justify-content: space-between; gap: 8mm; font-size: 15pt; font-weight: 700 }
#bp-report .tt .tr { font-size: 8pt; font-weight: 400; color: #646464; white-space: nowrap }
#bp-report th { text-align: left; font-weight: 700; color: #141414; height: 8mm;
  vertical-align: bottom }
#bp-report td { height: 7mm; color: #323232;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis }
#bp-report tr.alt td { background: #f8f9fa }
#bp-report tfoot td { height: 12mm; vertical-align: bottom; padding-top: 1.5mm }
#bp-report th:nth-child(1), #bp-report td:nth-child(1) { width: 38mm }
#bp-report th:nth-child(2), #bp-report td:nth-child(2),
#bp-report th:nth-child(3), #bp-report td:nth-child(3),
#bp-report th:nth-child(4), #bp-report td:nth-child(4) { width: 12mm }
#bp-report th:nth-child(5), #bp-report td:nth-child(5) { width: 22mm }
`;

/* A4 at 96 dpi, which is what one CSS pixel means, and the same in points.
   Rendered at 2x for ~192 dpi, which keeps the chart's hairlines readable
   without the file becoming absurd. */
const A4_PX = { w: 794, h: 1123 };
const A4_PT = { w: 595.28, h: 841.89 };
const RASTER_SCALE = 2;
const JPEG_QUALITY = 0.86;

/* Overrides for the copy that goes inside the SVG. Two things differ from
   print: the report is display:none until the print stylesheet reveals it, and
   there is no @page to supply a margin or size the box. Both are stated here
   outright -- 45px being 12mm at 96 dpi, the margin print gets from @page. */
const RASTER_CSS = `
#bp-report{display:block;background:#fff}
#bp-report .page{width:${A4_PX.w}px;height:${A4_PX.h}px;padding:45px;overflow:hidden}
`;

/* ------------------------------------------------- rasterised download ---- */

/* Draws one page box into a JPEG by way of an SVG foreignObject -- the browser
   renders the same DOM it would print, so every script comes out right without
   this code knowing anything about fonts. */
async function rasterisePage(el, css) {
  const html = new XMLSerializer().serializeToString(el);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${A4_PX.w}" height="${A4_PX.h}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" id="bp-report">
          <style>${css}</style>${html}
        </div>
      </foreignObject>
    </svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();

  const canvas = document.createElement('canvas');
  canvas.width = A4_PX.w * RASTER_SCALE;
  canvas.height = A4_PX.h * RASTER_SCALE;
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency; without this the page comes out black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
  return new Uint8Array(await blob.arrayBuffer());
}

/* A minimal PDF: one page per image, each drawn to fill the media box. There
   are no font objects at all, which is the whole point -- the glyphs are
   already pixels, so Arabic, Devanagari and CJK need nothing embedded. */
function buildPdf(images, px) {
  const enc = new TextEncoder();
  const parts = [];
  let len = 0;
  const put = (d) => {
    const b = typeof d === 'string' ? enc.encode(d) : d;
    parts.push(b);
    len += b.length;
  };
  const offsets = [];
  const obj = (id, dict, stream) => {
    offsets[id] = len;
    put(`${id} 0 obj\n${dict}\n`);
    if (stream !== undefined) {
      put('stream\n');
      put(stream);
      put('\nendstream\n');
    }
    put('endobj\n');
  };

  put('%PDF-1.4\n');
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));  // "this file is binary"

  const pageId = (k) => 3 + k * 3;
  const kids = images.map((_, k) => `${pageId(k)} 0 R`).join(' ');
  obj(1, '<</Type/Catalog/Pages 2 0 R>>');
  obj(2, `<</Type/Pages/Kids[${kids}]/Count ${images.length}>>`);

  const w = A4_PT.w.toFixed(2), h = A4_PT.h.toFixed(2);
  images.forEach((jpeg, k) => {
    const id = pageId(k), content = id + 1, image = id + 2;
    obj(id, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]`
          + `/Resources<</XObject<</Im0 ${image} 0 R>>>>/Contents ${content} 0 R>>`);
    const draw = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ`;
    obj(content, `<</Length ${draw.length}>>`, draw);
    obj(image, '<</Type/XObject/Subtype/Image'
             + `/Width ${px.w}/Height ${px.h}/ColorSpace/DeviceRGB`
             + `/BitsPerComponent 8/Filter/DCTDecode/Length ${jpeg.length}>>`, jpeg);
  });

  const count = 3 + images.length * 3;
  const xref = len;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  put(table);
  put(`trailer\n<</Size ${count}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}

/**
 * Builds the report and downloads it as a PDF file, with no print dialog.
 * The pages are pictures rather than text -- not selectable, and a good deal
 * larger -- which is the price of not shipping a font for every script the app
 * speaks. exportPdf is still the one to use for a searchable document.
 */
export async function exportPdfFile(all, opts = {}) {
  const html = reportHtml(all, { ...opts, paged: true });
  if (!html) return false;

  // Never inserted: the SVG lays the markup out for itself, so the live
  // document is neither measured nor disturbed.
  const host = document.createElement('div');
  host.innerHTML = html;
  {
    const pages = [...host.querySelectorAll('.page')];
    const images = [];
    for (const page of pages) images.push(await rasterisePage(page, CSS + RASTER_CSS));
    const blob = buildPdf(images, { w: A4_PX.w * RASTER_SCALE, h: A4_PX.h * RASTER_SCALE });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bp-report-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }
}

/* --------------------------------------------------------------- entry ---- */

/**
 * The report's markup. Exported separately from exportPdf so it can be rendered
 * and checked outside a browser -- the layout depends on print-time page
 * metrics, which is exactly the part worth testing.
 *
 * @param {Array}  all   every reading, any order
 * @param {object} opts  { smooth } -- average back-to-back sittings on the chart
 *                       pages, matching the dashboard's own toggle. The table
 *                       always shows the raw readings, as in the Android app.
 */
export function reportHtml(all, opts = {}) {
  const rows = [...all].sort((a, b) => a.timestamp - b.timestamp);
  if (!rows.length) return '';
  const now = Date.now();

  let html = '';
  const overview = rows.filter((r) => r.timestamp >= now - 90 * MS_DAY);
  if (overview.length >= OVERVIEW_MIN) html += overviewPage(overview);

  for (const range of buildChartRanges(rows)) {
    html += chartPage(opts.smooth ? { ...range, rows: collapseBursts(range.rows) } : range);
  }

  const table = rows.filter((r) => r.timestamp >= now - 30 * MS_DAY);
  if (table.length) {
    table.reverse();
    html += opts.paged ? tablePages(table) : tableSection(table);
  }
  return html;
}

export const reportCss = () => CSS;

export async function exportPdf(all, opts = {}) {
  const html = reportHtml(all, opts);
  if (!html) return false;

  if (!document.getElementById('bp-report-css')) {
    const style = document.createElement('style');
    style.id = 'bp-report-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  let host = document.getElementById('bp-report');
  if (!host) {
    host = document.createElement('div');
    host.id = 'bp-report';
    document.body.appendChild(host);
  }
  host.innerHTML = html;
  // Direction is inherited from <html>, so the Arabic report reads right-to-left
  // including its table columns. The plots are positioned geometrically and are
  // unaffected either way.

  // Registered before print() because some browsers fire afterprint from inside
  // the blocking call, which a listener added afterwards would miss.
  let done = false;
  const clean = () => {
    if (done) return;
    done = true;
    window.removeEventListener('afterprint', clean);
    document.documentElement.classList.remove('bp-printing');
    host.innerHTML = '';
  };
  window.addEventListener('afterprint', clean);
  setTimeout(clean, 120000);

  document.documentElement.classList.add('bp-printing');
  // Two frames: the report is display:none until the print stylesheet applies,
  // so it needs a layout pass before the dialog snapshots it.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    window.print();
  } catch {
    clean();
    return false;
  }
  return true;
}

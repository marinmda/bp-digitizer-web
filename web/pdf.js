/* The printable Blood Pressure Report, ported from ExportPdfUseCase.kt.

   Android draws into a PdfDocument canvas. Here the browser's own print
   pipeline does the rendering and the user picks "Save as PDF" -- which is
   what makes the report work in all twelve locales. A bundled PDF writer
   would have to carry embedded CJK, Devanagari and Arabic fonts (megabytes)
   and its own bidi/shaping, whereas the browser already has all of that.
   Nothing leaves the device either way.

   The layout is the same layout, expressed in millimetres rather than the
   Kotlin's 2x-A4 pixels: charts are SVG at 4 units/mm, everything else is
   ordinary flow laid out inside fixed-size page boxes. */
'use strict';

import { t, locale } from './i18n.js';
import { TAGS, CATEGORIES, ZONE_KEY, meanArterialPressure, pulsePressure } from './bp.js';
import { collapseBursts } from './aggregate.js';

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
/* Recency ramp for the scatter: oldest light, newest deep. It encodes time,
   not severity -- the dot's position already shows severity. */
const RECENCY_OLD = [0x90, 0xca, 0xf9];
const RECENCY_NEW = [0x0d, 0x47, 0xa1];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r0 = (n) => Math.round(n);
const clamp01 = (n) => Math.min(1, Math.max(0, n));

function lerpHex(a, b, k) {
  const f = clamp01(k);
  const c = a.map((v, i) => r0(v + (b[i] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

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

/* ------------------------------------------------------------- SVG bits --- */

/* Every SVG in the report is drawn at 4 units per millimetre, so a font-size
   of 15 units is 3.75 mm on paper whichever chart it appears in. Android's
   PDF is 2x A4 (5.67 px/mm); its TS_SMALL of 22 px is that same 3.9 mm. */
const U = 4;
const SVG_W = 273 * U;             // landscape content width, 273 mm
const PLOT_L = 36;
const PLOT_R = 960;                // leaves room for the reference labels
const BADGE_R = 9;

const line = (x1, y1, x2, y2, cls) =>
  `<line class="${cls}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
const text = (x, y, cls, s, extra = '') =>
  `<text class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"${extra}>${esc(s)}</text>`;

/** Yellow pill holding the concatenated tag numbers of one reading. */
function badge(cx, cy, label) {
  const halfW = Math.max(BADGE_R, label.length * 4 + 5);
  return `<rect class="bdg" x="${(cx - halfW).toFixed(1)}" y="${(cy - BADGE_R).toFixed(1)}"
    width="${(halfW * 2).toFixed(1)}" height="${(BADGE_R * 2).toFixed(1)}"
    rx="${BADGE_R}" ry="${BADGE_R}"/>`
    + text(cx, cy + BADGE_R * 0.42, 'bdg-t', label, ' text-anchor="middle"');
}

/* ---------------------------------------------------------- line chart ---- */

function chartSvg(rows, badgeAt, heightMm) {
  const H = r0(heightMm * U);
  const top = 10;
  const bottom = H - 48;                   // room for the rotated X labels
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
  const Y = (v) => bottom - ((v - yMin) / (yMax - yMin)) * (bottom - top);
  const X = (ts) => (first === last ? (PLOT_L + PLOT_R) / 2
                                    : PLOT_L + ((ts - first) / (last - first)) * (PLOT_R - PLOT_L));

  let s = '';
  const step = (yMax - yMin) <= 80 ? 10 : 20;
  for (let v = yMin; v <= yMax; v += step) {
    const y = Y(v);
    s += line(PLOT_L, y, PLOT_R, y, 'grid');
    s += text(PLOT_L - 8, y + 5, 'ax', v, ' text-anchor="end"');
    s += text(PLOT_R + 8, y + 5, 'ax', v);
  }
  for (const [v, label] of [[120, t('pdf_ref_sys', 120)], [80, t('pdf_ref_dia', 80)]]) {
    if (v < yMin || v > yMax) continue;
    const y = Y(v);
    s += line(PLOT_L, y, PLOT_R, y, 'ref');
    s += text(PLOT_R + 40, y + 5, 'reft', label);
  }

  // Up to ten X labels, spaced evenly in real time rather than by index, so
  // an irregular measuring habit is visible in the chart.
  const fmt = xLabelFmt(last - first);
  const count = Math.min(10, rows.length);
  const denom = Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const ts = first + (last - first) * i / denom;
    s += `<text class="ax" transform="translate(${X(ts).toFixed(1)},${(bottom + 16).toFixed(1)}) rotate(40)">${
      esc(fmt(ts))}</text>`;
  }

  const path = (key) => rows.map((r, i) =>
    `${i ? 'L' : 'M'}${X(r.timestamp).toFixed(1)},${Y(r[key]).toFixed(1)}`).join('');
  s += `<path class="serie" stroke="${DIA_COLOR}" d="${path('diastolic')}"/>`;
  s += `<path class="serie" stroke="${SYS_COLOR}" d="${path('systolic')}"/>`;

  const dotR = rows.length > 100 ? 2 : rows.length > 40 ? 3.5 : 5;
  rows.forEach((r, i) => {
    const x = X(r.timestamp), sy = Y(r.systolic), dy = Y(r.diastolic);
    s += `<circle cx="${x.toFixed(1)}" cy="${sy.toFixed(1)}" r="${dotR}" fill="${SYS_COLOR}"/>`;
    s += `<circle cx="${x.toFixed(1)}" cy="${dy.toFixed(1)}" r="${dotR}" fill="${DIA_COLOR}"/>`;
    if (badgeAt[i]) s += badge(x, Math.min(sy, dy) - dotR - BADGE_R - 2, badgeAt[i]);
  });

  s += line(PLOT_L, top, PLOT_L, bottom, 'axis') + line(PLOT_L, bottom, PLOT_R, bottom, 'axis');
  return `<svg class="chart" viewBox="0 0 ${SVG_W} ${H}" style="height:${heightMm}mm">${s}</svg>`;
}

/* ---------------------------------------------------------- stats bar ----- */

function statsBar(rows) {
  const sys = rows.map((r) => r.systolic);
  const dia = rows.map((r) => r.diastolic);
  const mapAvg = r0(avg(rows.map((r) => meanArterialPressure(r.systolic, r.diastolic))));
  const ppAvg = r0(avg(rows.map((r) => pulsePressure(r.systolic, r.diastolic))));
  const val = (label, v) => `<span class="sv"><b>${esc(label)}</b> ${esc(v)}</span>`;
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

const NOTE_COLS = 3;
const legendRows = (n) => Math.ceil(n / NOTE_COLS);
/* 6 mm a row, plus the rule and its padding. Kept in step with .legend in CSS
   so the page's fixed heights still add up to exactly the content box. */
const legendHeightMm = (n) => (n ? legendRows(n) * 6 + 3 : 0);

function tagLegend(tags) {
  if (!tags.length) return '';
  return `<div class="legend" style="height:${legendHeightMm(tags.length)}mm">${tags.map((k, i) =>
    `<span class="lg"><b>${i + 1}</b>${esc(`${i + 1} = ${t(k)}`)}</span>`).join('')}</div>`;
}

/* ------------------------------------------------------------- overview --- */

function donutSvg(rows) {
  const total = rows.length;
  const present = CATEGORIES.map((c) => [c, rows.filter((r) => r.category === c).length])
    .filter(([, n]) => n > 0);

  const cx = 110, cy = 140, r = 92, thickness = 34;
  const circ = 2 * Math.PI * r;
  let offset = 0, arcs = '';
  for (const [cat, n] of present) {
    const len = circ * n / total;
    arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ZONE_HEX[cat]}"
      stroke-width="${thickness}" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += len;
  }
  arcs += text(cx, cy + 12, 'donut-n', total, ' text-anchor="middle"');
  arcs += text(cx, cy + r + thickness / 2 + 28, 'donut-c', t('pdf_readings_count', total),
    ' text-anchor="middle"');

  let ly = 42;
  for (const [cat, n] of present) {
    const pct = Math.round(100 * n / total);
    arcs += `<rect x="245" y="${ly - 12}" width="16" height="16" fill="${ZONE_HEX[cat]}"/>`;
    arcs += text(272, ly + 1, 'lgd', `${t(ZONE_KEY[cat])}    ${n}  (${pct}%)`);
    ly += 44;
  }
  return `<svg viewBox="0 0 530 300">${arcs}</svg>`;
}

function scatterSvg(rows) {
  const W = 530, H = 380, left = 60, right = W - 12, top = 20, bottom = H - 64;
  const snapLo = (v) => Math.floor((v - 5) / 10) * 10;
  const snapHi = (v) => Math.ceil((v + 5) / 10) * 10;
  const sysMin = snapLo(Math.min(...rows.map((r) => r.systolic)));
  const sysMax = snapHi(Math.max(...rows.map((r) => r.systolic)));
  const diaMin = snapLo(Math.min(...rows.map((r) => r.diastolic)));
  const diaMax = snapHi(Math.max(...rows.map((r) => r.diastolic)));
  const X = (d) => left + ((d - diaMin) / (diaMax - diaMin || 1)) * (right - left);
  const Y = (s) => bottom - ((s - sysMin) / (sysMax - sysMin || 1)) * (bottom - top);

  let s = '';
  const yStep = (sysMax - sysMin) <= 80 ? 10 : 20;
  for (let v = sysMin; v <= sysMax; v += yStep) {
    s += line(left, Y(v), right, Y(v), 'grid') + text(left - 8, Y(v) + 5, 'ax', v, ' text-anchor="end"');
  }
  const xStep = (diaMax - diaMin) <= 80 ? 10 : 20;
  for (let v = diaMin; v <= diaMax; v += xStep) {
    s += line(X(v), top, X(v), bottom, 'grid')
       + text(X(v), bottom + 22, 'ax', v, ' text-anchor="middle"');
  }
  if (sysMin <= 120 && 120 <= sysMax) s += line(left, Y(120), right, Y(120), 'ref');
  if (diaMin <= 80 && 80 <= diaMax) s += line(X(80), top, X(80), bottom, 'ref');

  const tMin = Math.min(...rows.map((r) => r.timestamp));
  const tMax = Math.max(...rows.map((r) => r.timestamp));
  for (const r of rows) {
    const k = tMax > tMin ? (r.timestamp - tMin) / (tMax - tMin) : 1;
    s += `<circle cx="${X(r.diastolic).toFixed(1)}" cy="${Y(r.systolic).toFixed(1)}" r="4.5"
      fill="${lerpHex(RECENCY_OLD, RECENCY_NEW, k)}"/>`;
  }
  s += line(left, top, left, bottom, 'axis') + line(left, bottom, right, bottom, 'axis');
  s += text((left + right) / 2, bottom + 50, 'axt', t('pdf_stat_diastolic'), ' text-anchor="middle"');
  s += `<text class="axt" text-anchor="middle" transform="translate(${left - 44},${
    (top + bottom) / 2}) rotate(-90)">${esc(t('pdf_stat_systolic'))}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}">${s}</svg>`;
}

function recencyKey() {
  return `<svg class="reckey" viewBox="0 0 530 20">
    <defs><linearGradient id="rk"><stop offset="0" stop-color="rgb(${RECENCY_OLD})"/>
      <stop offset="1" stop-color="rgb(${RECENCY_NEW})"/></linearGradient></defs>
    <rect x="0" y="3" width="60" height="14" fill="url(#rk)"/>
    ${text(70, 15, 'lgd', t('scatter_colour_time'))}</svg>`;
}

/* ------------------------------------------------------------- assembly --- */

const header = (subtitle, right) => `<div class="hd">
    <div><h1>${esc(t('pdf_report_title'))}</h1><p>${esc(subtitle)}</p></div>
    <span>${esc(right)}</span>
  </div>`;

const footer = () => `<div class="ft">
    <span class="url">${esc(SITE_URL)}</span>
    <span class="disc">${esc(t('pdf_disclaimer'))}</span>
  </div>`;

function overviewPage(rows) {
  return `<section class="page land">
    ${header(`${t('pdf_overview_subtitle')}  ·  ${dateSpan(rows)}`, t('pdf_exported', dfDate(Date.now())))}
    <div class="ov">
      <div><h2>${esc(t('pdf_zone_distribution'))}</h2>${donutSvg(rows)}</div>
      <div><h2>${esc(t('pdf_sys_vs_dia'))}</h2>${recencyKey()}${scatterSvg(rows)}</div>
    </div>
    ${footer()}
  </section>`;
}

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

  // 186 mm of content: header 18, stats 9, footer 12, legend as needed.
  const chartMm = 186 - 18 - 9 - 12 - legendHeightMm(present.length);
  return `<section class="page land">
    ${header(range.heading, t('pdf_exported', dfDate(Date.now())))}
    ${chartSvg(rows, badgeAt, chartMm)}
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

/* 273 mm of content, less the 18 mm header, 8 mm column row and 12 mm footer,
   at 7 mm a row. Rows never wrap (fixed layout + ellipsis), so this is exact. */
const ROWS_PER_PAGE = 33;

function tablePages(rows) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_PAGE) chunks.push(rows.slice(i, i + ROWS_PER_PAGE));
  const total = chunks.length;
  return chunks.map((batch, ci) => `<section class="page port">
    <div class="hd">
      <h1>${esc(ci === 0 ? t('pdf_table_title') : t('pdf_table_title_cont'))}</h1>
      <span>${esc(ci === 0
        ? `${t('pdf_exported', dfDate(Date.now()))}  ·  ${t('pdf_readings_count', rows.length)}`
        : t('pdf_page_x_of_y', ci + 1, total))}</span>
    </div>
    <table>
      <thead><tr>
        <th>${esc(t('pdf_col_datetime'))}</th><th>${esc(t('pdf_col_sys'))}</th>
        <th>${esc(t('pdf_col_dia'))}</th><th>${esc(t('pdf_col_pulse'))}</th>
        <th>${esc(t('pdf_col_category'))}</th><th>${esc(t('pdf_col_notes'))}</th>
      </tr></thead>
      <tbody>${batch.map((r, i) => `<tr${i % 2 === 0 ? ' class="alt"' : ''}>
        <td>${esc(dfDateTime(r.timestamp))}</td><td>${r.systolic}</td><td>${r.diastolic}</td>
        <td>${r.pulse == null ? '—' : r.pulse}</td>
        <td style="color:${ZONE_HEX[r.category] || '#323232'}">${esc(t(ZONE_KEY[r.category] || ''))}</td>
        <td>${esc(notesCell(r))}</td></tr>`).join('')}</tbody>
    </table>
    ${footer()}
  </section>`).join('');
}

/* ------------------------------------------------------------ print CSS --- */

const CSS = `
@page land { size: A4 landscape; margin: 0 }
@page port { size: A4 portrait;  margin: 0 }
#bp-report { display: none }
@media print {
  html.bp-printing, html.bp-printing body { background: #fff !important; margin: 0; padding: 0 }
  html.bp-printing body > *:not(#bp-report) { display: none !important }
  html.bp-printing #bp-report { display: block }
}
#bp-report {
  color: #141414; background: #fff;
  font: 11pt/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
/* Every band below has a fixed height and the chart is sized to the remainder,
   so a page's parts add up to its content box exactly rather than nearly. */
#bp-report .page {
  box-sizing: border-box; padding: 12mm; background: #fff;
  display: flex; flex-direction: column; break-after: page; break-inside: avoid;
  overflow: hidden;
}
#bp-report .page:last-child { break-after: auto }
#bp-report .land { page: land; width: 297mm; height: 210mm }
#bp-report .port { page: port; width: 210mm; height: 297mm }

#bp-report .hd { box-sizing: border-box; height: 18mm; flex: none; overflow: hidden;
  display: flex; align-items: flex-start; justify-content: space-between; gap: 8mm;
  border-bottom: .5mm solid #c8c8c8 }
#bp-report .hd h1 { font-size: 16pt; margin: 0; font-weight: 700; line-height: 1.25 }
#bp-report .hd p  { font-size: 11pt; margin: 1mm 0 0; color: #3c3c3c; line-height: 1.25 }
#bp-report .hd span { font-size: 9pt; color: #646464; white-space: nowrap; padding-top: 1mm }

#bp-report .ft { box-sizing: border-box; height: 12mm; flex: none; margin-top: auto;
  border-top: .5mm solid #c8c8c8; padding-top: 1.5mm;
  display: flex; flex-direction: column; align-items: flex-start;
  font-size: 7.5pt; line-height: 1.3; color: #969696 }
#bp-report .ft .url { align-self: flex-end }

#bp-report .chart { display: block; width: 100%; flex: none }
#bp-report svg { overflow: hidden }
#bp-report svg text { font-family: inherit }
#bp-report .grid  { stroke: #e8e8e8; stroke-width: 1 }
#bp-report .axis  { stroke: #969696; stroke-width: 2 }
#bp-report .ref   { stroke: #a0a0a0; stroke-width: 1.5; stroke-dasharray: 9 5 }
#bp-report .serie { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round }
#bp-report .ax    { font-size: 15px; fill: #646464 }
#bp-report .reft  { font-size: 13px; fill: #8c8c8c }
#bp-report .axt   { font-size: 15px; fill: #505050 }
#bp-report .lgd   { font-size: 13px; fill: #282828 }
#bp-report .bdg   { fill: #ffe632; stroke: #a07800; stroke-width: 1.5 }
#bp-report .bdg-t { font-size: 12px; font-weight: 700; fill: #3c2800 }
#bp-report .donut-n { font-size: 34px; font-weight: 700; fill: #141414 }
#bp-report .donut-c { font-size: 14px; fill: #787878 }

#bp-report .stats { box-sizing: border-box; height: 9mm; flex: none;
  display: flex; align-items: center; gap: 2mm;
  font-size: 9pt; color: #3c3c3c; flex-wrap: nowrap; overflow: hidden }
#bp-report .stats i { width: 3mm; height: 3mm; flex: none }
#bp-report .stats em { width: .4mm; height: 5mm; background: #c8c8c8; margin: 0 2mm; flex: none }
#bp-report .stats .sv { font-variant-numeric: tabular-nums; white-space: nowrap; margin-right: 2mm }
#bp-report .stats .sv b { font-weight: 400; color: #3c3c3c }

#bp-report .legend { box-sizing: border-box; flex: none; overflow: hidden;
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 4mm;
  border-top: .3mm solid #e8e8e8; padding-top: 1.5mm }
#bp-report .lg { display: flex; align-items: center; gap: 2mm; height: 6mm;
  font-size: 8.5pt; color: #323232; overflow: hidden; white-space: nowrap }
#bp-report .lg b { display: inline-flex; align-items: center; justify-content: center;
  min-width: 5mm; height: 4mm; padding: 0 1mm; border-radius: 2mm; font-size: 7pt;
  background: #ffe632; border: .3mm solid #a07800; color: #3c2800; flex: none }

#bp-report .ov { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 8mm;
  align-items: start; min-height: 0 }
#bp-report .ov h2 { font-size: 12pt; margin: 0 0 3mm; font-weight: 700 }
#bp-report .ov svg { width: 100%; display: block }
#bp-report .reckey { margin-bottom: 2mm }

#bp-report table { width: 100%; border-collapse: collapse; font-size: 9pt; table-layout: fixed }
#bp-report th { text-align: left; font-weight: 700; color: #141414; height: 8mm;
  border-bottom: .5mm solid #c8c8c8 }
#bp-report td { height: 7mm; color: #323232;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis }
#bp-report tr.alt td { background: #f8f9fa }
#bp-report th:nth-child(1), #bp-report td:nth-child(1) { width: 42mm }
#bp-report th:nth-child(2), #bp-report td:nth-child(2),
#bp-report th:nth-child(3), #bp-report td:nth-child(3),
#bp-report th:nth-child(4), #bp-report td:nth-child(4) { width: 13mm }
#bp-report th:nth-child(5), #bp-report td:nth-child(5) { width: 24mm }
`;

/* --------------------------------------------------------------- entry ---- */

/**
 * Builds the report and hands it to the browser's print dialog, where the user
 * chooses "Save as PDF". Resolves once printing has been dismissed.
 *
 * @param {Array}  all     every reading, any order
 * @param {object} opts    { smooth } -- average back-to-back sittings on the
 *                         chart pages, matching the dashboard's own toggle.
 *                         The table pages always show the raw readings.
 */
export async function exportPdf(all, opts = {}) {
  const rows = [...all].sort((a, b) => a.timestamp - b.timestamp);
  if (!rows.length) return false;
  const now = Date.now();

  let html = '';
  const overview = rows.filter((r) => r.timestamp >= now - 90 * MS_DAY);
  if (overview.length >= OVERVIEW_MIN) html += overviewPage(overview);

  for (const range of buildChartRanges(rows)) {
    html += chartPage(opts.smooth ? { ...range, rows: collapseBursts(range.rows) } : range);
  }

  const table = rows.filter((r) => r.timestamp >= now - 30 * MS_DAY);
  if (table.length) html += tablePages(table.reverse());

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
  // including its table columns. The charts are SVG with explicit coordinates,
  // so they are unaffected either way.

  // Registered before print() because some browsers fire afterprint from
  // inside the blocking call, which a listener added afterwards would miss.
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

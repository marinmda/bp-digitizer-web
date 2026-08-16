/* BP Digitizer — local-first PWA.
   Readings live in IndexedDB and never leave the device unless the user
   explicitly turns on encrypted backup. The app is fully usable with no
   server at all; the server only adds OCR, backup and reminders. */
'use strict';

import * as db from './db.js';
import * as bp from './bp.js';
import { t, plural, load as loadLocale, setLocale, locale, LOCALES, fmtDate } from './i18n.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ZONE_COLOR = {
  NORMAL: 'var(--z-normal)', ELEVATED: 'var(--z-elevated)',
  STAGE_1: 'var(--z-s1)', STAGE_2: 'var(--z-s2)', HYPERTENSIVE_CRISIS: 'var(--z-crisis)',
};
const ZONE_KEY = {
  NORMAL: 'bp_category_normal', ELEVATED: 'bp_category_elevated',
  STAGE_1: 'bp_category_stage1', STAGE_2: 'bp_category_stage2',
  HYPERTENSIVE_CRISIS: 'bp_category_crisis',
};
const RISK_KEY = {
  LOW: 'cv_risk_low', MODERATE: 'cv_risk_moderate',
  HIGH: 'cv_risk_high', VERY_HIGH: 'cv_risk_very_high',
};
const RISK_COLOR = {
  LOW: 'var(--z-normal)', MODERATE: 'var(--z-elevated)',
  HIGH: 'var(--z-s2)', VERY_HIGH: 'var(--z-crisis)',
};
const RANGES = [
  { d: 7, key: 'chart_range_7d' }, { d: 30, key: 'chart_range_30d' },
  { d: 90, key: 'chart_range_90d' }, { d: 0, key: 'chart_range_all' },
];
const TAGS = ['tag_on_waking', 'tag_after_medication', 'tag_before_medication',
              'tag_exercise', 'tag_stress', 'tag_resting', 'tag_alcohol',
              'tag_caffeine', 'tag_salty_meal', 'tag_poor_sleep'];

const state = {
  view: 'dashboard', readings: [], profile: {}, rangeDays: 30,
  mode: 'trend', editing: null, selectedTags: new Set(),
};

const toast = (msg) => {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
};

/* ------------------------------------------------------------- routing -- */
function show(view) {
  state.view = view;
  for (const v of ['dashboard', 'add', 'profile', 'settings']) {
    $(`view-${v}`).hidden = v !== view;
  }
  document.querySelectorAll('.tab').forEach((b) => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------ dashboard -- */
async function refresh() {
  state.readings = await db.allReadings();
  state.profile = (await db.getKV('profile')) || {};
  renderRisk();
  renderChips();
  drawChart();
  renderHistory();
  $('hero-sub').textContent = state.readings.length
    ? `${state.readings.length}`
    : t('dashboard_empty');
}

function renderRisk() {
  const card = $('risk-card');
  const latest = state.readings[0];
  if (!latest) { card.hidden = true; return; }
  const a = bp.assess(latest.systolic, latest.diastolic, state.profile);
  card.hidden = false;
  const det = [];
  if (a.bmi != null) det.push(t('risk_card_bmi', a.bmi.toFixed(1), t(bmiKey(a.bmiCategory))));
  det.push(`MAP ${a.map} · PP ${a.pulsePressure}`);
  card.innerHTML =
    `<span class="dot" style="background:${RISK_COLOR[a.risk]}"></span>
     <div class="txt">
       <div class="lvl" style="color:${RISK_COLOR[a.risk]}">${esc(t(RISK_KEY[a.risk]))}</div>
       <div class="det">${esc(t(ZONE_KEY[a.category]))} · ${esc(det.join(' · '))}</div>
     </div>
     ${state.profile.birthYear ? '' :
       `<button class="link" id="risk-complete">${esc(t('risk_card_setup_profile'))}</button>`}`;
  const btn = $('risk-complete');
  if (btn) btn.addEventListener('click', () => { show('profile'); renderProfile(); });
}

const bmiKey = (c) => ({ UNDERWEIGHT: 'bmi_underweight', NORMAL: 'bmi_normal',
  OVERWEIGHT: 'bmi_overweight', OBESE: 'bmi_obese' }[c] || 'bmi_normal');

function renderChips() {
  $('range-chips').innerHTML = RANGES.map((r) =>
    `<button class="chip${r.d === state.rangeDays ? ' on' : ''}" data-d="${r.d}">${esc(t(r.key))}</button>`
  ).join('');
  $('mode-chips').innerHTML = ['trend', 'scatter'].map((m) =>
    `<button class="chip${m === state.mode ? ' on' : ''}" data-m="${m}">${esc(t(m === 'trend' ? 'chart_view_trend' : 'chart_view_scatter'))}</button>`
  ).join('');
  $('range-chips').querySelectorAll('[data-d]').forEach((b) =>
    b.addEventListener('click', () => {
      state.rangeDays = Number(b.dataset.d);
      db.setKV('rangeDays', state.rangeDays);
      renderChips(); drawChart(); renderHistory();
    }));
  $('mode-chips').querySelectorAll('[data-m]').forEach((b) =>
    b.addEventListener('click', () => {
      state.mode = b.dataset.m;
      db.setKV('chartMode', state.mode);
      renderChips(); drawChart();
    }));
}

const inRange = () => {
  if (!state.rangeDays) return state.readings;
  const since = Date.now() - state.rangeDays * 864e5;
  return state.readings.filter((r) => r.timestamp >= since);
};

function renderHistory() {
  const rows = inRange();
  $('history-title').textContent = t('nav_history');
  $('history-count').textContent = rows.length ? String(rows.length) : '';
  $('history').innerHTML = rows.length ? rows.map((r) => {
    const bits = [fmtDate(r.timestamp)];
    if (r.pulse) bits.push(t('dashboard_reading_pulse_format', r.pulse));
    const tags = (r.tags || '').split(',').filter(Boolean).map((x) => t(x)).join(', ');
    return `<div class="item">
        <span class="zone" style="background:${ZONE_COLOR[r.category]}"></span>
        <span class="val">${r.systolic}/${r.diastolic}<small>mmHg</small></span>
        <span class="meta"><b>${esc(t(ZONE_KEY[r.category]))}</b>${esc(bits.join(' · '))}${
          tags ? ' · ' + esc(tags) : ''}${r.notes ? '<br>' + esc(r.notes) : ''}</span>
        <button class="link del" data-del="${r.id}" aria-label="${esc(t('dashboard_cd_delete'))}">✕</button>
      </div>`;
  }).join('') : `<p class="empty">${esc(t('dashboard_empty'))}</p>`;

  $('history').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(t('dashboard_delete_confirm'))) return;
      await db.deleteReading(Number(b.dataset.del));
      toast(t('dashboard_snack_deleted'));
      refresh();
    }));
}

/* ---------------------------------------------------------------- chart -- */
function chartGeometry(svg) {
  const w = Math.max(280, Math.round(svg.clientWidth || 700));
  const h = Math.round(Math.min(320, Math.max(210, w * 0.55)));
  return { W: w, H: h, PAD: { l: 34, r: 10, t: 12, b: 26 },
           ticks: w < 380 ? 2 : w < 560 ? 3 : 5 };
}

function drawChart() {
  const svg = $('chart');
  const { W, H, PAD, ticks } = chartGeometry(svg);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  const rows = inRange().slice().sort((a, b) => a.timestamp - b.timestamp);
  if (!rows.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="axis">${
      esc(t('chart_no_readings'))}</text>`;
    $('legend').innerHTML = '';
    return;
  }
  (state.mode === 'scatter' ? drawScatter : drawTrend)(svg, rows, W, H, PAD, ticks);
}

/* The Android chart fixes the Y axis at 40–180 so charts stay comparable
   between sessions; keeping that avoids a 3 mmHg wobble filling the frame. */
const Y_MIN = 40, Y_MAX = 180;

function drawTrend(svg, rows, W, H, PAD, ticks) {
  const xs = rows.map((r) => r.timestamp);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const X = (v) => PAD.l + ((v - x0) / ((x1 - x0) || 1)) * (W - PAD.l - PAD.r);
  const Y = (v) => H - PAD.b - ((v - Y_MIN) / (Y_MAX - Y_MIN)) * (H - PAD.t - PAD.b);

  let grid = '', labels = '';
  for (let v = 40; v <= 180; v += 35) {
    grid += `<line class="grid" x1="${PAD.l}" y1="${Y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(v).toFixed(1)}"/>`;
    labels += `<text class="axis" x="4" y="${(Y(v) + 4).toFixed(1)}">${v}</text>`;
  }
  // 120 / 80 reference lines, as in the app.
  for (const v of [120, 80]) {
    grid += `<line class="refline" x1="${PAD.l}" y1="${Y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(v).toFixed(1)}"/>`;
  }
  for (let i = 0; i <= ticks; i++) {
    const ts = x0 + (i / ticks) * (x1 - x0);
    const anchor = i === 0 ? 'start' : i === ticks ? 'end' : 'middle';
    const short = (x1 - x0) < 864e5;
    labels += `<text class="axis" x="${X(ts).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}">${
      esc(fmtDate(ts, short ? { hour: '2-digit', minute: '2-digit' }
                             : { day: 'numeric', month: 'short' }))}</text>`;
  }
  const path = (key, colour) => `<path class="serie" stroke="${colour}" d="${
    rows.map((r, i) => `${i ? 'L' : 'M'}${X(r.timestamp).toFixed(1)},${Y(r[key]).toFixed(1)}`).join('')}"/>`;

  svg.innerHTML = grid + path('systolic', 'var(--accent)') + path('diastolic', 'var(--dia)')
    + labels + `<line id="cursor" class="cursor" x1="0" y1="${PAD.t}" x2="0" y2="${H - PAD.b}" style="display:none"/>`;
  $('legend').innerHTML =
    `<span><i style="background:var(--accent)"></i>${esc(t('validation_label_sys'))}</span>`
    + `<span><i style="background:var(--dia)"></i>${esc(t('validation_label_dia'))}</span>`;
  attachCursor(svg, rows, X);
}

function drawScatter(svg, rows, W, H, PAD) {
  const X = (v) => PAD.l + ((v - 40) / (140 - 40)) * (W - PAD.l - PAD.r);   // diastolic
  const Y = (v) => H - PAD.b - ((v - 70) / (220 - 70)) * (H - PAD.t - PAD.b); // systolic
  let grid = '', labels = '';
  for (let v = 70; v <= 220; v += 30) {
    grid += `<line class="grid" x1="${PAD.l}" y1="${Y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(v).toFixed(1)}"/>`;
    labels += `<text class="axis" x="4" y="${(Y(v) + 4).toFixed(1)}">${v}</text>`;
  }
  for (let v = 40; v <= 140; v += 25) {
    labels += `<text class="axis" x="${X(v).toFixed(1)}" y="${H - 6}" text-anchor="middle">${v}</text>`;
  }
  grid += `<line class="refline" x1="${PAD.l}" y1="${Y(120).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(120).toFixed(1)}"/>`
        + `<line class="refline" x1="${X(80).toFixed(1)}" y1="${PAD.t}" x2="${X(80).toFixed(1)}" y2="${H - PAD.b}"/>`;
  const dots = rows.map((r) =>
    `<circle cx="${X(r.diastolic).toFixed(1)}" cy="${Y(r.systolic).toFixed(1)}" r="4.5"
       fill="${ZONE_COLOR[r.category]}" opacity=".8" data-id="${r.id}"><title>${
       r.systolic}/${r.diastolic} — ${esc(fmtDate(r.timestamp))}</title></circle>`).join('');
  svg.innerHTML = grid + dots + labels;
  $('legend').innerHTML = Object.keys(ZONE_COLOR).map((z) =>
    `<span><i style="background:${ZONE_COLOR[z]};height:8px;width:8px;border-radius:50%"></i>${
      esc(t(ZONE_KEY[z]))}</span>`).join('');
}

function attachCursor(svg, rows, X) {
  const cursor = svg.querySelector('#cursor');
  const readout = $('readout');
  const at = (evt) => {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const cx = ((evt.touches ? evt.touches[0].clientX : evt.clientX) - r.left) / r.width * vb.width;
    let best = 0, bd = Infinity;
    rows.forEach((row, i) => {
      const d = Math.abs(X(row.timestamp) - cx);
      if (d < bd) { bd = d; best = i; }
    });
    const p = rows[best];
    cursor.setAttribute('x1', X(p.timestamp)); cursor.setAttribute('x2', X(p.timestamp));
    cursor.style.display = '';
    readout.hidden = false;
    readout.innerHTML = `${esc(fmtDate(p.timestamp))}<br><b>${p.systolic}/${p.diastolic}</b>`
      + (p.pulse ? ` · ${p.pulse} bpm` : '');
  };
  const hide = () => { cursor.style.display = 'none'; readout.hidden = true; };
  svg.onpointermove = at; svg.onpointerdown = at; svg.onpointerleave = hide;
  svg.ontouchmove = at; svg.ontouchend = hide;
}

let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.view === 'dashboard') drawChart(); }, 150);
});

/* ---------------------------------------------------------------- entry -- */
function syncPreview() {
  const s = Number($('in-sys').value), d = Number($('in-dia').value);
  const p = Number($('in-pulse').value);
  $('val-sys').textContent = s; $('val-dia').textContent = d; $('val-pulse').textContent = p;
  $('preview-sys').textContent = s; $('preview-dia').textContent = d;
  const cat = bp.categorize(s, d);
  const badge = $('preview-cat');
  badge.textContent = t(ZONE_KEY[cat]);
  badge.style.color = ZONE_COLOR[cat];
  $('preview-sys').style.color = ZONE_COLOR[cat];
  $('hemo').textContent =
    `MAP ${bp.meanArterialPressure(s, d)} · ${t('hemo_pulse_pressure')} ${bp.pulsePressure(s, d)}`;
}

async function openEntry(existing) {
  state.editing = existing || null;
  state.selectedTags = new Set((existing?.tags || '').split(',').filter(Boolean));
  // Sliders start from the last reading, as in the app: the next measurement
  // is far more likely to be near the previous one than near 120/80.
  const seed = existing || (await db.lastReading()) || { systolic: 120, diastolic: 80, pulse: 70 };
  $('in-sys').value = seed.systolic; $('in-dia').value = seed.diastolic;
  $('in-pulse').value = seed.pulse || 70;
  const when = new Date(existing?.timestamp ?? Date.now());
  when.setMinutes(when.getMinutes() - when.getTimezoneOffset());
  $('in-when').value = when.toISOString().slice(0, 16);
  $('in-notes').value = existing?.notes || '';
  renderTagPicker();
  syncPreview();
  show('add');
}

function renderTagPicker() {
  $('tag-picker').innerHTML = TAGS.map((k) =>
    `<button type="button" class="chip${state.selectedTags.has(k) ? ' on' : ''}" data-tag="${k}">${
      esc(t(k))}</button>`).join('');
  $('tag-picker').querySelectorAll('[data-tag]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.tag;
      state.selectedTags.has(k) ? state.selectedTags.delete(k) : state.selectedTags.add(k);
      renderTagPicker();
    }));
}

async function saveReading() {
  const systolic = Number($('in-sys').value);
  const diastolic = Number($('in-dia').value);
  if (diastolic >= systolic) { toast(t('validation_error_sys_dia')); return; }
  const row = {
    timestamp: $('in-when').value ? new Date($('in-when').value).getTime() : Date.now(),
    systolic, diastolic,
    pulse: Number($('in-pulse').value) || null,
    category: bp.categorize(systolic, diastolic),
    notes: $('in-notes').value.trim() || null,
    tags: [...state.selectedTags].join(','),
    source: state.editing?.source || 'manual',
  };
  if (state.editing) await db.updateReading({ ...state.editing, ...row });
  else await db.addReading(row);
  toast(t('validation_save'));
  state.editing = null;
  show('dashboard');
  refresh();
}

/* -------------------------------------------------------------- profile -- */
function renderProfile() {
  const p = state.profile || {};
  const sel = (v, o) => v === o ? ' selected' : '';
  $('profile-form').innerHTML = `
    <div class="row2">
      <div class="field"><label>${esc(t('profile_birth_year_label'))}</label>
        <input type="number" id="p-year" min="1900" max="${new Date().getFullYear()}"
               value="${p.birthYear || ''}"></div>
      <div class="field"><label>${esc(t('profile_sex_label'))}</label>
        <select id="p-sex">
          <option value=""${sel(p.sex, undefined)}>—</option>
          <option value="MALE"${sel(p.sex, 'MALE')}>${esc(t('sex_male'))}</option>
          <option value="FEMALE"${sel(p.sex, 'FEMALE')}>${esc(t('sex_female'))}</option>
          <option value="OTHER"${sel(p.sex, 'OTHER')}>${esc(t('sex_prefer_not_to_say'))}</option>
        </select></div>
    </div>
    <div class="row2">
      <div class="field"><label>${esc(t('profile_weight_label'))}</label>
        <input type="number" id="p-weight" step="0.1" value="${p.weightKg || ''}"></div>
      <div class="field"><label>${esc(t('profile_height_label'))}</label>
        <input type="number" id="p-height" step="1" value="${p.heightCm || ''}"></div>
    </div>
    <p class="muted" id="p-bmi"></p>
    <div class="field"><label>${esc(t('profile_activity_level_label'))}</label>
      <select id="p-activity">
        ${['SEDENTARY', 'LIGHTLY_ACTIVE', 'MODERATELY_ACTIVE', 'VERY_ACTIVE'].map((a) =>
          `<option value="${a}"${sel(p.activity, a)}>${esc(t('activity_desc_' + a.toLowerCase()))}</option>`).join('')}
      </select></div>
    <label class="field"><input type="checkbox" id="p-smoker" style="width:auto"${
      p.smoker ? ' checked' : ''}> ${esc(t('profile_smoker_label'))}</label>
    <label class="field"><input type="checkbox" id="p-diabetes" style="width:auto"${
      p.diabetes ? ' checked' : ''}> ${esc(t('profile_diabetes_label'))}</label>
    <div class="actions"><button class="btn" id="p-save">${esc(t('action_save'))}</button></div>`;

  const showBmi = () => {
    const v = bp.bmi(Number($('p-weight').value), Number($('p-height').value));
    $('p-bmi').textContent = v ? t('risk_card_bmi', v.toFixed(1), t(bmiKey(bp.bmiCategory(v)))) : '';
  };
  $('p-weight').addEventListener('input', showBmi);
  $('p-height').addEventListener('input', showBmi);
  showBmi();

  $('p-save').addEventListener('click', async () => {
    await db.setKV('profile', {
      birthYear: Number($('p-year').value) || null,
      sex: $('p-sex').value || null,
      weightKg: Number($('p-weight').value) || null,
      heightCm: Number($('p-height').value) || null,
      activity: $('p-activity').value,
      smoker: $('p-smoker').checked,
      diabetes: $('p-diabetes').checked,
    });
    toast(t('action_save'));
    show('dashboard');
    refresh();
  });
}

/* ------------------------------------------------------- export / import -- */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

async function exportJson() {
  const rows = await db.allReadings();
  download(`bp-${stamp()}.json`, JSON.stringify({
    app: 'bp-digitizer', version: 1, exported: new Date().toISOString(),
    profile: await db.getKV('profile'), readings: rows,
  }, null, 1), 'application/json');
}

async function exportCsv() {
  const rows = await db.allReadings();
  const head = ['timestamp', 'iso', 'systolic', 'diastolic', 'pulse', 'category', 'tags', 'notes'];
  const body = rows.map((r) => [
    r.timestamp, new Date(r.timestamp).toISOString(), r.systolic, r.diastolic,
    r.pulse ?? '', r.category, (r.tags || '').replace(/,/g, ' '),
    (r.notes || '').replace(/"/g, '""'),
  ].map((v) => (/[",\n]/.test(String(v)) ? `"${v}"` : v)).join(','));
  download(`bp-${stamp()}.csv`, [head.join(','), ...body].join('\n'), 'text/csv');
}

async function importFile(file) {
  try {
    const text = await file.text();
    let rows;
    if (file.name.endsWith('.csv')) {
      const [head, ...lines] = text.trim().split(/\r?\n/);
      const cols = head.split(',');
      rows = lines.map((l) => {
        const v = l.split(',');
        const o = Object.fromEntries(cols.map((c, i) => [c.trim(), v[i]]));
        return {
          timestamp: Number(o.timestamp) || Date.parse(o.iso),
          systolic: Number(o.systolic), diastolic: Number(o.diastolic),
          pulse: Number(o.pulse) || null,
          category: o.category || bp.categorize(Number(o.systolic), Number(o.diastolic)),
          tags: o.tags || '', notes: o.notes || null,
        };
      });
    } else {
      const data = JSON.parse(text);
      rows = data.readings || data;
      if (data.profile && !state.profile.birthYear) await db.setKV('profile', data.profile);
    }
    rows = rows.filter((r) => r.timestamp && r.systolic && r.diastolic);
    if (!rows.length) { toast(t('dashboard_snack_import_none')); return; }
    const { added, skipped } = await db.importReadings(rows);
    toast(added ? t('dashboard_snack_imported', added) + (skipped ? ` (${skipped}?)` : '')
                : t('dashboard_snack_import_none'));
    refresh();
  } catch (e) {
    toast(t('dashboard_snack_import_failed'));
  }
}

/* ------------------------------------------------------------- settings -- */
function renderSettings() {
  $('settings-body').innerHTML = `
    <div class="field">
      <label>${esc(t('settings_language'))}</label>
      <select id="s-lang">${LOCALES.map((l) =>
        `<option value="${l}"${l === locale() ? ' selected' : ''}>${
          new Intl.DisplayNames([l], { type: 'language' }).of(l)}</option>`).join('')}</select>
    </div>
    <h2 style="margin:18px 0 8px">${esc(t('dashboard_cd_export'))}</h2>
    <div class="actions" style="margin-top:0;flex-wrap:wrap">
      <button class="btn" id="s-json">${esc(t('dashboard_export_json'))}</button>
      <button class="btn" id="s-csv">${esc(t('dashboard_export_csv'))}</button>
      <button class="link" id="s-import">${esc(t('dashboard_cd_import'))}</button>
      <input type="file" id="s-file" accept=".json,.csv" hidden>
    </div>
    <p class="muted" style="margin-top:10px">${esc(t('settings_local_only_note'))}</p>
    <h2 style="margin:22px 0 8px">${esc(t('settings_danger_zone'))}</h2>
    <button class="link" id="s-wipe" style="color:var(--z-crisis)">${
      esc(t('settings_delete_all'))}</button>`;

  $('s-lang').addEventListener('change', async (e) => {
    await setLocale(e.target.value);
    applyStatic(); renderSettings(); refresh();
  });
  $('s-json').addEventListener('click', exportJson);
  $('s-csv').addEventListener('click', exportCsv);
  $('s-import').addEventListener('click', () => $('s-file').click());
  $('s-file').addEventListener('change', (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
    e.target.value = '';
  });
  $('s-wipe').addEventListener('click', async () => {
    if (!confirm(t('settings_delete_all_confirm'))) return;
    await db.wipe();
    toast(t('settings_deleted_all'));
    show('dashboard'); refresh();
  });
}

/* ---------------------------------------------------------------- boot --- */
function applyStatic() {
  $('hero-title').textContent = t('app_name');
  $('add-title').textContent = t('validation_save');
  $('profile-title').textContent = t('profile_title');
  $('settings-title').textContent = t('settings_title');
  $('lbl-sys').textContent = t('validation_subtitle_sys');
  $('lbl-dia').textContent = t('validation_subtitle_dia');
  $('lbl-pulse').textContent = t('validation_subtitle_pul');
  $('lbl-when').textContent = t('validation_timestamp');
  $('lbl-notes').textContent = t('validation_notes_label');
  $('btn-save').textContent = t('action_save');
  $('btn-cancel').textContent = t('action_cancel');
  $('tab-home').textContent = t('nav_dashboard');
  $('tab-add').textContent = t('nav_add');
  $('tab-profile').textContent = t('nav_profile');
  $('foot').textContent = t('settings_local_only_note');
  document.title = t('app_name');
}

function wire() {
  document.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.view;
      if (v === 'add') openEntry(null);
      else if (v === 'profile') { renderProfile(); show('profile'); }
      else show(v);
    }));
  $('btn-settings').addEventListener('click', () => { renderSettings(); show('settings'); });
  $('btn-add-back').addEventListener('click', () => show('dashboard'));
  $('btn-cancel').addEventListener('click', () => show('dashboard'));
  $('btn-profile-back').addEventListener('click', () => show('dashboard'));
  $('btn-settings-back').addEventListener('click', () => show('dashboard'));
  $('btn-save').addEventListener('click', saveReading);
  for (const id of ['in-sys', 'in-dia', 'in-pulse']) {
    $(id).addEventListener('input', syncPreview);
  }
}

async function boot() {
  await loadLocale();
  applyStatic();
  wire();
  state.rangeDays = (await db.getKV('rangeDays')) ?? 30;
  state.mode = (await db.getKV('chartMode')) || 'trend';
  await refresh();
  show('dashboard');
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch { /* offline still fine */ }
  }
}
boot();

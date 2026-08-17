/* Pure on-device insights engine.

   A direct port of GenerateInsightsUseCase from the Android app, thresholds
   included, so the two produce the same insights from the same history. No
   network: this is deterministic arithmetic over the reading list. */
'use strict';

import { CATEGORY, categorize } from './bp.js';

export const TONE = { POSITIVE: 'POSITIVE', NEUTRAL: 'NEUTRAL', WATCH: 'WATCH' };

const MS_PER_DAY      = 24 * 60 * 60 * 1000;
const MIN_TOTAL       = 5;    // minimum total readings before the engine runs
const MIN_SIDE        = 5;    // minimum per side for split comparisons
const MIN_DELTA       = 3.0;  // minimum mmHg difference worth surfacing
const MIN_TREND       = 7;    // minimum readings needed for a trend
const MIN_TREND_DELTA = 4.0;  // minimum projected 30-day change (mmHg)
const MIN_RANGE       = 7;    // minimum readings for time-in-range
const MIN_STREAK      = 3;    // minimum consecutive normals for a streak
const MIN_TAG         = 5;    // minimum tagged readings for a correlation
const MIN_TAG_DELTA   = 5.0;  // minimum tag effect size (mmHg)

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const cat = (r) => r.category || categorize(r.systolic, r.diastolic);
const tagsOf = (r) => String(r.tags || '').split(',').filter(Boolean);

/* Ordinary least-squares slope (y per x unit). Null when x is constant. */
function linregress(xs, ys) {
  if (xs.length < 2) return null;
  const xm = mean(xs), ym = mean(ys);
  const ssXX = xs.reduce((a, x) => a + (x - xm) ** 2, 0);
  if (ssXX === 0) return null;
  const ssXY = xs.reduce((a, x, i) => a + (x - xm) * (ys[i] - ym), 0);
  return ssXY / ssXX;
}

function morningVsEvening(rows) {
  const morning = rows.filter((r) => new Date(r.timestamp).getHours() < 12);
  const evening = rows.filter((r) => new Date(r.timestamp).getHours() >= 12);
  if (morning.length < MIN_SIDE || evening.length < MIN_SIDE) return null;

  const sysDelta = mean(morning.map((r) => r.systolic)) - mean(evening.map((r) => r.systolic));
  if (Math.abs(sysDelta) < MIN_DELTA) return null;
  const diaDelta = mean(morning.map((r) => r.diastolic)) - mean(evening.map((r) => r.diastolic));

  const args = [String(Math.round(Math.abs(sysDelta))), String(Math.round(Math.abs(diaDelta)))];
  return sysDelta > 0
    ? { kind: 'insight_morning_higher', tone: TONE.NEUTRAL, args, priority: 50 }
    : { kind: 'insight_evening_higher', tone: TONE.NEUTRAL, args, priority: 50 };
}

function trend30d(rows) {
  if (rows.length < MIN_TREND) return null;
  const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0].timestamp;
  const slope = linregress(
    sorted.map((r) => (r.timestamp - first) / MS_PER_DAY),
    sorted.map((r) => r.systolic),
  );
  if (slope == null) return null;

  const projected = slope * 30;              // projected change over 30 days
  if (Math.abs(projected) < MIN_TREND_DELTA) return null;
  const args = [String(Math.round(Math.abs(projected)))];
  return projected < 0
    ? { kind: 'insight_trend_down', tone: TONE.POSITIVE, args, priority: 85 }
    : { kind: 'insight_trend_up', tone: TONE.WATCH, args, priority: 80 };
}

function timeInRange(rows) {
  if (rows.length < MIN_RANGE) return null;
  const pct = Math.floor((rows.filter((r) => cat(r) === CATEGORY.NORMAL).length * 100) / rows.length);
  const tone = pct >= 80 ? TONE.POSITIVE : pct < 60 ? TONE.WATCH : TONE.NEUTRAL;
  return { kind: 'insight_time_in_range', tone, args: [String(pct)], priority: 65 };
}

function streak(all) {
  let count = 0;
  for (const r of [...all].sort((a, b) => b.timestamp - a.timestamp)) {
    if (cat(r) === CATEGORY.NORMAL) count++; else break;
  }
  if (count < MIN_STREAK) return null;
  return { kind: 'insight_streak', tone: TONE.POSITIVE, args: [String(count)], priority: 90 };
}

function weekdayVsWeekend(rows) {
  const isWeekend = (ts) => [0, 6].includes(new Date(ts).getDay());
  const weekday = rows.filter((r) => !isWeekend(r.timestamp));
  const weekend = rows.filter((r) => isWeekend(r.timestamp));
  if (weekday.length < MIN_SIDE || weekend.length < MIN_SIDE) return null;

  const wd = mean(weekday.map((r) => r.systolic));
  const we = mean(weekend.map((r) => r.systolic));
  if (Math.abs(wd - we) < MIN_DELTA) return null;

  const args = [String(Math.round(Math.abs(wd - we)))];
  return we > wd
    ? { kind: 'insight_weekend_higher', tone: TONE.NEUTRAL, args, priority: 40 }
    : { kind: 'insight_weekday_higher', tone: TONE.NEUTRAL, args, priority: 40 };
}

/* Only the single strongest tag signal, so the card cannot fill with noise. */
function tagCorrelations(rows) {
  if (!rows.length) return [];
  const baseline = mean(rows.map((r) => r.systolic));
  const all = new Set(rows.flatMap(tagsOf));
  const found = [];

  for (const tag of all) {
    const tagged = rows.filter((r) => tagsOf(r).includes(tag));
    if (tagged.length < MIN_TAG) continue;
    const delta = mean(tagged.map((r) => r.systolic)) - baseline;
    if (Math.abs(delta) < MIN_TAG_DELTA) continue;
    const args = [tag, String(Math.round(Math.abs(delta)))];
    found.push(delta > 0
      ? { kind: 'insight_tag_higher', tone: TONE.WATCH, args, priority: 75 }
      : { kind: 'insight_tag_lower', tone: TONE.POSITIVE, args, priority: 70 });
  }
  found.sort((a, b) => b.priority - a.priority);
  return found.slice(0, 1);
}

export function generateInsights(all) {
  if (!all || all.length < MIN_TOTAL) return [];
  const cutoff = Date.now() - 30 * MS_PER_DAY;
  const recent = all.filter((r) => r.timestamp >= cutoff);

  return [
    morningVsEvening(recent),
    trend30d(recent),
    timeInRange(recent),
    streak(all),
    weekdayVsWeekend(recent),
    ...tagCorrelations(recent),
  ].filter(Boolean).sort((a, b) => b.priority - a.priority);
}

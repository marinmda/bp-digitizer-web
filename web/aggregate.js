/* Collapses "bursts" -- several readings taken back-to-back in one sitting --
   into a single averaged point, mirroring clinical practice: AHA/ACC recommend
   averaging the two or three readings of a sitting rather than trusting any
   one of them.

   A direct port of AggregateReadingsUseCase, thresholds included. */
'use strict';

import { categorize } from './bp.js';

/** Readings closer together than this belong to the same sitting. */
export const WINDOW_MS = 10 * 60 * 1000;
/** Hard cap on one session's span, so near-threshold gaps cannot snowball. */
export const MAX_SPAN_MS = 30 * 60 * 1000;

const round = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

function aggregate(session) {
  const sys = round(session.map((r) => r.systolic));
  const dia = round(session.map((r) => r.diastolic));
  const pulses = session.map((r) => r.pulse).filter((p) => p != null);
  const notes = [...new Set(session.map((r) => (r.notes || '').trim()).filter(Boolean))];
  const tags = [...new Set(session.flatMap((r) => String(r.tags || '').split(',').filter(Boolean)))];

  return {
    ...session[0],
    timestamp: Math.round(session.reduce((a, r) => a + r.timestamp, 0) / session.length),
    systolic: sys,
    diastolic: dia,
    pulse: pulses.length ? round(pulses) : null,
    // Recomputed from the averaged pair, never averaged itself.
    category: categorize(sys, dia),
    notes: notes.join(' • ') || null,
    tags: tags.sort().join(','),
    burst: session.length,
  };
}

/* Single-linkage clustering by time gap: a reading joins the current session
   while it is within WINDOW_MS of the previous one AND the session's total span
   stays within MAX_SPAN_MS. Singletons pass through untouched. */
export function collapseBursts(readings, windowMs = WINDOW_MS, maxSpanMs = MAX_SPAN_MS) {
  if (!readings || readings.length < 2) return readings || [];
  const sorted = [...readings].sort((a, b) => a.timestamp - b.timestamp);

  const sessions = [];
  let current = [sorted[0]];
  for (const r of sorted.slice(1)) {
    const withinGap = r.timestamp - current[current.length - 1].timestamp <= windowMs;
    const withinSpan = r.timestamp - current[0].timestamp <= maxSpanMs;
    if (withinGap && withinSpan) current.push(r);
    else { sessions.push(current); current = [r]; }
  }
  sessions.push(current);

  return sessions.map((s) => (s.length === 1 ? s[0] : aggregate(s)));
}

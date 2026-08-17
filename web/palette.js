/* Chart colours shared between the dashboard and the printed report, so the
   two cannot drift apart. Kept out of bp.js, which is clinical logic with no
   presentation in it. */
'use strict';

/* Scatter dots are coloured by recency, oldest to newest -- position on the
   plot already encodes severity, so colour is free to carry time instead.
   The ramp is BPScatter3DChart's. */
export const RECENCY_OLD = [0x90, 0xca, 0xf9];   // light blue -- oldest
export const RECENCY_NEW = [0x0d, 0x47, 0xa1];   // deep blue  -- newest

/** Blend along the ramp; k is 0 for the oldest reading and 1 for the newest. */
export function recencyColor(k) {
  const f = Math.min(1, Math.max(0, k));
  const c = RECENCY_OLD.map((v, i) => Math.round(v + (RECENCY_NEW[i] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export const recencyGradient = () =>
  `linear-gradient(to right, rgb(${RECENCY_OLD}), rgb(${RECENCY_NEW}))`;

/** Position of a timestamp along the ramp. A single reading counts as newest. */
export const recencyAt = (ts, min, max) => (max > min ? (ts - min) / (max - min) : 1);

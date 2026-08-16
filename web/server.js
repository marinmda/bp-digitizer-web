/* The optional server.
   Everything here degrades to "feature absent". The app must remain fully
   usable when this file's every call fails, because self-hosters may deploy
   only the static directory. */
'use strict';

const HINT = 'bp.server.linked';
export const state = {
  // Seeded from the last confirmed probe. The server still decides -- every
  // privileged call is authorised by cookie -- but starting from the last
  // known answer stops a slow network from rendering "enter a code" at
  // someone who is already linked.
  linked: localStorage.getItem(HINT) === '1',
  features: {}, checked: false, present: null,
};

function remember(linked) {
  try { localStorage.setItem(HINT, linked ? '1' : '0'); } catch { /* private mode */ }
}

// Memoised so every caller shares one round trip, and so a view rendered
// before boot's probe finishes can await the same answer rather than
// assuming the worst.
let probing = null;
export function ready() {
  if (!probing) probing = probe();
  return probing;
}
export function reprobe() {
  probing = probe();
  return probing;
}

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.detail || `Request failed (${r.status})`);
    e.status = r.status;
    throw e;
  }
  return data;
}

/* Is a server present at all, and is this device linked to it? */
export async function probe() {
  try {
    const h = await api('/api/health');
    state.present = true;
    state.serverFeatures = { ocr: !!h.ocr, ocrLimit: h.ocr_daily_limit };
  } catch {
    // Unreachable server: report absence, but do not forget that this device
    // is linked -- that is only ever decided by a 401 below.
    state.present = false;
    state.checked = true;
    return state;
  }
  try {
    const me = await api('/api/me');
    state.linked = true;
    remember(true);
    state.features = me.features || {};
    state.device = me.device;
  } catch (e) {
    // Only a 401 is proof of not being linked. Any other failure (offline,
    // 502, DNS) leaves the previous answer standing.
    if (e.status === 401) { state.linked = false; remember(false); }
    else state.present = false;
  }
  state.checked = true;
  return state;
}

export async function redeem(code) {
  await api('/api/invites/redeem', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return reprobe();
}

/* ------------------------------------------------------------------ OCR -- */
export async function readMonitor(file) {
  const fd = new FormData();
  fd.append('image', file, file.name || 'photo.jpg');
  return api('/api/ocr', { method: 'POST', body: fd });
}

/* -------------------------------------------------- encrypted backup ----- */
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* PBKDF2 rather than a raw hash: a passphrase people can remember needs the
   work factor, or a stolen blob is brute-forced offline in minutes. */
async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase),
    'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function backup(passphrase, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    enc.encode(JSON.stringify(payload)));
  const fd = new FormData();
  fd.append('blob', new Blob([cipher], { type: 'application/octet-stream' }), 'b');
  fd.append('salt', b64(salt));
  fd.append('iv', b64(iv));
  fd.append('readings', String((payload.readings || []).length));
  return api('/api/backup', { method: 'PUT', body: fd });
}

export async function restore(passphrase) {
  const row = await api('/api/backup');
  const key = await deriveKey(passphrase, unb64(row.salt));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.iv) },
      key, unb64(row.blob));
  } catch {
    // AES-GCM fails authentication on a wrong key; there is no way to tell a
    // wrong passphrase from a corrupt blob, and no way to partially decrypt.
    const e = new Error('wrong-passphrase');
    e.code = 'wrong-passphrase';
    throw e;
  }
  return JSON.parse(dec.decode(plain));
}

export const backupInfo = () => api('/api/backup/info');
export const dropBackup = () => api('/api/backup', { method: 'DELETE' });

/* ------------------------------------------------------------ reminders -- */
export const getReminders = () => api('/api/reminders');

export const setReminders = (times, enabled) => api('/api/reminders', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    times: times.join(','), enabled,
    // The server stores an offset rather than a timezone name: it only needs
    // to know when "08:00 to this person" is, not where they live.
    tz_offset: -new Date().getTimezoneOffset(),
  }),
});

const b64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0));
};

export async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('no-push-support');
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    if (await Notification.requestPermission() !== 'granted') {
      throw new Error('permission-denied');
    }
    const { publicKey } = await api('/api/vapid');
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey),
    });
  }
  const json = sub.toJSON();
  await api('/api/push/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: json }),
  });
  return json;
}

export const testPush = (subscription) => api('/api/push/test', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ subscription }),
});

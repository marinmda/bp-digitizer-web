/* Local-first storage. Readings live in IndexedDB on the device and are
   never sent anywhere unless the user turns on encrypted backup, which
   uploads ciphertext the server cannot read. */
'use strict';

const DB_NAME = 'bpdigitizer';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('readings')) {
        const s = db.createObjectStore('readings', { keyPath: 'id', autoIncrement: true });
        // Every list and chart query is "most recent first, within a range".
        s.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function addReading(r) {
  const row = {
    timestamp: r.timestamp ?? Date.now(),
    systolic: r.systolic,
    diastolic: r.diastolic,
    pulse: r.pulse ?? null,
    category: r.category,
    notes: r.notes ?? null,
    tags: r.tags ?? '',
    source: r.source ?? 'manual',
  };
  return tx('readings', 'readwrite', (s) => s.add(row));
}

export async function updateReading(r) {
  return tx('readings', 'readwrite', (s) => s.put(r));
}

export async function deleteReading(id) {
  return tx('readings', 'readwrite', (s) => s.delete(id));
}

export async function allReadings() {
  const rows = await tx('readings', 'readonly', (s) => s.getAll());
  return (rows || []).sort((a, b) => b.timestamp - a.timestamp);
}

export async function readingsSince(ms) {
  const all = await allReadings();
  return ms ? all.filter((r) => r.timestamp >= Date.now() - ms) : all;
}

export async function lastReading() {
  const all = await allReadings();
  return all[0] || null;
}

/* Import is timestamp-deduplicated, matching the Android behaviour: a file
   imported twice must not double every point on the chart. */
export async function importReadings(rows) {
  const existing = new Set((await allReadings()).map((r) => r.timestamp));
  let added = 0, skipped = 0;
  for (const r of rows) {
    if (existing.has(r.timestamp)) { skipped++; continue; }
    await addReading(r);
    existing.add(r.timestamp);
    added++;
  }
  return { added, skipped };
}

export const getKV = (k) => tx('kv', 'readonly', (s) => s.get(k));
export const setKV = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));

export async function stats() {
  const all = await allReadings();
  return {
    count: all.length,
    first: all.length ? all[all.length - 1].timestamp : null,
    last: all.length ? all[0].timestamp : null,
  };
}

export async function wipe() {
  await tx('readings', 'readwrite', (s) => s.clear());
}

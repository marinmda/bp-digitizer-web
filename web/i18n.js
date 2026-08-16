/* Locale loading. The catalogues come straight from the Android app's
   strings.xml, so the wording is the reviewed wording rather than a
   re-translation. */
'use strict';

export const LOCALES = ['en', 'ar', 'de', 'es', 'fr', 'hi', 'ja', 'ko',
                        'pt', 'ro', 'uk', 'zh'];
export const RTL = new Set(['ar']);

let strings = {};
let current = 'en';

function pick() {
  const saved = localStorage.getItem('bp-locale');
  if (saved && LOCALES.includes(saved)) return saved;
  for (const tag of navigator.languages || [navigator.language || 'en']) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (LOCALES.includes(base)) return base;
  }
  return 'en';
}

export async function load(locale) {
  current = locale || pick();
  const res = await fetch(`/i18n/${current}.json`);
  strings = await res.json();
  document.documentElement.lang = current;
  document.documentElement.dir = RTL.has(current) ? 'rtl' : 'ltr';
  return current;
}

export function setLocale(locale) {
  localStorage.setItem('bp-locale', locale);
  return load(locale);
}

export const locale = () => current;

/* Android used %1$s / %d; the converter turned those into {0}, {1}. */
export function t(key, ...args) {
  let s = strings[key];
  if (s == null) return key;
  if (typeof s === 'object') s = s.other || Object.values(s)[0] || key;
  return String(s).replace(/\{(\d+)\}/g, (_, i) => (args[i] ?? ''));
}

export function plural(key, n, ...args) {
  const forms = strings[key];
  if (!forms || typeof forms !== 'object') return t(key, n, ...args);
  const rule = new Intl.PluralRules(current).select(n);
  const s = forms[rule] || forms.other || Object.values(forms)[0] || key;
  return String(s).replace(/\{(\d+)\}/g, (_, i) => ([n, ...args][i] ?? ''));
}

export const fmtDate = (ms, opts) =>
  new Date(ms).toLocaleString(current, opts || {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtNum = (n, d = 0) =>
  new Intl.NumberFormat(current, { minimumFractionDigits: d,
                                   maximumFractionDigits: d }).format(n);

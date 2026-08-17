/* wBP Digitizer admin. Served only on the tailnet listener, which is what
   injects X-Admin on the way to the API -- this page carries no credential of
   its own and would get 404s from the public URL. */
'use strict';

/* Where the API sits relative to this page. The tailnet listener mounts the
   BP server under /bp and this page beside it; serve the page from the API's
   own root and this becomes ''. */
const API = '/bp';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const api = (path, body, method) =>
  fetch(API + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || `Cererea a eșuat (${r.status})`);
    return data;
  });

/* This page is served over plain HTTP on the tailnet, which is not a secure
   context, so navigator.clipboard does not exist here. The deprecated
   execCommand path is the only one available. */
async function copy(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { ok = false; }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);   // iOS needs the explicit range
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
  }
  if (btn) {
    const was = btn.textContent;
    btn.textContent = ok ? 'Copiat' : 'Selectează manual';
    setTimeout(() => { btn.textContent = was; }, 1600);
  }
}

const when = (iso) => {
  if (!iso) return 'niciodată';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'chiar acum';
  if (mins < 60) return `acum ${mins} min`;
  if (mins < 60 * 24) return `acum ${Math.round(mins / 60)} h`;
  return d.toLocaleDateString('ro-RO', { day: 'numeric', month: 'short' });
};

/* when() reads backwards; an expiry reads forwards. Using the first for the
   second made a fresh invite claim it expired "chiar acum". */
const until = (iso) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'a expirat';
  const hours = Math.round(ms / 3600000);
  if (hours < 1) return 'în mai puțin de o oră';
  if (hours < 48) return `în ${hours} h`;
  return `în ${Math.round(hours / 24)} zile`;
};

/* The full ?code= link, and the steps that follow from it.

   The app redeems such a link only when it is running as an installed PWA;
   opened in a browser it shows the code with a copy button instead. So the
   link is inert until someone deliberately finishes the job from the installed
   app -- it can be tapped, previewed by a chat app, or retried as often as
   needed without spending anything. That also means the message carries the
   code where the recipient needs it, and one message is enough. */
function inviteMessage(inv) {
  return [
    'Salut! Îți trimit acces la wBP Digitizer — o aplicație pentru urmărirea',
    'tensiunii arteriale. Măsurătorile rămân pe telefonul tău, nu se trimit nicăieri.',
    '',
    '1) Deschide linkul:',
    inv.url,
    '',
    '2) Pagina îți cere să adaugi aplicația pe ecranul principal. Fă asta:',
    '• Android (Chrome): butonul „Instalează” din banner, sau meniul ⋮ →',
    '  „Adaugă la ecranul principal”',
    '• iPhone (Safari): butonul de partajare → „Add to Home Screen”',
    '',
    '3) Apasă linkul de mai sus din nou. Dacă se deschide direct în aplicație,',
    'gata — e activată.',
    '',
    '4) Dacă se deschide tot în browser (pe iPhone așa se întâmplă), apasă pe',
    'pagină „Copiază codul”, deschide aplicația de pe ecranul principal, apasă',
    'butonul camerei (cel cu lacăt) și lipește codul acolo.',
    '',
    'Linkul poate fi deschis de câte ori e nevoie — nu se consumă nimic până',
    `nu introduci codul în aplicație. Valabil ${inv.expires_in_days ?? 7} zile, un singur telefon.`,
  ].join('\n');
}

/* ------------------------------------------------------------- invites --- */
$('form-invite').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('invite-err');
  err.hidden = true;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Se creează…';
  try {
    const inv = await api('/api/admin/invites', { label: $('invite-label').value.trim() });
    $('invite-label').value = '';
    showInvite(inv);
    await load();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Creează invitație';
  }
});

function showInvite(inv) {
  const box = $('invite-result');
  box.hidden = false;
  box.innerHTML = `
    ${inv.url ? `<div class="field">
      <label for="v-link">Link</label>
      <div class="val" id="v-link">${esc(inv.url)}</div>
      <button class="btn small" data-copy="${esc(inv.url)}">Copiază</button>
    </div>` : ''}
    <div class="field">
      <label for="v-code">Cod</label>
      <div class="val code-big" id="v-code">${esc(inv.code)}</div>
      <button class="btn small" data-copy="${esc(inv.code)}">Copiază</button>
    </div>
    ${inv.url ? `<div class="field">
      <label for="v-msg">Mesaj</label>
      <div class="val" id="v-msg">Mesaj complet, cu link și pași</div>
      <button class="btn small" data-copy-msg="1">Copiază mesajul</button>
      <a class="btn small ghost" target="_blank" rel="noopener"
         href="https://wa.me/?text=${encodeURIComponent(inviteMessage(inv))}">WhatsApp</a>
    </div>` : ''}
    <p class="note">
      Un singur mesaj e de ajuns: linkul nu înregistrează nimic până când codul
      nu e introdus din aplicația instalată, iar pagina i-l arată cu un buton de
      copiere. Poate fi deschis de câte ori e nevoie.<br>
      Un singur dispozitiv, expiră în ${esc(inv.expires_in_days)} zile.
      În prima oră de la folosire codul re-leagă <em>același</em> dispozitiv,
      nu înregistrează altul — deci poate fi introdus întâi în browserul din
      chat și apoi din nou în aplicația instalată.<br>
      <strong>Pe iPhone</strong> trimite <em>codul</em>: aplicația trebuie
      adăugată întâi pe ecranul principal, iar cea instalată are stocare
      proprie, deci un cod folosit în Safari nu o înregistrează.
    </p>`;
  box.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copy(b.dataset.copy, b)));
  box.querySelectorAll('[data-copy-msg]').forEach((b) =>
    b.addEventListener('click', () => copy(inviteMessage(inv), b)));
}

/* ------------------------------------------------------------ listings --- */
let ttlDays = 7;

async function load() {
  try {
    const [d, i] = await Promise.all([
      api('/api/admin/devices'),
      api('/api/admin/invites'),
    ]);
    ttlDays = i.ttl_days ?? ttlDays;
    renderDevices(d.devices);
    renderInvites(i.invites);
  } catch (ex) {
    $('devices').innerHTML = `<p class="err">${esc(ex.message)}</p>`;
    $('invites').innerHTML = '';
  }
}

function renderDevices(devices) {
  if (!devices.length) {
    $('devices').innerHTML = '<p class="empty">Niciun dispozitiv înregistrat.</p>';
    return;
  }
  $('devices').innerHTML = devices.map((d) => `
    <div class="item${d.revoked ? ' off' : ''}">
      <div class="grow">
        <div class="name">${esc(d.label || `Dispozitiv ${d.id}`)}
          <span class="pill ${d.revoked ? 'bad' : 'ok'}">${d.revoked ? 'revocat' : 'activ'}</span>
          ${d.has_push ? '' : '<span class="pill warn">fără memento-uri</span>'}
        </div>
        <div class="meta">
          #${d.id} · înregistrat ${esc(when(d.created_at))}
          · văzut ultima dată ${esc(when(d.last_seen))}
        </div>
      </div>
      <button class="btn small ghost" data-revoke="${d.id}" data-to="${d.revoked ? 0 : 1}">
        ${d.revoked ? 'Restaurează' : 'Revocă'}
      </button>
      <button class="btn small danger" data-forget="${d.id}">Șterge</button>
    </div>`).join('');

  $('devices').querySelectorAll('[data-revoke]').forEach((b) =>
    b.addEventListener('click', async () => {
      const on = b.dataset.to === '1';
      if (on && !confirm('Revoci acest dispozitiv? Pierde imediat scanarea, '
                       + 'backupul și memento-urile. Măsurătorile din telefon rămân.')) return;
      await api(`/api/admin/devices/${b.dataset.revoke}/revoke`, { revoked: on });
      load();
    }));

  $('devices').querySelectorAll('[data-forget]').forEach((b) =>
    b.addEventListener('click', async () => {
      // Deleting cascades to the backup blob, the push subscription and the
      // reminders, so it is worth naming what goes rather than discovering it.
      if (!confirm('Ștergi definitiv acest dispozitiv? Backupul criptat, '
                 + 'abonamentul de notificări și memento-urile lui se pierd. '
                 + 'Măsurătorile din telefon rămân — sunt locale.')) return;
      await api(`/api/admin/devices/${b.dataset.forget}`, null, 'DELETE');
      load();
    }));
}

function renderInvites(invites) {
  if (!invites.length) {
    $('invites').innerHTML = '<p class="empty">Nicio invitație.</p>';
    return;
  }
  const now = Date.now();
  const row = (i) => {
    const expired = !i.used_at && new Date(i.expires_at).getTime() < now;
    const state = i.used_at ? ['ok', `folosită ${when(i.used_at)}`]
      : expired ? ['bad', 'expirată']
      : ['warn', 'în așteptare'];
    // The plaintext exists only while the invite can still register something;
    // it is wiped from the database on redemption.
    const live = i.code && !i.used_at && !expired;
    return `
      <div class="item${i.used_at || expired ? ' off' : ''}">
        <div class="grow">
          <div class="name">${esc(i.label || 'fără etichetă')}
            <span class="pill ${state[0]}">${esc(state[1])}</span>
          </div>
          <div class="meta">
            #${i.id} · creată ${esc(when(i.created_at))}
            ${i.used_at
              // invites.device_id is ON DELETE SET NULL, so a used invite whose
              // device was later deleted legitimately points at nothing.
              ? (i.device_id ? `· dispozitiv #${i.device_id}` : '· dispozitiv șters')
              : `· expiră ${esc(until(i.expires_at))}`}
            ${live ? `· <span class="code">${esc(i.code)}</span>` : ''}
          </div>
        </div>
        ${live && i.url ? `<button class="btn small ghost" data-msg="${i.id}">Mesaj</button>` : ''}
        ${live ? `<button class="btn small ghost" data-copy="${esc(i.code)}">Copiază</button>` : ''}
        ${!i.used_at ? `<button class="btn small danger" data-unvite="${i.id}">Anulează</button>` : ''}
      </div>`;
  };
  $('invites').innerHTML = invites.map(row).join('');

  $('invites').querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => copy(b.dataset.copy, b)));

  $('invites').querySelectorAll('[data-msg]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = invites.find((x) => String(x.id) === b.dataset.msg);
      // ttl_days is a property of the listing, not of a row.
      copy(inviteMessage({ ...i, expires_in_days: ttlDays }), b);
    }));

  $('invites').querySelectorAll('[data-unvite]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Anulezi această invitație? Codul nu va mai putea fi folosit.')) return;
      await api(`/api/admin/invites/${b.dataset.unvite}/revoke`);
      load();
    }));
}

load();

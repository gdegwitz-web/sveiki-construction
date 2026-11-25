'use strict';
// =====================================================================
//  Sveiki Construction — A/C Maintenance front end (Firebase & server backends)
//  All data access goes through api(method, url, body). In Firebase mode the calls are
//  answered by backend-firebase.js; in server mode they go to server.js over HTTP.
// =====================================================================
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { me: null, cache: {}, settings: null };
const CFG = window.APP_CONFIG || { backend: 'server' };
let BE = null;          // Firebase backend (when CFG.backend === 'firebase')
let tickTimer = null;
const FB = () => CFG.backend === 'firebase';

// ---------- dates & formatting ----------
// SQLite stores "YYYY-MM-DD HH:MM:SS" in UTC; everything else is ISO
function pd(s) { if (!s) return null; if (/^\d{4}-\d\d-\d\d \d/.test(s)) s = s.replace(' ', 'T') + 'Z'; const d = new Date(s); return isNaN(d) ? null : d; }
const fmtDT = s => { const d = pd(s); return d ? d.toLocaleString('en-US', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; };
const fmtT = s => { const d = pd(s); return d ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '—'; };
const fmtD = s => { const d = pd(s); return d ? d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; };
const fmtYMD = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
function fmtDur(min) { if (min == null || isNaN(min)) return '—'; min = Math.max(0, Math.round(min)); const h = Math.floor(min / 60), m = min % 60; return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`; }
const mins = (a, b) => { const x = pd(a), y = b ? pd(b) : new Date(); return x && y ? (y - x) / 60000 : null; };
const money = n => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const otCode = id => 'WO-' + String(id).padStart(5, '0');
const toLocalInput = s => { const d = pd(s); if (!d) return ''; const z = new Date(d - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };
const fromLocalInput = v => v ? new Date(v).toISOString() : null;
const today = (off = 0) => new Date(Date.now() + off * 86400e3 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const isOverdue = o => ['pendiente', 'asignada'].includes(o.status) && o.scheduled_at && pd(o.scheduled_at) < new Date();

const ST = { pendiente: 'Pending', asignada: 'Assigned', en_progreso: 'On site', completada: 'Completed', cancelada: 'Cancelled' };
const PR = { baja: 'Low', media: 'Medium', alta: 'High', urgente: 'Urgent' };
const TYPE = { correctivo: 'Corrective', preventivo: 'Preventive', any: 'Any' };
const PHOTO_KIND = { diagnostico: 'Diagnosis', antes: 'Before', despues: 'After' };
const FREQ = [[30, 'Monthly (30 days)'], [60, 'Every 2 months (60 days)'], [90, 'Quarterly (90 days)'], [120, 'Every 4 months (120 days)'], [180, 'Semiannual (180 days)'], [365, 'Annual (365 days)']];
const badgeSt = s => `<span class="badge st-${s}">${ST[s] || s}</span>`;
const badgePr = p => `<span class="badge pr-${p}">${PR[p] || p}</span>`;

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(t._h); t._h = setTimeout(() => t.className = '', 3200);
}

// ---------- data access ----------
async function api(method, url, body) {
  if (BE) {
    try { return await BE.request(method, url, body); }
    catch (e) { if (e.status === 401 && url !== '/api/me' && !/\/(login|setup)/.test(url)) { S.me = null; renderLogin(); } throw e; }
  }
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  if (r.status === 401 && !/\/(login|setup)/.test(url)) { if (url !== '/api/me') { S.me = null; renderLogin(); } throw new Error('Session expired'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : ct.includes('text/csv') ? { csv: await r.text() } : null;
  if (!r.ok) throw new Error(data?.error || 'Error ' + r.status);
  return data;
}
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { console.error(e); toast(e.message, true); } };
async function load(name, force) {
  if (!S.cache[name] || force) S.cache[name] = await api('GET', `/api/${name}`);
  return S.cache[name];
}
async function settings(force) { if (!S.settings || force) S.settings = await api('GET', '/api/settings'); return S.settings; }
function syncBrand(s) {
  const name = (s?.company_name || '').trim() || 'Sveiki App';
  document.title = `${name} — A/C Maintenance`;
}
// Image sources differ by backend: Firebase returns data URLs, the server serves files
const photoSrc = p => p.src || `/api/photos/${p.id}`;
const sigSrc = o => o.signature_src || `/api/orders/${o.id}/signature?t=${encodeURIComponent(o.signed_at || '')}`;
const logoSrc = s => s.logo_src || (s.has_logo ? `/api/logo?t=${Date.now()}` : '');

function getPos() {
  return new Promise(res => {
    if (!navigator.geolocation) return res({});
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({}), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}
// Downscale photo before upload (saves the technician's mobile data)
function compress(file, max = 1600, q = 0.8) {
  return new Promise(resolve => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => resolve(b || file), 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}
function download(name, text, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- form modal ----------
function formModal(title, fields, onSubmit, submitLabel = 'Save') {
  const dlg = $('#modal'), f = $('#modalForm');
  f.innerHTML = `<h2>${esc(title)}</h2>` + fields.map(x => {
    if (x.type === 'html') return x.html;
    const v = x.value ?? '';
    let input;
    if (x.type === 'select') input = `<select name="${x.name}" ${x.required ? 'required' : ''}>${x.options.map(o => `<option value="${esc(o[0])}" ${String(o[0]) === String(v) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
    else if (x.type === 'textarea') input = `<textarea name="${x.name}" ${x.required ? 'required' : ''} ${x.rows ? `style="min-height:${x.rows * 22}px"` : ''} ${x.placeholder ? `placeholder="${esc(x.placeholder)}"` : ''}>${esc(v)}</textarea>`;
    else input = `<input name="${x.name}" type="${x.type || 'text'}" value="${esc(v)}" ${x.required ? 'required' : ''} ${x.step ? `step="${x.step}"` : ''} ${x.min != null ? `min="${x.min}"` : ''} ${x.placeholder ? `placeholder="${esc(x.placeholder)}"` : ''} autocomplete="off">`;
    return `<div class="field ${x.half ? 'half' : ''}"><label>${esc(x.label)}</label>${input}${x.help ? `<div class="small muted">${x.help}</div>` : ''}</div>`;
  }).join('') + `<div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn pri" value="ok">${esc(submitLabel)}</button></div>`;
  fields.forEach(x => x.onchange && f.elements[x.name]?.addEventListener('change', e => x.onchange(e, f)));
  f.onsubmit = async e => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    const data = Object.fromEntries(new FormData(f));
    try { await onSubmit(data); dlg.close(); } catch (err) { console.error(err); toast(err.message, true); } finally { btn.disabled = false; }
  };
  dlg.showModal();
  return f;
}


// ---------- PWA install (Android, Desktop & iOS) ----------
let deferredInstallPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function canShowInstall() {
  return !isStandalone() && (!!deferredInstallPrompt || isIOS());
}

function updateInstallUI() {
  const show = canShowInstall();
  const topBtn = $('#btnInstall');
  if (topBtn) topBtn.hidden = !show;
  const loginBtn = $('#btnLoginInstall');
  if (loginBtn) loginBtn.hidden = !show;
}

async function triggerInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      deferredInstallPrompt = null;
      toast('Installing app…');
    }
    updateInstallUI();
    return;
  }
  if (isIOS()) {
    const dlg = $('#modal'), f = $('#modalForm');
    f.innerHTML = `<h2>Install on iPhone / iPad</h2>
      <p class="muted small" style="margin-top:0">Install Sveiki Construction directly to your home screen for full-screen access:</p>
      <ol style="padding-left:20px;line-height:1.7;margin:10px 0 16px">
        <li>Tap the <b>Share</b> button <span class="badge">⬆️</span> at the bottom of Safari.</li>
        <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
        <li>Tap <b>Add</b> in the top-right corner.</li>
      </ol>
      <div class="actions"><button class="btn pri" value="cancel">Got it</button></div>`;
    f.onsubmit = () => {};
    dlg.showModal();
  }
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  updateInstallUI();
  hideSplash();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallUI();
  toast('App installed on your device');
});

$('#btnInstall') && ($('#btnInstall').onclick = triggerInstall);

// ================= Login / setup =================
async function renderLogin() {
  $('#topbar').hidden = true;
  document.body.classList.remove('report-mode');
  document.body.classList.add('auth-mode');
  clearInterval(tickTimer);
  let needsSetup = false;
  try { needsSetup = (await api('GET', '/api/setup-status')).needsSetup; }
  catch (e) { app.innerHTML = `<div class="center"><div class="card login"><h1>Cannot connect</h1><p class="muted">${esc(e.message)}</p><button class="btn pri" onclick="location.reload()">Retry</button></div></div>`; return; }
  app.innerHTML = `<div class="center"><div class="card login">
    <img src="logo.png" alt="Sveiki App" class="login-logo">
    <h1>${needsSetup ? 'Initial setup' : 'A/C Maintenance Portal'}</h1>
    ${needsSetup ? '<p class="muted small" style="text-align:center">Create the initial <b>Developer</b> (super-admin) account. Afterwards, add the Master user and field technicians under Users.</p>' : '<p class="muted small" style="text-align:center;margin-bottom:16px">Sign in with your Sveiki Construction account</p>'}
    <form id="lf">
      ${needsSetup ? '<div class="field"><label>Name</label><input name="name" required></div>' : ''}
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div>
      <div class="field"><label>Password</label><input name="password" type="password" required minlength="${needsSetup ? 6 : 1}" autocomplete="${needsSetup ? 'new-password' : 'current-password'}"></div>
      <button class="btn pri big">${needsSetup ? 'Create developer account' : 'Sign in'}</button>
      ${!needsSetup && FB() ? '<p class="small" style="text-align:center;margin-top:12px"><button type="button" class="link" id="forgot">Forgot your password?</button></p>' : ''}
      <button type="button" class="btn" id="btnLoginInstall" style="width:100%;margin-top:10px" hidden>⬇ Install app on phone</button>
    </form></div></div>`;
  $('#lf').onsubmit = run(async e => {
    e.preventDefault();
    const b = e.target.querySelector('button.pri'); b.disabled = true;
    try { await api('POST', needsSetup ? '/api/setup' : '/api/login', Object.fromEntries(new FormData(e.target))); await boot(); }
    finally { b.disabled = false; }
  });
  $('#forgot') && ($('#forgot').onclick = run(async () => {
    const email = $('#lf').elements.email.value.trim();
    if (!email) throw new Error('Type your email first');
    await api('POST', '/api/password-reset', { email }); toast('If that email exists, a reset link was sent');
  }));
  $('#btnLoginInstall') && ($('#btnLoginInstall').onclick = triggerInstall);
  updateInstallUI();
}

// ================= Navigation =================
// ---------- permissions ----------
const can = (mod, lvl = 1) => (S.me?.perms?.[mod] || 0) >= lvl;
const isDev = () => S.me?.role === 'developer';
const fullOrders = () => can('orders', 2);
function renderNav() {
  $('#topbar').hidden = false;
  $('#whoName').textContent = `${S.me.name} · ${S.me.role_name || S.me.role}`;
  const links = [
    can('dashboard') && can('orders') && ['#/', 'Dashboard'],
    can('orders') && ['#/ordenes', 'Work orders'],
    can('field', 2) && [can('dashboard') && can('orders') ? '#/mis' : '#/', 'My work orders'],
    can('plans') && ['#/planes', 'Preventive plans'],
    can('clients') && ['#/clientes', 'Clients'],
    can('units') && ['#/equipos', 'Units'],
    can('parts') && ['#/repuestos', 'Parts'],
    can('checklists') && ['#/checklists', 'Checklists'],
    can('users') && ['#/usuarios', 'Users'],
    can('settings', 2) && ['#/ajustes', 'Settings'],
    isDev() && ['#/permisos', 'Permissions'],
  ].filter(Boolean);
  const cur = location.hash.split('?')[0] || '#/';
  $('#nav').innerHTML = links.map(([h, t]) => `<a href="${h}" class="${(cur === h || (h !== '#/' && cur.startsWith(h))) ? 'on' : ''}">${t}</a>`).join('');
  updateInstallUI();
}
$('#btnMenu').onclick = () => {
  formModal('My account', [
    { name: 'current', label: 'Current password', type: 'password' },
    { name: 'password', label: 'New password (min. 6)', type: 'password' },
  ], async d => { if (d.password) { await api('POST', '/api/me/password', d); toast('Password updated'); } }, 'Change password');
  const a = $('#modalForm .actions');
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn bad'; b.textContent = 'Sign out'; b.style.marginRight = 'auto';
  b.onclick = run(async () => { await api('POST', '/api/logout'); $('#modal').close(); S.me = null; S.cache = {}; S.settings = null; renderLogin(); });
  a.prepend(b);
};

function parseHash() {
  const [p, q] = (location.hash.slice(1) || '/').split('?');
  return { parts: p.split('/').filter(Boolean), q: Object.fromEntries(new URLSearchParams(q || '')) };
}
async function route() {
  if (!S.me) return;
  clearInterval(tickTimer);
  document.body.classList.remove('report-mode', 'auth-mode');
  renderNav();
  const { parts, q } = parseHash();
  const [a, b] = parts;
  try {
    if (a === 'orden' && b) return await viewOrder(b);
    if (a === 'reporte' && b) { if (!can('reports')) throw new Error('You do not have access to client reports.'); return await viewReport(b); }
    const guard = ok => { if (!ok) throw new Error('You do not have access to this module.'); };
    switch (a) {
      case undefined:
        if (can('dashboard') && can('orders')) return await viewDashboard(q);
        if (can('field', 2)) return await viewTechHome();
        if (can('orders')) return await viewOrders(q);
        { const first = [['planes', 'plans'], ['clientes', 'clients'], ['equipos', 'units'], ['repuestos', 'parts'], ['checklists', 'checklists'], ['usuarios', 'users']].find(([, m]) => can(m));
          if (first) { location.hash = '#/' + first[0]; return; } }
        app.innerHTML = '<div class="card empty">Your profile has no modules enabled. Contact the administrator.</div>'; return;
      case 'mis': guard(can('field', 2)); return await viewTechHome();
      case 'ordenes': guard(can('orders')); return await viewOrders(q);
      case 'planes': guard(can('plans')); return await viewPlans();
      case 'clientes': guard(can('clients')); return await viewClients();
      case 'equipos': guard(can('units')); return await viewEquipment(q);
      case 'repuestos': guard(can('parts')); return await viewParts();
      case 'checklists': guard(can('checklists')); return await viewChecklists();
      case 'usuarios': guard(can('users')); return await viewUsers();
      case 'ajustes': guard(can('settings', 2)); return await viewSettings();
      case 'permisos': guard(isDev()); return await viewPermissions();
      default: location.hash = '#/';
    }
  } catch (e) { if (!/access/i.test(e.message)) console.error(e); app.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

// ================= Technician: my work orders =================
let techTab = 'activas';
async function viewTechHome() {
  const status = techTab === 'activas' ? 'pendiente,asignada,en_progreso' : 'completada';
  const list = await api('GET', '/api/orders?mine=1&status=' + status);
  app.innerHTML = `<h1>My work orders</h1>
    <div class="tabs"><button data-t="activas" class="${techTab === 'activas' ? 'on' : ''}">Active</button><button data-t="historial" class="${techTab === 'historial' ? 'on' : ''}">Completed</button></div>
    <div class="olist">${list.length ? list.map(orderCard).join('') : `<div class="card empty">You have no ${techTab === 'activas' ? 'active' : 'completed'} work orders.</div>`}</div>`;
  app.querySelectorAll('.tabs button').forEach(b => b.onclick = run(() => { techTab = b.dataset.t; return viewTechHome(); }));
  bindOrderCards();
}
function orderCard(o) {
  const eq = [o.eq_location, o.eq_brand, o.eq_btu && o.eq_btu + ' BTU'].filter(Boolean).join(' · ');
  return `<div class="oitem p-${o.priority}" data-id="${o.id}">
    <div class="row between"><span class="t">${esc(o.client_name)}</span><span>${badgeSt(o.status)} ${['alta', 'urgente'].includes(o.priority) ? badgePr(o.priority) : ''}</span></div>
    <div class="small muted">${otCode(o.id)} · ${TYPE[o.type]}${eq ? ' · ' + esc(eq) : ''}</div>
    ${o.reported_issue ? `<div style="margin-top:6px">${esc(o.reported_issue)}</div>` : ''}
    <div class="small ${isOverdue(o) ? 'overdue' : 'muted'}" style="margin-top:6px">${o.status === 'en_progreso' ? '⏱ On site since ' + fmtT(o.arrival_at)
      : o.status === 'completada' ? 'Closed ' + fmtDT(o.departure_at) + ' · ' + fmtDur(mins(o.arrival_at, o.departure_at))
      : o.scheduled_at ? (isOverdue(o) ? '⚠ Overdue · ' : '📅 ') + fmtDT(o.scheduled_at) : 'Created ' + fmtDT(o.created_at)}</div>
  </div>`;
}
const bindOrderCards = () => app.querySelectorAll('[data-id]').forEach(el => el.onclick = () => location.hash = '#/orden/' + el.dataset.id);

// ================= Signature pad =================
function signaturePad(canvas) {
  const ctx = canvas.getContext('2d');
  let drawing = false, ink = false, last = null;
  function size() {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); clear();
  }
  function clear() {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.restore();
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b1f3a'; ink = false;
  }
  const pt = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', e => { drawing = true; last = pt(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return; const p = pt(e);
    ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke(); last = p; ink = true; e.preventDefault();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => canvas.addEventListener(t, () => drawing = false));
  size();
  return { clear, hasInk: () => ink, toBlob: () => new Promise(r => canvas.toBlob(r, 'image/png')) };
}

// ================= Work order detail (technician and master) =================
async function viewOrder(id) {
  const [o, parts] = await Promise.all([api('GET', '/api/orders/' + id), load('parts', true)]);
  renderOrder(o, parts);
}
function checklistHtml(items, editable) {
  if (!items?.length) return '';
  const checks = items.filter(i => i.kind === 'check'), done = checks.filter(i => i.value).length;
  return `<div class="card"><div class="row between"><h2 style="margin:0">Checklist</h2><span class="small muted">${done}/${checks.length} checks done</span></div>
    <div class="checklist">${items.map((it, i) => {
      if (it.kind === 'check') return editable
        ? `<label class="ck"><input type="checkbox" data-ci="${i}" ${it.value ? 'checked' : ''}><span>${esc(it.label)}</span></label>`
        : `<div class="ck ro"><span class="mark ${it.value ? 'yes' : 'no'}">${it.value ? '✓' : '✗'}</span><span>${esc(it.label)}</span></div>`;
      if (it.kind === 'number') return editable
        ? `<div class="ck num"><span>${esc(it.label)}</span><span class="inp"><input type="number" step="any" inputmode="decimal" data-ci="${i}" value="${esc(it.value)}"><em>${esc(it.unit || '')}</em></span></div>`
        : `<div class="ck num ro"><span>${esc(it.label)}</span><b>${it.value !== '' && it.value != null ? esc(it.value) + ' ' + esc(it.unit || '') : '—'}</b></div>`;
      return editable
        ? `<div class="ck txt"><span>${esc(it.label)}</span><textarea data-ci="${i}" style="min-height:50px">${esc(it.value)}</textarea></div>`
        : `<div class="ck txt ro"><span>${esc(it.label)}</span><div>${esc(it.value || '—')}</div></div>`;
    }).join('')}</div></div>`;
}
function renderOrder(o, partsCat) {
  clearInterval(tickTimer);
  const closed = ['completada', 'cancelada'].includes(o.status);
  const arrived = !!o.arrival_at;
  const full = fullOrders();
  const mine = o.technician_id === S.me.id && can('field', 2);
  const canWork = full ? o.status !== 'cancelada' : (mine && arrived && !closed);
  const canArrive = !arrived && !closed && (full || mine);
  const showCosts = can('orders') && can('parts');
  const eq = [o.eq_kind, o.eq_brand, o.eq_model, o.eq_btu && o.eq_btu + ' BTU'].filter(Boolean).join(' · ');
  const respMin = arrived ? Math.max(0, mins(o.scheduled_at || o.created_at, o.arrival_at)) : null;
  const partsTotal = o.parts.reduce((s, p) => s + p.qty * p.unit_cost, 0);
  const showSigPad = canWork && !closed;

  app.innerHTML = `
  <div class="row between noprint" style="margin-bottom:8px">
    <a class="link" href="${can('orders') ? '#/ordenes' : '#/'}">← Back</a>
    <div class="row">${full ? '<button class="btn sm" id="bEdit">Edit order</button>' : ''}${can('reports') ? `<a class="btn sm" href="#/reporte/${o.id}">📄 Client report</a>` : ''}</div>
  </div>
  <div class="card">
    <div class="row between"><h1 style="margin:0">${otCode(o.id)}</h1><div class="row">${badgeSt(o.status)}${badgePr(o.priority)}<span class="badge">${TYPE[o.type]}</span>${o.plan_id ? '<span class="badge">Plan</span>' : ''}</div></div>
    ${isOverdue(o) ? `<div class="alert">⚠ Overdue — was scheduled for ${fmtDT(o.scheduled_at)}</div>` : ''}
    <div class="grid g2" style="margin-top:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">
      <div><h3>Client</h3><b>${esc(o.client_name)}</b>${o.client_address ? `<div class="small muted">${esc(o.client_address)} · <a target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(o.client_address)}">Directions</a></div>` : ''}
        ${o.contact_name || o.contact_phone ? `<div class="small">Contact: ${esc(o.contact_name || '')} ${o.contact_phone ? `<a href="tel:${esc(o.contact_phone)}">${esc(o.contact_phone)}</a>` : ''}</div>` : ''}</div>
      <div><h3>Unit</h3>${o.equipment_id ? `<b>${esc(o.eq_location)}</b><div class="small muted">${esc(eq)}${o.eq_serial ? ' · S/N ' + esc(o.eq_serial) : ''}</div>` : '<span class="muted">No specific unit</span>'}</div>
      <div><h3>Technician</h3>${esc(o.technician_name || 'Unassigned')}${o.scheduled_at ? `<div class="small muted">Scheduled: ${fmtDT(o.scheduled_at)}</div>` : ''}</div>
    </div>
    ${o.reported_issue ? `<div style="margin-top:12px"><h3>Reported issue / task</h3>${esc(o.reported_issue)}</div>` : ''}
  </div>

  <div class="card">
    <h2>Time log</h2>
    <div class="timebox">
      <div><span>Arrival</span><b>${fmtT(o.arrival_at)}</b><span>${arrived ? fmtD(o.arrival_at) : ''}</span></div>
      <div><span>Departure</span><b>${fmtT(o.departure_at)}</b><span>${o.departure_at ? fmtD(o.departure_at) : ''}</span></div>
      <div><span>Time on site</span><b id="onsite" class="${arrived && !o.departure_at ? 'live' : ''}">${arrived ? fmtDur(mins(o.arrival_at, o.departure_at)) : '—'}</b><span>${respMin != null ? 'Response: ' + fmtDur(respMin) : ''}</span></div>
    </div>
    ${o.arrival_lat ? `<div class="small muted" style="margin-top:8px">📍 Arrival recorded with GPS: <a target="_blank" rel="noopener" href="https://maps.google.com/?q=${o.arrival_lat},${o.arrival_lng}">view map</a>${o.departure_lat ? ` · Departure: <a target="_blank" rel="noopener" href="https://maps.google.com/?q=${o.departure_lat},${o.departure_lng}">view map</a>` : ''}</div>` : ''}
    ${canArrive ? `<div style="margin-top:14px"><button class="btn pri big" id="bArrive">📍 Record arrival</button><div class="small muted" style="margin-top:6px;text-align:center">Server time${location.protocol === 'https:' || location.hostname === 'localhost' ? ' and your GPS location' : ''} will be saved.</div></div>` : ''}
  </div>

  ${!arrived && !full ? '<div class="card empty">Record your arrival to add diagnosis, checklist, photos and parts.</div>' : `
  <div class="card">
    <h2>Diagnosis</h2>
    ${canWork ? `<textarea id="fDiag" placeholder="What did you find? E.g. compressor won't start, swollen capacitor, low refrigerant pressure…">${esc(o.diagnosis || '')}</textarea>` : `<div>${esc(o.diagnosis || '—')}</div>`}
    <div class="row between" style="margin:14px 0 8px"><h3 style="margin:0">Photos (${o.photos.length})</h3>
      ${canWork ? `<div class="row"><select id="fKind" style="width:auto"><option value="diagnostico">Diagnosis</option><option value="antes">Before</option><option value="despues">After</option></select>
      <label class="btn pri camera-btn" style="margin:0;color:#fff">📷 Take photo<input type="file" accept="image/*" capture="environment" id="fPhoto" multiple></label></div>` : ''}
    </div>
    <div class="photos">${o.photos.map(p => `<div class="photo"><img loading="lazy" src="${esc(photoSrc(p))}" alt=""><span class="tag">${PHOTO_KIND[p.kind] || p.kind}</span>${canWork ? `<button class="del noprint" data-del="${esc(p.id)}" title="Delete">×</button>` : ''}</div>`).join('') || '<div class="muted small">No photos.</div>'}</div>
  </div>

  ${checklistHtml(o.checklist, canWork)}

  <div class="card">
    <h2>Parts used</h2>
    ${o.parts.length ? `<div class="tbl-wrap"><table><thead><tr><th>Part</th><th>Qty</th>${showCosts ? '<th>Cost</th>' : ''}<th></th></tr></thead><tbody>
      ${o.parts.map(p => `<tr><td>${esc(p.name)}${p.code ? ` <span class="small muted">${esc(p.code)}</span>` : ''}</td><td>${p.qty} ${esc(p.unit)}</td>${showCosts ? `<td>${money(p.qty * p.unit_cost)}</td>` : ''}<td>${canWork ? `<button class="btn sm bad noprint" data-rmpart="${esc(p.id)}">Remove</button>` : ''}</td></tr>`).join('')}
      ${showCosts ? `<tr><td colspan="2"><b>Parts total</b></td><td><b>${money(partsTotal)}</b></td><td></td></tr>` : ''}
    </tbody></table></div>` : '<div class="muted small">No parts added.</div>'}
    ${canWork ? `<div class="row noprint" style="margin-top:10px">
      <select id="fPart" style="flex:3;min-width:180px"><option value="">— Select part —</option>${partsCat.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.code ? ' (' + esc(p.code) + ')' : ''} · stock ${p.stock} ${esc(p.unit)}</option>`).join('')}</select>
      <input id="fQty" type="number" min="0.01" step="0.01" value="1" style="flex:1;min-width:70px">
      <button class="btn" id="bAddPart">Add</button></div>` : ''}
  </div>

  <div class="card">
    <h2>Work performed and sign-off</h2>
    ${canWork ? `
      <div class="field"><label>Work performed</label><textarea id="fWork" placeholder="E.g. replaced 35/5 µF capacitor, cleaned coil, recharged R410A…">${esc(o.work_done || '')}</textarea></div>
      <div class="field"><label>Recommendations to client</label><textarea id="fRec" style="min-height:60px">${esc(o.recommendations || '')}</textarea></div>
      <div class="field"><label>Received by (on-site contact signing off)</label><input id="fRecv" value="${esc(o.received_by || '')}"></div>`
    : `<div class="grid g2"><div><h3>Work performed</h3>${esc(o.work_done || '—')}</div><div><h3>Recommendations</h3>${esc(o.recommendations || '—')}</div></div><div style="margin-top:10px"><h3>Received by</h3>${esc(o.received_by || '—')}</div>`}
    <div style="margin-top:12px"><h3>Client signature</h3>
      ${o.has_signature ? `<div class="sigview" id="sigView"><img src="${esc(sigSrc(o))}" alt="Signature"><div class="small muted">Signed ${fmtDT(o.signed_at)}</div>${showSigPad ? '<button class="btn sm noprint" id="bResign">Sign again</button>' : ''}</div>` : ''}
      ${showSigPad ? `<div id="sigWrap" ${o.has_signature ? 'hidden' : ''}><canvas id="sigPad" class="sigpad"></canvas>
        <div class="row between small muted" style="margin-top:4px"><span>Ask the client to sign above with a finger</span><button type="button" class="link" id="bSigClear">Clear</button></div></div>` : ''}
      ${!o.has_signature && !showSigPad ? '<div class="muted small">Not signed.</div>' : ''}
    </div>
  </div>`}

  ${canWork && !closed && arrived ? `<div class="stickybar noprint"><div class="inner row"><button class="btn" id="bSave" style="flex:1">Save</button><button class="btn ok" id="bDepart" style="flex:2">✅ Record departure</button></div></div>` : ''}
  ${full && canWork && (closed || !arrived) ? `<div class="stickybar noprint"><div class="inner"><button class="btn pri big" id="bSave">Save changes</button></div></div>` : ''}
  `;

  if (arrived && !o.departure_at) tickTimer = setInterval(() => { const el = $('#onsite'); if (el) el.textContent = fmtDur(mins(o.arrival_at)); }, 15000);

  // --- signature pad
  let pad = null;
  if ($('#sigPad')) {
    const init = () => { pad = signaturePad($('#sigPad')); };
    if (!$('#sigWrap').hidden) init();
    $('#bSigClear').onclick = () => pad?.clear();
    $('#bResign') && ($('#bResign').onclick = () => { $('#sigWrap').hidden = false; $('#sigView').hidden = true; init(); });
  }
  const uploadSignature = async () => {
    if (!pad?.hasInk()) return null;
    const fd = new FormData(); fd.append('signature', await pad.toBlob(), 'signature.png');
    fd.append('received_by', $('#fRecv')?.value || '');
    return api('POST', `/api/orders/${o.id}/signature`, fd);
  };

  // --- collected values
  const checklistVals = () => o.checklist ? o.checklist.map((it, i) => {
    const el = app.querySelector(`[data-ci="${i}"]`);
    return { value: !el ? it.value : it.kind === 'check' ? el.checked : el.value };
  }) : undefined;
  const textVals = () => ({ diagnosis: $('#fDiag')?.value, work_done: $('#fWork')?.value, recommendations: $('#fRec')?.value, received_by: $('#fRecv')?.value, checklist: checklistVals() });
  const save = async (silent) => { const r = await api('PUT', '/api/orders/' + o.id, textVals()); if (!silent) toast('Saved'); return r; };
  ['#fDiag', '#fWork', '#fRec', '#fRecv'].forEach(s => { const el = $(s); if (el) el.addEventListener('change', run(() => save(true))); });
  app.querySelectorAll('[data-ci]').forEach(el => el.addEventListener('change', run(() => save(true))));

  const rerender = async (fresh) => renderOrder(fresh, await load('parts', true));

  $('#bArrive') && ($('#bArrive').onclick = run(async e => {
    e.target.disabled = true; e.target.textContent = 'Recording…';
    try { const pos = await getPos(); const r = await api('POST', `/api/orders/${o.id}/arrive`, pos); toast('Arrival recorded ' + fmtT(r.arrival_at)); rerender(r); }
    finally { e.target.disabled = false; }
  }));
  $('#bSave') && ($('#bSave').onclick = run(async () => { await save(true); const r = (await uploadSignature()) || await api('GET', '/api/orders/' + o.id); toast('Saved'); rerender(r); }));
  $('#bDepart') && ($('#bDepart').onclick = run(async e => {
    const v = textVals();
    if (!v.diagnosis?.trim()) { $('#fDiag').focus(); throw new Error('Enter the diagnosis before closing'); }
    const missing = (o.checklist || []).filter((it, i) => it.kind === 'check' && !v.checklist[i].value).length;
    if (missing && !confirm(`${missing} checklist item(s) not checked. Close anyway?`)) return;
    if (!o.photos.length && !confirm('No photos taken. Close the work order anyway?')) return;
    const signedNow = pad?.hasInk();
    if (!o.has_signature && !signedNow && !confirm('The client has not signed. Close anyway?')) return;
    if (!confirm('Record departure and close this work order? You will not be able to edit it afterwards.')) return;
    e.target.disabled = true;
    try {
      await save(true);
      await uploadSignature();
      const pos = await getPos();
      const r = await api('POST', `/api/orders/${o.id}/depart`, { ...v, ...pos });
      toast('Work order closed. Time on site: ' + fmtDur(mins(r.arrival_at, r.departure_at))); rerender(r);
    } finally { e.target.disabled = false; }
  }));
  $('#fPhoto') && ($('#fPhoto').onchange = run(async e => {
    const files = [...e.target.files]; if (!files.length) return;
    const kind = $('#fKind').value;
    await save(true).catch(() => {});
    for (const [i, f] of files.entries()) {
      toast(`Uploading photo ${i + 1} of ${files.length}…`);
      const fd = new FormData(); fd.append('kind', kind); fd.append('photo', await compress(f), 'photo.jpg');
      await api('POST', `/api/orders/${o.id}/photos`, fd);
    }
    toast('Photo(s) saved'); rerender(await api('GET', '/api/orders/' + o.id));
  }));
  app.querySelectorAll('[data-del]').forEach(b => b.onclick = run(async ev => {
    ev.stopPropagation(); if (!confirm('Delete this photo?')) return;
    await save(true).catch(() => {}); rerender(await api('DELETE', '/api/photos/' + b.dataset.del));
  }));
  app.querySelectorAll('.photo img').forEach(img => img.onclick = () => {
    const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${img.src}">`; lb.onclick = () => lb.remove(); document.body.append(lb);
  });
  $('#bAddPart') && ($('#bAddPart').onclick = run(async () => {
    const part_id = $('#fPart').value, qty = Number($('#fQty').value);
    if (!part_id) throw new Error('Select a part');
    if (!Number.isFinite(qty) || qty <= 0) throw new Error('Enter a valid quantity greater than 0');
    await save(true).catch(() => {});
    rerender(await api('POST', `/api/orders/${o.id}/parts`, { part_id, qty }));
    toast('Part added');
  }));
  app.querySelectorAll('[data-rmpart]').forEach(b => b.onclick = run(async () => {
    if (!confirm('Remove this part? It will be returned to stock.')) return;
    await save(true).catch(() => {});
    rerender(await api('DELETE', `/api/orders/${o.id}/parts/${b.dataset.rmpart}`));
  }));
  $('#bEdit') && ($('#bEdit').onclick = run(() => editOrderModal(o)));
}

// ================= Client report (print / save as PDF) =================
async function viewReport(id) {
  const [o, s] = await Promise.all([api('GET', '/api/orders/' + id), settings(true)]);
  document.body.classList.add('report-mode');
  const showCosts = s.report_show_costs === '1';
  const partsTotal = o.parts.reduce((t, p) => t + p.qty * p.unit_cost, 0);
  const eq = [o.eq_kind, o.eq_brand, o.eq_model, o.eq_btu && o.eq_btu + ' BTU'].filter(Boolean).join(' · ');
  const logo = logoSrc(s) || 'logo.png';
  const sec = (title, body) => body ? `<section><h3>${title}</h3>${body}</section>` : '';
  app.innerHTML = `
  <div class="row between noprint report-tools">
    <a class="link" href="#/orden/${o.id}">← Back to work order</a>
    <button class="btn pri" onclick="print()">🖨 Print / Save as PDF</button>
  </div>
  <article class="report">
    <header class="rhead">
      <div class="rco">${logo ? `<img src="${esc(logo)}" alt="">` : ''}<div><b>${esc(s.company_name)}</b>
        <div>${[s.company_address, s.company_phone, s.company_email].filter(Boolean).map(esc).join(' · ')}</div></div></div>
      <div class="rtitle"><div>SERVICE REPORT</div><b>${otCode(o.id)}</b><div>${fmtD(o.departure_at || o.arrival_at || o.created_at)}</div></div>
    </header>
    <div class="rgrid">
      <div><h3>Client</h3><b>${esc(o.client_name)}</b><div>${esc(o.client_address || '')}</div>${o.contact_name ? `<div>${esc(o.contact_name)} ${esc(o.contact_phone || '')}</div>` : ''}</div>
      <div><h3>Unit</h3>${o.equipment_id ? `<b>${esc(o.eq_location)}</b><div>${esc(eq)}</div>${o.eq_serial ? `<div>S/N ${esc(o.eq_serial)}</div>` : ''}` : '—'}</div>
      <div><h3>Service</h3><div>${TYPE[o.type]} · ${ST[o.status]}</div><div>Technician: ${esc(o.technician_name || '—')}</div></div>
    </div>
    <table class="rtimes"><tr><th>Arrival</th><th>Departure</th><th>Time on site</th></tr>
      <tr><td>${o.arrival_at ? fmtDT(o.arrival_at) : '—'}</td><td>${o.departure_at ? fmtDT(o.departure_at) : '—'}</td><td>${o.arrival_at ? fmtDur(mins(o.arrival_at, o.departure_at)) : '—'}</td></tr></table>
    ${sec('Reported issue / task', o.reported_issue && `<p>${esc(o.reported_issue)}</p>`)}
    ${sec('Diagnosis', o.diagnosis && `<p>${esc(o.diagnosis)}</p>`)}
    ${sec('Checklist', o.checklist?.length && `<table class="rtbl">${o.checklist.map(it => `<tr><td>${esc(it.label)}</td><td class="r">${it.kind === 'check' ? (it.value ? '✓ Done' : '✗ Not done') : esc(it.value || '—') + (it.kind === 'number' && it.value !== '' ? ' ' + esc(it.unit || '') : '')}</td></tr>`).join('')}</table>`)}
    ${sec('Work performed', o.work_done && `<p>${esc(o.work_done)}</p>`)}
    ${sec('Parts used', o.parts.length && `<table class="rtbl"><tr><th>Part</th><th class="r">Qty</th>${showCosts ? '<th class="r">Amount</th>' : ''}</tr>
      ${o.parts.map(p => `<tr><td>${esc(p.name)}</td><td class="r">${p.qty} ${esc(p.unit)}</td>${showCosts ? `<td class="r">${money(p.qty * p.unit_cost)}</td>` : ''}</tr>`).join('')}
      ${showCosts ? `<tr><td colspan="2"><b>Total</b></td><td class="r"><b>${money(partsTotal)}</b></td></tr>` : ''}</table>`)}
    ${sec('Recommendations', o.recommendations && `<p>${esc(o.recommendations)}</p>`)}
    ${sec('Photos', o.photos.length && `<div class="rphotos">${o.photos.map(p => `<figure><img src="${esc(photoSrc(p))}" alt=""><figcaption>${PHOTO_KIND[p.kind] || p.kind}</figcaption></figure>`).join('')}</div>`)}
    <div class="rsign">
      <div>${o.has_signature ? `<img src="${esc(sigSrc(o))}" alt="">` : '<div class="sigline"></div>'}<div class="sigcap">Client signature${o.received_by ? ' — ' + esc(o.received_by) : ''}${o.signed_at ? ' · ' + fmtDT(o.signed_at) : ''}</div></div>
      <div><div class="sigline tech">${esc(o.technician_name || '')}</div><div class="sigcap">Technician</div></div>
    </div>
    ${s.report_footer ? `<footer class="rfoot">${esc(s.report_footer)}</footer>` : ''}
  </article>`;
}

// ================= Master: create / edit work order =================
async function editOrderModal(o) {
  const [clients, equipment, techs, checklists] = await Promise.all([load('clients', true), load('equipment', true), api('GET', '/api/technicians'), load('checklists', true)]);
  const isNew = !o;
  o = o || { type: 'correctivo', priority: 'media' };
  if (!clients.length) throw new Error('Create a client first');
  const eqOpts = cid => [['', '— No specific unit —'], ...equipment.filter(e => e.client_id == cid).map(e => [e.id, [e.location, e.brand, e.btu && e.btu + ' BTU'].filter(Boolean).join(' · ')])];
  const ckOpts = [['', '— No checklist —'], ...checklists.map(c => [c.id, `${c.name} (${TYPE[c.type]})`])];
  const defaultCk = type => (checklists.find(c => c.type === type) || {}).id || '';
  const firstClient = o.client_id || clients[0]?.id;
  const optHtml = arr => arr.map(x => `<option value="${esc(x[0])}">${esc(x[1])}</option>`).join('');
  const fields = [
    { name: 'client_id', label: 'Client', type: 'select', required: true, value: firstClient, options: clients.map(c => [c.id, c.name]),
      onchange: (e, f) => { f.elements.equipment_id.innerHTML = optHtml(eqOpts(e.target.value)); } },
    { name: 'equipment_id', label: 'Unit', type: 'select', value: o.equipment_id, options: eqOpts(firstClient) },
    { name: 'type', label: 'Type', type: 'select', value: o.type, options: [['correctivo', 'Corrective (repair)'], ['preventivo', 'Preventive']], half: true,
      onchange: (e, f) => { if (f.elements.checklist_id) f.elements.checklist_id.value = defaultCk(e.target.value); } },
    { name: 'priority', label: 'Priority', type: 'select', value: o.priority, options: Object.entries(PR), half: true },
    { name: 'technician_id', label: 'Assigned technician', type: 'select', value: o.technician_id, options: [['', '— Unassigned —'], ...techs.map(u => [u.id, u.name])] },
    { name: 'scheduled_at', label: 'Scheduled date/time', type: 'datetime-local', value: toLocalInput(o.scheduled_at) },
  ];
  if (isNew) fields.push({ name: 'checklist_id', label: 'Checklist', type: 'select', value: defaultCk(o.type), options: ckOpts });
  fields.push({ name: 'reported_issue', label: 'Reported issue / task', type: 'textarea', value: o.reported_issue });
  if (!isNew) fields.push(
    { name: 'status', label: 'Status', type: 'select', value: o.status, options: Object.entries(ST) },
    { name: 'arrival_at', label: 'Correct arrival time', type: 'datetime-local', value: toLocalInput(o.arrival_at), half: true },
    { name: 'departure_at', label: 'Correct departure time', type: 'datetime-local', value: toLocalInput(o.departure_at), half: true },
  );
  formModal(isNew ? 'New work order' : 'Edit ' + otCode(o.id), fields, async d => {
    ['scheduled_at', 'arrival_at', 'departure_at'].forEach(k => { if (k in d) d[k] = fromLocalInput(d[k]); });
    if (isNew) { const r = await api('POST', '/api/orders', d); toast('Work order created'); location.hash = '#/orden/' + r.id; }
    else { const r = await api('PUT', '/api/orders/' + o.id, d); toast('Work order updated'); renderOrder(r, await load('parts', true)); }
  }, isNew ? 'Create order' : 'Save');
}

// ================= Master: dashboard =================
async function viewDashboard(q) {
  const from = q.from || today(-30), to = q.to || today();
  const s = await api('GET', `/api/stats?from=${from}&to=${to}`);
  const st = Object.fromEntries(s.byStatus.map(x => [x.status, x.n]));
  const total = s.byStatus.reduce((a, x) => a + x.n, 0);
  const maxTech = Math.max(1, ...s.byTech.map(t => t.done || 0));
  app.innerHTML = `
  <div class="row between"><h1>Dashboard</h1>
    <form class="row" id="rng"><input type="date" name="from" value="${from}" style="width:auto"><span class="muted">to</span><input type="date" name="to" value="${to}" style="width:auto"><button class="btn sm">Apply</button></form></div>
  <div class="grid g4" style="margin-bottom:14px">
    <div class="kpi"><b>${s.open}</b><span>Open work orders now</span></div>
    <div class="kpi ${s.overdue.length ? 'warn' : ''}"><b>${s.overdue.length}</b><span>Overdue preventives</span></div>
    <div class="kpi"><b>${st.en_progreso || 0}</b><span>Technicians on site now</span></div>
    <div class="kpi"><b>${st.completada || 0}</b><span>Completed in period (of ${total})</span></div>
    <div class="kpi"><b>${fmtDur(s.times.avg_onsite)}</b><span>Avg. time on site</span></div>
    <div class="kpi"><b>${fmtDur(s.times.avg_response)}</b><span>Avg. response time</span></div>
    <div class="kpi"><b>${fmtDur(s.times.total_onsite)}</b><span>Technician hours on site</span></div>
    <div class="kpi"><b>${s.upcoming}</b><span>Preventives due in next 30 days</span></div>
  </div>
  ${s.overdue.length ? `<div class="card"><h2>Overdue preventive maintenance</h2><table><thead><tr><th>WO</th><th>Client / unit</th><th>Technician</th><th>Was due</th></tr></thead><tbody>
    ${s.overdue.map(o => `<tr class="click" data-id="${o.id}"><td><b>${otCode(o.id)}</b></td><td>${esc(o.client_name)}<div class="small muted">${esc(o.eq_location || '')}</div></td><td>${esc(o.technician_name || '—')}</td><td class="overdue">${fmtDT(o.scheduled_at)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  <div class="grid g2">
    <div class="card"><h2>By technician</h2>${s.byTech.length ? `<table><thead><tr><th>Technician</th><th>Closed</th><th>Open</th><th>Avg. on site</th></tr></thead><tbody>
      ${s.byTech.map(t => `<tr class="click" data-href="#/ordenes?technician_id=${t.id}"><td>${esc(t.name)}<div class="bar"><i style="width:${(t.done || 0) / maxTech * 100}%"></i></div></td><td>${t.done || 0}</td><td>${t.open || 0}</td><td>${fmtDur(t.avg_onsite)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No technicians yet. <a href="#/usuarios">Add technician</a></div>'}</div>
    <div class="card"><h2>Most used parts</h2>${s.topParts.length ? `<table><thead><tr><th>Part</th><th>Qty</th><th>Cost</th></tr></thead><tbody>${s.topParts.map(p => `<tr><td>${esc(p.name)}</td><td>${p.qty} ${esc(p.unit)}</td><td>${money(p.cost)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No parts used in this period.</div>'}</div>
    <div class="card"><h2>Top clients by work orders</h2>${s.byClient.length ? `<table><thead><tr><th>Client</th><th>Orders</th><th>Parts</th></tr></thead><tbody>${s.byClient.map(c => `<tr><td>${esc(c.name)}</td><td>${c.n}</td><td>${money(c.parts_cost)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No work orders in this period.</div>'}</div>
    <div class="card"><h2>Low stock</h2>${s.lowStock.length ? `<table><thead><tr><th>Part</th><th>Stock</th><th>Minimum</th></tr></thead><tbody>${s.lowStock.map(p => `<tr><td>${esc(p.name)}</td><td class="overdue">${p.stock} ${esc(p.unit)}</td><td>${p.min_stock}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">All inventory is above minimum.</div>'}</div>
  </div>`;
  $('#rng').onsubmit = e => { e.preventDefault(); const d = new FormData(e.target); location.hash = `#/?from=${d.get('from')}&to=${d.get('to')}`; };
  app.querySelectorAll('[data-href]').forEach(r => r.onclick = () => location.hash = r.dataset.href);
  bindOrderCards();
}

// ================= Master: work orders =================
async function viewOrders(q) {
  const [clients, users] = await Promise.all([load('clients', true), api('GET', '/api/technicians')]);
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  const list = await api('GET', '/api/orders?' + qs);
  const opt = (arr, sel) => arr.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('');
  app.innerHTML = `
  <div class="row between"><h1>Work orders</h1><div class="row">${can('reports') ? '<button class="btn" id="bCsv">⬇ Export CSV</button>' : ''}${fullOrders() ? '<button class="btn pri" id="bNew">+ New work order</button>' : ''}</div></div>
  <form class="card row" id="flt">
    <input type="search" name="q" value="${esc(q.q || '')}" placeholder="Search WO, client, unit, issue…" style="flex:2;min-width:180px">
    <select name="status" style="flex:1;min-width:130px">${opt([['', 'All statuses'], ['pendiente,asignada,en_progreso', 'Open'], ...Object.entries(ST)], q.status)}</select>
    <select name="type" style="flex:1;min-width:120px">${opt([['', 'All types'], ['correctivo', 'Corrective'], ['preventivo', 'Preventive']], q.type)}</select>
    <select name="priority" style="flex:1;min-width:120px">${opt([['', 'All priorities'], ...Object.entries(PR)], q.priority)}</select>
    <select name="technician_id" style="flex:1;min-width:140px">${opt([['', 'All technicians'], ...users.map(u => [u.id, u.name])], q.technician_id)}</select>
    <select name="client_id" style="flex:1;min-width:140px">${opt([['', 'All clients'], ...clients.map(c => [c.id, c.name])], q.client_id)}</select>
    <input type="date" name="from" value="${q.from || ''}" style="width:auto" title="From"><input type="date" name="to" value="${q.to || ''}" style="width:auto" title="To">
    ${q.equipment_id ? `<input type="hidden" name="equipment_id" value="${esc(q.equipment_id)}"><span class="badge">Filtered by unit</span>` : ''}
    <button class="btn pri">Filter</button>
    ${qs ? '<a class="btn" href="#/ordenes">Clear</a>' : ''}
  </form>
  <div class="card tbl-wrap">${list.length ? `<table><thead><tr><th>WO</th><th>Client / unit</th><th>Technician</th><th>Status</th><th class="hide-m">Scheduled / arrival</th><th class="hide-m">On site</th><th class="hide-m">Photos</th><th class="hide-m">Parts</th></tr></thead><tbody>
    ${list.map(o => `<tr class="click" data-id="${o.id}"><td><b>${otCode(o.id)}</b><div class="small muted">${fmtD(o.created_at)}</div></td>
      <td>${esc(o.client_name)}<div class="small muted">${esc(o.eq_location || '')} ${o.type === 'preventivo' ? '· Preventive' : ''}</div></td>
      <td>${esc(o.technician_name || '—')}</td><td>${badgeSt(o.status)} ${['alta', 'urgente'].includes(o.priority) ? badgePr(o.priority) : ''}</td>
      <td class="hide-m ${isOverdue(o) ? 'overdue' : ''}">${o.arrival_at ? fmtDT(o.arrival_at) : o.scheduled_at ? (isOverdue(o) ? '⚠ ' : '📅 ') + fmtDT(o.scheduled_at) : '—'}</td><td class="hide-m">${o.arrival_at ? fmtDur(mins(o.arrival_at, o.departure_at)) : '—'}</td>
      <td class="hide-m">${o.photo_count}</td><td class="hide-m">${money(o.parts_cost)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No work orders match these filters.</div>'}</div>`;
  $('#bNew') && ($('#bNew').onclick = run(() => editOrderModal(null)));
  $('#bCsv') && ($('#bCsv').onclick = run(async () => {
    const r = await api('GET', `/api/reports/orders.csv?from=${q.from || ''}&to=${q.to || ''}`);
    download(`work_orders_${q.from || 'all'}_${q.to || today()}.csv`, r.csv);
  }));
  $('#flt').onsubmit = e => { e.preventDefault(); location.hash = '#/ordenes?' + new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v)).toString(); };
  bindOrderCards();
}

// ================= Master: preventive plans =================
async function viewPlans() {
  const [plans, clients, equipment, users, checklists, s] = await Promise.all([api('GET', '/api/plans'), load('clients', true), load('equipment', true), api('GET', '/api/technicians'), load('checklists', true), settings(true)]);
  const techs = users;
  const editable = can('plans', 2);
  const prevCk = (checklists.find(c => c.type === 'preventivo') || {}).id || '';
  const ckOpts = [['', '— No checklist —'], ...checklists.map(c => [c.id, c.name])];
  const techOpts = [['', '— Unassigned —'], ...techs.map(u => [u.id, u.name])];
  const freqOpts = r => { const v = r?.every_days || 90; return FREQ.some(f => f[0] == v) ? FREQ : [...FREQ, [v, `Every ${v} days`]]; };
  const optHtml = arr => arr.map(x => `<option value="${esc(x[0])}">${esc(x[1])}</option>`).join('');
  const eqOpts = cid => { const list = equipment.filter(e => e.client_id == cid); return [['all', `★ All units of this client (${list.length})`], ...list.map(e => [e.id, [e.location, e.kind, e.btu && e.btu + ' BTU'].filter(Boolean).join(' · ')])]; };

  const form = r => {
    if (!r && !equipment.length) throw new Error('Add units first (Units page)');
    const firstClient = clients[0]?.id;
    const fields = r ? [
      { type: 'html', html: `<p class="muted" style="margin-top:-6px"><b>${esc(r.client_name)}</b> · ${esc(r.location)}</p>` },
    ] : [
      { name: 'client_id', label: 'Client', type: 'select', required: true, value: firstClient, options: clients.map(c => [c.id, c.name]),
        onchange: (e, f) => { f.elements.equipment_id.innerHTML = optHtml(eqOpts(e.target.value)); } },
      { name: 'equipment_id', label: 'Unit(s)', type: 'select', required: true, value: 'all', options: eqOpts(firstClient) },
    ];
    fields.push(
      { name: 'every_days', label: 'Frequency', type: 'select', value: r?.every_days || 90, options: freqOpts(r), half: true },
      { name: 'next_due', label: r ? 'Next due date' : 'First due date', type: 'date', required: true, value: r?.next_due || today(), half: true },
      { name: 'technician_id', label: 'Default technician', type: 'select', value: r?.technician_id, options: techOpts },
      { name: 'checklist_id', label: 'Checklist', type: 'select', value: r ? r.checklist_id : prevCk, options: ckOpts, half: true },
      { name: 'priority', label: 'Priority', type: 'select', value: r?.priority || 'media', options: Object.entries(PR), half: true },
      { name: 'task', label: 'Task description (shown on the work order)', type: 'textarea', value: r?.task, placeholder: 'E.g. Quarterly maintenance: clean filters and coils, check drain and electrical.' },
    );
    if (r) fields.push({ name: 'active', label: 'Status', type: 'select', value: r.active ?? 1, options: [[1, 'Active'], [0, 'Paused']] });
    formModal(r ? 'Edit preventive plan' : 'New preventive plan', fields, async d => {
      if (d.active != null) d.active = +d.active;
      const res = await api(r ? 'PUT' : 'POST', '/api/plans' + (r ? '/' + r.id : ''), d);
      toast(`${res.plans ? res.plans + ' plan(s) saved' : 'Plan saved'}${res.orders ? ` · ${res.orders} work order(s) generated` : ''}`);
      viewPlans();
    });
  };
  const due = p => p.next_due <= today();
  app.innerHTML = `
  <div class="row between"><h1>Preventive plans</h1>${editable ? '<div class="row"><button class="btn" id="bRun">⟳ Generate due orders now</button><button class="btn pri" id="bNew">+ New plan</button></div>' : ''}</div>
  <p class="muted small" style="margin-top:-6px">Work orders are created automatically ${esc(s.preventive_lead_days)} day(s) before each due date${FB() ? ' (checked every time a master opens the app)' : ' (checked every hour)'}. Change the lead time in Settings.</p>
  <div class="card tbl-wrap">${plans.length ? `<table><thead><tr><th>Client / unit</th><th>Frequency</th><th>Next due</th><th class="hide-m">Technician</th><th class="hide-m">Checklist</th><th>Open order</th></tr></thead><tbody>
  ${plans.map((p, i) => `<tr class="click" data-i="${i}" style="${p.active ? '' : 'opacity:.5'}"><td><b>${esc(p.client_name)}</b><div class="small muted">${esc(p.location)}${p.kind ? ' · ' + esc(p.kind) : ''}</div></td>
    <td>${(FREQ.find(f => f[0] == p.every_days) || [, `Every ${p.every_days} days`])[1].replace(/ \(.*\)/, '')}</td>
    <td class="${due(p) ? 'overdue' : ''}">${fmtYMD(p.next_due)}${p.active ? '' : ' · paused'}</td><td class="hide-m">${esc(p.technician_name || '—')}</td><td class="hide-m small">${esc(p.checklist_name || '—')}</td>
    <td>${p.open_order_id ? `<a class="link" href="#/orden/${p.open_order_id}" onclick="event.stopPropagation()">${otCode(p.open_order_id)}</a>` : p.open_orders ? `${p.open_orders} open` : '—'}</td></tr>`).join('')}
  </tbody></table>` : '<div class="empty">No preventive plans yet. Create one per unit, or for all units of a client at once.</div>'}</div>`;
  if (!editable) { app.querySelectorAll('tr.click').forEach(tr => tr.classList.remove('click')); return; }
  $('#bNew').onclick = run(() => form());
  $('#bRun').onclick = run(async () => { const r = await api('POST', '/api/plans/run'); toast(r.orders ? `${r.orders} work order(s) generated` : 'Nothing due right now'); viewPlans(); });
  app.querySelectorAll('[data-i]').forEach(tr => tr.onclick = run(() => form(plans[tr.dataset.i])));
}

// ================= Master: catalogs =================
function catalogView({ title, rows, cols, onNew, onEdit, extra = '', editable = true, canEditRow = () => true }) {
  app.innerHTML = `<div class="row between"><h1>${title}</h1>${editable ? '<button class="btn pri" id="bNew">+ New</button>' : '<span class="badge">View only</span>'}</div>${extra}
  <div class="card tbl-wrap">${rows.length ? `<table><thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${c.h}</th>`).join('')}</tr></thead><tbody>
  ${rows.map((r, i) => `<tr class="${editable && canEditRow(r) ? 'click' : ''}" data-i="${i}" style="${r.active === 0 || r.active === false ? 'opacity:.5' : ''}">${cols.map(c => `<td class="${c.cls || ''}">${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty">No records yet.</div>'}</div>`;
  if (!editable) return;
  $('#bNew').onclick = run(onNew);
  app.querySelectorAll('tr.click[data-i]').forEach(tr => tr.onclick = run(() => onEdit(rows[tr.dataset.i])));
}
const activeField = r => ({ name: 'active', label: 'Status', type: 'select', value: r.active === 0 || r.active === false ? 0 : 1, options: [[1, 'Active'], [0, 'Inactive']] });
const saveCat = (name, r, back) => async d => {
  if ('active' in d) d.active = +d.active;
  await api(r?.id ? 'PUT' : 'POST', `/api/${name}${r?.id ? '/' + r.id : ''}`, d); delete S.cache[name]; toast('Saved'); back();
};

async function viewClients() {
  const rows = await api('GET', '/api/clients?all=1');
  const form = r => formModal(r ? 'Edit client' : 'New client', [
    { name: 'name', label: 'Name', required: true, value: r?.name },
    { name: 'type', label: 'Type', type: 'select', value: r?.type || 'hotel', options: [['hotel', 'Hotel'], ['condominio', 'Condominium'], ['otro', 'Other']] },
    { name: 'address', label: 'Address', value: r?.address },
    { name: 'contact_name', label: 'Contact person', value: r?.contact_name, half: true },
    { name: 'contact_phone', label: 'Phone', type: 'tel', value: r?.contact_phone, half: true },
    { name: 'notes', label: 'Notes (access, hours…)', type: 'textarea', value: r?.notes },
    ...(r ? [activeField(r)] : []),
  ], saveCat('clients', r, viewClients));
  catalogView({
    title: 'Clients', rows, editable: can('clients', 2), onNew: () => form(), onEdit: form,
    cols: [{ h: 'Name', f: r => `<b>${esc(r.name)}</b><div class="small muted">${esc(r.address || '')}</div>` },
      { h: 'Type', f: r => esc({ hotel: 'Hotel', condominio: 'Condominium' }[r.type] || 'Other') },
      { h: 'Contact', cls: 'hide-m', f: r => esc([r.contact_name, r.contact_phone].filter(Boolean).join(' · ')) },
      { h: '', f: r => `<a class="link" href="#/equipos?client_id=${esc(r.id)}" onclick="event.stopPropagation()">Units</a> · <a class="link" href="#/ordenes?client_id=${esc(r.id)}" onclick="event.stopPropagation()">Work orders</a>` }],
  });
}

async function viewEquipment(q) {
  const [clients, all] = await Promise.all([load('clients', true), api('GET', '/api/equipment?all=1')]);
  const cmap = Object.fromEntries(clients.map(c => [c.id, c.name]));
  const rows = q.client_id ? all.filter(e => e.client_id == q.client_id) : all;
  const form = r => {
    if (!clients.length) throw new Error('Create a client first');
    formModal(r ? 'Edit unit' : 'New unit', [
      { name: 'client_id', label: 'Client', type: 'select', required: true, value: r?.client_id || q.client_id, options: clients.map(c => [c.id, c.name]) },
      { name: 'location', label: 'Location (room, apartment, area)', required: true, value: r?.location, placeholder: 'E.g. Room 304 / Lobby / Apt 5-B' },
      { name: 'kind', label: 'Unit type', type: 'select', value: r?.kind || 'Split', options: ['Split', 'Window', 'Cassette', 'Floor/ceiling', 'Fan coil', 'Package', 'Chiller', 'VRF', 'Other'].map(x => [x, x]) },
      { name: 'brand', label: 'Brand', value: r?.brand, half: true },
      { name: 'model', label: 'Model', value: r?.model, half: true },
      { name: 'btu', label: 'Capacity (BTU)', type: 'number', value: r?.btu, half: true },
      { name: 'serial', label: 'Serial number', value: r?.serial, half: true },
      { name: 'notes', label: 'Notes', type: 'textarea', value: r?.notes },
      ...(r ? [activeField(r)] : []),
    ], saveCat('equipment', r, () => viewEquipment(q)));
  };
  catalogView({
    title: 'A/C units', rows, editable: can('units', 2), onNew: () => form(), onEdit: form,
    extra: `<div class="card row"><label style="margin:0">Client</label><select id="fc" style="width:auto;min-width:200px"><option value="">All</option>${clients.map(c => `<option value="${esc(c.id)}" ${c.id == q.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select><span class="small muted">${rows.length} unit(s)</span></div>`,
    cols: [{ h: 'Location', f: r => `<b>${esc(r.location)}</b><div class="small muted">${esc(cmap[r.client_id] || '')}</div>` },
      { h: 'Unit', f: r => esc([r.kind, r.brand, r.model].filter(Boolean).join(' · ')) },
      { h: 'BTU', cls: 'hide-m', f: r => r.btu ? Number(r.btu).toLocaleString('en-US') : '—' },
      { h: 'Serial no.', cls: 'hide-m', f: r => esc(r.serial || '—') },
      { h: '', f: r => `<a class="link" href="#/ordenes?equipment_id=${esc(r.id)}" onclick="event.stopPropagation()">History</a>` }],
  });
  $('#fc').onchange = e => location.hash = '#/equipos' + (e.target.value ? '?client_id=' + e.target.value : '');
}

async function viewParts() {
  const rows = await api('GET', '/api/parts?all=1');
  const form = r => formModal(r ? 'Edit part' : 'New part', [
    { name: 'name', label: 'Name', required: true, value: r?.name, placeholder: 'E.g. Capacitor 35/5 µF' },
    { name: 'code', label: 'Code', value: r?.code, half: true },
    { name: 'unit', label: 'Unit of measure', type: 'select', value: r?.unit || 'ea', options: [['ea', 'Each'], ['lb', 'Pound (refrigerant)'], ['kg', 'Kg'], ['m', 'Meter'], ['ft', 'Foot'], ['L', 'Liter'], ['set', 'Set']], half: true },
    { name: 'cost', label: 'Unit cost (USD)', type: 'number', step: '0.01', value: r?.cost ?? 0, half: true },
    { name: 'stock', label: 'Current stock', type: 'number', step: '0.01', value: r?.stock ?? 0, half: true, help: 'Deducted automatically when used on a work order' },
    { name: 'min_stock', label: 'Minimum stock (alert)', type: 'number', step: '0.01', value: r?.min_stock ?? 0 },
    ...(r ? [activeField(r)] : []),
  ], saveCat('parts', r, viewParts));
  catalogView({
    title: 'Parts & inventory', rows, editable: can('parts', 2), onNew: () => form(), onEdit: form,
    cols: [{ h: 'Part', f: r => `<b>${esc(r.name)}</b>${r.code ? `<div class="small muted">${esc(r.code)}</div>` : ''}` },
      { h: 'Stock', f: r => `<span class="${+r.stock <= +r.min_stock ? 'overdue' : ''}">${r.stock} ${esc(r.unit)}</span>` },
      { h: 'Min.', cls: 'hide-m', f: r => r.min_stock },
      { h: 'Cost', f: r => money(r.cost) }],
  });
}

// Checklist items are edited as text, one per line:  "Label"  |  "Label | number | psi"  |  "Label | text"
const itemsToText = items => items.map(i => i.kind === 'check' ? i.label : [i.label, i.kind, i.unit].filter(Boolean).join(' | ')).join('\n');
const textToItems = t => t.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
  const [label, kind, unit] = l.split('|').map(x => x.trim());
  const k = /^n(um(ber)?)?$/i.test(kind || '') ? 'number' : /^t(ext)?$/i.test(kind || '') ? 'text' : 'check';
  return { label, kind: k, ...(k === 'number' && unit ? { unit } : {}) };
});
async function viewChecklists() {
  const rows = await api('GET', '/api/checklists?all=1');
  const form = r => formModal(r ? 'Edit checklist' : 'New checklist', [
    { name: 'name', label: 'Name', required: true, value: r?.name, placeholder: 'E.g. Preventive maintenance - cassette' },
    { name: 'type', label: 'Default for', type: 'select', value: r?.type || 'preventivo', options: [['preventivo', 'Preventive orders'], ['correctivo', 'Corrective orders'], ['any', 'Any (not a default)']] },
    { name: 'items', label: 'Items (one per line)', type: 'textarea', rows: 10, required: true, value: r ? itemsToText(r.items) : '',
      placeholder: 'Clean air filters\nSuction pressure | number | psi\nObservations | text',
      help: 'A plain line is a checkbox. Add <code>| number | unit</code> for a reading (e.g. <code>Compressor current | number | A</code>) or <code>| text</code> for a note.' },
    ...(r ? [activeField(r)] : []),
  ], async d => {
    const body = { name: d.name, type: d.type, items: textToItems(d.items), ...(r ? { active: +d.active } : {}) };
    await api(r ? 'PUT' : 'POST', '/api/checklists' + (r ? '/' + r.id : ''), body); delete S.cache.checklists; toast('Checklist saved'); viewChecklists();
  });
  catalogView({
    title: 'Checklists', rows, editable: can('checklists', 2), onNew: () => form(), onEdit: form,
    extra: '<p class="muted small" style="margin-top:-6px">Templates copied into each new work order. Changing a template does not affect orders already created.</p>',
    cols: [{ h: 'Name', f: r => `<b>${esc(r.name)}</b>` }, { h: 'Default for', f: r => TYPE[r.type] },
      { h: 'Items', f: r => `${r.items.length} <span class="small muted hide-m">(${r.items.filter(i => i.kind === 'check').length} checks, ${r.items.filter(i => i.kind === 'number').length} readings)</span>` }],
  });
}

async function viewUsers() {
  const [rows, profiles] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/profiles')]);
  const pname = Object.fromEntries([['developer', 'Developer'], ...profiles.map(p => [p.key, p.name])]);
  const roleOpts = [...(isDev() ? [['developer', 'Developer (full access, manages permissions)']] : []), ...profiles.map(p => [p.key, p.name])];
  const form = r => formModal(r ? 'Edit user' : 'New user', [
    { name: 'name', label: 'Name', required: true, value: r?.name },
    { name: 'email', label: 'Email (used to sign in)', type: 'email', required: true, value: r?.email, ...(r && FB() ? { help: 'Changing the email here does not change the sign-in email.' } : {}) },
    { name: 'phone', label: 'Phone', type: 'tel', value: r?.phone },
    { name: 'role', label: 'Profile', type: 'select', value: r?.role || 'tecnico', options: roleOpts, help: isDev() ? 'Module access for each profile is set in <a href="#/permisos" onclick="document.getElementById(\'modal\').close()">Permissions</a>.' : '' },
    ...(!r ? [{ name: 'password', label: 'Initial password (min. 6)', type: 'text', required: true }]
      : FB() ? [{ name: 'send_reset', label: 'Password', type: 'select', value: '0', options: [['0', 'Keep current password'], ['1', 'Email a password-reset link to this user']] }]
      : [{ name: 'password', label: 'New password (leave blank to keep)', type: 'text' }]),
    ...(r ? [activeField(r)] : []),
  ], async d => {
    if (r) { d.active = +d.active; await api('PUT', '/api/users/' + r.id, d); } else await api('POST', '/api/users', d);
    toast(d.send_reset === '1' ? 'User saved · reset email sent' : 'User saved'); viewUsers();
  });
  catalogView({
    title: 'Users', rows, onNew: () => form(), onEdit: form, editable: can('users', 2), canEditRow: r => r.role !== 'developer' || isDev(),
    cols: [{ h: 'Name', f: r => `<b>${esc(r.name)}</b><div class="small muted">${esc(r.email)}</div>` },
      { h: 'Profile', f: r => `<span class="badge ${r.role === 'developer' ? 'st-en_progreso' : r.role === 'master' ? 'st-asignada' : ''}">${esc(pname[r.role] || r.role)}</span>` },
      { h: 'Phone', cls: 'hide-m', f: r => esc(r.phone || '—') },
      { h: 'Status', f: r => r.active ? 'Active' : 'Inactive' }],
  });
}

// ================= Developer: profiles & permissions =================
async function viewPermissions() {
  const profiles = await api('GET', '/api/profiles');
  const M = PERMS.MODULES;
  const draft = Object.fromEntries(profiles.map(p => [p.key, { ...PERMS.cleanPerms(p.perms) }]));
  const lvlSel = (p, m) => `<select data-p="${esc(p.key)}" data-m="${m.key}" class="lvl lvl-${draft[p.key][m.key]}">${m.levels.map(l => `<option value="${l}" ${draft[p.key][m.key] === l ? 'selected' : ''}>${PERMS.LEVEL_NAMES[l]}</option>`).join('')}</select>`;
  app.innerHTML = `
  <div class="row between"><h1>Permissions</h1><div class="row"><button class="btn" id="bNewProf">+ New profile</button><button class="btn pri" id="bSavePerms">Save changes</button></div></div>
  <p class="muted small" style="margin-top:-6px">Choose what each profile can do in each module. <b>View</b> shows the screen read-only; <b>Full</b> allows creating and editing. Developer always has full access. Changes apply the next time each user opens the app.</p>
  <div class="card tbl-wrap"><table class="perm"><thead><tr><th>Module</th><th class="pc">Developer<div class="small muted">locked</div></th>
    ${profiles.map(p => `<th class="pc"><button class="link" data-prof="${esc(p.key)}">${esc(p.name)}</button><div class="small muted">${p.users} user(s)${p.builtin ? ' · built-in' : ''}</div></th>`).join('')}</tr></thead>
  <tbody>${M.map(m => `<tr><td><b>${m.name}</b>${m.help ? `<div class="small muted">${m.help}</div>` : ''}</td><td class="pc"><span class="badge st-completada">Full</span></td>
    ${profiles.map(p => `<td class="pc">${lvlSel(p, m)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  app.querySelectorAll('select.lvl').forEach(sel => sel.onchange = () => {
    draft[sel.dataset.p][sel.dataset.m] = +sel.value; sel.className = 'lvl lvl-' + sel.value;
  });
  $('#bSavePerms').onclick = run(async () => {
    const fixes = [];
    for (const p of profiles) {
      const d = draft[p.key];
      if (d.dashboard && !d.orders) { d.orders = 1; fixes.push(`${p.name}: Dashboard needs "All work orders: View" — enabled it`); }
      if (JSON.stringify(d) !== JSON.stringify(PERMS.cleanPerms(p.perms))) await api('PUT', '/api/profiles/' + p.key, { name: p.name, perms: d });
    }
    toast(fixes.length ? fixes.join(' · ') : 'Permissions saved'); viewPermissions();
  });
  $('#bNewProf').onclick = () => formModal('New profile', [
    { name: 'name', label: 'Profile name', required: true, placeholder: 'E.g. Supervisor, Warehouse, Receptionist' },
    { name: 'copy', label: 'Start with the permissions of', type: 'select', value: 'tecnico', options: [['', '— Nothing (no access) —'], ...profiles.map(p => [p.key, p.name])] },
  ], async d => { await api('POST', '/api/profiles', { name: d.name, perms: d.copy ? draft[d.copy] : {} }); toast('Profile created'); viewPermissions(); }, 'Create');
  app.querySelectorAll('[data-prof]').forEach(b => b.onclick = () => {
    const p = profiles.find(x => x.key === b.dataset.prof);
    formModal('Profile: ' + p.name, [
      { name: 'name', label: 'Name', required: true, value: p.name },
      { type: 'html', html: p.builtin ? '<p class="small muted">Built-in profile: it can be renamed but not deleted.</p>' : p.users ? `<p class="small muted">${p.users} user(s) have this profile. Move them to another profile before deleting it.</p>` : '' },
    ], async d => { await api('PUT', '/api/profiles/' + p.key, { name: d.name, perms: draft[p.key] }); toast('Profile saved'); viewPermissions(); });
    if (!p.builtin && !p.users) {
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn bad'; del.textContent = 'Delete profile'; del.style.marginRight = 'auto';
      del.onclick = run(async () => { if (!confirm(`Delete profile "${p.name}"?`)) return; await api('DELETE', '/api/profiles/' + p.key); $('#modal').close(); toast('Profile deleted'); viewPermissions(); });
      $('#modalForm .actions').prepend(del);
    }
  });
}

// ================= Master: settings =================
async function viewSettings() {
  const s = await settings(true);
  const logo = logoSrc(s);
  app.innerHTML = `<h1>Settings</h1>
  <form class="card" id="sf">
    <h2>Company (shown on client reports)</h2>
    <div class="grid g2" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
      <div class="field"><label>Company name</label><input name="company_name" value="${esc(s.company_name)}"></div>
      <div class="field"><label>Phone</label><input name="company_phone" value="${esc(s.company_phone)}"></div>
      <div class="field"><label>Email</label><input name="company_email" value="${esc(s.company_email)}"></div>
      <div class="field"><label>Address</label><input name="company_address" value="${esc(s.company_address)}"></div>
    </div>
    <div class="field"><label>Report footer</label><input name="report_footer" value="${esc(s.report_footer)}"></div>
    <div class="grid g2" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
      <div class="field"><label>Show part costs on client reports</label><select name="report_show_costs"><option value="0" ${s.report_show_costs !== '1' ? 'selected' : ''}>No</option><option value="1" ${s.report_show_costs === '1' ? 'selected' : ''}>Yes</option></select></div>
      <div class="field"><label>Create preventive orders this many days before due</label><input name="preventive_lead_days" type="number" min="0" max="60" value="${esc(s.preventive_lead_days)}"></div>
    </div>
    <button class="btn pri">Save settings</button>
  </form>
  <div class="card"><h2>Logo</h2>
    <div class="row">${logo ? `<img src="${esc(logo)}" class="logo-prev" alt="">` : '<span class="muted">No logo uploaded.</span>'}</div>
    <div class="row" style="margin-top:10px"><label class="btn camera-btn" style="margin:0">Upload logo (PNG/JPG/SVG)<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" id="fLogo"></label>
    ${logo ? '<button class="btn bad" id="bDelLogo">Remove</button>' : ''}</div></div>`;
  $('#sf').onsubmit = run(async e => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.target)); await api('PUT', '/api/settings', data); toast('Settings saved'); S.settings = null; syncBrand(data); });
  $('#fLogo').onchange = run(async e => { const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('logo', f, f.name); await api('POST', '/api/settings/logo', fd); toast('Logo updated'); viewSettings(); });
  $('#bDelLogo') && ($('#bDelLogo').onclick = run(async () => { if (!confirm('Remove logo?')) return; await api('DELETE', '/api/settings/logo'); viewSettings(); }));
}

// ================= Boot =================
const splashStart = Date.now();
function hideSplash() {
  const sp = $('#splash');
  if (!sp || sp.classList.contains('hide')) return;
  const wait = Math.max(0, 420 - (Date.now() - splashStart));
  setTimeout(() => { sp.classList.add('hide'); setTimeout(() => sp.remove(), 450); }, wait);
}
setTimeout(hideSplash, 4000);

async function boot() {
  if (FB() && !BE) {
    try {
      const m = await import('./backend-firebase.js');
      BE = await m.createBackend(CFG.firebase);
    } catch (e) {
      console.error(e);
      hideSplash();
      app.innerHTML = `<div class="center"><div class="card login"><h1>Configuration needed</h1><p class="muted">Could not start Firebase: ${esc(e.message)}</p><p class="small">Check the Firebase settings in <code>config.js</code>.</p></div></div>`;
      return;
    }
  }
  try { S.me = await api('GET', '/api/me'); } catch { if (!S.me) return renderLogin(); }
  S.cache = {}; S.settings = null;
  settings().then(syncBrand).catch(() => {});
  if (can('plans', 2) && FB()) api('POST', '/api/plans/run').then(r => r.orders && toast(`${r.orders} preventive work order(s) generated`)).catch(e => console.warn('plans', e));
  if (!location.hash) location.hash = '#/';
  await route();
  hideSplash();
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();

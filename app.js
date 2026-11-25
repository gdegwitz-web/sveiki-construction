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
const getImpersonateId = () => sessionStorage.getItem('sv_impersonate_uid') || '';
function setImpersonateId(uid) {
  if (uid) sessionStorage.setItem('sv_impersonate_uid', uid);
  else sessionStorage.removeItem('sv_impersonate_uid');
}

async function api(method, url, body) {
  const imp = getImpersonateId();
  if (BE) {
    try { return await BE.request(method, url, body, { impersonate: imp || null }); }
    catch (e) { if (e.status === 401 && url !== '/api/me' && !/\/(login|setup)/.test(url)) { setImpersonateId(''); S.me = null; renderLogin(); } throw e; }
  }
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (imp) opt.headers['X-Impersonate'] = imp;
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


// ---------- Biometric Access (Face ID / Touch ID / Fingerprint via WebAuthn) ----------
const BIO_STORAGE_KEY = 'sv_bio_v1';
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ub64u = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function isBioSupported() {
  try {
    return !!(window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
      && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { return false; }
}

function getBioData() {
  try { return JSON.parse(localStorage.getItem(BIO_STORAGE_KEY) || 'null'); }
  catch { return null; }
}
function saveBioData(obj) { localStorage.setItem(BIO_STORAGE_KEY, JSON.stringify(obj)); }
function clearBioData() {
  localStorage.removeItem(BIO_STORAGE_KEY);
  sessionStorage.removeItem('sv_bio_ok');
}

function openBioKeyDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('sveiki-bio-db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function getOrCreateDeviceKey() {
  const db = await openBioKeyDB();
  const existing = await new Promise((res, rej) => {
    const tx = db.transaction('keys', 'readonly');
    const r = tx.objectStore('keys').get('dev');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await new Promise((res, rej) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(key, 'dev');
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  return key;
}

async function encryptSecret(plainText) {
  if (!plainText || !window.crypto?.subtle) return null;
  const key = await getOrCreateDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plainText));
  return { iv: b64u(iv), ct: b64u(ct) };
}

async function decryptSecret(vault) {
  if (!vault?.iv || !vault?.ct || !window.crypto?.subtle) return null;
  const key = await getOrCreateDeviceKey();
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ub64u(vault.iv) }, key, ub64u(vault.ct));
  return new TextDecoder().decode(pt);
}

async function enrollBiometric(email, name, passwordOpt) {
  if (!(await isBioSupported())) {
    throw new Error('Biometric authentication (Face ID / Fingerprint) is not available on this device or browser.');
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = new TextEncoder().encode(email.toLowerCase());
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Sveiki App', id: location.hostname },
      user: { id: userId, name: email.toLowerCase(), displayName: name || email },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
    },
  });
  if (!cred) throw new Error('Biometric setup cancelled');
  const prev = getBioData();
  const vault = passwordOpt ? await encryptSecret(passwordOpt) : (prev?.email === email.toLowerCase() ? prev.vault : null);
  saveBioData({
    credentialId: b64u(cred.rawId),
    email: email.toLowerCase(),
    name: name || email,
    enabledAt: new Date().toISOString(),
    vault,
  });
  if (S.me?.id) sessionStorage.setItem('sv_bio_ok', S.me.id);
}

async function verifyBiometricAssertion(bio) {
  if (!bio?.credentialId) throw new Error('Biometric access is not configured on this device');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: location.hostname,
      allowCredentials: [{ type: 'public-key', id: ub64u(bio.credentialId), transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  if (!assertion) throw new Error('Biometric verification failed');
  return true;
}

function renderBiometricLock(user) {
  $('#topbar').hidden = true;
  if ($('#impBanner')) $('#impBanner').hidden = true;
  document.body.classList.remove('report-mode');
  document.body.classList.add('auth-mode');
  clearInterval(tickTimer);
  hideSplash();
  const bio = getBioData();
  app.innerHTML = `<div class="center"><div class="card login bio-card">
    <img src="logo.png" alt="Sveiki App" class="login-logo">
    <div class="bio-icon">🔐</div>
    <h1>Biometric Verification</h1>
    <p class="muted small" style="margin-bottom:16px">Signed in as <b>${esc(user.name)}</b> (${esc(user.role_name || user.role)}).<br>Verify with Face ID or Fingerprint to enter the app.</p>
    <div class="auth-actions">
      <button type="button" class="btn pri big" id="bBioUnlock">🔓 Unlock with Face ID / Fingerprint</button>
      <button type="button" class="btn" id="bBioSignOut">Sign out / Use password</button>
    </div>
  </div></div>`;

  const doUnlock = async () => {
    const btn = $('#bBioUnlock');
    if (btn) btn.disabled = true;
    try {
      await verifyBiometricAssertion(bio);
      sessionStorage.setItem('sv_bio_ok', user.id);
      toast('Welcome back, ' + user.name);
      await boot();
    } catch (e) {
      if (e?.name !== 'NotAllowedError') toast(e.message || 'Biometric verification failed', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  $('#bBioUnlock').onclick = doUnlock;
  $('#bBioSignOut').onclick = run(async () => {
    await api('POST', '/api/logout');
    S.me = null;
    S.cache = {};
    S.settings = null;
    renderLogin();
  });

  // Trigger native Face ID / Fingerprint prompt automatically on entry
  setTimeout(doUnlock, 180);
}

// Re-lock automatically if app is hidden in background for > 2 minutes
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
  } else if (hiddenAt && Date.now() - hiddenAt > 120000) {
    hiddenAt = 0;
    const bio = getBioData();
    if (S.me && bio && bio.email === (S.me.email || '').toLowerCase()) {
      sessionStorage.removeItem('sv_bio_ok');
      renderBiometricLock(S.me);
    }
  }
});

// ================= Login / setup =================
async function openResetPasswordModal(prefill = '') {
  formModal('Reset forgotten password', [
    { type: 'html', html: '<p class="muted small" style="margin-top:0">Enter the email address associated with your account and we will send you a password reset link.</p>' },
    { name: 'email', label: 'Account email', type: 'email', required: true, value: prefill, placeholder: 'name@company.com' },
  ], async d => {
    const email = (d.email || '').trim();
    if (!email) throw new Error('Enter your email address');
    await api('POST', '/api/password-reset', { email });
    toast('If that email is registered, a password reset link has been sent. Check your inbox and spam folder.');
  }, 'Send reset link');
}

async function renderLogin() {
  $('#topbar').hidden = true;
  document.body.classList.remove('report-mode');
  document.body.classList.add('auth-mode');
  clearInterval(tickTimer);
  let needsSetup = false;
  try { needsSetup = (await api('GET', '/api/setup-status')).needsSetup; }
  catch (e) {
    hideSplash();
    app.innerHTML = `<div class="center"><div class="card login"><h1>Cannot connect</h1><p class="muted">${esc(e.message)}</p><button class="btn pri" onclick="location.reload()">Retry</button></div></div>`;
    return;
  }
  const bio = !needsSetup ? getBioData() : null;
  const bioSupported = !needsSetup && bio ? await isBioSupported() : false;

  app.innerHTML = `<div class="center"><div class="card login">
    <img src="logo.png" alt="Sveiki App" class="login-logo">
    <h1>${needsSetup ? 'Initial setup' : 'A/C Maintenance Portal'}</h1>
    ${needsSetup ? '<p class="muted small" style="text-align:center">Create the initial <b>Developer</b> (super-admin) account. Afterwards, add the Master user and field technicians under Users.</p>' : '<p class="muted small" style="text-align:center;margin-bottom:16px">Sign in with your Sveiki Construction account</p>'}
    ${bioSupported ? `<div style="margin-bottom:14px">
      <button type="button" class="btn bio big" id="bBioLogin">🔐 Sign in with Face ID / Fingerprint</button>
      <div class="small muted" style="text-align:center;margin-top:4px">${esc(bio.name)} (${esc(bio.email)})</div>
    </div>` : ''}
    <form id="lf">
      ${needsSetup ? '<div class="field"><label>Name</label><input name="name" required></div>' : ''}
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username" value="${esc(bio?.email || '')}"></div>
      <div class="field"><label>Password</label><input name="password" type="password" required minlength="${needsSetup ? 6 : 1}" autocomplete="${needsSetup ? 'new-password' : 'current-password'}"></div>
      <button class="btn pri big">${needsSetup ? 'Create developer account' : 'Sign in'}</button>
    </form>
    <div class="auth-actions">
      ${!needsSetup ? '<button type="button" class="btn" id="forgot" style="width:100%">🔑 Reset forgotten password</button>' : ''}
      <button type="button" class="btn" id="btnLoginInstall" style="width:100%" hidden>⬇ Install app on phone</button>
    </div>
  </div></div>`;

  $('#lf').onsubmit = run(async e => {
    e.preventDefault();
    const b = e.target.querySelector('button.pri');
    b.disabled = true;
    const creds = Object.fromEntries(new FormData(e.target));
    try {
      await api('POST', needsSetup ? '/api/setup' : '/api/login', creds);
      // If biometric is already configured for this email, refresh encrypted vault with latest password
      const curBio = getBioData();
      if (curBio && curBio.email === (creds.email || '').trim().toLowerCase() && creds.password) {
        curBio.vault = await encryptSecret(creds.password).catch(() => curBio.vault);
        saveBioData(curBio);
      } else if (!needsSetup && creds.password && await isBioSupported()) {
        if (confirm('Enable Face ID / Fingerprint biometric access on this device for future sign-ins?')) {
          await enrollBiometric(creds.email.trim(), creds.email.trim(), creds.password).catch(err => console.warn('bio enroll skipped', err));
        }
      }
      if (S.me?.id) sessionStorage.setItem('sv_bio_ok', S.me.id);
      await boot();
    } finally {
      b.disabled = false;
    }
  });

  $('#bBioLogin') && ($('#bBioLogin').onclick = run(async e => {
    const btn = e.target;
    btn.disabled = true;
    try {
      await verifyBiometricAssertion(bio);
      if (!bio.vault) {
        toast('Biometric verified — enter your password once to link quick sign-in on this device.');
        $('#lf').elements.password.focus();
        return;
      }
      const pwd = await decryptSecret(bio.vault);
      if (!pwd) throw new Error('Could not unlock saved credentials. Sign in with your password once.');
      await api('POST', '/api/login', { email: bio.email, password: pwd });
      await boot();
    } catch (err) {
      if (err?.name !== 'NotAllowedError') toast(err.message || 'Biometric sign-in failed', true);
    } finally {
      btn.disabled = false;
    }
  }));

  $('#forgot') && ($('#forgot').onclick = () => {
    const typed = $('#lf').elements.email.value.trim();
    openResetPasswordModal(typed);
  });

  $('#btnLoginInstall') && ($('#btnLoginInstall').onclick = triggerInstall);
  updateInstallUI();
  hideSplash();
}

// ================= Navigation =================
// ---------- permissions ----------
const can = (mod, lvl = 1) => (S.me?.perms?.[mod] || 0) >= lvl;
const isDev = () => S.me?.role === 'developer';
const isRealDev = () => S.me?.role === 'developer' || S.me?.real_user?.role === 'developer';
const fullOrders = () => can('orders', 2);

async function switchUserTo(uid) {
  setImpersonateId(uid || '');
  S.cache = {};
  S.settings = null;
  location.hash = '#/';
  await boot();
  if (uid && S.me) toast(`Viewing app as ${S.me.name} (${S.me.role_name || S.me.role})`);
  else if (S.me) toast(`Returned to Developer account (${S.me.name})`);
}

function renderImpersonationBanner() {
  let bar = $('#impBanner');
  if (!S.me?.impersonating) {
    if (bar) bar.hidden = true;
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'impBanner';
    document.body.prepend(bar);
  }
  bar.hidden = false;
  bar.innerHTML = `<div>👁️ <b>Developer Preview Mode:</b> Viewing as <b>${esc(S.me.name)}</b> (${esc(S.me.role_name || S.me.role)})${S.me.active === false ? ' · <span style="text-decoration:underline">Account Restricted</span>' : ''}</div>
    <div class="row" style="gap:6px">
      <button type="button" class="btn sm" id="bImpSwitch">Switch user</button>
      <button type="button" class="btn sm" id="bImpExit">Exit to Developer</button>
    </div>`;
  $('#bImpSwitch').onclick = run(openSwitchUserModal);
  $('#bImpExit').onclick = run(() => switchUserTo(''));
}

async function openSwitchUserModal() {
  if (!isRealDev()) return;
  const curImp = getImpersonateId();
  // Temporarily query users/profiles as real developer so it works even while previewing a restricted user
  let users = [], profiles = [];
  setImpersonateId('');
  try {
    [users, profiles] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/profiles')]);
  } finally {
    setImpersonateId(curImp);
  }
  const pname = Object.fromEntries([['developer', 'Developer'], ...profiles.map(p => [p.key, p.name])]);
  const realId = S.me?.real_user?.id || S.me?.id;
  const dlg = $('#modal'), f = $('#modalForm');
  f.innerHTML = `<h2>Switch user (Developer Preview)</h2>
    <p class="muted small" style="margin-top:0">Test how the app looks and behaves for any user without signing out. Your developer permissions are restored immediately when you exit preview mode.</p>
    <input type="search" id="swFilter" placeholder="Filter by name, email or role…" style="margin-bottom:4px">
    <div class="switch-list" id="swList">
      ${users.map(u => {
        const isSelf = u.id === realId;
        const isCurrent = u.id === S.me?.id;
        return `<button type="button" class="switch-row ${isCurrent ? 'cur' : ''}" data-sw-uid="${isSelf ? '' : esc(u.id)}" data-sw-q="${esc((u.name + ' ' + u.email + ' ' + (pname[u.role] || u.role)).toLowerCase())}">
          <div>
            <b>${esc(u.name)}</b> ${isSelf ? '<span class="badge st-en_progreso">Your Developer Account</span>' : ''}
            <div class="small muted">${esc(u.email)}</div>
          </div>
          <div class="row" style="gap:6px">
            <span class="badge ${u.role === 'developer' ? 'st-en_progreso' : u.role === 'master' ? 'st-asignada' : ''}">${esc(pname[u.role] || u.role)}</span>
            ${u.active ? '' : '<span class="badge st-bad">Restricted</span>'}
            ${isCurrent ? '<span class="badge st-completada">Current</span>' : ''}
          </div>
        </button>`;
      }).join('')}
    </div>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button></div>`;
  f.onsubmit = () => {};
  $('#swFilter').oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    f.querySelectorAll('[data-sw-uid]').forEach(row => {
      row.hidden = !!(q && !row.dataset.swQ.includes(q));
    });
  };
  f.querySelectorAll('[data-sw-uid]').forEach(btn => btn.onclick = run(async () => {
    dlg.close();
    await switchUserTo(btn.dataset.swUid);
  }));
  dlg.showModal();
}

function renderNav() {
  renderImpersonationBanner();
  $('#topbar').hidden = false;
  $('#whoName').textContent = `${S.me.name} · ${S.me.role_name || S.me.role}`;
  const whoBox = $('.who');
  let swBtn = $('#bTopSwitch');
  if (isRealDev()) {
    if (!swBtn && whoBox) {
      swBtn = document.createElement('button');
      swBtn.type = 'button';
      swBtn.id = 'bTopSwitch';
      swBtn.className = 'link';
      swBtn.textContent = '⇄ Switch';
      swBtn.title = 'Switch user to test permissions and views';
      whoBox.insertBefore(swBtn, $('#btnMenu'));
    }
    if (swBtn) swBtn.onclick = run(openSwitchUserModal);
  } else if (swBtn) {
    swBtn.remove();
  }
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
$('#btnMenu').onclick = run(async () => {
  const bioSupported = await isBioSupported();
  const bio = getBioData();
  const bioActive = !!(bio && S.me?.email && bio.email === S.me.email.toLowerCase());
  const bioHtml = bioSupported ? `<div class="bio-box">
    <div class="row between">
      <div>
        <b>🔐 Biometric Access (Face ID / Fingerprint)</b>
        <div class="small muted">${bioActive ? 'Active — required every time you open the app on this device.' : 'Disabled — enable to unlock the app with Face ID or Fingerprint.'}</div>
      </div>
      <button type="button" class="btn sm ${bioActive ? 'bad' : 'pri'}" id="bToggleBio">${bioActive ? 'Disable' : 'Enable'}</button>
    </div>
  </div>` : '';

  formModal('My account', [
    { type: 'html', html: bioHtml },
    { name: 'current', label: 'Current password', type: 'password', placeholder: 'Required to change password' },
    { name: 'password', label: 'New password (min. 6)', type: 'password', placeholder: 'Leave blank to keep current' },
  ], async d => {
    if (d.password) {
      await api('POST', '/api/me/password', d);
      const curBio = getBioData();
      if (curBio && S.me?.email && curBio.email === S.me.email.toLowerCase()) {
        curBio.vault = await encryptSecret(d.password).catch(() => curBio.vault);
        saveBioData(curBio);
      }
      toast('Password updated');
    }
  }, 'Change password');

  $('#bToggleBio') && ($('#bToggleBio').onclick = run(async () => {
    if (bioActive) {
      clearBioData();
      toast('Biometric access disabled on this device');
      $('#modal').close();
    } else {
      const curPwd = $('#modalForm').elements.current?.value || '';
      await enrollBiometric(S.me.email, S.me.name, curPwd || null);
      toast('Biometric access enabled! It will verify on every entry.');
      $('#modal').close();
    }
  }));

  const a = $('#modalForm .actions');
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn bad'; b.textContent = 'Sign out'; b.style.marginRight = 'auto';
  b.onclick = run(async () => {
    setImpersonateId('');
    await api('POST', '/api/logout');
    $('#modal').close();
    S.me = null;
    S.cache = {};
    S.settings = null;
    renderImpersonationBanner();
    renderLogin();
  });
  a.prepend(b);
  if (isRealDev()) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'btn';
    sw.textContent = '⇄ Switch user';
    sw.onclick = run(async () => { $('#modal').close(); await openSwitchUserModal(); });
    a.insertBefore(sw, b.nextSibling);
  }
});

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
    <div class="small muted">${otCode(o.id)} · ${TYPE[o.type]}${eq ? ' · ' + esc(eq) : ''}${o.estimated_minutes ? ' · ⏱ ~' + fmtDur(o.estimated_minutes) : ''}</div>
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
  const [o, parts, cfg] = await Promise.all([api('GET', '/api/orders/' + id), load('parts', true), settings(true)]);
  renderOrder(o, parts, cfg);
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
function renderOrder(o, partsCat, cfg = S.settings || {}) {
  clearInterval(tickTimer);
  const closed = ['completada', 'cancelada'].includes(o.status);
  const arrived = !!o.arrival_at;
  const full = fullOrders();
  const mine = o.technician_id === S.me.id && can('field', 2);
  const canWork = full ? o.status !== 'cancelada' : (mine && arrived && !closed);
  const canArrive = !arrived && !closed && (full || mine);
  const showCosts = can('orders') && can('parts');
  // Master/full-order users always see all sections; field technicians follow the Master toggles
  const fOn = k => full || (cfg?.[k] ?? '1') !== '0';
  const showDiagSec = fOn('field_show_diagnosis');
  const showPhotosSec = fOn('field_show_photos');
  const showChecklistSec = fOn('field_show_checklist');
  const showPartsSec = fOn('field_show_parts');
  const showWorkSec = fOn('field_show_work_done');
  const showRecSec = fOn('field_show_recommendations');
  const showRecvSec = fOn('field_show_received_by');
  const showSigSec = fOn('field_show_signature');
  const showSignoffCard = showWorkSec || showRecSec || showRecvSec || showSigSec;
  const eq = [o.eq_kind, o.eq_brand, o.eq_model, o.eq_btu && o.eq_btu + ' BTU'].filter(Boolean).join(' · ');
  const respMin = arrived ? Math.max(0, mins(o.scheduled_at || o.created_at, o.arrival_at)) : null;
  const partsTotal = o.parts.reduce((s, p) => s + p.qty * p.unit_cost, 0);
  const showSigPad = canWork && !closed && showSigSec;

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
      <div><h3>Technician</h3>${esc(o.technician_name || 'Unassigned')}${o.scheduled_at ? `<div class="small muted">Scheduled: ${fmtDT(o.scheduled_at)}</div>` : ''}${o.estimated_minutes ? `<div class="small muted">Est. duration: ~${fmtDur(o.estimated_minutes)}</div>` : ''}</div>
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

  ${!arrived && !full ? '<div class="card empty">Record your arrival to start working on this order.</div>' : `
  ${(showDiagSec || showPhotosSec) ? `<div class="card">
    ${showDiagSec ? `<h2>Diagnosis</h2>
    ${canWork ? `<textarea id="fDiag" placeholder="What did you find? E.g. compressor won't start, swollen capacitor, low refrigerant pressure…">${esc(o.diagnosis || '')}</textarea>` : `<div>${esc(o.diagnosis || '—')}</div>`}` : ''}
    ${showPhotosSec ? `<div class="row between" style="margin:${showDiagSec ? '14px' : '0'} 0 8px"><h3 style="margin:0">Photos (${o.photos.length})</h3>
      ${canWork ? `<div class="row"><select id="fKind" style="width:auto"><option value="diagnostico">Diagnosis</option><option value="antes">Before</option><option value="despues">After</option></select>
      <label class="btn pri camera-btn" style="margin:0;color:#fff">📷 Take photo<input type="file" accept="image/*" capture="environment" id="fPhoto" multiple></label></div>` : ''}
    </div>
    <div class="photos">${o.photos.map(p => `<div class="photo"><img loading="lazy" src="${esc(photoSrc(p))}" alt=""><span class="tag">${PHOTO_KIND[p.kind] || p.kind}</span>${canWork ? `<button class="del noprint" data-del="${esc(p.id)}" title="Delete">×</button>` : ''}</div>`).join('') || '<div class="muted small">No photos.</div>'}</div>` : ''}
  </div>` : ''}

  ${showChecklistSec ? checklistHtml(o.checklist, canWork) : ''}

  ${showPartsSec ? `<div class="card">
    <h2>Parts used</h2>
    ${o.parts.length ? `<div class="tbl-wrap"><table><thead><tr><th>Part</th><th>Qty</th>${showCosts ? '<th>Cost</th>' : ''}<th></th></tr></thead><tbody>
      ${o.parts.map(p => `<tr><td>${esc(p.name)}${p.code ? ` <span class="small muted">${esc(p.code)}</span>` : ''}</td><td>${p.qty} ${esc(p.unit)}</td>${showCosts ? `<td>${money(p.qty * p.unit_cost)}</td>` : ''}<td>${canWork ? `<button class="btn sm bad noprint" data-rmpart="${esc(p.id)}">Remove</button>` : ''}</td></tr>`).join('')}
      ${showCosts ? `<tr><td colspan="2"><b>Parts total</b></td><td><b>${money(partsTotal)}</b></td><td></td></tr>` : ''}
    </tbody></table></div>` : '<div class="muted small">No parts added.</div>'}
    ${canWork ? `<div class="row noprint" style="margin-top:10px">
      <select id="fPart" style="flex:3;min-width:180px"><option value="">— Select part —</option>${partsCat.map(p => `<option value="${esc(p.id)}">${esc(p.name)}${p.code ? ' (' + esc(p.code) + ')' : ''} · stock ${p.stock} ${esc(p.unit)}</option>`).join('')}</select>
      <input id="fQty" type="number" min="0.01" step="0.01" value="1" style="flex:1;min-width:70px">
      <button class="btn" id="bAddPart">Add</button></div>` : ''}
  </div>` : ''}

  ${showSignoffCard ? `<div class="card">
    <h2>${showSigSec || showRecvSec ? 'Work performed and sign-off' : 'Work performed'}</h2>
    ${canWork ? `
      ${showWorkSec ? `<div class="field"><label>Work performed</label><textarea id="fWork" placeholder="E.g. replaced 35/5 µF capacitor, cleaned coil, recharged R410A…">${esc(o.work_done || '')}</textarea></div>` : ''}
      ${showRecSec ? `<div class="field"><label>Recommendations to client</label><textarea id="fRec" style="min-height:60px">${esc(o.recommendations || '')}</textarea></div>` : ''}
      ${showRecvSec ? `<div class="field"><label>Received by (on-site contact signing off)</label><input id="fRecv" value="${esc(o.received_by || '')}"></div>` : ''}`
    : `<div class="grid g2">${showWorkSec ? `<div><h3>Work performed</h3>${esc(o.work_done || '—')}</div>` : ''}${showRecSec ? `<div><h3>Recommendations</h3>${esc(o.recommendations || '—')}</div>` : ''}</div>${showRecvSec ? `<div style="margin-top:10px"><h3>Received by</h3>${esc(o.received_by || '—')}</div>` : ''}`}
    ${showSigSec ? `<div style="margin-top:12px"><h3>Client signature</h3>
      ${o.has_signature ? `<div class="sigview" id="sigView"><img src="${esc(sigSrc(o))}" alt="Signature"><div class="small muted">Signed ${fmtDT(o.signed_at)}</div>${showSigPad ? '<button class="btn sm noprint" id="bResign">Sign again</button>' : ''}</div>` : ''}
      ${showSigPad ? `<div id="sigWrap" ${o.has_signature ? 'hidden' : ''}><canvas id="sigPad" class="sigpad"></canvas>
        <div class="row between small muted" style="margin-top:4px"><span>Ask the client to sign above with a finger</span><button type="button" class="link" id="bSigClear">Clear</button></div></div>` : ''}
      ${!o.has_signature && !showSigPad ? '<div class="muted small">Not signed.</div>' : ''}
    </div>` : ''}
  </div>` : ''}`}

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

  const rerender = async (fresh) => renderOrder(fresh, await load('parts', true), await settings());

  $('#bArrive') && ($('#bArrive').onclick = run(async e => {
    e.target.disabled = true; e.target.textContent = 'Recording…';
    try { const pos = await getPos(); const r = await api('POST', `/api/orders/${o.id}/arrive`, pos); toast('Arrival recorded ' + fmtT(r.arrival_at)); rerender(r); }
    finally { e.target.disabled = false; }
  }));
  $('#bSave') && ($('#bSave').onclick = run(async () => { await save(true); const r = (await uploadSignature()) || await api('GET', '/api/orders/' + o.id); toast('Saved'); rerender(r); }));
  $('#bDepart') && ($('#bDepart').onclick = run(async e => {
    const v = textVals();
    if (showDiagSec && !v.diagnosis?.trim()) { $('#fDiag')?.focus(); throw new Error('Enter the diagnosis before closing'); }
    if (showChecklistSec && o.checklist && v.checklist) {
      const missing = o.checklist.filter((it, i) => it.kind === 'check' && !v.checklist[i]?.value).length;
      if (missing && !confirm(`${missing} checklist item(s) not checked. Close anyway?`)) return;
    }
    if (showPhotosSec && !o.photos.length && !confirm('No photos taken. Close the work order anyway?')) return;
    const signedNow = pad?.hasInk();
    if (showSigSec && !o.has_signature && !signedNow && !confirm('The client has not signed. Close anyway?')) return;
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
  const [plans, clients, equipment, users, checklists, s] = await Promise.all([
    api('GET', '/api/plans'),
    load('clients', true),
    load('equipment', true),
    api('GET', '/api/technicians'),
    load('checklists', true),
    settings(true),
  ]);
  const techs = users;
  const editable = can('plans', 2);
  const prevCk = (checklists.find(c => c.type === 'preventivo') || {}).id || '';
  const ckOpts = [['', '— No checklist —'], ...checklists.map(c => [c.id, c.name])];
  const techOpts = [['', '— Unassigned —'], ...techs.map(u => [u.id, u.name])];
  const clientTypeLabels = { hotel: 'Hotel', condominio: 'Condominium', otro: 'Other' };
  const clientById = Object.fromEntries(clients.map(c => [c.id, c]));

  const freqPresets = [...FREQ, ['custom', 'Custom interval (days)…']];
  const optHtml = arr => arr.map(x => `<option value="${esc(x[0])}">${esc(x[1])}</option>`).join('');

  const distinctKinds = [...new Set(equipment.map(e => (e.kind || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const distinctBrands = [...new Set(equipment.map(e => (e.brand || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const eqOptsForClient = cid => {
    const list = equipment.filter(e => !cid || e.client_id == cid);
    return list.map(e => [
      e.id,
      [e.location, e.kind, e.brand, e.btu && e.btu + ' BTU'].filter(Boolean).join(' · ') + (!cid && clientById[e.client_id] ? ` (${clientById[e.client_id].name})` : ''),
    ]);
  };

  const countMatches = (f) => {
    if (!f) return 0;
    const scope = f.elements.scope_type?.value || 'client';
    const cid = f.elements.client_id?.value || '';
    const ctype = f.elements.client_type?.value || '';
    const eid = f.elements.equipment_id?.value || '';
    const kind = (f.elements.eq_kind?.value || '').trim().toLowerCase();
    const brand = (f.elements.eq_brand?.value || '').trim().toLowerCase();
    return equipment.filter(e => {
      if (scope === 'unit') return e.id === eid;
      if (scope === 'client') return e.client_id === cid;
      if (scope === 'client_type') return (clientById[e.client_id]?.type || 'otro') === ctype;
      if (scope === 'eq_kind') return (!cid || e.client_id === cid) && kind && (e.kind || '').trim().toLowerCase() === kind;
      if (scope === 'eq_brand') return (!cid || e.client_id === cid) && brand && (e.brand || '').trim().toLowerCase() === brand;
      if (scope === 'eq_kind_brand') return (!cid || e.client_id === cid) && kind && brand && (e.kind || '').trim().toLowerCase() === kind && (e.brand || '').trim().toLowerCase() === brand;
      return false;
    }).length;
  };

  const form = r => {
    if (!r && !equipment.length) throw new Error('Add units first (Units page)');
    const firstClient = clients[0]?.id || '';
    const isPreset = !r || FREQ.some(f => f[0] == r.every_days);

    const fields = r ? [
      { type: 'html', html: `<p class="muted" style="margin-top:-6px"><b>${esc(r.client_name)}</b> · ${esc(r.location)}${r.kind || r.brand ? ` <span class="small">(${esc([r.kind, r.brand].filter(Boolean).join(' · '))})</span>` : ''}</p>` },
    ] : [
      {
        name: 'scope_type',
        label: 'Apply schedule by',
        type: 'select',
        value: 'client',
        options: [
          ['client', 'Client (all units of a client)'],
          ['client_type', 'Facility / client type (Hotel, Condominium, Other)'],
          ['eq_kind', 'Equipment type (Split, Cassette, Chiller, etc.)'],
          ['eq_brand', 'Equipment brand (Carrier, LG, York, etc.)'],
          ['eq_kind_brand', 'Equipment type + Brand'],
          ['unit', 'Single specific unit'],
        ],
      },
      {
        name: 'client_id',
        label: 'Client',
        type: 'select',
        value: firstClient,
        options: clients.map(c => [c.id, c.name]),
      },
      {
        name: 'client_type',
        label: 'Facility / client type',
        type: 'select',
        value: 'hotel',
        options: [['hotel', 'Hotel'], ['condominio', 'Condominium'], ['otro', 'Other']],
      },
      {
        name: 'eq_kind',
        label: 'Equipment type',
        type: 'select',
        value: distinctKinds[0] || '',
        options: distinctKinds.length ? distinctKinds.map(k => [k, k]) : [['', '— No equipment types registered —']],
        half: true,
      },
      {
        name: 'eq_brand',
        label: 'Brand',
        type: 'select',
        value: distinctBrands[0] || '',
        options: distinctBrands.length ? distinctBrands.map(b => [b, b]) : [['', '— No brands registered —']],
        half: true,
      },
      {
        name: 'equipment_id',
        label: 'Unit',
        type: 'select',
        value: eqOptsForClient(firstClient)[0]?.[0] || '',
        options: eqOptsForClient(firstClient),
      },
      { type: 'html', html: `<div id="planMatchBanner" class="small" style="background:var(--sky-soft);border:1px solid var(--sky-border);color:var(--navy);padding:8px 12px;border-radius:10px;margin-bottom:12px;font-weight:600"></div>` },
    ];

    fields.push(
      {
        name: 'every_preset',
        label: 'Maintenance frequency',
        type: 'select',
        value: isPreset ? (r?.every_days || 90) : 'custom',
        options: freqPresets,
        half: true,
      },
      {
        name: 'every_days_custom',
        label: 'Interval (days)',
        type: 'number',
        min: 1,
        value: r?.every_days || 90,
        placeholder: 'E.g. 45',
        half: true,
      },
      {
        name: 'next_due',
        label: r ? 'Next due date' : 'First due date',
        type: 'date',
        required: true,
        value: r?.next_due || today(),
        half: true,
      },
      {
        name: 'estimated_minutes',
        label: 'Est. service time (min)',
        type: 'number',
        min: 0,
        step: 5,
        value: r?.estimated_minutes ?? '',
        placeholder: 'E.g. 60',
        half: true,
      },
      { name: 'technician_id', label: 'Default technician', type: 'select', value: r?.technician_id, options: techOpts },
      { name: 'checklist_id', label: 'Checklist', type: 'select', value: r ? r.checklist_id : prevCk, options: ckOpts, half: true },
      { name: 'priority', label: 'Priority', type: 'select', value: r?.priority || 'media', options: Object.entries(PR), half: true },
      { name: 'task', label: 'Task description (shown on the work order)', type: 'textarea', value: r?.task, placeholder: 'E.g. Quarterly maintenance: clean filters and coils, check drain and electrical.' },
    );

    if (!r) {
      fields.push({
        type: 'html',
        html: `<label class="restrict-item" style="margin-bottom:10px"><input type="checkbox" name="replace_existing" value="1" checked><span>Replace existing active preventive plans on matching units</span></label>`,
      });
    } else {
      fields.push({ name: 'active', label: 'Status', type: 'select', value: r.active ?? 1, options: [[1, 'Active'], [0, 'Paused']] });
    }

    const f = formModal(r ? 'Edit preventive plan' : 'New preventive plan', fields, async d => {
      const every = d.every_preset === 'custom' ? parseInt(d.every_days_custom, 10) : parseInt(d.every_preset, 10);
      if (!(every > 0)) throw new Error('Enter a valid maintenance interval in days');
      const payload = {
        ...d,
        every_days: every,
        estimated_minutes: d.estimated_minutes !== '' ? parseInt(d.estimated_minutes, 10) : null,
      };
      if (payload.active != null) payload.active = +payload.active;
      const res = await api(r ? 'PUT' : 'POST', '/api/plans' + (r ? '/' + r.id : ''), payload);
      const repNote = res.replaced ? ` (${res.replaced} previous replaced)` : '';
      toast(`${res.plans ? res.plans + ' plan(s) saved' + repNote : 'Plan saved'}${res.orders ? ` · ${res.orders} work order(s) generated` : ''}`);
      viewPlans();
    });

    const toggleField = (name, show) => {
      const el = f.elements[name];
      const wrap = el?.closest('.field');
      if (wrap) wrap.style.display = show ? '' : 'none';
    };

    const syncCustomDays = () => {
      const isCust = f.elements.every_preset?.value === 'custom';
      toggleField('every_days_custom', isCust);
      if (!isCust && f.elements.every_days_custom) {
        f.elements.every_days_custom.value = f.elements.every_preset.value;
      }
    };
    f.elements.every_preset?.addEventListener('change', syncCustomDays);
    syncCustomDays();

    if (!r) {
      const syncScope = () => {
        const sc = f.elements.scope_type.value;
        const clientSel = f.elements.client_id;
        // For eq_kind / eq_brand / eq_kind_brand allow either All clients or a specific client
        if (['eq_kind', 'eq_brand', 'eq_kind_brand'].includes(sc)) {
          if (clientSel.options[0]?.value !== '') {
            const cur = clientSel.value;
            clientSel.innerHTML = optHtml([['', '★ All clients'], ...clients.map(c => [c.id, c.name])]);
            clientSel.value = cur && clients.some(c => c.id === cur) ? cur : '';
          }
        } else if (clientSel.options[0]?.value === '') {
          clientSel.innerHTML = optHtml(clients.map(c => [c.id, c.name]));
          clientSel.value = firstClient;
        }

        toggleField('client_id', ['unit', 'client', 'eq_kind', 'eq_brand', 'eq_kind_brand'].includes(sc));
        toggleField('client_type', sc === 'client_type');
        toggleField('eq_kind', ['eq_kind', 'eq_kind_brand'].includes(sc));
        toggleField('eq_brand', ['eq_brand', 'eq_kind_brand'].includes(sc));
        toggleField('equipment_id', sc === 'unit');

        if (sc === 'unit') {
          const curEq = f.elements.equipment_id.value;
          const opts = eqOptsForClient(f.elements.client_id.value);
          f.elements.equipment_id.innerHTML = optHtml(opts);
          if (opts.some(o => o[0] === curEq)) f.elements.equipment_id.value = curEq;
        }

        const n = countMatches(f);
        const banner = $('#planMatchBanner');
        if (banner) {
          banner.textContent = n
            ? `✓ This rule will apply to ${n} active unit(s)`
            : '⚠ No active units match this selection';
          banner.style.color = n ? 'var(--navy)' : 'var(--bad)';
        }
      };

      ['scope_type', 'client_id', 'client_type', 'eq_kind', 'eq_brand', 'equipment_id'].forEach(nm => {
        f.elements[nm]?.addEventListener('change', syncScope);
      });
      syncScope();
    }
  };

  const due = p => p.next_due <= today();
  const planKinds = [...new Set(plans.map(p => (p.kind || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const planBrands = [...new Set(plans.map(p => (p.brand || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  app.innerHTML = `
  <div class="row between"><h1>Preventive plans</h1>${editable ? '<div class="row"><button class="btn" id="bRun">⟳ Generate due orders now</button><button class="btn pri" id="bNew">+ New plan / rule</button></div>' : ''}</div>
  <p class="muted small" style="margin-top:-6px">Define maintenance intervals by unit, client, facility type, equipment type or brand. Work orders are created automatically ${esc(s.preventive_lead_days)} day(s) before each due date${FB() ? ' (checked every time a master opens the app)' : ' (checked every hour)'}.</p>
  ${plans.length ? `<div class="card row" id="planFilters">
    <select id="pfClient" style="flex:1;min-width:150px"><option value="">All clients</option>${clients.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>
    <select id="pfCType" style="flex:1;min-width:140px"><option value="">All facility types</option><option value="hotel">Hotel</option><option value="condominio">Condominium</option><option value="otro">Other</option></select>
    <select id="pfKind" style="flex:1;min-width:140px"><option value="">All equipment types</option>${planKinds.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}</select>
    <select id="pfBrand" style="flex:1;min-width:140px"><option value="">All brands</option>${planBrands.map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}</select>
  </div>` : ''}
  <div class="card tbl-wrap">${plans.length ? `<table id="plansTbl"><thead><tr><th>Client / unit</th><th>Type &amp; Brand</th><th>Frequency</th><th>Next due</th><th class="hide-m">Technician</th><th class="hide-m">Checklist</th><th>Open order</th></tr></thead><tbody>
  ${plans.map((p, i) => {
    const freqLabel = (FREQ.find(f => f[0] == p.every_days) || [, `Every ${p.every_days} days`])[1].replace(/ \(.*\)/, '');
    const cTypeLabel = clientTypeLabels[p.client_type] || 'Other';
    return `<tr class="click" data-i="${i}" data-cid="${esc(p.client_id || '')}" data-ctype="${esc(p.client_type || 'otro')}" data-kind="${esc((p.kind || '').trim())}" data-brand="${esc((p.brand || '').trim())}" style="${p.active ? '' : 'opacity:.5'}">
      <td><b>${esc(p.client_name)}</b> <span class="small muted">(${esc(cTypeLabel)})</span><div class="small muted">${esc(p.location)}</div></td>
      <td>${esc([p.kind, p.brand].filter(Boolean).join(' · ') || '—')}${p.btu ? `<div class="small muted">${Number(p.btu).toLocaleString('en-US')} BTU</div>` : ''}</td>
      <td><b>${esc(freqLabel)}</b>${p.estimated_minutes ? `<div class="small muted">⏱ ~${fmtDur(p.estimated_minutes)}</div>` : ''}</td>
      <td class="${due(p) ? 'overdue' : ''}">${fmtYMD(p.next_due)}${p.active ? '' : ' · paused'}</td>
      <td class="hide-m">${esc(p.technician_name || '—')}</td>
      <td class="hide-m small">${esc(p.checklist_name || '—')}</td>
      <td>${p.open_order_id ? `<a class="link" href="#/orden/${p.open_order_id}" onclick="event.stopPropagation()">${otCode(p.open_order_id)}</a>` : p.open_orders ? `${p.open_orders} open` : '—'}</td>
    </tr>`;
  }).join('')}
  </tbody></table>` : '<div class="empty">No preventive plans yet. Create schedules by unit, client, facility type, equipment type, or brand.</div>'}</div>`;

  if (plans.length) {
    const applyPlanFilters = () => {
      const cid = $('#pfClient')?.value || '';
      const ct = $('#pfCType')?.value || '';
      const kd = $('#pfKind')?.value || '';
      const br = $('#pfBrand')?.value || '';
      app.querySelectorAll('#plansTbl tbody tr').forEach(tr => {
        const ok = (!cid || tr.dataset.cid === cid)
          && (!ct || tr.dataset.ctype === ct)
          && (!kd || tr.dataset.kind === kd)
          && (!br || tr.dataset.brand === br);
        tr.hidden = !ok;
      });
    };
    ['#pfClient', '#pfCType', '#pfKind', '#pfBrand'].forEach(sel => $(sel)?.addEventListener('change', applyPlanFilters));
  }

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
  const modName = Object.fromEntries(PERMS.MODULES.map(m => [m.key, m.name]));
  const roleOpts = [...(isDev() ? [['developer', 'Developer (full access, manages permissions)']] : []), ...profiles.map(p => [p.key, p.name])];

  const form = r => {
    const canRestrictUser = isDev() && (!r || r.role !== 'developer');
    const curRestrict = r?.restrict || {};
    const restrictHtml = canRestrictUser ? `<div class="restrict-box" id="userRestrictWrap" ${r?.role === 'developer' ? 'hidden' : ''}>
      <label style="margin-bottom:2px">Restrict specific modules for this user (optional)</label>
      <div class="small muted">Checked modules are blocked for this individual user even if their profile allows them.</div>
      <div class="restrict-grid">${PERMS.MODULES.map(m => `<label class="restrict-item"><input type="checkbox" data-rmod="${m.key}" ${curRestrict[m.key] ? 'checked' : ''}><span>${esc(m.name)}</span></label>`).join('')}</div>
    </div>` : '';

    const f = formModal(r ? 'Edit user' : 'New user', [
      { name: 'name', label: 'Name', required: true, value: r?.name },
      { name: 'email', label: 'Email (used to sign in)', type: 'email', required: true, value: r?.email, ...(r && FB() ? { help: 'Changing the email here does not change the sign-in email.' } : {}) },
      { name: 'phone', label: 'Phone', type: 'tel', value: r?.phone },
      { name: 'role', label: 'Profile', type: 'select', value: r?.role || 'tecnico', options: roleOpts,
        help: isDev() ? 'Enable/disable modules for each user type in <a href="#/permisos" onclick="document.getElementById(\'modal\').close()">Permissions</a>.' : '',
        onchange: (e) => { const w = $('#userRestrictWrap'); if (w) w.hidden = e.target.value === 'developer'; } },
      ...(!r ? [{ name: 'password', label: 'Initial password (min. 6)', type: 'text', required: true }]
        : FB() ? [{ name: 'send_reset', label: 'Password', type: 'select', value: '0', options: [['0', 'Keep current password'], ['1', 'Email a password-reset link to this user']] }]
        : [{ name: 'password', label: 'New password (leave blank to keep)', type: 'text' }]),
      ...(r ? [{ name: 'active', label: 'Account access', type: 'select', value: r.active === 0 || r.active === false ? 0 : 1, options: [[1, 'Active (allowed to sign in)'], [0, 'Restricted / Suspended (block all access)']] }] : []),
      ...(restrictHtml ? [{ type: 'html', html: restrictHtml }] : []),
    ], async d => {
      if (canRestrictUser) {
        const restrict = {};
        if (d.role !== 'developer') {
          f.querySelectorAll('[data-rmod]').forEach(cb => { if (cb.checked) restrict[cb.dataset.rmod] = true; });
        }
        d.restrict = restrict;
      }
      if (r) { d.active = +d.active; await api('PUT', '/api/users/' + r.id, d); }
      else {
        const created = await api('POST', '/api/users', d);
        if (canRestrictUser && created?.id && Object.keys(d.restrict || {}).length) {
          await api('PUT', '/api/users/' + created.id, { name: d.name, email: d.email, role: d.role, phone: d.phone, active: 1, restrict: d.restrict });
        }
      }
      toast(d.send_reset === '1' ? 'User saved · reset email sent' : 'User saved');
      viewUsers();
    });
  };

  catalogView({
    title: 'Users',
    rows,
    onNew: () => form(),
    onEdit: form,
    editable: can('users', 2),
    canEditRow: r => r.role !== 'developer' || isDev(),
    cols: [
      { h: 'Name', f: r => {
        const rKeys = Object.keys(r.restrict || {}).filter(k => r.restrict[k]);
        const rText = rKeys.length ? `<div class="small overdue">Restricted: ${rKeys.map(k => esc(modName[k] || k)).join(', ')}</div>` : '';
        return `<b>${esc(r.name)}</b><div class="small muted">${esc(r.email)}</div>${rText}`;
      }},
      { h: 'Profile', f: r => `<span class="badge ${r.role === 'developer' ? 'st-en_progreso' : r.role === 'master' ? 'st-asignada' : ''}">${esc(pname[r.role] || r.role)}</span>` },
      { h: 'Phone', cls: 'hide-m', f: r => esc(r.phone || '—') },
      { h: 'Access', f: r => r.active
        ? '<span class="badge st-completada">Active</span>'
        : '<span class="badge st-bad">Restricted</span>' },
      ...(isDev() ? [{ h: '', f: r => (r.role === 'developer' || r.id === S.me.id) ? '' : `<div class="row" style="gap:6px;flex-wrap:nowrap">
        <button type="button" class="btn sm" data-preview-user="${esc(r.id)}" title="Test app as this user">👁 Preview</button>
        <button type="button" class="btn sm ${r.active ? 'bad' : 'ok'}" data-tog-user="${esc(r.id)}">${r.active ? 'Restrict' : 'Restore'}</button>
      </div>` }] : []),
    ],
  });

  app.querySelectorAll('[data-preview-user]').forEach(btn => btn.onclick = run(async ev => {
    ev.stopPropagation();
    await switchUserTo(btn.dataset.previewUser);
  }));

  app.querySelectorAll('[data-tog-user]').forEach(btn => btn.onclick = run(async ev => {
    ev.stopPropagation();
    const u = rows.find(x => x.id === btn.dataset.togUser);
    if (!u) return;
    const nextActive = u.active ? 0 : 1;
    if (!nextActive && !confirm(`Restrict all access for "${u.name}"? They will be signed out and blocked immediately.`)) return;
    await api('PUT', '/api/users/' + u.id, {
      name: u.name,
      email: u.email,
      role: u.role,
      phone: u.phone || '',
      active: nextActive,
      restrict: u.restrict || {},
    });
    toast(nextActive ? `Access restored for ${u.name}` : `Access restricted for ${u.name}`);
    viewUsers();
  }));
}

// ================= Developer: profiles & permissions =================
async function viewPermissions() {
  const profiles = await api('GET', '/api/profiles');
  const M = PERMS.MODULES;
  const draft = Object.fromEntries(profiles.map(p => [p.key, { ...PERMS.cleanPerms(p.perms) }]));

  const lvlCell = (p, m) => {
    const cur = draft[p.key][m.key];
    const maxLvl = Math.max(...m.levels);
    return `<div class="perm-cell">
      <label class="sv-switch" title="${cur > 0 ? 'Disable module' : 'Enable module'}">
        <input type="checkbox" data-sw-p="${esc(p.key)}" data-sw-m="${m.key}" data-max="${maxLvl}" ${cur > 0 ? 'checked' : ''}>
        <span class="sv-slider"></span>
      </label>
      <select data-p="${esc(p.key)}" data-m="${m.key}" class="lvl lvl-${cur}">${m.levels.map(l => `<option value="${l}" ${cur === l ? 'selected' : ''}>${PERMS.LEVEL_NAMES[l]}</option>`).join('')}</select>
    </div>`;
  };

  app.innerHTML = `
  <div class="row between"><h1>Modules &amp; Permissions</h1><div class="row"><button class="btn" id="bNewProf">+ New user type</button><button class="btn pri" id="bSavePerms">Save changes</button></div></div>
  <p class="muted small" style="margin-top:-6px">Enable or disable modules for each user type using the switches or access levels (<b>No access</b> / <b>View</b> / <b>Full</b>). Developer always has unrestricted access. To restrict an individual user, go to <a href="#/usuarios">Users</a>.</p>
  <div class="card tbl-wrap"><table class="perm"><thead><tr><th>Module</th><th class="pc">Developer<div class="small muted">unrestricted</div></th>
    ${profiles.map(p => `<th class="pc"><button class="link" data-prof="${esc(p.key)}">${esc(p.name)}</button><div class="small muted">${p.users} user(s)${p.builtin ? ' · built-in' : ''}</div></th>`).join('')}</tr></thead>
  <tbody>${M.map(m => `<tr><td><b>${m.name}</b>${m.help ? `<div class="small muted">${m.help}</div>` : ''}</td><td class="pc"><span class="badge st-completada">Full</span></td>
    ${profiles.map(p => `<td class="pc">${lvlCell(p, m)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  const syncControl = (pKey, mKey, val) => {
    draft[pKey][mKey] = val;
    const sel = app.querySelector(`select[data-p="${pKey}"][data-m="${mKey}"]`);
    const sw = app.querySelector(`input[data-sw-p="${pKey}"][data-sw-m="${mKey}"]`);
    if (sel) { sel.value = String(val); sel.className = 'lvl lvl-' + val; }
    if (sw) { sw.checked = val > 0; }
  };

  app.querySelectorAll('select.lvl').forEach(sel => sel.onchange = () => {
    syncControl(sel.dataset.p, sel.dataset.m, +sel.value);
  });

  app.querySelectorAll('input[data-sw-p]').forEach(sw => sw.onchange = () => {
    const val = sw.checked ? Number(sw.dataset.max) : 0;
    syncControl(sw.dataset.swP, sw.dataset.swM, val);
  });

  $('#bSavePerms').onclick = run(async () => {
    const fixes = [];
    for (const p of profiles) {
      const d = draft[p.key];
      if (d.dashboard && !d.orders) { d.orders = 1; fixes.push(`${p.name}: Dashboard needs "All work orders: View" — enabled it`); }
      if (JSON.stringify(d) !== JSON.stringify(PERMS.cleanPerms(p.perms))) await api('PUT', '/api/profiles/' + p.key, { name: p.name, perms: d });
    }
    toast(fixes.length ? fixes.join(' · ') : 'Module permissions saved');
    viewPermissions();
  });

  $('#bNewProf').onclick = () => formModal('New user type / profile', [
    { name: 'name', label: 'Profile name', required: true, placeholder: 'E.g. Supervisor, Warehouse, Receptionist' },
    { name: 'copy', label: 'Start with the modules of', type: 'select', value: 'tecnico', options: [['', '— None (all modules disabled) —'], ...profiles.map(p => [p.key, p.name])] },
  ], async d => { await api('POST', '/api/profiles', { name: d.name, perms: d.copy ? draft[d.copy] : {} }); toast('User type created'); viewPermissions(); }, 'Create');

  app.querySelectorAll('[data-prof]').forEach(b => b.onclick = () => {
    const p = profiles.find(x => x.key === b.dataset.prof);
    formModal('User type: ' + p.name, [
      { name: 'name', label: 'Name', required: true, value: p.name },
      { type: 'html', html: `<div class="row" style="margin-bottom:10px">
        <button type="button" class="btn sm ok" id="bProfEnableAll">Enable all modules</button>
        <button type="button" class="btn sm bad" id="bProfDisableAll">Disable all modules</button>
      </div>` },
      { type: 'html', html: p.builtin ? '<p class="small muted">Built-in profile: it can be renamed and its modules customized, but not deleted.</p>' : p.users ? `<p class="small muted">${p.users} user(s) have this profile. Move them to another profile before deleting it.</p>` : '' },
    ], async d => { await api('PUT', '/api/profiles/' + p.key, { name: d.name, perms: draft[p.key] }); toast('Profile saved'); viewPermissions(); });

    $('#bProfEnableAll').onclick = () => {
      M.forEach(m => syncControl(p.key, m.key, Math.max(...m.levels)));
      toast(`All modules enabled for ${p.name} (click Save changes to apply)`);
      $('#modal').close();
    };
    $('#bProfDisableAll').onclick = () => {
      M.forEach(m => syncControl(p.key, m.key, 0));
      toast(`All modules disabled for ${p.name} (click Save changes to apply)`);
      $('#modal').close();
    };

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
  const fieldSections = [
    ['field_show_diagnosis', 'Diagnosis', 'Text field to describe what was found on site (required before closing when enabled)'],
    ['field_show_photos', 'Photos (Diagnosis / Before / After)', 'Camera upload and photo gallery on work orders'],
    ['field_show_checklist', 'Checklist & readings', 'Inspection checklist items and measurements'],
    ['field_show_parts', 'Parts & materials used', 'Select parts from inventory and deduct stock'],
    ['field_show_work_done', 'Work performed', 'Summary of repair or maintenance actions completed'],
    ['field_show_recommendations', 'Recommendations to client', 'Follow-up notes and recommendations'],
    ['field_show_received_by', 'Client sign-off contact name', '"Received by" on-site contact name field'],
    ['field_show_signature', 'Client signature pad', 'Touchscreen signature pad for client approval'],
  ];

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

    <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">
    <h2>Technician Field Work Sections</h2>
    <p class="muted small" style="margin-top:-6px">Choose which sections field technicians see and complete on their work orders. Arrival and departure time logs are always active.</p>
    <div class="tbl-wrap" style="margin-bottom:14px">
      <table>
        <thead><tr><th>Field section</th><th>Description</th><th style="text-align:center;width:110px">Enabled</th></tr></thead>
        <tbody>
          ${fieldSections.map(([key, title, desc]) => {
            const on = (s[key] ?? '1') !== '0';
            return `<tr>
              <td><b>${esc(title)}</b></td>
              <td class="small muted">${esc(desc)}</td>
              <td style="text-align:center">
                <label class="sv-switch" title="${on ? 'Disable section' : 'Enable section'}">
                  <input type="checkbox" data-fsec="${key}" ${on ? 'checked' : ''}>
                  <span class="sv-slider"></span>
                </label>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <button class="btn pri">Save settings</button>
  </form>
  <div class="card"><h2>Logo</h2>
    <div class="row">${logo ? `<img src="${esc(logo)}" class="logo-prev" alt="">` : '<span class="muted">No logo uploaded.</span>'}</div>
    <div class="row" style="margin-top:10px"><label class="btn camera-btn" style="margin:0">Upload logo (PNG/JPG/SVG)<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" id="fLogo"></label>
    ${logo ? '<button class="btn bad" id="bDelLogo">Remove</button>' : ''}</div></div>`;
  $('#sf').onsubmit = run(async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    $('#sf').querySelectorAll('[data-fsec]').forEach(cb => {
      data[cb.dataset.fsec] = cb.checked ? '1' : '0';
    });
    await api('PUT', '/api/settings', data);
    toast('Settings saved');
    S.settings = null;
    syncBrand(data);
  });
  $('#fLogo').onchange = run(async e => { const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append('logo', f, f.name); await api('POST', '/api/settings/logo', fd); toast('Logo updated'); viewSettings(); });
  $('#bDelLogo') && ($('#bDelLogo').onclick = run(async () => { if (!confirm('Remove logo?')) return; await api('DELETE', '/api/settings/logo'); viewSettings(); }));

  if (isDev() && !S.me?.impersonating) {
    const dz = document.createElement('div');
    dz.className = 'card';
    dz.style.borderColor = '#f3c4c4';
    dz.style.background = '#fff9f9';
    dz.innerHTML = `<h2 style="color:var(--bad)">Developer · Go-Live Data Reset</h2>
      <p class="small muted" style="margin-top:-4px">Delete all test data created during the trial period before going live: <b>work orders</b> (resets counter back to <code>WO-00001</code>), <b>photos &amp; signatures</b>, <b>preventive plans</b>, <b>clients</b>, <b>A/C units</b>, <b>parts</b>, and <b>all users except your Developer account</b>. Company settings, logo, and permission profiles are preserved.</p>
      <button type="button" class="btn bad" id="bResetTestData">🗑️ Delete all test data (Go Live)</button>`;
    app.append(dz);

    $('#bResetTestData').onclick = () => {
      formModal('⚠️ Delete all test data', [
        { type: 'html', html: `<div class="alert" style="margin-top:0;margin-bottom:12px">This action is permanent and cannot be undone. All test work orders, photos, signatures, plans, clients, units, parts, and non-developer users will be erased.</div>` },
        { type: 'html', html: `<label class="restrict-item" style="margin-bottom:12px"><input type="checkbox" name="reset_checklists" value="1"><span>Also reset Checklists back to the 2 default templates</span></label>` },
        { name: 'confirm', label: 'Type RESET in capital letters to confirm', required: true, placeholder: 'RESET' },
      ], async d => {
        if ((d.confirm || '').trim() !== 'RESET') throw new Error('You must type RESET in capital letters to confirm');
        toast('Deleting test data, please wait…');
        const res = await api('POST', '/api/admin/reset-test-data', {
          confirm: 'RESET',
          reset_checklists: d.reset_checklists === '1',
        });
        S.cache = {};
        const c = res?.counts || {};
        toast(`Live reset complete! Deleted ${c.orders || 0} orders, ${c.clients || 0} clients, ${c.equipment || 0} units, ${c.parts || 0} parts, ${c.plans || 0} plans, and ${c.users || 0} users.`);
        viewSettings();
      }, 'Delete all test data');
    };
  }
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
  const bio = getBioData();
  if (bio && S.me?.email && bio.email === S.me.email.toLowerCase() && sessionStorage.getItem('sv_bio_ok') !== S.me.id) {
    return renderBiometricLock(S.me);
  }
  S.cache = {}; S.settings = null;
  settings().then(syncBrand).catch(() => {});
  if (can('plans', 2) && FB()) api('POST', '/api/plans/run').then(r => r.orders && toast(`${r.orders} preventive work order(s) generated`)).catch(e => console.warn('plans', e));
  if (!location.hash) location.hash = '#/';
  await route();
  hideSplash();
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();

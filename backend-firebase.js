// =====================================================================
//  Firebase backend — Sveiki Construction (A/C Maintenance)
//  Answers the same api(method, url, body) calls as server.js over HTTP,
//  using Firebase Auth + Cloud Firestore (free Spark plan compatible).
// =====================================================================
import {
  initializeApp, deleteApp, getAuth, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  inMemoryPersistence, setPersistence, initializeFirestore, doc,
  getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query,
  where, limit, orderBy, runTransaction, writeBatch, serverTimestamp,
  Timestamp, arrayUnion,
} from './vendor/firebase.js';

const PERMS = window.PERMS;
const OPEN = ['pendiente', 'asignada', 'en_progreso'];
const CLOSED = ['completada', 'cancelada'];
const TS_FIELDS = ['created_at', 'updated_at', 'scheduled_at', 'arrival_at', 'departure_at', 'signed_at'];

const DEFAULT_SETTINGS = {
  company_name: 'Sveiki Construction',
  company_phone: '',
  company_email: '',
  company_address: '',
  report_footer: 'Thank you for trusting Sveiki Construction.',
  report_show_costs: '0',
  preventive_lead_days: '7',
  // Technician field workflow sections ('1' = enabled, '0' = disabled)
  field_show_diagnosis: '1',
  field_show_photos: '1',
  field_show_checklist: '0',
  field_show_parts: '1',
  field_show_work_done: '1',
  field_show_recommendations: '1',
  field_show_received_by: '0',
  field_show_signature: '0',
};

const CATALOGS = {
  clients: { mod: 'clients', fields: ['name', 'type', 'address', 'contact_name', 'contact_phone', 'notes'], num: [], sort: (a, b) => cmp(a.name, b.name) },
  equipment: { mod: 'units', fields: ['client_id', 'location', 'kind', 'brand', 'model', 'btu', 'serial', 'notes'], num: ['btu'], sort: (a, b) => cmp(a.location, b.location, true) },
  parts: { mod: 'parts', fields: ['code', 'name', 'unit', 'cost', 'stock', 'min_stock'], num: ['cost', 'stock', 'min_stock'], sort: (a, b) => cmp(a.name, b.name) },
};

const DEFAULT_CHECKLISTS = [
  {
    name: 'Preventive maintenance - split unit',
    type: 'preventivo',
    items: [
      { label: 'Clean / replace air filters', kind: 'check' },
      { label: 'Clean evaporator coil', kind: 'check' },
      { label: 'Clean condenser coil', kind: 'check' },
      { label: 'Clear condensate drain line', kind: 'check' },
      { label: 'Check electrical connections', kind: 'check' },
      { label: 'Suction pressure', kind: 'number', unit: 'psi' },
      { label: 'Compressor current', kind: 'number', unit: 'A' },
      { label: 'Supply air temperature', kind: 'number', unit: '°F' },
      { label: 'Return air temperature', kind: 'number', unit: '°F' },
      { label: 'Observations', kind: 'text' },
    ],
  },
  {
    name: 'Corrective - basic diagnosis',
    type: 'correctivo',
    items: [
      { label: 'Thermostat / remote checked', kind: 'check' },
      { label: 'Power supply voltage', kind: 'number', unit: 'V' },
      { label: 'Capacitor tested', kind: 'check' },
      { label: 'Compressor current', kind: 'number', unit: 'A' },
      { label: 'Suction pressure', kind: 'number', unit: 'psi' },
      { label: 'Leak check performed', kind: 'check' },
      { label: 'Unit tested after repair', kind: 'check' },
    ],
  },
];

const cmp = (a, b, numeric) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: !!numeric, sensitivity: 'base' });
const iso = v => v?.toDate ? v.toDate().toISOString() : (v ?? null);
const toTs = v => v ? Timestamp.fromDate(new Date(v)) : null;
const blank = v => v === '' || v === undefined ? null : v;
const ymd = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const dayStart = s => new Date(s + 'T00:00:00');
const dayEnd = s => new Date(s + 'T23:59:59.999');
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

class ApiError extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

function mapError(e) {
  if (e instanceof ApiError) return e;
  const code = e?.code || '';
  const M = {
    'permission-denied': 'Access denied',
    'auth/invalid-credential': 'Wrong email or password',
    'auth/wrong-password': 'Wrong email or password',
    'auth/user-not-found': 'Wrong email or password',
    'auth/invalid-email': 'Invalid email address',
    'auth/email-already-in-use': 'That email is already registered',
    'auth/weak-password': 'Password must be at least 6 characters',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed': 'No connection. Check your internet and try again.',
    'unavailable': 'No connection. Check your internet and try again.',
    'auth/requires-recent-login': 'Please sign out and sign in again, then retry.',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled in Firebase Authentication.',
  };
  const err = new ApiError(M[code] || e?.message || 'Unexpected error', code === 'permission-denied' ? 403 : 400);
  err.cause = e;
  return err;
}

const blobToDataURL = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

function loadImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new ApiError('Could not read the image')); };
    img.src = url;
  });
}

async function imageToDataURL(blob, { maxSide = 1280, type = 'image/jpeg', quality = 0.72, maxChars = 850000 } = {}) {
  const img = await loadImage(blob);
  for (const [side, q] of [[maxSide, quality], [1024, 0.65], [800, 0.6], [640, 0.55]]) {
    const k = Math.min(1, side / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k);
    c.height = Math.round(img.height * k);
    const ctx = c.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL(type, q);
    if (data.length <= maxChars) return data;
  }
  throw new ApiError('Image is too large');
}

export async function createBackend(config) {
  if (!config?.apiKey || /PASTE|YOUR_PROJECT/.test(config.apiKey + config.projectId)) {
    throw new ApiError('Firebase is not configured yet (config.js)');
  }
  const fbApp = initializeApp(config);
  const auth = getAuth(fbApp);
  const db = initializeFirestore(fbApp, { ignoreUndefinedProperties: true });
  if (auth.authStateReady) await auth.authStateReady();

  let me = null;
  let realMe = null;
  let impersonateUid = null;
  const photoCache = new Map();
  const photoOrder = new Map();
  const sigCache = new Map();
  let logoCache = null;

  const ref = (...p) => doc(db, ...p.map(String));
  const col = (...p) => collection(db, ...p.map(String));
  const can = (mod, lvl = 1) => (me?.perms?.[mod] || 0) >= lvl;
  const need = (mod, lvl = 1) => { if (!can(mod, lvl)) throw new ApiError('You do not have access to this module', 403); };
  const isDev = () => me?.role === 'developer';
  const isClosed = o => CLOSED.includes(o.status);

  async function profilesMap() {
    const snap = await getDocs(col('profiles'));
    return Object.fromEntries(snap.docs.map(d => [d.id, { key: d.id, ...d.data() }]));
  }

  const canWork = o => can('orders', 2) || (o.technician_id === me.id && can('field', 2));
  function assertWork(o, { requireArrival = false } = {}) {
    if (!canWork(o)) throw new ApiError('Access denied', 403);
    if (!can('orders', 2)) {
      if (isClosed(o)) throw new ApiError('This work order is closed');
      if (requireArrival && !o.arrival_at) throw new ApiError('Record arrival first');
    }
  }

  async function buildUserObj(uid, data) {
    const role = data.role;
    let prof = null;
    if (role !== 'developer') {
      const ps = await getDoc(ref('profiles', role));
      prof = ps.exists() ? ps.data() : null;
    }
    const restrict = PERMS.cleanRestrict(data.restrict);
    return {
      id: uid,
      ...data,
      restrict,
      created_at: iso(data.created_at),
      perms: PERMS.permsFor(role, prof ? { [role]: prof } : {}, restrict),
      role_name: role === 'developer' ? 'Developer' : (prof?.name || role),
    };
  }

  async function loadMe() {
    const u = auth.currentUser;
    if (!u) { me = null; realMe = null; impersonateUid = null; throw new ApiError('Not authenticated', 401); }
    const s = await getDoc(ref('users', u.uid));
    if (!s.exists() || s.data().active !== true) {
      me = null;
      realMe = null;
      impersonateUid = null;
      await signOut(auth);
      throw new ApiError('This account is not active. Contact the administrator.', 401);
    }
    realMe = await buildUserObj(u.uid, s.data());
    if (realMe.role === 'developer' && impersonateUid && impersonateUid !== u.uid) {
      const ts = await getDoc(ref('users', impersonateUid));
      if (ts.exists()) {
        const targetObj = await buildUserObj(impersonateUid, ts.data());
        me = {
          ...targetObj,
          impersonating: true,
          real_user: { id: realMe.id, name: realMe.name, email: realMe.email, role: realMe.role },
        };
        return me;
      } else {
        impersonateUid = null;
      }
    }
    me = realMe;
    return me;
  }

  async function ensureMe() {
    if (!realMe || realMe.id !== auth.currentUser?.uid) await loadMe();
    return me;
  }

  async function list(name, { all } = {}) {
    const snap = await getDocs(col(name));
    let rows = snap.docs.map(d => ({ id: d.id, ...d.data(), created_at: iso(d.data().created_at) }));
    if (!all) rows = rows.filter(r => r.active !== 0 && r.active !== false);
    return rows;
  }

  function cleanCatalog(name, body) {
    const c = CATALOGS[name], out = {};
    for (const f of c.fields) {
      if (f in body) out[f] = c.num.includes(f) ? (blank(body[f]) == null ? null : Number(body[f])) : blank(body[f]);
    }
    if ('active' in body) out.active = body.active === 0 || body.active === '0' ? 0 : 1;
    return out;
  }

  async function settingsDoc() {
    const s = await getDoc(ref('settings', 'app'));
    return { ...DEFAULT_SETTINGS, ...(s.exists() ? s.data() : {}) };
  }

  function normOrder(snap) {
    const d = snap.data();
    const o = { ...d, id: Number(snap.id) };
    for (const k of TS_FIELDS) o[k] = iso(d[k]);
    o.parts = (d.parts || []).map(p => ({ ...p }));
    o.photos = (d.photos || []).map(p => ({ ...p }));
    o.parts_cost = o.parts.reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.unit_cost) || 0), 0);
    o.photo_count = o.photos.length;
    return o;
  }

  async function readOrder(id) {
    let s;
    try { s = await getDoc(ref('orders', id)); } catch (e) { throw mapError(e); }
    if (!s.exists()) throw new ApiError('Work order not found', 404);
    const o = normOrder(s);
    if (!can('orders', 1) && !(o.technician_id === me.id && can('field', 2))) {
      throw new ApiError('Access denied', 403);
    }
    return o;
  }

  async function getOrderFull(id) {
    const o = await readOrder(id);
    await Promise.all(o.photos.map(async p => {
      photoOrder.set(p.id, o.id);
      if (!photoCache.has(p.id)) {
        const s = await getDoc(ref('orders', o.id, 'photos', p.id));
        if (s.exists()) photoCache.set(p.id, s.data().data);
      }
      p.src = photoCache.get(p.id) || '';
    }));
    o.photos.sort((a, b) => cmp(a.created_at, b.created_at));
    if (o.has_signature) {
      const key = o.id + '|' + o.signed_at;
      if (!sigCache.has(key)) {
        const s = await getDoc(ref('orders', o.id, 'files', 'signature'));
        if (s.exists()) sigCache.set(key, s.data().data);
      }
      o.signature_src = sigCache.get(key) || '';
    }
    return o;
  }

  async function denorm(b) {
    const out = {};
    if ('client_id' in b) {
      const c = b.client_id ? await getDoc(ref('clients', b.client_id)) : null;
      if (!c?.exists()) throw new ApiError('Client required');
      Object.assign(out, {
        client_id: c.id,
        client_name: c.data().name,
        client_address: c.data().address || null,
        contact_name: c.data().contact_name || null,
        contact_phone: c.data().contact_phone || null,
      });
    }
    if ('equipment_id' in b) {
      const e = b.equipment_id ? await getDoc(ref('equipment', b.equipment_id)) : null;
      const d = e?.exists() ? e.data() : null;
      Object.assign(out, {
        equipment_id: d ? e.id : null,
        eq_location: d?.location || null,
        eq_kind: d?.kind || null,
        eq_brand: d?.brand || null,
        eq_model: d?.model || null,
        eq_btu: d?.btu ?? null,
        eq_serial: d?.serial || null,
      });
    }
    if ('technician_id' in b) {
      const u = b.technician_id ? await getDoc(ref('users', b.technician_id)) : null;
      Object.assign(out, {
        technician_id: u?.exists() ? u.id : null,
        technician_name: u?.exists() ? u.data().name : null,
      });
    }
    return out;
  }

  async function checklistFromTemplate(id) {
    if (!id) return null;
    const s = await getDoc(ref('checklists', id));
    if (!s.exists()) return null;
    return (s.data().items || []).map(i => ({ ...i, value: i.kind === 'check' ? false : '' }));
  }

  function emptyOrder() {
    const o = {};
    [
      'client_id', 'client_name', 'client_address', 'contact_name', 'contact_phone',
      'equipment_id', 'eq_location', 'eq_kind', 'eq_brand', 'eq_model', 'eq_btu', 'eq_serial',
      'technician_id', 'technician_name', 'reported_issue', 'scheduled_at',
      'arrival_at', 'arrival_lat', 'arrival_lng', 'departure_at', 'departure_lat', 'departure_lng',
      'diagnosis', 'work_done', 'recommendations', 'received_by', 'checklist', 'signed_at', 'plan_id', 'updated_at',
    ].forEach(k => o[k] = null);
    return Object.assign(o, { parts: [], photos: [], has_signature: false });
  }

  async function buildOrder(b) {
    return {
      ...emptyOrder(),
      ...(await denorm({ client_id: b.client_id, equipment_id: b.equipment_id || null, technician_id: b.technician_id || null })),
      type: b.type || 'correctivo',
      priority: b.priority || 'media',
      status: b.technician_id ? 'asignada' : 'pendiente',
      reported_issue: blank(b.reported_issue),
      scheduled_at: toTs(b.scheduled_at),
      checklist: await checklistFromTemplate(b.checklist_id),
      plan_id: b.plan_id || null,
      created_by: me.id,
      created_at: serverTimestamp(),
    };
  }

  async function insertOrder(data, extra) {
    return runTransaction(db, async tx => {
      const cRef = ref('counters', 'orders');
      const pre = extra ? await extra.read(tx) : null;
      if (extra && pre === false) return null;
      const c = await tx.get(cRef);
      const n = (c.exists() ? c.data().n : 0) + 1;
      tx.set(cRef, { n });
      tx.set(ref('orders', n), { ...data, num: n });
      if (extra) extra.write(tx, n);
      return n;
    });
  }

  function mergeChecklist(current, incoming) {
    if (!Array.isArray(current) || !Array.isArray(incoming)) return current;
    return current.map((it, i) => ({
      ...it,
      value: it.kind === 'check' ? !!incoming[i]?.value : String(incoming[i]?.value ?? '').slice(0, 500),
    }));
  }

  function filterSortOrders(rows, q) {
    const st = q.status ? q.status.split(',') : null;
    const from = q.from ? dayStart(q.from) : null;
    const to = q.to ? dayEnd(q.to) : null;
    const term = (q.q || '').trim().toLowerCase();

    rows = rows.filter(o =>
      (!st || st.includes(o.status))
      && (!q.type || o.type === q.type)
      && (!q.priority || o.priority === q.priority)
      && (!q.technician_id || o.technician_id === q.technician_id)
      && (!q.client_id || o.client_id === q.client_id)
      && (!q.equipment_id || o.equipment_id === q.equipment_id)
      && (!from || new Date(o.created_at || Date.now()) >= from)
      && (!to || new Date(o.created_at || Date.now()) <= to)
      && (!term || [
        'wo-' + String(o.id).padStart(5, '0'),
        String(o.id),
        o.client_name,
        o.eq_location,
        o.eq_brand,
        o.technician_name,
        o.reported_issue,
      ].some(v => v && String(v).toLowerCase().includes(term)))
    );

    const sr = { en_progreso: 0, asignada: 1, pendiente: 2 };
    const pr = { urgente: 0, alta: 1, media: 2 };
    rows.sort((a, b) =>
      (sr[a.status] ?? 3) - (sr[b.status] ?? 3)
      || (pr[a.priority] ?? 3) - (pr[b.priority] ?? 3)
      || cmp(b.scheduled_at || b.created_at, a.scheduled_at || a.created_at)
    );
    return rows.slice(0, 500);
  }

  async function queryOrders(q = {}) {
    const base = col('orders');
    let qq;
    if (!can('orders', 1) || q.mine === '1') {
      if (!can('field', 2)) return [];
      qq = query(base, where('technician_id', '==', me.id));
    } else if (q.technician_id) qq = query(base, where('technician_id', '==', q.technician_id));
    else if (q.equipment_id) qq = query(base, where('equipment_id', '==', q.equipment_id));
    else if (q.client_id) qq = query(base, where('client_id', '==', q.client_id));
    else if (q.from) qq = query(base, where('created_at', '>=', Timestamp.fromDate(dayStart(q.from))));
    else if (q.status) qq = query(base, where('status', 'in', q.status.split(',').slice(0, 10)));
    else qq = query(base, orderBy('created_at', 'desc'), limit(1000));
    const snap = await getDocs(qq);
    return snap.docs.map(normOrder);
  }

  async function runPlans() {
    need('plans', 2);
    const lead = Math.max(0, parseInt((await settingsDoc()).preventive_lead_days, 10) || 0);
    const todayS = ymd(new Date()), horizon = addDays(todayS, lead);
    const plans = (await getDocs(col('plans'))).docs.filter(d => d.data().active !== 0 && d.data().next_due <= horizon);
    let created = 0;

    for (const pd of plans) {
      const p = pd.data();
      const eq = await getDoc(ref('equipment', p.equipment_id));
      if (!eq.exists() || eq.data().active === 0) continue;
      const data = await buildOrder({
        client_id: eq.data().client_id,
        equipment_id: p.equipment_id,
        technician_id: p.technician_id,
        type: 'preventivo',
        priority: p.priority,
        reported_issue: p.task || `Scheduled preventive maintenance (every ${p.every_days} days)`,
        scheduled_at: new Date(p.next_due + 'T08:00:00').toISOString(),
        checklist_id: p.checklist_id,
        plan_id: pd.id,
      });
      const planRef = ref('plans', pd.id);
      const n = await insertOrder(data, {
        read: async tx => {
          const cur = await tx.get(planRef);
          if (!cur.exists() || cur.data().active === 0 || cur.data().next_due > horizon) return false;
          if (cur.data().open_order_id) {
            const o = await tx.get(ref('orders', cur.data().open_order_id));
            if (o.exists() && OPEN.includes(o.data().status)) return false;
          }
          return cur.data();
        },
        write: (tx, num) => {
          let next = addDays(p.next_due, p.every_days);
          if (next < todayS) next = addDays(todayS, p.every_days);
          tx.update(planRef, { next_due: next, open_order_id: num });
        },
      });
      if (n) created++;
    }
    return created;
  }

  async function stats(q) {
    need('dashboard');
    need('orders');
    const from = q.from || ymd(new Date(Date.now() - 30 * 864e5));
    const to = q.to || ymd(new Date());
    const [rangeSnap, openSnap, users, profs, parts, plans] = await Promise.all([
      getDocs(query(col('orders'), where('created_at', '>=', Timestamp.fromDate(dayStart(from))))),
      getDocs(query(col('orders'), where('status', 'in', OPEN))),
      list('users', { all: true }),
      profilesMap(),
      list('parts'),
      list('plans', { all: true }),
    ]);

    const end = dayEnd(to);
    const inRange = rangeSnap.docs.map(normOrder).filter(o => new Date(o.created_at || Date.now()) <= end);
    const openOrders = openSnap.docs.map(normOrder);
    const onsite = o => (new Date(o.departure_at) - new Date(o.arrival_at)) / 60000;
    const done = inRange.filter(o => o.status === 'completada' && o.arrival_at && o.departure_at);
    const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

    const byStatusMap = {};
    inRange.forEach(o => byStatusMap[o.status] = (byStatusMap[o.status] || 0) + 1);

    const byTech = users
      .filter(u => u.active === true && (u.role === 'developer' || (!u.restrict?.field && (profs[u.role]?.perms?.field || 0) >= 2)))
      .map(u => {
        const mine = inRange.filter(o => o.technician_id === u.id);
        const d = mine.filter(o => o.status === 'completada' && o.arrival_at && o.departure_at);
        return {
          id: u.id,
          name: u.name,
          done: d.length,
          open: mine.filter(o => ['asignada', 'en_progreso'].includes(o.status)).length,
          avg_onsite: avg(d.map(onsite)),
        };
      })
      .filter(t => t.done > 0 || t.open > 0 || (profs[users.find(u => u.id === t.id)?.role]?.perms?.field || 0) >= 2)
      .sort((a, b) => b.done - a.done || cmp(a.name, b.name));

    const clientMap = {};
    inRange.forEach(o => {
      const c = clientMap[o.client_id] ||= { name: o.client_name, n: 0, parts_cost: 0 };
      c.n++;
      c.parts_cost += o.parts_cost;
    });

    const partMap = {};
    inRange.forEach(o => o.parts.forEach(p => {
      const x = partMap[p.part_id] ||= { name: p.name, unit: p.unit, qty: 0, cost: 0 };
      x.qty += +p.qty;
      x.cost += p.qty * p.unit_cost;
    }));

    const now = new Date();
    return {
      from,
      to,
      open: openOrders.length,
      byStatus: Object.entries(byStatusMap).map(([status, n]) => ({ status, n })),
      times: {
        avg_onsite: avg(done.map(onsite)),
        avg_response: avg(done.map(o => Math.max(0, (new Date(o.arrival_at) - new Date(o.scheduled_at || o.created_at)) / 60000))),
        total_onsite: done.length ? done.reduce((s, o) => s + onsite(o), 0) : null,
      },
      byTech,
      byClient: Object.values(clientMap).sort((a, b) => b.n - a.n).slice(0, 10),
      topParts: Object.values(partMap).sort((a, b) => b.cost - a.cost).slice(0, 10),
      lowStock: parts.filter(p => Number(p.stock) <= Number(p.min_stock)).sort((a, b) => (a.stock - a.min_stock) - (b.stock - b.min_stock)),
      overdue: openOrders
        .filter(o => o.type === 'preventivo' && ['pendiente', 'asignada'].includes(o.status) && o.scheduled_at && new Date(o.scheduled_at) < now)
        .sort((a, b) => cmp(a.scheduled_at, b.scheduled_at))
        .slice(0, 50),
      upcoming: plans.filter(p => p.active !== 0 && p.next_due <= addDays(ymd(now), 30)).length,
    };
  }

  async function csv(q) {
    need('reports');
    need('orders');
    let rows = await queryOrders(q.from ? { from: q.from } : {});
    rows = filterSortOrders(rows, { from: q.from, to: q.to }).sort((a, b) => a.id - b.id);
    const EN = {
      pendiente: 'Pending', asignada: 'Assigned', en_progreso: 'On site', completada: 'Completed', cancelada: 'Cancelled',
      correctivo: 'Corrective', preventivo: 'Preventive',
      baja: 'Low', media: 'Medium', alta: 'High', urgente: 'Urgent',
    };
    const cols = [
      'WO', 'Created', 'Type', 'Priority', 'Status', 'Client', 'Unit', 'Technician',
      'Scheduled', 'Arrival', 'Departure', 'Min. on site', 'Min. response',
      'Reported issue', 'Diagnosis', 'Work performed', 'Parts', 'Parts cost', 'Photos', 'Signed', 'Received by',
    ];
    const e = v => { v = v == null ? '' : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const m = (a, b) => a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : '';
    const lines = [cols.join(',')];
    for (const o of rows) {
      lines.push([
        'WO-' + String(o.id).padStart(5, '0'),
        o.created_at,
        EN[o.type],
        EN[o.priority],
        EN[o.status],
        o.client_name,
        [o.eq_location, o.eq_brand, o.eq_model].filter(Boolean).join(' / '),
        o.technician_name,
        o.scheduled_at,
        o.arrival_at,
        o.departure_at,
        m(o.arrival_at, o.departure_at),
        o.arrival_at ? m(o.scheduled_at || o.created_at, o.arrival_at) : '',
        o.reported_issue,
        o.diagnosis,
        o.work_done,
        o.parts.map(p => `${p.name} x${p.qty} ${p.unit}`).join(' | '),
        o.parts_cost.toFixed(2),
        o.photo_count,
        o.has_signature ? 'Yes' : 'No',
        o.received_by,
      ].map(e).join(','));
    }
    return { csv: '\uFEFF' + lines.join('\n') };
  }

  const routes = [];
  const R = (method, pattern, fn) => routes.push({
    method,
    re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'),
    fn,
  });

  R('GET', '/api/setup-status', async () => ({ needsSetup: !(await getDoc(ref('meta', 'setup'))).exists() }));

  R('POST', '/api/setup', async (p, b) => {
    if ((await getDoc(ref('meta', 'setup'))).exists()) throw new ApiError('Already set up');
    if (!b.name || !b.email || !b.password) throw new ApiError('Name, email and password required');
    const cred = await createUserWithEmailAndPassword(auth, b.email.trim(), b.password);
    const batch = writeBatch(db);
    batch.set(ref('users', cred.user.uid), {
      name: b.name.trim(),
      email: b.email.trim().toLowerCase(),
      role: 'developer',
      phone: null,
      active: true,
      created_at: serverTimestamp(),
    });
    batch.set(ref('meta', 'setup'), { done: true, by: cred.user.uid, at: serverTimestamp() });
    await batch.commit();
    await loadMe();
    const b2 = writeBatch(db);
    DEFAULT_CHECKLISTS.forEach(c => b2.set(doc(col('checklists')), { ...c, active: 1, created_at: serverTimestamp() }));
    b2.set(ref('settings', 'app'), DEFAULT_SETTINGS);
    PERMS.DEFAULT_PROFILES.forEach(pr => b2.set(ref('profiles', pr.key), { name: pr.name, perms: pr.perms, builtin: 1 }));
    await b2.commit();
    return { ok: true };
  });

  R('POST', '/api/login', async (p, b) => {
    await signInWithEmailAndPassword(auth, (b.email || '').trim(), b.password || '');
    await loadMe();
    return { ok: true };
  });

  R('POST', '/api/logout', async () => {
    me = null;
    realMe = null;
    impersonateUid = null;
    photoCache.clear();
    sigCache.clear();
    logoCache = null;
    await signOut(auth);
    return { ok: true };
  });

  R('POST', '/api/password-reset', async (p, b) => {
    try { await sendPasswordResetEmail(auth, b.email); }
    catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
    return { ok: true };
  });

  R('GET', '/api/me', async () => {
    const m = await loadMe();
    return {
      id: m.id, name: m.name, email: m.email, role: m.role, phone: m.phone,
      active: m.active, perms: m.perms, role_name: m.role_name,
      ...(m.impersonating ? { impersonating: true, real_user: m.real_user } : {}),
    };
  });

  R('POST', '/api/me/password', async (p, b) => {
    if (!b.password || b.password.length < 6) throw new ApiError('New password must be at least 6 characters');
    await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, b.current || ''));
    await updatePassword(auth.currentUser, b.password);
    return { ok: true };
  });

  R('GET', '/api/users', async () => {
    need('users');
    return (await list('users', { all: true })).sort((a, b) => (b.active === true) - (a.active === true) || cmp(a.name, b.name));
  });

  async function checkRole(role) {
    if (role === 'developer') {
      if (!isDev()) throw new ApiError('Only a developer can assign the Developer profile');
      return;
    }
    if (!(await profilesMap())[role]) throw new ApiError('Unknown profile');
  }

  R('POST', '/api/users', async (p, b) => {
    need('users', 2);
    await checkRole(b.role || 'tecnico');
    if (!b.name || !b.email || !b.password || b.password.length < 6) {
      throw new ApiError('Name, email and password (min. 6 chars) required');
    }
    const sec = initializeApp(config, 'create-user-' + rid());
    try {
      const secAuth = getAuth(sec);
      await setPersistence(secAuth, inMemoryPersistence);
      const cred = await createUserWithEmailAndPassword(secAuth, b.email.trim(), b.password);
      await setDoc(ref('users', cred.user.uid), {
        name: b.name.trim(),
        email: b.email.trim().toLowerCase(),
        role: b.role || 'tecnico',
        phone: blank(b.phone),
        active: true,
        created_at: serverTimestamp(),
      });
      await signOut(secAuth);
      return { id: cred.user.uid };
    } finally {
      deleteApp(sec).catch(() => {});
    }
  });

  R('PUT', '/api/users/:id', async (p, b) => {
    need('users', 2);
    const active = b.active === 0 || b.active === '0' ? false : true;
    const target = await getDoc(ref('users', p.id));
    if (!target.exists()) throw new ApiError('User not found');
    if (target.data().role === 'developer' && !isDev()) throw new ApiError('Only a developer can edit a developer account');
    await checkRole(b.role);
    if (p.id === me.id && (!active || b.role !== me.role)) {
      throw new ApiError('You cannot deactivate yourself or change your own profile');
    }
    const userPatch = {
      name: b.name,
      email: (b.email || '').trim().toLowerCase(),
      role: b.role,
      phone: blank(b.phone),
      active,
    };
    if ('restrict' in b) {
      if (!isDev()) throw new ApiError('Only a developer can restrict individual user modules', 403);
      userPatch.restrict = b.role === 'developer' ? {} : PERMS.cleanRestrict(b.restrict);
    }
    await updateDoc(ref('users', p.id), userPatch);
    if (b.send_reset === '1') await sendPasswordResetEmail(auth, (b.email || '').trim());
    return { ok: true };
  });

  R('GET', '/api/technicians', async () => {
    if (!can('orders') && !can('plans')) return [];
    const [users, profs] = await Promise.all([list('users'), profilesMap()]);
    return users
      .filter(u => u.active === true && !u.restrict?.field && (profs[u.role]?.perms?.field || 0) >= 2)
      .map(u => ({ id: u.id, name: u.name, role: u.role }))
      .sort((a, b) => cmp(a.name, b.name));
  });

  R('GET', '/api/profiles', async () => {
    const profs = Object.values(await profilesMap());
    let users = [];
    if (can('users') || isDev()) users = await list('users', { all: true });
    return profs
      .map(p => ({ ...p, users: users.filter(u => u.role === p.key).length }))
      .sort((a, b) => (b.builtin || 0) - (a.builtin || 0) || cmp(a.name, b.name));
  });

  const devOnly = () => { if (!isDev()) throw new ApiError('Developer only', 403); };

  R('POST', '/api/profiles', async (p, b) => {
    devOnly();
    const name = String(b.name || '').trim();
    if (!name) throw new ApiError('Profile name required');
    const key = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'profile';
    if (key === 'developer' || (await getDoc(ref('profiles', key))).exists()) {
      throw new ApiError('A profile with that name already exists');
    }
    await setDoc(ref('profiles', key), { name, perms: PERMS.cleanPerms(b.perms), builtin: 0 });
    return { key };
  });

  R('PUT', '/api/profiles/:key', async (p, b) => {
    devOnly();
    const cur = await getDoc(ref('profiles', p.key));
    if (!cur.exists()) throw new ApiError('Profile not found');
    await updateDoc(ref('profiles', p.key), {
      name: String(b.name || cur.data().name).trim(),
      perms: PERMS.cleanPerms(b.perms),
    });
    return { ok: true };
  });

  R('DELETE', '/api/profiles/:key', async p => {
    devOnly();
    const cur = await getDoc(ref('profiles', p.key));
    if (!cur.exists()) throw new ApiError('Profile not found');
    if (cur.data().builtin) throw new ApiError('Built-in profiles cannot be deleted');
    if ((await list('users', { all: true })).some(u => u.role === p.key)) {
      throw new ApiError('Move the users of this profile to another one first');
    }
    await deleteDoc(ref('profiles', p.key));
    return { ok: true };
  });

  for (const name of Object.keys(CATALOGS)) {
    R('GET', `/api/${name}`, async (p, b, q) => (await list(name, { all: q.all === '1' })).sort(CATALOGS[name].sort));
    R('POST', `/api/${name}`, async (p, b) => {
      need(CATALOGS[name].mod, 2);
      const data = cleanCatalog(name, b);
      if (name === 'equipment' && (!data.client_id || !data.location)) throw new ApiError('Client and location required');
      if (name !== 'equipment' && !data.name) throw new ApiError('Name required');
      const r = doc(col(name));
      await setDoc(r, { ...data, active: 1, created_at: serverTimestamp() });
      return { id: r.id };
    });
    R('PUT', `/api/${name}/:id`, async (p, b) => {
      need(CATALOGS[name].mod, 2);
      await updateDoc(ref(name, p.id), cleanCatalog(name, b));
      return { ok: true };
    });
  }

  const cleanItems = items => {
    if (!Array.isArray(items) || !items.length) throw new ApiError('Add at least one checklist item');
    return items.slice(0, 100).map(i => ({
      label: String(i.label || '').slice(0, 200),
      kind: ['check', 'number', 'text'].includes(i.kind) ? i.kind : 'check',
      ...(i.unit ? { unit: String(i.unit).slice(0, 20) } : {}),
    })).filter(i => i.label);
  };

  R('GET', '/api/checklists', async (p, b, q) => (await list('checklists', { all: q.all === '1' })).sort((a, b2) => cmp(a.name, b2.name)));
  R('POST', '/api/checklists', async (p, b) => {
    need('checklists', 2);
    if (!b.name) throw new ApiError('Name required');
    const r = doc(col('checklists'));
    await setDoc(r, { name: b.name, type: b.type || 'any', items: cleanItems(b.items), active: 1, created_at: serverTimestamp() });
    return { id: r.id };
  });
  R('PUT', '/api/checklists/:id', async (p, b) => {
    need('checklists', 2);
    await updateDoc(ref('checklists', p.id), { name: b.name, type: b.type || 'any', items: cleanItems(b.items), active: b.active === 0 ? 0 : 1 });
    return { ok: true };
  });

  R('GET', '/api/plans', async () => {
    need('plans');
    const [plans, eq, clients, users, cks, open] = await Promise.all([
      list('plans', { all: true }),
      list('equipment', { all: true }),
      list('clients', { all: true }),
      list('users', { all: true }).catch(() => []),
      list('checklists', { all: true }),
      can('orders') ? getDocs(query(col('orders'), where('status', 'in', OPEN))) : { docs: [] },
    ]);
    const M = a => Object.fromEntries(a.map(x => [x.id, x]));
    const E = M(eq), C = M(clients), U = M(users), K = M(cks);
    const openIds = new Set(open.docs.map(d => Number(d.id)));
    return plans.map(p => {
      const e = E[p.equipment_id] || {};
      return {
        ...p,
        location: e.location,
        kind: e.kind,
        brand: e.brand,
        btu: e.btu,
        client_id: e.client_id,
        client_name: C[e.client_id]?.name || '—',
        technician_name: U[p.technician_id]?.name,
        checklist_name: K[p.checklist_id]?.name,
        open_order_id: openIds.has(Number(p.open_order_id)) ? p.open_order_id : null,
      };
    }).sort((a, b) => (b.active !== 0) - (a.active !== 0) || cmp(a.next_due, b.next_due) || cmp(a.client_name, b.client_name) || cmp(a.location, b.location, true));
  });

  R('POST', '/api/plans', async (p, b) => {
    need('plans', 2);
    const every = parseInt(b.every_days, 10);
    if (!(every > 0)) throw new ApiError('Frequency (days) must be greater than 0');
    if (!/^\d{4}-\d\d-\d\d$/.test(b.next_due || '')) throw new ApiError('First due date required');
    let ids;
    if (b.equipment_id === 'all') {
      ids = (await list('equipment')).filter(e => e.client_id === b.client_id).map(e => e.id);
      if (!ids.length) throw new ApiError('This client has no active units');
    } else if (b.equipment_id) {
      ids = [b.equipment_id];
    } else {
      throw new ApiError('Select a unit');
    }
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      ids.slice(i, i + 400).forEach(eid => batch.set(doc(col('plans')), {
        equipment_id: eid,
        technician_id: blank(b.technician_id),
        checklist_id: blank(b.checklist_id),
        every_days: every,
        next_due: b.next_due,
        priority: b.priority || 'media',
        task: blank(b.task),
        active: 1,
        open_order_id: null,
        created_at: serverTimestamp(),
      }));
      await batch.commit();
    }
    return { plans: ids.length, orders: await runPlans() };
  });

  R('PUT', '/api/plans/:id', async (p, b) => {
    need('plans', 2);
    const every = parseInt(b.every_days, 10);
    if (!(every > 0)) throw new ApiError('Frequency (days) must be greater than 0');
    await updateDoc(ref('plans', p.id), {
      technician_id: blank(b.technician_id),
      checklist_id: blank(b.checklist_id),
      every_days: every,
      next_due: b.next_due,
      priority: b.priority || 'media',
      task: blank(b.task),
      active: b.active === 0 ? 0 : 1,
    });
    return { ok: true, orders: await runPlans() };
  });

  R('POST', '/api/plans/run', async () => ({ orders: await runPlans() }));

  R('GET', '/api/orders', async (p, b, q) => filterSortOrders(await queryOrders(q), q));
  R('GET', '/api/orders/:id', async p => getOrderFull(p.id));

  R('POST', '/api/orders', async (p, b) => {
    need('orders', 2);
    if (!b.client_id) throw new ApiError('Client required');
    return { id: await insertOrder(await buildOrder(b)) };
  });

  R('PUT', '/api/orders/:id', async (p, b) => {
    const o = await readOrder(p.id);
    const upd = {};
    assertWork(o, { requireArrival: true });

    const fCfg = can('orders', 2) ? null : await settingsDoc();
    if (Array.isArray(b.checklist) && o.checklist && (!fCfg || fCfg.field_show_checklist !== '0')) {
      upd.checklist = mergeChecklist(o.checklist, b.checklist);
    }

    if (can('orders', 2)) {
      const keys = ['type', 'priority', 'status', 'reported_issue', 'diagnosis', 'work_done', 'recommendations', 'received_by'];
      keys.forEach(k => {
        if (k in b && b[k] !== undefined) {
          upd[k] = k === 'status' || k === 'type' || k === 'priority' ? b[k] : (b[k] ?? null);
        }
      });
      ['scheduled_at', 'arrival_at', 'departure_at'].forEach(k => {
        if (k in b && b[k] !== undefined) upd[k] = toTs(b[k]);
      });
      const ref3 = {};
      ['client_id', 'equipment_id', 'technician_id'].forEach(k => {
        if (k in b && (blank(b[k]) ?? null) !== (o[k] ?? null)) ref3[k] = blank(b[k]);
      });
      Object.assign(upd, await denorm(ref3));

      const status = upd.status ?? o.status;
      const tech = 'technician_id' in upd ? upd.technician_id : o.technician_id;
      if (status === 'pendiente' && tech) upd.status = 'asignada';
      if (status === 'asignada' && !tech) upd.status = 'pendiente';
    } else {
      const fMap = {
        diagnosis: 'field_show_diagnosis',
        work_done: 'field_show_work_done',
        recommendations: 'field_show_recommendations',
        received_by: 'field_show_received_by',
      };
      Object.entries(fMap).forEach(([k, flag]) => {
        if (k in b && b[k] !== undefined && fCfg?.[flag] !== '0') upd[k] = b[k] ?? null;
      });
    }

    if (Object.keys(upd).length) {
      upd.updated_at = serverTimestamp();
      await updateDoc(ref('orders', o.id), upd);
    }
    return getOrderFull(o.id);
  });

  R('POST', '/api/orders/:id/arrive', async (p, b) => {
    const o = await readOrder(p.id);
    assertWork(o);
    if (o.arrival_at) throw new ApiError('Arrival already recorded');
    if (isClosed(o)) throw new ApiError('This work order is closed');
    const upd = {
      arrival_at: serverTimestamp(),
      arrival_lat: b.lat ?? null,
      arrival_lng: b.lng ?? null,
      status: 'en_progreso',
      updated_at: serverTimestamp(),
    };
    if (!o.technician_id) Object.assign(upd, { technician_id: me.id, technician_name: me.name });
    await updateDoc(ref('orders', o.id), upd);
    return getOrderFull(o.id);
  });

  R('POST', '/api/orders/:id/depart', async (p, b) => {
    const o = await readOrder(p.id);
    assertWork(o);
    if (isClosed(o)) throw new ApiError('This work order is already closed');
    if (!o.arrival_at) throw new ApiError('Record arrival first');
    if (o.departure_at) throw new ApiError('Departure already recorded');
    const fCfg = can('orders', 2) ? null : await settingsDoc();
    const diagRequired = !fCfg || fCfg.field_show_diagnosis !== '0';
    const diagnosis = (fCfg && fCfg.field_show_diagnosis === '0') ? (o.diagnosis ?? null) : (b.diagnosis ?? o.diagnosis);
    if (diagRequired && (!diagnosis || !String(diagnosis).trim())) throw new ApiError('Enter the diagnosis before closing');
    const upd = {
      diagnosis,
      work_done: (fCfg && fCfg.field_show_work_done === '0') ? (o.work_done ?? null) : (b.work_done ?? o.work_done),
      recommendations: (fCfg && fCfg.field_show_recommendations === '0') ? (o.recommendations ?? null) : (b.recommendations ?? o.recommendations),
      received_by: (fCfg && fCfg.field_show_received_by === '0') ? (o.received_by ?? null) : (b.received_by ?? o.received_by),
      departure_at: serverTimestamp(),
      departure_lat: b.lat ?? null,
      departure_lng: b.lng ?? null,
      status: 'completada',
      updated_at: serverTimestamp(),
    };
    if (Array.isArray(b.checklist) && o.checklist && (!fCfg || fCfg.field_show_checklist !== '0')) {
      upd.checklist = mergeChecklist(o.checklist, b.checklist);
    }
    await updateDoc(ref('orders', o.id), upd);
    return getOrderFull(o.id);
  });

  R('POST', '/api/orders/:id/parts', async (p, b) => {
    const qty = Number(b.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new ApiError('Enter a valid quantity greater than 0');
    await runTransaction(db, async tx => {
      const os = await tx.get(ref('orders', p.id));
      const ps = await tx.get(ref('parts', b.part_id));
      if (!os.exists()) throw new ApiError('Work order not found');
      if (!ps.exists()) throw new ApiError('Part not found');
      const o = os.data(), part = ps.data();
      assertWork({ ...o, id: os.id }, { requireArrival: true });
      if (!can('orders', 2) && (await settingsDoc()).field_show_parts === '0') {
        throw new ApiError('Parts section is disabled for field technicians', 403);
      }
      const line = {
        id: rid(),
        part_id: ps.id,
        name: part.name,
        code: part.code || null,
        unit: part.unit || 'ea',
        qty,
        unit_cost: Number(part.cost) || 0,
        added_by: me.id,
        added_by_name: me.name,
        created_at: new Date().toISOString(),
      };
      tx.update(os.ref, { parts: [...(o.parts || []), line], updated_at: serverTimestamp() });
      tx.update(ps.ref, { stock: Number(((Number(part.stock) || 0) - qty).toFixed(2)) });
    });
    return getOrderFull(p.id);
  });

  R('DELETE', '/api/orders/:id/parts/:pid', async p => {
    await runTransaction(db, async tx => {
      const os = await tx.get(ref('orders', p.id));
      if (!os.exists()) throw new ApiError('Work order not found');
      const o = os.data();
      assertWork({ ...o, id: os.id }, { requireArrival: true });
      const line = (o.parts || []).find(x => x.id === p.pid);
      if (!line) throw new ApiError('Part line not found');
      const ps = await tx.get(ref('parts', line.part_id));
      tx.update(os.ref, { parts: o.parts.filter(x => x.id !== p.pid), updated_at: serverTimestamp() });
      if (ps.exists()) {
        tx.update(ps.ref, { stock: Number(((Number(ps.data().stock) || 0) + Number(line.qty)).toFixed(2)) });
      }
    });
    return getOrderFull(p.id);
  });

  R('POST', '/api/orders/:id/photos', async (p, body) => {
    const o = await readOrder(p.id);
    assertWork(o, { requireArrival: true });
    if (!can('orders', 2) && (await settingsDoc()).field_show_photos === '0') {
      throw new ApiError('Photos section is disabled for field technicians', 403);
    }
    const file = body.get('photo');
    if (!file) throw new ApiError('Image file required');
    const data = await imageToDataURL(file);
    const pRef = doc(col('orders', o.id, 'photos'));
    const meta = { id: pRef.id, kind: body.get('kind') || 'diagnostico', user_id: me.id, created_at: new Date().toISOString() };
    const batch = writeBatch(db);
    batch.set(pRef, { data, kind: meta.kind, user_id: me.id, created_at: serverTimestamp() });
    batch.update(ref('orders', o.id), { photos: arrayUnion(meta), updated_at: serverTimestamp() });
    await batch.commit();
    photoCache.set(pRef.id, data);
    return getOrderFull(o.id);
  });

  R('DELETE', '/api/photos/:pid', async p => {
    const oid = photoOrder.get(p.pid);
    if (!oid) throw new ApiError('Photo not found');
    const o = await readOrder(oid);
    const meta = o.photos.find(x => x.id === p.pid);
    if (!meta) throw new ApiError('Photo not found');
    assertWork(o, { requireArrival: true });
    if (!can('orders', 2) && meta.user_id !== me.id) throw new ApiError('You cannot delete this photo');
    const batch = writeBatch(db);
    batch.delete(ref('orders', oid, 'photos', p.pid));
    batch.update(ref('orders', oid), {
      photos: o.photos.filter(x => x.id !== p.pid).map(({ src, ...x }) => x),
      updated_at: serverTimestamp(),
    });
    await batch.commit();
    photoCache.delete(p.pid);
    return getOrderFull(oid);
  });

  R('POST', '/api/orders/:id/signature', async (p, body) => {
    const o = await readOrder(p.id);
    assertWork(o, { requireArrival: true });
    if (!can('orders', 2) && (await settingsDoc()).field_show_signature === '0') {
      throw new ApiError('Client signature is disabled for field technicians', 403);
    }
    const file = body.get('signature');
    if (!file) throw new ApiError('Signature image required');
    const data = await imageToDataURL(file, { maxSide: 900, type: 'image/png', maxChars: 400000 });
    const batch = writeBatch(db);
    batch.set(ref('orders', o.id, 'files', 'signature'), { data, created_at: serverTimestamp(), user_id: me.id });
    const upd = { has_signature: true, signed_at: serverTimestamp(), updated_at: serverTimestamp() };
    if (body.get('received_by')) upd.received_by = body.get('received_by');
    batch.update(ref('orders', o.id), upd);
    await batch.commit();
    return getOrderFull(o.id);
  });

  R('GET', '/api/settings', async () => {
    const s = await settingsDoc();
    if (logoCache === null) {
      const l = await getDoc(ref('settings', 'logo'));
      logoCache = l.exists() ? l.data().data : '';
    }
    return { ...s, has_logo: !!logoCache, logo_src: logoCache };
  });

  R('PUT', '/api/settings', async (p, b) => {
    need('settings', 2);
    const out = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in b) out[k] = String(b[k] ?? '');
    await setDoc(ref('settings', 'app'), out, { merge: true });
    return { ok: true };
  });

  R('POST', '/api/settings/logo', async (p, body) => {
    need('settings', 2);
    const f = body.get('logo');
    if (!f) throw new ApiError('Image required');
    const data = f.type === 'image/svg+xml' && f.size < 300000
      ? await blobToDataURL(f)
      : await imageToDataURL(f, { maxSide: 600, type: 'image/png', maxChars: 600000 });
    await setDoc(ref('settings', 'logo'), { data });
    logoCache = data;
    return { ok: true };
  });

  R('DELETE', '/api/settings/logo', async () => {
    need('settings', 2);
    await deleteDoc(ref('settings', 'logo'));
    logoCache = '';
    return { ok: true };
  });

  R('GET', '/api/stats', async (p, b, q) => stats(q));
  R('GET', '/api/reports/orders.csv', async (p, b, q) => csv(q));

  return {
    async request(method, url, body, opts = {}) {
      const u = new URL(url, location.href);
      const route = routes.find(r => r.method === method && r.re.test(u.pathname));
      if (!route) throw new ApiError(`Not available: ${method} ${u.pathname}`, 404);
      const params = u.pathname.match(route.re).groups || {};
      const q = Object.fromEntries(u.searchParams);
      const nextImp = opts?.impersonate || null;
      if (nextImp !== impersonateUid) {
        impersonateUid = nextImp;
        me = null;
      }
      try {
        const open = ['/api/setup-status', '/api/setup', '/api/login', '/api/password-reset', '/api/me', '/api/logout'];
        if (!open.includes(u.pathname)) await ensureMe();
        return await route.fn(params, body ?? {}, q);
      } catch (e) {
        const err = mapError(e);
        if (err.status >= 400 && !(e instanceof ApiError)) console.warn('[firebase]', method, u.pathname, e);
        throw err;
      }
    },
  };
}

// =====================================================================
//  Modules and access levels — shared by the front end, server.js and backend-firebase.js
//  Levels: 0 = no access, 1 = view, 2 = full
//  'developer' is a built-in profile with full access that cannot be restricted.
// =====================================================================
(function (root) {
  const MODULES = [
    { key: 'dashboard', name: 'Dashboard', levels: [0, 1], help: 'KPIs, overdue preventives, low stock. Needs "All work orders: View".' },
    { key: 'orders', name: 'All work orders', levels: [0, 1, 2], help: 'View: see every work order. Full: create, assign, edit, cancel, correct times, work on any order.' },
    { key: 'field', name: 'Field work (own orders)', levels: [0, 2], help: 'Can be assigned as technician; records arrival/departure, diagnosis, checklist, photos, parts and signature on their own orders.' },
    { key: 'plans', name: 'Preventive plans', levels: [0, 1, 2] },
    { key: 'clients', name: 'Clients', levels: [0, 1, 2] },
    { key: 'units', name: 'A/C units', levels: [0, 1, 2] },
    { key: 'parts', name: 'Parts & inventory', levels: [0, 1, 2] },
    { key: 'checklists', name: 'Checklists', levels: [0, 1, 2] },
    { key: 'users', name: 'Users', levels: [0, 1, 2], help: 'Full: create and edit users (except developers) and assign profiles.' },
    { key: 'settings', name: 'Company settings', levels: [0, 2] },
    { key: 'reports', name: 'Client reports & CSV export', levels: [0, 1] },
  ];

  const ALL = Object.fromEntries(MODULES.map(m => [m.key, Math.max(...m.levels)]));

  const DEFAULT_PROFILES = [
    { key: 'master', name: 'Master', builtin: 1, perms: { ...ALL } },
    { key: 'tecnico', name: 'Technician', builtin: 1, perms: { dashboard: 0, orders: 0, field: 2, plans: 0, clients: 0, units: 0, parts: 0, checklists: 0, users: 0, settings: 0, reports: 1 } },
  ];

  const LEVEL_NAMES = { 0: 'No access', 1: 'View', 2: 'Full' };

  function cleanRestrict(restrict) {
    const out = {};
    if (!restrict || typeof restrict !== 'object') return out;
    for (const m of MODULES) {
      if (restrict[m.key] === true || restrict[m.key] === 1 || restrict[m.key] === '1') {
        out[m.key] = true;
      }
    }
    return out;
  }

  function permsFor(role, profiles, restrict) {
    if (role === 'developer') return { ...ALL };
    const p = profiles?.[role]?.perms || {};
    const r = cleanRestrict(restrict);
    return Object.fromEntries(MODULES.map(m => {
      if (r[m.key]) return [m.key, 0];
      return [m.key, Math.min(Number(p[m.key]) || 0, Math.max(...m.levels))];
    }));
  }

  function cleanPerms(perms) {
    return Object.fromEntries(MODULES.map(m => {
      const v = Number(perms?.[m.key]) || 0;
      return [m.key, m.levels.includes(v) ? v : 0];
    }));
  }

  const P = { MODULES, ALL, DEFAULT_PROFILES, LEVEL_NAMES, permsFor, cleanPerms, cleanRestrict };
  if (typeof module !== 'undefined' && module.exports) module.exports = P;
  else root.PERMS = P;
})(typeof self !== 'undefined' ? self : this);

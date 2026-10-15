'use strict';
/* =====================================================================
   LabPilot · core
   Shared primitives: encoding, crypto (PBKDF2 / HMAC tokens), the SQLite
   wrapper, schema migrations and seed data. No UI code lives here.
   ===================================================================== */

const APP = { name: 'LabPilot', version: '1.4.0', builder: 'Shovan Dutta' };

const RULES = Object.freeze({
  MAX_EXTENSIONS: 2,
  EXTENSION_MIN: 15,
  TOKEN_TTL_MS: 8 * 3600 * 1000,
  LOGIN_WINDOW_MS: 60 * 1000,
  LOGIN_MAX_FAILURES: 5,
  PBKDF2_ITERATIONS: 100000,
});
const ACTIVE_STATUSES = ['queued', 'provisioning', 'ready', 'stopping'];

/* ---------- encoding ---------- */
const textEnc = new TextEncoder();
const textDec = new TextDecoder();
function b64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const toB64url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return s; };
const jsonB64url = (obj) => toB64url(b64(textEnc.encode(JSON.stringify(obj))));
const parseJsonB64url = (s) => JSON.parse(textDec.decode(unb64(fromB64url(s))));

/* ---------- randomness ---------- */
function randomBytes(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
function randomInt(max) { // unbiased 0..max-1 for max <= 256
  const limit = 256 - (256 % max);
  for (;;) { const b = randomBytes(1)[0]; if (b < limit) return b % max; }
}
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function shortId(n = 10) { let s = ''; for (let i = 0; i < n; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)]; return s; }
function newId(prefix) { return prefix + '_' + shortId(10); }
function strongPassword(len = 14) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%*?'];
  const all = sets.join('');
  const out = sets.map((s) => s[randomInt(s.length)]);
  while (out.length < len) out.push(all[randomInt(all.length)]);
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

/* ---------- crypto: password hashing + signed tokens ---------- */
const Crypto = {
  async pbkdf2(password, saltB64, iterations) {
    const key = await crypto.subtle.importKey('raw', textEnc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations }, key, 256);
    return b64(bits);
  },
  /** Stored as pbkdf2$<iterations>$<salt>$<hash> so the cost can be raised later. */
  async hashPassword(password, iterations = RULES.PBKDF2_ITERATIONS) {
    const salt = b64(randomBytes(16));
    return `pbkdf2$${iterations}$${salt}$${await this.pbkdf2(password, salt, iterations)}`;
  },
  async verifyPassword(password, stored) {
    const [scheme, iter, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'pbkdf2' || !salt) return false;
    return this.safeEqual(await this.pbkdf2(password, salt, Number(iter)), hash);
  },
  _keys: new Map(),
  async hmac(secret, data) {
    let key = this._keys.get(secret);
    if (!key) {
      key = await crypto.subtle.importKey('raw', textEnc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      this._keys.set(secret, key);
    }
    return toB64url(b64(await crypto.subtle.sign('HMAC', key, textEnc.encode(data))));
  },
  safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
    return diff === 0;
  },
  async signToken(secret, payload) {
    const head = jsonB64url({ alg: 'HS256', typ: 'JWT' });
    const body = jsonB64url(payload);
    return `${head}.${body}.${await this.hmac(secret, head + '.' + body)}`;
  },
  async verifyToken(secret, token, now) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expected = await this.hmac(secret, parts[0] + '.' + parts[1]);
    if (!this.safeEqual(expected, parts[2])) return null;
    let payload;
    try { payload = parseJsonB64url(parts[1]); } catch (_) { return null; }
    if (!payload || typeof payload.exp !== 'number' || payload.exp <= now) return null;
    return payload;
  },
};

/* ---------- credits ---------- */
const creditsFor = (minutes, perHour) => Math.ceil((minutes * perHour) / 60);
const refundFor = (remainingMs, perHour) => Math.max(0, Math.floor(((remainingMs / 60000) * perHour) / 60));

/* ---------- clocks ---------- */
const systemClock = { now: () => Date.now() };
function fakeClock(start) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

/* ---------- SQLite wrapper ----------
   Thin layer over sql.js: parameter binding only (no string-built SQL),
   nested transactions through SAVEPOINTs, and per-request SQL tracing. */
function wrapDb(raw, hooks = {}) {
  let depth = 0;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const norm = (params) => (params || []).map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
  const w = {
    raw,
    trace: null,
    record(sql, params, t0, rows) {
      if (w.trace) w.trace.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: norm(params), ms: Math.round((now() - t0) * 100) / 100, rows });
    },
    run(sql, params) {
      const t0 = now();
      raw.run(sql, norm(params));
      const n = raw.getRowsModified();
      w.record(sql, params, t0, n);
      if (hooks.onWrite) hooks.onWrite();
      return n;
    },
    all(sql, params) {
      const t0 = now();
      const st = raw.prepare(sql);
      const out = [];
      try {
        st.bind(norm(params));
        while (st.step()) out.push(st.getAsObject());
      } finally { st.free(); }
      w.record(sql, params, t0, out.length);
      return out;
    },
    get(sql, params) { return w.all(sql, params)[0] || null; },
    val(sql, params) { const r = w.get(sql, params); return r ? Object.values(r)[0] : null; },
    tx(fn) {
      const name = 'sp_' + ++depth;
      raw.exec('SAVEPOINT ' + name);
      try {
        const r = fn();
        if (r && typeof r.then === 'function') throw new Error('db.tx callback must be synchronous');
        raw.exec('RELEASE ' + name);
        return r;
      } catch (e) {
        raw.exec('ROLLBACK TO ' + name);
        raw.exec('RELEASE ' + name);
        throw e;
      } finally { depth--; }
    },
    inTx() { return depth > 0; },
  };
  return w;
}

/* ---------- schema migrations ---------- */
const MIGRATIONS = [
  { version: 1, name: '001_tenants_users', sql: `
CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  region        TEXT NOT NULL,
  credit_quota  INTEGER NOT NULL CHECK (credit_quota >= 0),
  created_at    INTEGER NOT NULL
);
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('learner','instructor','admin')),
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);` },
  { version: 2, name: '002_lab_catalog', sql: `
CREATE TABLE lab_templates (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  title            TEXT NOT NULL,
  summary          TEXT NOT NULL,
  level            TEXT NOT NULL CHECK (level IN ('beginner','intermediate','advanced')),
  duration_min     INTEGER NOT NULL CHECK (duration_min BETWEEN 15 AND 240),
  credits_per_hour INTEGER NOT NULL CHECK (credits_per_hour BETWEEN 1 AND 100),
  resources        TEXT NOT NULL DEFAULT '[]',
  tasks            TEXT NOT NULL DEFAULT '[]',
  created_by       TEXT REFERENCES users(id),
  created_at       INTEGER NOT NULL
);
CREATE TABLE assignments (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  template_id  TEXT NOT NULL REFERENCES lab_templates(id),
  learner_id   TEXT NOT NULL REFERENCES users(id),
  assigned_by  TEXT REFERENCES users(id),
  due_at       INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (template_id, learner_id)
);` },
  { version: 3, name: '003_sessions_jobs', sql: `
CREATE TABLE lab_sessions (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  template_id      TEXT NOT NULL REFERENCES lab_templates(id),
  learner_id       TEXT NOT NULL REFERENCES users(id),
  status           TEXT NOT NULL CHECK (status IN ('queued','provisioning','ready','stopping','stopped','expired','failed')),
  progress         INTEGER NOT NULL DEFAULT 0,
  step             TEXT,
  resource_group   TEXT NOT NULL,
  region           TEXT NOT NULL,
  username         TEXT,
  secret_ref       TEXT,
  started_at       INTEGER,
  expires_at       INTEGER,
  ended_at         INTEGER,
  end_reason       TEXT,
  extensions       INTEGER NOT NULL DEFAULT 0,
  credits_charged  INTEGER NOT NULL DEFAULT 0,
  tasks_done       TEXT NOT NULL DEFAULT '[]',
  idempotency_key  TEXT,
  created_at       INTEGER NOT NULL
);
CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  type         TEXT NOT NULL CHECK (type IN ('provision','deprovision')),
  session_id   TEXT NOT NULL REFERENCES lab_sessions(id),
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','cancelled')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  run_at       INTEGER NOT NULL,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);` },
  { version: 4, name: '004_ledger_audit_vault', sql: `
CREATE TABLE credit_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  session_id  TEXT REFERENCES lab_sessions(id),
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN ('allocation','launch','extension','refund')),
  created_at  INTEGER NOT NULL
);
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  actor_id    TEXT REFERENCES users(id),
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT,
  request_id  TEXT,
  created_at  INTEGER NOT NULL
);
-- Stands in for Azure Key Vault: sessions keep only a reference.
CREATE TABLE vault_secrets (
  ref         TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  value       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);` },
  { version: 5, name: '005_indexes', sql: `
CREATE UNIQUE INDEX ux_sessions_one_active ON lab_sessions (learner_id, template_id)
  WHERE status IN ('queued','provisioning','ready','stopping');
CREATE UNIQUE INDEX ux_sessions_idempotency ON lab_sessions (learner_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ix_sessions_tenant_status ON lab_sessions (tenant_id, status, created_at);
CREATE INDEX ix_jobs_due ON jobs (status, run_at);
CREATE INDEX ix_ledger_tenant ON credit_ledger (tenant_id, created_at);
CREATE INDEX ix_audit_tenant ON audit_log (tenant_id, created_at);
CREATE INDEX ix_assignments_learner ON assignments (learner_id);` },
];

function migrate(db, now) {
  db.raw.exec('PRAGMA foreign_keys = ON');
  db.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.all('SELECT version FROM schema_migrations').map((r) => r.version));
  const ran = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.tx(() => {
      db.raw.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, now]);
    });
    ran.push(m.name);
  }
  if (!db.val("SELECT value FROM settings WHERE key = 'token_secret'")) {
    db.run("INSERT INTO settings (key, value) VALUES ('token_secret', ?)", [b64(randomBytes(32))]);
  }
  return ran;
}

/* ---------- shared write helpers ---------- */
function audit(db, { tenantId, actorId = null, action, target = null, detail = null, requestId = null, now }) {
  db.run(
    'INSERT INTO audit_log (tenant_id, actor_id, action, target, detail, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [tenantId, actorId, action, target, detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail), requestId, now]
  );
}
function ledger(db, { tenantId, sessionId = null, delta, reason, now }) {
  db.run('INSERT INTO credit_ledger (tenant_id, session_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?)', [tenantId, sessionId, delta, reason, now]);
}
function creditBalance(db, tenantId) {
  return db.val('SELECT COALESCE(SUM(delta), 0) AS balance FROM credit_ledger WHERE tenant_id = ?', [tenantId]);
}
function insertTenant(db, t) {
  db.run('INSERT INTO tenants (id, name, slug, region, credit_quota, created_at) VALUES (?, ?, ?, ?, ?, ?)', [t.id, t.name, t.slug, t.region, t.quota, t.createdAt]);
}
async function insertUser(db, u, iterations) {
  const hash = await Crypto.hashPassword(u.password, iterations);
  db.run('INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [u.id, u.tenantId, u.email.toLowerCase(), u.name, u.role, hash, u.createdAt]);
  return u.id;
}
function insertTemplate(db, t) {
  db.run(`INSERT INTO lab_templates (id, tenant_id, title, summary, level, duration_min, credits_per_hour, resources, tasks, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.id, t.tenantId, t.title, t.summary, t.level, t.durationMin, t.creditsPerHour, JSON.stringify(t.resources), JSON.stringify(t.tasks), t.createdBy || null, t.createdAt]);
  return t.id;
}
function insertAssignment(db, a) {
  db.run('INSERT OR IGNORE INTO assignments (id, tenant_id, template_id, learner_id, assigned_by, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [newId('asg'), a.tenantId, a.templateId, a.learnerId, a.assignedBy || null, a.dueAt || null, a.createdAt]);
}

/* ---------- demo seed (the live app) ---------- */
const DEMO_PASSWORD = 'Labs@2026';
const DAY = 86400000, MIN = 60000;

async function seedDemo(db, now, iterations = RULES.PBKDF2_ITERATIONS) {
  const T0 = now - 20 * DAY;
  insertTenant(db, { id: 'tnt_contoso', name: 'Contoso Academy', slug: 'contoso', region: 'centralindia', quota: 400, createdAt: T0 });
  insertTenant(db, { id: 'tnt_fabrikam', name: 'Fabrikam University', slug: 'fabrikam', region: 'westeurope', quota: 120, createdAt: T0 });

  const people = [
    ['meera', 'tnt_contoso', 'meera@contoso.example', 'Meera Iyer', 'admin'],
    ['rahul', 'tnt_contoso', 'rahul@contoso.example', 'Rahul Menon', 'instructor'],
    ['ananya', 'tnt_contoso', 'ananya@contoso.example', 'Ananya Sen', 'learner'],
    ['kabir', 'tnt_contoso', 'kabir@contoso.example', 'Kabir Shah', 'learner'],
    ['zoya', 'tnt_contoso', 'zoya@contoso.example', 'Zoya Khan', 'learner'],
    ['lena', 'tnt_fabrikam', 'lena@fabrikam.example', 'Lena Fischer', 'instructor'],
    ['arjun', 'tnt_fabrikam', 'arjun@fabrikam.example', 'Arjun Das', 'learner'],
  ];
  const U = {};
  await Promise.all(people.map(async ([key, tenantId, email, name, role]) => {
    U[key] = newId('usr');
    await insertUser(db, { id: U[key], tenantId, email, name, role, password: DEMO_PASSWORD, createdAt: T0 + DAY }, iterations);
  }));

  const tpl = (tenantId, title, summary, level, durationMin, creditsPerHour, resources, tasks) =>
    insertTemplate(db, { id: newId('lab'), tenantId, title, summary, level, durationMin, creditsPerHour, resources, tasks, createdBy: tenantId === 'tnt_contoso' ? U.rahul : U.lena, createdAt: T0 + 2 * DAY });

  const L = {};
  L.appsvc = tpl('tnt_contoso', 'Deploy a web app to Azure App Service',
    'Create a resource group, publish a Node.js app to App Service and wire up Application Insights.',
    'beginner', 45, 8, ['Resource group', 'App Service plan (B1)', 'Web App', 'Application Insights'], [
      { id: 't1', title: 'Create the resource group for this lab', hint: 'Enter the resource group name from your lab credentials.', check: 'resource_group' },
      { id: 't2', title: 'Deploy into your tenant’s assigned region', hint: 'Enter the Azure region code, for example eastus.', check: 'region' },
      { id: 't3', title: 'Sign in to the portal as the lab user', hint: 'Enter the lab username you signed in with.', check: 'username' },
      { id: 't4', title: 'Enable Application Insights and confirm requests appear', hint: 'Mark done once live metrics show traffic.', check: 'confirm' },
    ]);
  L.keyvault = tpl('tnt_contoso', 'Store and rotate secrets with Azure Key Vault',
    'Move a connection string out of app settings into Key Vault, grant a managed identity access and rotate it safely.',
    'intermediate', 60, 12, ['Key Vault (Standard)', 'User-assigned managed identity', 'Function App'], [
      { id: 't1', title: 'Find the resource group that holds your vault', hint: 'Enter the resource group name.', check: 'resource_group' },
      { id: 't2', title: 'Grant the managed identity get/list on secrets', hint: 'Mark done once the Function can read the secret.', check: 'confirm' },
      { id: 't3', title: 'Rotate the secret and confirm the new version is used', hint: 'Mark done after the Function logs the new version.', check: 'confirm' },
    ]);
  L.rag = tpl('tnt_contoso', 'Build a RAG chatbot with Azure OpenAI and AI Search',
    'Index a set of PDFs into AI Search, ground a chat completion on the results and return cited answers from a container.',
    'advanced', 90, 20, ['Azure OpenAI', 'AI Search (Basic)', 'Storage account', 'Container App'], [
      { id: 't1', title: 'Locate the lab resource group', hint: 'Enter the resource group name.', check: 'resource_group' },
      { id: 't2', title: 'Confirm the region your OpenAI deployment runs in', hint: 'Enter the Azure region code.', check: 'region' },
      { id: 't3', title: 'Index the sample PDFs into AI Search', hint: 'Mark done when the index reports 42 documents.', check: 'confirm' },
      { id: 't4', title: 'Return an answer that cites its source chunks', hint: 'Mark done when citations render in the chat.', check: 'confirm' },
    ]);
  L.aca = tpl('tnt_contoso', 'Ship a container to Azure Container Apps',
    'Push an image to Container Registry, deploy it to Container Apps and roll out a second revision behind a traffic split.',
    'intermediate', 60, 12, ['Container Apps environment', 'Container Registry', 'Log Analytics workspace'], [
      { id: 't1', title: 'Open the resource group for this lab', hint: 'Enter the resource group name.', check: 'resource_group' },
      { id: 't2', title: 'Sign in to the registry as the lab user', hint: 'Enter the lab username.', check: 'username' },
      { id: 't3', title: 'Send 20% of traffic to revision 2', hint: 'Mark done when the split shows 80/20.', check: 'confirm' },
    ]);
  L.vm = tpl('tnt_fabrikam', 'Linux VM fundamentals',
    'Create a Linux VM behind Azure Bastion, harden SSH and attach a data disk.',
    'beginner', 30, 6, ['Virtual network', 'Linux VM (B2s)', 'Azure Bastion'], [
      { id: 't1', title: 'Find the VM’s resource group', hint: 'Enter the resource group name.', check: 'resource_group' },
      { id: 't2', title: 'Disable password SSH authentication', hint: 'Mark done once only key auth works.', check: 'confirm' },
    ]);
  L.aks = tpl('tnt_fabrikam', 'Kubernetes basics on AKS',
    'Deploy a two-tier app to AKS, expose it through an ingress and scale it with the HPA.',
    'intermediate', 60, 14, ['AKS cluster', 'Container Registry'], [
      { id: 't1', title: 'Find the cluster’s resource group', hint: 'Enter the resource group name.', check: 'resource_group' },
      { id: 't2', title: 'Confirm the cluster region', hint: 'Enter the Azure region code.', check: 'region' },
      { id: 't3', title: 'Scale the web deployment with the HPA', hint: 'Mark done when replicas climb under load.', check: 'confirm' },
    ]);

  const assign = (learner, labKeys, tenantId, by) => labKeys.forEach((k) => insertAssignment(db, { tenantId, templateId: L[k], learnerId: U[learner], assignedBy: U[by], createdAt: T0 + 3 * DAY }));
  assign('ananya', ['appsvc', 'keyvault', 'rag'], 'tnt_contoso', 'rahul');
  assign('kabir', ['appsvc', 'aca'], 'tnt_contoso', 'rahul');
  assign('zoya', ['keyvault', 'aca'], 'tnt_contoso', 'rahul');
  assign('arjun', ['vm', 'aks'], 'tnt_fabrikam', 'lena');

  ledger(db, { tenantId: 'tnt_contoso', delta: 400, reason: 'allocation', now: now - 14 * DAY });
  ledger(db, { tenantId: 'tnt_fabrikam', delta: 120, reason: 'allocation', now: now - 14 * DAY });

  const meta = {};
  for (const r of db.all('SELECT id, duration_min, credits_per_hour, tasks FROM lab_templates')) meta[r.id] = r;
  const tenantOf = { meera: 'tnt_contoso', rahul: 'tnt_contoso', ananya: 'tnt_contoso', kabir: 'tnt_contoso', zoya: 'tnt_contoso', lena: 'tnt_fabrikam', arjun: 'tnt_fabrikam' };
  const regionOf = { tnt_contoso: 'centralindia', tnt_fabrikam: 'westeurope' };

  // Finished sessions spread over the last two weeks (drives the usage chart and history).
  const past = [
    ['kabir', 'appsvc', 12.3, 38, 0, 'stopped', 4], ['zoya', 'keyvault', 10.6, 75, 1, 'expired', 1],
    ['ananya', 'appsvc', 9.4, 41, 0, 'stopped', 4], ['kabir', 'aca', 7.2, 52, 0, 'stopped', 2],
    ['zoya', 'aca', 5.5, 60, 0, 'expired', 3], ['ananya', 'keyvault', 3.3, 47, 0, 'stopped', 2],
    ['kabir', 'appsvc', 2.1, 30, 0, 'stopped', 3], ['zoya', 'keyvault', 1.4, 90, 2, 'expired', 2],
    ['ananya', 'rag', 0.6, 64, 0, 'stopped', 3], ['arjun', 'vm', 4.2, 26, 0, 'stopped', 2],
    ['arjun', 'aks', 1.8, 75, 1, 'expired', 2],
  ];
  for (const [who, lab, daysAgo, usedMin, ext, status, done] of past) {
    const m = meta[L[lab]];
    const tenantId = tenantOf[who];
    const start = now - daysAgo * DAY;
    const allowedMin = m.duration_min + ext * RULES.EXTENSION_MIN;
    const charged = creditsFor(m.duration_min, m.credits_per_hour) + ext * creditsFor(RULES.EXTENSION_MIN, m.credits_per_hour);
    const id = newId('ses');
    const tasks = JSON.parse(m.tasks).slice(0, done).map((t) => t.id);
    db.run(`INSERT INTO lab_sessions (id, tenant_id, template_id, learner_id, status, progress, step, resource_group, region, username,
              started_at, expires_at, ended_at, end_reason, extensions, credits_charged, tasks_done, created_at)
            VALUES (?, ?, ?, ?, ?, 0, 'Resources deleted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tenantId, L[lab], U[who], status, 'rg-lab-' + shortId(6), regionOf[tenantId], `labuser-${shortId(5)}@${tenantId.slice(4)}-labs.example`,
        start, start + allowedMin * MIN, start + usedMin * MIN, status, ext, charged, JSON.stringify(tasks), start - 2 * MIN]);
    ledger(db, { tenantId, sessionId: id, delta: -creditsFor(m.duration_min, m.credits_per_hour), reason: 'launch', now: start - 2 * MIN });
    for (let i = 0; i < ext; i++) ledger(db, { tenantId, sessionId: id, delta: -creditsFor(RULES.EXTENSION_MIN, m.credits_per_hour), reason: 'extension', now: start + (m.duration_min - 5 + i * 15) * MIN });
    if (status === 'stopped') {
      const refund = refundFor((allowedMin - usedMin) * MIN, m.credits_per_hour);
      if (refund > 0) ledger(db, { tenantId, sessionId: id, delta: refund, reason: 'refund', now: start + usedMin * MIN });
    }
    audit(db, { tenantId, actorId: U[who], action: 'session.launched', target: id, detail: { template: L[lab] }, now: start - 2 * MIN });
    audit(db, { tenantId, actorId: status === 'expired' ? null : U[who], action: status === 'expired' ? 'session.expired' : 'session.stopped', target: id, now: start + usedMin * MIN });
  }

  // Two labs running right now, so live views have something to show.
  const running = [['kabir', 'aca', 18, 1], ['arjun', 'aks', 9, 1]];
  for (const [who, lab, minAgo, done] of running) {
    const m = meta[L[lab]];
    const tenantId = tenantOf[who];
    const id = newId('ses');
    const start = now - minAgo * MIN;
    const slug = tenantId.slice(4);
    const ref = `kv://${slug}/lab-${id}`;
    db.run('INSERT INTO vault_secrets (ref, tenant_id, value, created_at) VALUES (?, ?, ?, ?)', [ref, tenantId, strongPassword(), start]);
    db.run(`INSERT INTO lab_sessions (id, tenant_id, template_id, learner_id, status, progress, step, resource_group, region, username, secret_ref,
              started_at, expires_at, extensions, credits_charged, tasks_done, created_at)
            VALUES (?, ?, ?, ?, 'ready', 100, 'Ready', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, tenantId, L[lab], U[who], 'rg-lab-' + shortId(6), regionOf[tenantId], `labuser-${shortId(5)}@${slug}-labs.example`, ref,
        start, start + m.duration_min * MIN, creditsFor(m.duration_min, m.credits_per_hour), JSON.stringify(JSON.parse(m.tasks).slice(0, done).map((t) => t.id)), start - MIN]);
    ledger(db, { tenantId, sessionId: id, delta: -creditsFor(m.duration_min, m.credits_per_hour), reason: 'launch', now: start - MIN });
    audit(db, { tenantId, actorId: U[who], action: 'session.launched', target: id, detail: { template: L[lab] }, now: start - MIN });
    audit(db, { tenantId, actorId: null, action: 'session.ready', target: id, now: start });
    for (let s = 0; s <= 5; s++) {
      db.run(`INSERT INTO jobs (tenant_id, type, session_id, payload, status, attempts, run_at, last_error, created_at, finished_at)
              VALUES (?, 'provision', ?, ?, 'done', ?, ?, ?, ?, ?)`,
        [tenantId, id, JSON.stringify({ step: s }), s === 3 && who === 'kabir' ? 2 : 1, start - MIN + s * 9000,
          s === 3 && who === 'kabir' ? 'ARM returned 429 TooManyRequests while creating the lab user' : null, start - MIN, start - MIN + s * 9000 + 400]);
    }
  }
  audit(db, { tenantId: 'tnt_contoso', actorId: U.rahul, action: 'assignment.created', target: L.rag, detail: { learners: 1 }, now: T0 + 3 * DAY });
  return { users: U, labs: L };
}

/* ---------- minimal fixture (the test suite) ---------- */
const FIXTURE_PASSWORD = 'Fixture#Pass1';
async function seedFixture(db, now, iterations = 1000) {
  insertTenant(db, { id: 'tnt_c', name: 'Contoso Test', slug: 'contoso', region: 'centralindia', quota: 400, createdAt: now });
  insertTenant(db, { id: 'tnt_f', name: 'Fabrikam Test', slug: 'fabrikam', region: 'westeurope', quota: 120, createdAt: now });
  const U = {};
  const users = [
    ['admin', 'tnt_c', 'admin@c.test', 'admin'], ['inst', 'tnt_c', 'inst@c.test', 'instructor'],
    ['l1', 'tnt_c', 'l1@c.test', 'learner'], ['l2', 'tnt_c', 'l2@c.test', 'learner'],
    ['f1', 'tnt_f', 'f1@f.test', 'learner'], ['finst', 'tnt_f', 'finst@f.test', 'instructor'],
  ];
  for (const [k, tenantId, email, role] of users) {
    U[k] = newId('usr');
    await insertUser(db, { id: U[k], tenantId, email, name: k.toUpperCase(), role, password: FIXTURE_PASSWORD, createdAt: now }, iterations);
  }
  const L = {
    t1: insertTemplate(db, { id: newId('lab'), tenantId: 'tnt_c', title: 'Fixture lab one', summary: 'Assigned to l1 and l2.', level: 'beginner', durationMin: 45, creditsPerHour: 8, resources: ['Web App'],
      tasks: [{ id: 't1', title: 'RG', check: 'resource_group' }, { id: 't2', title: 'Region', check: 'region' }, { id: 't3', title: 'Done', check: 'confirm' }], createdAt: now }),
    t2: insertTemplate(db, { id: newId('lab'), tenantId: 'tnt_c', title: 'Fixture lab two', summary: 'Assigned to nobody.', level: 'advanced', durationMin: 60, creditsPerHour: 12, resources: ['AKS'],
      tasks: [{ id: 't1', title: 'RG', check: 'resource_group' }], createdAt: now }),
    tf: insertTemplate(db, { id: newId('lab'), tenantId: 'tnt_f', title: 'Fabrikam lab', summary: 'Other tenant.', level: 'beginner', durationMin: 30, creditsPerHour: 6, resources: ['VM'],
      tasks: [{ id: 't1', title: 'RG', check: 'resource_group' }], createdAt: now }),
  };
  insertAssignment(db, { tenantId: 'tnt_c', templateId: L.t1, learnerId: U.l1, createdAt: now });
  insertAssignment(db, { tenantId: 'tnt_c', templateId: L.t1, learnerId: U.l2, createdAt: now });
  insertAssignment(db, { tenantId: 'tnt_f', templateId: L.tf, learnerId: U.f1, createdAt: now });
  ledger(db, { tenantId: 'tnt_c', delta: 400, reason: 'allocation', now });
  ledger(db, { tenantId: 'tnt_f', delta: 120, reason: 'allocation', now });
  return { users: U, labs: L };
}

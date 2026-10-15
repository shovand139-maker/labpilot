/* =====================================================================
   LabPilot · UI foundation
   The UI only talks to the API through `client.request`. Templates use the
   `html` tag, which escapes every interpolated value unless it is SafeHtml.
   ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
let escapeFn = escapeHtml;
/** Test hook: render with a different escaper (used by the XSS fault). */
function withEscaping(fn, cb) {
  if (!fn) return cb();
  const prev = escapeFn;
  escapeFn = fn;
  try { return cb(); } finally { escapeFn = prev; }
}
class SafeHtml { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new SafeHtml(String(s)); // only for markup this file builds itself
function interp(v) {
  if (v instanceof SafeHtml) return v.s;
  if (Array.isArray(v)) return v.map(interp).join('');
  if (v == null || v === false || v === true) return '';
  return escapeFn(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += interp(vals[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/* ---------- icons ---------- */
const ICONS = {
  flask: '<path d="M9 3h6M10 3v6.2L4.6 18.4A1.8 1.8 0 0 0 6.2 21h11.6a1.8 1.8 0 0 0 1.6-2.6L14 9.2V3"/><path d="M7.2 15h9.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pulse: '<path d="M3 12h4l2.2-6 4.6 12 2.2-6h5"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  users: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5a6 6 0 0 1 12 0"/><path d="M15.5 5.2a3.3 3.3 0 0 1 0 6.6M21 19.5a6 6 0 0 0-3.6-5.5"/>',
  chart: '<path d="M3.5 20.5h17"/><path d="M6.5 16.5v-5M11 16.5v-9M15.5 16.5v-6.5M20 16.5v-3"/>',
  audit: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="m3.8 6.5 1.2 1.2 2.2-2.4M3.8 12l1.2 1.2 2.2-2.4M3.8 17.5l1.2 1.2 2.2-2.4"/>',
  layers: '<path d="m12 3.5 9 4.6-9 4.6-9-4.6z"/><path d="m3 12.6 9 4.6 9-4.6"/><path d="m3 16.8 9 4.6 9-4.6"/>',
  braces: '<path d="M8.5 4C6.6 4 6 5 6 6.8v2.3c0 1.4-.8 2.4-2 2.9 1.2.5 2 1.5 2 2.9v2.3C6 19 6.6 20 8.5 20M15.5 4c1.9 0 2.5 1 2.5 2.8v2.3c0 1.4.8 2.4 2 2.9-1.2.5-2 1.5-2 2.9v2.3c0 1.8-.6 2.8-2.5 2.8"/>',
  db: '<ellipse cx="12" cy="5.8" rx="7.5" ry="2.8"/><path d="M4.5 5.8v12.4c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V5.8M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.2 2.6 2.6 5-5.4"/>',
  tick: '<path d="m5 12.5 4.2 4.2L19 7"/>',
  cross: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  blueprint: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M9 9v11"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M16.5 6.5l2.6 2.6M14.3 8.7l2 2"/>',
  out: '<path d="M14.5 4.5h4a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-4M10 16l4-4-4-4M14 12H4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5.5 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v.5"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  net: '<path d="M7 20V4M3.5 7.5 7 4l3.5 3.5M17 4v16M13.5 16.5 17 20l3.5-3.5"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.4 3 8 7 9 4-1 7-4.6 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  bug: '<path d="M8.5 8.5a3.5 3.5 0 0 1 7 0v.5h-7z"/><rect x="7" y="9" width="10" height="10" rx="5"/><path d="M12 12v7M3.5 13H7M17 13h3.5M4.5 8.5 7.4 10M19.5 8.5 16.6 10M4.5 18.5 7.4 17M19.5 18.5 16.6 17"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v4h4"/>',
};
const icon = (name, cls = '') => raw(`<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`);
const LOGO = raw('<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent)"/><path d="M12.5 7.5h7M13.6 7.5v6.4L8.4 22.6a1.7 1.7 0 0 0 1.5 2.4h12.2a1.7 1.7 0 0 0 1.5-2.4l-5.2-8.7V7.5" fill="none" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.6 19.5h10.8" stroke="var(--accent-ink)" stroke-width="2" stroke-linecap="round"/></svg>');

/* ---------- formatting ---------- */
const DAY_MS = 86400000;
const fmt = {
  time: (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'),
  hm: (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'),
  hms: (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
  day: (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
  ago(ms, now = Date.now()) {
    if (!ms) return '—';
    const d = Math.max(0, now - ms);
    if (d < 45000) return 'just now';
    if (d < 3600000) return `${Math.round(d / 60000)} min ago`;
    if (d < DAY_MS) return `${Math.round(d / 3600000)} h ago`;
    return `${Math.round(d / DAY_MS)} d ago`;
  },
  mins: (ms) => `${Math.max(0, Math.round(ms / 60000))} min`,
  num: (n) => Number(n || 0).toLocaleString(),
};
function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
const initials = (name) => String(name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const ROLE_LABEL = { learner: 'Learner', instructor: 'Instructor', admin: 'Admin' };
const LEVEL_LABEL = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
const CHECK_LABEL = { resource_group: 'Resource group name', region: 'Region code', username: 'Lab username', confirm: 'Self-confirmed' };

const STATUS = {
  queued: ['Queued', 'info'], provisioning: ['Provisioning', 'info'], ready: ['Running', 'ok'], stopping: ['Stopping', 'warn'],
  stopped: ['Stopped', 'neutral'], expired: ['Expired', 'neutral'], failed: ['Failed', 'bad'],
  done: ['Done', 'ok'], running: ['Running', 'info'], cancelled: ['Cancelled', 'neutral'],
};
const pill = (status) => {
  const [label, tone] = STATUS[status] || [status, 'neutral'];
  const live = ['queued', 'provisioning', 'running', 'stopping'].includes(status);
  return html`<span class="pill tone-${tone}${live ? ' live' : ''}"><i></i>${label}</span>`;
};
const httpTone = (code) => (code >= 500 ? 'bad' : code >= 400 ? (code === 401 || code === 403 || code === 404 ? 'warn' : 'bad') : 'ok');
const countdown = (expiresAt, cls = '') => html`<span class="countdown ${cls}" data-countdown="${expiresAt}">${fmtCountdown(expiresAt - Date.now())}</span>`;
const progressBar = (pct, label) => html`<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${label || 'Progress'}"><span style="width:${Math.max(3, Math.min(100, Number(pct) || 0))}%"></span></div>`;
const empty = (title, body, action) => html`<div class="empty"><div class="empty-title">${title}</div><p>${body}</p>${action || ''}</div>`;
const pageHead = (title, sub, actions) => html`<header class="page-head"><div class="page-head-text"><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${actions ? html`<div class="page-actions">${actions}</div>` : ''}</header>`;
const copyBtn = (value, label = 'Copy') => html`<button type="button" class="icon-btn" data-act="copy" data-copy="${value}" title="${label}" aria-label="${label}">${icon('copy')}</button>`;

function jsonHtml(value) {
  const text = value === undefined ? '' : JSON.stringify(value, null, 2);
  const s = escapeHtml(text == null ? 'null' : text);
  return raw(s.replace(/(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, (m, str, colon, kw) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (kw) return `<span class="j-kw">${m}</span>`;
    return `<span class="j-num">${m}</span>`;
  }));
}
const SQL_KW = /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|JOIN|LEFT|ON|AS|ORDER|BY|GROUP|LIMIT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CASE|WHEN|THEN|ELSE|END|COUNT|SUM|COALESCE|MAX|MIN|DISTINCT|DESC|ASC|SAVEPOINT|RELEASE|ROLLBACK|TO|REPLACE|WITH|EXPLAIN|QUERY|PLAN|OR IGNORE)\b/g;
const sqlHtml = (sql) => raw(escapeHtml(sql).replace(SQL_KW, '<span class="s-kw">$1</span>'));

/* ---------- live system handles (set at boot) ---------- */
const LIVE = { SQL: null, raw: null, db: null, server: null, workerTimer: null };
const STORE_KEY = 'labpilot:db:v1';
const TOKEN_KEY = 'labpilot:token';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (_) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* storage unavailable */ } },
};

/* ---------- state ---------- */
const freshUi = () => ({
  confirm: null, revealed: {}, taskMsg: {}, newLabOpen: false, newLabTasks: 2, newLabErrors: null,
  assignFor: null, invited: null, inviteErrors: null, auditFilter: 'all', loginError: null,
});
const S = {
  token: null, me: null, view: 'boot', params: {}, data: null, error: null, seq: 0, skipRestore: false,
  net: [], netSeq: 0, netOpen: false, netSel: null, netShowBg: false, netTab: 'response', netUnseen: 0,
  ui: freshUi(),
  tests: { running: false, done: 0, last: null, live: {}, faults: {}, mutation: null, mutRunning: null, autoRan: false },
  apiX: { sel: null, res: null, sending: false, preset: null },
  dbx: { sql: '', result: null, error: null },
  persistedAt: null, persistFailed: false,
};

/* ---------- API client ---------- */
function tamperToken(token) {
  if (!token) return 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJub2JvZHkiLCJyb2xlIjoiYWRtaW4ifQ.forged';
  const [h, p, s] = token.split('.');
  try { const payload = parseJsonB64url(p); payload.role = 'admin'; payload.exp += 365 * DAY_MS; return `${h}.${jsonB64url(payload)}.${s}`; } catch (_) { return token + 'x'; }
}
const client = {
  async request(method, path, { body, auth = 'user', headers = {}, background = false } = {}) {
    const bearer = auth === 'user' ? S.token : auth === 'tampered' ? tamperToken(S.token) : null;
    const reqHeaders = { accept: 'application/json', ...(body !== undefined && body !== null ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...headers };
    const reqBody = body === undefined || body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const t0 = performance.now();
    await sleep(14 + Math.random() * 36); // network latency, so loading states are real
    const res = await LIVE.server.handle({ method, path, headers: reqHeaders, body: reqBody });
    await sleep(4 + Math.random() * 10);
    logNet({ id: ++S.netSeq, at: Date.now(), method, path, status: res.status, ms: Math.round(performance.now() - t0), res, reqHeaders, reqBody, background, who: S.me ? S.me.user.name : 'Signed out' });
    if (res.status === 401 && auth === 'user' && S.token && !path.startsWith('/api/auth')) sessionEnded();
    return res;
  },
};
class ApiError extends Error { constructor(res) { super((res.body && res.body.detail) || `HTTP ${res.status}`); this.res = res; } }
async function api(method, path, body, opts = {}) {
  const res = await client.request(method, path, { body, ...opts });
  if (res.status >= 400) throw new ApiError(res);
  return res.body;
}
const get = (path, background) => api('GET', path, undefined, { background });

/* ---------- toasts ---------- */
function toast(title, tone = 'ok', detail = '') {
  const host = $('#toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast tone-${tone}`;
  el.innerHTML = String(html`<div class="toast-title">${title}</div>${detail ? html`<div class="toast-detail">${detail}</div>` : ''}`);
  host.appendChild(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, tone === 'bad' ? 6500 : 4200);
}
function toastProblem(res) {
  const b = res.body || {};
  const fields = b.errors ? Object.values(b.errors).join(' · ') : '';
  toast(`${res.status} ${b.title || 'Error'}${b.code ? ` · ${b.code}` : ''}`, res.status >= 500 ? 'bad' : 'warn', [b.detail, fields].filter(Boolean).join(' — '));
}
async function withBusy(btn, fn) {
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try { return await fn(); }
  catch (e) {
    if (e instanceof ApiError) toastProblem(e.res);
    else { console.error(e); toast('Something went wrong', 'bad', e.message); }
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.classList.remove('busy'); }
  }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'ok', text.length > 60 ? text.slice(0, 60) + '…' : text); }
  catch (_) { toast('Copy is blocked here', 'warn', 'Select the text and copy it manually.'); }
}

/* ---------- network inspector ---------- */
function logNet(entry) {
  S.net.push(entry);
  if (S.net.length > 250) S.net.shift();
  if (!entry.background) S.netUnseen++;
  if (!entry.background || S.netShowBg) renderNet();
}
function visibleNet() { return S.net.filter((e) => S.netShowBg || !e.background); }
function renderNet() {
  const bar = $('#net-bar'), body = $('#net-body'), host = $('#net');
  if (!bar) return;
  const list = visibleNet();
  const last = list[list.length - 1];
  host.classList.toggle('open', S.netOpen);
  bar.innerHTML = String(html`
    <button type="button" class="net-toggle" data-act="toggleNet" aria-expanded="${S.netOpen ? 'true' : 'false'}" aria-controls="net-body">
      ${icon('net')}<span class="net-label">Network</span><span class="net-count">${list.length}</span>
      ${last ? html`<span class="net-last"><b class="m-${last.method.toLowerCase()}">${last.method}</b> <span class="net-path">${last.path}</span> <span class="code tone-${httpTone(last.status)}">${last.status}</span> <span class="muted">${last.ms} ms</span></span>` : html`<span class="net-last muted">Every API call the app makes appears here, with the SQL it ran.</span>`}
      <span class="net-chev">${icon(S.netOpen ? 'down' : 'up')}</span>
    </button>`);
  body.hidden = !S.netOpen;
  if (!S.netOpen) return;
  const sel = S.net.find((e) => e.id === S.netSel) || last;
  body.innerHTML = String(html`
    <div class="net-list">
      <div class="net-tools">
        <label class="check-inline"><input type="checkbox" id="net-bg" data-change="netBg" ${S.netShowBg ? 'checked' : ''}> Show background refreshes</label>
        <button type="button" class="btn btn-ghost btn-xs" data-act="netClear">Clear</button>
      </div>
      <ol class="net-rows">${list.slice().reverse().map((e) => html`
        <li><button type="button" class="net-row${sel && sel.id === e.id ? ' sel' : ''}" data-act="netSel" data-id="${e.id}">
          <span class="code tone-${httpTone(e.status)}">${e.status}</span>
          <b class="m-${e.method.toLowerCase()}">${e.method}</b>
          <span class="net-path">${e.path}</span>
          <span class="muted num">${e.ms} ms</span>
        </button></li>`)}</ol>
    </div>
    <div class="net-detail">${sel ? netDetail(sel) : empty('No requests yet', 'Sign in or click around the app to see its API traffic.')}</div>`);
}
function netDetail(e) {
  const r = e.res;
  const tabs = [['response', 'Response'], ['request', 'Request'], ['sql', `SQL · ${r.sql.length}`]];
  return html`
    <div class="nd-head">
      <div class="nd-line"><b class="m-${e.method.toLowerCase()}">${e.method}</b> <span class="mono">${e.path}</span></div>
      <div class="nd-meta"><span class="code tone-${httpTone(e.status)}">${e.status} ${STATUS_TEXT[e.status] || ''}</span>
        <span>${e.ms} ms total · ${r.serverMs} ms server</span><span class="mono">${r.headers['x-request-id']}</span><span>${e.who}</span></div>
    </div>
    <div class="tabs" role="tablist">${tabs.map(([k, label]) => html`<button type="button" role="tab" class="tab${S.netTab === k ? ' on' : ''}" aria-selected="${S.netTab === k ? 'true' : 'false'}" data-act="netTab" data-tab="${k}">${label}</button>`)}</div>
    <div class="nd-body">${S.netTab === 'request' ? html`
        <div class="kv-title">Headers</div>${headerList(redactHeaders(e.reqHeaders))}
        <div class="kv-title">Body</div><pre class="code-block">${e.reqBody ? jsonOrText(e.reqBody) : html`<span class="j-dim">(none)</span>`}</pre>`
      : S.netTab === 'sql' ? sqlTrace(r.sql)
      : html`<div class="kv-title">Headers</div>${headerList(r.headers)}<div class="kv-title">Body</div><pre class="code-block">${jsonHtml(r.body)}</pre>`}</div>`;
}
function jsonOrText(s) { try { return jsonHtml(JSON.parse(s)); } catch (_) { return s; } }
function redactHeaders(h) {
  const out = { ...h };
  if (out.authorization) out.authorization = out.authorization.slice(0, 26) + '…' + out.authorization.slice(-6);
  return out;
}
const headerList = (h) => html`<dl class="headers">${Object.entries(h).map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
const sqlTrace = (rows) => rows.length
  ? html`<ol class="sql-trace">${rows.map((q) => html`<li><pre class="code-block sql">${sqlHtml(q.sql)}</pre><div class="sql-meta">${q.params.length ? html`<span>params <code>${JSON.stringify(q.params)}</code></span>` : ''}<span>${q.rows} row${q.rows === 1 ? '' : 's'}</span><span>${q.ms} ms</span></div></li>`)}</ol>`
  : empty('No SQL for this request', 'It was rejected before reaching the database, by routing, authentication or validation.');

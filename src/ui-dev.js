/* =====================================================================
   LabPilot · "Under the hood" views: API explorer, database console,
   test suite with fault injection, and the build notes.
   ===================================================================== */

/* ---------- API explorer ---------- */
function devLookup() {
  // Developer convenience: pick real ids for path parameters straight from the database.
  const db = LIVE.db;
  const me = S.me && S.me.user;
  const tid = S.me ? S.me.tenant.id : 'tnt_contoso';
  const session = me && me.role === 'learner'
    ? db.get('SELECT id FROM lab_sessions WHERE learner_id = ? ORDER BY created_at DESC LIMIT 1', [me.id])
    : db.get("SELECT id FROM lab_sessions WHERE tenant_id = ? ORDER BY CASE WHEN status = 'ready' THEN 0 ELSE 1 END, created_at DESC LIMIT 1", [tid]);
  const lab = me && me.role === 'learner'
    ? db.get('SELECT template_id AS id FROM assignments WHERE learner_id = ? LIMIT 1', [me.id])
    : db.get('SELECT id FROM lab_templates WHERE tenant_id = ? ORDER BY created_at LIMIT 1', [tid]);
  const learner = db.get("SELECT id FROM users WHERE tenant_id = ? AND role = 'learner' ORDER BY name LIMIT 1", [tid]);
  const foreign = db.get("SELECT id FROM lab_sessions WHERE tenant_id <> ? ORDER BY CASE WHEN status = 'ready' THEN 0 ELSE 1 END, created_at DESC LIMIT 1", [tid]);
  return { sessionId: session ? session.id : 'ses_unknown', labId: lab ? lab.id : 'lab_unknown', learnerId: learner ? learner.id : 'usr_unknown', foreignSessionId: foreign ? foreign.id : 'ses_unknown' };
}
function fillRoute(r) {
  const ids = devLookup();
  const path = r.path.replace(':id', r.path.startsWith('/api/labs') ? ids.labId : ids.sessionId).replace(':taskId', 't1');
  let body = r.example ? JSON.parse(JSON.stringify(r.example)) : null;
  if (body && 'templateId' in body) body.templateId = ids.labId;
  if (body && 'learnerIds' in body) body.learnerIds = [ids.learnerId];
  if (body && 'email' in body && 'password' in body && S.me) body.email = S.me.user.email;
  return { method: r.method, path, body: body ? JSON.stringify(body, null, 2) : '', idem: r.path === '/api/sessions' && r.method === 'POST' ? 'demo-' + shortId(6) : '' };
}
const PRESETS = [
  { title: 'Read another organization’s lab session', expect: '404', why: 'Tenant scope comes from the token. Ids from other tenants look like they do not exist.',
    make: (ids) => ({ method: 'GET', path: `/api/sessions/${ids.foreignSessionId}`, auth: 'user', body: '' }), needsAuth: true },
  { title: 'Edit my token: admin role, valid for a year', expect: '401', why: 'The payload changed but the HMAC signature did not, so the token is rejected. Roles are read from the database on every request anyway.',
    make: () => ({ method: 'GET', path: '/api/audit', auth: 'tampered', body: '' }) },
  { title: 'Sneak a tenantId into the request body', expect: '422 / 403', why: 'Unknown fields are rejected, so a client cannot choose its tenant. Staff get 403 first because only learners launch labs.',
    make: (ids) => ({ method: 'POST', path: '/api/sessions', auth: 'user', body: JSON.stringify({ templateId: ids.labId, tenantId: 'tnt_fabrikam' }, null, 2) }), needsAuth: true },
  { title: 'Create a lab that runs for five hours', expect: '422 / 403', why: 'durationMin must be 15 to 240. The database has the same CHECK constraint as a backstop.',
    make: () => ({ method: 'POST', path: '/api/labs', auth: 'user', body: JSON.stringify({ title: 'Marathon lab', summary: 'Runs far longer than any lab should.', level: 'advanced', durationMin: 300, creditsPerHour: 10, resources: ['VM'], tasks: [{ title: 'Survive', check: 'confirm' }] }, null, 2) }), needsAuth: true },
  { title: 'Call the API with no token', expect: '401', why: 'Every route except sign-in runs the authenticate middleware first.',
    make: () => ({ method: 'GET', path: '/api/sessions', auth: 'none', body: '' }) },
  { title: 'Send malformed JSON', expect: '400', why: 'The body is parsed before routing, and parse errors become problem+json.',
    make: () => ({ method: 'POST', path: '/api/auth/login', auth: 'none', body: '{"email": "ananya@contoso.example", ' }) },
  { title: 'Use the wrong HTTP method', expect: '405', why: 'The route exists for GET and POST only, so the response includes an Allow header.',
    make: () => ({ method: 'DELETE', path: '/api/labs', auth: 'user', body: '' }) },
];
VIEWS.api = {
  title: 'API explorer',
  render() {
    const routes = LIVE.server.routes;
    const x = S.apiX;
    if (!x.form) { const r = routes.find((q) => q.method === 'GET' && q.path === '/api/me') || routes[0]; x.sel = `${r.method} ${r.path}`; x.form = { ...fillRoute(r), auth: S.me ? 'user' : 'none' }; }
    const f = x.form;
    const res = x.res;
    const groups = {};
    routes.forEach((r) => { const g = r.path.split('/')[2]; (groups[g] = groups[g] || []).push(r); });
    return html`${pageHead('API explorer', 'Send real requests to the same API the app uses. Responses, headers and the SQL each request ran are shown below.')}
      <div class="api-layout">
        <aside class="panel api-list">
          <div class="panel-head"><h2>Endpoints</h2><span class="muted small">${routes.length} routes</span></div>
          ${Object.entries(groups).map(([g, rs]) => html`<div class="api-group"><div class="api-group-name">/${g}</div>${rs.map((r) => {
            const key = `${r.method} ${r.path}`;
            return html`<button type="button" class="api-route${x.sel === key ? ' on' : ''}" data-act="apiPick" data-key="${key}"><b class="m-${r.method.toLowerCase()}">${r.method}</b><span class="mono">${r.path}</span><span class="api-sum">${r.summary}${r.roles ? html` <span class="roles">· ${r.roles.join(', ')}</span>` : ''}</span></button>`;
          })}</div>`)}
        </aside>
        <div class="api-main">
          <section class="panel">
            <div class="panel-head"><h2>Try to break it</h2><span class="muted small">Each one sends immediately</span></div>
            <div class="presets">${PRESETS.map((p, i) => html`<button type="button" class="preset" data-act="apiPreset" data-i="${i}"><span class="preset-title">${p.title}</span><span class="preset-expect">expect ${p.expect}</span></button>`)}</div>
            ${x.preset != null ? html`<p class="preset-why">${icon('shield')}<span>${PRESETS[x.preset].why}</span></p>` : ''}
          </section>
          <form class="panel" data-form="apiSend">
            <div class="panel-body">
              <div class="req-line">
                <label class="sr" for="ax-method">Method</label>
                <select id="ax-method">${['GET', 'POST', 'PUT', 'DELETE'].map((m) => html`<option ${f.method === m ? raw('selected') : ''}>${m}</option>`)}</select>
                <label class="sr" for="ax-path">Path</label>
                <input id="ax-path" class="mono" value="${f.path}" spellcheck="false" autocomplete="off">
                <button type="submit" class="btn btn-primary">Send</button>
              </div>
              <div class="req-opts">
                <div class="field"><label for="ax-auth">Authorization</label>
                  <select id="ax-auth">
                    <option value="user" ${f.auth === 'user' ? raw('selected') : ''}>${S.me ? `Bearer token of ${S.me.user.name}` : 'Bearer token (sign in first)'}</option>
                    <option value="none" ${f.auth === 'none' ? raw('selected') : ''}>No token</option>
                    <option value="tampered" ${f.auth === 'tampered' ? raw('selected') : ''}>Edited token (role admin, +1 year)</option>
                  </select></div>
                <div class="field"><label for="ax-idem">Idempotency-Key <span class="muted">(optional)</span></label><input id="ax-idem" class="mono" value="${f.idem || ''}" spellcheck="false" autocomplete="off"></div>
              </div>
              <div class="field"><label for="ax-body">JSON body</label><textarea id="ax-body" class="mono code-input" rows="7" spellcheck="false">${f.body}</textarea></div>
            </div>
          </form>
          <section class="panel response-panel" aria-live="polite">
            ${res ? html`<div class="panel-head resp-head"><span class="code big tone-${httpTone(res.status)}">${res.status}</span><b>${STATUS_TEXT[res.status] || ''}</b>
                <span class="muted small">${res.ms} ms · ${res.res.serverMs} ms in handler · ${res.res.sql.length} SQL statement${res.res.sql.length === 1 ? '' : 's'}</span></div>
              <div class="panel-body resp-body">
                <div class="kv-title">Body</div><pre class="code-block">${jsonHtml(res.res.body)}</pre>
                <div class="resp-cols"><div><div class="kv-title">Headers</div>${headerList(res.res.headers)}</div><div><div class="kv-title">SQL</div>${sqlTrace(res.res.sql)}</div></div>
              </div>`
              : html`<div class="panel-body">${empty('No response yet', 'Pick an endpoint or a preset, then send it. You can edit the path, token and body first.')}</div>`}
          </section>
        </div>
      </div>`;
  },
};
async function apiSend(btn) {
  const f = S.apiX.form = {
    method: $('#ax-method').value, path: $('#ax-path').value.trim() || '/', auth: $('#ax-auth').value,
    idem: $('#ax-idem').value.trim(), body: $('#ax-body').value,
  };
  if (f.auth === 'user' && !S.token) f.auth = 'none';
  await withBusy(btn, async () => {
    const res = await client.request(f.method, f.path, { body: f.body.trim() ? f.body : undefined, auth: f.auth, headers: f.idem ? { 'Idempotency-Key': f.idem } : {} });
    S.apiX.res = { status: res.status, ms: S.net[S.net.length - 1].ms, res };
    renderMain();
    if (S.token) scheduleRefresh(50);
  });
}

/* ---------- database console ---------- */
const SAMPLE_SQL = [
  ['Credit balance per organization', `SELECT t.name, t.credit_quota AS quota, SUM(l.delta) AS balance\nFROM credit_ledger l JOIN tenants t ON t.id = l.tenant_id\nGROUP BY t.id`],
  ['Sessions by status', `SELECT status, COUNT(*) AS sessions\nFROM lab_sessions\nGROUP BY status\nORDER BY sessions DESC`],
  ['Jobs that needed a retry', `SELECT id, type, session_id, attempts, last_error\nFROM jobs\nWHERE attempts > 1\nORDER BY id DESC`],
  ['Is the tenant index used?', `EXPLAIN QUERY PLAN\nSELECT * FROM lab_sessions\nWHERE tenant_id = 'tnt_contoso' AND status = 'ready'`],
  ['Passwords are hashes', `SELECT email, role, substr(password_hash, 1, 40) || '…' AS password_hash\nFROM users`],
  ['Try to delete the audit log', `DELETE FROM audit_log`],
];
function runReadOnly(sql) {
  const q = sql.trim().replace(/;+\s*$/, '');
  if (!q) throw new Error('Type a query first.');
  if (!/^(select|with|explain|pragma\s+table_info|pragma\s+index_list)\b/i.test(q)) throw new Error('This console is read-only. Start with SELECT, WITH, EXPLAIN or PRAGMA table_info.');
  if (q.includes(';')) throw new Error('Run one statement at a time.');
  const t0 = performance.now();
  LIVE.raw.exec('SAVEPOINT console_ro');
  try {
    const res = LIVE.raw.exec(q);
    return { columns: res[0] ? res[0].columns : [], rows: res[0] ? res[0].values : [], ms: Math.round((performance.now() - t0) * 100) / 100 };
  } finally {
    LIVE.raw.exec('ROLLBACK TO console_ro'); // anything a WITH … DELETE slipped through is undone
    LIVE.raw.exec('RELEASE console_ro');
  }
}
function dbRun(sql) {
  S.dbx.sql = sql;
  try { S.dbx.result = runReadOnly(sql); S.dbx.error = null; } catch (e) { S.dbx.result = null; S.dbx.error = e.message; }
  S.skipRestore = true;
  renderMain();
}
VIEWS.db = {
  title: 'Database',
  render() {
    const db = LIVE.db;
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((t) => ({ name: t.name, rows: db.val(`SELECT COUNT(*) FROM "${t.name}"`) }));
    const migs = db.all('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
    const r = S.dbx.result;
    if (!S.dbx.sql) S.dbx.sql = SAMPLE_SQL[0][1];
    return html`${pageHead('Database', 'SQLite running in this page. The app reaches it only through the API; this console is a developer view.')}
      <div class="callout tone-info">${icon('db')}<span>This console reads the database directly, so it is <b>not</b> tenant-scoped. It is read-only: queries run inside a savepoint that is always rolled back.</span></div>
      <div class="db-layout">
        <aside class="panel">
          <div class="panel-head"><h2>Tables</h2></div>
          <ul class="table-list">${tables.map((t) => html`<li><button type="button" class="table-btn" data-act="dbTable" data-t="${t.name}"><span class="mono">${t.name}</span><span class="muted num">${t.rows}</span></button></li>`)}</ul>
          <div class="panel-head sub"><h2>Migrations</h2></div>
          <ol class="mig-list">${migs.map((m) => html`<li><span class="mono">${m.name}</span><span class="muted small">${fmt.ago(m.applied_at)}</span></li>`)}</ol>
          <div class="panel-body"><button type="button" class="btn btn-ghost-danger btn-sm" data-act="resetDemo">${icon('reset')}${S.ui.confirm === 'reset' ? 'Click again to wipe and reseed' : 'Reset demo data'}</button></div>
        </aside>
        <div class="db-main">
          <form class="panel" data-form="dbRun">
            <div class="panel-body">
              <div class="samples">${SAMPLE_SQL.map(([label], i) => html`<button type="button" class="chip-btn" data-act="dbSample" data-i="${i}">${label}</button>`)}</div>
              <label class="sr" for="db-sql">SQL query</label>
              <textarea id="db-sql" class="mono code-input" rows="5" spellcheck="false" data-enter-mod="dbRun">${S.dbx.sql}</textarea>
              <div class="form-foot"><span class="fine">Ctrl/⌘ + Enter runs the query.</span><button type="submit" class="btn btn-primary">${icon('play')}Run query</button></div>
            </div>
          </form>
          <section class="panel">
            ${S.dbx.error ? html`<div class="panel-body"><div class="callout tone-bad" role="alert">${S.dbx.error}</div></div>`
              : r ? html`<div class="panel-head"><h2>Result</h2><span class="muted small num">${r.rows.length} row${r.rows.length === 1 ? '' : 's'} · ${r.ms} ms</span></div>
                ${r.columns.length ? html`<div class="table-wrap result-wrap"><table class="data compact mono-cells"><thead><tr>${r.columns.map((c) => html`<th>${c}</th>`)}</tr></thead>
                  <tbody>${r.rows.slice(0, 200).map((row) => html`<tr>${row.map((v) => html`<td title="${v == null ? 'NULL' : String(v)}">${v == null ? html`<span class="null">NULL</span>` : String(v)}</td>`)}</tr>`)}</tbody></table></div>`
                  : html`<div class="panel-body muted">The statement ran and returned no rows.</div>`}`
              : html`<div class="panel-body">${empty('Run a query', 'Pick a table or a sample query to start.')}</div>`}
          </section>
        </div>
      </div>`;
  },
  mount() { if (!S.dbx.result && !S.dbx.error) dbRun(S.dbx.sql || SAMPLE_SQL[0][1]); },
};

/* ---------- tests ---------- */
const SPEC_ACS = [
  ['AC-1', 'A running lab can be extended by exactly 15 minutes.', 'E1'],
  ['AC-2', 'At most two extensions per session; the third returns 422 extension_limit.', 'E2'],
  ['AC-3', 'Each extension debits credits; without enough credits it returns 402 and changes nothing.', 'E3'],
  ['AC-4', 'Only a running lab can be extended; anything else returns 409 not_running.', 'E4'],
  ['AC-5', 'Classmates and other organizations get 404, the same as a missing session.', 'E5'],
  ['AC-6', 'Every extension writes an audit entry with actor, minutes and request id.', 'E6'],
];
const yieldUI = () => new Promise((r) => setTimeout(r, 0));
async function runTestsUI(btn) {
  if (S.tests.running) return;
  const faults = { ...S.tests.faults };
  S.tests.running = true; S.tests.live = {}; S.tests.done = 0; S.tests.runFaults = Object.keys(faults).filter((k) => faults[k]);
  renderMain();
  let last = 0;
  const res = await runTests(LIVE.SQL, {
    faults,
    onResult: (r) => { S.tests.live[r.id] = r; S.tests.done++; },
    tick: async () => { if (performance.now() - last > 60) { last = performance.now(); if (S.view === 'tests') renderMain(); await yieldUI(); } },
  });
  S.tests.running = false;
  S.tests.last = { ...res, faults: S.tests.runFaults, at: Date.now() };
  renderRail();
  if (S.view === 'tests') renderMain();
}
async function runMutationUI() {
  if (S.tests.running) return;
  S.tests.running = true;
  S.tests.mutation = { results: {}, done: 0 };
  renderMain();
  for (const f of FAULTS) {
    S.tests.mutRunning = f.key;
    if (S.view === 'tests') renderMain();
    await yieldUI();
    const res = await runTests(LIVE.SQL, { faults: { [f.key]: true }, tick: yieldUI });
    S.tests.mutation.results[f.key] = res.results.filter((r) => r.status === 'fail').map((r) => r.id);
    S.tests.mutation.done++;
  }
  S.tests.mutRunning = null;
  S.tests.running = false;
  S.tests.mutation.caught = Object.values(S.tests.mutation.results).filter((ids) => ids.length).length;
  await runTestsUI(); // leave the list showing a run with the current switches
}
VIEWS.tests = {
  title: 'Test suite',
  render() {
    const T = S.tests;
    const live = T.running ? T.live : T.last ? Object.fromEntries(T.last.results.map((r) => [r.id, r])) : {};
    const suites = [];
    TESTS.forEach((t) => { let g = suites.find((s) => s.name === t.suite); if (!g) suites.push(g = { name: t.suite, tests: [] }); g.tests.push(t); });
    const enabled = Object.keys(T.faults).filter((k) => T.faults[k]);
    const last = T.last;
    const mut = T.mutation;
    const summary = T.running && !T.mutRunning
      ? html`<div class="ts-status running"><span class="spinner"></span><b>Running</b> <span class="num">${T.done} / ${TESTS.length}</span></div>`
      : T.mutRunning ? html`<div class="ts-status running"><span class="spinner"></span><b>Mutation check</b> <span class="num">${mut.done + 1} / ${FAULTS.length}</span><span class="muted">${FAULTS.find((f) => f.key === T.mutRunning).title}</span></div>`
      : last ? html`<div class="ts-status ${last.failed ? 'bad' : 'ok'}">${icon(last.failed ? 'cross' : 'tick')}<b class="num">${last.passed} passed${last.failed ? `, ${last.failed} failed` : ''}</b><span class="muted num">${(last.ms / 1000).toFixed(1)} s${last.faults.length ? ` · with ${last.faults.length} injected bug${last.faults.length === 1 ? '' : 's'}` : ' · clean build'}</span></div>`
      : html`<div class="ts-status"><b>Not run yet</b></div>`;
    return html`${pageHead('Test suite', `${TESTS.length} tests. Each API test gets a fresh in-memory database built by the real migrations, then drives the real API and worker with a fake clock.`)}
      <section class="panel ts-bar">
        ${summary}
        <div class="ts-actions">
          <button type="button" class="btn btn-primary" data-act="runTests" ${T.running ? raw('disabled') : ''}>${icon('play')}${enabled.length ? `Run with ${enabled.length} bug${enabled.length === 1 ? '' : 's'} injected` : 'Run all tests'}</button>
          <button type="button" class="btn" data-act="runMutation" ${T.running ? raw('disabled') : ''}>${icon('bug')}Mutation check</button>
        </div>
        ${mut && mut.caught != null ? html`<div class="ts-mut tone-${mut.caught === FAULTS.length ? 'ok' : 'warn'}">${icon('shield')}<span><b class="num">${mut.caught} of ${FAULTS.length}</b> injected bugs were caught by at least one failing test.</span></div>` : ''}
      </section>
      <div class="tests-layout">
        <section class="panel test-results">
          ${suites.map((g) => html`<div class="suite"><div class="suite-name">${g.name}</div><ul class="test-list">${g.tests.map((t) => {
            const r = live[t.id];
            const st = r ? r.status : T.running ? 'pending' : 'idle';
            return html`<li class="test st-${st}">
              <span class="t-mark">${st === 'pass' ? icon('tick') : st === 'fail' ? icon('cross') : st === 'skip' ? '–' : ''}</span>
              <span class="t-id mono">${t.id}</span>
              <span class="t-name">${t.name}${r && r.error ? html`<span class="t-err mono">${r.error}</span>` : ''}</span>
              <span class="t-ms num muted">${r ? `${r.ms} ms` : ''}</span>
            </li>`;
          })}</ul></div>`)}
        </section>
        <aside class="tests-side">
          <section class="panel">
            <div class="panel-head"><h2>Inject a bug</h2><span class="muted small">${enabled.length ? `${enabled.length} on` : 'all off'}</span></div>
            <div class="panel-body">
              <p class="fine lead-fine">Each switch applies a change an AI coding agent could plausibly write. It only affects the code under test, never the live app. Turn one on and run the suite.</p>
              <ul class="faults">${FAULTS.map((f) => {
                const caught = mut && mut.results[f.key];
                const on = !!T.faults[f.key];
                return html`<li class="fault${on ? ' on' : ''}">
                  <label class="switch"><input type="checkbox" id="fault-${f.key}" data-change="toggleFault" data-key="${f.key}" ${on ? raw('checked') : ''} ${T.running ? raw('disabled') : ''}><span class="switch-ui" aria-hidden="true"></span><span class="fault-title">${f.title}</span></label>
                  <div class="fault-file mono">${f.file}</div>
                  <pre class="diff">${f.diff.map((l) => html`<span class="${l.startsWith('-') ? 'del' : 'add'}">${l}</span>\n`)}</pre>
                  <p class="fault-why">${f.why}</p>
                  ${caught ? html`<div class="caught tone-${caught.length ? 'ok' : 'bad'}">${caught.length ? html`${icon('tick')}Caught by ${caught.join(', ')}` : html`${icon('cross')}Not caught`}</div>` : ''}
                </li>`;
              })}</ul>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Spec → tests</h2><span class="muted small">SPEC-014 · Lab time extension</span></div>
            <div class="panel-body"><ul class="trace">${SPEC_ACS.map(([ac, text, id]) => { const r = live[id]; return html`<li><span class="trace-ac mono">${ac}</span><span class="trace-text">${text}</span><span class="trace-test st-${r ? r.status : 'idle'}"><span class="mono">${id}</span>${r ? icon(r.status === 'pass' ? 'tick' : 'cross') : ''}</span></li>`; })}</ul></div>
          </section>
        </aside>
      </div>`;
  },
  mount() { if (!S.tests.autoRan && !S.tests.running) { S.tests.autoRan = true; runTestsUI(); } },
};

/* ---------- how it's built ---------- */
const AGENTS_MD = `# AGENTS.md · LabPilot

Read this before changing anything. Each rule exists because the mistake it prevents is easy to make and easy to miss in review.

## Rules
- Tenant data is always filtered by \`tenant_id\` from the authenticated user. Never from the body, query string or route.
- Learner-owned records (sessions, credentials) also check ownership. Missing, other-tenant and not-yours all return the same 404.
- Request bodies go through \`validate(shape)\`. Unknown fields are rejected, so a client can never set \`tenantId\` or \`role\`.
- Errors are \`application/problem+json\` via \`HttpError(status, code, detail)\`. Codes are stable snake_case; the UI branches on them.
- Credits only move through \`credit_ledger\` rows. Never store a balance column.
- Secrets live in \`vault_secrets\`; other tables keep a \`secret_ref\`. Credential reads are audited and sent with \`Cache-Control: no-store\`.
- SQL is parameterised. String-built SQL fails review.
- Server code reads time from the injected \`clock\`, never \`Date.now()\`, so tests can move time.
- UI markup uses the \`html\` tagged template, which escapes by default. Any \`raw()\` needs a comment saying why it is safe.

## Definition of done
1. Every acceptance criterion in the spec maps to a test id.
2. The new test fails before the change and passes after it.
3. A new guard gets a matching entry in \`FAULTS\`, and the mutation check stays at 100%.
4. Migrations are additive and numbered. Never edit an applied one.
5. The PR says what changed, why, how it was tested, and how to roll it back.

## Working in parallel
- One spec per branch and worktree: \`git worktree add ../lp-SPEC-014 -b spec/SPEC-014\`
- Agents edit only the files listed in the spec's "Files in scope".
- One spec at a time owns the migrations in \`core.js\`.

## When an agent repeats a mistake
Add a one-line rule above, with the reason.`;

/** Tiny renderer for the markdown this file ships (headings, lists, inline code). Input is escaped first. */
function mdLite(src) {
  const inline = (t) => escapeHtml(t).replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of src.split('\n')) {
    let m;
    if (!line.trim()) { close(); continue; }
    if ((m = /^# (.*)/.exec(line))) { close(); out.push(`<h3>${inline(m[1])}</h3>`); }
    else if ((m = /^## (.*)/.exec(line))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if ((m = /^- (.*)/.exec(line))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = /^\d+\. (.*)/.exec(line))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return raw(out.join(''));
}

const SPEC_MD = `SPEC-014 · Lab time extension

Problem
  Learners lose work when a lab expires a few minutes before they
  finish. Instructors currently cannot give more time.

Change
  POST /api/sessions/:id/extend adds 15 minutes to a running lab.

Files in scope
  server.js   the route
  tests.js    E1–E6 and FAULTS
  ui-views.js the Extend buttons

Out of scope
  Changing lab duration on the template. Refund rules.

Responses
  200  session with the new expiresAt and extensionsLeft
  402  insufficient_credits    404  not_found
  409  not_running             422  extension_limit`;

const REVIEW_CHECKLIST = [
  ['Tenancy and auth', 'Is every query scoped by the token’s tenant? Does each route check role and ownership, and return 404 rather than 403 where existence would leak?'],
  ['Input', 'Are bodies validated with unknown fields rejected? Are limits enforced in both the API and the schema?'],
  ['Secrets', 'Any secret in code, logs, responses or the database outside the vault? Are reads audited?'],
  ['Data integrity', 'Are multi-row writes in one transaction? Do unique indexes back up the business rules?'],
  ['Concurrency', 'What happens on a retry, a double-click or two workers claiming one job?'],
  ['Errors', 'Problem+json with a stable code, and no stack traces or SQL in responses?'],
  ['Tests', 'Does a test fail when the change is reverted? Is there a fault entry for each new guard?'],
  ['Performance', 'Does each new query have an index? Any query inside a loop?'],
];
const ARCH = [
  ['Interface', 'Role-based views built with an auto-escaping html template; live updates pushed per tenant.', 'Next.js / React or Angular, served from Azure Static Web Apps or App Service'],
  ['API', '{n} routes. Middleware chain: authenticate → role → validate → handler. Errors as problem+json; idempotency keys on launch.', 'ASP.NET Core minimal APIs or Next.js route handlers on Container Apps behind Front Door'],
  ['Identity', 'PBKDF2 password hashes (100k iterations); HMAC-SHA256 tokens, 8-hour expiry; sign-in rate limit.', 'Microsoft Entra ID or Azure AD B2C with OIDC'],
  ['Data', 'SQLite with 5 numbered migrations, CHECK constraints, partial unique indexes; a ledger for credits.', 'Azure SQL with stored procedures, or PostgreSQL with row-level security'],
  ['Jobs', 'Polling worker, guarded claim, retries with exponential backoff, expiry sweep, refunds on failure.', 'Service Bus queue plus Functions or Container Apps jobs'],
  ['Secrets', 'vault_secrets table; sessions hold only a reference.', 'Key Vault, read with a managed identity'],
  ['Observability', 'Network panel with per-request SQL trace; request ids in the audit log.', 'Application Insights and Log Analytics with KQL alerts'],
  ['Quality', '{t} tests with a fake clock and a fresh database per test; {f} injectable bugs for mutation checks.', 'xUnit or Vitest plus Playwright in GitHub Actions or Azure DevOps'],
];
VIEWS.about = {
  title: 'How it’s built',
  render() {
    const n = LIVE.server.routes.length;
    const fill = (s) => s.replace('{n}', n).replace('{t}', TESTS.length).replace('{f}', FAULTS.length);
    return html`${pageHead('How LabPilot is built', 'A full stack in one page: UI, API, database, background worker and tests. Each layer maps to the Azure service it would run on in production.')}
      <section class="panel builder">
        <div class="panel-body builder-body">
          <div class="avatar lg">${initials(APP.builder)}</div>
          <div>
            <div class="eyebrow">Built by</div>
            <h2 class="builder-name">${APP.builder}</h2>
            <p>A working sample for a full-stack role that ships through AI coding agents. It was written spec-first: the rules live in <span class="mono">AGENTS.md</span>, each feature has acceptance criteria mapped to test ids, and every guard has an injectable bug that the suite has to catch.</p>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Request path</h2><span class="muted small">What happens when a learner clicks Launch</span></div>
        <div class="panel-body">
          <ol class="flow">
            <li><b>UI</b><span>POST /api/sessions with an Idempotency-Key</span></li>
            <li><b>Middleware</b><span>Verify token → learner role → validate body</span></li>
            <li><b>Handler</b><span>Check assignment, active session, credit balance</span></li>
            <li><b>Transaction</b><span>Insert session, debit ledger, enqueue job, audit</span></li>
            <li><b>202 Accepted</b><span>UI opens the session and listens for updates</span></li>
            <li><b>Worker</b><span>Five provisioning steps, retries, then Ready</span></li>
          </ol>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Layers</h2></div>
        <div class="table-wrap"><table class="data arch"><thead><tr><th>Layer</th><th>In this page</th><th>On Azure in production</th></tr></thead>
          <tbody>${ARCH.map(([layer, here, prod]) => html`<tr><th scope="row">${layer}</th><td>${fill(here)}</td><td class="muted">${prod}</td></tr>`)}</tbody></table></div>
      </section>
      <div class="about-cols">
        <section class="panel">
          <div class="panel-head"><h2>AGENTS.md</h2>${copyBtn(AGENTS_MD, 'Copy AGENTS.md')}</div>
          <div class="md">${mdLite(AGENTS_MD)}</div>
        </section>
        <div class="about-stack">
          <section class="panel">
            <div class="panel-head"><h2>A spec, as handed to an agent</h2>${copyBtn(SPEC_MD, 'Copy spec')}</div>
            <pre class="code-block doc">${SPEC_MD}</pre>
            <div class="panel-body"><button type="button" class="btn btn-sm" data-act="nav" data-view="tests">${icon('check')}See its acceptance criteria run</button></div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Review checklist for agent diffs</h2></div>
            <div class="panel-body"><dl class="checklist">${REVIEW_CHECKLIST.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl></div>
          </section>
        </div>
      </div>`;
  },
};

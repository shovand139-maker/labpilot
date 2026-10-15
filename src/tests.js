/* =====================================================================
   LabPilot · test suite
   Every API test boots a fresh in-memory database, applies the real
   migrations, seeds a small fixture and drives the real server and worker
   with a fake clock. FAULTS are plausible-looking agent mistakes; switching
   one on must turn at least one test red.
   ===================================================================== */

const FAULTS = [
  { key: 'skipTenantScope', title: 'Drop the tenant filter on session lookup', file: 'server.js · loadSession()',
    diff: ['- WHERE s.id = ? AND s.tenant_id = ?', '+ WHERE s.id = ?'],
    why: 'The query still works for every same-tenant request, so happy-path tests pass. But an instructor at one organization can now read another organization’s lab by id.' },
  { key: 'skipOwnershipCheck', title: 'Drop the owner check when stopping a lab', file: 'server.js · POST /sessions/:id/stop',
    diff: ['- loadSession(ctx, id, { enforceOwner: true })', '+ loadSession(ctx, id, { enforceOwner: false })'],
    why: 'The route is behind authentication, so it looks protected. Authentication is not ownership: any learner could end a classmate’s lab mid-assessment.' },
  { key: 'skipCreditCheck', title: 'Extend without checking the credit balance', file: 'server.js · POST /sessions/:id/extend',
    diff: ['- if (balance < cost) throw 402', '+ // balance checked at launch already'],
    why: 'The comment sounds reasonable, but the balance changes after launch. Organizations can overspend their prepaid credits.' },
  { key: 'offByOneExtensions', title: 'Use > instead of >= for the extension limit', file: 'server.js · POST /sessions/:id/extend',
    diff: ['- if (s.extensions >= MAX_EXTENSIONS)', '+ if (s.extensions > MAX_EXTENSIONS)'],
    why: 'A boundary bug. It allows a third extension, and only a test that hits the limit exactly will notice.' },
  { key: 'idempotencyIgnored', title: 'Ignore the Idempotency-Key header', file: 'server.js · POST /sessions',
    diff: ['- const prior = findByIdempotencyKey(key)', '+ // unique index already blocks duplicates'],
    why: 'The index does block a duplicate session, but a client that retries after a timeout now gets 409 instead of the lab it launched, and shows an error for a request that worked.' },
  { key: 'loginEnumeration', title: 'Tell users when an email has no account', file: 'server.js · POST /auth/login',
    diff: ['- "Email or password is incorrect"', '+ user ? "Wrong password" : "No account exists with that email"'],
    why: 'It reads as friendlier UX, but different messages let anyone check which emails have accounts.' },
  { key: 'noRateLimit', title: 'Remove the sign-in rate limiter', file: 'server.js · POST /auth/login',
    diff: ['- if (recent.length >= LOGIN_MAX_FAILURES) throw 429', '+'],
    why: 'It simplifies the handler, and nothing in the UI breaks. It also allows unlimited password guessing.' },
  { key: 'noOutputEscaping', title: 'Render lab titles without escaping', file: 'ui.js · labCard()',
    diff: ['- html`<h3>${lab.title}</h3>`   // tagged: escapes', '+ `<h3>${lab.title}</h3>`       // plain string'],
    why: 'Instructors can name labs. An unescaped title becomes stored XSS that runs in every assigned learner’s browser.' },
];

class AssertionError extends Error {}
function fmtVal(v) { if (v && typeof v === 'object' && v.nodeType === 1) return `<${v.tagName.toLowerCase()}> element`; try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); } catch (_) { return String(v); } }
function expect(actual) {
  const fail = (m) => { throw new AssertionError(m); };
  return {
    toBe: (e) => { if (!Object.is(actual, e)) fail(`Expected ${fmtVal(e)}, received ${fmtVal(actual)}`); },
    toEqual: (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) fail(`Expected ${fmtVal(e)}, received ${fmtVal(actual)}`); },
    toBeTruthy: () => { if (!actual) fail(`Expected a truthy value, received ${fmtVal(actual)}`); },
    toBeFalsy: () => { if (actual) fail(`Expected a falsy value, received ${fmtVal(actual)}`); },
    toBeNull: () => { if (actual !== null) fail(`Expected null, received ${fmtVal(actual)}`); },
    toContain: (x) => { if (!actual || !actual.includes(x)) fail(`Expected ${fmtVal(actual)} to contain ${fmtVal(x)}`); },
    toMatch: (re) => { if (!re.test(String(actual))) fail(`Expected ${fmtVal(actual)} to match ${re}`); },
    toBeGreaterThan: (n) => { if (!(actual > n)) fail(`Expected ${fmtVal(actual)} to be greater than ${n}`); },
    toHaveStatus: (code) => {
      if (!actual || actual.status !== code) fail(`Expected HTTP ${code}, received ${actual && actual.status}${actual && actual.body && actual.body.code ? ` (${actual.body.code})` : ''}`);
    },
    toThrow: (re) => {
      let threw = null;
      try { actual(); } catch (e) { threw = e; }
      if (!threw) fail('Expected the call to throw');
      if (re && !re.test(threw.message)) fail(`Expected error matching ${re}, received "${threw.message}"`);
    },
  };
}

const FIXTURE_T0 = Date.UTC(2026, 9, 14, 9, 0, 0);
const fixtureCache = { SQL: null, bytes: null, fx: null };
async function makeEnv(SQL, { faults = {}, rng = () => 0.99 } = {}) {
  if (fixtureCache.SQL !== SQL) { // migrate + seed once, then clone the file for each test
    const raw0 = new SQL.Database();
    const db0 = wrapDb(raw0);
    migrate(db0, FIXTURE_T0);
    fixtureCache.fx = await seedFixture(db0, FIXTURE_T0, 1000);
    fixtureCache.bytes = raw0.export();
    fixtureCache.SQL = SQL;
    raw0.close();
  }
  const raw = new SQL.Database(fixtureCache.bytes);
  raw.exec('PRAGMA foreign_keys = ON');
  const db = wrapDb(raw);
  const clock = fakeClock(FIXTURE_T0);
  const fx = fixtureCache.fx;
  const server = createServer({ db, clock, rng, faults, iterations: 1000 });
  const call = (method, path, { token, body, headers } = {}) => server.handle({
    method, path,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const tokens = {};
  const login = async (email) => {
    if (tokens[email]) return tokens[email];
    const r = await call('POST', '/api/auth/login', { body: { email, password: FIXTURE_PASSWORD } });
    if (r.status !== 200) throw new AssertionError(`Fixture login failed for ${email}: ${r.status}`);
    return (tokens[email] = r.body.token);
  };
  /** Runs the worker until the queue is empty, moving the fake clock to each job's run time. */
  const drain = () => {
    for (let i = 0; i < 200; i++) {
      server.worker.tick();
      const next = db.val("SELECT MIN(run_at) FROM jobs WHERE status = 'queued'");
      if (next == null) return;
      if (next > clock.now()) clock.set(next);
    }
    throw new AssertionError('Worker did not settle after 200 ticks');
  };
  const launch = async (email, templateId, headers) => {
    const r = await call('POST', '/api/sessions', { token: await login(email), body: { templateId }, headers });
    return r;
  };
  const launchReady = async (email, templateId) => {
    const r = await launch(email, templateId);
    if (r.status !== 202) throw new AssertionError(`Launch failed: ${r.status} ${r.body && r.body.code}`);
    drain();
    return r.body.id;
  };
  return { db, clock, server, call, login, drain, launch, launchReady, fx, close: () => raw.close() };
}

const TESTS = [];
const test = (suite, id, name, fn, opts = {}) => TESTS.push({ suite, id, name, fn, ...opts });

/* ---------- unit ---------- */
test('Unit', 'U1', 'Passwords are stored as salted PBKDF2 hashes', async () => {
  const a = await Crypto.hashPassword('correct horse', 1000);
  const b = await Crypto.hashPassword('correct horse', 1000);
  expect(a === b).toBe(false);
  expect(a).toMatch(/^pbkdf2\$1000\$/);
  expect(await Crypto.verifyPassword('correct horse', a)).toBe(true);
  expect(await Crypto.verifyPassword('correct horsf', a)).toBe(false);
});
test('Unit', 'U2', 'A token with an edited payload is rejected', async () => {
  const t = await Crypto.signToken('secret-1', { sub: 'u1', role: 'learner', exp: 2e12 });
  const [h, , s] = t.split('.');
  const forged = `${h}.${jsonB64url({ sub: 'u1', role: 'admin', exp: 2e12 })}.${s}`;
  expect(await Crypto.verifyToken('secret-1', t, 1e12)).toBeTruthy();
  expect(await Crypto.verifyToken('secret-1', forged, 1e12)).toBeNull();
});
test('Unit', 'U3', 'An expired token is rejected', async () => {
  const t = await Crypto.signToken('secret-1', { sub: 'u1', exp: 1000 });
  expect(await Crypto.verifyToken('secret-1', t, 999)).toBeTruthy();
  expect(await Crypto.verifyToken('secret-1', t, 1000)).toBeNull();
});
test('Unit', 'U4', 'Launch cost rounds up and refunds round down', async () => {
  expect(creditsFor(45, 8)).toBe(6);
  expect(creditsFor(15, 12)).toBe(3);
  expect(refundFor(20 * 60000, 12)).toBe(4);
  expect(refundFor(60000, 8)).toBe(0);
  expect(refundFor(-5000, 8)).toBe(0);
});
test('Unit', 'U5', 'Unknown body fields are rejected, blocking mass assignment', async () => {
  let err = null;
  try { validate({ templateId: 'lab_1', tenantId: 'tnt_other' }, { templateId: V.string({ min: 1 }) }); } catch (e) { err = e; }
  expect(err && err.status).toBe(422);
  expect(err.extra.errors.tenantId).toMatch(/not an allowed field/);
});

/* ---------- auth ---------- */
test('API · auth', 'A1', 'Valid credentials return a signed token and no password hash', async (env) => {
  const r = await env.call('POST', '/api/auth/login', { body: { email: 'L1@c.test', password: FIXTURE_PASSWORD } });
  expect(r).toHaveStatus(200);
  expect(r.body.token.split('.').length).toBe(3);
  expect(r.body.user.role).toBe('learner');
  expect(JSON.stringify(r.body).includes('pbkdf2')).toBe(false);
});
test('API · auth', 'A2', 'Wrong password and unknown email return the same 401', async (env) => {
  const wrong = await env.call('POST', '/api/auth/login', { body: { email: 'l1@c.test', password: 'nope' } });
  const unknown = await env.call('POST', '/api/auth/login', { body: { email: 'ghost@c.test', password: 'nope' } });
  expect(wrong).toHaveStatus(401);
  expect(unknown).toHaveStatus(401);
  expect(unknown.body.detail).toBe(wrong.body.detail);
}, { guards: ['loginEnumeration'] });
test('API · auth', 'A3', 'The sixth failed sign-in within a minute gets 429', async (env) => {
  for (let i = 0; i < 5; i++) expect(await env.call('POST', '/api/auth/login', { body: { email: 'l1@c.test', password: 'bad' + i } })).toHaveStatus(401);
  const sixth = await env.call('POST', '/api/auth/login', { body: { email: 'l1@c.test', password: FIXTURE_PASSWORD } });
  expect(sixth).toHaveStatus(429);
  expect(sixth.headers['retry-after']).toBeTruthy();
  env.clock.advance(61000);
  expect(await env.call('POST', '/api/auth/login', { body: { email: 'l1@c.test', password: FIXTURE_PASSWORD } })).toHaveStatus(200);
}, { guards: ['noRateLimit'] });
test('API · auth', 'A4', 'Requests without a token get 401', async (env) => {
  expect(await env.call('GET', '/api/sessions')).toHaveStatus(401);
  expect(await env.call('GET', '/api/sessions', { token: 'not.a.token' })).toHaveStatus(401);
});
test('API · auth', 'A5', 'Learners cannot create lab templates', async (env) => {
  const r = await env.call('POST', '/api/labs', { token: await env.login('l1@c.test'), body: { title: 'x' } });
  expect(r).toHaveStatus(403);
});

/* ---------- tenancy ---------- */
test('API · tenancy', 'B1', 'Learners see only the labs assigned to them', async (env) => {
  const r = await env.call('GET', '/api/labs', { token: await env.login('l1@c.test') });
  expect(r).toHaveStatus(200);
  expect(r.body.items.map((l) => l.id)).toEqual([env.fx.labs.t1]);
});
test('API · tenancy', 'B2', 'Reading another tenant’s session returns 404', async (env) => {
  const fabrikamSession = await env.launchReady('f1@f.test', env.fx.labs.tf);
  const r = await env.call('GET', `/api/sessions/${fabrikamSession}`, { token: await env.login('inst@c.test') });
  expect(r).toHaveStatus(404);
}, { guards: ['skipTenantScope'] });
test('API · tenancy', 'B3', 'A learner cannot read a classmate’s session', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  expect(await env.call('GET', `/api/sessions/${id}`, { token: await env.login('l2@c.test') })).toHaveStatus(404);
  expect(await env.call('GET', `/api/sessions/${id}`, { token: await env.login('l1@c.test') })).toHaveStatus(200);
});
test('API · tenancy', 'B4', 'A learner cannot stop a classmate’s session', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  expect(await env.call('POST', `/api/sessions/${id}/stop`, { token: await env.login('l2@c.test') })).toHaveStatus(404);
  expect(env.db.val('SELECT status FROM lab_sessions WHERE id = ?', [id])).toBe('ready');
}, { guards: ['skipOwnershipCheck'] });
test('API · tenancy', 'B5', 'Assigning a lab to another tenant’s learner is rejected', async (env) => {
  const r = await env.call('POST', `/api/labs/${env.fx.labs.t2}/assignments`, { token: await env.login('inst@c.test'), body: { learnerIds: [env.fx.users.f1] } });
  expect(r).toHaveStatus(422);
  expect(env.db.val('SELECT COUNT(*) FROM assignments WHERE learner_id = ?', [env.fx.users.f1])).toBe(1);
});
test('API · tenancy', 'B6', 'Only the session owner can read lab credentials, and reads are audited', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  const own = await env.call('GET', `/api/sessions/${id}/credentials`, { token: await env.login('l1@c.test') });
  expect(own).toHaveStatus(200);
  expect(own.body.password.length).toBe(14);
  expect(own.headers['cache-control']).toBe('no-store');
  expect(await env.call('GET', `/api/sessions/${id}/credentials`, { token: await env.login('inst@c.test') })).toHaveStatus(403);
  expect(env.db.val("SELECT COUNT(*) FROM audit_log WHERE action = 'credentials.read' AND target = ?", [id])).toBe(1);
});

/* ---------- lifecycle ---------- */
test('API · lab lifecycle', 'C1', 'Launching returns 202 and the worker provisions the lab to ready', async (env) => {
  const r = await env.launch('l1@c.test', env.fx.labs.t1);
  expect(r).toHaveStatus(202);
  expect(r.body.status).toBe('queued');
  env.drain();
  const s = (await env.call('GET', `/api/sessions/${r.body.id}`, { token: await env.login('l1@c.test') })).body;
  expect(s.status).toBe('ready');
  expect(s.expiresAt - s.startedAt).toBe(45 * 60000);
  expect(env.db.val("SELECT delta FROM credit_ledger WHERE session_id = ? AND reason = 'launch'", [r.body.id])).toBe(-6);
});
test('API · lab lifecycle', 'C2', 'Launching a lab that is not assigned is forbidden', async (env) => {
  const r = await env.launch('l1@c.test', env.fx.labs.t2);
  expect(r).toHaveStatus(403);
  expect(r.body.code).toBe('not_assigned');
});
test('API · lab lifecycle', 'C3', 'Retrying a launch with the same Idempotency-Key returns the original session', async (env) => {
  const first = await env.launch('l1@c.test', env.fx.labs.t1, { 'Idempotency-Key': 'retry-123' });
  const retry = await env.launch('l1@c.test', env.fx.labs.t1, { 'Idempotency-Key': 'retry-123' });
  expect(first).toHaveStatus(202);
  expect(retry).toHaveStatus(202);
  expect(retry.body.id).toBe(first.body.id);
  expect(env.db.val("SELECT COUNT(*) FROM credit_ledger WHERE reason = 'launch'")).toBe(1);
}, { guards: ['idempotencyIgnored'] });
test('API · lab lifecycle', 'C4', 'A second launch of a running lab is rejected with 409', async (env) => {
  await env.launch('l1@c.test', env.fx.labs.t1);
  const again = await env.launch('l1@c.test', env.fx.labs.t1);
  expect(again).toHaveStatus(409);
  expect(again.body.sessionId).toBeTruthy();
});
test('API · lab lifecycle', 'C5', 'Provisioning retries a transient Azure error and still succeeds', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  expect(env.db.val('SELECT status FROM lab_sessions WHERE id = ?', [id])).toBe('ready');
  const retried = env.db.get("SELECT attempts, last_error FROM jobs WHERE session_id = ? AND attempts > 1", [id]);
  expect(retried && retried.attempts).toBe(2);
  expect(retried.last_error).toMatch(/429/);
}, { rng: () => 0 });
test('API · lab lifecycle', 'C6', 'Stopping early refunds unused credits and deletes the secret', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  env.clock.advance(15 * 60000);
  const r = await env.call('POST', `/api/sessions/${id}/stop`, { token: await env.login('l1@c.test') });
  expect(r).toHaveStatus(202);
  expect(r.body.refunded).toBe(4);
  env.drain();
  const s = env.db.get('SELECT status, secret_ref FROM lab_sessions WHERE id = ?', [id]);
  expect(s.status).toBe('stopped');
  expect(s.secret_ref).toBeNull();
  expect(env.db.val('SELECT COUNT(*) FROM vault_secrets')).toBe(0);
});
test('API · lab lifecycle', 'C7', 'A lab expires at its time limit and its resources are deleted', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  env.clock.advance(45 * 60000 - 1000);
  env.server.worker.tick();
  expect(env.db.val('SELECT status FROM lab_sessions WHERE id = ?', [id])).toBe('ready');
  env.clock.advance(1000);
  env.drain();
  expect(env.db.val('SELECT status FROM lab_sessions WHERE id = ?', [id])).toBe('expired');
  expect(env.db.val('SELECT COUNT(*) FROM vault_secrets')).toBe(0);
});
test('API · lab lifecycle', 'C8', 'Task checks compare answers with the live session', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  const tok = await env.login('l1@c.test');
  const rg = env.db.val('SELECT resource_group FROM lab_sessions WHERE id = ?', [id]);
  const wrong = await env.call('POST', `/api/sessions/${id}/tasks/t1/validate`, { token: tok, body: { answer: 'rg-lab-wrong' } });
  expect(wrong.body.passed).toBe(false);
  const right = await env.call('POST', `/api/sessions/${id}/tasks/t1/validate`, { token: tok, body: { answer: '  ' + rg.toUpperCase() } });
  expect(right.body.passed).toBe(true);
  expect(right.body.tasksDone).toEqual(['t1']);
});

/* ---------- spec: lab time extension ---------- */
test('Spec · lab extension', 'E1', 'AC-1 · Extending adds exactly 15 minutes to the expiry', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  const before = env.db.val('SELECT expires_at FROM lab_sessions WHERE id = ?', [id]);
  const r = await env.call('POST', `/api/sessions/${id}/extend`, { token: await env.login('l1@c.test') });
  expect(r).toHaveStatus(200);
  expect(r.body.expiresAt - before).toBe(15 * 60000);
  expect(r.body.extensionsLeft).toBe(1);
});
test('Spec · lab extension', 'E2', 'AC-2 · The third extension is rejected with 422', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  const tok = await env.login('l1@c.test');
  expect(await env.call('POST', `/api/sessions/${id}/extend`, { token: tok })).toHaveStatus(200);
  expect(await env.call('POST', `/api/sessions/${id}/extend`, { token: tok })).toHaveStatus(200);
  const third = await env.call('POST', `/api/sessions/${id}/extend`, { token: tok });
  expect(third).toHaveStatus(422);
  expect(third.body.code).toBe('extension_limit');
}, { guards: ['offByOneExtensions'] });
test('Spec · lab extension', 'E3', 'AC-3 · Without enough credits the extension returns 402 and changes nothing', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  const balance = creditBalance(env.db, 'tnt_c');
  ledger(env.db, { tenantId: 'tnt_c', delta: -(balance - 1), reason: 'launch', now: env.clock.now() });
  const before = env.db.get('SELECT expires_at, extensions FROM lab_sessions WHERE id = ?', [id]);
  const r = await env.call('POST', `/api/sessions/${id}/extend`, { token: await env.login('l1@c.test') });
  expect(r).toHaveStatus(402);
  expect(env.db.get('SELECT expires_at, extensions FROM lab_sessions WHERE id = ?', [id])).toEqual(before);
  expect(creditBalance(env.db, 'tnt_c')).toBe(1);
}, { guards: ['skipCreditCheck'] });
test('Spec · lab extension', 'E4', 'AC-4 · Only a running lab can be extended', async (env) => {
  const r = await env.launch('l1@c.test', env.fx.labs.t1);
  const ext = await env.call('POST', `/api/sessions/${r.body.id}/extend`, { token: await env.login('l1@c.test') });
  expect(ext).toHaveStatus(409);
  expect(ext.body.code).toBe('not_running');
});
test('Spec · lab extension', 'E5', 'AC-5 · Classmates and other tenants cannot extend a lab', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  expect(await env.call('POST', `/api/sessions/${id}/extend`, { token: await env.login('l2@c.test') })).toHaveStatus(404);
  expect(await env.call('POST', `/api/sessions/${id}/extend`, { token: await env.login('finst@f.test') })).toHaveStatus(404);
  expect(env.db.val('SELECT extensions FROM lab_sessions WHERE id = ?', [id])).toBe(0);
}, { guards: ['skipTenantScope'] });
test('Spec · lab extension', 'E6', 'AC-6 · Every extension is written to the audit log', async (env) => {
  const id = await env.launchReady('l1@c.test', env.fx.labs.t1);
  await env.call('POST', `/api/sessions/${id}/extend`, { token: await env.login('inst@c.test') });
  const row = env.db.get("SELECT actor_id, detail, request_id FROM audit_log WHERE action = 'session.extended' AND target = ?", [id]);
  expect(row && row.actor_id).toBe(env.fx.users.inst);
  expect(JSON.parse(row.detail).minutes).toBe(15);
  expect(row.request_id).toMatch(/^req_/);
});

/* ---------- database ---------- */
test('Database', 'S1', 'Every tenant-owned table has a tenant_id column', async (env) => {
  const tables = env.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('tenants','settings','schema_migrations')").map((r) => r.name);
  const missing = tables.filter((t) => !env.db.all(`PRAGMA table_info(${t})`).some((c) => c.name === 'tenant_id'));
  expect(missing).toEqual([]);
});
test('Database', 'S2', 'The schema allows one active session per learner and lab', async (env) => {
  const ins = () => env.db.run("INSERT INTO lab_sessions (id, tenant_id, template_id, learner_id, status, resource_group, region, created_at) VALUES (?, 'tnt_c', ?, ?, 'ready', 'rg', 'r', 0)", [newId('ses'), env.fx.labs.t1, env.fx.users.l1]);
  ins();
  expect(ins).toThrow(/UNIQUE/);
});

/* ---------- UI ---------- */
test('UI', 'D1', 'Lab titles render as text, never as HTML', async (env, faults) => {
  const evil = { id: 'lab_x', title: '<img src=x onerror="window.__pwned=1">Intro', summary: '<b>bold</b>', level: 'beginner', durationMin: 30, creditsPerHour: 6, launchCost: 3, resources: ['<script>x</script>'], tasks: [] };
  const markup = withEscaping(faults.noOutputEscaping ? (s) => String(s) : null, () => String(labCard(evil, { mode: 'learner' })));
  const tpl = document.createElement('template'); // inert: nothing in it loads or runs
  tpl.innerHTML = markup;
  expect(tpl.content.querySelector('img, script, b')).toBeNull();
  expect(tpl.content.textContent).toContain('<img src=x');
}, { dom: true, guards: ['noOutputEscaping'], env: false });
test('UI', 'D2', 'Countdown shows hours, minutes and seconds', async () => {
  expect(fmtCountdown(3725000)).toBe('1:02:05');
  expect(fmtCountdown(59000)).toBe('0:59');
  expect(fmtCountdown(-4000)).toBe('0:00');
}, { dom: true, env: false });

/* ---------- runner ---------- */
async function runTests(SQL, { faults = {}, only = null, onResult = () => {}, tick = null } = {}) {
  const hasDom = typeof document !== 'undefined';
  const results = [];
  const t0 = Date.now();
  for (const t of TESTS) {
    if (only && !only.includes(t.id)) continue;
    const r = { id: t.id, suite: t.suite, name: t.name, guards: t.guards || [], status: 'pass', ms: 0, error: null };
    if (t.dom && !hasDom) { r.status = 'skip'; results.push(r); onResult(r); continue; }
    const start = Date.now();
    let env = null;
    try {
      if (t.env !== false) env = await makeEnv(SQL, { faults, rng: t.rng });
      await t.fn(env, faults);
    } catch (e) {
      r.status = 'fail';
      r.error = e instanceof AssertionError ? e.message : `${e.name}: ${e.message}`;
    } finally {
      if (env) env.close();
    }
    r.ms = Date.now() - start;
    results.push(r);
    onResult(r);
    if (tick) await tick();
  }
  return {
    results, ms: Date.now() - t0,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    skipped: results.filter((r) => r.status === 'skip').length,
  };
}

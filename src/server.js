/* =====================================================================
   LabPilot · API server + background worker
   An HTTP-shaped request handler: routing, middleware (auth, roles,
   validation), problem+json errors, tenant scoping, audit, idempotency.
   `faults` exists only so the test suite can inject known-bad changes;
   the live app never passes it.
   ===================================================================== */

class HttpError extends Error {
  constructor(status, code, detail, extra = {}) {
    super(detail);
    this.status = status; this.code = code; this.detail = detail; this.extra = extra;
  }
}
const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized',
  402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
  422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error',
};

/* ---------- request validation ---------- */
const V = {
  string: (o = {}) => (v, f) => {
    if (typeof v !== 'string') return `${f} must be a string`;
    const t = v.trim();
    if (o.min != null && t.length < o.min) return `${f} must be at least ${o.min} characters`;
    if (o.max != null && t.length > o.max) return `${f} must be at most ${o.max} characters`;
    if (o.pattern && !o.pattern.test(t)) return `${f} ${o.message || 'is invalid'}`;
  },
  email: () => V.string({ min: 3, max: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'must be a valid email address' }),
  int: (o = {}) => (v, f) => {
    if (!Number.isInteger(v)) return `${f} must be a whole number`;
    if (o.min != null && v < o.min) return `${f} must be at least ${o.min}`;
    if (o.max != null && v > o.max) return `${f} must be at most ${o.max}`;
  },
  oneOf: (vals) => (v, f) => (vals.includes(v) ? undefined : `${f} must be one of: ${vals.join(', ')}`),
  array: (item, o = {}) => (v, f) => {
    if (!Array.isArray(v)) return `${f} must be a list`;
    if (o.min != null && v.length < o.min) return `${f} needs at least ${o.min} item${o.min === 1 ? '' : 's'}`;
    if (o.max != null && v.length > o.max) return `${f} allows at most ${o.max} items`;
    for (let i = 0; i < v.length; i++) { const e = item(v[i], `${f}[${i}]`); if (e) return e; }
  },
  object: (shape) => (v, f) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${f} must be an object`;
    for (const k of Object.keys(v)) if (!(k in shape)) return `${f}.${k} is not an allowed field`;
    for (const k in shape) { const e = shape[k](v[k], `${f}.${k}`); if (e) return e; }
  },
  optional: (fn) => (v, f) => (v === undefined || v === null ? undefined : fn(v, f)),
};
/** Validates a JSON body against a shape. Unknown fields are rejected, which blocks mass assignment (e.g. a client-sent tenantId). */
function validate(body, shape) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body', 'Request body must be a JSON object');
  const errors = {};
  for (const k of Object.keys(body)) if (!(k in shape)) errors[k] = `${k} is not an allowed field`;
  for (const k in shape) { const e = shape[k](body[k], k); if (e) errors[k] = e; }
  if (Object.keys(errors).length) throw new HttpError(422, 'validation_failed', 'One or more fields are invalid', { errors });
}

const PROVISION_STEPS = [
  { name: 'Creating resource group', ms: [700, 1100] },
  { name: 'Deploying Bicep template', ms: [1500, 2300] },
  { name: 'Creating lab user and RBAC assignment', ms: [800, 1200], flaky: 0.35 },
  { name: 'Applying Azure Policy and budget alert', ms: [600, 900] },
  { name: 'Running health checks', ms: [500, 800] },
];

const SESSION_SELECT = `
  SELECT s.*, t.title AS template_title, t.tasks AS template_tasks, t.credits_per_hour, t.duration_min, t.level,
         u.name AS learner_name, u.email AS learner_email
  FROM lab_sessions s
  JOIN lab_templates t ON t.id = s.template_id
  JOIN users u ON u.id = s.learner_id`;

function presentSession(s) {
  const tasks = JSON.parse(s.template_tasks || '[]').map((t) => ({ id: t.id, title: t.title, hint: t.hint || '', check: t.check }));
  return {
    id: s.id, status: s.status, progress: s.progress, step: s.step,
    templateId: s.template_id, templateTitle: s.template_title, level: s.level,
    learnerId: s.learner_id, learnerName: s.learner_name,
    resourceGroup: s.resource_group, region: s.region, username: s.status === 'ready' ? s.username : null,
    startedAt: s.started_at, expiresAt: s.expires_at, endedAt: s.ended_at, endReason: s.end_reason,
    durationMin: s.duration_min, creditsPerHour: s.credits_per_hour,
    extensions: s.extensions, extensionsLeft: Math.max(0, RULES.MAX_EXTENSIONS - s.extensions),
    extensionCost: creditsFor(RULES.EXTENSION_MIN, s.credits_per_hour),
    creditsCharged: s.credits_charged, tasks, tasksDone: JSON.parse(s.tasks_done || '[]'), createdAt: s.created_at,
  };
}
function presentTemplate(t, extra = {}) {
  return {
    id: t.id, title: t.title, summary: t.summary, level: t.level, durationMin: t.duration_min, creditsPerHour: t.credits_per_hour,
    launchCost: creditsFor(t.duration_min, t.credits_per_hour), resources: JSON.parse(t.resources || '[]'),
    tasks: JSON.parse(t.tasks || '[]').map((k) => ({ id: k.id, title: k.title, hint: k.hint || '', check: k.check })), createdAt: t.created_at, ...extra,
  };
}

function createServer(opts) {
  const { db, clock = systemClock, rng = Math.random, faults = {}, iterations = RULES.PBKDF2_ITERATIONS, onEvent = () => {} } = opts;
  const routes = [];
  const failures = new Map(); // email -> [timestamps] of failed logins
  const tokenSecret = () => db.val("SELECT value FROM settings WHERE key = 'token_secret'");
  const DUMMY_HASH = `pbkdf2$${iterations}$${b64(new Uint8Array(16))}$x`;
  const created = (body) => ({ __status: 201, body });
  const accepted = (body) => ({ __status: 202, body });
  const emit = (e) => { try { onEvent(e); } catch (_) { /* listeners never break the request */ } };

  function route(method, path, meta, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, path, re, keys, meta, handlers });
  }

  /* ----- middleware ----- */
  const authenticate = async (ctx) => {
    const m = /^Bearer\s+(.+)$/i.exec(ctx.headers.authorization || '');
    if (!m) throw new HttpError(401, 'unauthenticated', 'Send a bearer token in the Authorization header');
    const payload = await Crypto.verifyToken(tokenSecret(), m[1].trim(), clock.now());
    if (!payload) throw new HttpError(401, 'invalid_token', 'The token is invalid or has expired');
    // Role and tenant come from the database, not the token, so role changes apply immediately.
    const user = db.get('SELECT id, tenant_id, email, name, role FROM users WHERE id = ?', [payload.sub]);
    if (!user || user.tenant_id !== payload.tid) throw new HttpError(401, 'invalid_token', 'The token’s user no longer exists');
    ctx.user = user;
    ctx.tenantId = user.tenant_id;
  };
  const requireRole = (...allowed) => (ctx) => {
    if (!allowed.includes(ctx.user.role)) throw new HttpError(403, 'forbidden', `This action needs the ${allowed.join(' or ')} role`);
  };
  const body = (shape) => (ctx) => validate(ctx.body, shape);
  const staff = requireRole('instructor', 'admin');

  /** Loads a session the caller may see. Missing, other-tenant and not-yours all return the same 404. */
  function loadSession(ctx, id, { enforceOwner = true } = {}) {
    const s = faults.skipTenantScope
      ? db.get(`${SESSION_SELECT} WHERE s.id = ?`, [id])
      : db.get(`${SESSION_SELECT} WHERE s.id = ? AND s.tenant_id = ?`, [id, ctx.tenantId]);
    if (!s) throw new HttpError(404, 'not_found', 'Lab session not found');
    if (enforceOwner && ctx.user.role === 'learner' && s.learner_id !== ctx.user.id) throw new HttpError(404, 'not_found', 'Lab session not found');
    return s;
  }
  const writeAudit = (ctx, action, target, detail) => audit(db, { tenantId: ctx.tenantId, actorId: ctx.user ? ctx.user.id : null, action, target, detail, requestId: ctx.requestId, now: ctx.now });
  const enqueue = ({ tenantId, type, sessionId, payload, runAt, now }) =>
    db.run('INSERT INTO jobs (tenant_id, type, session_id, payload, status, run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tenantId, type, sessionId, JSON.stringify(payload || {}), 'queued', runAt, now]);

  /* ----- auth ----- */
  route('POST', '/api/auth/login', { summary: 'Exchange email and password for a signed token', auth: false, example: { email: 'ananya@contoso.example', password: 'Labs@2026' } },
    body({ email: V.email(), password: V.string({ min: 1, max: 200 }) }),
    async (ctx) => {
      const email = ctx.body.email.trim().toLowerCase();
      const now = ctx.now;
      const recent = (failures.get(email) || []).filter((t) => now - t < RULES.LOGIN_WINDOW_MS);
      if (!faults.noRateLimit && recent.length >= RULES.LOGIN_MAX_FAILURES) {
        const retry = Math.ceil((RULES.LOGIN_WINDOW_MS - (now - recent[0])) / 1000);
        throw new HttpError(429, 'too_many_attempts', `Too many failed sign-ins. Try again in ${retry} seconds.`, { headers: { 'retry-after': String(retry) } });
      }
      const user = db.get('SELECT * FROM users WHERE email = ?', [email]);
      // Hash even for unknown emails so response time does not reveal which accounts exist.
      const ok = await Crypto.verifyPassword(ctx.body.password, user ? user.password_hash : DUMMY_HASH);
      if (!user || !ok) {
        recent.push(now);
        failures.set(email, recent);
        const detail = faults.loginEnumeration && !user ? 'No account exists with that email' : 'Email or password is incorrect';
        throw new HttpError(401, 'invalid_credentials', detail);
      }
      failures.delete(email);
      const exp = now + RULES.TOKEN_TTL_MS;
      const token = await Crypto.signToken(tokenSecret(), { sub: user.id, tid: user.tenant_id, role: user.role, iat: now, exp });
      ctx.tenantId = user.tenant_id;
      ctx.user = user;
      writeAudit(ctx, 'auth.login', user.id, null);
      return { token, expiresAt: exp, user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenant_id } };
    });

  route('GET', '/api/me', { summary: 'Current user, tenant and credit balance' }, authenticate, (ctx) => {
    const t = db.get('SELECT id, name, slug, region, credit_quota FROM tenants WHERE id = ?', [ctx.tenantId]);
    return {
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.role },
      tenant: { id: t.id, name: t.name, slug: t.slug, region: t.region, creditQuota: t.credit_quota },
      credits: { balance: creditBalance(db, ctx.tenantId) },
    };
  });

  /* ----- lab catalog ----- */
  route('GET', '/api/labs', { summary: 'Labs the caller can see (learners: only assigned labs)' }, authenticate, (ctx) => {
    if (ctx.user.role === 'learner') {
      const rows = db.all(`SELECT t.*, a.due_at,
            (SELECT s.id FROM lab_sessions s WHERE s.template_id = t.id AND s.learner_id = ? AND s.status IN ('queued','provisioning','ready','stopping')) AS active_session_id,
            (SELECT COUNT(*) FROM lab_sessions s WHERE s.template_id = t.id AND s.learner_id = ?) AS attempts
          FROM lab_templates t JOIN assignments a ON a.template_id = t.id
          WHERE a.learner_id = ? AND t.tenant_id = ? ORDER BY t.created_at, t.title`, [ctx.user.id, ctx.user.id, ctx.user.id, ctx.tenantId]);
      return { items: rows.map((r) => presentTemplate(r, { dueAt: r.due_at, activeSessionId: r.active_session_id, attempts: r.attempts })) };
    }
    const rows = db.all(`SELECT t.*,
          (SELECT COUNT(*) FROM assignments a WHERE a.template_id = t.id) AS assigned,
          (SELECT COUNT(*) FROM lab_sessions s WHERE s.template_id = t.id AND s.status IN ('queued','provisioning','ready','stopping')) AS active
        FROM lab_templates t WHERE t.tenant_id = ? ORDER BY t.created_at DESC, t.title`, [ctx.tenantId]);
    const assignees = db.all('SELECT a.template_id, a.learner_id FROM assignments a WHERE a.tenant_id = ?', [ctx.tenantId]);
    return { items: rows.map((r) => presentTemplate(r, { assigned: r.assigned, active: r.active, learnerIds: assignees.filter((a) => a.template_id === r.id).map((a) => a.learner_id) })) };
  });

  route('POST', '/api/labs', {
    summary: 'Create a lab template', roles: ['instructor', 'admin'],
    example: { title: 'Secure an API with Front Door and WAF', summary: 'Put an App Service API behind Azure Front Door and block an injection attempt with a WAF rule.', level: 'intermediate', durationMin: 45, creditsPerHour: 10, resources: ['Front Door Standard', 'App Service'], tasks: [{ title: 'Find the lab resource group', check: 'resource_group' }, { title: 'Block the test payload with a custom WAF rule', check: 'confirm' }] },
  }, authenticate, staff, body({
    title: V.string({ min: 3, max: 80 }),
    summary: V.string({ min: 10, max: 280 }),
    level: V.oneOf(['beginner', 'intermediate', 'advanced']),
    durationMin: V.int({ min: 15, max: 240 }),
    creditsPerHour: V.int({ min: 1, max: 100 }),
    resources: V.array(V.string({ min: 2, max: 60 }), { min: 1, max: 8 }),
    tasks: V.array(V.object({ title: V.string({ min: 3, max: 120 }), hint: V.optional(V.string({ max: 160 })), check: V.oneOf(['resource_group', 'region', 'username', 'confirm']) }), { min: 1, max: 8 }),
  }), (ctx) => {
    const b = ctx.body;
    const id = newId('lab');
    db.tx(() => {
      insertTemplate(db, {
        id, tenantId: ctx.tenantId, title: b.title.trim(), summary: b.summary.trim(), level: b.level, durationMin: b.durationMin, creditsPerHour: b.creditsPerHour,
        resources: b.resources.map((r) => r.trim()), tasks: b.tasks.map((t, i) => ({ id: 't' + (i + 1), title: t.title.trim(), hint: (t.hint || '').trim(), check: t.check })),
        createdBy: ctx.user.id, createdAt: ctx.now,
      });
      writeAudit(ctx, 'lab.created', id, { title: b.title.trim() });
    });
    emit({ type: 'lab', tenantId: ctx.tenantId });
    return created(presentTemplate(db.get('SELECT * FROM lab_templates WHERE id = ?', [id]), { assigned: 0, active: 0, learnerIds: [] }));
  });

  route('POST', '/api/labs/:id/assignments', { summary: 'Assign a lab to learners in your tenant', roles: ['instructor', 'admin'], example: { learnerIds: ['usr_…'] } },
    authenticate, staff, body({ learnerIds: V.array(V.string({ min: 1, max: 40 }), { min: 1, max: 50 }), dueAt: V.optional(V.int({ min: 0 })) }),
    (ctx) => {
      const t = db.get('SELECT id FROM lab_templates WHERE id = ? AND tenant_id = ?', [ctx.params.id, ctx.tenantId]);
      if (!t) throw new HttpError(404, 'not_found', 'Lab not found');
      const ids = [...new Set(ctx.body.learnerIds)];
      const valid = new Set(db.all(`SELECT id FROM users WHERE tenant_id = ? AND role = 'learner' AND id IN (${ids.map(() => '?').join(',')})`, [ctx.tenantId, ...ids]).map((r) => r.id));
      const invalid = ids.filter((i) => !valid.has(i));
      if (invalid.length) throw new HttpError(422, 'validation_failed', 'Some learners are not learners in your organization', { errors: { learnerIds: `Unknown learner ids: ${invalid.join(', ')}` } });
      let added = 0;
      db.tx(() => {
        for (const learnerId of ids) {
          const exists = db.val('SELECT COUNT(*) FROM assignments WHERE template_id = ? AND learner_id = ?', [t.id, learnerId]);
          if (!exists) { insertAssignment(db, { tenantId: ctx.tenantId, templateId: t.id, learnerId, assignedBy: ctx.user.id, dueAt: ctx.body.dueAt, createdAt: ctx.now }); added++; }
        }
        if (added) writeAudit(ctx, 'assignment.created', t.id, { learners: added });
      });
      emit({ type: 'lab', tenantId: ctx.tenantId });
      return created({ assigned: added, alreadyAssigned: ids.length - added });
    });

  /* ----- lab sessions ----- */
  route('GET', '/api/sessions', { summary: 'Lab sessions (learners: their own; staff: whole tenant). ?scope=active|ended|all' }, authenticate, (ctx) => {
    const scope = ctx.query.scope || 'all';
    const where = ['s.tenant_id = ?'];
    const params = [ctx.tenantId];
    if (ctx.user.role === 'learner') { where.push('s.learner_id = ?'); params.push(ctx.user.id); }
    if (scope === 'active') where.push("s.status IN ('queued','provisioning','ready','stopping')");
    else if (scope === 'ended') where.push("s.status IN ('stopped','expired','failed')");
    const rows = db.all(`${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT 100`, params);
    return { items: rows.map(presentSession), serverTime: ctx.now };
  });

  route('POST', '/api/sessions', { summary: 'Launch a lab (send an Idempotency-Key header so retries are safe)', roles: ['learner'], example: { templateId: 'lab_…' }, headers: { 'Idempotency-Key': '(any unique string)' } },
    authenticate, requireRole('learner'), body({ templateId: V.string({ min: 1, max: 40 }) }),
    (ctx) => {
      const key = (ctx.headers['idempotency-key'] || '').trim().slice(0, 100) || null;
      if (key && !faults.idempotencyIgnored) {
        const prior = db.get(`${SESSION_SELECT} WHERE s.learner_id = ? AND s.idempotency_key = ?`, [ctx.user.id, key]);
        if (prior) { ctx.res.headers['idempotent-replay'] = 'true'; return accepted(presentSession(prior)); }
      }
      const t = db.get('SELECT * FROM lab_templates WHERE id = ? AND tenant_id = ?', [ctx.body.templateId, ctx.tenantId]);
      if (!t) throw new HttpError(404, 'not_found', 'Lab not found');
      if (!db.val('SELECT COUNT(*) FROM assignments WHERE template_id = ? AND learner_id = ?', [t.id, ctx.user.id])) throw new HttpError(403, 'not_assigned', 'This lab has not been assigned to you');
      const active = db.val(`SELECT id FROM lab_sessions WHERE learner_id = ? AND template_id = ? AND status IN ('queued','provisioning','ready','stopping')`, [ctx.user.id, t.id]);
      if (active) throw new HttpError(409, 'session_active', 'You already have this lab running', { data: { sessionId: active } });
      const cost = creditsFor(t.duration_min, t.credits_per_hour);
      const balance = creditBalance(db, ctx.tenantId);
      if (balance < cost) throw new HttpError(402, 'insufficient_credits', `Launching needs ${cost} credits; your organization has ${balance}`);
      const tenant = db.get('SELECT region FROM tenants WHERE id = ?', [ctx.tenantId]);
      const id = newId('ses');
      db.tx(() => {
        db.run(`INSERT INTO lab_sessions (id, tenant_id, template_id, learner_id, status, progress, step, resource_group, region, credits_charged, idempotency_key, created_at)
                VALUES (?, ?, ?, ?, 'queued', 0, 'Waiting for a worker', ?, ?, ?, ?, ?)`,
          [id, ctx.tenantId, t.id, ctx.user.id, 'rg-lab-' + shortId(6), tenant.region, cost, key, ctx.now]);
        ledger(db, { tenantId: ctx.tenantId, sessionId: id, delta: -cost, reason: 'launch', now: ctx.now });
        enqueue({ tenantId: ctx.tenantId, type: 'provision', sessionId: id, payload: { step: 0 }, runAt: ctx.now + 400, now: ctx.now });
        writeAudit(ctx, 'session.launched', id, { template: t.id, credits: cost });
      });
      emit({ type: 'session', tenantId: ctx.tenantId, sessionId: id });
      return accepted(presentSession(db.get(`${SESSION_SELECT} WHERE s.id = ?`, [id])));
    });

  route('GET', '/api/sessions/:id', { summary: 'One lab session, with its provisioning jobs' }, authenticate, (ctx) => {
    const s = loadSession(ctx, ctx.params.id);
    const jobs = db.all('SELECT id, type, status, attempts, last_error, payload, run_at, finished_at FROM jobs WHERE session_id = ? ORDER BY id', [s.id]);
    return { ...presentSession(s), jobs: jobs.map((j) => ({ id: j.id, type: j.type, status: j.status, attempts: j.attempts, lastError: j.last_error, step: JSON.parse(j.payload).step, runAt: j.run_at, finishedAt: j.finished_at })), serverTime: ctx.now };
  });

  route('GET', '/api/sessions/:id/credentials', { summary: 'Lab sign-in credentials (session owner only; every read is audited)', roles: ['learner'] }, authenticate, (ctx) => {
    const s = loadSession(ctx, ctx.params.id);
    if (s.learner_id !== ctx.user.id) throw new HttpError(403, 'owner_only', 'Only the learner running this lab can see its credentials');
    if (s.status !== 'ready' || !s.secret_ref) throw new HttpError(409, 'not_running', 'Credentials are available once the lab is ready');
    const secret = db.get('SELECT value FROM vault_secrets WHERE ref = ? AND tenant_id = ?', [s.secret_ref, ctx.tenantId]);
    if (!secret) throw new HttpError(409, 'not_running', 'Credentials have been revoked');
    writeAudit(ctx, 'credentials.read', s.id, null);
    ctx.res.headers['cache-control'] = 'no-store';
    return { username: s.username, password: secret.value, resourceGroup: s.resource_group, region: s.region };
  });

  route('POST', '/api/sessions/:id/extend', { summary: `Add ${RULES.EXTENSION_MIN} minutes (max ${RULES.MAX_EXTENSIONS} per session; costs credits)`, example: {} },
    authenticate, (ctx) => {
      const s = loadSession(ctx, ctx.params.id);
      if (s.status !== 'ready') throw new HttpError(409, 'not_running', 'Only a running lab can be extended');
      const atLimit = faults.offByOneExtensions ? s.extensions > RULES.MAX_EXTENSIONS : s.extensions >= RULES.MAX_EXTENSIONS;
      if (atLimit) throw new HttpError(422, 'extension_limit', `A lab can be extended at most ${RULES.MAX_EXTENSIONS} times`);
      const cost = creditsFor(RULES.EXTENSION_MIN, s.credits_per_hour);
      const balance = creditBalance(db, ctx.tenantId);
      if (!faults.skipCreditCheck && balance < cost) throw new HttpError(402, 'insufficient_credits', `Extending needs ${cost} credits; your organization has ${balance}`);
      const newExpiry = s.expires_at + RULES.EXTENSION_MIN * 60000;
      db.tx(() => {
        db.run("UPDATE lab_sessions SET expires_at = ?, extensions = extensions + 1, credits_charged = credits_charged + ? WHERE id = ? AND status = 'ready'", [newExpiry, cost, s.id]);
        ledger(db, { tenantId: ctx.tenantId, sessionId: s.id, delta: -cost, reason: 'extension', now: ctx.now });
        writeAudit(ctx, 'session.extended', s.id, { minutes: RULES.EXTENSION_MIN, credits: cost, expiresAt: newExpiry });
      });
      emit({ type: 'session', tenantId: ctx.tenantId, sessionId: s.id });
      return presentSession(db.get(`${SESSION_SELECT} WHERE s.id = ?`, [s.id]));
    });

  route('POST', '/api/sessions/:id/stop', { summary: 'Stop a lab and delete its resources (unused time is refunded)', example: {} },
    authenticate, (ctx) => {
      const s = loadSession(ctx, ctx.params.id, { enforceOwner: !faults.skipOwnershipCheck });
      if (!['queued', 'provisioning', 'ready'].includes(s.status)) throw new HttpError(409, 'not_running', `The lab is already ${s.status}`);
      const refund = s.status === 'ready' ? Math.min(s.credits_charged, refundFor(s.expires_at - ctx.now, s.credits_per_hour)) : s.credits_charged;
      db.tx(() => {
        db.run("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE session_id = ? AND status = 'queued'", [ctx.now, s.id]);
        db.run("UPDATE lab_sessions SET status = 'stopping', end_reason = ?, step = 'Deleting resource group' WHERE id = ?", [s.status === 'ready' ? 'stopped' : 'cancelled', s.id]);
        if (refund > 0) ledger(db, { tenantId: ctx.tenantId, sessionId: s.id, delta: refund, reason: 'refund', now: ctx.now });
        enqueue({ tenantId: ctx.tenantId, type: 'deprovision', sessionId: s.id, payload: {}, runAt: ctx.now + 1200, now: ctx.now });
        writeAudit(ctx, 'session.stopped', s.id, { refund, by: ctx.user.role });
      });
      emit({ type: 'session', tenantId: ctx.tenantId, sessionId: s.id });
      return accepted({ ...presentSession(db.get(`${SESSION_SELECT} WHERE s.id = ?`, [s.id])), refunded: refund });
    });

  route('POST', '/api/sessions/:id/tasks/:taskId/validate', { summary: 'Check a lab task against the live environment', roles: ['learner'], example: { answer: 'rg-lab-…' } },
    authenticate, requireRole('learner'), body({ answer: V.string({ min: 0, max: 200 }) }),
    (ctx) => {
      const s = loadSession(ctx, ctx.params.id);
      if (s.status !== 'ready') throw new HttpError(409, 'not_running', 'Tasks can be checked while the lab is running');
      const task = JSON.parse(s.template_tasks).find((t) => t.id === ctx.params.taskId);
      if (!task) throw new HttpError(404, 'not_found', 'Task not found');
      const answer = ctx.body.answer.trim().toLowerCase();
      const expected = { resource_group: s.resource_group, region: s.region, username: (s.username || '').toLowerCase(), confirm: 'done' }[task.check];
      const passed = answer === expected;
      const done = new Set(JSON.parse(s.tasks_done));
      if (passed && !done.has(task.id)) {
        done.add(task.id);
        db.tx(() => {
          db.run('UPDATE lab_sessions SET tasks_done = ? WHERE id = ?', [JSON.stringify([...done]), s.id]);
          writeAudit(ctx, 'task.passed', s.id, { task: task.id });
        });
        emit({ type: 'session', tenantId: ctx.tenantId, sessionId: s.id });
      }
      const hints = { resource_group: 'That is not this lab’s resource group.', region: 'That is not the region this lab runs in.', username: 'That is not your lab username.', confirm: 'Send "done" once you have finished the task.' };
      return { passed, message: passed ? 'Check passed' : hints[task.check], tasksDone: [...done], total: JSON.parse(s.template_tasks).length };
    });

  /* ----- people ----- */
  route('GET', '/api/users', { summary: 'People in your organization', roles: ['instructor', 'admin'] }, authenticate, staff, (ctx) => {
    const rows = db.all(`SELECT u.id, u.name, u.email, u.role, u.created_at,
          (SELECT COUNT(*) FROM assignments a WHERE a.learner_id = u.id) AS assigned,
          (SELECT COUNT(*) FROM lab_sessions s WHERE s.learner_id = u.id) AS sessions,
          (SELECT MAX(s.created_at) FROM lab_sessions s WHERE s.learner_id = u.id) AS last_active
        FROM users u WHERE u.tenant_id = ? ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'instructor' THEN 1 ELSE 2 END, u.name`, [ctx.tenantId]);
    return { items: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, createdAt: r.created_at, assigned: r.assigned, sessions: r.sessions, lastActive: r.last_active })) };
  });

  route('POST', '/api/users', { summary: 'Invite a person (returns a one-time temporary password)', roles: ['admin'], example: { name: 'Dev Patel', email: 'dev@contoso.example', role: 'learner' } },
    authenticate, requireRole('admin'), body({ name: V.string({ min: 2, max: 80 }), email: V.email(), role: V.oneOf(['learner', 'instructor', 'admin']) }),
    async (ctx) => {
      const email = ctx.body.email.trim().toLowerCase();
      if (db.val('SELECT COUNT(*) FROM users WHERE email = ?', [email])) throw new HttpError(409, 'email_taken', 'Someone already uses that email address');
      const temp = strongPassword(14);
      const id = newId('usr');
      const hash = await Crypto.hashPassword(temp, iterations);
      db.tx(() => {
        db.run('INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, ctx.tenantId, email, ctx.body.name.trim(), ctx.body.role, hash, ctx.now]);
        writeAudit(ctx, 'user.invited', id, { role: ctx.body.role });
      });
      emit({ type: 'user', tenantId: ctx.tenantId });
      return created({ user: { id, name: ctx.body.name.trim(), email, role: ctx.body.role }, temporaryPassword: temp });
    });

  /* ----- reporting ----- */
  route('GET', '/api/tenant/usage', { summary: 'Credit balance and the last 14 days of usage', roles: ['instructor', 'admin'] }, authenticate, staff, (ctx) => {
    const t = db.get('SELECT credit_quota FROM tenants WHERE id = ?', [ctx.tenantId]);
    const since = ctx.now - 14 * 86400000;
    const rows = db.all("SELECT delta, reason, created_at FROM credit_ledger WHERE tenant_id = ? AND created_at >= ? AND reason <> 'allocation'", [ctx.tenantId, since]);
    const byLab = db.all(`SELECT t.title, COUNT(DISTINCT s.id) AS sessions, COALESCE(SUM(-l.delta), 0) AS credits
        FROM credit_ledger l JOIN lab_sessions s ON s.id = l.session_id JOIN lab_templates t ON t.id = s.template_id
        WHERE l.tenant_id = ? AND l.reason <> 'allocation' GROUP BY t.id ORDER BY credits DESC`, [ctx.tenantId]);
    const counts = db.get(`SELECT
        SUM(CASE WHEN status IN ('queued','provisioning','ready','stopping') THEN 1 ELSE 0 END) AS active,
        COUNT(*) AS total FROM lab_sessions WHERE tenant_id = ?`, [ctx.tenantId]);
    return { quota: t.credit_quota, balance: creditBalance(db, ctx.tenantId), entries: rows.map((r) => ({ delta: r.delta, reason: r.reason, at: r.created_at })), byLab, activeSessions: counts.active || 0, totalSessions: counts.total || 0, serverTime: ctx.now };
  });

  route('GET', '/api/audit', { summary: 'Audit trail for your organization (newest first)', roles: ['admin'] }, authenticate, requireRole('admin'), (ctx) => {
    const limit = Math.min(500, Math.max(1, parseInt(ctx.query.limit || '200', 10) || 200));
    const rows = db.all(`SELECT a.id, a.action, a.target, a.detail, a.request_id, a.created_at, u.name AS actor
        FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.tenant_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`, [ctx.tenantId, limit]);
    return { items: rows.map((r) => ({ id: r.id, action: r.action, target: r.target, detail: r.detail ? JSON.parse(r.detail) : null, requestId: r.request_id, at: r.created_at, actor: r.actor || 'System' })) };
  });

  route('GET', '/api/jobs', { summary: 'Background jobs for your organization', roles: ['admin'] }, authenticate, requireRole('admin'), (ctx) => {
    const rows = db.all(`SELECT j.*, u.name AS learner_name, t.title AS template_title FROM jobs j
        JOIN lab_sessions s ON s.id = j.session_id JOIN users u ON u.id = s.learner_id JOIN lab_templates t ON t.id = s.template_id
        WHERE j.tenant_id = ? ORDER BY j.id DESC LIMIT 100`, [ctx.tenantId]);
    return { items: rows.map((j) => ({ id: j.id, type: j.type, status: j.status, attempts: j.attempts, step: JSON.parse(j.payload).step, lastError: j.last_error, runAt: j.run_at, finishedAt: j.finished_at, sessionId: j.session_id, learner: j.learner_name, lab: j.template_title })), serverTime: ctx.now };
  });

  /* ----- dispatcher ----- */
  async function handle(req) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const requestId = 'req_' + shortId(8);
    const res = { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': requestId }, body: null };
    const trace = [];
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) headers[k.toLowerCase()] = String(v);
    let path = req.path, query = {};
    const qi = path.indexOf('?');
    if (qi >= 0) { query = Object.fromEntries(new URLSearchParams(path.slice(qi + 1))); path = path.slice(0, qi); }
    let matched = null;
    try {
      let parsed = null;
      if (req.body != null && req.body !== '') {
        try { parsed = JSON.parse(req.body); } catch (_) { throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON'); }
      }
      const candidates = routes.filter((r) => r.re.test(path));
      matched = candidates.find((r) => r.method === req.method);
      if (!matched) {
        if (candidates.length) throw new HttpError(405, 'method_not_allowed', `${req.method} is not supported here. Try ${candidates.map((c) => c.method).join(', ')}.`, { headers: { allow: candidates.map((c) => c.method).join(', ') } });
        throw new HttpError(404, 'route_not_found', `No route matches ${req.method} ${path}`);
      }
      const m = matched.re.exec(path);
      const ctx = { method: req.method, path, query, params: {}, headers, body: parsed, requestId, now: clock.now(), user: null, tenantId: null, res };
      matched.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
      for (const h of matched.handlers) {
        db.trace = trace;
        const out = await h(ctx);
        if (out !== undefined) {
          if (out && out.__status) { res.status = out.__status; res.body = out.body; } else res.body = out;
          break;
        }
      }
    } catch (e) {
      if (e instanceof HttpError) {
        res.status = e.status;
        res.headers['content-type'] = 'application/problem+json';
        if (e.extra.headers) Object.assign(res.headers, e.extra.headers);
        res.body = { type: 'about:blank', title: STATUS_TEXT[e.status] || 'Error', status: e.status, code: e.code, detail: e.detail, ...(e.extra.errors ? { errors: e.extra.errors } : {}), ...(e.extra.data || {}), requestId };
      } else {
        if (typeof console !== 'undefined') console.error('[labpilot] unhandled', e);
        res.status = 500;
        res.headers['content-type'] = 'application/problem+json';
        res.body = { type: 'about:blank', title: 'Internal Server Error', status: 500, code: 'internal_error', detail: 'Something went wrong on our side. Quote the requestId if you report it.', requestId };
      }
    } finally {
      db.trace = null;
    }
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    // Serialize across the boundary so the client never shares object references with the server.
    return JSON.parse(JSON.stringify({ ...res, route: matched ? `${matched.method} ${matched.path}` : null, serverMs: Math.round(ms * 100) / 100, sql: trace }));
  }

  const worker = createWorker({ db, clock, rng, onEvent: emit });
  return {
    handle, worker,
    routes: routes.map((r) => ({ method: r.method, path: r.path, keys: r.keys, ...r.meta })),
  };
}

/* ---------- background worker ----------
   Polls the jobs table. Jobs are claimed with a guarded UPDATE, retried with
   exponential backoff on transient errors, and fail the session (with a full
   refund) when retries run out. */
function createWorker({ db, clock, rng = Math.random, onEvent = () => {} }) {
  const N = PROVISION_STEPS.length;
  const between = ([a, b]) => Math.round(a + rng() * (b - a));
  const enqueue = (j) => db.run('INSERT INTO jobs (tenant_id, type, session_id, payload, status, run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [j.tenantId, j.type, j.sessionId, JSON.stringify(j.payload || {}), 'queued', j.runAt, j.now]);

  const handlers = {
    provision(job, payload, now, attempt) {
      const s = db.get('SELECT s.*, t.duration_min FROM lab_sessions s JOIN lab_templates t ON t.id = s.template_id WHERE s.id = ?', [job.session_id]);
      if (!s || !['queued', 'provisioning'].includes(s.status)) return; // stopped while queued
      const k = payload.step;
      const finished = PROVISION_STEPS[k - 1];
      if (finished && finished.flaky && attempt === 1 && rng() < finished.flaky) {
        const e = new Error(`ARM returned 429 TooManyRequests during "${finished.name}"`);
        e.transient = true;
        throw e;
      }
      if (k < N) {
        db.run("UPDATE lab_sessions SET status = 'provisioning', progress = ?, step = ? WHERE id = ?", [Math.round((k / N) * 100), PROVISION_STEPS[k].name, s.id]);
        enqueue({ tenantId: s.tenant_id, type: 'provision', sessionId: s.id, payload: { step: k + 1 }, runAt: now + between(PROVISION_STEPS[k].ms), now });
        return;
      }
      const slug = db.val('SELECT slug FROM tenants WHERE id = ?', [s.tenant_id]);
      const ref = `kv://${slug}/lab-${s.id}`;
      db.run('INSERT OR REPLACE INTO vault_secrets (ref, tenant_id, value, created_at) VALUES (?, ?, ?, ?)', [ref, s.tenant_id, strongPassword(), now]);
      db.run("UPDATE lab_sessions SET status = 'ready', progress = 100, step = 'Ready', username = ?, secret_ref = ?, started_at = ?, expires_at = ? WHERE id = ?",
        [`labuser-${shortId(5)}@${slug}-labs.example`, ref, now, now + s.duration_min * 60000, s.id]);
      audit(db, { tenantId: s.tenant_id, action: 'session.ready', target: s.id, now });
    },
    deprovision(job, payload, now) {
      const s = db.get('SELECT * FROM lab_sessions WHERE id = ?', [job.session_id]);
      if (!s || s.status !== 'stopping') return;
      if (s.secret_ref) db.run('DELETE FROM vault_secrets WHERE ref = ?', [s.secret_ref]);
      const final = s.end_reason === 'expired' ? 'expired' : 'stopped';
      db.run("UPDATE lab_sessions SET status = ?, ended_at = ?, step = 'Resources deleted', progress = 0, secret_ref = NULL WHERE id = ?", [final, now, s.id]);
      audit(db, { tenantId: s.tenant_id, action: 'session.deprovisioned', target: s.id, detail: { outcome: final }, now });
    },
  };

  function failSession(sessionId, message, now) {
    const s = db.get('SELECT * FROM lab_sessions WHERE id = ?', [sessionId]);
    if (!s || !['queued', 'provisioning'].includes(s.status)) return;
    if (s.secret_ref) db.run('DELETE FROM vault_secrets WHERE ref = ?', [s.secret_ref]);
    db.run("UPDATE lab_sessions SET status = 'failed', end_reason = 'failed', step = ?, ended_at = ?, secret_ref = NULL WHERE id = ?", [message.slice(0, 200), now, s.id]);
    if (s.credits_charged > 0) ledger(db, { tenantId: s.tenant_id, sessionId: s.id, delta: s.credits_charged, reason: 'refund', now });
    audit(db, { tenantId: s.tenant_id, action: 'session.failed', target: s.id, detail: { error: message }, now });
  }

  function runJob(job, now) {
    const claimed = db.run("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'queued'", [job.id]);
    if (!claimed) return false;
    const attempt = job.attempts + 1;
    try {
      db.tx(() => handlers[job.type](job, JSON.parse(job.payload), now, attempt));
      db.run("UPDATE jobs SET status = 'done', finished_at = ?, last_error = CASE WHEN attempts > 1 THEN last_error ELSE NULL END WHERE id = ?", [now, job.id]);
    } catch (e) {
      if (e.transient && attempt < 3) {
        db.run("UPDATE jobs SET status = 'queued', run_at = ?, last_error = ? WHERE id = ?", [now + 800 * 2 ** (attempt - 1), e.message, job.id]);
      } else {
        db.tx(() => {
          db.run("UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ? WHERE id = ?", [e.message, now, job.id]);
          failSession(job.session_id, e.message, now);
        });
      }
    }
    onEvent({ type: 'job', tenantId: job.tenant_id, sessionId: job.session_id });
    return true;
  }

  function tick() {
    const prev = db.trace;
    db.trace = null; // worker SQL never shows up in a request's trace
    try {
      const now = clock.now();
      let work = 0;
      const expired = db.all("SELECT id, tenant_id FROM lab_sessions WHERE status = 'ready' AND expires_at <= ?", [now]);
      for (const s of expired) {
        db.tx(() => {
          db.run("UPDATE lab_sessions SET status = 'stopping', end_reason = 'expired', step = 'Time limit reached, deleting resources' WHERE id = ? AND status = 'ready'", [s.id]);
          enqueue({ tenantId: s.tenant_id, type: 'deprovision', sessionId: s.id, runAt: now + 1000, now });
          audit(db, { tenantId: s.tenant_id, action: 'session.expired', target: s.id, now });
        });
        onEvent({ type: 'session', tenantId: s.tenant_id, sessionId: s.id });
        work++;
      }
      const due = db.all("SELECT * FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT 10", [now]);
      for (const job of due) if (runJob(job, now)) work++;
      return work;
    } finally {
      db.trace = prev;
    }
  }

  const stats = () => db.get("SELECT SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM jobs");
  return { tick, stats, steps: PROVISION_STEPS };
}

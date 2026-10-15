/* =====================================================================
   LabPilot · actions, forms and boot
   ===================================================================== */

async function signIn(email, password, btn) {
  return withBusy(btn, async () => {
    const res = await client.request('POST', '/api/auth/login', { body: { email, password }, auth: 'none' });
    if (res.status !== 200) { S.ui.loginError = res.body; renderMain(); return; }
    S.token = res.body.token;
    store.set(TOKEN_KEY, S.token);
    const me = await client.request('GET', '/api/me');
    S.me = me.body;
    S.ui = freshUi();
    S.apiX.form = null; S.apiX.res = null; S.apiX.preset = null;
    renderTopbar();
    toast(`Signed in as ${S.me.user.name}`, 'ok', `${ROLE_LABEL[S.me.user.role]} · ${S.me.tenant.name}`);
    await go(HOME[S.me.user.role]);
  });
}
function sessionEnded() {
  S.token = null; S.me = null; store.del(TOKEN_KEY);
  renderTopbar();
  toast('You were signed out', 'warn', 'The token was rejected. Sign in again.');
  go('signin');
}
function confirmTwice(key, el) {
  if (S.ui.confirm === key) { S.ui.confirm = null; return true; }
  S.ui.confirm = key;
  renderMain();
  clearTimeout(confirmTwice.t);
  confirmTwice.t = setTimeout(() => { if (S.ui.confirm === key) { S.ui.confirm = null; renderMain(); } }, 5000);
  return false;
}

const ACT = {
  nav: (el) => go(el.dataset.view, el.dataset.id ? { id: el.dataset.id } : {}),
  home: () => go(S.me ? HOME[S.me.user.role] : 'signin'),
  demoLogin: (el) => signIn(el.dataset.email, DEMO_PASSWORD, el),
  signout: () => {
    S.token = null; S.me = null; S.ui = freshUi(); S.apiX.form = null; S.apiX.res = null;
    store.del(TOKEN_KEY);
    renderTopbar();
    toast('Signed out', 'ok', 'Pick another demo account to see a different role.');
    go('signin');
  },
  launch: (el) => withBusy(el, async () => {
    const key = (crypto.randomUUID ? crypto.randomUUID() : shortId(16));
    const s = await api('POST', '/api/sessions', { templateId: el.dataset.id }, { headers: { 'Idempotency-Key': key } });
    toast('Lab launched', 'ok', `${s.creditsCharged} credits reserved. The worker is provisioning it now.`);
    await go('session', { id: s.id });
  }),
  extend: (el) => withBusy(el, async () => {
    const s = await api('POST', `/api/sessions/${el.dataset.id}/extend`, {});
    toast('Added 15 minutes', 'ok', `Now ends at ${fmt.hm(s.expiresAt)} · ${s.extensionCost} credits · ${s.extensionsLeft} extension${s.extensionsLeft === 1 ? '' : 's'} left`);
    refresh(); refreshMe();
  }),
  stop: (el) => {
    if (!confirmTwice('stop:' + el.dataset.id, el)) return;
    return withBusy(el, async () => {
      const s = await api('POST', `/api/sessions/${el.dataset.id}/stop`, {});
      toast('Lab stopping', 'ok', s.refunded ? `${s.refunded} unused credits refunded. Resources are being deleted.` : 'Resources are being deleted.');
      refresh(); refreshMe();
    });
  },
  cancelConfirm: () => { S.ui.confirm = null; renderMain(); },
  reveal: (el) => withBusy(el, async () => {
    S.ui.revealed[el.dataset.id] = await api('GET', `/api/sessions/${el.dataset.id}/credentials`);
    renderMain();
  }),
  hideSecret: (el) => { delete S.ui.revealed[el.dataset.id]; renderMain(); },
  copy: (el) => copyText(el.dataset.copy),
  checkTask: (el) => withBusy(el, async () => {
    const { id, task } = el.dataset;
    const input = document.getElementById(`ans-${id}-${task}`);
    const answer = el.dataset.check === 'confirm' ? 'done' : input ? input.value : '';
    const r = await api('POST', `/api/sessions/${id}/tasks/${task}/validate`, { answer });
    S.ui.taskMsg[id + ':' + task] = r.passed ? null : r.message;
    if (r.passed) toast('Task passed', 'ok', `${r.tasksDone.length} of ${r.total} done`);
    if (input && r.passed) input.value = '';
    await load(S.seq, true);
  }),
  toggleNewLab: () => { S.ui.newLabOpen = !S.ui.newLabOpen; S.ui.newLabErrors = null; S.ui.newLabTasks = 2; S.skipRestore = true; renderMain(); },
  addTask: () => { S.ui.newLabTasks = Math.min(8, S.ui.newLabTasks + 1); renderMain(); const el = document.getElementById(`nl-task-${S.ui.newLabTasks - 1}`); if (el) el.focus(); },
  assignOpen: (el) => { S.ui.assignFor = el.dataset.id; renderMain(); const p = $('#assign-panel'); if (p) p.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
  assignClose: () => { S.ui.assignFor = null; renderMain(); },
  toggleNet: () => { S.netOpen = !S.netOpen; S.netUnseen = 0; renderNet(); },
  netSel: (el) => { S.netSel = Number(el.dataset.id); renderNet(); },
  netTab: (el) => { S.netTab = el.dataset.tab; renderNet(); },
  netClear: () => { S.net = []; S.netSel = null; renderNet(); },
  auditFilter: (el) => { S.ui.auditFilter = el.dataset.f; renderMain(); },
  runTests: () => runTestsUI(),
  runMutation: () => runMutationUI(),
  apiPick: (el) => {
    const r = LIVE.server.routes.find((q) => `${q.method} ${q.path}` === el.dataset.key);
    S.apiX.sel = el.dataset.key;
    S.apiX.form = { ...fillRoute(r), auth: r.auth === false ? 'none' : S.me ? 'user' : 'none' };
    S.apiX.preset = null;
    S.skipRestore = true;
    renderMain();
  },
  apiPreset: async (el) => {
    const i = Number(el.dataset.i);
    const p = PRESETS[i];
    const f = p.make(devLookup());
    S.apiX.form = { ...f, idem: '', auth: f.auth === 'user' && !S.me ? 'none' : f.auth };
    S.apiX.sel = null;
    S.apiX.preset = i;
    S.skipRestore = true;
    renderMain();
    await apiSend($('form[data-form="apiSend"] [type=submit]'));
  },
  dbTable: (el) => dbRun(`SELECT * FROM ${el.dataset.t}\nORDER BY rowid DESC\nLIMIT 50`),
  dbSample: (el) => dbRun(SAMPLE_SQL[Number(el.dataset.i)][1]),
  resetDemo: async (el) => {
    if (!confirmTwice('reset', el)) return;
    await withBusy(el, async () => {
      store.del(STORE_KEY); store.del(TOKEN_KEY);
      S.token = null; S.me = null; S.ui = freshUi(); S.apiX = { sel: null, res: null, sending: false, preset: null }; S.dbx = { sql: '', result: null, error: null };
      await openDatabase({ fresh: true });
      renderTopbar();
      toast('Demo data reset', 'ok', 'Fresh organizations, labs and sessions were seeded.');
      go('signin');
    });
  },
};

const FORMS = {
  login: (form) => signIn($('#li-email').value.trim(), $('#li-pass').value, form.querySelector('[type=submit]')),
  newLab: (form) => withBusy(form.querySelector('[type=submit]'), async () => {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const tasks = [];
    for (let i = 0; i < S.ui.newLabTasks; i++) { const title = val(`nl-task-${i}`).trim(); if (title) tasks.push({ title, check: val(`nl-check-${i}`) }); }
    const body = {
      title: val('nl-title'), summary: val('nl-summary'), level: val('nl-level'),
      durationMin: Number(val('nl-duration')), creditsPerHour: Number(val('nl-cph')),
      resources: val('nl-resources').split(',').map((s) => s.trim()).filter(Boolean), tasks,
    };
    const res = await client.request('POST', '/api/labs', { body });
    if (res.status === 422) { S.ui.newLabErrors = res.body.errors || {}; renderMain(); return; }
    if (res.status >= 400) throw new ApiError(res);
    S.ui.newLabOpen = false; S.ui.newLabErrors = null; S.skipRestore = true;
    toast('Lab created', 'ok', `“${res.body.title}” is in the catalog. Assign it to learners next.`);
    S.ui.assignFor = res.body.id;
    await load(S.seq, true);
  }),
  assign: (form) => withBusy(form.querySelector('[type=submit]'), async () => {
    const ids = $$('input[type=checkbox]', form).filter((c) => c.checked && !c.disabled).map((c) => c.value);
    if (!ids.length) { toast('Pick at least one learner', 'warn', 'Learners who already have the lab are greyed out.'); return; }
    const due = $('#as-due', form).value;
    const body = { learnerIds: ids, ...(due ? { dueAt: new Date(due + 'T23:59:00').getTime() } : {}) };
    const r = await api('POST', `/api/labs/${form.dataset.id}/assignments`, body);
    toast(`Assigned to ${r.assigned} learner${r.assigned === 1 ? '' : 's'}`, 'ok', 'It shows up in their labs immediately.');
    S.ui.assignFor = null; S.skipRestore = true;
    await load(S.seq, true);
  }),
  invite: (form) => withBusy(form.querySelector('[type=submit]'), async () => {
    const body = { name: $('#iv-name').value, email: $('#iv-email').value, role: $('#iv-role').value };
    const res = await client.request('POST', '/api/users', { body });
    if (res.status === 422 || res.status === 409) { S.ui.inviteErrors = res.body.errors || { email: res.body.detail }; S.ui.invited = null; renderMain(); return; }
    if (res.status >= 400) throw new ApiError(res);
    S.ui.invited = res.body; S.ui.inviteErrors = null; S.skipRestore = true;
    toast('Invite created', 'ok', `${res.body.user.name} · ${ROLE_LABEL[res.body.user.role]}`);
    await load(S.seq, true);
  }),
  apiSend: (form) => apiSend(form.querySelector('[type=submit]')),
  dbRun: () => dbRun($('#db-sql').value),
};

const CHANGE = {
  netBg: (el) => { S.netShowBg = el.checked; renderNet(); },
  toggleFault: (el) => { S.tests.faults[el.dataset.key] = el.checked; renderMain(); },
};

function bindEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = ACT[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    fn(el, e);
  });
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const fn = FORMS[form.dataset.form];
    if (fn) fn(form);
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-change]');
    if (el && CHANGE[el.dataset.change]) CHANGE[el.dataset.change](el);
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === 'Enter' && t.dataset && t.dataset.enter) {
      e.preventDefault();
      const btn = t.parentElement.querySelector('[data-act]');
      if (btn) btn.click();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && t.dataset && t.dataset.enterMod) {
      e.preventDefault();
      t.form && t.form.requestSubmit();
    }
  });
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { const v = VIEWS[S.view]; if (v && v.after && S.data && !S.error) v.after(S.data); }, 150);
  });
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (v && VIEWS[v] && v !== S.view && v !== 'boot') go(v);
  });
}

/* ---------- persistence ---------- */
let persistTimer = null, lastPersist = 0;
function persistSoon() {
  clearTimeout(persistTimer);
  const wait = Date.now() - lastPersist > 4000 ? 300 : 900;
  persistTimer = setTimeout(persistNow, wait);
}
function persistNow() {
  if (!LIVE.raw || LIVE.db.inTx()) return persistSoon();
  try {
    const bytes = LIVE.raw.export();
    LIVE.raw.exec('PRAGMA foreign_keys = ON'); // export() reopens the file and resets pragmas
    S.persistFailed = !store.set(STORE_KEY, b64(bytes));
    lastPersist = Date.now();
  } catch (e) { S.persistFailed = true; }
}

/* ---------- boot ---------- */
const SQLJS_SOURCES = [
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-asm.js',
  'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-asm.js',
];
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
async function loadSqlJs() {
  if (typeof initSqlJs !== 'function') {
    let lastErr;
    for (const src of SQLJS_SOURCES) {
      try { await loadScript(src); if (typeof initSqlJs === 'function') break; } catch (e) { lastErr = e; }
    }
    if (typeof initSqlJs !== 'function') throw lastErr || new Error('The SQLite engine did not load');
  }
  return initSqlJs();
}
function bootStep(key, state, detail) {
  const li = document.querySelector(`[data-boot="${key}"]`);
  if (!li) return;
  li.className = 'boot-step ' + state;
  if (detail != null) li.querySelector('.boot-detail').textContent = detail;
}
async function openDatabase({ fresh = false } = {}) {
  if (LIVE.workerTimer) clearInterval(LIVE.workerTimer);
  if (LIVE.raw) { try { LIVE.raw.close(); } catch (_) { /* already closed */ } }
  const saved = fresh ? null : store.get(STORE_KEY);
  let rawDb = null, restored = false;
  if (saved) {
    try { rawDb = new LIVE.SQL.Database(unb64(saved)); restored = true; } catch (_) { rawDb = null; }
  }
  if (!rawDb) rawDb = new LIVE.SQL.Database();
  const db = wrapDb(rawDb, { onWrite: persistSoon });
  bootStep('db', 'done', restored ? 'Restored from this browser' : 'New in-memory database');
  bootStep('migrate', 'active');
  const ran = migrate(db, Date.now());
  bootStep('migrate', 'done', ran.length ? `${ran.length} applied: ${ran.join(', ')}` : 'Schema up to date');
  const seeded = db.val('SELECT COUNT(*) FROM tenants');
  if (!seeded) {
    bootStep('seed', 'active', 'Hashing 7 demo passwords with PBKDF2…');
    await seedDemo(db, Date.now());
    bootStep('seed', 'done', '2 organizations, 7 people, 6 labs, 13 sessions');
  } else bootStep('seed', 'done', 'Using your saved data');
  LIVE.raw = rawDb;
  LIVE.db = db;
  LIVE.server = createServer({ db, clock: systemClock, onEvent: onServerEvent });
  LIVE.workerTimer = setInterval(() => {
    try { LIVE.server.worker.tick(); } catch (e) { console.error('[worker]', e); }
    renderWorkerStatus();
  }, 300);
  persistSoon();
  return { restored };
}
async function boot() {
  bindEvents();
  renderNet();
  renderTopbar();
  try {
    bootStep('engine', 'active');
    const t0 = performance.now();
    LIVE.SQL = await loadSqlJs();
    bootStep('engine', 'done', `sql.js 1.10.3 ready in ${Math.round(performance.now() - t0)} ms`);
    bootStep('db', 'active');
    await openDatabase();
    bootStep('api', 'done', `${LIVE.server.routes.length} routes, worker polling every 300 ms`);
  } catch (e) {
    console.error(e);
    $('#main').innerHTML = String(html`<div class="panel error-panel"><div class="panel-body"><div class="eyebrow tone-bad">Startup failed</div><h2>The database engine didn’t load</h2><p>LabPilot loads SQLite from a public CDN. Check your connection, then reload the page.</p><p class="fine mono">${e.message}</p></div></div>`);
    return;
  }
  setInterval(tickCountdowns, 1000);
  const token = store.get(TOKEN_KEY);
  if (token) {
    S.token = token;
    const res = await client.request('GET', '/api/me', { background: true });
    if (res.status === 200) S.me = res.body; else { S.token = null; store.del(TOKEN_KEY); }
  }
  renderTopbar();
  renderWorkerStatus();
  const hash = location.hash.slice(1);
  await go(hash && VIEWS[hash] && hash !== 'boot' && hash !== 'session' ? hash : S.me ? HOME[S.me.user.role] : 'signin');
}
boot();

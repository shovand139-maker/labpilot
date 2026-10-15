/* =====================================================================
   LabPilot · shell, navigation and product views
   ===================================================================== */

const ROLE_NAV = {
  learner: [['labs', 'My labs', 'flask'], ['history', 'History', 'clock']],
  instructor: [['live', 'Live sessions', 'pulse'], ['catalog', 'Lab catalog', 'grid'], ['people', 'Learners', 'users']],
  admin: [['overview', 'Overview', 'chart'], ['live', 'Live sessions', 'pulse'], ['catalog', 'Lab catalog', 'grid'], ['people', 'People', 'users'], ['audit', 'Audit log', 'audit'], ['jobs', 'Job queue', 'layers']],
};
const DEV_NAV = [['api', 'API explorer', 'braces'], ['db', 'Database', 'db'], ['tests', 'Test suite', 'check'], ['about', 'How it’s built', 'blueprint']];
const HOME = { learner: 'labs', instructor: 'live', admin: 'overview' };

/* ---------- shell ---------- */
function renderTopbar() {
  const right = $('#topbar-right');
  if (!right) return;
  if (!S.me) {
    right.innerHTML = String(html`<span class="muted top-hint">Not signed in</span>`);
    return;
  }
  const { user, tenant, credits } = S.me;
  right.innerHTML = String(html`
    <span class="tenant-chip" title="Your organization">${tenant.name}</span>
    <span class="credit-chip" title="Organization credit balance"><b class="num">${fmt.num(credits.balance)}</b> credits</span>
    <span class="who"><span class="avatar" aria-hidden="true">${initials(user.name)}</span><span class="who-text"><b>${user.name}</b><span>${ROLE_LABEL[user.role]}</span></span></span>
    <button type="button" class="icon-btn" data-act="signout" title="Sign out or switch account" aria-label="Sign out">${icon('out')}</button>`);
}
function renderWorkerStatus() {
  const el = $('#worker-status');
  if (!el || !LIVE.server) return;
  const st = LIVE.server.worker.stats() || {};
  const busy = (st.queued || 0) + (st.running || 0);
  const text = `${busy ? 'busy' : 'idle'}|${st.queued || 0}`;
  if (el.dataset.state === text) return;
  el.dataset.state = text;
  el.innerHTML = String(html`<span class="dot${busy ? ' busy' : ''}"></span><span class="ws-label">Worker</span><span class="ws-val">${busy ? `${st.queued || 0} queued` : 'idle'}</span>`);
}
function renderRail() {
  const rail = $('#rail');
  if (!rail) return;
  const item = ([view, label, ic]) => {
    const active = S.view === view || (S.view === 'session' && view === (S.me && S.me.user.role === 'learner' ? 'labs' : 'live'));
    let badge = '';
    if (view === 'tests' && S.tests.last) badge = html`<span class="badge tone-${S.tests.last.failed ? 'bad' : 'ok'}">${S.tests.last.failed ? `${S.tests.last.failed} failing` : `${S.tests.last.passed} ✓`}</span>`;
    return html`<a href="#${view}" class="rail-item${active ? ' on' : ''}" data-act="nav" data-view="${view}" ${active ? raw('aria-current="page"') : ''}>${icon(ic)}<span>${label}</span>${badge}</a>`;
  };
  rail.innerHTML = String(html`
    <div class="rail-group">
      <div class="rail-title">${S.me ? (S.me.user.role === 'learner' ? 'Learning' : 'Workspace') : 'Start'}</div>
      ${S.me ? ROLE_NAV[S.me.user.role].map(item) : item(['signin', 'Sign in', 'key'])}
    </div>
    <div class="rail-group">
      <div class="rail-title">Under the hood</div>
      ${DEV_NAV.map(item)}
    </div>
    <div class="rail-foot">Built by <b>${APP.builder}</b><br><span class="muted">v${APP.version}</span></div>`);
  const on = $('.rail-item.on', rail);
  if (on && rail.scrollWidth > rail.clientWidth + 4) {
    const left = on.offsetLeft - 16;
    if (left < rail.scrollLeft || on.offsetLeft + on.offsetWidth > rail.scrollLeft + rail.clientWidth) rail.scrollLeft = Math.max(0, left);
  }
}

/* ---------- navigation and rendering ---------- */
function setHash(view) {
  try { if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view); } catch (_) { /* sandboxed */ }
}
async function go(view, params = {}) {
  if (!VIEWS[view]) view = S.me ? HOME[S.me.user.role] : 'signin';
  const v = VIEWS[view];
  if (v.auth && !S.me) view = 'signin';
  else if (v.roles && S.me && !v.roles.includes(S.me.user.role)) view = HOME[S.me.user.role];
  if (view === 'signin' && S.me) view = HOME[S.me.user.role];
  S.view = view; S.params = params; S.data = null; S.error = null;
  if (S.ui.confirm) S.ui.confirm = null;
  const seq = ++S.seq;
  if (view !== 'session') setHash(view);
  renderRail();
  renderMain(true);
  try { window.scrollTo({ top: 0, behavior: 'instant' }); } catch (_) { window.scrollTo(0, 0); }
  await load(seq, false);
  const vm = VIEWS[S.view];
  if (seq === S.seq && vm.mount) vm.mount();
}
async function load(seq, background) {
  const v = VIEWS[S.view];
  if (!v.load) { renderMain(); return; }
  try {
    const data = await v.load(S.params, { background });
    if (seq !== S.seq) return;
    S.data = data; S.error = null;
  } catch (e) {
    if (seq !== S.seq) return;
    if (!background || !S.data) S.error = e;
  }
  if (seq === S.seq) renderMain();
}
let refreshTimer = null;
function refresh() { load(S.seq, true); }
function scheduleRefresh(delay = 250) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (VIEWS[S.view] && VIEWS[S.view].live) refresh();
    refreshMe();
  }, delay);
}
async function refreshMe() {
  if (!S.token) return;
  const res = await client.request('GET', '/api/me', { background: true });
  if (res.status === 200) { S.me = res.body; renderTopbar(); }
}
function onServerEvent(e) {
  if (!S.me || e.tenantId !== S.me.tenant.id) return; // tenant-scoped push
  scheduleRefresh();
}

function captureForm(root) {
  const vals = {};
  $$('input[id], textarea[id], select[id]', root).forEach((el) => { vals[el.id] = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value; });
  const a = document.activeElement;
  const focus = a && root.contains(a) && a.id ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  return { vals, focus };
}
function restoreForm(root, snap) {
  for (const [id, v] of Object.entries(snap.vals)) {
    const el = document.getElementById(id);
    if (!el || !root.contains(el) || 'noRestore' in el.dataset) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = v; else el.value = v;
  }
  if (snap.focus) {
    const el = document.getElementById(snap.focus.id);
    if (el && root.contains(el)) {
      el.focus({ preventScroll: true });
      try { if (snap.focus.s != null) el.setSelectionRange(snap.focus.s, snap.focus.e); } catch (_) { /* not a text input */ }
    }
  }
}
function renderMain(fresh = false) {
  const main = $('#main');
  if (!main) return;
  const v = VIEWS[S.view];
  const snap = fresh || S.skipRestore ? null : captureForm(main);
  S.skipRestore = false;
  let content;
  try {
    content = S.error ? errorView(S.error) : v.load && !S.data ? loadingView(v.title) : v.render(S.data, S.params);
  } catch (e) {
    console.error(e);
    content = errorView(e);
  }
  main.innerHTML = String(html`<div class="view view-${S.view}">${content}</div>`);
  if (snap) restoreForm(main, snap);
  if (v.after && S.data && !S.error) { try { v.after(S.data); } catch (e) { console.error(e); } }
  tickCountdowns();
}
const loadingView = (title) => html`<div class="loading" aria-busy="true"><div class="sk sk-h"></div><div class="sk sk-p"></div><div class="sk-grid"><div class="sk sk-card"></div><div class="sk sk-card"></div><div class="sk sk-card"></div></div><span class="sr">Loading ${title || ''}</span></div>`;
function errorView(e) {
  const res = e instanceof ApiError ? e.res : null;
  return html`<div class="panel error-panel"><div class="panel-body">
    <div class="eyebrow tone-bad">${res ? `${res.status} ${res.body.title}` : 'Error'}</div>
    <h2>${res && res.status === 404 ? 'We couldn’t find that' : 'This view failed to load'}</h2>
    <p>${res ? res.body.detail : e.message}</p>
    ${res ? html`<p class="fine mono">${res.body.code} · ${res.body.requestId}</p>` : ''}
    <button type="button" class="btn" data-act="nav" data-view="${S.me ? HOME[S.me.user.role] : 'signin'}">Back to start</button>
  </div></div>`;
}
function tickCountdowns() {
  const now = Date.now();
  $$('[data-countdown]').forEach((el) => {
    const left = Number(el.dataset.countdown) - now;
    const t = fmtCountdown(left);
    if (el.textContent !== t) el.textContent = t;
    el.classList.toggle('low', left < 5 * 60000);
  });
}

/* ---------- shared pieces ---------- */
function labCard(lab, { mode }) {
  const foot = mode === 'learner'
    ? (lab.activeSessionId
      ? html`<button type="button" class="btn btn-primary" data-act="nav" data-view="session" data-id="${lab.activeSessionId}">${icon('play')}Open running lab</button>`
      : html`<button type="button" class="btn btn-primary" data-act="launch" data-id="${lab.id}">${icon('bolt')}Launch · ${lab.launchCost} credits</button>`)
    : html`<span class="muted">${lab.assigned} assigned · ${lab.active} running</span><button type="button" class="btn btn-sm" data-act="assignOpen" data-id="${lab.id}">${icon('users')}Assign</button>`;
  return html`<article class="lab-card">
    <div class="lab-card-top"><span class="lvl lvl-${lab.level}">${LEVEL_LABEL[lab.level] || lab.level}</span><span class="lab-meta num">${lab.durationMin} min · ${lab.creditsPerHour} cr/h</span></div>
    <h3>${lab.title}</h3>
    <p class="lab-summary">${lab.summary}</p>
    <ul class="res-list" aria-label="Azure resources">${lab.resources.map((r) => html`<li>${r}</li>`)}</ul>
    <div class="lab-tasks muted">${lab.tasks.length} task${lab.tasks.length === 1 ? '' : 's'} checked against the live lab${mode === 'learner' && lab.attempts ? ` · launched ${lab.attempts}× before` : ''}</div>
    <div class="lab-card-foot">${foot}</div>
  </article>`;
}
const tile = (label, value, sub, extra) => html`<div class="tile"><div class="tile-label">${label}</div><div class="tile-value num">${value}</div>${sub ? html`<div class="tile-sub">${sub}</div>` : ''}${extra || ''}</div>`;
const fieldError = (errs, key) => (errs && errs[key] ? html`<div class="field-error">${errs[key]}</div>` : '');

/* ---------- views ---------- */
const VIEWS = {};

VIEWS.boot = { title: 'Starting', render: () => html`` };

VIEWS.signin = {
  title: 'Sign in',
  render() {
    const accounts = [
      ['Contoso Academy', 'centralindia', [['Ananya Sen', 'ananya@contoso.example', 'learner', '3 labs assigned'], ['Rahul Menon', 'rahul@contoso.example', 'instructor', 'Runs the class'], ['Meera Iyer', 'meera@contoso.example', 'admin', 'Owns credits and people']]],
      ['Fabrikam University', 'westeurope', [['Arjun Das', 'arjun@fabrikam.example', 'learner', 'A different tenant'], ['Lena Fischer', 'lena@fabrikam.example', 'instructor', 'Cannot see Contoso data']]],
    ];
    const err = S.ui.loginError;
    return html`<div class="signin">
      <section class="intro intro-head">
        <div class="eyebrow">Hands-on cloud labs · multi-tenant</div>
        <h1 class="display">Launch a real lab, check the work, tear it down on time.</h1>
        <p class="lede">LabPilot is a working lab platform. Learners launch Azure-style lab environments that a background worker provisions. Instructors watch the room live and adjust time. Admins keep a prepaid credit ledger under control.</p>
      </section>
      <section class="intro intro-more">
        <div class="stack-strip" aria-label="What runs in this page">
          <div><b>SQLite</b><span>5 migrations, constraints, indexes</span></div>
          <div><b>REST API</b><span>${LIVE.server ? LIVE.server.routes.length : 15} routes, signed tokens, problem+json</span></div>
          <div><b>Job worker</b><span>retries with backoff, expiry sweep</span></div>
          <div><b>${TESTS.length} tests</b><span>plus ${FAULTS.length} injectable bugs</span></div>
        </div>
        <h2 class="h-small">Things to try</h2>
        <ul class="try">
          <li>${icon('flask')}<span>Sign in as <b>Ananya</b>, launch a lab and watch it provision step by step. Then pass its tasks using the lab’s real resource group.</span></li>
          <li>${icon('pulse')}<span>Sign in as <b>Rahul</b> in a second tab to watch Ananya’s session update live. Extend or stop it.</span></li>
          <li>${icon('net')}<span>Open the <b>Network</b> bar at the bottom: every call, its headers, response and the exact SQL it ran.</span></li>
          <li>${icon('bug')}<span>Open the <b>Test suite</b>, switch on a plausible agent mistake, and see which test catches it.</span></li>
        </ul>
        <p class="credit">Built by <b>${APP.builder}</b>. Everything here runs in your browser, and your changes are saved on this device only.</p>
      </section>
      <section class="panel signin-card" aria-labelledby="signin-h">
        <div class="panel-body">
          <h2 id="signin-h">Sign in</h2>
          <form data-form="login" class="form" novalidate>
            <div class="field"><label for="li-email">Email</label><input id="li-email" name="email" type="email" autocomplete="username" placeholder="ananya@contoso.example" required></div>
            <div class="field"><label for="li-pass">Password</label><input id="li-pass" name="password" type="password" autocomplete="current-password" placeholder="Labs@2026" required></div>
            ${err ? html`<div class="callout tone-${err.status === 429 ? 'bad' : 'warn'}" role="alert"><b>${err.status} · ${err.code}</b> ${err.detail}</div>` : ''}
            <button type="submit" class="btn btn-primary btn-block">Sign in</button>
          </form>
          <div class="demo">
            <div class="demo-head"><span>Demo accounts</span><span class="mono">password: ${DEMO_PASSWORD}</span></div>
            ${accounts.map(([org, region, people]) => html`<div class="demo-org">
              <div class="demo-org-name">${org} <span class="mono muted">${region}</span></div>
              ${people.map(([name, email, role, note]) => html`<button type="button" class="demo-acct" data-act="demoLogin" data-email="${email}">
                <span class="avatar">${initials(name)}</span>
                <span class="demo-who"><b>${name}</b><span class="muted">${note}</span></span>
                <span class="role-chip role-${role}">${ROLE_LABEL[role]}</span>
              </button>`)}
            </div>`)}
          </div>
        </div>
      </section>
    </div>`;
  },
};

VIEWS.labs = {
  title: 'My labs', auth: true, roles: ['learner'], live: true,
  async load(p, o) {
    const [labs, act] = await Promise.all([get('/api/labs', o.background), get('/api/sessions?scope=active', o.background)]);
    return { labs: labs.items, active: act.items };
  },
  render(d) {
    return html`
      ${pageHead('My labs', `${S.me.tenant.name} · ${d.labs.length} lab${d.labs.length === 1 ? '' : 's'} assigned to you`)}
      ${d.active.length ? html`<section class="section"><h2 class="section-title">Running now</h2>
        <div class="active-list">${d.active.map((s) => html`<article class="active-row">
          <div class="active-main"><div class="active-title">${s.templateTitle}</div><div class="muted small">${s.status === 'ready' ? html`Resource group <span class="mono">${s.resourceGroup}</span> · ${s.tasksDone.length}/${s.tasks.length} tasks` : s.step}</div></div>
          ${pill(s.status)}
          <div class="active-meter">${s.status === 'ready' ? html`<span class="muted small">Time left</span> ${countdown(s.expiresAt, 'mid')}` : progressBar(s.progress, 'Provisioning')}</div>
          <button type="button" class="btn btn-primary btn-sm" data-act="nav" data-view="session" data-id="${s.id}">Open lab</button>
        </article>`)}</div></section>` : ''}
      <section class="section"><h2 class="section-title">Assigned to you</h2>
        ${d.labs.length ? html`<div class="lab-grid">${d.labs.map((l) => labCard(l, { mode: 'learner' }))}</div>` : empty('No labs assigned yet', 'Your instructor assigns labs from the catalog. They appear here straight away.')}
      </section>`;
  },
};

function stepRows(s) {
  const N = PROVISION_STEPS.length;
  const reached = !!s.startedAt;
  const k = reached ? N : Math.round((s.progress / 100) * N);
  const retries = {};
  for (const j of s.jobs || []) if (j.type === 'provision' && j.attempts > 1 && j.lastError) retries[j.step - 1] = j;
  const rows = PROVISION_STEPS.map((st, i) => {
    let state = 'todo';
    if (i < k) state = 'done';
    else if (i === k && ['provisioning', 'queued'].includes(s.status) && s.status === 'provisioning') state = 'active';
    else if (i === k && s.status === 'failed') state = 'failed';
    else if (!reached && ['stopping', 'stopped'].includes(s.status)) state = 'skipped';
    return { name: st.name, state, retry: retries[i] };
  });
  rows.push({ name: 'Lab ready, credentials stored in the vault', state: reached ? 'done' : s.status === 'failed' ? 'skipped' : 'todo' });
  if (['stopping', 'stopped', 'expired'].includes(s.status)) rows.push({ name: s.status === 'stopping' ? 'Deleting resource group' : 'Resource group deleted', state: s.status === 'stopping' ? 'active' : 'done' });
  return rows;
}

VIEWS.session = {
  title: 'Lab session', auth: true, live: true,
  load: (p, o) => get(`/api/sessions/${encodeURIComponent(p.id)}`, o.background),
  render(s) {
    const learner = S.me.user.role === 'learner';
    const ready = s.status === 'ready';
    const ended = ['stopped', 'expired', 'failed'].includes(s.status);
    const confirming = S.ui.confirm === 'stop:' + s.id;
    const revealed = S.ui.revealed[s.id];
    const steps = stepRows(s);
    const done = new Set(s.tasksDone);
    const back = learner ? ['labs', 'My labs'] : ['live', 'Live sessions'];
    const placeholders = { resource_group: 'rg-lab-…', region: 'e.g. eastus', username: 'labuser-…@…' };
    const ranFor = s.startedAt ? (s.endedAt || Date.now()) - s.startedAt : 0;
    return html`
      <a href="#${back[0]}" class="back" data-act="nav" data-view="${back[0]}">${icon('left')}${back[1]}</a>
      <header class="session-head">
        <div class="session-title">
          <div class="row-wrap">${pill(s.status)}<span class="lvl lvl-${s.level}">${LEVEL_LABEL[s.level]}</span><span class="mono muted small">${s.id}</span></div>
          <h1>${s.templateTitle}</h1>
          <p class="muted">${learner ? '' : html`Learner <b>${s.learnerName}</b> · `}Region <span class="mono">${s.region}</span> · ${s.creditsPerHour} credits per hour</p>
        </div>
        <div class="session-clock">
          ${ready ? html`<div class="clock-label">Time left</div>${countdown(s.expiresAt, 'big')}<div class="muted small">Ends at ${fmt.hm(s.expiresAt)}${s.extensions ? ` · extended ${s.extensions}×` : ''}</div>`
            : ended ? html`<div class="clock-label">${s.status === 'failed' ? 'Failed' : 'Ended'}</div><div class="clock-text">${fmt.time(s.endedAt)}</div><div class="muted small">${s.startedAt ? `Ran for ${fmt.mins(ranFor)}` : 'Never started'}</div>`
            : html`<div class="clock-label">${s.status === 'stopping' ? 'Cleaning up' : 'Provisioning'}</div><div class="clock-text num">${s.status === 'stopping' ? '…' : s.progress + '%'}</div>${progressBar(s.status === 'stopping' ? 100 : s.progress, 'Provisioning')}`}
        </div>
      </header>
      <div class="session-actions">
        ${ready ? html`
          <button type="button" class="btn" data-act="extend" data-id="${s.id}" ${s.extensionsLeft ? '' : raw('disabled')}>${icon('plus')}${s.extensionsLeft ? `Extend 15 min · ${s.extensionCost} credits` : 'No extensions left'}</button>
          <span class="muted small">${s.extensionsLeft} of 2 extensions left</span>` : ''}
        ${['queued', 'provisioning', 'ready'].includes(s.status) ? (confirming
          ? html`<span class="confirm-row"><span class="small">${ready ? 'Stop the lab and delete its resources?' : 'Cancel provisioning? Credits are refunded.'}</span><button type="button" class="btn btn-danger" data-act="stop" data-id="${s.id}">${ready ? 'Yes, stop lab' : 'Yes, cancel'}</button><button type="button" class="btn btn-ghost" data-act="cancelConfirm">Keep it</button></span>`
          : html`<button type="button" class="btn btn-ghost-danger" data-act="stop" data-id="${s.id}">${ready ? 'Stop lab' : 'Cancel launch'}</button>`) : ''}
        ${ended && learner ? html`<button type="button" class="btn" data-act="nav" data-view="labs">Back to my labs</button>` : ''}
      </div>
      <div class="session-grid">
        <section class="panel">
          <div class="panel-head"><h2>Environment</h2>${ready ? html`<span class="mono muted small">${s.resourceGroup}</span>` : ''}</div>
          <div class="panel-body">
            ${ready && learner ? html`
              <dl class="creds">
                <div><dt>Resource group</dt><dd><code>${s.resourceGroup}</code>${copyBtn(s.resourceGroup)}</dd></div>
                <div><dt>Region</dt><dd><code>${s.region}</code>${copyBtn(s.region)}</dd></div>
                <div><dt>Username</dt><dd><code>${s.username}</code>${copyBtn(s.username)}</dd></div>
                <div><dt>Password</dt><dd>${revealed
                  ? html`<code>${revealed.password}</code>${copyBtn(revealed.password)}<button type="button" class="btn btn-ghost btn-xs" data-act="hideSecret" data-id="${s.id}">Hide</button>`
                  : html`<code class="masked">••••••••••••••</code><button type="button" class="btn btn-xs" data-act="reveal" data-id="${s.id}">${icon('eye')}Reveal</button>`}</dd></div>
              </dl>
              <p class="fine">The password is read from the vault on demand. Each reveal is written to the audit log and sent with <code>Cache-Control: no-store</code>.</p>` : ''}
            ${ready && !learner ? html`<div class="callout tone-info">${icon('shield')}<span>Lab credentials are only shown to ${s.learnerName}. Instructors can extend or stop the lab but never sign in as the learner.</span></div>` : ''}
            ${s.status === 'failed' ? html`<div class="callout tone-bad"><b>Provisioning failed.</b> ${s.step}. All ${s.creditsCharged} credits were refunded.</div>` : ''}
            <ol class="steps" aria-label="Provisioning steps">${steps.map((r) => html`<li class="step st-${r.state}"><span class="step-mark">${r.state === 'done' ? icon('tick') : r.state === 'failed' ? icon('cross') : ''}</span><span class="step-text">${r.name}${r.retry ? html`<span class="step-retry">Retried after: ${r.retry.lastError}</span>` : ''}</span></li>`)}</ol>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Tasks</h2><span class="muted small num">${s.tasksDone.length} of ${s.tasks.length} passed</span></div>
          <div class="panel-body">
            ${progressBar(s.tasks.length ? (s.tasksDone.length / s.tasks.length) * 100 : 0, 'Tasks passed')}
            <ol class="tasks">${s.tasks.map((t, i) => {
              const passed = done.has(t.id);
              const msg = S.ui.taskMsg[s.id + ':' + t.id];
              const canCheck = learner && ready && !passed;
              return html`<li class="task${passed ? ' passed' : ''}">
                <span class="task-mark">${passed ? icon('tick') : i + 1}</span>
                <div class="task-body">
                  <div class="task-title">${t.title}</div>
                  ${t.hint ? html`<div class="task-hint">${t.hint}</div>` : ''}
                  ${canCheck ? (t.check === 'confirm'
                    ? html`<button type="button" class="btn btn-sm" data-act="checkTask" data-id="${s.id}" data-task="${t.id}" data-check="confirm">Mark as done</button>`
                    : html`<div class="task-check"><label class="sr" for="ans-${s.id}-${t.id}">Answer for ${t.title}</label><input id="ans-${s.id}-${t.id}" class="mono" placeholder="${placeholders[t.check]}" autocomplete="off" spellcheck="false" data-enter="checkTask" data-id="${s.id}" data-task="${t.id}"><button type="button" class="btn btn-sm" data-act="checkTask" data-id="${s.id}" data-task="${t.id}">Check</button></div>`) : ''}
                  ${msg && !passed ? html`<div class="task-msg">${msg}</div>` : ''}
                </div>
              </li>`;
            })}</ol>
            ${!ready && !ended ? html`<p class="fine">Task checks open when the lab is ready.</p>` : ''}
          </div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Session record</h2><span class="muted small">From <span class="mono">GET /api/sessions/${s.id}</span></span></div>
        <div class="panel-body">
          <dl class="facts">
            <div><dt>Launched</dt><dd>${fmt.time(s.createdAt)}</dd></div>
            <div><dt>Started</dt><dd>${fmt.time(s.startedAt)}</dd></div>
            <div><dt>Expires</dt><dd>${fmt.time(s.expiresAt)}</dd></div>
            <div><dt>Credits charged</dt><dd class="num">${s.creditsCharged}</dd></div>
            <div><dt>Extensions</dt><dd class="num">${s.extensions} of 2</dd></div>
            <div><dt>End reason</dt><dd>${s.endReason || '—'}</dd></div>
          </dl>
          ${s.jobs.length ? html`<div class="table-wrap"><table class="data compact"><caption class="sr">Background jobs for this session</caption>
            <thead><tr><th>Job</th><th>Type</th><th>Step</th><th>Status</th><th class="r">Attempts</th><th>Finished</th></tr></thead>
            <tbody>${s.jobs.map((j) => html`<tr><td class="mono">#${j.id}</td><td>${j.type}</td><td>${j.type === 'provision' ? (j.step < PROVISION_STEPS.length ? PROVISION_STEPS[j.step].name : 'Mark ready') : 'Delete resource group'}</td><td>${pill(j.status)}</td><td class="r num">${j.attempts}</td><td>${j.finishedAt ? fmt.hms(j.finishedAt) : '—'}</td></tr>`)}</tbody></table></div>` : ''}
        </div>
      </section>`;
  },
};

VIEWS.history = {
  title: 'History', auth: true, roles: ['learner'], live: true,
  load: (p, o) => get('/api/sessions?scope=ended', o.background),
  render(d) {
    const items = d.items;
    return html`${pageHead('History', 'Every lab you have run, newest first.')}
      ${items.length ? html`<div class="panel"><div class="table-wrap"><table class="data"><caption class="sr">Finished lab sessions</caption>
        <thead><tr><th>Lab</th><th>Started</th><th class="r">Ran for</th><th class="r">Tasks</th><th class="r">Credits</th><th>Outcome</th><th></th></tr></thead>
        <tbody>${items.map((s) => html`<tr>
          <td><b>${s.templateTitle}</b></td><td>${fmt.time(s.startedAt || s.createdAt)}</td>
          <td class="r num">${s.startedAt && s.endedAt ? fmt.mins(s.endedAt - s.startedAt) : '—'}</td>
          <td class="r num">${s.tasksDone.length}/${s.tasks.length}</td><td class="r num">${s.creditsCharged}</td><td>${pill(s.status)}</td>
          <td class="r"><button type="button" class="btn btn-ghost btn-xs" data-act="nav" data-view="session" data-id="${s.id}">Details</button></td></tr>`)}</tbody></table></div></div>`
        : empty('No finished labs yet', 'Labs you stop, or that reach their time limit, show up here.')}`;
  },
};

VIEWS.live = {
  title: 'Live sessions', auth: true, roles: ['instructor', 'admin'], live: true,
  async load(p, o) {
    const [all, usage] = await Promise.all([get('/api/sessions?scope=all', o.background), get('/api/tenant/usage', o.background)]);
    return { all: all.items, usage };
  },
  render(d) {
    const active = d.all.filter((s) => ACTIVE_STATUSES.includes(s.status));
    const ended = d.all.filter((s) => !ACTIVE_STATUSES.includes(s.status)).slice(0, 8);
    const running = active.filter((s) => s.status === 'ready').length;
    const prov = active.filter((s) => s.status === 'queued' || s.status === 'provisioning').length;
    const today = d.all.filter((s) => s.endedAt && Date.now() - s.endedAt < DAY_MS).length;
    return html`${pageHead('Live sessions', `${S.me.tenant.name} · updates as the worker and learners act`)}
      <div class="tiles">
        ${tile('Running now', running, 'Labs with time on the clock')}
        ${tile('Provisioning', prov, prov ? 'Worker is building environments' : 'Nothing in the queue')}
        ${tile('Credits left', fmt.num(d.usage.balance), `of ${fmt.num(d.usage.quota)} allocated`, html`<div class="meter"><span style="width:${Math.max(0, Math.min(100, (d.usage.balance / d.usage.quota) * 100))}%"></span></div>`)}
        ${tile('Ended in 24 h', today, 'Stopped or expired')}
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Running and provisioning</h2><span class="muted small">${active.length} active</span></div>
        ${active.length ? html`<div class="table-wrap"><table class="data"><caption class="sr">Active lab sessions</caption>
          <thead><tr><th>Learner</th><th>Lab</th><th>Status</th><th class="r">Time left</th><th class="r">Tasks</th><th class="r">Ext.</th><th class="r">Actions</th></tr></thead>
          <tbody>${active.map((s) => html`<tr>
            <td><span class="person"><span class="avatar sm">${initials(s.learnerName)}</span>${s.learnerName}</span></td>
            <td>${s.templateTitle}</td>
            <td>${pill(s.status)}${s.status !== 'ready' ? html`<div class="muted small">${s.step}</div>` : ''}</td>
            <td class="r">${s.status === 'ready' ? countdown(s.expiresAt) : html`<span class="muted num">${s.progress}%</span>`}</td>
            <td class="r num">${s.tasksDone.length}/${s.tasks.length}</td>
            <td class="r num">${s.extensions}</td>
            <td class="r"><span class="row-actions">
              <button type="button" class="btn btn-xs" data-act="nav" data-view="session" data-id="${s.id}">Open</button>
              ${s.status === 'ready' ? html`<button type="button" class="btn btn-xs" data-act="extend" data-id="${s.id}" ${s.extensionsLeft ? '' : raw('disabled')} title="Extend by 15 minutes">+15 min</button>` : ''}
              ${S.ui.confirm === 'stop:' + s.id
                ? html`<button type="button" class="btn btn-xs btn-danger" data-act="stop" data-id="${s.id}">Confirm stop</button>`
                : html`<button type="button" class="btn btn-xs btn-ghost-danger" data-act="stop" data-id="${s.id}" ${s.status === 'stopping' ? raw('disabled') : ''}>Stop</button>`}
            </span></td></tr>`)}</tbody></table></div>`
          : html`<div class="panel-body">${empty('No labs running', 'When a learner launches a lab it appears here within a second, then moves through provisioning to running.')}</div>`}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Recently ended</h2></div>
        ${ended.length ? html`<div class="table-wrap"><table class="data compact"><caption class="sr">Recently ended sessions</caption>
          <thead><tr><th>Learner</th><th>Lab</th><th>Outcome</th><th class="r">Ran for</th><th class="r">Tasks</th><th>Ended</th></tr></thead>
          <tbody>${ended.map((s) => html`<tr><td>${s.learnerName}</td><td>${s.templateTitle}</td><td>${pill(s.status)}</td>
            <td class="r num">${s.startedAt && s.endedAt ? fmt.mins(s.endedAt - s.startedAt) : '—'}</td><td class="r num">${s.tasksDone.length}/${s.tasks.length}</td><td>${fmt.ago(s.endedAt)}</td></tr>`)}</tbody></table></div>`
          : html`<div class="panel-body">${empty('Nothing has ended yet', 'Finished sessions appear here.')}</div>`}
      </section>`;
  },
};

VIEWS.catalog = {
  title: 'Lab catalog', auth: true, roles: ['instructor', 'admin'], live: true,
  async load(p, o) {
    const [labs, users] = await Promise.all([get('/api/labs', o.background), get('/api/users', o.background)]);
    return { labs: labs.items, learners: users.items.filter((u) => u.role === 'learner') };
  },
  render(d) {
    const errs = S.ui.newLabErrors;
    const lab = d.labs.find((l) => l.id === S.ui.assignFor);
    const nTasks = S.ui.newLabTasks;
    return html`${pageHead('Lab catalog', `${d.labs.length} lab templates in ${S.me.tenant.name}`, S.ui.newLabOpen ? '' : html`<button type="button" class="btn btn-primary" data-act="toggleNewLab">${icon('plus')}New lab</button>`)}
      ${S.ui.newLabOpen ? html`<form class="panel" data-form="newLab" novalidate>
        <div class="panel-head"><h2>New lab template</h2><button type="button" class="btn btn-ghost btn-sm" data-act="toggleNewLab">Cancel</button></div>
        <div class="panel-body">
          <div class="form-grid">
            <div class="field span-2"><label for="nl-title">Title</label><input id="nl-title" value="Secure an API with Front Door and WAF">${fieldError(errs, 'title')}</div>
            <div class="field span-2"><label for="nl-summary">Summary</label><textarea id="nl-summary" rows="2">Put an App Service API behind Azure Front Door and block an injection attempt with a custom WAF rule.</textarea>${fieldError(errs, 'summary')}</div>
            <div class="field"><label for="nl-level">Level</label><select id="nl-level"><option value="beginner">Beginner</option><option value="intermediate" selected>Intermediate</option><option value="advanced">Advanced</option></select>${fieldError(errs, 'level')}</div>
            <div class="field"><label for="nl-duration">Duration (minutes)</label><input id="nl-duration" type="number" inputmode="numeric" value="45">${fieldError(errs, 'durationMin')}</div>
            <div class="field"><label for="nl-cph">Credits per hour</label><input id="nl-cph" type="number" inputmode="numeric" value="10">${fieldError(errs, 'creditsPerHour')}</div>
            <div class="field"><label for="nl-resources">Azure resources <span class="muted">(comma separated)</span></label><input id="nl-resources" value="Front Door Standard, App Service, WAF policy">${fieldError(errs, 'resources')}</div>
          </div>
          <fieldset class="task-rows"><legend>Tasks learners must pass</legend>
            ${Array.from({ length: nTasks }, (_, i) => html`<div class="task-row">
              <span class="task-n num">${i + 1}</span>
              <label class="sr" for="nl-task-${i}">Task ${i + 1} title</label><input id="nl-task-${i}" placeholder="Describe what the learner does" value="${i === 0 ? 'Find the lab resource group' : i === 1 ? 'Block the test payload with a custom WAF rule' : ''}">
              <label class="sr" for="nl-check-${i}">How task ${i + 1} is checked</label><select id="nl-check-${i}">${Object.entries(CHECK_LABEL).map(([k, label]) => html`<option value="${k}" ${(i === 0 ? k === 'resource_group' : k === 'confirm') ? raw('selected') : ''}>${label}</option>`)}</select>
            </div>`)}
            ${nTasks < 8 ? html`<button type="button" class="btn btn-ghost btn-sm" data-act="addTask">${icon('plus')}Add task</button>` : ''}
            ${fieldError(errs, 'tasks')}
          </fieldset>
          ${errs ? html`<div class="callout tone-warn" role="alert"><b>422 · validation_failed.</b> The API rejected ${Object.keys(errs).length} field${Object.keys(errs).length === 1 ? '' : 's'}. Fix them and submit again.</div>` : ''}
          <div class="form-foot"><span class="fine">The server validates every field. Try a duration of 300 to see a 422.</span><button type="submit" class="btn btn-primary">Create lab</button></div>
        </div>
      </form>` : ''}
      ${lab ? html`<form class="panel" data-form="assign" data-id="${lab.id}" id="assign-panel">
        <div class="panel-head"><h2>Assign “${lab.title}”</h2><button type="button" class="btn btn-ghost btn-sm" data-act="assignClose">Close</button></div>
        <div class="panel-body">
          ${d.learners.length ? html`<div class="check-grid">${d.learners.map((u) => {
            const has = lab.learnerIds.includes(u.id);
            return html`<label class="check-card${has ? ' is-on' : ''}"><input type="checkbox" id="as-${lab.id}-${u.id}" value="${u.id}" ${has ? raw('checked disabled data-no-restore') : ''}><span class="avatar sm">${initials(u.name)}</span><span class="check-text"><b>${u.name}</b><span class="muted">${has ? 'Already assigned' : u.email}</span></span></label>`;
          })}</div>` : empty('No learners yet', 'Invite learners from the People page first.')}
          <div class="form-foot"><div class="field inline"><label for="as-due">Due date <span class="muted">(optional)</span></label><input id="as-due" type="date"></div><button type="submit" class="btn btn-primary">Assign selected</button></div>
        </div>
      </form>` : ''}
      <div class="lab-grid">${d.labs.map((l) => labCard(l, { mode: 'staff' }))}</div>`;
  },
};

VIEWS.people = {
  title: 'People', auth: true, roles: ['instructor', 'admin'], live: true,
  load: (p, o) => get('/api/users', o.background),
  render(d) {
    const admin = S.me.user.role === 'admin';
    const items = admin ? d.items : d.items.filter((u) => u.role === 'learner');
    const inv = S.ui.invited;
    const errs = S.ui.inviteErrors;
    return html`${pageHead(admin ? 'People' : 'Learners', `${items.length} ${admin ? 'people' : 'learners'} in ${S.me.tenant.name}`)}
      ${admin ? html`<form class="panel" data-form="invite" novalidate>
        <div class="panel-head"><h2>Invite someone</h2><span class="muted small">Admins only · <span class="mono">POST /api/users</span></span></div>
        <div class="panel-body">
          <div class="form-grid cols-4">
            <div class="field"><label for="iv-name">Name</label><input id="iv-name" placeholder="Dev Patel">${fieldError(errs, 'name')}</div>
            <div class="field span-2"><label for="iv-email">Email</label><input id="iv-email" type="email" placeholder="dev@contoso.example">${fieldError(errs, 'email')}</div>
            <div class="field"><label for="iv-role">Role</label><select id="iv-role"><option value="learner">Learner</option><option value="instructor">Instructor</option><option value="admin">Admin</option></select></div>
          </div>
          ${inv ? html`<div class="callout tone-ok" role="status"><div><b>${inv.user.name}</b> can now sign in as <span class="mono">${inv.user.email}</span> with this one-time password: <code>${inv.temporaryPassword}</code> ${copyBtn(inv.temporaryPassword)}</div><div class="fine">It is only shown once. The database stores a PBKDF2 hash.</div></div>` : ''}
          <div class="form-foot"><span class="fine">Duplicate emails return 409. Invalid fields return 422.</span><button type="submit" class="btn btn-primary">Send invite</button></div>
        </div>
      </form>` : ''}
      <div class="panel"><div class="table-wrap"><table class="data"><caption class="sr">People</caption>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="r">Labs assigned</th><th class="r">Sessions</th><th>Last lab</th></tr></thead>
        <tbody>${items.map((u) => html`<tr><td><span class="person"><span class="avatar sm">${initials(u.name)}</span><b>${u.name}</b></span></td><td class="mono small">${u.email}</td>
          <td><span class="role-chip role-${u.role}">${ROLE_LABEL[u.role]}</span></td><td class="r num">${u.role === 'learner' ? u.assigned : '—'}</td><td class="r num">${u.role === 'learner' ? u.sessions : '—'}</td><td>${u.lastActive ? fmt.ago(u.lastActive) : '—'}</td></tr>`)}</tbody></table></div></div>`;
  },
};

function usageChart(usage, W = 640) {
  const now = usage.serverTime;
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => ({ t: start.getTime() - (13 - i) * DAY_MS, used: 0, launches: 0, refunds: 0 }));
  for (const e of usage.entries) {
    const idx = days.findIndex((d) => e.at >= d.t && e.at < d.t + DAY_MS);
    if (idx < 0) continue;
    days[idx].used -= e.delta;
    if (e.reason === 'launch') days[idx].launches++;
    if (e.reason === 'refund') days[idx].refunds += e.delta;
  }
  const max = Math.max(10, ...days.map((d) => d.used));
  const step = max <= 20 ? 5 : max <= 50 ? 10 : max <= 100 ? 25 : 50;
  const top = Math.ceil(max / step) * step;
  W = Math.max(280, Math.round(W));
  const H = W < 520 ? 190 : 230, L = 34, R = 6, T = 12, B = 26;
  const every = W < 520 ? 3 : 2;
  const bw = (W - L - R) / days.length;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  const bars = days.map((d, i) => {
    const gap = Math.min(6, Math.max(2, bw * 0.18));
    const x = L + i * bw + gap / 2, w = bw - gap, h = Math.max(0, y(0) - y(d.used)), yy = y(d.used);
    const r = Math.min(4, h, w / 2);
    const path = h > 0 ? `M${x},${y(0)} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + w - r} Q${x + w},${yy} ${x + w},${yy + r} V${y(0)} Z` : '';
    const label = `${fmt.day(d.t)}: ${d.used} credits used, ${d.launches} launch${d.launches === 1 ? '' : 'es'}${d.refunds ? `, ${d.refunds} refunded` : ''}`;
    return { x, w, path, d, i, label };
  });
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Credits used per day over the last 14 days">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid${v === 0 ? ' base' : ''}"/><text x="${L - 8}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}</text>`).join('')}
    ${bars.map((b) => `${b.path ? `<path d="${b.path}" class="bar${b.i === 13 ? ' today' : ''}"/>` : ''}<rect x="${L + b.i * bw}" y="${T}" width="${bw}" height="${H - T - B}" class="hit" data-tip="${escapeHtml(b.label)}" aria-label="${escapeHtml(b.label)}" role="img" tabindex="0"></rect>${(13 - b.i) % every === 0 ? `<text x="${b.x + b.w / 2}" y="${H - 8}" class="axis" text-anchor="middle">${b.i === 13 ? 'Today' : escapeHtml(fmt.day(b.d.t))}</text>` : ''}`).join('')}
  </svg>`;
  const total = days.reduce((a, d) => a + d.used, 0);
  return { svg: raw(svg), total, days };
}

VIEWS.overview = {
  title: 'Overview', auth: true, roles: ['admin'], live: true,
  load: (p, o) => get('/api/tenant/usage', o.background),
  render(u) {
    const chart = usageChart(u);
    const pct = Math.round((u.balance / u.quota) * 100);
    return html`${pageHead('Overview', `${S.me.tenant.name} · region ${S.me.tenant.region}`)}
      <div class="tiles">
        ${tile('Credits left', fmt.num(u.balance), `${pct}% of ${fmt.num(u.quota)} this period`, html`<div class="meter${pct < 20 ? ' low' : ''}"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>`)}
        ${tile('Used in 14 days', fmt.num(chart.total), 'Launches and extensions, net of refunds')}
        ${tile('Active labs', u.activeSessions, 'Queued, provisioning or running')}
        ${tile('Sessions so far', u.totalSessions, 'Across every learner')}
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Credits used per day</h2><span class="muted small">Last 14 days · from <span class="mono">credit_ledger</span></span></div>
        <div class="panel-body"><div class="chart" data-chart>${chart.svg}<div class="chart-tip" hidden></div></div></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Spend by lab</h2></div>
        <div class="table-wrap"><table class="data"><caption class="sr">Credits by lab</caption>
          <thead><tr><th>Lab</th><th class="r">Sessions</th><th class="r">Credits</th><th class="bar-col">Share</th></tr></thead>
          <tbody>${u.byLab.map((r) => { const total = u.byLab.reduce((a, b) => a + b.credits, 0) || 1; return html`<tr><td>${r.title}</td><td class="r num">${r.sessions}</td><td class="r num">${r.credits}</td><td class="bar-col"><span class="hbar"><span style="width:${(r.credits / total) * 100}%"></span></span></td></tr>`; })}</tbody>
        </table></div>
      </section>`;
  },
  after(u) {
    $$('[data-chart]').forEach((host) => {
      const old = $('svg', host);
      if (old) old.remove();
      host.insertAdjacentHTML('afterbegin', String(usageChart(u, host.clientWidth || 640).svg));
    });
    bindChartTips();
  },
};
function bindChartTips() {
  $$('[data-chart]').forEach((host) => {
    const tip = $('.chart-tip', host);
    const show = (el) => {
      const hb = host.getBoundingClientRect(), rb = el.getBoundingClientRect();
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const half = tip.offsetWidth / 2 + 4;
      const x = rb.left - hb.left + rb.width / 2;
      tip.style.left = Math.max(half, Math.min(hb.width - half, x)) + 'px';
      $$('.hit', host).forEach((h) => h.classList.toggle('on', h === el));
    };
    const hide = () => { tip.hidden = true; $$('.hit', host).forEach((h) => h.classList.remove('on')); };
    $$('.hit', host).forEach((el) => {
      el.addEventListener('mouseenter', () => show(el));
      el.addEventListener('focus', () => show(el));
      el.addEventListener('blur', hide);
    });
    if (!host.dataset.bound) { host.dataset.bound = '1'; host.addEventListener('mouseleave', hide); }
  });
}

const AUDIT_FILTERS = [['all', 'All'], ['session', 'Sessions'], ['credentials', 'Credentials'], ['task', 'Tasks'], ['auth', 'Sign-ins'], ['lab', 'Labs'], ['assignment', 'Assignments'], ['user', 'People']];
VIEWS.audit = {
  title: 'Audit log', auth: true, roles: ['admin'], live: true,
  load: (p, o) => get('/api/audit?limit=300', o.background),
  render(d) {
    const f = S.ui.auditFilter;
    const items = d.items.filter((a) => f === 'all' || a.action.startsWith(f + '.'));
    return html`${pageHead('Audit log', 'Append-only record of every change and every credential read in your organization.')}
      <div class="filters" role="group" aria-label="Filter by action">${AUDIT_FILTERS.map(([k, label]) => html`<button type="button" class="filter${f === k ? ' on' : ''}" data-act="auditFilter" data-f="${k}" aria-pressed="${f === k ? 'true' : 'false'}">${label}</button>`)}</div>
      <div class="panel"><div class="table-wrap"><table class="data compact"><caption class="sr">Audit entries</caption>
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th><th>Request</th></tr></thead>
        <tbody>${items.length ? items.map((a) => html`<tr><td title="${fmt.time(a.at)}">${fmt.ago(a.at)}</td><td>${a.actor}</td><td><span class="action-chip">${a.action}</span></td>
          <td class="mono small">${a.target || '—'}</td><td class="mono small detail-cell">${a.detail ? JSON.stringify(a.detail) : ''}</td><td class="mono small muted">${a.requestId || 'worker'}</td></tr>`)
          : html`<tr><td colspan="6" class="muted">No entries for this filter.</td></tr>`}</tbody></table></div></div>`;
  },
};

VIEWS.jobs = {
  title: 'Job queue', auth: true, roles: ['admin'], live: true,
  load: (p, o) => get('/api/jobs', o.background),
  render(d) {
    const c = (st) => d.items.filter((j) => j.status === st).length;
    const retried = d.items.filter((j) => j.attempts > 1).length;
    return html`${pageHead('Job queue', 'Provisioning and clean-up jobs for your organization. The worker polls every 300 ms.')}
      <div class="tiles">${tile('Queued', c('queued'), 'Waiting for their run time')}${tile('Done', c('done'), 'In the last 100 jobs')}${tile('Retried', retried, 'Transient Azure errors, backed off')}${tile('Failed', c('failed'), 'Session failed and was refunded')}</div>
      <div class="panel"><div class="table-wrap"><table class="data compact"><caption class="sr">Jobs</caption>
        <thead><tr><th>Job</th><th>Type</th><th>Learner · lab</th><th>Step</th><th>Status</th><th class="r">Attempts</th><th>Run at</th><th>Last error</th></tr></thead>
        <tbody>${d.items.map((j) => html`<tr><td class="mono">#${j.id}</td><td>${j.type}</td><td>${j.learner} · <span class="muted">${j.lab}</span></td>
          <td>${j.type === 'provision' ? (j.step < PROVISION_STEPS.length ? PROVISION_STEPS[j.step].name : 'Mark ready') : 'Delete resources'}</td>
          <td>${pill(j.status)}</td><td class="r num">${j.attempts}</td><td class="num">${fmt.hms(j.runAt)}</td><td class="small ${j.lastError ? 'tone-text-warn' : 'muted'}">${j.lastError || '—'}</td></tr>`)}</tbody></table></div></div>`;
  },
};

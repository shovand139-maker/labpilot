// End-to-end walk-through of every role and the developer views, in light, dark and phone layouts.
const { PAGE_URL, launch, openPage, checker, shot, overflow, text } = require('./harness');

(async () => {
  const browser = await launch();
  const { check, failures } = checker();
  try {
    const { ctx, page, errors } = await openPage(browser);
    await page.goto(PAGE_URL);
    await page.waitForSelector('.signin', { timeout: 20000 });
    check((await overflow(page)) === 0, 'sign-in page has no horizontal scroll');
    await shot(page, '01-signin');

    console.log('Sign-in');
    await page.fill('#li-email', 'ananya@contoso.example');
    await page.fill('#li-pass', 'wrong password');
    await page.click('form[data-form=login] [type=submit]');
    await page.waitForSelector('.signin .callout');
    check((await text(page, '.signin .callout')).includes('401'), 'wrong password shows a 401 problem');

    console.log('Learner');
    await page.click('[data-email="ananya@contoso.example"]');
    await page.waitForSelector('.view-labs .lab-card');
    check((await page.locator('.lab-card').count()) === 3, 'learner sees exactly the 3 labs assigned to her');
    await shot(page, '02-learner-labs');
    await page.locator('.lab-card [data-act=launch]').first().click();
    await page.waitForSelector('.view-session');
    await page.waitForSelector('.view-session .creds', { timeout: 20000 });
    check((await page.locator('.step.st-done').count()) >= 6, 'worker provisions the lab through every step to ready');
    const rg = await text(page, '.creds > div:nth-child(1) code');
    const region = await text(page, '.creds > div:nth-child(2) code');
    await page.locator('.task-check input').first().fill('rg-lab-wrong');
    await page.locator('.task-check [data-act=checkTask]').first().click();
    await page.waitForSelector('.task-msg');
    check((await text(page, '.task-msg')).includes('not this lab'), 'a wrong task answer is rejected');
    await page.locator('.task-check input').first().fill(rg);
    await page.locator('.task-check input').first().press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.task.passed').length === 1);
    await page.locator('.task-check input').first().fill(region);
    await page.locator('.task-check [data-act=checkTask]').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.task.passed').length === 2);
    check(true, 'tasks pass with the live resource group and region');
    await page.click('[data-act=reveal]');
    await page.waitForSelector('[data-act=hideSecret]');
    check((await text(page, '.creds > div:nth-child(4) code')).length === 14, 'password is revealed from the vault');
    await page.click('[data-act=extend]');
    await page.waitForFunction(() => /1 of 2 extensions left/.test(document.querySelector('.session-actions').innerText));
    check(true, 'extending adds time and uses one of two extensions');
    await shot(page, '03-session', true);
    await page.click('.net-toggle');
    await page.waitForSelector('.net-row');
    await page.locator('.net-row').nth(1).click();
    await page.click('[data-tab=sql]');
    check((await page.locator('.sql-trace li').count()) > 0, 'network panel shows the SQL a request ran');
    await shot(page, '04-network');
    await page.click('.net-toggle');

    console.log('Instructor');
    await page.click('[data-act=signout]');
    await page.click('[data-email="rahul@contoso.example"]');
    await page.waitForSelector('.view-live table');
    check((await page.locator('.view-live tbody tr').count()) > 0, 'live sessions list running labs');
    await shot(page, '05-instructor-live');
    await page.click('[data-view=catalog]');
    await page.waitForSelector('.view-catalog .lab-card');
    await page.click('[data-act=toggleNewLab]');
    await page.fill('#nl-duration', '300');
    await page.fill('#nl-title', 'AB');
    await page.click('form[data-form=newLab] [type=submit]');
    await page.waitForSelector('.field-error');
    check((await page.locator('.field-error').count()) === 2, 'server validation errors appear next to the fields');
    await page.fill('#nl-duration', '45');
    await page.fill('#nl-title', 'Secure an API with Front Door and WAF');
    await page.click('form[data-form=newLab] [type=submit]');
    await page.waitForSelector('#assign-panel');
    await page.locator('#assign-panel input[type=checkbox]:not([disabled])').first().check();
    await page.click('#assign-panel [type=submit]');
    await page.waitForFunction(() => !document.querySelector('#assign-panel'));
    check((await page.locator('.lab-card').count()) === 5, 'a new lab is created and assigned');

    console.log('Admin');
    await page.click('[data-act=signout]');
    await page.click('[data-email="meera@contoso.example"]');
    await page.waitForSelector('.view-overview .chart-svg .bar');
    await shot(page, '06-admin-overview');
    await page.click('[data-view=people]');
    await page.fill('#iv-name', 'Dev Patel');
    await page.fill('#iv-email', 'dev@contoso.example');
    await page.click('form[data-form=invite] [type=submit]');
    await page.waitForSelector('.callout.tone-ok');
    check(true, 'admin invites a person and gets a one-time password');
    await page.click('[data-view=audit]');
    await page.waitForSelector('.view-audit tbody tr');
    check((await page.locator('.view-audit tbody tr').count()) > 10, 'audit log records actions');
    await page.click('[data-view=jobs]');
    await page.waitForSelector('.view-jobs tbody tr');

    console.log('API explorer and database');
    await page.click('[data-view=api]');
    await page.locator('[data-act=apiPreset]').nth(0).click();
    await page.waitForSelector('.resp-head');
    check((await text(page, '.resp-head .code')) === '404', 'reading another tenant\'s session returns 404');
    await page.locator('[data-act=apiPreset]').nth(1).click();
    await page.waitForFunction(() => document.querySelector('.resp-head .code').textContent.trim() === '401');
    check(true, 'an edited token is rejected with 401');
    await page.locator('[data-act=apiPreset]').nth(6).click();
    await page.waitForFunction(() => document.querySelector('.resp-head .code').textContent.trim() === '405');
    check(true, 'the wrong HTTP method returns 405');
    await page.click('[data-view=db]');
    await page.waitForSelector('.view-db table');
    await page.locator('[data-act=dbSample]').nth(3).click();
    check((await page.locator('.view-db .mono-cells tbody').innerText()).includes('ix_sessions_tenant_status'), 'tenant lookups use the index');
    await page.locator('[data-act=dbSample]').nth(5).click();
    await page.waitForSelector('.view-db .callout.tone-bad');
    check(true, 'the SQL console refuses writes');

    console.log('Test suite in the browser');
    await page.click('[data-view=tests]');
    await page.waitForSelector('.ts-status.ok, .ts-status.bad', { timeout: 30000 });
    check((await text(page, '.ts-status')).startsWith('34 passed'), 'all 34 tests pass in the browser');
    await page.check('#fault-noOutputEscaping', { force: true });
    await page.click('[data-act=runTests]');
    await page.waitForSelector('.ts-status.bad', { timeout: 30000 });
    const failing = await page.locator('.test.st-fail .t-id').allInnerTexts();
    check(failing.length === 1 && failing[0] === 'D1', 'the XSS fault is caught by D1 and nothing else');
    await page.uncheck('#fault-noOutputEscaping', { force: true });
    await page.click('[data-act=runMutation]');
    await page.waitForSelector('.ts-mut', { timeout: 120000 });
    check((await text(page, '.ts-mut')).startsWith('8 of 8'), 'mutation check: all 8 injected bugs are caught');
    await page.waitForSelector('.ts-status.ok', { timeout: 30000 });
    await shot(page, '07-tests', true);
    await page.click('[data-view=about]');
    await page.waitForSelector('.view-about .md');
    await shot(page, '08-about', true);

    await page.reload();
    await page.waitForSelector('.view-about', { timeout: 20000 });
    check((await text(page, '.who-text b')) === 'Meera Iyer', 'data and sign-in survive a reload');
    check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
    const state = await ctx.storageState();
    await ctx.close();

    console.log('Layouts');
    for (const [name, opts] of [['phone-light', { viewport: { width: 390, height: 844 } }], ['phone-dark', { viewport: { width: 390, height: 844 }, dark: true }], ['desktop-dark', { dark: true }]]) {
      const m = await openPage(browser, { ...opts, storageState: state });
      await m.page.goto(PAGE_URL);
      await m.page.waitForSelector('.view-overview', { timeout: 20000 });
      let worst = await overflow(m.page);
      for (const view of ['live', 'catalog', 'tests', 'api', 'db', 'about']) {
        await m.page.click(`[data-view=${view}]`);
        await m.page.waitForSelector(`.view-${view}`);
        worst = Math.max(worst, await overflow(m.page));
      }
      await shot(m.page, `10-${name}`, true);
      await m.page.click('[data-act=signout]');
      await m.page.waitForSelector('.signin');
      worst = Math.max(worst, await overflow(m.page));
      check(worst === 0 && m.errors.length === 0, `${name}: no horizontal scroll and no errors`);
      await m.ctx.close();
    }
  } catch (e) {
    console.error(e);
    failures.push(e.message);
  } finally {
    await browser.close();
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll end-to-end checks passed');
  process.exit(failures.length ? 1 : 0);
})();

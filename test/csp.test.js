// Boots the page under a strict Content-Security-Policy (no unsafe-eval) and drives a launch.
// Uses selector waits only, because waitForFunction itself needs eval.
const { PAGE_URL, launch, openPage, checker, text } = require('./harness');

(async () => {
  const browser = await launch();
  const { check, failures } = checker();
  try {
    const { page, errors } = await openPage(browser, { csp: true, viewport: { width: 1280, height: 860 } });
    await page.goto(PAGE_URL);
    await page.waitForSelector('.signin', { timeout: 20000 });
    await page.click('[data-email="ananya@contoso.example"]');
    await page.waitForSelector('.view-labs .lab-card [data-act=launch]');
    await page.locator('.lab-card [data-act=launch]').first().click();
    await page.waitForSelector('.view-session .creds', { timeout: 20000 });
    check(true, 'a lab launches and provisions under the strict policy');
    await page.click('[data-view=tests]');
    await page.waitForSelector('.ts-status.ok, .ts-status.bad', { timeout: 30000 });
    check((await text(page, '.ts-status')).startsWith('34 passed'), 'the test suite passes under the strict policy');
    check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) {
    console.error(e);
    failures.push(e.message);
  } finally {
    await browser.close();
  }
  process.exit(failures.length ? 1 : 0);
})();

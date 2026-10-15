// Shared Playwright setup: serves docs/index.html from a fake origin and the SQLite engine
// from node_modules, so the browser tests run offline and deterministically.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PAGE_URL = 'https://labpilot.test/';
const SQLJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-asm.js';
const SQLJS = fs.readFileSync(require.resolve('sql.js/dist/sql-asm.js'));
const STRICT_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'none'";
const SHOTS = path.join(ROOT, 'shots');

const launch = () => chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

async function openPage(browser, { viewport = { width: 1440, height: 900 }, dark = false, csp = false, storageState } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: dark ? 'dark' : 'light', storageState });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(PAGE_URL)) {
      return route.fulfill({ contentType: 'text/html', headers: csp ? { 'content-security-policy': STRICT_CSP } : {}, body: fs.readFileSync(path.join(ROOT, 'docs', 'index.html')) });
    }
    if (u === SQLJS_URL) return route.fulfill({ contentType: 'application/javascript', body: SQLJS, headers: { 'access-control-allow-origin': '*' } });
    if (u.includes('fonts.googleapis.com') || u.includes('fonts.gstatic.com')) return route.fulfill({ contentType: 'text/css', body: '' });
    return route.abort();
  });
  return { ctx, page, errors };
}

function checker() {
  const failures = [];
  const check = (ok, what) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) failures.push(what); };
  return { check, failures };
}

const shot = (page, name, fullPage = false) => { fs.mkdirSync(SHOTS, { recursive: true }); return page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage }); };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const text = async (page, sel) => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();

module.exports = { PAGE_URL, launch, openPage, checker, shot, overflow, text };

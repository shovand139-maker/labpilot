// Runs the suite headless in Node against the real modules, then the fault matrix:
// every injected bug must make at least one guarding test fail. Exits non-zero otherwise.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const initSqlJs = require('sql.js/dist/sql-asm.js');

const MODULES = ['core.js', 'server.js', 'tests.js'];

(async () => {
  const SQL = await initSqlJs();
  const code = MODULES.map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n;\n');
  const ctx = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, performance, URLSearchParams, setTimeout });
  vm.runInContext(code + '\n;globalThis.__suite = { runTests, FAULTS, TESTS };', ctx);
  const { runTests, FAULTS, TESTS } = ctx.__suite;
  let failed = false;

  const base = await runTests(SQL, {});
  for (const r of base.results) {
    const mark = r.status === 'pass' ? '✓' : r.status === 'skip' ? '-' : '✗';
    console.log(`  ${mark} ${r.id.padEnd(3)} ${r.name}${r.status === 'skip' ? ' (runs in the browser)' : ''}${r.error ? `\n        ${r.error}` : ''}`);
  }
  console.log(`\n${base.passed} passed, ${base.failed} failed, ${base.skipped} browser-only, ${base.ms} ms\n`);
  if (base.failed) failed = true;

  console.log('Fault injection: every bug must be caught by a failing test');
  const browserOnly = new Set(TESTS.filter((t) => t.dom).map((t) => t.id));
  for (const f of FAULTS) {
    const guards = TESTS.filter((t) => (t.guards || []).includes(f.key));
    if (guards.length && guards.every((t) => browserOnly.has(t.id))) {
      console.log(`  - ${f.key.padEnd(20)} checked in the browser by npm run e2e`);
      continue;
    }
    const res = await runTests(SQL, { faults: { [f.key]: true } });
    const caught = res.results.filter((r) => r.status === 'fail').map((r) => r.id);
    console.log(`  ${caught.length ? '✓' : '✗'} ${f.key.padEnd(20)} ${caught.length ? `caught by ${caught.join(', ')}` : 'NOT CAUGHT'}`);
    if (!caught.length) failed = true;
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

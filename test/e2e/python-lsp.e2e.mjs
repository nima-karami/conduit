/**
 * Python navigation through a host-owned basedpyright (docs/specs/2026-10-08-language-coverage.md
 * §7): B8 a 3 MB `.py` is never synced and F12 says why, as does an invalid-UTF-8 one — checked
 * first, while no other Python doc exists; then B3 F12 / hover / breadcrumbs in a marked project,
 * F12 from an extensionless `#!/usr/bin/env python3` script, and B5 an ad-hoc server for a `.py`
 * under no marker.
 *
 * Needs basedpyright: `pip install basedpyright`. Fails, never skips, when it is missing.
 * Run: node test/e2e/run-smoke.mjs python-lsp   (needs `npm run build` first)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTransients, openDoc, placeCursor } from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';
import {
  breadcrumbWith,
  endsWith,
  hoverText,
  lsp,
  serverInstalled,
  trustViaHost,
  waitDefinition,
  waitObserved,
  waitServerState,
} from './lsp-fixture.mjs';
import {
  PY_GREET_CALL,
  PY_SOLO_CALL,
  writePythonFixture,
  writeUnsyncablePython,
} from './python-fixture.mjs';

const READY_CEILING_MS = 60_000;

const sameDir = (a, b) =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

async function notSynced(app, page, sid, file, token, want, log) {
  await openDoc(app, page, sid, file);
  await clearTransients(page);
  await placeCursor(page, file, token);
  await page.keyboard.press('F12');
  const r = await waitObserved(page, (o) => o.toasts.includes(want), 8_000);
  log(`F12 in ${file} → toasts ${JSON.stringify(r.toasts)}`);
  assert(r.toasts.includes(want), `F12 in ${file} did not say ${JSON.stringify(want)}`);
}

async function f12Lands(page, file, token, suffix, marker, log) {
  await clearTransients(page);
  await placeCursor(page, file, token);
  await page.keyboard.press('F12');
  const r = await waitObserved(page, (o) => endsWith(o.path, suffix), 30_000);
  log(
    `F12 ${token} in ${file} → ${r.path}:${r.line} "${r.lineText}" toasts=${JSON.stringify(r.toasts)}`,
  );
  assert(endsWith(r.path, suffix), `F12 landed in ${r.path}`);
  assert(r.lineText.includes(marker), `caret line is "${r.lineText}"`);
}

runScenario('python-lsp', async ({ app, page, log }) => {
  // `where`, not a run: the language server itself waits on stdin rather than exiting.
  assert(
    serverInstalled('where', ['basedpyright-langserver']),
    'python-lsp e2e needs basedpyright: pip install basedpyright',
  );
  const dir = mkdtempSync(join(tmpdir(), 'conduit-py-'));
  const fx = writePythonFixture(dir);
  const big = writeUnsyncablePython(dir);
  const sid = await openSession(page, { path: dir });
  await trustViaHost(page, fx.main, 'python', log);

  // ── B8: kept from the server, and F12 says why ──
  await openDoc(app, page, sid, big.huge);
  await page.waitForTimeout(5_000);
  const alone = await lsp(page, { type: 'lsp:statusSnapshot' });
  log(`huge.py alone → servers ${JSON.stringify(alone.servers)}`);
  assert(
    !alone.servers.some((s) => s.languageId === 'python'),
    `a 3 MB head window reached a Python server: ${JSON.stringify(alone.servers)}`,
  );
  await notSynced(app, page, sid, big.huge, 'f1()', 'File too large for code navigation', log);
  await notSynced(app, page, sid, big.latin, 'caf()', 'Code navigation needs UTF-8 text', log);
  log('B8 too-large and invalid-UTF-8 docs: never synced, F12 says why ✓');

  // ── B3: a marked project ──
  await openDoc(app, page, sid, fx.main);
  const appRoot = join(dir, 'app');
  await waitServerState(page, 'python', 'ready', log, READY_CEILING_MS, (s) =>
    sameDir(s.root, appRoot),
  );
  const def = await waitDefinition(
    page,
    fx.main,
    PY_GREET_CALL.line,
    PY_GREET_CALL.character,
    log,
    60_000,
  );
  assert(
    def.locations.some((l) => endsWith(l.path, 'util.py')),
    `definition → ${JSON.stringify(def.locations)}`,
  );
  await openDoc(app, page, sid, fx.main);
  await f12Lands(page, fx.main, 'greet("x")', 'util.py', 'def greet', log);

  await openDoc(app, page, sid, fx.main);
  const hover = await hoverText(page, fx.main, 'greet("x")', 'greet');
  log(`hover greet → ${JSON.stringify(hover)}`);
  assert(hover?.includes('greet(name: str) -> str'), `hover: ${JSON.stringify(hover)}`);

  await placeCursor(page, fx.main, 'return greet');
  const crumbs = await breadcrumbWith(page, 'run');
  log(`breadcrumb symbols → ${JSON.stringify(crumbs)}`);
  assert(crumbs, 'the breadcrumb bar never showed the function run');
  log('B3 Python F12 / hover / breadcrumbs ✓');

  // ── B3: an extensionless script is Python by its shebang ──
  await openDoc(app, page, sid, fx.tool);
  const toolLang = await page.evaluate(
    (p) =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.path.toLowerCase() === `/${p.toLowerCase()}`)
        ?.getLanguageId() ?? null,
    fx.tool.replace(/\\/g, '/'),
  );
  assert(toolLang === 'python', `bin/tool opened as ${toolLang}`);
  await f12Lands(page, fx.tool, 'greet("tool")', 'util.py', 'def greet', log);
  log('B3 extensionless #!/usr/bin/env python3 script navigates ✓');

  // ── B5: no marker → an ad-hoc server at the workspace root ──
  await openDoc(app, page, sid, fx.solo);
  const adHoc = await waitServerState(page, 'python', 'ready', log, READY_CEILING_MS, (s) =>
    sameDir(s.root, dir),
  );
  const soloDef = await waitDefinition(
    page,
    fx.solo,
    PY_SOLO_CALL.line,
    PY_SOLO_CALL.character,
    log,
    60_000,
  );
  assert(
    soloDef.locations.some((l) => endsWith(l.path, 'solo.py') && l.range.start.line === 0),
    `ad-hoc definition → ${JSON.stringify(soloDef.locations)}`,
  );
  log(`B5 loose/solo.py served ad hoc at ${adHoc.root} ✓`);
});

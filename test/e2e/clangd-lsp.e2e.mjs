/**
 * C/C++ navigation through a host-owned clangd (docs/specs/archive/2026-10-08-language-coverage.md §7):
 * B3 F12 / hover / breadcrumbs from `main.cpp` into `greet.hpp`/`greet.cpp` with a
 * compile_commands.json; B7 a `.h` (language `c`) beside them is served by the SAME clangd —
 * one record, one pid. That didOpen carries `c` for the `.h` is lsp-manager.test.ts's half.
 *
 * Needs clangd (LLVM). The host finds it in %ProgramFiles%\LLVM\bin without PATH, as CI leaves it.
 * Fails, never skips, when it is missing.
 * Run: node test/e2e/run-smoke.mjs clangd-lsp   (needs `npm run build` first)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CPP_GREET_CALL, clangdInstalled, writeClangdFixture } from './clangd-fixture.mjs';
import { clearTransients, openDoc, placeCursor } from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';
import {
  breadcrumbWith,
  endsWith,
  hoverText,
  lsp,
  trustViaHost,
  waitDefinition,
  waitObserved,
  waitServerState,
} from './lsp-fixture.mjs';

const READY_CEILING_MS = 60_000;
const GREET_FILE = /greet\.(hpp|cpp)$/i;

runScenario('clangd-lsp', async ({ app, page, log }) => {
  assert(clangdInstalled(), 'clangd-lsp e2e needs clangd: winget install LLVM.LLVM');
  const dir = mkdtempSync(join(tmpdir(), 'conduit-cpp-'));
  const fx = writeClangdFixture(dir);
  const sid = await openSession(page, { path: dir });
  await trustViaHost(page, fx.main, 'cpp', log);

  // ── B3 ──
  await openDoc(app, page, sid, fx.main);
  const live = await waitServerState(page, 'cpp', 'ready', log, READY_CEILING_MS);
  const def = await waitDefinition(
    page,
    fx.main,
    CPP_GREET_CALL.line,
    CPP_GREET_CALL.character,
    log,
    60_000,
  );
  assert(
    def.locations.some((l) => GREET_FILE.test(l.path)),
    `definition → ${JSON.stringify(def.locations)}`,
  );

  await openDoc(app, page, sid, fx.main);
  await clearTransients(page);
  await placeCursor(page, fx.main, 'greet(2)');
  await page.keyboard.press('F12');
  const f12 = await waitObserved(page, (o) => GREET_FILE.test(o.path ?? ''), 30_000);
  log(`F12 greet → ${f12.path}:${f12.line} "${f12.lineText}" toasts=${JSON.stringify(f12.toasts)}`);
  assert(GREET_FILE.test(f12.path ?? ''), `F12 landed in ${f12.path}`);
  assert(f12.lineText.includes('int greet'), `caret line is "${f12.lineText}"`);

  await openDoc(app, page, sid, fx.main);
  const hover = await hoverText(page, fx.main, 'greet(2)', 'greet');
  log(`hover greet → ${JSON.stringify(hover)}`);
  assert(
    hover?.includes('int greet(int n)'),
    `hover lacks the signature: ${JSON.stringify(hover)}`,
  );

  await placeCursor(page, fx.main, 'return greet');
  const crumbs = await breadcrumbWith(page, 'main');
  log(`breadcrumb symbols → ${JSON.stringify(crumbs)}`);
  assert(crumbs, 'the breadcrumb bar never showed the function main');
  log('B3 C++ F12 / hover / breadcrumbs ✓');

  // ── B7: the .h joins the same clangd ──
  await openDoc(app, page, sid, fx.header);
  const headerLang = await page.evaluate(
    (p) =>
      window.monaco.editor
        .getModels()
        .find((m) => m.uri.path.toLowerCase() === `/${p.toLowerCase()}`)
        ?.getLanguageId() ?? null,
    fx.header.replace(/\\/g, '/'),
  );
  assert(headerLang === 'c', `util.h opened as ${headerLang}`);
  await page.waitForTimeout(1_000);
  const snap = await lsp(page, { type: 'lsp:statusSnapshot' });
  const clangd = snap.servers.filter((s) => s.languageId === 'cpp');
  log(`clangd records with util.h open → ${JSON.stringify(clangd)}`);
  assert(
    clangd.length === 1 && clangd[0].pid === live.pid,
    `.h and .cpp should share clangd pid ${live.pid}: ${JSON.stringify(clangd)}`,
  );
  await openDoc(app, page, sid, fx.main);
  await clearTransients(page);
  await placeCursor(page, fx.main, 'twice(1)');
  await page.keyboard.press('F12');
  const tw = await waitObserved(page, (o) => endsWith(o.path, 'util.h'), 30_000);
  log(`F12 twice → ${tw.path}:${tw.line} "${tw.lineText}"`);
  assert(endsWith(tw.path, 'util.h'), `F12 twice landed in ${tw.path}`);
  log('B7 .h and .cpp: one clangd process ✓');
});

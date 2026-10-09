/**
 * Rust navigation through a host-owned rust-analyzer (docs/specs/archive/2026-10-08-language-coverage.md
 * §7): B3 F12 / hover / breadcrumbs across a two-member workspace served by ONE rust-analyzer
 * rooted at the workspace; B5 a `.rs` under no Cargo.toml gets the "not in a project" outcome.
 *
 * Not measured here: AC-B4 (no `cargo check` on edit or save). Conduit sends no didSave, so no
 * save can trigger flycheck; that is pinned in lsp-server.test.ts / lsp-manager.test.ts, and
 * `checkOnSave:false` is defence in depth.
 *
 * Needs rust-analyzer: `rustup component add rust-analyzer`. Fails, never skips, when missing.
 * Run: node test/e2e/run-smoke.mjs rust-lsp   (needs `npm run build` first)
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
import { RS_GREET_CALL, writeRustFixture } from './rust-fixture.mjs';

const READY_CEILING_MS = 90_000;
const NO_ROOT_TOAST = 'Rust navigation works for files inside an open project.';

runScenario('rust-lsp', async ({ app, page, log }) => {
  assert(
    serverInstalled('rust-analyzer', ['--version']),
    'rust-lsp e2e needs rust-analyzer: rustup component add rust-analyzer',
  );
  const dir = mkdtempSync(join(tmpdir(), 'conduit-rs-'));
  const fx = writeRustFixture(dir);
  const sid = await openSession(page, { path: dir });
  await trustViaHost(page, fx.main, 'rust', log);

  // ── B3: one rust-analyzer for both members, rooted at the workspace ──
  await openDoc(app, page, sid, fx.main);
  await openDoc(app, page, sid, fx.lib);
  await waitServerState(page, 'rust', 'ready', log, READY_CEILING_MS);
  const def = await waitDefinition(
    page,
    fx.main,
    RS_GREET_CALL.line,
    RS_GREET_CALL.character,
    log,
    90_000,
  );
  assert(
    def.locations.some((l) => endsWith(l.path, 'lib.rs') && l.range.start.line === 1),
    `definition → ${JSON.stringify(def.locations)}`,
  );
  const snap = await lsp(page, { type: 'lsp:statusSnapshot' });
  const rust = snap.servers.filter((s) => s.languageId === 'rust');
  log(`rust servers → ${JSON.stringify(rust)}`);
  assert(
    rust.length === 1 && rust[0].root.toLowerCase() === fx.ws.toLowerCase(),
    `expected one rust-analyzer rooted at ${fx.ws}: ${JSON.stringify(rust)}`,
  );

  await openDoc(app, page, sid, fx.main);
  await clearTransients(page);
  await placeCursor(page, fx.main, 'greet(');
  await page.keyboard.press('F12');
  const f12 = await waitObserved(page, (o) => endsWith(o.path, 'lib.rs'), 30_000);
  log(`F12 greet → ${f12.path}:${f12.line} "${f12.lineText}" toasts=${JSON.stringify(f12.toasts)}`);
  assert(endsWith(f12.path, 'lib.rs'), `F12 landed in ${f12.path}`);
  assert(f12.lineText.includes('pub fn greet'), `caret line is "${f12.lineText}"`);

  await openDoc(app, page, sid, fx.main);
  const hover = await hoverText(page, fx.main, 'greet(', 'greet');
  log(`hover greet → ${JSON.stringify(hover)}`);
  assert(
    hover?.includes('pub fn greet(name: &str) -> String'),
    `hover lacks the signature: ${JSON.stringify(hover)}`,
  );

  await placeCursor(page, fx.main, 'println');
  const crumbs = await breadcrumbWith(page, 'main');
  log(`breadcrumb symbols → ${JSON.stringify(crumbs)}`);
  assert(crumbs, 'the breadcrumb bar never showed the function main');
  log('B3 Rust F12 / hover / breadcrumbs, one server for the workspace ✓');

  // ── B5: a detached .rs is not in any project ──
  await openDoc(app, page, sid, fx.detached);
  await clearTransients(page);
  await placeCursor(page, fx.detached, 'lonely()', 1);
  await page.keyboard.press('F12');
  const r = await waitObserved(page, (o) => o.toasts.includes(NO_ROOT_TOAST), 8_000);
  log(`F12 in detached/x.rs → toasts ${JSON.stringify(r.toasts)}`);
  assert(r.toasts.includes(NO_ROOT_TOAST), `detached .rs toasts: ${JSON.stringify(r.toasts)}`);
  log('B5 detached .rs → not in a project ✓');
});

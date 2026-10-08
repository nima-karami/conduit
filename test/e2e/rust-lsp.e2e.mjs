/**
 * Rust navigation through a host-owned rust-analyzer (docs/specs/2026-10-08-language-coverage.md
 * §7): B3 F12 / hover / breadcrumbs across a two-member workspace served by ONE rust-analyzer
 * rooted at the workspace; B4 once it has settled, saving a `.rs` spawns no `cargo`
 * (`checkOnSave:false`); B5 a `.rs` under no Cargo.toml gets the "not in a project" outcome.
 *
 * Needs rust-analyzer: `rustup component add rust-analyzer`. Fails, never skips, when missing.
 * Run: node test/e2e/run-smoke.mjs rust-lsp   (needs `npm run build` first)
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTransients, openDoc, placeCursor } from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';
import {
  breadcrumbWith,
  endsWith,
  hoverText,
  lsp,
  recordTree,
  serverInstalled,
  trustViaHost,
  waitDefinition,
  waitObserved,
  waitServerState,
} from './lsp-fixture.mjs';
import { RS_GREET_CALL, writeRustFixture } from './rust-fixture.mjs';

const READY_CEILING_MS = 90_000;
const CARGO = /^cargo(\.exe)?$/i;
const NO_ROOT_TOAST = 'Rust navigation works for files inside an open project.';

const cargoDescendants = (pid) => recordTree(pid).filter((p) => CARGO.test(p.name));

/** Polls the server's tree until no cargo descendant has existed for `quietMs`. */
async function waitCargoQuiet(pid, quietMs, capMs, log) {
  const t0 = Date.now();
  let quietSince = Date.now();
  while (Date.now() - t0 < capMs) {
    if (cargoDescendants(pid).length > 0) quietSince = Date.now();
    if (Date.now() - quietSince >= quietMs) {
      log(
        `no cargo under rust-analyzer for ${quietMs / 1000}s (after ${((Date.now() - t0) / 1000).toFixed(1)}s)`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert(false, `rust-analyzer kept a cargo descendant for ${capMs / 1000}s`);
}

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
  const live = await waitServerState(page, 'rust', 'ready', log, READY_CEILING_MS);
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

  // ── B4: a save runs no cargo once the startup build-script pass is over ──
  await waitCargoQuiet(live.pid, 10_000, 90_000, log);
  await openDoc(app, page, sid, fx.main);
  await placeCursor(page, fx.main, 'fn main');
  await page.keyboard.press('End');
  await page.keyboard.type(' // edited');
  await page.keyboard.press('Control+S');
  const t0 = Date.now();
  while (!readFileSync(fx.main, 'utf8').includes('// edited') && Date.now() - t0 < 5_000) {
    await page.waitForTimeout(100);
  }
  assert(readFileSync(fx.main, 'utf8').includes('// edited'), 'main.rs was not saved');
  const seen = new Set();
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    for (const p of cargoDescendants(live.pid)) seen.add(`${p.name}:${p.pid}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(seen.size === 0, `saving a .rs spawned cargo: ${[...seen].join(', ')}`);
  log('B4 save → no cargo descendant within 10 s ✓');

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

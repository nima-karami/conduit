/**
 * AC-C3 (docs/specs/2026-10-08-language-coverage.md §2.6): with rust-analyzer evicted (the
 * lsp-residency setup), rename the called function in BOTH `.rs` tabs and move its definition
 * down five lines, without saving; show the caller and F12: rust-analyzer relaunches — evicting
 * clangd, hidden > 60 s by then — and the caret lands on the definition's EDITED line, which only
 * a didOpen replay of the unsaved text can produce.
 *
 * Needs rust-analyzer, clangd and csharp-ls. Fails, never skips, when one is missing.
 * Run: node test/e2e/run-smoke.mjs lsp-residency-replay   (needs `npm run build` first)
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clangdInstalled, writeClangdFixture } from './clangd-fixture.mjs';
import { csharpLsInstalled, writeCsharpFixture } from './csharp-fixture.mjs';
import { clearTransients, openDoc, placeCursor } from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';
import {
  EVICT_MIN_HIDDEN_MS,
  endsWith,
  liveServers,
  reachRustEvicted,
  serverInstalled,
  sleep,
  trustViaHost,
  waitObserved,
} from './lsp-fixture.mjs';
import { writeRustFixture } from './rust-fixture.mjs';

/** Edits the model of a tab that is open but not shown (no editor is mounted on it): `prepend`
 *  first, then `from` → `to`. Returns the 1-based line `to` ends up on, or null with no model. */
function editHiddenTab(page, absPath, { prepend = '', from, to }) {
  return page.evaluate(
    ({ path, prepend, from, to }) => {
      const model = window.monaco.editor
        .getModels()
        .find((m) => m.uri.path.toLowerCase() === `/${path.toLowerCase()}`);
      if (!model) return null;
      model.setValue(prepend + model.getValue().replace(from, to));
      return (
        model
          .getValue()
          .split('\n')
          .findIndex((l) => l.includes(to)) + 1
      );
    },
    { path: absPath.replace(/\\/g, '/'), prepend, from, to },
  );
}

const lineOf = (file, needle) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .findIndex((l) => l.includes(needle)) + 1;

runScenario('lsp-residency-replay', async ({ app, page, log }) => {
  assert(
    serverInstalled('rust-analyzer', ['--version']) && clangdInstalled() && csharpLsInstalled(),
    'lsp-residency-replay e2e needs rust-analyzer, clangd and csharp-ls installed',
  );
  const dir = mkdtempSync(join(tmpdir(), 'conduit-residency-replay-'));
  const fx = {
    rs: writeRustFixture(join(dir, 'rs')),
    cpp: writeClangdFixture(join(dir, 'cpp')),
    cs: writeCsharpFixture(join(dir, 'cs')),
  };
  const sid = await openSession(page, { path: dir });
  await trustViaHost(page, fx.rs.main, 'rust', log);
  const { shownCs, cpp } = await reachRustEvicted(app, page, sid, fx, log);

  // The edit MOVES the definition: a server answering from the disk text lands on the disk line,
  // so only a replay of the unsaved buffers can put the caret on the edited one.
  const diskLine = lineOf(fx.rs.lib, 'pub fn greet(');
  const editedLine = await editHiddenTab(page, fx.rs.lib, {
    prepend: '// moved\n'.repeat(5),
    from: 'pub fn greet(',
    to: 'pub fn greet2(',
  });
  assert(editedLine !== null, 'no lib.rs model');
  assert(
    (await editHiddenTab(page, fx.rs.main, { from: 'util::greet(', to: 'util::greet2(' })) !== null,
    'no main.rs model',
  );
  assert(editedLine !== diskLine, `the edit did not move the definition (line ${diskLine})`);
  log(
    `unsaved, while rust-analyzer is evicted: greet → greet2 in both .rs tabs, definition moved from line ${diskLine} to ${editedLine}`,
  );
  // clangd was hidden when .cs was shown; past the hysteresis it is the evictable heavy.
  await sleep(Math.max(0, shownCs + EVICT_MIN_HIDDEN_MS + 1_000 - Date.now()));

  await openDoc(app, page, sid, fx.rs.main);
  const t0 = Date.now();
  let cppLeft = [];
  let rust = [];
  while (Date.now() - t0 < 20_000) {
    rust = await liveServers(page, 'rust');
    cppLeft = await liveServers(page, 'cpp');
    if (rust.length > 0 && cppLeft.length === 0) break;
    await sleep(250);
  }
  log(`after showing .rs: rust ${JSON.stringify(rust)} cpp ${JSON.stringify(cppLeft)}`);
  assert(rust.length === 1, 'rust-analyzer did not relaunch when its tab was shown');
  assert(cppLeft.length === 0, `clangd ${cpp} (hidden > 60 s) was not evicted for it`);

  let landed = null;
  while (!landed && Date.now() - t0 < 90_000) {
    await openDoc(app, page, sid, fx.rs.main);
    await clearTransients(page);
    await placeCursor(page, fx.rs.main, 'greet2');
    await page.keyboard.press('F12');
    const r = await waitObserved(page, (o) => endsWith(o.path, 'lib.rs'), 10_000);
    if (endsWith(r.path, 'lib.rs')) landed = r;
  }
  log(`F12 greet2 → ${landed ? `${landed.path}:${landed.line} "${landed.lineText}"` : 'never'}`);
  assert(landed, 'F12 on greet2 never reached lib.rs');
  assert(
    landed.line === editedLine,
    `F12 landed on line ${landed.line}; the edited definition is on ${editedLine}, the disk one on ${diskLine}`,
  );
  log('AC-C3: relaunch replayed the unsaved edits; F12 landed on the edited definition ✓');
});

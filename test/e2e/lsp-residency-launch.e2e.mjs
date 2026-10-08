/**
 * AC-C5 (docs/specs/2026-10-08-language-coverage.md §2.6): a session restored with `.py` and `.rs`
 * tabs but the Terminal tab active starts no language server; showing the `.py` tab starts
 * basedpyright. A request on the never-shown `.rs` then starts rust-analyzer, which proves the
 * restored tabs did reach the host — registered, just not launched.
 *
 * Needs basedpyright and rust-analyzer. Fails, never skips, when one is missing.
 * Run: node test/e2e/run-smoke.mjs lsp-residency-launch   (needs `npm run build` first)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openDoc } from './goto-matrix.mjs';
import { assert, closeApp, launchApp, openSession, runScenario, tapBridge } from './harness.mjs';
import { liveServers, lsp, serverInstalled, sleep, trustViaHost } from './lsp-fixture.mjs';
import { writePythonFixture } from './python-fixture.mjs';
import { writeRustFixture } from './rust-fixture.mjs';

async function waitLive(page, languageId, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const live = await liveServers(page, languageId);
    if (live.length > 0) {
      return { at: Date.now() - t0, status: live[0] };
    }
    await sleep(100);
  }
  return null;
}

runScenario('lsp-residency-launch', async ({ app, page, log }) => {
  assert(
    serverInstalled('where', ['basedpyright-langserver']) &&
      serverInstalled('rust-analyzer', ['--version']),
    'lsp-residency-launch e2e needs basedpyright and rust-analyzer installed',
  );
  const dir = mkdtempSync(join(tmpdir(), 'conduit-residency-launch-'));
  const py = writePythonFixture(join(dir, 'py'));
  const rs = writeRustFixture(join(dir, 'rs'));
  const sid = await openSession(page, { path: dir });
  await trustViaHost(page, py.main, 'python', log);
  await openDoc(app, page, sid, py.main);
  await openDoc(app, page, sid, rs.main);
  await page.locator('.tabbar [data-tabid="__terminal__"]').click();
  // Lets the debounced docs.json write land before the quit.
  await page.waitForTimeout(800);
  const profile = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  await closeApp(app, page);

  const second = await launchApp({ userDataDir: profile });
  try {
    const p2 = second.page;
    await tapBridge(p2);
    await p2.waitForFunction((id) => (window.__sessions || []).some((s) => s.id === id), sid, {
      timeout: 45_000,
    });
    // The launch folder's own session opens active; ours is selected the way a user would.
    const name = basename(dir);
    await p2.waitForSelector(`.session:has-text("${name}")`, { timeout: 20_000 });
    await p2.locator('.session', { hasText: name }).first().click();
    const pyTab = p2.locator('.tabbar [role="tab"]', { hasText: 'main.py' });
    await pyTab.waitFor({ state: 'visible', timeout: 20_000 });
    await p2.waitForFunction(
      () =>
        document
          .querySelector('.tabbar [data-tabid="__terminal__"]')
          ?.getAttribute('aria-pressed') === 'true',
      null,
      { timeout: 10_000 },
    );
    log('restored session selected: .py + .rs tabs, Terminal active');

    const t0 = Date.now();
    while (Date.now() - t0 < 5_000) {
      const started = [...(await liveServers(p2, 'python')), ...(await liveServers(p2, 'rust'))];
      assert(
        started.length === 0,
        `a server started for a tab nobody shows: ${JSON.stringify(started)}`,
      );
      await sleep(250);
    }
    log('5 s with only the Terminal shown: no python or rust server ✓');

    await pyTab.click();
    const py2 = await waitLive(p2, 'python', 10_000);
    log(`python after the .py tab was shown → ${JSON.stringify(py2)}`);
    assert(py2, 'basedpyright did not start within 10 s of showing the .py tab');
    assert((await liveServers(p2, 'rust')).length === 0, 'showing .py started rust-analyzer');

    // Not awaited: a definition waits out the whole load; only the launch it causes matters.
    void lsp(p2, {
      type: 'lsp:request',
      requestId: 'wake-rs',
      path: rs.main,
      version: 1,
      op: 'definition',
      line: 0,
      character: 0,
    }).catch(() => null);
    const rs2 = await waitLive(p2, 'rust', 10_000);
    log(`rust after a request on the hidden .rs tab → ${JSON.stringify(rs2)}`);
    assert(rs2, 'the restored .rs tab never reached the host: the 5 s check proved nothing');
    log('AC-C5: no server until a served file is shown ✓');
  } finally {
    await second.cleanup();
  }
});

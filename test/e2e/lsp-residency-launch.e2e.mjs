/**
 * AC-C5 (docs/specs/archive/2026-10-08-language-coverage.md §2.6): a session restored with `.py` and `.rs`
 * tabs but the Terminal tab active starts no language server, even once the host has registered
 * both hidden tabs (proved first, from its lsp:open answers); showing the `.py` tab starts
 * basedpyright, and a request on the never-shown `.rs` starts rust-analyzer.
 *
 * Needs basedpyright and rust-analyzer. Fails, never skips, when one is missing.
 * Run: node test/e2e/run-smoke.mjs lsp-residency-launch   (needs `npm run build` first)
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openDoc } from './goto-matrix.mjs';
import { assert, closeApp, launchApp, openSession, runScenario, tapBridge } from './harness.mjs';
import { assertInstalled, liveServers, lsp, probeServer, trustViaHost } from './lsp-fixture.mjs';
import { writePythonFixture } from './python-fixture.mjs';
import { writeRustFixture } from './rust-fixture.mjs';

async function waitHost(page, mode, paths, ms) {
  await page.evaluate(() => {
    window.__residencyPoll = { pending: false, value: null, error: null };
  });
  try {
    const handle = await page.waitForFunction(
      ({ mode, paths }) => {
        const state = window.__residencyPoll;
        if (state.error) throw new Error(state.error);
        const value =
          mode === 'held'
            ? state.value?.every((reply) => reply.kind === 'stale') && paths
            : state.value?.servers?.find(
                (s) =>
                  (mode === 'any'
                    ? ['python', 'rust'].includes(s.languageId)
                    : s.languageId === mode) &&
                  ['starting', 'loading', 'ready', 'restarting'].includes(s.state),
              );
        if (value) return value;
        if (!state.pending) {
          state.pending = true;
          const request =
            mode === 'held'
              ? Promise.all(
                  paths.map((path, i) =>
                    window.agentDeck.lsp({
                      type: 'lsp:request',
                      requestId: `held-${Date.now()}-${i}`,
                      path,
                      version: 999_999,
                      op: 'documentSymbol',
                      line: 0,
                      character: 0,
                    }),
                  ),
                )
              : window.agentDeck.lsp({ type: 'lsp:statusSnapshot' });
          request.then(
            (value) => {
              state.value = value;
              state.pending = false;
            },
            (error) => {
              state.error = String(error);
            },
          );
        }
        return false;
      },
      { mode, paths },
      { timeout: ms },
    );
    return await handle.jsonValue();
  } catch (error) {
    if (error.name === 'TimeoutError') return null;
    throw error;
  }
}

async function waitLive(page, languageId, ms) {
  const t0 = Date.now();
  const status = await waitHost(page, languageId, [], ms);
  return status ? { at: Date.now() - t0, status } : null;
}

runScenario('lsp-residency-launch', async ({ app, page, log }) => {
  assertInstalled(
    [
      ['basedpyright-langserver', probeServer('where', ['basedpyright-langserver'])],
      ['rust-analyzer', probeServer('rust-analyzer', ['--version'])],
    ],
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
  const profile = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const docsPath = join(profile, 'docs.json');
  const docsSaved = await new Promise((resolve) => {
    const signal = AbortSignal.timeout(800);
    const watcher = watch(profile, { signal });
    let settled = false;
    const finish = (saved) => {
      if (settled) return;
      settled = true;
      watcher.close();
      resolve(saved);
    };
    const inspect = () => {
      if (!existsSync(docsPath)) return;
      try {
        const docs = JSON.parse(readFileSync(docsPath, 'utf8')).docs;
        const paths = new Set(docs?.map((doc) => doc.path.replace(/\\/g, '/')) ?? []);
        if (
          paths.has(py.main.replace(/\\/g, '/')) &&
          paths.has(rs.main.replace(/\\/g, '/')) &&
          !docs.some((doc) => doc.sessionId === sid && doc.active)
        )
          finish(true);
      } catch {
        // An atomic write may replace the file between existence and read.
      }
    };
    watcher.on('change', inspect);
    watcher.on('rename', inspect);
    watcher.on('error', () => finish(false));
    signal.addEventListener('abort', () => finish(false), { once: true });
    inspect();
  });
  assert(docsSaved, 'docs.json did not persist both open language tabs');
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
    // A restored tab is not read until shown, so nothing would reach the host and the check below
    // would hold with or without residency. A change on disk makes the app re-read both hidden
    // tabs, which syncs them — the case that used to launch a server per tab.
    appendFileSync(py.main, '\n# touched\n');
    appendFileSync(rs.main, '\n// touched\n');
    const held = (await waitHost(p2, 'held', [py.main, rs.main], 15_000)) ?? [];
    log(`host holds the hidden tabs → ${JSON.stringify(held)}`);
    assert(
      held.length === 2,
      'the hidden .py/.rs tabs never reached the host; the check below would prove nothing',
    );

    const started = await waitHost(p2, 'any', [], 5_000);
    assert(!started, `a server started for a tab nobody shows: ${JSON.stringify(started)}`);
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
    }).catch((e) => log(`hidden .rs request failed: ${String(e)}`));
    const rs2 = await waitLive(p2, 'rust', 10_000);
    log(`rust after a request on the hidden .rs tab → ${JSON.stringify(rs2)}`);
    assert(rs2, 'a request on the registered, hidden .rs tab did not start rust-analyzer');
    log('AC-C5: no server until a served file is shown ✓');
  } finally {
    await second.cleanup();
  }
});

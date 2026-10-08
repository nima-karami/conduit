/**
 * B4 (docs/specs/2026-10-08-language-support.md §7): once the last .cs tab closes, csharp-ls and
 * every descendant (MSBuild build hosts) stop within IDLE_GRACE_MS + 10 s. Split from csharp-lsp
 * because the idle wait and the server load don't both fit one 200 s scenario deadline.
 *
 * Needs csharp-ls and a .NET 10 SDK: `dotnet tool install --global csharp-ls`.
 * Run: node test/e2e/run-smoke.mjs csharp-lsp-idle   (needs `npm run build` first)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  csharpLsInstalled,
  lsp,
  READY_CEILING_MS,
  recordTree,
  restoreFixture,
  survivorsAfter,
  trustViaHost,
  waitCsState,
  writeCsharpFixture,
} from './csharp-fixture.mjs';
import { closeAllDocs, openDoc } from './goto-matrix.mjs';
import { assert, openSession, runScenario } from './harness.mjs';

/** electron/lsp-manager.ts IDLE_GRACE_MS, plus the AC's 10 s. */
const STOP_CEILING_MS = 60_000 + 10_000;

runScenario('csharp-lsp-idle', async ({ app, page, log }) => {
  assert(
    csharpLsInstalled(),
    'csharp-lsp-idle e2e needs csharp-ls: dotnet tool install --global csharp-ls',
  );
  const dir = mkdtempSync(join(tmpdir(), 'conduit-cs-idle-'));
  const { program } = writeCsharpFixture(dir);
  restoreFixture(dir, log);
  const sid = await openSession(page, { path: dir });
  await trustViaHost(page, program, log);

  await openDoc(app, page, sid, program);
  const live = await waitCsState(page, 'ready', log, READY_CEILING_MS);
  const tree = recordTree(live.pid);
  log(`csharp-ls tree: ${tree.map((p) => `${p.name}:${p.pid}`).join(', ')}`);

  await closeAllDocs(page);
  const t0 = Date.now();
  let held = true;
  while (held && Date.now() - t0 < STOP_CEILING_MS) {
    await page.waitForTimeout(1_000);
    const snap = await lsp(page, { type: 'lsp:statusSnapshot' });
    held = snap.servers.some((s) => s.languageId === 'csharp' && s.state !== 'stopped');
  }
  const stoppedAfter = (Date.now() - t0) / 1000;
  log(`csharp server released after ${stoppedAfter.toFixed(1)}s`);
  assert(!held, `csharp-ls still held ${STOP_CEILING_MS / 1000}s after its last tab closed`);
  const left = await survivorsAfter(tree, 5_000);
  assert(left.length === 0, `csharp-ls tree alive after the idle stop: ${JSON.stringify(left)}`);
  log('B4 idle stop: csharp-ls and its descendants gone after the last .cs tab closed ✓');
});

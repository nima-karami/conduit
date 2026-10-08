/**
 * AC-C1 (docs/specs/2026-10-08-language-coverage.md §2.6): show `.rs` (t0), show `.cpp` (t1), and
 * once `.rs` has been hidden 61 s open `.cs` from the `.cpp` tab. rust-analyzer — the LRU, hidden
 * past the 60 s hysteresis — is evicted; clangd, hidden ~0 s, is kept; csharp-ls starts. At every
 * 250 ms sample from t0 on, never more than 2 heavy server pids are alive (an evictee still
 * exiting counts).
 *
 * Needs rust-analyzer, clangd and csharp-ls. Fails, never skips, when one is missing.
 * Run: node test/e2e/run-smoke.mjs lsp-residency   (needs `npm run build` first)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clangdInstalled, writeClangdFixture } from './clangd-fixture.mjs';
import { csharpLsInstalled, writeCsharpFixture } from './csharp-fixture.mjs';
import { assert, openSession, runScenario } from './harness.mjs';
import { heavySampler, reachRustEvicted, serverInstalled, trustViaHost } from './lsp-fixture.mjs';
import { writeRustFixture } from './rust-fixture.mjs';

runScenario('lsp-residency', async ({ app, page, log }) => {
  assert(
    serverInstalled('rust-analyzer', ['--version']) && clangdInstalled() && csharpLsInstalled(),
    'lsp-residency e2e needs rust-analyzer, clangd and csharp-ls installed',
  );
  const dir = mkdtempSync(join(tmpdir(), 'conduit-residency-'));
  const fx = {
    rs: writeRustFixture(join(dir, 'rs')),
    cpp: writeClangdFixture(join(dir, 'cpp')),
    cs: writeCsharpFixture(join(dir, 'cs')),
  };
  const sid = await openSession(page, { path: dir });
  await trustViaHost(page, fx.rs.main, 'rust', log);

  const sampler = heavySampler(page, log);
  let result;
  try {
    await reachRustEvicted(app, page, sid, fx, log);
    // Long enough for a late spawn or a slow evictee to show up in the samples.
    await new Promise((r) => setTimeout(r, 3_000));
  } finally {
    result = await sampler.stop();
  }
  log(
    `heavy pids seen ${JSON.stringify(result.pids)}; max alive at once ${result.maxAlive} over ${result.samples} samples`,
  );
  assert(result.samples > 100, `too few samples to mean anything: ${result.samples}`);
  assert(
    new Set(result.pids.map(([, l]) => l)).size === 3,
    `the sampler never saw all three heavy servers: ${JSON.stringify(result.pids)}`,
  );
  assert(result.maxAlive <= 2, `${result.maxAlive} heavy server pids were alive at once`);
  log('AC-C1: LRU evicted, hysteresis kept clangd, never more than 2 heavy pids ✓');
});

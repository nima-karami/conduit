/**
 * Smoke test runner — discovers test/e2e/*.e2e.mjs and runs each sequentially
 * as a child process, printing PASS / FAIL / SKIP per scenario + a final summary.
 *
 * Exit codes:
 *   0 — all scenarios passed or skipped
 *   1 — at least one scenario failed
 *
 * On non-win32 platforms prints a suite-level SKIP and exits 0.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Settle delay between scenarios: gives the prior Electron process time to fully
 *  release GPU/ConPTY handles and let the CPU quiesce before the next launch. */
const SETTLE_MS = 3000;

const here = dirname(fileURLToPath(import.meta.url));

if (process.platform !== 'win32') {
  console.log('[smoke] SKIP (suite is Windows-only)');
  process.exit(0);
}

// Discover all *.e2e.mjs files, sorted alphabetically for deterministic order.
const scenarios = readdirSync(here)
  .filter((f) => f.endsWith('.e2e.mjs'))
  .sort()
  .map((f) => join(here, f));

if (scenarios.length === 0) {
  console.log('[smoke] No *.e2e.mjs scenarios found — nothing to run.');
  process.exit(0);
}

console.log(`[smoke] Running ${scenarios.length} scenario(s) sequentially...\n`);

const results = [];

for (const scenarioPath of scenarios) {
  const name = scenarioPath.replace(/.*[/\\]/, '').replace('.e2e.mjs', '');
  process.stdout.write(`  ${name} ... `);

  const start = Date.now();
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', scenarioPath], {
    cwd: join(here, '..', '..'),
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 210_000, // 3.5-minute per-scenario guard (headroom for 120s paste READY + margin)
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  let status;
  if (result.status === 0) {
    // Distinguish SKIP (the scenario printed SKIP) from PASS.
    const combined = (result.stdout || '') + (result.stderr || '');
    if (/\bSKIP\b/.test(combined)) {
      status = 'SKIP';
    } else {
      status = 'PASS';
    }
  } else if (result.status === 1) {
    status = 'FAIL';
  } else if (result.status === 2) {
    status = 'ERROR';
  } else if (result.signal || result.error?.code === 'ETIMEDOUT') {
    status = 'TIMEOUT';
  } else {
    status = `EXIT(${result.status ?? '?'})`;
  }

  const icon = status === 'PASS' ? '✓' : status === 'SKIP' ? '○' : '✗';
  console.log(`${icon} ${status} (${elapsed}s)`);

  // Print scenario output only on failure / error / timeout for brevity.
  if (!['PASS', 'SKIP'].includes(status)) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  results.push({ name, status, elapsed });

  // Settle: give the prior Electron process time to fully release GPU/ConPTY
  // handles before the next scenario launches.  Avoids in-suite flakiness on
  // Windows where back-to-back real-Electron launches contend for resources.
  // Skip settle after the last scenario.
  if (scenarioPath !== scenarios[scenarios.length - 1]) {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }
}

// Summary
console.log('\n── Summary ──────────────────────────────────────');
const counts = { PASS: 0, SKIP: 0, FAIL: 0, ERROR: 0, TIMEOUT: 0 };
for (const r of results) {
  const key = Object.hasOwn(counts, r.status) ? r.status : 'ERROR';
  counts[key]++;
}
console.log(
  `  ${counts.PASS} passed  ${counts.SKIP} skipped  ${counts.FAIL} failed  ${counts.ERROR + counts.TIMEOUT} errors`,
);
console.log('─────────────────────────────────────────────────\n');

const anyFailed = counts.FAIL > 0 || counts.ERROR > 0 || counts.TIMEOUT > 0;
process.exit(anyFailed ? 1 : 0);

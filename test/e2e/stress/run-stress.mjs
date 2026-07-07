/**
 * Stress/load lane runner — discovers test/e2e/stress/*.stress.mjs and runs each as a child
 * process, HIDDEN (CONDUIT_E2E=1), Windows-only. Separate from `npm run test:smoke` (which
 * globs the top-level test/e2e/*.e2e.mjs) and NOT wired into `npm run verify` — perf numbers
 * are environment-sensitive and this drives a real GUI, exactly like the smoke suite.
 *
 * Usage:
 *   node test/e2e/stress/run-stress.mjs            # whole lane
 *   node test/e2e/stress/run-stress.mjs arch       # only scenarios matching a filter term
 *
 * Each scenario emits `##PERF## {json}` lines (harness-stress.emitReport). This runner parses
 * them, prints a summary table, and writes docs/runs/2026-07-07-stress-load/baseline.json.
 *
 * Gating: a scenario FAILS the lane only on a broken structural INVARIANT (exit 1) or an
 * infra error (exit 2 / timeout). The advisory timing numbers never fail the run.
 *
 * Exit codes: 0 — all passed/skipped; 1 — at least one scenario failed or errored.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTLE_MS = 3000;
const PER_SCENARIO_TIMEOUT_MS = 420_000; // load scenarios do real work (10k files, 500 nodes…)

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

if (process.platform !== 'win32') {
  console.log('[stress] SKIP (lane is Windows-only)');
  process.exit(0);
}

const filters = process.argv.slice(2).map((t) => t.toLowerCase());

const scenarios = readdirSync(here)
  .filter((f) => f.endsWith('.stress.mjs'))
  .filter((f) => {
    if (filters.length === 0) return true;
    const name = f.replace('.stress.mjs', '').toLowerCase();
    return filters.some((t) => name.includes(t));
  })
  .sort()
  .map((f) => ({ name: f.replace('.stress.mjs', ''), path: join(here, f) }));

if (scenarios.length === 0) {
  const suffix = filters.length ? ` matching [${filters.join(', ')}]` : '';
  console.log(`[stress] No *.stress.mjs scenarios found${suffix} — nothing to run.`);
  process.exit(filters.length ? 1 : 0);
}

const scope = filters.length ? ` (filter: ${filters.join(', ')})` : '';
console.log(`[stress] Running ${scenarios.length} scenario(s) sequentially${scope}...\n`);

const results = [];
const perfRows = [];

for (const { name, path } of scenarios) {
  process.stdout.write(`  ${name} ... `);

  const start = Date.now();
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', path], {
    cwd: repo,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: PER_SCENARIO_TIMEOUT_MS,
    env: { ...process.env, CONDUIT_E2E: '1' },
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const combined = (result.stdout || '') + (result.stderr || '');

  // Parse the machine-readable perf lines this scenario emitted.
  for (const line of combined.split(/\r?\n/)) {
    const m = line.match(/^##PERF##\s+(.*)$/);
    if (!m) continue;
    try {
      perfRows.push(JSON.parse(m[1]));
    } catch {
      /* malformed perf line — skip */
    }
  }

  let status;
  if (result.status === 0) {
    status = /\bSKIP\b/.test(combined) ? 'SKIP' : 'PASS';
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

  // Always surface the scenario's own log lines (the human perf summaries live here), and the
  // full output on failure.
  if (['PASS', 'SKIP'].includes(status)) {
    for (const line of combined.split(/\r?\n/)) {
      if (/^\[[^\]]+\]/.test(line) && !line.startsWith('##PERF##')) console.log(`      ${line}`);
    }
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  results.push({ name, status, elapsed });

  if (path !== scenarios[scenarios.length - 1].path) {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }
}

// ── Perf baseline ────────────────────────────────────────────────────────────
if (perfRows.length > 0) {
  const outDir = join(repo, 'docs', 'runs', '2026-07-07-stress-load');
  mkdirSync(outDir, { recursive: true });
  const baseline = {
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    scenarios: perfRows,
  };
  writeFileSync(join(outDir, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);

  console.log('\n── Responsiveness (advisory) ────────────────────────────────────');
  console.log('  scenario              blockMs  maxStall  stalls  longTasks  frameGapMax');
  for (const r of perfRows) {
    const pad = (s, n) => String(s).padEnd(n);
    console.log(
      `  ${pad(r.scenario, 20)} ${pad(r.lag.totalMs, 8)} ${pad(r.lag.maxMs, 9)} ` +
        `${pad(r.lag.stalls, 7)} ${pad(`${r.longTasks.count}/${r.longTasks.totalMs}ms`, 10)} ${r.maxFrameGapMs}`,
    );
  }
  console.log('  blockMs = cumulative main-thread block (the interactivity number).');
  console.log('  (advisory — these never fail the lane; see baseline.json)');
}

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

process.exit(counts.FAIL > 0 || counts.ERROR > 0 || counts.TIMEOUT > 0 ? 1 : 0);

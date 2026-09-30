/**
 * e2e runner — runs test/e2e/<name>.e2e.mjs scenarios one at a time, each as a child process,
 * printing PASS / FAIL / SKIP / TIMEOUT / FLAKY per scenario and a summary. LOCK-TIMEOUT (local
 * only): the scenario waited on another checkout's e2e app for longer than the 20 min cap.
 *
 * Locally (`npm run e2e -- <name>`) it runs exactly ONE scenario, matched by exact file stem; the
 * suite and any multi-scenario selection run remotely (`npm run e2e:remote -- --full | <names>`),
 * because a full local run takes ~100 min of a workstation. `CONDUIT_E2E_LOCAL_FULL=1` is a
 * human-only escape hatch. On CI (GITHUB_ACTIONS) it runs whatever it is given — a shard of the
 * suite. Spec: docs/specs/2026-09-29-remote-e2e-lean-loop.md.
 *
 * Usage:
 *   node test/e2e/run-smoke.mjs <name…> [--names-file f.json] [--json out.json]
 *                                       [--artifacts dir] [--retry] [--quarantine q.json]
 *
 *   --names-file  JSON array of names, added to the positional ones
 *   --json        result rows `[{ name, status, seconds, attempts }]`, rewritten after each scenario
 *   --artifacts   failure artifacts root: each non-PASS attempt's log (and, from the harness, its
 *                 trace and screenshots) lands in <dir>/<name>/attempt-<n>/
 *   --retry       a failed or timed-out scenario runs once more; a pass then is FLAKY
 *   --quarantine  test/e2e/quarantine.json: a listed scenario that still fails is
 *                 QUARANTINED-FAIL, reported but not failing the run
 *
 * Exit codes: 0 all PASS/SKIP/FLAKY/QUARANTINED-FAIL; 1 a scenario failed; 2 usage error or local refusal.
 * On non-win32 platforms prints a suite-level SKIP and exits 0.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyQuarantine,
  classify,
  finalStatus,
  isGreen,
  killTimerOnLine,
  killTimerStart,
  orphanVictims,
  parseRunnerArgs,
  resolveSelection,
} from './smoke-select.mjs';

/** Settle delay between scenarios: gives the prior Electron process time to fully
 *  release GPU/ConPTY handles and let the CPU quiesce before the next launch. */
const SETTLE_MS = 3000;
/**
 * Runner kill. The harness watchdog (E2E_DEADLINE_MS) fires first so it can save artifacts. Its
 * clock stops while the scenario waits on the e2e lock (`killTimerOnLine`).
 */
const KILL_MS = 210_000;
const DEADLINE_MS = 200_000;

const here = dirname(fileURLToPath(import.meta.url));
/** Every app this invocation's scenarios launch carries it (harness `launchElectron`). */
const RUN_ID = `${process.pid}-${randomBytes(4).toString('hex')}`;

/**
 * Kill Electrons left behind by a scenario the runner had to kill itself. `spawnSync`'s timeout
 * only reaches the node child; the Electron it spawned survives, holding GPU/ConPTY handles and
 * CPU — which is what turns ONE wedged scenario into a run of "flaky" timeouts after it.
 *
 * Scoped to THIS invocation's apps (`orphanVictims`): another checkout's scenario may be running,
 * or holding the e2e lock, with the same temp-dir profile prefix, and a developer's own Conduit
 * carries no marker at all.
 */
function sweepOrphanElectrons() {
  if (process.platform !== 'win32') return 0;
  const script =
    `@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
    'Select-Object ProcessId, ParentProcessId, CommandLine) | ConvertTo-Json -Compress';
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  let procs;
  try {
    procs = [JSON.parse(r.stdout || '[]')].flat();
  } catch {
    return 0;
  }
  const pids = orphanVictims(procs, RUN_ID);
  for (const pid of pids) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  }
  return pids.length;
}

if (process.platform !== 'win32') {
  console.log('[smoke] SKIP (suite is Windows-only)');
  process.exit(0);
}

const args = parseRunnerArgs(process.argv.slice(2));
if (args.error) {
  console.log(`[smoke] ${args.error}`);
  process.exit(2);
}
const ci = process.env.GITHUB_ACTIONS === 'true';
const stems = readdirSync(here)
  .filter((f) => f.endsWith('.e2e.mjs'))
  .map((f) => f.replace('.e2e.mjs', ''));
const requested = [
  ...args.names,
  ...(args.namesFile ? JSON.parse(readFileSync(args.namesFile, 'utf8')) : []),
];
const selection = resolveSelection({
  names: requested,
  stems,
  ci,
  localFull: process.env.CONDUIT_E2E_LOCAL_FULL === '1',
});
if ('exit' in selection) {
  console.log(selection.message);
  process.exit(selection.exit);
}
if (selection.banner) console.log(`${selection.banner}\n`);
const names = selection.names;
const artifactsRoot = args.artifacts ? resolve(args.artifacts) : null;
const quarantine = args.quarantine ? JSON.parse(readFileSync(args.quarantine, 'utf8')) : null;

console.log(`[smoke] Running ${names.length} scenario(s) sequentially...\n`);

/**
 * One scenario attempt as a child process. Output is buffered (it is only shown for a failure),
 * except the e2e lock's lines: a scenario waiting on another checkout's run must say so live.
 */
function runAttempt(name, attempt) {
  const start = Date.now();
  const child = spawn(
    process.execPath,
    ['--experimental-vm-modules', join(here, `${name}.e2e.mjs`)],
    {
      cwd: join(here, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      // CONDUIT_E2E launches the app hidden (main.ts reads it). A scenario run directly, not
      // through this runner, still shows its window for debugging.
      env: {
        ...process.env,
        CONDUIT_E2E: '1',
        E2E_SCENARIO: name,
        E2E_RUN_ID: RUN_ID,
        E2E_ATTEMPT: String(attempt),
        E2E_DEADLINE_MS: String(DEADLINE_MS),
        ...(artifactsRoot ? { E2E_ARTIFACT_DIR: artifactsRoot } : {}),
      },
    },
  );
  const r = { stdout: '', stderr: '', status: null, signal: null };
  let partial = '';
  let timer = killTimerStart(start, { killMs: KILL_MS });
  let lockTimeout = false;
  let kill;
  const arm = () => {
    clearTimeout(kill);
    kill = setTimeout(
      () => {
        if (timer.reason === 'lock-wait') {
          lockTimeout = true;
          console.log(
            `\n  [e2e-lock] lock wait timeout: gave up after ${timer.waitCapMs / 60_000} min waiting for another e2e app`,
          );
        }
        child.kill();
      },
      Math.max(0, timer.deadline - Date.now()),
    );
  };
  arm();
  child.stdout.setEncoding('utf8').on('data', (d) => {
    r.stdout += d;
    const lines = (partial + d).split('\n');
    partial = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('[e2e-lock]')) continue;
      console.log(`\n  ${line}`);
      const next = killTimerOnLine(timer, line.trimEnd(), Date.now());
      if (next !== timer) {
        timer = next;
        arm();
      }
    }
  });
  child.stderr.setEncoding('utf8').on('data', (d) => {
    r.stderr += d;
  });
  return new Promise((resolveAttempt) => {
    let done = false;
    const finish = (status, signal) => {
      if (done) return;
      done = true;
      clearTimeout(kill);
      r.status = status;
      r.signal = signal;
      const output = r.stdout + r.stderr;
      const result = classify({ status, signal, output, lockTimeout });
      const seconds = Number(((Date.now() - start) / 1000).toFixed(1));
      resolveAttempt({ name, attempt, status: result, seconds, exit: status ?? signal, r, output });
    };
    child.on('close', finish);
    // An orphaned Electron can keep the pipes open after the scenario died, so 'close' may never come.
    child.on('exit', (status, signal) => setTimeout(() => finish(status, signal), 2000));
  });
}

/** A non-clean attempt: dump its output, keep its log beside the harness's artifacts, sweep. */
function afterFailure({ name, attempt, exit, r, output }) {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (artifactsRoot) {
    const dir = join(artifactsRoot, name, `attempt-${attempt}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'log.txt'), `exit ${exit}\n${output}`);
  }
  // Only after a non-clean exit: a scenario that finished normally already shut its app down,
  // and the sweep costs a PowerShell spawn we don't want on the happy path.
  const swept = sweepOrphanElectrons();
  if (swept > 0) console.log(`  ↳ swept ${swept} orphaned Electron process(es)`);
}

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));
const ICON = { PASS: '✓', SKIP: '○', FLAKY: '~', 'QUARANTINED-FAIL': 'q' };
const results = [];

for (const name of names) {
  process.stdout.write(`  ${name} ... `);
  const first = await runAttempt(name, 1);
  let last = first;
  // A retry after a lock-wait timeout would only wait on the same other app again.
  if (args.retry && !isGreen(first.status) && first.status !== 'LOCK-TIMEOUT') {
    console.log(`${first.status} (${first.seconds}s, exit ${first.exit}), retrying`);
    afterFailure(first);
    await settle();
    process.stdout.write(`  ${name} (attempt 2) ... `);
    last = await runAttempt(name, 2);
  }
  const status = applyQuarantine(
    name,
    finalStatus(first.status, last === first ? undefined : last.status),
    quarantine,
  );
  const exitNote = status === 'FAIL' ? `, exit ${last.exit}` : '';
  console.log(`${ICON[status] ?? '✗'} ${status} (${last.seconds}s${exitNote})`);
  if (last.status !== 'PASS' && last.status !== 'SKIP') afterFailure(last);
  results.push({ name, status, seconds: last.seconds, attempts: last === first ? 1 : 2 });
  // Rewritten after every scenario so a shard that dies mid-run still reports what it finished.
  if (args.json) writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
  if (name !== names[names.length - 1]) await settle();
}

const count = (s) => results.filter((r) => r.status === s).length;
const failed = results.filter((r) => !isGreen(r.status));
console.log('\n── Summary ──────────────────────────────────────');
console.log(
  `  ${count('PASS')} passed  ${count('FLAKY')} flaky  ${count('SKIP')} skipped  ` +
    `${count('QUARANTINED-FAIL')} quarantined-failed  ${failed.length} failed`,
);
console.log('─────────────────────────────────────────────────\n');
if (failed.length && !ci) {
  console.log(
    '[smoke] A loaded machine fails PTY scenarios the way a regression does. Confirm remotely ' +
      `before debugging: npm run e2e:remote -- ${failed.map((r) => r.name).join(' ')}`,
  );
}
process.exit(failed.length ? 1 : 0);

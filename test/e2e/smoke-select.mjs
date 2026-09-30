/**
 * Pure pieces of run-smoke.mjs: argument parsing, the local single-scenario rule, exclusions and
 * exit → status classification. Spec: docs/specs/2026-09-29-remote-e2e-lean-loop.md §A′, §3.
 */

/** Exit code of the harness watchdog (`finishScenario(EXIT_WATCHDOG)`); artifacts were captured. */
export const EXIT_WATCHDOG = 124;

const VALUE_FLAGS = {
  '--names-file': 'namesFile',
  '--json': 'json',
  '--artifacts': 'artifacts',
  '--quarantine': 'quarantine',
};

export function parseRunnerArgs(argv) {
  const out = {
    names: [],
    namesFile: null,
    json: null,
    artifacts: null,
    retry: false,
    quarantine: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--retry') out.retry = true;
    else if (Object.hasOwn(VALUE_FLAGS, a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      out[VALUE_FLAGS[a]] = v;
    } else if (a.startsWith('--')) return { error: `unknown flag ${a}` };
    else out.names.push(a);
  }
  return out;
}

/**
 * Local runs are one scenario, exact name; the whole suite runs remotely. `localFull` is the
 * human-only CONDUIT_E2E_LOCAL_FULL escape hatch.
 *
 * @returns {{ names: string[], banner?: string } | { exit: number, message: string }}
 */
export function resolveSelection({ names, stems, ci, localFull }) {
  const known = new Set(stems);
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length)
    return { exit: 1, message: `[smoke] Unknown scenario(s): ${unknown.join(', ')}` };
  const unique = [...new Set(names)].sort();
  if (ci || unique.length === 1) return { names: unique };
  if (localFull) {
    return {
      names: unique.length ? unique : [...stems].sort(),
      banner:
        '[smoke] CONDUIT_E2E_LOCAL_FULL=1: running more than one scenario on this machine (human-only escape hatch).',
    };
  }
  const remote = unique.length ? unique.join(' ') : '--full';
  return {
    exit: 2,
    message:
      `[smoke] Refusing to run ${unique.length ? `${unique.length} scenarios` : 'the whole suite'} locally: ` +
      `at most one e2e scenario runs on this machine.\n` +
      `  Run them remotely:  npm run e2e:remote -- ${remote}\n` +
      '  Or one locally:     npm run e2e -- <name>',
  };
}

/** Split names into those that run and those `exclusions` (`{ name: reason }`) keeps off the runner. */
export function applyExclusions(names, exclusions) {
  const run = [];
  const excluded = {};
  for (const n of names) {
    if (Object.hasOwn(exclusions, n)) excluded[n] = exclusions[n];
    else run.push(n);
  }
  return { run, excluded };
}

/**
 * @param {{ status: number | null, signal?: string | null, output?: string }} r a finished child
 * @returns {'PASS' | 'SKIP' | 'TIMEOUT' | 'FAIL'}
 */
export function classify({ status, signal, output = '' }) {
  if (status === 0) return /\bSKIP\b/.test(output) ? 'SKIP' : 'PASS';
  if (status === EXIT_WATCHDOG || signal) return 'TIMEOUT';
  return 'FAIL';
}

/** Outcome of a scenario given its first attempt and, if one ran, its retry. */
export function finalStatus(first, retry) {
  if (!retry) return first;
  return retry === 'PASS' || retry === 'SKIP' ? 'FLAKY' : retry;
}

/**
 * A quarantined scenario (test/e2e/quarantine.json, `{ scenarios: { name: { reason, since } } }`)
 * still runs and reports, but its failure no longer fails the run (spec §B4).
 */
export function applyQuarantine(name, status, quarantine) {
  if (isGreen(status) || !Object.hasOwn(quarantine?.scenarios ?? {}, name)) return status;
  return 'QUARANTINED-FAIL';
}

export function isGreen(status) {
  return (
    status === 'PASS' || status === 'SKIP' || status === 'FLAKY' || status === 'QUARANTINED-FAIL'
  );
}

/** Harness watchdog delay: the deadline counts from process start, minus the e2e-lock wait. */
export function watchdogDelayMs({ deadlineMs, uptimeMs, lockWaitMs }) {
  return Math.max(0, deadlineMs - (uptimeMs - lockWaitMs));
}

/** The harness's `[e2e-lock] acquired after Ns` line → the wait in ms, so the runner can add it. */
export function lockWaitMsFromLine(line) {
  const m = /^\[e2e-lock\] acquired after (\d+)s/.exec(line);
  return m ? Number(m[1]) * 1000 : null;
}

/** Appended by `launchElectron` to every app it launches; names the runner invocation. */
export const RUN_MARKER = '--conduit-e2e-run';

const userDataDir = (cmd) =>
  /--user-data-dir=(?:"([^"]+)"|(\S+))/
    .exec(cmd ?? '')
    ?.slice(1)
    .find(Boolean);

/**
 * The Electron processes a runner's orphan sweep may kill: the apps this run launched (marked with
 * `RUN_MARKER=<runId>`), their descendants, and any process sharing one of their `--user-data-dir`s
 * (a child whose parent already died). Never another run's — a second worktree's scenario may be
 * holding the e2e lock with the same temp-dir profile prefix — nor the developer's own Conduit.
 *
 * @param {{ ProcessId: number, ParentProcessId: number, CommandLine: string | null }[]} procs
 * @returns {number[]} sorted PIDs
 */
export function orphanVictims(procs, runId) {
  const mark = `${RUN_MARKER}=${runId}`;
  const roots = procs.filter((p) => (p.CommandLine ?? '').split(/\s+/).includes(mark));
  const dirs = new Set(roots.map((p) => userDataDir(p.CommandLine)).filter(Boolean));
  const victims = new Set(roots.map((p) => p.ProcessId));
  for (const p of procs) {
    const dir = userDataDir(p.CommandLine);
    if (dir && dirs.has(dir)) victims.add(p.ProcessId);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (!victims.has(p.ProcessId) && victims.has(p.ParentProcessId)) {
        victims.add(p.ProcessId);
        grew = true;
      }
    }
  }
  return [...victims].sort((a, b) => a - b);
}

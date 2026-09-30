/**
 * Pure pieces of run-smoke.mjs: argument parsing, the local single-scenario rule, exclusions and
 * exit → status classification. Spec: docs/specs/2026-09-29-remote-e2e-lean-loop.md §A′, §3.
 */

/** Exit code of the harness watchdog (`finishScenario(EXIT_WATCHDOG)`); artifacts were captured. */
export const EXIT_WATCHDOG = 124;

export function parseRunnerArgs(argv) {
  const out = { names: [], namesFile: null, json: null, artifacts: null, retry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--retry') out.retry = true;
    else if (a === '--names-file' || a === '--json' || a === '--artifacts') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      out[{ '--names-file': 'namesFile', '--json': 'json', '--artifacts': 'artifacts' }[a]] = v;
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

export function isGreen(status) {
  return status === 'PASS' || status === 'SKIP' || status === 'FLAKY';
}

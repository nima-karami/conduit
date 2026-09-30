/**
 * Pure pieces of `npm run e2e:remote` (tools/e2e-remote.mjs): argument parsing, run correlation,
 * in-flight matching, state mapping and printing. Spec: docs/specs/archive/2026-09-29-remote-e2e-lean-loop.md §A, §3.
 */
import { createHash } from 'node:crypto';

export const USAGE =
  'usage: npm run e2e:remote -- [--affected (default) | --full | <name>…] [--shards N] [--no-wait] [--no-verify] [--out <dir>] [--timeout <min>]';

const IN_FLIGHT = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

export function parseArgs(argv) {
  const o = {
    full: false,
    affected: false,
    names: [],
    shards: 0,
    wait: true,
    verify: true,
    out: null,
    timeoutMin: 60,
  };
  const num = (flag, v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : { error: `${flag} needs a non-negative integer` };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') o.full = true;
    else if (a === '--affected') o.affected = true;
    else if (a === '--no-wait') o.wait = false;
    else if (a === '--no-verify') o.verify = false;
    else if (a === '--shards' || a === '--timeout') {
      const n = num(a, argv[++i]);
      if (typeof n === 'object') return n;
      if (a === '--shards') o.shards = n;
      else o.timeoutMin = n;
    } else if (a === '--out') {
      o.out = argv[++i];
      if (!o.out) return { error: '--out needs a directory' };
    } else if (a.startsWith('--')) return { error: `unknown flag ${a}` };
    else o.names.push(a);
  }
  if ([o.full, o.affected, o.names.length > 0].filter(Boolean).length > 1) {
    return { error: 'pass one of --affected, --full or names' };
  }
  if (!o.full && !o.names.length) o.affected = true;
  o.names = [...new Set(o.names)].sort();
  return o;
}

/** `base` is the diff base of an `--affected` selection: the same HEAD and base select the same. */
export function selectionKey({ full, affected, names, verify, base }) {
  let key;
  if (full) key = 'full';
  else if (affected) key = `a-${base.slice(0, 7)}`;
  else key = `n-${createHash('sha256').update(names.join(' ')).digest('hex').slice(0, 8)}`;
  return verify ? key : `${key}-nv`;
}

export function makeNonce(selKey, rand) {
  return `${selKey}.${rand}`;
}

/** Inverse of e2e.yml's `run-name: e2e <selection> <nonce>`. */
export function parseTitle(title) {
  const m = /^e2e (\S+) (\S+)$/.exec(title ?? '');
  if (!m) return null;
  const dot = m[2].lastIndexOf('.');
  return { selection: m[1], nonce: m[2], selKey: dot > 0 ? m[2].slice(0, dot) : null };
}

/**
 * @param {{ databaseId: number, displayTitle: string, status: string, headSha: string, url: string }[]} runs
 * @returns {{ attach: object } | { waitFor: object } | { dispatch: true }}
 */
export function matchInFlight(runs, { sha, selKey, full }) {
  const live = runs.filter((r) => IN_FLIGHT.has(r.status));
  const same = live.find((r) => r.headSha === sha && parseTitle(r.displayTitle)?.selKey === selKey);
  if (same) return { attach: same };
  if (full) {
    const other = live.find((r) => parseTitle(r.displayTitle)?.selection === 'full');
    if (other) return { waitFor: other };
  }
  return { dispatch: true };
}

/** A `gh run view --json status,conclusion,jobs` payload → the spec's run state. */
export function runState(view) {
  if (view.status === 'completed') return 'completed';
  const jobs = view.jobs ?? [];
  const done = (j) => j.status === 'completed';
  // A run goes back to 'queued' while its later jobs wait for a runner; its jobs still say where it is.
  if (view.status !== 'in_progress' && !jobs.some(done)) return 'queued';
  const prepare = jobs.find((j) => j.name === 'prepare');
  if (!prepare || !done(prepare)) return 'preparing';
  const shards = jobs.filter((j) => /^shard \d+$/.test(j.name));
  const finished = shards.filter(done).length;
  if (finished < shards.length || shards.length === 0)
    return `running ${finished}/${shards.length}`;
  return 'reporting';
}

export function finalStatus(conclusion, result) {
  if (conclusion === 'cancelled') return 'cancelled';
  return result?.status ?? 'infra-error';
}

export function exitCodeFor(status) {
  if (status === 'passed' || status === 'flaky-passed') return 0;
  if (status === 'failed') return 1;
  return 2;
}

const localCommand = (name) => `npm run e2e -- ${name}`;

/**
 * Named scenarios that `exclusions` (test/e2e/remote-exclusions.json) keeps off the runner: all of
 * them → refuse; some → a notice. Either way each name comes with its local command.
 * @returns {{ refuse?: string, notice?: string }}
 */
export function checkExclusions(names, exclusions) {
  const excluded = names.filter((n) => Object.hasOwn(exclusions, n));
  if (!excluded.length) return {};
  const list = excluded
    .map((n) => `  ${n}: ${exclusions[n]}\n    run locally: ${localCommand(n)}`)
    .join('\n');
  if (excluded.length === names.length) {
    return { refuse: `every named scenario is excluded from the runner:\n${list}` };
  }
  return { notice: `excluded from the runner (reported EXCLUDED, not run):\n${list}` };
}

const ICON = { PASS: '✓', FLAKY: '~', SKIP: '○', EXCLUDED: '-', 'QUARANTINED-FAIL': 'q' };

export function formatResults(result) {
  const lines = [];
  for (const r of result.results) {
    const where = r.shard ? ` [s${r.shard}]` : '';
    let why = r.reason ? ` — ${r.reason}` : '';
    if (r.status === 'EXCLUDED') why += `; run locally: ${localCommand(r.name)}`;
    if (r.alsoFailingOnNightly) {
      why += ` (also failing on the last nightly, ${result.lastNightlySha?.slice(0, 7)})`;
    }
    lines.push(
      `  ${r.name} ... ${ICON[r.status] ?? '✗'} ${r.status} (${r.seconds}s)${where}${why}`,
    );
  }
  const c = {};
  for (const r of result.results) c[r.status] = (c[r.status] ?? 0) + 1;
  lines.push('', '── Summary ──────────────────────────────────────');
  lines.push(
    `  ${result.status}: ${Object.entries(c)
      .map(([s, n]) => `${n} ${s}`)
      .join('  ')}`,
  );
  if (result.verify) lines.push(`  verify job: ${result.verify}`);
  const links = [...new Set(result.results.map((r) => r.artifact).filter(Boolean))];
  for (const l of links) lines.push(`  artifacts: ${l}`);
  if (result.rerun) lines.push(`  re-run the INFRA scenarios: ${result.rerun}`);
  for (const c of result.quarantineCandidates ?? []) {
    lines.push(
      `  quarantine candidate: ${c.name} (FLAKY ${c.count} in 14 days); quarantine via test/e2e/quarantine.json`,
    );
  }
  for (const w of result.warnings ?? []) lines.push(`  warning: ${w}`);
  if (result.url) lines.push(`  run: ${result.url}`);
  return lines.join('\n');
}

/**
 * Whether a failed `gh` call is worth repeating: a GitHub 5xx, 429 / secondary rate limit, or a
 * network-level failure. Any other HTTP status (auth, not found, validation) is final.
 */
export function isTransientGhError(message) {
  const m = String(message ?? '');
  const http = /HTTP (\d{3})/.exec(m);
  if (http) return http[1] === '429' || http[1].startsWith('5');
  return /secondary rate limit|ECONNRESET|ETIMEDOUT|connection reset|timeout|TLS/i.test(m);
}

/**
 * Run `fn` (sync or async) until it succeeds, a non-transient error, or `attempts` runs out; the
 * delay doubles from `baseMs` and is capped at `maxMs`.
 */
export async function withGhRetry(
  fn,
  { attempts = 5, baseMs = 2000, maxMs = 30_000, sleep, onRetry = () => {} } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isTransientGhError(e?.message ?? e)) throw e;
      const delayMs = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      onRetry(e, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}

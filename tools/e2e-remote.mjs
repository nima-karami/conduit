/**
 * `npm run e2e:remote -- [--affected | --full | <name>…] [--shards N] [--no-wait] [--no-verify]
 * [--out <dir>] [--timeout <min>]` — run e2e scenarios on GitHub-hosted Windows runners at the committed HEAD
 * and print run-smoke-style results. Spec: docs/specs/2026-09-29-remote-e2e-lean-loop.md §A, §3.
 *
 * Pushes HEAD to an ephemeral `ci/e2e/<sha7>-<rand>` ref and dispatches e2e.yml there; the run
 * deletes its own ref, so this never does (and Ctrl-C needs no handling). A run already in flight
 * for the same sha and selection is attached to instead.
 *
 * `--affected` (the default) diffs HEAD against its merge-base with origin/main; a diff of only
 * e2e-irrelevant files ends here, "no e2e needed", and pushes nothing. The run's `prepare` job
 * maps the rest to scenarios (test/e2e/ci-affected.mjs).
 *
 * Exit: 0 passed / flaky-passed / no e2e needed; 1 failed; 2 infra-error, cancelled, timed-out or a precondition;
 * 3 dispatched with --no-wait.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isE2eIrrelevant, parseNameStatus } from '../test/e2e/ci-affected.mjs';
import {
  checkExclusions,
  exitCodeFor,
  finalStatus,
  formatResults,
  makeNonce,
  matchInFlight,
  parseArgs,
  runState,
  selectionKey,
  USAGE,
} from './e2e-remote-lib.mjs';

const WORKFLOW = 'e2e.yml';
const RUN_FIELDS = 'databaseId,displayTitle,status,headSha,url,createdAt';

function sh(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).trim()}`,
    );
  }
  return r;
}
const gh = (...args) => sh('gh', args).stdout;
const ghJson = (...args) => JSON.parse(gh(...args));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[e2e:remote] ${m}`);
const stamp = () => new Date().toISOString().slice(11, 19);

function fail(message, code = 2) {
  console.error(`[e2e:remote] ${message}`);
  process.exit(code);
}

function preconditions(o) {
  const auth = sh('gh', ['auth', 'status'], { allowFail: true });
  if (auth.status !== 0) fail('gh is not authenticated: run `gh auth login`');
  const dirty = sh('git', ['status', '--porcelain']).stdout.trim();
  if (dirty) fail(`the working tree is not clean; commit or stash first:\n${dirty}`);
  const unknown = o.names.filter((n) => !existsSync(join('test', 'e2e', `${n}.e2e.mjs`)));
  if (unknown.length) fail(`unknown scenario(s): ${unknown.join(', ')}`);
  if (o.full || o.affected) return;
  const exclusions = JSON.parse(
    readFileSync(join('test', 'e2e', 'remote-exclusions.json'), 'utf8'),
  );
  const { refuse, notice } = checkExclusions(o.names, exclusions);
  if (refuse) fail(refuse);
  if (notice) say(notice);
}

/** The `--affected` diff base, or exit 0 when nothing in the diff can affect an e2e scenario. */
function affectedBase() {
  const mb = sh('git', ['merge-base', 'HEAD', 'origin/main'], { allowFail: true });
  if (mb.status !== 0) fail('no merge-base with origin/main (run git fetch origin main)');
  const base = mb.stdout.trim();
  const diff = sh('git', ['diff', '--name-status', `${base}...HEAD`]).stdout;
  const relevant = parseNameStatus(diff).filter((c) => !isE2eIrrelevant(c.path));
  if (!relevant.length) {
    say(`no e2e needed: nothing since ${base.slice(0, 7)} can affect a scenario`);
    process.exit(0);
  }
  say(`affected: ${relevant.length} relevant change(s) since ${base.slice(0, 7)}`);
  return base;
}

function inFlight() {
  return ghJson('run', 'list', '-w', WORKFLOW, '--json', RUN_FIELDS, '-L', '50');
}

async function waitUntilDone(run) {
  for (;;) {
    const v = ghJson('run', 'view', String(run.databaseId), '--json', 'status');
    if (v.status === 'completed') return;
    await sleep(30_000);
  }
}

async function dispatch(o, sha, selKey) {
  const rand = randomBytes(4).toString('hex');
  const ref = `ci/e2e/${sha.slice(0, 7)}-${rand}`;
  const nonce = makeNonce(selKey, rand);
  sh('git', ['push', '--quiet', 'origin', `HEAD:refs/heads/${ref}`]);
  say(`pushed ${ref}`);
  const inputs = {
    selection: o.full ? 'full' : o.affected ? 'affected' : 'names',
    scenarios: o.names.join(' '),
    base: o.base ?? '',
    shards: String(o.shards),
    nonce,
    verify: String(o.verify),
  };
  sh('gh', [
    'workflow',
    'run',
    WORKFLOW,
    '--ref',
    ref,
    ...Object.entries(inputs).flatMap(([k, v]) => ['-f', `${k}=${v}`]),
  ]);
  for (let waited = 0; waited <= 90_000; waited += 3000) {
    const runs = ghJson('run', 'list', '-w', WORKFLOW, '-b', ref, '--json', RUN_FIELDS, '-L', '10');
    const run = runs.find((r) => r.displayTitle.endsWith(` ${nonce}`));
    if (run) return run;
    await sleep(3000);
  }
  fail(`dispatched on ${ref} but no run titled with nonce ${nonce} appeared within 90 s`);
}

/** Poll to completion, printing state changes and a heartbeat. Returns the final view. */
async function follow(run, o) {
  let last = '';
  let lastPrint = 0;
  let queuedFor = null;
  for (;;) {
    const v = ghJson(
      'run',
      'view',
      String(run.databaseId),
      '--json',
      'status,conclusion,jobs,startedAt,createdAt',
    );
    const state = runState(v);
    const firstJob = (v.jobs ?? [])
      .map((j) => Date.parse(j.startedAt))
      .filter((t) => t > 0)
      .sort((a, b) => a - b)[0];
    if (queuedFor === null && firstJob) {
      queuedFor = Math.max(0, Math.round((firstJob - Date.parse(v.createdAt)) / 1000));
      say(`queue time ${queuedFor}s`);
    }
    if (state === 'completed') return { view: v, queuedFor };
    if (state !== last || Date.now() - lastPrint >= 60_000) {
      say(`${stamp()} ${state}`);
      last = state;
      lastPrint = Date.now();
    }
    const started = Date.parse(v.startedAt);
    if (started > 0 && Date.now() - started > o.timeoutMin * 60_000) {
      say(`timed out after ${o.timeoutMin} min; the run continues: ${run.url}`);
      return { timedOut: true, queuedFor };
    }
    await sleep(20_000);
  }
}

function downloadResult(runId) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-result-'));
  try {
    const r = sh('gh', ['run', 'download', String(runId), '-n', 'e2e-result', '-D', dir], {
      allowFail: true,
    });
    const file = join(dir, 'result.json');
    return r.status === 0 && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) fail(`${o.error}\n${USAGE}`);
  preconditions(o);
  if (o.affected) o.base = affectedBase();
  const sha = sh('git', ['rev-parse', 'HEAD']).stdout.trim();
  const selKey = selectionKey(o);

  let run;
  for (;;) {
    const m = matchInFlight(inFlight(), { sha, selKey, full: o.full });
    if (m.attach) {
      run = m.attach;
      say(`attaching to run ${run.url} (same sha and selection already in flight)`);
      break;
    }
    if (m.waitFor) {
      say(
        `waiting for full run ${m.waitFor.url} (${m.waitFor.headSha.slice(0, 7)}) to finish before dispatching`,
      );
      await waitUntilDone(m.waitFor);
      continue;
    }
    run = await dispatch(o, sha, selKey);
    say(`dispatched ${run.url}`);
    break;
  }
  if (!o.wait) {
    say(`not waiting (--no-wait): ${run.url}`);
    process.exit(3);
  }

  const started = Date.now();
  const { view, timedOut, queuedFor } = await follow(run, o);
  if (timedOut) process.exit(exitCodeFor('timed-out'));
  const result = view.conclusion === 'cancelled' ? null : downloadResult(run.databaseId);
  const status = finalStatus(view.conclusion, result);
  if (result) {
    result.status = status;
    result.queueSeconds = queuedFor;
    console.log(`\n${formatResults(result)}`);
    const out = o.out || process.env.E2E_EVIDENCE_DIR || join(tmpdir(), 'conduit-e2e');
    mkdirSync(out, { recursive: true });
    const file = join(out, `e2e-${run.databaseId}.json`);
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    say(`result JSON: ${file}`);
  } else {
    say(`${status}: no result to report (${run.url})`);
  }
  say(`${status} after ${Math.round((Date.now() - started) / 1000)}s of waiting`);
  process.exit(exitCodeFor(status));
}

main().catch((e) => fail(e?.message || String(e)));

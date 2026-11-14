/**
 * Shared driver for the auto-resume scenarios (spec 2026-11-13-scheduler-auto-resume §7 and R11).
 * A session runs `fixtures/fake-claude-hooks.mjs` behind a launcher named `claude` (or `codex`), so
 * the host matches the real adapter by the command's leaf and launches it as it would the CLI:
 * `--settings <file>` for Claude, the rollout watch for Codex. What the PTY delivered is read from
 * the fake's JSONL log, never from the terminal stream; what the Scheduler did is read from the
 * server's `scheduler.history` over a test C2 client (the same call works with no window open).
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { C2 } from './c2-peer.mjs';
import { isolatedHome } from './conduit-mcp-helpers.mjs';
import { assert, pollUntil, profileDir, REPO } from './harness.mjs';
import { SERVER_PROTOCOL_GENERATION, teardownNames } from './harness-server-teardown.mjs';

export const FAKE_HOOKS = join(REPO, 'test', 'e2e', 'fixtures', 'fake-claude-hooks.mjs');
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
export const APP_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

/** A reset this far ahead is long enough to see an armed job, short enough to wait out. */
export const MARGIN_MS = 5000;

/** A launcher `<binDir>/<leaf>` that runs the fake; `.cmd` on Windows, an executable `sh` script elsewhere. */
function writeLauncher(binDir, leaf, fakeArgs) {
  mkdirSync(binDir, { recursive: true });
  const quoted = fakeArgs.map((a) => `"${a}"`).join(' ');
  if (process.platform === 'win32') {
    const file = join(binDir, `${leaf}.cmd`);
    writeFileSync(file, `@"${process.execPath}" "${FAKE_HOOKS}" ${quoted} %*\r\n`);
    return file;
  }
  const file = join(binDir, leaf);
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HOOKS}" ${quoted} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/**
 * A profile with one fake CLI registered as an agent, in an isolated home: `HOME`, `CLAUDE_CONFIG_DIR`
 * and `CODEX_HOME` all point inside the profile, so nothing reads or writes the real ones.
 * @param {string} name
 * @param {{ as?: 'claude' | 'codex', paste?: 'on' | 'off' }} [opts]
 */
export function autoResumeProfile(name, { as = 'claude', paste = 'on' } = {}) {
  const userDataDir = profileDir(name);
  const { homeDir, env: homeEnv } = isolatedHome(userDataDir);
  const configDir = join(homeDir, '.claude');
  const codexHome = join(homeDir, '.codex');
  mkdirSync(configDir, { recursive: true });
  const dir = join(userDataDir, 'fake-records');
  const launcher = writeLauncher(join(userDataDir, 'bin'), as, [
    '--dir',
    dir,
    '--label',
    as,
    '--as',
    as,
    '--paste',
    paste,
  ]);
  const agentId = `e2e-auto-resume-${as}`;
  writeFileSync(
    join(userDataDir, 'agents.json'),
    JSON.stringify([
      {
        id: agentId,
        label: `Fake ${as}`,
        command: launcher,
        args: [],
        icon: 'terminal',
        color: 'green',
        cwdStrategy: 'workspaceFolder',
      },
    ]),
  );
  const env = { ...homeEnv, CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: codexHome };
  return { userDataDir, homeDir, configDir, codexHome, env, agentId, fake: fakeLog(dir, as) };
}

/** A fresh folder to run a session in, resolved so the host's and the scenario's spellings agree. */
export const workFolder = (prefix = 'conduit-auto-resume-') =>
  realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));

/** Read, and drive, one fake CLI through its files. */
function fakeLog(dir, label) {
  const recordFile = join(dir, `${label}.jsonl`);
  const cueFile = join(dir, `${label}.cue`);
  let cueSeq = 0;
  const api = {
    /** The fake's records of `kind` (all when omitted), in order; only whole lines count. */
    records(kind) {
      if (!existsSync(recordFile)) return [];
      const lines = readFileSync(recordFile, 'utf8').split('\n');
      lines.pop();
      return lines.map((l) => JSON.parse(l)).filter((r) => kind === undefined || r.kind === kind);
    },
    /** Every byte the CLI received on stdin, in order. */
    raw: () =>
      api
        .records('IN')
        .map((r) => r.d)
        .join(''),
    /** Append a cue and resolve once the fake has finished it (its hooks and status line included). */
    async cue(cue, ms = 60_000) {
      mkdirSync(dir, { recursive: true });
      cueSeq += 1;
      const id = `c${cueSeq}`;
      appendFileSync(cueFile, `${JSON.stringify({ id, ...cue })}\n`);
      const done = await pollUntil(() => api.records('CUE_DONE').some((r) => r.id === id), ms);
      assert(done, `the fake never finished cue ${JSON.stringify(cue)}`);
      const errors = api.records('ERROR');
      assert(errors.length === 0, `the fake failed: ${JSON.stringify(errors)}`);
    },
    /** SessionStart and the first status line are done: the launch is as wired as it will be. */
    async ready(ms = 45_000) {
      const ok = await pollUntil(() => api.records('READY').length > 0, ms);
      assert(ok, 'the fake CLI never reported READY');
      return api.records('START')[0];
    },
    submits: () => api.records('SUBMIT'),
    pastes: () => api.records('PASTE'),
  };
  return api;
}

/** Wait for `n` or more submitted lines; resolves them, or fails with what was seen. */
export async function waitForSubmits(fake, n, ms, what) {
  const got = await pollUntil(() => (fake.submits().length >= n ? fake.submits() : null), ms);
  assert(
    got,
    `${what}: expected ${n} submit(s) within ${ms} ms, saw ${JSON.stringify(fake.submits())}`,
  );
  return got;
}

/** A test C2 client on the profile's own server: hello'd, with `scheduler.history` and settings patch. */
export async function connectServer(userDataDir, ms = 60_000) {
  const { serverEndpoint } = teardownNames(userDataDir, process.platform, tmpdir());
  let c2 = null;
  const ok = await pollUntil(
    async () => {
      try {
        c2 = await C2.open(serverEndpoint);
        await c2.call('hello', { appVersion: APP_VERSION, generation: SERVER_PROTOCOL_GENERATION });
        return true;
      } catch {
        c2?.close();
        c2 = null;
        return false;
      }
    },
    ms,
    250,
  );
  assert(ok && c2, 'the server pipe never accepted a hello');
  return {
    close: () => c2.close(),
    /** `serverSettings.patch`: the same call the app's `updateServerSettings` makes. */
    patchSettings: (patch) => c2.call('serverSettings.patch', { patch }),
    /** `{ jobs, episodes }` for one session. */
    history: (sessionId) => c2.call('scheduler.history', { sessionId }),
  };
}

export const isResumeJob = (j) => j.trigger?.kind === 'limit-reset';

/** The session's newest resume job that satisfies `pred`, polled; null at the deadline. */
export async function waitForResumeJob(server, sessionId, pred, ms) {
  return pollUntil(async () => {
    const { jobs } = await server.history(sessionId);
    return jobs.filter(isResumeJob).findLast(pred) ?? null;
  }, ms);
}

/** The latest history entry of `job` whose state is `state`. */
export const entryOf = (job, state) => job.history.findLast((h) => h.state === state);

/** Resolves once `Date.now()` has passed `at`: a wait on the wall clock, in the poll helper. */
export function untilClock(at, ms = at - Date.now() + 5_000) {
  return pollUntil(() => Date.now() >= at, ms, 250);
}

/** The terminal pane's output reached the window (so the server saw it first). Needs `tapBridge`. */
export function paneHas(page, sessionId, text, ms) {
  return pollUntil(
    () => page.evaluate(([id, t]) => (window.__capBy?.[id] ?? '').includes(t), [sessionId, text]),
    ms,
  );
}

/** The session as the window last saw it (needs `tapBridge`). */
export const sessionOf = (page, id) =>
  page.evaluate((sid) => (window.__sessions || []).find((s) => s.id === sid) ?? null, id);

// See architecture F12: using the built identity keeps teardown on the endpoint the app starts.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect as netConnect } from 'node:net';
import { resolveHcBinary } from './hc-binary.mjs';

const require = createRequire(import.meta.url);
const runtimeIdentity = () => require('../../out/server/instance-names.js');

// Mirror STOP_ALL_*_TIMEOUT_MS and SERVER_PROTOCOL_GENERATION in src/contracts/server-protocol.ts
// (pinned by the unit test).
export const STOP_ALL_CONNECT_TIMEOUT_MS = 5_000;
export const STOP_ALL_ANSWER_TIMEOUT_MS = 20_000;
export const SERVER_PROTOCOL_GENERATION = 1;

const BACKSLASH = String.fromCharCode(92);
const HC_CALL_TIMEOUT_MS = 20_000;

export function teardownNames(userData, platform, tmpdir, options) {
  return runtimeIdentity().instanceNames(userData, platform, tmpdir, options);
}

/**
 * The only hc session this teardown may touch is one a scenario's own profile derives; refusing
 * anything else keeps a bug here from killing the runner's or the developer's real session.
 */
export function assertOwnSession(hcSession, inheritedSession) {
  if (!hcSession.startsWith('conduit-')) {
    throw new Error(`teardown: refusing hc session ${hcSession} (not conduit-*)`);
  }
  if (inheritedSession && hcSession === inheritedSession) {
    throw new Error(`teardown: refusing the runner's own hc session ${hcSession}`);
  }
}

/** Every inherited HC_* dropped (hc would otherwise address the runner's core), then our session and the XDG dirs the app starts its core with. */
export function hcEnv(inherited, names) {
  if (names.hcEndpointError) throw new Error(names.hcEndpointError);
  return runtimeIdentity().coreStartEnv(inherited, names);
}

export function hcCalls(supervisorName) {
  return [
    { args: ['kill', supervisorName], ignore: /not[ _-]?found/i },
    { args: ['server', 'stop'], ignore: /not running/i },
  ];
}

/**
 * @typedef {(bin: string, args: string[], opts: { env: Record<string, string>, timeout: number }) =>
 *   { status: number | null, stdout?: string, stderr?: string, error?: { code?: string } }} Exec
 */

/** @param {{ exec: Exec, bin: string, names: ReturnType<typeof teardownNames>, inheritedEnv: Record<string, string | undefined>, log: (...a: any[]) => void }} o */
export function stopHc({ exec, bin, names, inheritedEnv, log }) {
  assertOwnSession(names.hcSession, inheritedEnv.HC_SESSION);
  const env = hcEnv(inheritedEnv, names);
  for (const { args, ignore } of hcCalls(names.supervisorName)) {
    const r = exec(bin, args, { env, timeout: HC_CALL_TIMEOUT_MS });
    const label = `hc ${args.join(' ')}`;
    if (r.error?.code === 'ENOENT') {
      log(`teardown: hc unavailable (${bin}), skipped`);
      return;
    }
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.error) log(`teardown: ${label} failed: ${r.error.code ?? r.error}`);
    else if (r.status === 0) log(`teardown: ${label} ok`);
    else if (ignore.test(text)) log(`teardown: ${label}: nothing to stop`);
    else log(`teardown: ${label} exit ${r.status}: ${text.trim().slice(0, 200)}`);
  }
}

/**
 * C2 `server.stopAll`. Resolves with an outcome; never rejects.
 * @param {{ endpoint: string, appVersion: string, connect?: typeof netConnect,
 *   connectTimeoutMs?: number, answerTimeoutMs?: number }} o
 * @returns {Promise<{ outcome: 'no-server' | 'stopped' | 'closed' | 'timeout' | 'error', detail?: string }>}
 */
export function stopAllViaServer({
  endpoint,
  appVersion,
  connect = netConnect,
  connectTimeoutMs = STOP_ALL_CONNECT_TIMEOUT_MS,
  answerTimeoutMs = STOP_ALL_ANSWER_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let buf = '';
    const sock = connect(endpoint);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const send = (id, method, params) =>
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    timer = setTimeout(
      () => done({ outcome: 'timeout', detail: 'connect/hello' }),
      connectTimeoutMs,
    );
    sock.on('error', (e) => {
      const gone = e.code === 'ENOENT' || e.code === 'ECONNREFUSED';
      done(gone ? { outcome: 'no-server' } : { outcome: 'error', detail: e.code ?? String(e) });
    });
    sock.on('close', () => done({ outcome: 'closed' }));
    sock.on('connect', () =>
      send(1, 'hello', { appVersion, generation: SERVER_PROTOCOL_GENERATION }),
    );
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0 && !settled) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          clearTimeout(timer);
          timer = setTimeout(
            () => done({ outcome: 'timeout', detail: 'stopAll answer' }),
            answerTimeoutMs,
          );
          if (msg.error) {
            done({ outcome: 'error', detail: `hello: ${msg.error.message}` });
            return;
          }
          send(2, 'server.stopAll', {});
        } else if (msg.id === 2) {
          done(
            msg.error
              ? { outcome: 'error', detail: msg.error.message }
              : { outcome: 'stopped', detail: `killed ${msg.result?.killed}` },
          );
        }
      }
    });
  });
}

/** @typedef {{ ProcessId: number, ParentProcessId?: number, Name?: string, CommandLine?: string | null }} ProcessRow */

/** See docs/runs/2026-11-02-hc-spike/raw/m21.txt:3-5. */
function executableAndArgs(commandLine) {
  const match = /^(?:"([^"]+)"|(\S+))\s+(.*)$/.exec(
    (commandLine ?? '').toLowerCase().replaceAll(BACKSLASH, '/'),
  );
  return match ? { executable: match[1] ?? match[2], args: match[3] } : null;
}

/**
 * See docs/runs/2026-11-02-hc-spike/raw/m21.txt:3-5 for the core/holder/ConPTY relationship.
 * A core whose holders have all exited is invisible here: its profile link is only in env/XDG,
 * never on a command line.
 * @param {ProcessRow[]} procs
 * @param {string} userDataDir
 * @param {ReturnType<typeof teardownNames>} names
 */
export function profileLeftovers(procs, userDataDir, names) {
  const dir = userDataDir.toLowerCase().replaceAll(BACKSLASH, '/');
  const holderToken = `-${names.hcSession.toLowerCase()}.holder`;
  const matches = procs.filter((p) => {
    // Teardown may itself be a worker whose command line contains this profile.
    if (p.ProcessId === process.pid) return false;
    const cmd = (p.CommandLine ?? '').toLowerCase();
    return cmd.replaceAll(BACKSLASH, '/').includes(dir) || cmd.includes(holderToken);
  });
  const selected = new Set(matches.map((p) => p.ProcessId));
  const holders = new Set(
    matches
      .filter((p) => (p.CommandLine ?? '').toLowerCase().includes(holderToken))
      .map((p) => p.ProcessId),
  );
  const byPid = new Map(procs.map((p) => [p.ProcessId, p]));
  for (const matched of matches) {
    const parent = byPid.get(matched.ParentProcessId);
    const core = executableAndArgs(parent?.CommandLine);
    const child = executableAndArgs(matched.CommandLine);
    if (core && child && core.executable === child.executable && /^serve(?:\s|$)/.test(core.args))
      selected.add(parent.ProcessId);
  }
  return procs.filter(
    (p) =>
      p.ProcessId !== process.pid && (selected.has(p.ProcessId) || holders.has(p.ParentProcessId)),
  );
}

const LEFTOVER_WAIT_MS = 3_000;
const LEFTOVER_POLL_MS = 500;

const wqlLike = (value) =>
  value
    .replaceAll(BACKSLASH, BACKSLASH + BACKSLASH)
    .replaceAll("'", `${BACKSLASH}'`)
    .replaceAll('[', '[[]')
    .replaceAll('%', '[%]')
    .replaceAll('_', '[_]');

/** Profile and PID filters avoid fetching every process command line on each app teardown. */
export function listProfileProcs(
  userDataDir,
  names,
  { platform = process.platform, run = spawnSync } = {},
) {
  if (platform !== 'win32') return [];
  const needles = new Set([
    userDataDir,
    userDataDir.replaceAll(BACKSLASH, '/'),
    userDataDir.replaceAll('/', BACKSLASH),
    `-${names.hcSession}.holder`,
  ]);
  const filter = `ProcessId <> ${process.pid} AND (${[...needles]
    .map((needle) => `CommandLine LIKE '%${wqlLike(needle)}%'`)
    .join(' OR ')})`;
  const script = `
    $ErrorActionPreference = 'Stop'
    $seeds = @(Get-CimInstance Win32_Process -Filter $env:E2E_SCAN_FILTER -ErrorAction Stop)
    $rows = @($seeds)
    if ($seeds.Count -gt 0) {
      $relatedFilter = @(
        foreach ($row in $seeds) {
          if ($row.ParentProcessId -gt 0) { "ProcessId = " + $row.ParentProcessId }
          "ParentProcessId = " + $row.ProcessId
        }
      ) -join ' OR '
      $rows += @(Get-CimInstance Win32_Process -Filter $relatedFilter -ErrorAction Stop)
    }
    ConvertTo-Json -InputObject @($rows | Sort-Object ProcessId -Unique | Select-Object ProcessId,ParentProcessId,Name,CommandLine) -Compress
  `;
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, E2E_SCAN_FILTER: filter },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`PowerShell exit ${r.status ?? r.signal}`);
  const parsed = JSON.parse(r.stdout);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (p) =>
        p !== null &&
        Number.isInteger(p.ProcessId) &&
        Number.isInteger(p.ParentProcessId) &&
        typeof p.Name === 'string' &&
        (p.CommandLine === null || typeof p.CommandLine === 'string'),
    )
  )
    throw new Error('invalid process table');
  return parsed;
}

const realExec = (bin, args, opts) =>
  spawnSync(bin, args, { ...opts, encoding: 'utf8', windowsHide: true });

/**
 * An unowned session or missing pinned engine must fail before teardown can reach another install.
 * @param {{ userDataDir: string, log: (...a: any[]) => void, platform?: string, tmpdir: string,
 *   env?: Record<string, string | undefined>, exec?: Exec, stopAll?: typeof stopAllViaServer,
 *   appVersion?: string, listProcs?: () => ProcessRow[],
 *   waitMs?: number }} o
 */
export async function teardownScenarioServer({
  userDataDir,
  log,
  tmpdir,
  platform = process.platform,
  env = process.env,
  exec = realExec,
  stopAll = stopAllViaServer,
  appVersion,
  listProcs,
  waitMs = LEFTOVER_WAIT_MS,
}) {
  const names = teardownNames(userDataDir, platform, tmpdir);
  assertOwnSession(names.hcSession, env.HC_SESSION);
  const bin = resolveHcBinary({ env, platform });
  try {
    const version =
      appVersion ??
      JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    const r = await stopAll({ endpoint: names.serverEndpoint, appVersion: version });
    log(`teardown: server.stopAll ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`);
    stopHc({ exec, bin, names, inheritedEnv: env, log });
    // An injected exec is a simulated world: the real process table says nothing about it.
    const list =
      listProcs ?? (exec === realExec ? () => listProfileProcs(userDataDir, names) : () => []);
    try {
      let left = profileLeftovers(list(), userDataDir, names);
      for (let waited = 0; left.length > 0 && waited < waitMs; waited += LEFTOVER_POLL_MS) {
        await new Promise((r) => setTimeout(r, LEFTOVER_POLL_MS));
        left = profileLeftovers(list(), userDataDir, names);
      }
      if (left.length > 0) {
        log(
          `teardown: STILL RUNNING for this profile: ${left.map((p) => `${p.ProcessId} ${p.Name}`).join(', ')}`,
        );
      }
    } catch (e) {
      log(`teardown: process scan failed: ${e?.code ?? e?.message ?? e}`);
    }
  } catch (e) {
    log(`teardown: failed: ${e?.message || e}`);
  }
}

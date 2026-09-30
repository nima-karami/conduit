/**
 * Local-only e2e guards, applied by the harness's `launchElectron`: one e2e app per machine, run
 * at below-normal priority. Spec: docs/specs/2026-09-29-remote-e2e-lean-loop.md §A′.
 *
 * Holding the lock = listening on a named pipe. The OS closes the pipe when the owner dies, so
 * there is no stale-lock reclaim, PID probe or age check.
 */
import { rmSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { constants, setPriority } from 'node:os';

const DEFAULT_PIPE = '\\\\.\\pipe\\conduit-e2e';
const REPORT_EVERY_MS = 30_000;

let held = null;

function tryListen(pipePath, owner) {
  return new Promise((resolve, reject) => {
    const server = createServer((s) => s.end(JSON.stringify(owner)));
    server.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(null) : reject(e)));
    server.listen(pipePath, () => {
      server.unref();
      resolve(server);
    });
  });
}

function readOwner(pipePath) {
  return new Promise((resolve) => {
    let buf = '';
    const s = connect(pipePath);
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(2000, () => done(null));
    s.on('data', (d) => {
      buf += d;
    });
    s.on('end', () => {
      try {
        done(JSON.parse(buf));
      } catch {
        done(null);
      }
    });
    s.on('error', (e) => done(e.code === 'ECONNREFUSED' ? { refused: true } : null));
  });
}

function describeOwner(o) {
  return o && !o.refused ? `pid ${o.pid} (${o.scenario}, ${o.cwd})` : 'unknown owner';
}

/** Re-entrant per process: a scenario that relaunches its app holds the lock across launches. */
export async function acquireE2eLock({
  pipePath = DEFAULT_PIPE,
  scenario = 'unknown',
  pollMs = 1000,
  log = console.log,
} = {}) {
  if (held) return;
  const owner = { pid: process.pid, scenario, cwd: process.cwd() };
  const since = Date.now();
  let lastReport = 0;
  for (;;) {
    const server = await tryListen(pipePath, owner);
    if (server) {
      held = server;
      if (lastReport) log(`[e2e-lock] acquired after ${Math.round((Date.now() - since) / 1000)}s`);
      return;
    }
    const current = await readOwner(pipePath);
    // A Unix socket file outlives a killed owner (a Windows pipe does not); nobody accepting on it
    // means it is stale. Only the unit test runs off Windows.
    if (current?.refused && process.platform !== 'win32') {
      rmSync(pipePath, { force: true });
      continue;
    }
    if (Date.now() - lastReport >= REPORT_EVERY_MS) {
      lastReport = Date.now();
      log(`[e2e-lock] waiting for ${describeOwner(current)}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export function releaseE2eLock() {
  held?.close();
  held = null;
}

/**
 * Children inherit this process's priority class on Windows, but Chromium then raises its own:
 * measured, the GPU process came up AboveNormal and the renderer Normal. So the harness also
 * lowers every PID the app reports. A PID that is already gone is skipped.
 */
export function setBelowNormal(pids = [0]) {
  if (process.env.CONDUIT_E2E_PRIORITY === 'normal') return;
  for (const pid of pids) {
    try {
      setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* exited */
    }
  }
}

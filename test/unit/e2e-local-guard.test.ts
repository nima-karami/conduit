import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireE2eLock, releaseE2eLock } from '../e2e/local-guard.mjs';

const GUARD = pathToFileURL(join(__dirname, '..', 'e2e', 'local-guard.mjs')).href;

function freshPipe() {
  const id = randomBytes(4).toString('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\conduit-e2e-test-${id}`
    : join(tmpdir(), `e2e-lock-${id}.sock`);
}

/** A separate process that takes the lock and keeps it until killed. */
function spawnOwner(pipePath: string): Promise<ChildProcess> {
  const src = `import { acquireE2eLock } from ${JSON.stringify(GUARD)};
    await acquireE2eLock({ pipePath: ${JSON.stringify(pipePath)}, scenario: 'owner-scn' });
    console.log('HELD'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: 'pipe' });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('HELD') && resolve(child));
    child.once('exit', (code) => reject(new Error(`owner exited ${code}`)));
  });
}

let owner: ChildProcess | undefined;
afterEach(() => {
  owner?.kill('SIGKILL');
  owner = undefined;
  releaseE2eLock();
});

describe('acquireE2eLock', () => {
  it('acquires a free lock and is re-entrant within one process, reporting no wait', async () => {
    const pipePath = freshPipe();
    expect(await acquireE2eLock({ pipePath, scenario: 'a', log: () => {} })).toBe(0);
    expect(await acquireE2eLock({ pipePath, scenario: 'a', log: () => {} })).toBe(0);
  });

  it('the owner survives waiters that hang up before it answers (EPIPE)', async () => {
    const pipePath = freshPipe();
    const ownerProc = await spawnOwner(pipePath);
    owner = ownerProc;
    for (let i = 0; i < 40; i++) connect(pipePath).destroy();
    await new Promise((r) => setTimeout(r, 500));
    expect(ownerProc.exitCode).toBeNull();
    expect(ownerProc.signalCode).toBeNull();
  });

  it('a second process waits, names the owner, and gets the lock the moment the owner dies', async () => {
    const pipePath = freshPipe();
    const ownerProc = await spawnOwner(pipePath);
    owner = ownerProc;
    const lines: string[] = [];
    let acquired = false;
    const waiting = acquireE2eLock({
      pipePath,
      scenario: 'b',
      pollMs: 50,
      log: (l: string) => lines.push(l),
    }).then((ms) => {
      acquired = true;
      return ms;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(acquired).toBe(false);
    expect(lines[0]).toBe(
      `[e2e-lock] waiting for pid ${ownerProc.pid} (owner-scn, ${process.cwd()})`,
    );

    const killedAt = Date.now();
    ownerProc.kill('SIGKILL');
    const waited = await waiting;
    expect(Date.now() - killedAt).toBeLessThan(3000);
    expect(waited).toBeGreaterThanOrEqual(500);
  });
});

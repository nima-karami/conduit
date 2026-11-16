import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSshDial } from '../../server/network/ssh-dialer';
import type { SshEndpoint } from '../../src/contracts/ssh-link';

const FAKE_SSH = path.join(process.cwd(), 'test', 'helpers', 'fake-ssh.mjs');
const created: string[] = [];

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.FAKE_SSH_FAIL;
});

function scratch(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ssh-dialer-test-'));
  created.push(d);
  return d;
}

// The remote "node main.js --link-stdio" is replaced by an echo script; fake-ssh runs it locally.
function echoEndpoint(): SshEndpoint {
  const dir = scratch();
  const mainJs = path.join(dir, 'echo.mjs');
  writeFileSync(mainJs, 'process.stdin.pipe(process.stdout);\n');
  return { target: 'fake', node: process.execPath, mainJs, userData: dir };
}

function dialer(controlDir: string) {
  return createSshDial({
    sshPath: process.execPath,
    sshArgsPrefix: [FAKE_SSH],
    controlDir,
    log: { debug() {}, warn() {} },
  });
}

describe('createSshDial', () => {
  it('round-trips bytes through the ssh child and ends with a clean exit', async () => {
    const dialed = dialer(path.join(scratch(), 'ssh'))(echoEndpoint());
    const received: Buffer[] = [];
    dialed.stream.on('data', (chunk: Buffer) => received.push(chunk));
    const ended = new Promise<void>((resolve) => dialed.stream.once('end', resolve));
    dialed.stream.write('ping\n');
    dialed.stream.end();
    await ended;
    expect(Buffer.concat(received).toString()).toBe('ping\n');
    expect(await dialed.failure()).toBeNull();
  });

  it('classifies an ssh stderr line into a typed failure', async () => {
    process.env.FAKE_SSH_FAIL = 'Host key verification failed.';
    const dialed = dialer(path.join(scratch(), 'ssh'))(echoEndpoint());
    expect(await dialed.failure()).toEqual({
      code: 'ssh_needs_person',
      reason: 'host_key_unknown',
    });
  });

  it('gives a destroyed stream and ssh_failed for a bad target', async () => {
    const dialed = dialer(path.join(scratch(), 'ssh'))({
      ...echoEndpoint(),
      target: '-oProxyCommand=x',
    });
    expect(dialed.stream.destroyed).toBe(true);
    expect(await dialed.failure()).toEqual({ code: 'ssh_failed', detail: 'bad_target' });
  });

  it('destroying the stream ends the ssh child', async () => {
    const dialed = dialer(path.join(scratch(), 'ssh'))(echoEndpoint());
    dialed.stream.destroy();
    // A child killed mid-session exits non-zero, so it reports as a typed ssh_failed.
    expect((await dialed.failure())?.code).toBe('ssh_failed');
  });

  it('creates the control directory with mode 0700', () => {
    if (process.platform === 'win32') return;
    const control = path.join(scratch(), 'ssh');
    const dialed = dialer(control)(echoEndpoint());
    dialed.stream.destroy();
    expect(statSync(control).mode & 0o777).toBe(0o700);
  });
});

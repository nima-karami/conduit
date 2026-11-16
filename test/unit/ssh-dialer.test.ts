import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSshDial, type SshDialOptions } from '../../server/network/ssh-dialer';
import type { SshEndpoint } from '../../src/contracts/ssh-link';

const FAKE_SSH = path.join(process.cwd(), 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const created: string[] = [];
const quietLog = { debug() {}, warn() {} };

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.FAKE_SSH_FAIL;
});

function scratch(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ssh-dialer-test-'));
  created.push(d);
  return d;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The remote "node main.js --link-stdio" is replaced by a script; fake-ssh runs it locally.
function endpointWith(source: string): SshEndpoint {
  const dir = scratch();
  const mainJs = path.join(dir, 'remote.mjs');
  writeFileSync(mainJs, `${source}\n`);
  return { target: 'fake', node: process.execPath, mainJs, userData: dir };
}
const echoEndpoint = () => endpointWith('process.stdin.pipe(process.stdout);');

function dialer(controlDir: string | null, overrides: Partial<SshDialOptions> = {}) {
  return createSshDial({
    sshPath: process.execPath,
    sshArgsPrefix: [FAKE_SSH],
    controlDir,
    log: quietLog,
    ...overrides,
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

  it('emits close when the child exits without the consumer ending the stream', async () => {
    const dialed = dialer(path.join(scratch(), 'ssh'))(
      endpointWith("process.stdout.write('bye');"),
    );
    dialed.stream.resume();
    const closed = new Promise<'closed'>((resolve) =>
      dialed.stream.once('close', () => resolve('closed')),
    );
    // A missing close would hang the test, so bound it and fail with the reason.
    const outcome = await Promise.race([closed, sleep(5_000).then(() => 'timed out' as const)]);
    expect(outcome).toBe('closed');
    expect(await dialed.failure()).toBeNull();
  });

  it('emits close when the child exits after the consumer ends the stream', async () => {
    const dialed = dialer(path.join(scratch(), 'ssh'))(echoEndpoint());
    const closed = new Promise<void>((resolve) => dialed.stream.once('close', resolve));
    dialed.stream.resume();
    dialed.stream.end();
    await closed;
    expect(await dialed.failure()).toBeNull();
  });

  it('a consumer that does not read keeps the child paused, so buffering stays bounded', async () => {
    const dialed = dialer(path.join(scratch(), 'ssh'))(
      endpointWith('process.stdout.write(Buffer.alloc(16 * 1024 * 1024, 97));'),
    );
    // Wait until the buffered length stops moving; a paused child stops it at about one chunk.
    let last = -1;
    let stable = 0;
    while (stable < 5) {
      await sleep(50);
      const length = dialed.stream.readableLength;
      stable = length === last ? stable + 1 : 0;
      last = length;
    }
    expect(dialed.stream.readableLength).toBeLessThan(1024 * 1024);
    dialed.stream.destroy();
    await dialed.failure();
  });

  it('classifies an ssh stderr line into a typed failure', async () => {
    process.env.FAKE_SSH_FAIL = 'Host key verification failed.';
    const dialed = dialer(path.join(scratch(), 'ssh'))(echoEndpoint());
    expect(await dialed.failure()).toEqual({
      code: 'ssh_needs_person',
      reason: 'host_key_unknown',
    });
  });

  it('classifies the tail of a long stderr, so a late unreachable line is seen', async () => {
    process.env.FAKE_SSH_FAIL = `${'x'.repeat(40_000)}\nssh: Timeout, server 10.0.0.9 not responding.`;
    const dialed = dialer(path.join(scratch(), 'ssh'))(echoEndpoint());
    expect(await dialed.failure()).toEqual({
      code: 'ssh_unreachable',
      detail: 'ssh: Timeout, server 10.0.0.9 not responding.',
    });
  });

  it('drops stderr beyond the 16 KiB tail, so an early line is not classified', async () => {
    process.env.FAKE_SSH_FAIL = `Host key verification failed.\n${'x'.repeat(40_000)}`;
    const dialed = dialer(path.join(scratch(), 'ssh'))(echoEndpoint());
    expect(await dialed.failure()).toEqual({ code: 'ssh_failed', detail: 'x'.repeat(200) });
  });

  it('refuses a dash-led target even when its characters are allowed', async () => {
    const dialed = dialer(path.join(scratch(), 'ssh'))({ ...echoEndpoint(), target: '-vvv' });
    expect(await dialed.failure()).toEqual({ code: 'ssh_failed', detail: 'bad_target' });
  });

  it('gives a destroyed stream and ssh_failed for a bad target', async () => {
    const dialed = dialer(path.join(scratch(), 'ssh'))({
      ...echoEndpoint(),
      target: '-oProxyCommand=x',
    });
    expect(dialed.stream.destroyed).toBe(true);
    expect(await dialed.failure()).toEqual({ code: 'ssh_failed', detail: 'bad_target' });
  });

  it('gives control_dir_too_long when no control dir fits', async () => {
    const dialed = dialer(null)(echoEndpoint());
    expect(dialed.stream.destroyed).toBe(true);
    expect(await dialed.failure()).toEqual({
      code: 'ssh_failed',
      detail: 'control_dir_too_long',
    });
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

  // The owner and mode check is posix-only: Windows has no getuid, and its tmpdir is per-user.
  it.skipIf(process.platform === 'win32')(
    'refuses a pre-existing 0777 control dir without spawning ssh',
    async () => {
      const control = path.join(scratch(), 'ssh');
      mkdirSync(control);
      // chmod, not mkdir's mode: the umask would otherwise narrow the 0777 we mean to test.
      chmodSync(control, 0o777);
      // A missing ssh binary would fail as spawn ENOENT, so this reason proves ssh never ran.
      const dialed = dialer(control, {
        sshPath: path.join(scratch(), 'no-such-ssh'),
        sshArgsPrefix: [],
      })(echoEndpoint());
      expect(dialed.stream.destroyed).toBe(true);
      expect(await dialed.failure()).toEqual({ code: 'ssh_failed', detail: 'control_dir_unsafe' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a control dir with a group or other bit set',
    async () => {
      for (const mode of [0o755, 0o750]) {
        const control = path.join(scratch(), `ssh-${mode.toString(8)}`);
        mkdirSync(control);
        chmodSync(control, mode);
        const dialed = dialer(control, {
          sshPath: path.join(scratch(), 'no-such-ssh'),
          sshArgsPrefix: [],
        })(echoEndpoint());
        expect(await dialed.failure()).toEqual({
          code: 'ssh_failed',
          detail: 'control_dir_unsafe',
        });
      }
    },
  );

  it.skipIf(process.platform === 'win32')('refuses a symlinked control dir', async () => {
    const real = path.join(scratch(), 'real');
    mkdirSync(real, { mode: 0o700 });
    const control = path.join(scratch(), 'ssh');
    symlinkSync(real, control, 'dir');
    const dialed = dialer(control, {
      sshPath: path.join(scratch(), 'no-such-ssh'),
      sshArgsPrefix: [],
    })(echoEndpoint());
    expect(await dialed.failure()).toEqual({ code: 'ssh_failed', detail: 'control_dir_unsafe' });
  });
});

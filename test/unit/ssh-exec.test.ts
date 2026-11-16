import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sshControlExit, sshExec } from '../../server/network/ssh-exec';
import { remoteForTest } from '../../src/network/remote-scripts';

// Driven through fake-ssh.cjs, which runs the remote string on this host with stdio inherited,
// so stdin, the exit code and stderr all cross the real child-process boundary.
const FAKE_SSH = path.join(process.cwd(), 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
const created: string[] = [];

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ssh-exec-test-'));
  created.push(d);
  return d;
}

/** True once no process has the pid. A killed child can linger as a zombie for a moment. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function run(over: Partial<Parameters<typeof sshExec>[0]> & { raw: string }) {
  const { raw, ...rest } = over;
  return sshExec({
    sshPath: process.execPath,
    sshArgsPrefix: [FAKE_SSH],
    controlDir: scratch(),
    target: 'fake',
    command: remoteForTest(raw),
    timeoutMs: 20_000,
    ...rest,
  });
}

describe.skipIf(process.platform === 'win32')('sshExec (posix, through fake-ssh)', () => {
  it('returns stdout and a null failure on a clean exit', async () => {
    const r = await run({ raw: 'echo hello' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hello\n');
    expect(r.failure).toBeNull();
  });

  it('writes the stdin bytes to the remote command unchanged', async () => {
    // stdout is text, so the bytes are checked where they land: a file the remote writes.
    const dir = scratch();
    const target = path.join(dir, 'in.bin');
    const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
    const r = await run({
      raw: `cat > '${target}'`,
      stdin: bytes,
      controlDir: dir,
    });
    expect(r.code).toBe(0);
    expect(readFileSync(target).equals(bytes)).toBe(true);
  });

  it('passes a multi-line raw command to the remote shell verbatim', async () => {
    const r = await run({ raw: "printf '%s\\n' one\nprintf '%s\\n' two" });
    expect(r.stdout).toBe('one\ntwo\n');
  });

  it('kills the child by its handle when the timeout passes, and reports it', async () => {
    const started = Date.now();
    const r = await run({ raw: 'sleep 30', timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.code).not.toBe(0);
    expect(r.failure).toEqual({
      code: 'ssh_failed',
      detail: 'timed out after 300 ms',
    });
    // fake-ssh prints its child's pid; the child must be gone, not merely the ssh stand-in.
    const pid = Number(/fake-ssh: pid (\d+)/.exec(r.stderr)?.[1]);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(await goneWithin(pid, 5_000)).toBe(true);
  });

  it('classifies an auth refusal from stderr', async () => {
    const r = await run({
      raw: "echo 'Permission denied (publickey).' 1>&2; exit 255",
    });
    expect(r.code).toBe(255);
    expect(r.failure).toEqual({ code: 'ssh_auth_failed' });
  });

  it('caps stdout at 1 MiB and keeps its tail, where a result line sits', async () => {
    const r = await run({
      raw: 'head -c 2000000 /dev/zero | tr "\\0" a; echo END',
    });
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1024 * 1024);
    expect(r.stdout.endsWith('END\n')).toBe(true);
  });

  it('reports a control dir that does not fit as a typed failure, spawning nothing', async () => {
    const r = await run({ raw: 'echo never', controlDir: null });
    expect(r.code).toBeNull();
    expect(r.failure).toEqual({
      code: 'ssh_failed',
      detail: 'control_dir_too_long',
    });
  });

  it('refuses a bad target before spawning', async () => {
    const r = await run({ raw: 'echo never', target: '-oProxyCommand=x' });
    expect(r.failure).toEqual({ code: 'ssh_failed', detail: 'bad_target' });
  });
});

// fake-ssh stands for `ssh -O exit` the way the real one answers: a live master is its socket
// (<ControlPath> with %C read as 'fakehash'), and no socket is ssh's own "No such file" message.
describe.skipIf(process.platform === 'win32')('sshControlExit (posix, through fake-ssh)', () => {
  const exit = (controlDir: string | null, target = 'fake') =>
    sshControlExit({
      sshPath: process.execPath,
      sshArgsPrefix: [FAKE_SSH],
      controlDir,
      target,
    });

  it('a running master is asked to exit, and that is success', async () => {
    const dir = scratch();
    const socket = path.join(dir, 'fakehash');
    writeFileSync(socket, '');
    expect(await exit(dir)).toBeNull();
    expect(existsSync(socket)).toBe(false);
  });

  // Not a failure: the link is already gone, which is what disconnect wants.
  it('no master running is success too: ssh says the control socket is missing', async () => {
    expect(await exit(scratch())).toBeNull();
  });

  it('an ssh failure other than a missing master is reported', async () => {
    process.env.FAKE_SSH_FAIL = 'Permission denied (publickey).';
    try {
      expect(await exit(scratch())).toEqual({ code: 'ssh_auth_failed' });
    } finally {
      delete process.env.FAKE_SSH_FAIL;
    }
  });

  it('a control dir that does not fit is a typed failure, spawning nothing', async () => {
    expect(await exit(null)).toEqual({ code: 'ssh_failed', detail: 'control_dir_too_long' });
  });

  it('a bad target is refused before spawning', async () => {
    expect(await exit(scratch(), '-oProxyCommand=x')).toEqual({
      code: 'ssh_failed',
      detail: 'bad_target',
    });
  });
});

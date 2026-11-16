import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sshExec } from '../../server/network/ssh-exec';

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

function run(over: Partial<Parameters<typeof sshExec>[0]> & { raw: string }) {
  const { raw, ...rest } = over;
  return sshExec({
    sshPath: process.execPath,
    sshArgsPrefix: [FAKE_SSH],
    controlDir: scratch(),
    target: 'fake',
    command: { command: raw },
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

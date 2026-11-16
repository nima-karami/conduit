import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { SshFailure } from '../../src/contracts/ssh-link';
import type { RemoteCommand } from '../../src/network/remote-scripts';
import { classifySshFailure, sshArgv } from '../../src/network/ssh-argv';
import { prepareControlDir } from './ssh-dialer';

// One-shot ssh for the bootstrap: a fixed remote script, run to its exit, with its output
// collected. Like ssh-dialer, the child is killed only through its own handle.

const STDOUT_MAX_BYTES = 1024 * 1024;
const STDERR_MAX_BYTES = 16 * 1024;

export interface SshExecOptions {
  sshPath: string;
  /** e2e only: the stand-in's leading argv (see readE2eSshArgsPrefix). */
  sshArgsPrefix?: string[];
  /** controlDir()'s result; null means no candidate fits, and nothing is spawned. */
  controlDir: string | null;
  target: string;
  command: RemoteCommand;
  stdin?: Buffer | Readable;
  timeoutMs: number;
}

export interface SshExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failure: SshFailure | null;
}

/** Keeps the tail: the script's CONDUIT_RESULT line is its last output. */
function keepTail(acc: Buffer, chunk: Buffer, max: number): Buffer {
  const joined = Buffer.concat([acc, chunk]);
  return joined.length > max ? joined.subarray(joined.length - max) : joined;
}

const failed = (failure: SshFailure): SshExecResult => ({
  code: null,
  stdout: '',
  stderr: '',
  failure,
});

export function sshExec(o: SshExecOptions): Promise<SshExecResult> {
  if (o.controlDir === null) {
    return Promise.resolve(failed({ code: 'ssh_failed', detail: 'control_dir_too_long' }));
  }
  const argv = sshArgv({
    target: o.target,
    controlPath: path.join(o.controlDir, '%C'),
    rawRemote: o.command,
  });
  if ('error' in argv) return Promise.resolve(failed({ code: 'ssh_failed', detail: argv.error }));
  const dirFailure = prepareControlDir(o.controlDir);
  if (dirFailure !== null) return Promise.resolve(failed(dirFailure));

  return new Promise<SshExecResult>((resolve) => {
    const child = spawn(o.sshPath, [...(o.sshArgsPrefix ?? []), ...argv], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result: SshExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Resolves at the deadline rather than at 'close': a grandchild that inherited the pipes can
    // hold stdout open after the kill, and the bootstrap must not wait on it.
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      finish({
        code: null,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        failure: {
          code: 'ssh_failed',
          detail: `timed out after ${o.timeoutMs} ms`,
        },
      });
    }, o.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = keepTail(stdout, chunk, STDOUT_MAX_BYTES);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = keepTail(stderr, chunk, STDERR_MAX_BYTES);
    });
    // A child that exits before reading its stdin turns the write into EPIPE; the exit reports it.
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      finish({
        code: null,
        stdout: '',
        stderr: error.message,
        failure: { code: 'ssh_failed', detail: error.message },
      });
    });
    // 'close' rather than 'exit': it waits until stdout and stderr have been read in full.
    child.on('close', (code) => {
      const text = stderr.toString('utf8');
      finish({
        code,
        stdout: stdout.toString('utf8'),
        stderr: text,
        failure: classifySshFailure(code, text),
      });
    });

    if (o.stdin === undefined) child.stdin.end();
    else if (Buffer.isBuffer(o.stdin)) child.stdin.end(o.stdin);
    else o.stdin.pipe(child.stdin);
  });
}

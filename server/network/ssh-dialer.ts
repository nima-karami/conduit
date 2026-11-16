import { type ChildProcess, spawn } from 'node:child_process';
import { lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Duplex, finished, PassThrough } from 'node:stream';
import type { SshDial, SshDialed, SshEndpoint, SshFailure } from '../../src/contracts/ssh-link';
import { classifySshFailure, sshArgv } from '../../src/network/ssh-argv';
import type { NetLog } from './listener';

// ssh is spawned only here (plan Global constraints). The child is killed only through its own
// handle, never by name, so one link's teardown cannot reach the user's other ssh sessions.

// The tail, not the head: a failure line such as "Timeout, server … not responding" arrives last.
const STDERR_TAIL_BYTES = 16 * 1024;

export interface SshDialOptions {
  sshPath: string;
  /** controlDir()'s result. null means no candidate fits, and every dial fails with that reason. */
  controlDir: string | null;
  log: NetLog;
  /** Test-only: a leading argv for sshPath, so tests can run fake-ssh through node. */
  sshArgsPrefix?: string[];
}

export function createSshDial(o: SshDialOptions): SshDial {
  return (ssh) => dialOne(o, ssh);
}

function dialOne(o: SshDialOptions, ssh: SshEndpoint): SshDialed {
  if (o.controlDir === null) {
    return failedDial({ code: 'ssh_failed', detail: 'control_dir_too_long' });
  }
  const argv = sshArgv({
    target: ssh.target,
    controlPath: path.join(o.controlDir, '%C'),
    remote: [ssh.node, ssh.mainJs, '--link-stdio', '--user-data', ssh.userData],
  });
  if ('error' in argv) {
    o.log.warn('ssh argv refused', { error: argv.error });
    return failedDial({ code: 'ssh_failed', detail: argv.error });
  }
  const dirFailure = prepareControlDir(o.controlDir, o.log);
  if (dirFailure !== null) return failedDial(dirFailure);
  return spawnDial(o, argv);
}

/**
 * Creates the control dir and refuses one that is not ours. mkdir keeps the mode and owner of a
 * directory that already exists, and ssh's mux client does not check who owns the socket it
 * connects to, so a dir another local user created would receive our link's stdio.
 */
export function prepareControlDir(dir: string, log?: Pick<NetLog, 'warn'>): SshFailure | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Windows has no getuid, and its tmpdir is per-user, so the owner and mode check is posix-only.
    if (process.platform === 'win32') return null;
    const stat = lstatSync(dir);
    const ours = stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
    if (ours) return null;
    log?.warn('ssh control dir is not private to this user', { dir });
    return { code: 'ssh_failed', detail: 'control_dir_unsafe' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log?.warn('ssh control dir unavailable', { detail });
    return { code: 'ssh_failed', detail };
  }
}

function spawnDial(o: SshDialOptions, argv: string[]): SshDialed {
  const child = spawn(o.sshPath, [...(o.sshArgsPrefix ?? []), ...argv], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr: Buffer = Buffer.alloc(0);
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = keepTail(stderr, chunk);
  });
  // A dead ssh turns its stdin into EPIPE: the link going down, reported through exit, not a crash.
  child.stdin.on('error', (error) => o.log.debug('ssh stdin error', { message: error.message }));
  child.stdout.on('error', (error) => o.log.debug('ssh stdout error', { message: error.message }));

  // Built by hand rather than Duplex.from({readable, writable}): that form is typed for web
  // streams, and the Node streams here need the backpressure below to keep the bytes in order.
  const stream = new Duplex({
    read: () => child.stdout.resume(),
    write: (chunk, _encoding, callback) => child.stdin.write(chunk, callback),
    final: (callback) => child.stdin.end(callback),
  });
  child.stdout.on('data', (chunk: Buffer) => {
    // Pausing the child's stdout is what keeps a slow reader from buffering a whole session.
    if (!stream.push(chunk)) child.stdout.pause();
  });
  child.stdout.once('end', () => stream.push(null));
  // The stream ends only after its reader has consumed the last bytes the child wrote, so
  // destroying it at that point cannot cut off a final frame.
  stream.once('end', () => stream.destroy());
  stream.on('error', (error) => o.log.debug('ssh stream error', { message: error.message }));
  stream.once('close', () => killIfRunning(child));

  // Resolves on exit, not on close: close waits for stdout to be read, and failure() may be
  // awaited before the link has read anything. stderr is drained first so its tail is classified.
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', (error) => {
      o.log.debug('ssh spawn failed', { message: error.message });
      stderr = keepTail(stderr, Buffer.from(`${error.message}\n`));
      resolve(null);
    });
    child.once('exit', (code) => finished(child.stderr, () => resolve(code)));
  });

  return {
    stream,
    failure: () => exited.then((code) => classifySshFailure(code, stderr.toString('utf8'))),
  };
}

function killIfRunning(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

function keepTail(acc: Buffer, chunk: Buffer): Buffer {
  const joined = Buffer.concat([acc, chunk]);
  return joined.length > STDERR_TAIL_BYTES
    ? joined.subarray(joined.length - STDERR_TAIL_BYTES)
    : joined;
}

function failedDial(failure: SshFailure): SshDialed {
  const stream = new PassThrough();
  stream.destroy();
  return { stream, failure: () => Promise.resolve(failure) };
}

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Duplex, finished, PassThrough } from 'node:stream';
import type { SshDial, SshDialed, SshEndpoint, SshFailure } from '../../src/contracts/ssh-link';
import { classifySshFailure, sshArgv } from '../../src/network/ssh-argv';
import type { NetLog } from './listener';

// ssh is spawned only here (plan Global constraints). The child is killed only through its own
// handle, never by name, so one link's teardown cannot reach the user's other ssh sessions.

const STDERR_CAP_BYTES = 16 * 1024;

export interface SshDialOptions {
  sshPath: string;
  controlDir: string;
  log: NetLog;
  /** Test-only: a leading argv for sshPath, so tests can run fake-ssh through node. */
  sshArgsPrefix?: string[];
}

export function createSshDial(o: SshDialOptions): SshDial {
  return (ssh) => dialOne(o, ssh);
}

function dialOne(o: SshDialOptions, ssh: SshEndpoint): SshDialed {
  const argv = sshArgv({
    target: ssh.target,
    controlPath: path.join(o.controlDir, '%C'),
    remote: [ssh.node, ssh.mainJs, '--link-stdio', '--user-data', ssh.userData],
  });
  if ('error' in argv) {
    o.log.warn('ssh argv refused', { error: argv.error });
    return failedDial({ code: 'ssh_failed', detail: argv.error });
  }
  try {
    // The mode applies only when the directory is created; an existing one keeps its mode.
    mkdirSync(o.controlDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    o.log.warn('ssh control dir unavailable', { detail });
    return failedDial({ code: 'ssh_failed', detail });
  }
  return spawnDial(o, argv);
}

function spawnDial(o: SshDialOptions, argv: string[]): SshDialed {
  const child = spawn(o.sshPath, [...(o.sshArgsPrefix ?? []), ...argv], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = appendCapped(stderr, chunk);
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
    child.once('error', (error) => {
      o.log.debug('ssh spawn failed', { message: error.message });
      stderr = appendCapped(stderr, `${error.message}\n`);
      resolve(null);
    });
    child.once('exit', (code) => finished(child.stderr, () => resolve(code)));
  });

  return {
    stream,
    failure: () => exited.then((code) => classifySshFailure(code, stderr)),
  };
}

function killIfRunning(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

function appendCapped(acc: string, chunk: string): string {
  return acc.length >= STDERR_CAP_BYTES ? acc : (acc + chunk).slice(0, STDERR_CAP_BYTES);
}

function failedDial(failure: SshFailure): SshDialed {
  const stream = new PassThrough();
  stream.destroy();
  return { stream, failure: () => Promise.resolve(failure) };
}

// A short-lived helper process (a version probe, `go env`) that always settles within its
// timeout. `child_process.execFile` waits for 'close', which never comes while a grandchild still
// holds the inherited pipes (the rustup proxy's tool on Windows), and its timeout kills only the
// direct child — so a hung grandchild left the caller pending forever.
import type { EventEmitter } from 'node:events';
import { killTree, type TreeKillDeps } from './process-tree';

export interface BoundedChild extends EventEmitter {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
}

export type BoundedSpawn = (
  file: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string | undefined>;
    shell: false;
    windowsHide: true;
    stdio: ['ignore', 'pipe', 'ignore'];
    detached: boolean;
  },
) => BoundedChild;

const STDOUT_MAX = 1024 * 1024;

export function execFileBounded(
  file: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string | undefined>; timeout: number },
  deps: { spawn: BoundedSpawn; tree: TreeKillDeps },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let out = '';
    const child = deps.spawn(file, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      // POSIX: its own group, so the kill below reaches every descendant.
      detached: deps.tree.platform !== 'win32',
    });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const killAndFail = (why: string) => {
      if (child.pid !== undefined) void killTree(child.pid, deps.tree);
      finish(() => reject(new Error(`${file} ${why}`)));
    };
    const timer = setTimeout(() => killAndFail(`timed out after ${opts.timeout} ms`), opts.timeout);
    child.stdout?.on('data', (d: Buffer | string) => {
      out += String(d);
      if (out.length > STDOUT_MAX) killAndFail('wrote too much output');
    });
    child.on('error', (err: Error) => finish(() => reject(err)));
    // A failure is known at exit; a success waits for 'close' so stdout is complete.
    child.on('exit', (code: number | null, signal: string | null) => {
      if (code !== 0) finish(() => reject(new Error(`${file} exited ${code ?? signal}`)));
    });
    child.on('close', (code: number | null, signal: string | null) =>
      finish(() =>
        code === 0 ? resolve(out) : reject(new Error(`${file} exited ${code ?? signal}`)),
      ),
    );
  });
}

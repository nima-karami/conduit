// A short-lived helper process (a version probe, `go env`) that always settles within its
// timeout. `child_process.execFile` waits for 'close', which never comes while a grandchild still
// holds the inherited pipes (the rustup proxy's tool on Windows), and its timeout kills only the
// direct child — so a hung grandchild left the caller pending forever.
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { killTree, type TreeKillDeps } from './process-tree';

export interface BoundedChild extends EventEmitter {
  pid?: number;
  stdout: Readable | null;
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
/** After a clean exit, how long stdout may still drain before the output is taken as complete. */
export const EXIT_GRACE_MS = 200;

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
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      // Our end of a pipe an orphan may still hold; nothing more is read after settling.
      child.stdout?.destroy();
      fn();
    };
    const killAndFail = (why: string) => {
      if (settled) return;
      if (child.pid !== undefined) void killTree(child.pid, deps.tree);
      finish(() => reject(new Error(`${file} ${why}`)));
    };
    const timer = setTimeout(() => killAndFail(`timed out after ${opts.timeout} ms`), opts.timeout);
    child.stdout?.on('data', (d: Buffer | string) => {
      out += String(d);
      if (out.length > STDOUT_MAX) killAndFail('wrote too much output');
    });
    child.on('error', (err: Error) => finish(() => reject(err)));
    // A failure is known at exit. A success normally ends at 'close', once stdout is drained —
    // but a grandchild that outlived the child holds the pipe open, so 'close' never comes, and
    // no tree kill reaches it once its parent is gone. So exit 0 settles after a drain grace.
    child.on('exit', (code: number | null, signal: string | null) => {
      if (code !== 0) finish(() => reject(new Error(`${file} exited ${code ?? signal}`)));
      else grace = setTimeout(() => finish(() => resolve(out)), EXIT_GRACE_MS);
    });
    child.on('close', (code: number | null, signal: string | null) =>
      finish(() =>
        code === 0 ? resolve(out) : reject(new Error(`${file} exited ${code ?? signal}`)),
      ),
    );
  });
}

// PID-scoped tree kill. Never by image name: the user's own editors run the same binaries
// (docs/specs/2026-09-22-language-server-go.md §2.4).
import * as childProcess from 'node:child_process';
import * as path from 'node:path';

export interface TreeKillDeps {
  platform: NodeJS.Platform;
  systemRoot: string;
  execFile: typeof childProcess.execFile;
  execFileSync: typeof childProcess.execFileSync;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

const taskkill = (deps: TreeKillDeps) =>
  path.win32.join(deps.systemRoot, 'System32', 'taskkill.exe');
const taskkillArgs = (pid: number) => ['/PID', String(pid), '/T', '/F'];

/** POSIX servers are spawned `detached`, so `-pid` is their whole process group. */
function killGroup(pid: number, deps: TreeKillDeps): boolean {
  try {
    deps.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** Never rejects: a tree that is already gone is not an error the caller can act on. */
export function killTree(pid: number, deps: TreeKillDeps): Promise<boolean> {
  if (deps.platform !== 'win32') return Promise.resolve(killGroup(pid, deps));
  return new Promise((resolve) => {
    try {
      deps.execFile(taskkill(deps), taskkillArgs(pid), { windowsHide: true }, (err) =>
        resolve(!err),
      );
    } catch {
      resolve(false);
    }
  });
}

export function killTreeSync(pid: number, deps: TreeKillDeps): boolean {
  if (deps.platform !== 'win32') return killGroup(pid, deps);
  try {
    deps.execFileSync(taskkill(deps), taskkillArgs(pid), { windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function defaultTreeKillDeps(): TreeKillDeps {
  return {
    platform: process.platform,
    systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows',
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    kill: (pid, signal) => process.kill(pid, signal),
  };
}

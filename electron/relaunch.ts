import { spawn } from 'node:child_process';
import { app } from 'electron';

// Chromium launches children with PR_SET_NO_NEW_PRIVS, so on Linux `app.relaunch()` yields a
// Conduit where setuid pkexec can never work (CON-74). A Node-spawned waiter doesn't set it.

/** The file to exec: an AppImage's execPath lives in its mount, which vanishes when we exit. */
export function relaunchBinary(env: NodeJS.ProcessEnv, execPath: string): string {
  return env.APPIMAGE || execPath;
}

/**
 * argv for `/bin/sh` that waits for `pid` to exit (it holds the single-instance lock, so an
 * earlier start would just hand off to it and quit) and then execs `binary` with `args`.
 */
export function waiterArgv(pid: number, binary: string, args: readonly string[]): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`);
  const script = `while kill -0 ${pid} 2>/dev/null; do sleep 0.1; done; exec "$0" "$@"`;
  return ['-c', script, binary, ...args];
}

/** Starts Conduit again once this process exits; `args` replaces argv after the executable. */
export function relaunchApp(args: readonly string[] = process.argv.slice(1)): void {
  if (process.platform !== 'linux') {
    app.relaunch({ args: [...args] });
    return;
  }
  const child = spawn(
    '/bin/sh',
    waiterArgv(process.pid, relaunchBinary(process.env, process.execPath), args),
    { detached: true, stdio: 'ignore' },
  );
  child.on('error', (error) => console.error('relaunch waiter failed to start', error));
  child.unref();
}

// Real OS temp roots for tests that exercise path containment / realpath behaviour
// (fs-mutations, path-guard). Roots are realpath-resolved so the symlink stage behaves
// like production, tracked for teardown, and never created inside the repo.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onTestFinished } from 'vitest';

/**
 * Returns a `root()` factory that mints tracked temp dirs and a `cleanup()` the caller
 * wires into `afterEach`. Each root is resolved to its real path (so symlink/realpath
 * containment checks see the same path production does).
 */
export function tempRoots(defaultPrefix: string) {
  const created: string[] = [];
  const root = (prefix = defaultPrefix): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(dir);
    return fs.realpathSync.native(dir);
  };
  const cleanup = (): void => {
    for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  };
  return { root, cleanup };
}

/** Keep fixture cleanup tied to the test, including failures during setup. */
export function testTempDir(prefix: string, parent = os.tmpdir()): string {
  let dir: string | undefined;
  onTestFinished(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  dir = fs.mkdtempSync(path.join(parent, prefix));
  return dir;
}

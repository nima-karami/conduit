// Real OS temp roots for tests that exercise path containment / realpath behaviour
// (fs-mutations, path-guard). Roots are realpath-resolved so the symlink stage behaves
// like production, tracked for teardown, and never created inside the repo.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Returns a `root()` factory that mints tracked temp dirs and a `cleanup()` the caller
 * wires into `afterEach`. Each root is resolved to its real path (so symlink/realpath
 * containment checks see the same path production does).
 */
export function tempRoots(defaultPrefix: string) {
  const created: string[] = [];
  const root = (prefix = defaultPrefix): string => {
    const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    created.push(d);
    return d;
  };
  const cleanup = (): void => {
    for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  };
  return { root, cleanup };
}

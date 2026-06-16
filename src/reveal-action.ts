/**
 * Pure helper for the "Reveal in Explorer" host action.
 *
 * When the target is a **directory**, the OS file manager should open the
 * folder itself (shell.openPath).  When it's a **file**, we want to open the
 * parent and select the file (shell.showItemInFolder).  This module isolates
 * that decision so it can be unit-tested without involving Electron's shell.
 */

import * as fs from 'node:fs';

export type RevealAction = 'openPath' | 'showItemInFolder';

/**
 * Determine the correct reveal action for `targetPath`.
 *
 * Uses `fs.statSync` to check whether the path is a directory.  If the path
 * doesn't exist or the stat call throws for any other reason, falls back to
 * `showItemInFolder` — that matches the original behaviour and is safe.
 */
export function revealActionFor(targetPath: string): RevealAction {
  try {
    return fs.statSync(targetPath).isDirectory() ? 'openPath' : 'showItemInFolder';
  } catch {
    // Path missing or inaccessible — fall back to the legacy behaviour.
    return 'showItemInFolder';
  }
}

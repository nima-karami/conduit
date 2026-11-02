import * as os from 'node:os';
import type { WindowsPtyInfo } from './protocol';

/**
 * @lydell/node-pty ships ConPTY only (no winpty agent) and ignores `useConpty`, so every Windows
 * PTY is ConPTY, a debugger attached or not. The renderer's xterm must be told the same; preload
 * reads it once per renderer load.
 */
export function windowsPtyInfo(
  platform: NodeJS.Platform,
  release: string,
): WindowsPtyInfo | undefined {
  if (platform !== 'win32') return undefined;
  return { backend: 'conpty', buildNumber: Number(release.split('.')[2]) };
}

export function currentWindowsPty(): WindowsPtyInfo | undefined {
  return windowsPtyInfo(process.platform, os.release());
}

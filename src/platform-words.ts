// OS wording for the trash and the file manager. One pure map from HostPlatform, so Linux and
// macOS never say "Recycle Bin" or "Explorer", and the Windows strings stay byte-identical.
import { platformFromNavigator } from './drag-out-policy';
import type { HostPlatform } from './lsp-binary';

export interface PlatformWords {
  /** The OS trash, as a noun: "Recycle Bin" or "Trash". */
  trash: string;
  /** The verb phrase for trashing: "Move to Recycle Bin" or "Move to Trash". */
  moveToTrash: string;
  /** Context-menu label that opens the path in the OS file manager. */
  reveal: string;
  /** Command-palette titles for the project and the active file. */
  revealProject: string;
  revealActiveFile: string;
}

const WORDS: Readonly<Record<HostPlatform, PlatformWords>> = {
  win32: {
    trash: 'Recycle Bin',
    moveToTrash: 'Move to Recycle Bin',
    reveal: 'Reveal in Explorer',
    revealProject: 'Reveal project in Explorer',
    revealActiveFile: 'Reveal active file in Explorer',
  },
  darwin: {
    trash: 'Trash',
    moveToTrash: 'Move to Trash',
    reveal: 'Reveal in Finder',
    revealProject: 'Reveal project in Finder',
    revealActiveFile: 'Reveal active file in Finder',
  },
  linux: {
    trash: 'Trash',
    moveToTrash: 'Move to Trash',
    reveal: 'Show in Files',
    revealProject: 'Show project in Files',
    revealActiveFile: 'Show active file in Files',
  },
};

export function platformWords(platform: HostPlatform): PlatformWords {
  return WORDS[platform];
}

/** The renderer's platform, mapped from `navigator.platform` once here for every webview caller. */
export const rendererPlatform: HostPlatform =
  typeof navigator === 'undefined' ? 'linux' : platformFromNavigator(navigator.platform);

/** Auto-save copy in one place (docs/specs/2026-09-28-auto-save.md §10). */
export const AUTO_SAVE_COPY = {
  settingLabel: 'Auto save',
  settingDesc: 'Save edited files automatically',
  modeLabels: {
    off: 'Off',
    afterDelay: 'After delay',
    onFocusChange: 'On focus change',
    onWindowChange: 'On window change',
  },
  delayLabel: 'Delay (ms)',
  delayHint: '100–60000 ms',
  delayError: 'Enter 100–60000 ms',
  saveFailed: (name: string, reason: string) => `Could not save ${name}: ${reason}`,
  partialFile: 'only its first 2 MB is loaded, and saving would cut the file short.',
  tailFile: 'only its last 2 MB is loaded, and saving would cut the file short.',
  invalidUtf8Refusal: "it isn't valid UTF-8, and saving would change its bytes.",
  mixedEolRefusal: 'its line endings are mixed, and saving would change them.',
  partialBanner: 'Large file — showing the first 2 MB, read-only.',
  tailBanner: 'Large log — showing the last 2 MB, read-only.',
  invalidUtf8Banner: "Not valid UTF-8 — read-only so saving can't change its bytes.",
  mixedEolBanner:
    'Line endings the editor would rewrite — read-only so this golden file stays byte-exact.',
  tailLine: (line: number) =>
    `This log is shown from its last 2 MB — line ${line} may be outside it.`,
  changedOnDisk: (name: string) => `${name} changed on disk. Auto-save is paused for this file.`,
  deletedOnDisk: (name: string) => `${name} was deleted on disk.`,
  overwrite: 'Overwrite',
  reload: 'Reload from disk',
  close: 'Close',
  tabConflict: 'Changed on disk — auto-save paused',
  closeFallback: (reason: string) => `Couldn't save automatically: ${reason}`,
  saveFailedMany: (n: number) => `Could not save ${n} file${n === 1 ? '' : 's'}`,
} as const;

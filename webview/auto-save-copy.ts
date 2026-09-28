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
  changedOnDisk: (name: string) => `${name} changed on disk. Auto-save is paused for this file.`,
  deletedOnDisk: (name: string) => `${name} was deleted on disk.`,
  overwrite: 'Overwrite',
  reload: 'Reload from disk',
  close: 'Close',
  tabConflict: 'Changed on disk — auto-save paused',
  closeFallback: (reason: string) => `Couldn't save automatically: ${reason}`,
  saveFailedMany: (n: number) => `Could not save ${n} file${n === 1 ? '' : 's'}`,
} as const;

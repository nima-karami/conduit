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
} as const;

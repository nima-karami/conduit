/**
 * Build the OS "Open with…" application-chooser command for a file.
 *
 * Only Windows has a stable CLI primitive for the chooser dialog
 * (`rundll32 shell32.dll,OpenAs_RunDLL <path>`). On platforms without one, return
 * `null` so the caller falls back to opening the file with its default app
 * (`shell.openPath`) — the menu item is never dead.
 *
 * Pure over its inputs so the command is unit-testable without spawning anything.
 */
export function openWithCommand(
  platform: NodeJS.Platform,
  filePath: string,
): { command: string; args: string[] } | null {
  if (platform === 'win32') {
    return { command: 'rundll32.exe', args: ['shell32.dll,OpenAs_RunDLL', filePath] };
  }
  return null;
}

/**
 * Find the directory argument in a process `argv`. The "Open in Conduit" Explorer action
 * launches `Conduit.exe "<dir>"`, so on launch (or via the single-instance `second-instance`
 * event) we scan argv for the folder to open. Skips the executable path (a file, so the
 * `isDir` check rejects it), the Electron dev `.` arg, and any `--flags`. Returns the first
 * remaining entry that `isDir` accepts, or `undefined`.
 *
 * `isDir` is injected so this stays pure and unit-testable without touching the filesystem.
 */
export function extractDirArg(
  argv: readonly string[],
  isDir: (p: string) => boolean,
): string | undefined {
  for (const arg of argv) {
    if (!arg || arg === '.' || arg.startsWith('-')) continue;
    if (isDir(arg)) return arg;
  }
  return undefined;
}

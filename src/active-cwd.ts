/**
 * Returns the effective working directory for a session.
 * Prefers `cwd` (live cd-tracked dir) when present and non-empty;
 * falls back to `projectPath`.
 */
export function activeCwd(s: { cwd?: string; projectPath: string }): string {
  return s.cwd && s.cwd.length > 0 ? s.cwd : s.projectPath;
}

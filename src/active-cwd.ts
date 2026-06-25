/**
 * Returns the effective working directory for a session.
 * Prefers `cwd` (live cd-tracked dir) when present and non-empty;
 * falls back to `projectPath`.
 */
export function activeCwd(s: { cwd?: string; projectPath: string }): string {
  return s.cwd && s.cwd.length > 0 ? s.cwd : s.projectPath;
}

/**
 * The directory every git surface (Changes, History, refs, switch, the branch indicator)
 * resolves against for a session: the active repo when one is selected (multi-repo
 * workspaces), else the live cwd. Change paths are relative to THIS root, so host and
 * renderer must agree — hence one shared definition. See the multi-repo-awareness spec.
 */
export function gitRootForSession(s: {
  activeRepoRoot?: string;
  cwd?: string;
  projectPath: string;
}): string {
  return s.activeRepoRoot ?? activeCwd(s);
}

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

/**
 * The git repository root a terminal's OWN link/commit resolution (and a Review opened from a
 * terminal commit click) keys off: the top-level of the session's LIVE cwd, via `run`
 * (`git rev-parse --show-toplevel`). Deliberately IGNORES `activeRepoRoot` — a terminal is a view
 * of its cwd, so a printed path or commit hash must resolve against the repo cwd lives in, even
 * when the UI pins a different repo active. Contrast {@link gitRootForSession}, which the git
 * surfaces (Changes/History/refs) use and which DOES honor the pin. Falls back to the cwd itself
 * when it is not inside a repo (empty rev-parse). `run` is injected so this stays host-free and
 * unit-testable.
 */
export async function sessionGitRoot(
  s: { cwd?: string; projectPath: string },
  run: (args: string[], cwd: string) => Promise<string>,
): Promise<string> {
  const cwd = activeCwd(s).replace(/\\/g, '/');
  return (await run(['rev-parse', '--show-toplevel'], cwd)).trim() || cwd;
}

// Build an @-mention reference for a code selection, to drop into the terminal so
// the agent (e.g. Claude Code) can resolve it. Cursor-style: a path + line range,
// relative to the session's project root when possible. Pure / unit-testable.

/** Normalise to forward slashes and drop a trailing slash. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Path of `absPath` relative to `root` when nested, else the basename. */
export function toRelative(root: string, absPath: string): string {
  const r = norm(root);
  const a = norm(absPath);
  if (r && (a === r || a.toLowerCase().startsWith(`${r.toLowerCase()}/`))) {
    return a.slice(r.length).replace(/^\/+/, '') || a;
  }
  return a.split('/').filter(Boolean).pop() || a;
}

/**
 * Format a mention for a 1-based line range. Collapses a single-line selection to
 * `#L<n>`. Example: `@src/app.ts#L10-L20`.
 */
export function formatMention(
  projectPath: string,
  absPath: string,
  startLine: number,
  endLine: number,
): string {
  const rel = toRelative(projectPath, absPath);
  const a = Math.min(startLine, endLine);
  const b = Math.max(startLine, endLine);
  const lines = b > a ? `#L${a}-L${b}` : `#L${a}`;
  return `@${rel}${lines}`;
}

/**
 * Pure host-side helpers for terminal commit-hash validation. The renderer detects
 * candidate hex tokens (webview/terminal-links.ts); the host re-asserts the hex class and
 * confirms each is a real commit object before linking. See
 * docs/specs/2026-06-29-terminal-commit-link.md §3.2.
 */

const COMMIT_HEX_RE = /^[0-9a-f]{7,40}$/;

/**
 * Host re-assertion of the renderer's shape: lowercase hex, 7–40 chars. A candidate string is
 * never passed to git until this passes (defense in depth, mirrors `git:switch`'s ref check).
 */
export function isCommitHex(token: string): boolean {
  return COMMIT_HEX_RE.test(token);
}

/** One token → its resolved full 40-char sha, or null when it is not a commit object. */
export interface CommitValidation {
  token: string;
  commit: string | null;
}

/**
 * Parse `git cat-file --batch-check` stdout, zipping its one-line-per-input output back to the
 * `tokens` fed on stdin (in order). A line resolves only when it names a real `commit` object
 * (`<40-hex> commit <size>`); `missing`, `ambiguous`, and non-commit types (blob/tree/tag) → null.
 */
export function parseBatchCheck(stdout: string, tokens: string[]): CommitValidation[] {
  const lines = stdout.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return tokens.map((token, i) => {
    const m = /^([0-9a-f]{40}) commit\b/.exec(lines[i] ?? '');
    return { token, commit: m ? m[1] : null };
  });
}

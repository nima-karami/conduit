/**
 * Derive the default session name from a folder path.
 *
 * Rules:
 * - Strip trailing slashes / backslashes (handles `C:\foo\` → `foo`).
 * - Accept both forward slashes and Windows backslashes.
 * - Windows drive roots (e.g. `C:\`) → the drive letter `C:`.
 * - Empty / falsy input falls back to the raw input string.
 * - Uniqueness is by session id — duplicate folder names produce the same
 *   title, and that is fine by design.
 */
export function sessionNameFromPath(p: string): string {
  if (!p) return p;
  // Normalise separators then strip a single trailing slash.
  const normalised = p.replace(/[\\/]+$/, '');
  const parts = normalised.split(/[\\/]/);
  const last = parts[parts.length - 1];
  // last is empty only when path is bare e.g. "/" or "\\" — fall back to raw.
  return last || p;
}

/** `C:` / `/c:` at the head of a Windows path — the only shape that gets rewritten. */
const WIN_DRIVE = /^\/?([a-zA-Z]):(?=[\\/])/;

/**
 * The ONE spelling of an absolute path the renderer keys anything by — tabs (`docs.ts`'s
 * `idOf` is a case-sensitive string compare), reveal targets, and the go-to-definition opener.
 *
 * Windows paths become uppercase-drive + backslashes, which is what the host's `path.join`
 * hands the explorer tree, so a tree open and a navigation into the same file produce the same
 * key. Everything else (POSIX, UNC `\\server\…`, extended `\\?\…`) is left exactly as given:
 * those are already unambiguous, and rewriting separators inside them would break them.
 *
 * See docs/specs/2026-08-21-goto-definition-flows.md contract 4.
 */
export function canonicalPath(path: string): string {
  const m = WIN_DRIVE.exec(path);
  if (!m) return path;
  return `${m[1].toUpperCase()}:${path.slice(m[0].length).replace(/\//g, '\\')}`;
}

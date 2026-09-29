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

/**
 * What is left of `path` below `root` — `''` for the same path, `\x` / `/x` inside it — or null
 * when `path` is neither. Compared in the {@link canonicalPath} spelling: the explorer spells a
 * path with `/` where a tab spells it with `\`, and a raw compare between them never matches.
 */
export function pathBelow(path: string, root: string): string | null {
  const p = canonicalPath(path);
  const r = canonicalPath(root).replace(/[\\/]+$/, '');
  if (!p.startsWith(r)) return null;
  const rest = p.slice(r.length);
  return rest === '' || rest[0] === '\\' || rest[0] === '/' ? rest : null;
}

/** Where `path` lives after `from` (the file itself, or a folder holding it) is renamed to `to`;
 *  null when the rename doesn't touch it. */
export function renamedPath(path: string, from: string, to: string): string | null {
  const rest = pathBelow(path, from);
  return rest === null ? null : canonicalPath(to.replace(/[\\/]+$/, '') + rest);
}

const DOT_SEGMENT = /(^|[\\/])\.{1,2}([\\/]|$)/;

/** A `.`/`..` segment lets a string-prefix containment check pass for a path outside the
 *  container — every path that confines something refuses one. */
export function hasDotSegment(path: string): boolean {
  return DOT_SEGMENT.test(path);
}

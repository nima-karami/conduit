// Pure card-id → spec-filename derivation (G3). Lives in `src/` so BOTH the host FS layer
// (electron/conduit-fs.ts) and the renderer (webview) can derive the same name from a card
// id — the renderer needs it to match a card against the host's list of spec filenames
// (which are sanitized stems), and the host needs it to read/write the file. See
// docs/adr/0002-conduit-artifact-format.md §2c and docs/specs/archive/2026-06-11-conduit-specs.md.

/**
 * Reduce an arbitrary card id to a single safe filename segment (no extension). Card ids
 * in this app are slug-like, but a hand-edited / agent-written board.json could carry a
 * hostile id, so this is defensive. Guarantees: no path separator, no leading dot (so the
 * result can't be `.`/`..`/a dotfile and can't escape via traversal), never empty.
 * Examples: `../../etc/passwd` → `passwd`, `/abs/evil` → `evil`, `..` → `_`,
 * `weird id!` → `weird_id_`.
 */
export function safeSpecFileName(cardId: string): string {
  // Last path segment only: collapses `../`, `a/b`, and absolute paths to their basename.
  // Split on BOTH separators ourselves so a `\` (on POSIX) or `/` (on Windows) in a
  // hostile id can't slip past a host-specific path.basename.
  const lastSegment = (cardId ?? '').split(/[/\\]/).pop() ?? '';
  // Replace anything that isn't a safe filename char, then strip leading dots.
  const cleaned = lastSegment.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned : '_';
}

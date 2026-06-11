/**
 * md-links.ts — Markdown link classification and resolution.
 *
 * Given an href and the current document's absolute path, produces a typed
 * result so the viewer can route each link non-destructively.
 *
 * NOTE: This module runs in the browser bundle (platform: 'browser') so it
 * must NOT import node:path or any Node.js built-ins. All path operations are
 * implemented inline using string manipulation that handles both Windows
 * backslash and POSIX forward-slash separators.
 *
 * Link kinds:
 *  - anchor       → scroll to in-page element (href starts with #)
 *  - relative-file → resolve against dirname(docPath)
 *  - absolute-file → windows drive (C:\) or posix-absolute (/foo) path
 *  - external     → http(s):// → open in system browser
 *  - other        → mailto:, data:, javascript:, etc. → inert
 */

export type MdLinkKind = 'anchor' | 'relative-file' | 'absolute-file' | 'external' | 'other';

export interface MdLinkResult {
  kind: MdLinkKind;
  /**
   * For file kinds: the resolved absolute path (fragment stripped, separators
   * normalised to backslash on Windows doc paths, forward-slash otherwise).
   * Undefined for non-file kinds.
   */
  resolvedPath?: string;
  /**
   * For file links the fragment component (e.g. `section-1`), empty string if
   * absent. For anchor links, the whole href (minus the leading `#`) is the
   * fragment.
   */
  fragment?: string;
}

// Windows drive-letter pattern: one letter followed by colon and separator
const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

/**
 * Decode %XX sequences in a file path so that file-system resolution works
 * correctly (e.g. `my%20doc.md` → `my doc.md`).
 */
function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Split href into [pathPart, fragment]. The fragment is the portion after
 * the first `#`; empty string when absent.
 */
function splitFragment(href: string): [string, string] {
  const hashIdx = href.indexOf('#');
  if (hashIdx === -1) return [href, ''];
  return [href.slice(0, hashIdx), href.slice(hashIdx + 1)];
}

/**
 * Return the directory part of a path (everything before the last
 * separator). Works for both Windows (`\`) and POSIX (`/`) paths.
 */
function dirName(p: string): string {
  // Remove trailing separators first
  const trimmed = p.replace(/[\\/]+$/, '');
  const last = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (last === -1) return '.';
  // Keep the separator in the result so joining works correctly
  return trimmed.slice(0, last + 1);
}

/**
 * Join a base directory path to a relative path and normalise the result.
 * Handles `..` and `.` components. Preserves the separator style of the
 * base path (backslash for Windows doc paths, forward-slash for POSIX).
 */
function resolvePath(dir: string, rel: string): string {
  // Detect the separator from the base directory.
  const sep = dir.includes('\\') ? '\\' : '/';

  // Normalise the relative path to use the same separator.
  const normRel = rel.replace(/[\\/]/g, sep);

  // Split into segments. Start from the base directory segments.
  const base = dir.replace(/[\\/]+$/, '');
  const baseParts = base.split(/[\\/]/);

  // Process each segment of the relative path.
  const relParts = normRel.split(sep).filter((p) => p !== '.');
  for (const part of relParts) {
    if (part === '..') {
      // Pop the last segment (never go above drive root).
      if (baseParts.length > 1) baseParts.pop();
    } else if (part !== '') {
      baseParts.push(part);
    }
  }

  return baseParts.join(sep);
}

/**
 * Classify and resolve an href relative to the current document's absolute
 * path.
 *
 * @param href     The raw href from the markdown link
 * @param docPath  The absolute path of the document being viewed. On Windows
 *                 this will typically contain backslashes.
 */
export function resolveMdLink(href: string | null | undefined, docPath: string): MdLinkResult {
  const raw = (href ?? '').trim();
  if (!raw) return { kind: 'other' };

  // ── Anchor (in-document) ───────────────────────────────────────────────────
  if (raw.startsWith('#')) {
    return { kind: 'anchor', fragment: raw.slice(1) };
  }

  // ── Split fragment before further analysis ─────────────────────────────────
  // Must happen BEFORE scheme detection so `C:\file.md#section` is not
  // mistaken for a scheme (the `C:` portion is one character, not two+).
  const [pathPart, fragment] = splitFragment(raw);

  // Decode %XX sequences (handles spaces encoded as %20 in file hrefs).
  const decoded = decodePath(pathPart);

  // ── Windows absolute path: drive letter (C:\) or UNC (\\server\share) ──────
  const isWindowsAbs = WIN_DRIVE_RE.test(decoded) || decoded.startsWith('\\\\');

  // ── POSIX absolute path: starts with / ────────────────────────────────────
  const isPosixAbs = decoded.startsWith('/');

  if (isWindowsAbs || isPosixAbs) {
    // Normalise to use consistent separators (backslash for Windows paths)
    const resolvedPath = decoded.replace(/\//g, isWindowsAbs ? '\\' : '/');
    return { kind: 'absolute-file', resolvedPath, fragment };
  }

  // ── URL schemes ────────────────────────────────────────────────────────────
  // Check AFTER ruling out Windows drive letters.
  // RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) followed by ":"
  // We require at least 2 chars before ":" to exclude single-letter Windows drive
  // letters (already handled above, but defence-in-depth).
  const lc = raw.toLowerCase();
  if (lc.startsWith('http://') || lc.startsWith('https://')) {
    return { kind: 'external' };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]+:/.test(raw)) {
    // mailto:, data:, javascript:, tel:, file:, etc.
    return { kind: 'other' };
  }

  // ── Relative file path ─────────────────────────────────────────────────────
  // Includes: ./foo.md, ../foo/bar.md, bare "foo.md", "images/photo.png"
  const docDir = dirName(docPath);
  const resolvedPath = resolvePath(docDir, decoded);
  return { kind: 'relative-file', resolvedPath, fragment };
}

/**
 * Return true if the resolved path is a markdown file (by extension).
 * Used to decide rendered-view vs code-editor routing.
 */
export function isMdPath(resolvedPath: string): boolean {
  return /\.md$/i.test(resolvedPath);
}

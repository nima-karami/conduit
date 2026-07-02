/**
 * md-links.ts — Markdown link classification and resolution.
 *
 * Runs in the browser bundle (platform: 'browser'), so it must NOT import
 * node:path or any Node.js built-ins — all path operations are inline string
 * manipulation handling both Windows backslash and POSIX forward-slash.
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
   * The fragment component (e.g. `section-1`), '' if absent. For anchor links
   * this is the whole href minus the leading `#`.
   */
  fragment?: string;
}

const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

/** Decode %XX so file-system resolution works (e.g. `my%20doc.md` → `my doc.md`). */
function decodePath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Split href into [pathPart, fragment] at the first `#`; fragment is '' when absent. */
function splitFragment(href: string): [string, string] {
  const hashIdx = href.indexOf('#');
  if (hashIdx === -1) return [href, ''];
  return [href.slice(0, hashIdx), href.slice(hashIdx + 1)];
}

/** Directory part of a path (before the last separator). Handles `\` and `/`. */
function dirName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const last = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (last === -1) return '.';
  return trimmed.slice(0, last + 1); // keep trailing separator so joining works
}

/**
 * Join a base directory to a relative path, resolving `..`/`.`. Preserves the
 * base path's separator style (backslash for Windows doc paths, else forward).
 */
function resolvePath(dir: string, rel: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const normRel = rel.replace(/[\\/]/g, sep);

  const base = dir.replace(/[\\/]+$/, '');
  const baseParts = base.split(/[\\/]/);

  const relParts = normRel.split(sep).filter((p) => p !== '.');
  for (const part of relParts) {
    if (part === '..') {
      if (baseParts.length > 1) baseParts.pop(); // never go above drive root
    } else if (part !== '') {
      baseParts.push(part);
    }
  }

  return baseParts.join(sep);
}

/** Classify and resolve an href relative to the document's absolute path. */
export function resolveMdLink(href: string | null | undefined, docPath: string): MdLinkResult {
  const raw = (href ?? '').trim();
  if (!raw) return { kind: 'other' };

  if (raw.startsWith('#')) {
    return { kind: 'anchor', fragment: raw.slice(1) };
  }

  // Split the fragment BEFORE scheme detection so `C:\file.md#section` isn't
  // mistaken for a scheme (the `C:` portion is one character, not two+).
  const [pathPart, fragment] = splitFragment(raw);

  const decoded = decodePath(pathPart);

  const isWindowsAbs = WIN_DRIVE_RE.test(decoded) || decoded.startsWith('\\\\');
  const isPosixAbs = decoded.startsWith('/');

  if (isWindowsAbs || isPosixAbs) {
    const resolvedPath = decoded.replace(/\//g, isWindowsAbs ? '\\' : '/');
    return { kind: 'absolute-file', resolvedPath, fragment };
  }

  // Scheme detection runs AFTER ruling out Windows drive letters.
  const lc = raw.toLowerCase();
  if (lc.startsWith('http://') || lc.startsWith('https://')) {
    return { kind: 'external' };
  }
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]+:/.test(raw)) {
    return { kind: 'other' };
  }

  const docDir = dirName(docPath);
  const resolvedPath = resolvePath(docDir, decoded);
  return { kind: 'relative-file', resolvedPath, fragment };
}

/** True if the resolved path is a markdown file (gates rendered-view routing). */
export function isMdPath(resolvedPath: string): boolean {
  return /\.md$/i.test(resolvedPath);
}

export type MdImageKind = 'remote' | 'local' | 'data';

export interface MdImageResult {
  kind: MdImageKind;
  /** For kind 'local': the resolved absolute filesystem path to load via the host. */
  resolvedPath?: string;
  /** For kind 'remote'/'data': the src to use directly in `<img>` (unchanged). */
  src?: string;
}

/**
 * Classify a markdown image `src` for the rendered view: a remote URL / data URI renders
 * as-is (`<img src>` unchanged), while a relative/absolute LOCAL file path resolves against
 * the document's directory so its bytes can be loaded through the host (the webview is served
 * from `file://` at the dist dir, so an unresolved relative src 404s — the north-star bug).
 *
 * Reuses `resolveMdLink`'s path classification; `data:` is special-cased first because that
 * function treats it as an opaque `other` scheme.
 */
export function resolveMdImage(src: string | null | undefined, docPath: string): MdImageResult {
  const raw = (src ?? '').trim();
  if (!raw) return { kind: 'remote', src: '' };
  if (/^data:/i.test(raw)) return { kind: 'data', src: raw };

  const link = resolveMdLink(raw, docPath);
  if ((link.kind === 'relative-file' || link.kind === 'absolute-file') && link.resolvedPath) {
    return { kind: 'local', resolvedPath: link.resolvedPath };
  }
  // external (http/https), anchor, other schemes (blob:, protocol-relative): render as-is.
  return { kind: 'remote', src: raw };
}

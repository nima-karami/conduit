/**
 * Classification and decoding of link URIs a terminal hands over (OSC 8 targets and printed
 * `file://` URLs; plan 2026-10-16-terminal-path-links Contracts "v1 OSC 8 / file://"). The
 * target is chosen by terminal output, so it is untrusted: the host decodes it here and then
 * confines it (src/path-link-confine.ts). Browser-safe and hand-parsed, never `new URL`, which
 * collapses `..` (ADR 0005 §4).
 */
import {
  isAbsoluteToken,
  isUncLike,
  normalizeAbs,
  type PathPlatform,
} from './path-token-normalize';

export type LinkUriClass = 'external' | 'file' | 'ignore';

const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const DRIVE_RE = /^[A-Za-z]:[\\/]/;
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto']);
// Any C0 control or DEL: a decoded NUL truncates the path in native code, and no other control
// byte belongs in a path a terminal printed.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function classifyLinkUri(uri: string): LinkUriClass {
  if (DRIVE_RE.test(uri)) return 'file';
  const scheme = SCHEME_RE.exec(uri)?.[1].toLowerCase();
  if (scheme !== undefined) {
    if (EXTERNAL_SCHEMES.has(scheme)) return 'external';
    return scheme === 'file' ? 'file' : 'ignore';
  }
  if (isUncLike(uri)) return 'ignore';
  return uri.startsWith('/') ? 'file' : 'ignore';
}

/** `#L42` / `#L42C7` (VS Code, GitHub) as line/col; any other fragment is dropped. */
function splitFragment(s: string): { rest: string; line?: number; col?: number } {
  const hash = s.indexOf('#');
  if (hash < 0) return { rest: s };
  const m = /^L(\d+)(?:C(\d+))?$/.exec(s.slice(hash + 1));
  return {
    rest: s.slice(0, hash),
    ...(m ? { line: Number(m[1]) } : {}),
    ...(m?.[2] !== undefined ? { col: Number(m[2]) } : {}),
  };
}

const LINE_COL_RE = /:(\d+)(?::(\d+))?$/;

/** Null for anything that is not a confined-able local absolute path — see the plan's
 *  Contracts for every refused form. Decodes a `file:` URI once; a scheme-less path is taken
 *  literally. */
export function decodeFileUri(
  uri: string,
  platform: PathPlatform,
): { path: string; line?: number; col?: number } | null {
  let raw: string;
  let encoded: boolean;
  if (/^file:/i.test(uri)) {
    let rest = uri.slice('file:'.length);
    if (rest.startsWith('//')) {
      const after = rest.slice(2);
      const slash = after.indexOf('/');
      const authority = slash < 0 ? after : after.slice(0, slash);
      // Anything but the local host would be a UNC share once handed to the OS.
      if (authority !== '' && authority.toLowerCase() !== 'localhost') return null;
      rest = slash < 0 ? '' : after.slice(slash);
    }
    if (!rest.startsWith('/')) return null;
    raw = rest;
    encoded = true;
  } else if (classifyLinkUri(uri) === 'file') {
    raw = uri;
    encoded = false;
  } else {
    return null;
  }

  // Before decoding, so an encoded %23 / %3F / %3A stays part of the name.
  const frag = splitFragment(raw);
  let body = frag.rest;
  if (encoded) {
    const q = body.indexOf('?');
    if (q >= 0) body = body.slice(0, q);
  }
  let line = frag.line;
  let col = frag.col;
  const lc = line === undefined ? LINE_COL_RE.exec(body) : null;
  if (lc) {
    body = body.slice(0, lc.index);
    line = Number(lc[1]);
    if (lc[2] !== undefined) col = Number(lc[2]);
  }

  let decoded = body;
  if (encoded) {
    try {
      decoded = decodeURIComponent(body);
    } catch {
      // Malformed percent-encoding: refused like any other undecodable target.
      return null;
    }
  }
  if (hasControlChar(decoded)) return null;
  if (isUncLike(decoded)) return null;
  // `file:///G:/x` carries the drive after the path's leading slash.
  const local = encoded && /^\/[A-Za-z]:(?:[\\/]|$)/.test(decoded) ? decoded.slice(1) : decoded;
  // An empty segment has no use in a file URI; refusing it closes `G:/../..//host` and friends,
  // which only normalise away from a UNC form by accident.
  if (local.replace(/\\/g, '/').includes('//')) return null;
  if (!isAbsoluteToken(local, platform)) return null;
  const path = normalizeAbs(local, platform);
  if (isUncLike(path)) return null;
  return {
    path,
    ...(line !== undefined ? { line } : {}),
    ...(col !== undefined ? { col } : {}),
  };
}

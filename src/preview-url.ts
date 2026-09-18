/**
 * `conduit-preview:` URL construction and parsing, plus the extension → Content-Type
 * table the preview handler serves with. See ADR 0005.
 *
 * The host is an opaque per-root token, never a volume — one origin per workspace root.
 * This module never sees an absolute path; the token → root table lives in the host.
 *
 * Plain string logic, no node builtins: the renderer imports this module and its esbuild
 * bundle is `platform: 'browser'` with no shims (`esbuild.mjs:29-37`).
 */

export const PREVIEW_SCHEME = 'conduit-preview';

const PREFIX = `${PREVIEW_SCHEME}://`;
const ROOT_TOKEN = /^[a-z0-9]{8,32}$/;

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

/** Token shape: 8-32 chars of [a-z0-9]. Exported so the host can validate what it mints. */
export function isValidRootToken(token: string): boolean {
  return ROOT_TOKEN.test(token);
}

/**
 * Build a preview URL. `rootToken` is an opaque per-run token identifying ONE workspace
 * root (the host owns the token→root table); `relSegments` are the path segments below
 * that root, unencoded.
 */
export function buildPreviewUrl(rootToken: string, relSegments: readonly string[]): string {
  return `${PREFIX}${rootToken}/${relSegments.map(encodeURIComponent).join('/')}`;
}

/**
 * Parse one back. Returns null for a foreign scheme, an empty/invalid host, an empty path,
 * or any segment that is `.` or `..`.
 *
 * Parsed by hand, not through `URL`: the WHATWG parser silently collapses `..` and `%2e%2e`
 * into the resolved path, so traversal could never be seen here, let alone refused.
 */
export function parsePreviewUrl(url: string): { token: string; segments: string[] } | null {
  if (!url.startsWith(PREFIX)) return null;
  const rest = url.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;

  const token = rest.slice(0, slash);
  if (!isValidRootToken(token)) return null;

  let segments: string[];
  try {
    segments = rest
      .slice(slash + 1)
      .split('/')
      .map(decodeURIComponent);
  } catch {
    return null;
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }
  return { token, segments };
}

/** True when `src` parses as a preview URL — the webview guard's allow test. */
export function isPreviewUrl(src: string): boolean {
  return parsePreviewUrl(src) !== null;
}

/** Extension → Content-Type. Unknown → 'application/octet-stream'. */
export function previewContentType(pathOrExt: string): string {
  const dot = pathOrExt.lastIndexOf('.');
  if (dot < 0) return DEFAULT_CONTENT_TYPE;
  return CONTENT_TYPES[pathOrExt.slice(dot).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

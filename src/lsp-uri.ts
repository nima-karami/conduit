import { canonicalPath } from './canonical-path';

const DRIVE_PATH = /^([a-zA-Z]):[\\/]/;
const DRIVE_URI_PATH = /^\/([a-zA-Z]):(\/|$)/;

const encodeSegments = (segs: readonly string[]): string => segs.map(encodeURIComponent).join('/');

/** Absolute path → `file:` URI. Never reads the host platform: the path's own shape decides
 *  (spec §3.5), so Windows spellings are testable on the Linux CI runner. */
export function pathToFileUri(path: string): string {
  if (path.startsWith('\\\\')) {
    const [host = '', ...rest] = path.slice(2).split(/[\\/]/);
    return `file://${host}/${encodeSegments(rest)}`;
  }
  if (DRIVE_PATH.test(path)) {
    const [drive = '', ...rest] = canonicalPath(path).split('\\');
    return `file:///${drive}/${encodeSegments(rest)}`;
  }
  return `file://${encodeSegments(path.split('/'))}`;
}

/** `file:` URI → the `canonicalPath` spelling; null for any other scheme or a malformed escape. */
export function fileUriToPath(uri: string): string | null {
  if (!uri.toLowerCase().startsWith('file://')) return null;
  const rest = uri.slice('file://'.length);
  const slash = rest.indexOf('/');
  const host = slash === -1 ? rest : rest.slice(0, slash);
  let path: string;
  try {
    path = decodeURIComponent(slash === -1 ? '/' : rest.slice(slash));
  } catch {
    return null;
  }
  if (host !== '' && host.toLowerCase() !== 'localhost') {
    return `\\\\${host}${path.replace(/\//g, '\\')}`;
  }
  if (DRIVE_URI_PATH.test(path)) return canonicalPath(path.slice(1));
  return path;
}

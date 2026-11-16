// A minimal ustar writer for the server tree pushed to a remote (plan decision 6). Regular files
// only: no links, devices or directories are emitted, so the receiver has nothing to follow.
import { createHash } from 'node:crypto';
import type { ManifestEntry } from './remote-scripts';

export interface TreeFile {
  /** Relative, `/`-separated. */
  path: string;
  data: Buffer;
  /** Permission bits only, e.g. 0o755. */
  mode: number;
}

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
// The size field is 11 octal digits plus a NUL: 8 GiB - 1 is the most it can hold.
const SIZE_MAX = 0o77777777777;

function assertPath(path: string): void {
  // A `\` is a separator on the receiving Windows side, so a POSIX-looking name could escape there.
  if (path === '' || path.startsWith('/') || path.endsWith('/') || path.includes('\\')) {
    throw new Error(`unsafe tree path: ${JSON.stringify(path)}`);
  }
  if (path.includes('\0')) throw new Error(`tree path holds a NUL: ${JSON.stringify(path)}`);
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`unsafe tree path: ${JSON.stringify(path)}`);
  }
}

/** The ustar name and prefix for a path. Splits at a `/` when the whole path is over 100 bytes. */
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= NAME_MAX) return { name: path, prefix: '' };
  const segments = path.split('/');
  // Longest prefix first, so the name stays as short as it can be.
  for (let i = segments.length - 1; i >= 1; i--) {
    const prefix = segments.slice(0, i).join('/');
    const name = segments.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= PREFIX_MAX && Buffer.byteLength(name) <= NAME_MAX) {
      return { name, prefix };
    }
  }
  throw new Error(`tree path does not fit a ustar header: ${JSON.stringify(path)}`);
}

/** A numeric header field: octal digits, zero-padded, NUL-terminated, exactly `width` bytes. */
function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function headerOf(file: TreeFile): Buffer {
  const { name, prefix } = splitName(file.path);
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, NAME_MAX, 'utf8');
  h.write(octal(file.mode, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii'); // uid
  h.write(octal(0, 8), 116, 'ascii'); // gid
  h.write(octal(file.data.length, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii'); // mtime: fixed, so the same tree packs to the same bytes
  h.write('        ', 148, 'ascii'); // the checksum is summed with this field blank
  h.write('0', 156, 'ascii'); // regular file
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, PREFIX_MAX, 'utf8');
  let sum = 0;
  for (const byte of h) sum += byte;
  // Six octal digits, then NUL and a space: the layout tar itself writes.
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

/**
 * The tree as a ustar stream, with entries in the order given. Each file is padded to whole
 * blocks, and two zero blocks end the archive.
 */
export function packTree(files: TreeFile[]): Buffer {
  const seen = new Set<string>();
  const parts: Buffer[] = [];
  for (const file of files) {
    assertPath(file.path);
    if (seen.has(file.path)) throw new Error(`duplicate tree path: ${file.path}`);
    seen.add(file.path);
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o7777) {
      throw new Error(`mode out of range for ${file.path}: ${file.mode}`);
    }
    if (file.data.length > SIZE_MAX) throw new Error(`file too large for ustar: ${file.path}`);
    parts.push(headerOf(file));
    const body = Buffer.alloc(Math.ceil(file.data.length / BLOCK) * BLOCK);
    file.data.copy(body);
    parts.push(body);
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** The manifest the receiver checks each unpacked file against. */
export function manifestOf(files: TreeFile[]): ManifestEntry[] {
  return files.map((file) => ({
    path: file.path,
    sha256: createHash('sha256').update(file.data).digest('hex'),
    size: file.data.length,
  }));
}

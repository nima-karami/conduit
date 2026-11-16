import { constants as fsConstants, promises as fsp } from 'node:fs';
import * as path from 'node:path';

// O_NONBLOCK: opening a FIFO with no writer would otherwise block the feed-gap queue for good.
// Windows has no such flag; a named pipe there is refused by the isFile check below.
const TRANSCRIPT_OPEN_FLAGS =
  process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;

/**
 * The transcript_path in a hook payload is agent-controlled, so it is confined before any
 * filesystem call. Pure: the caller decides what to do with a refusal. `paths` is injected so a
 * win32 path can be tested on a posix CI runner; containment is by `relative`, which that module
 * already makes case-insensitive on win32, rather than by the host-platform isInsideRoot.
 */
// posix and win32 share one type, so a win32 module is accepted wherever the default is
type PlatformPath = typeof path.posix;

export function confineTranscriptPath(
  p: string,
  claudeHome: string,
  paths: PlatformPath = path,
): string | null {
  // Checked on the raw string: the UNC and device forms are only spelled that way on win32.
  if (p.startsWith('\\\\') || p.startsWith('//')) return null;
  if (!paths.isAbsolute(p)) return null;
  const normalised = paths.resolve(p);
  const rel = paths.relative(paths.resolve(claudeHome, 'projects'), normalised);
  // rel is '' for the projects dir itself, and starts with '..' for an escape or a sibling.
  if (rel === '' || rel === '..' || rel.startsWith(`..${paths.sep}`) || paths.isAbsolute(rel)) {
    return null;
  }
  return normalised;
}

export async function readTranscriptSize(p: string): Promise<number> {
  const handle = await fsp.open(p, TRANSCRIPT_OPEN_FLAGS);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error(`transcript is not a regular file: ${p}`);
    return st.size;
  } finally {
    await handle.close();
  }
}

export async function readTranscriptRange(p: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const handle = await fsp.open(p, TRANSCRIPT_OPEN_FLAGS);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`transcript is not a regular file: ${p}`);
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buf, 0, end - start, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

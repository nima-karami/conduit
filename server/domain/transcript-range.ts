import { constants as fsConstants, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { isInsideRoot } from '../../src/path-guard';

// O_NONBLOCK: opening a FIFO with no writer would otherwise block the feed-gap queue for good.
// Windows has no such flag; a named pipe there is refused by the isFile check below.
const TRANSCRIPT_OPEN_FLAGS =
  process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;

/**
 * The transcript_path in a hook payload is agent-controlled, so it is confined before any
 * filesystem call. Pure: the caller decides what to do with a refusal.
 */
export function confineTranscriptPath(p: string, claudeHome: string): string | null {
  // Checked on the raw string: a UNC or device path is not absolute on Linux, and CI runs there.
  if (p.startsWith('\\\\') || p.startsWith('//')) return null;
  if (!path.isAbsolute(p)) return null;
  const normalised = path.resolve(p);
  const projects = path.resolve(claudeHome, 'projects');
  // isInsideRoot also accepts the root itself; a transcript is a file inside it.
  if (normalised === projects) return null;
  return isInsideRoot(normalised, projects) ? normalised : null;
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

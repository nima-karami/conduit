import { constants as fsConstants, promises as fsp } from 'node:fs';

// O_NONBLOCK: opening a FIFO with no writer would otherwise block the feed-gap queue for good.
// Windows has no such flag; a named pipe there is refused by the isFile check below.
const TRANSCRIPT_OPEN_FLAGS =
  process.platform === 'win32' ? 'r' : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;

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

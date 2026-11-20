import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';

export const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

async function statIfPresent(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export const isClaudeId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);

export async function checkTranscript(
  projects: string,
  candidate: string,
  id: string,
): Promise<string> {
  const relative = path.relative(projects, candidate).split(path.sep);
  if (
    relative.length !== 2 ||
    relative[0] === '..' ||
    path.isAbsolute(relative[0]) ||
    relative[1] !== `${id}.jsonl`
  ) {
    throw new Error('Claude transcript is outside its project store');
  }
  const config = await realpath(path.dirname(projects));
  const root = path.join(config, 'projects');
  const project = path.join(root, relative[0]);
  for (const directory of [root, project]) {
    const stat = await statIfPresent(directory);
    if (stat && !stat.isDirectory()) throw new Error('Invalid Claude project directory');
  }
  return path.join(project, relative[1]);
}

export async function findTranscript(config: string, id: string): Promise<string | undefined> {
  if (!isClaudeId(id)) throw new Error('Invalid Claude conversation ID');
  const projects = path.join(config, 'projects');
  const entries = await readdir(projects, { withFileTypes: true });
  let match: string | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = await checkTranscript(
      projects,
      path.join(projects, entry.name, `${id}.jsonl`),
      id,
    );
    const stat = await statIfPresent(candidate);
    if (!stat) continue;
    if (!stat.isFile() || match) throw new Error('Ambiguous or invalid Claude transcript');
    match = candidate;
  }
  return match;
}

const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;

export async function appendTitle(file: string, record: object): Promise<void> {
  if (!(await lstat(file)).isFile()) throw new Error('Invalid Claude transcript');
  const handle = await open(file, constants.O_RDWR | constants.O_APPEND | noFollow | nonBlock);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Invalid Claude transcript');
    if (stat.size > 0) {
      const lastByte = Buffer.alloc(1);
      const { bytesRead } = await handle.read(lastByte, 0, 1, stat.size - 1);
      if (bytesRead !== 1 || lastByte[0] !== 10) {
        throw new Error('Claude transcript ends with an incomplete record');
      }
    }
    // One append keeps the record together across independent writers.
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if ((await handle.write(bytes)).bytesWritten !== bytes.length) {
      throw new Error('Incomplete Claude title append');
    }
  } finally {
    await handle.close();
  }
}

export interface TranscriptCursor {
  inode: bigint;
  device: bigint;
  offset: number;
  fragment: Buffer;
  anchor?: Buffer;
  restarted?: boolean;
}

export async function readTitles(
  file: string,
  prior: TranscriptCursor | undefined,
  onLine: (line: string) => void,
): Promise<TranscriptCursor> {
  if (!(await lstat(file)).isFile()) throw new Error('Invalid Claude transcript');
  const handle = await open(file, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error('Invalid Claude transcript');
    const size = Number(stat.size);
    let sameFile =
      prior && stat.ino === prior.inode && stat.dev === prior.device && size >= prior.offset;
    if (sameFile && prior?.anchor?.length) {
      // A truncate and rewrite between polls can retain both the inode and length.
      const anchor = Buffer.allocUnsafe(prior.anchor.length);
      const { bytesRead } = await handle.read(
        anchor,
        0,
        anchor.length,
        prior.offset - anchor.length,
      );
      sameFile = bytesRead === anchor.length && anchor.equals(prior.anchor);
    }
    const cursor: TranscriptCursor =
      sameFile && prior
        ? { ...prior, restarted: false }
        : {
            inode: stat.ino,
            device: stat.dev,
            offset: 0,
            fragment: Buffer.alloc(0),
            restarted: Boolean(prior),
          };
    if (cursor.offset >= size) return cursor;
    const chunk = Buffer.allocUnsafe(Math.min(size - cursor.offset, 64 * 1024));
    while (cursor.offset < size) {
      const length = Math.min(chunk.length, size - cursor.offset);
      const { bytesRead } = await handle.read(chunk, 0, length, cursor.offset);
      if (!bytesRead) break;
      cursor.offset += bytesRead;
      cursor.anchor = Buffer.from(chunk.subarray(Math.max(0, bytesRead - 32), bytesRead));
      const data = Buffer.concat([cursor.fragment, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
        onLine(data.toString('utf8', start, end));
        start = end + 1;
      }
      cursor.fragment = data.subarray(start);
    }
    return cursor;
  } finally {
    await handle.close();
  }
}

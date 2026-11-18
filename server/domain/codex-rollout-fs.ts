// see docs/specs/2026-11-13-scheduler-auto-resume.md §3 "Codex adapter"
import { constants, promises as fsp } from 'node:fs';
import type { CodexWatchDeps } from './codex-rollout-watch';

const MAX_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export type RolloutIdentity = { dev: number; ino: number; fileSize: number } | null;
export type RolloutReadEvent =
  | { kind: 'start'; identity: RolloutIdentity; highWater: number }
  | { kind: 'lines'; lines: string[]; cursor: number; discarding: boolean }
  | { kind: 'gap'; cursor: number; discarding: boolean }
  | { kind: 'end'; cursor: number; discarding: boolean };

const safeSize = (size: number): boolean => Number.isSafeInteger(size) && size >= 0;
const identityOf = (stat: { dev: number; ino: number; size: number }): RolloutIdentity =>
  Number.isSafeInteger(stat.dev) && stat.dev >= 0 && Number.isSafeInteger(stat.ino) && stat.ino > 0
    ? { dev: stat.dev, ino: stat.ino, fileSize: stat.size }
    : null;
const flags = constants.O_RDONLY | constants.O_NONBLOCK;

export class RolloutShortReadError extends Error {}

export function createRolloutFs(i: {
  onFirstLineTooLong(file: string): void;
  firstLineMaxBytes?: number;
  recordMaxBytes?: number;
  chunkBytes?: number;
}): Omit<CodexWatchDeps['fs'], 'readFrom'> & {
  readFrom(p: string, offset: number, discarding?: boolean): AsyncIterable<RolloutReadEvent>;
} {
  const firstCap = i.firstLineMaxBytes ?? MAX_BYTES;
  const cap = i.recordMaxBytes ?? MAX_BYTES;
  const chunkBytes = i.chunkBytes ?? CHUNK_BYTES;
  return {
    readdir: (p) => fsp.readdir(p),
    readFirstLine: async (p) => {
      const h = await fsp.open(p, flags).catch(() => null);
      if (!h) return null;
      try {
        const stat = await h.stat();
        if (!stat.isFile() || !safeSize(stat.size)) return null;
        const chunks: Buffer[] = [];
        let total = 0;
        while (total < firstCap && total < stat.size) {
          const buf = Buffer.alloc(Math.min(chunkBytes, firstCap - total, stat.size - total));
          const { bytesRead } = await h.read(buf, 0, buf.length, total);
          if (!bytesRead) return null;
          const chunk = buf.subarray(0, bytesRead);
          const nl = chunk.indexOf(0x0a);
          if (nl >= 0) {
            chunks.push(chunk.subarray(0, nl));
            return Buffer.concat(chunks).toString('utf8');
          }
          chunks.push(chunk);
          total += bytesRead;
        }
        if (total === firstCap) i.onFirstLineTooLong(p);
        return null;
      } finally {
        await h.close();
      }
    },
    readFrom: async function* (p, offset, initialDiscarding = false) {
      const h = await fsp.open(p, flags);
      try {
        const stat = await h.stat();
        if (!stat.isFile() || !safeSize(stat.size) || !safeSize(offset))
          throw new Error('invalid rollout file');
        const highWater = stat.size;
        yield { kind: 'start', identity: identityOf(stat), highWater };
        if (offset > highWater) throw new Error('rollout file truncated');
        let pos = offset;
        let cursor = offset;
        let discarding = initialDiscarding;
        let parts: Buffer[] = [];
        let length = 0;
        while (pos < highWater) {
          const buf = Buffer.alloc(Math.min(chunkBytes, highWater - pos));
          const { bytesRead } = await h.read(buf, 0, buf.length, pos);
          if (!bytesRead) throw new RolloutShortReadError('short rollout read');
          let index = 0;
          while (index < bytesRead) {
            const nl = buf.indexOf(0x0a, index);
            const end = nl >= 0 && nl < bytesRead ? nl + 1 : bytesRead;
            const segment = buf.subarray(index, end);
            pos += segment.length;
            index = end;
            if (discarding) {
              cursor = pos;
              if (nl >= 0 && nl < bytesRead) discarding = false;
              yield { kind: 'gap', cursor, discarding };
            } else if (length + segment.length > cap) {
              parts = [];
              length = 0;
              cursor = pos;
              discarding = !(nl >= 0 && nl < bytesRead);
              yield { kind: 'gap', cursor, discarding };
            } else {
              parts.push(segment);
              length += segment.length;
              if (nl >= 0 && nl < bytesRead) {
                const line = Buffer.concat(parts, length)
                  .subarray(0, length - 1)
                  .toString('utf8');
                parts = [];
                length = 0;
                cursor = pos;
                yield { kind: 'lines', lines: [line], cursor, discarding: false };
              }
            }
          }
        }
        yield { kind: 'end', cursor, discarding };
      } finally {
        await h.close();
      }
    },
    pathIdentity: async (p) => {
      const stat = await fsp.stat(p).catch(() => null);
      return stat?.isFile() && safeSize(stat.size) ? identityOf(stat) : null;
    },
    exists: (p) =>
      fsp.access(p).then(
        () => true,
        () => false,
      ),
  };
}

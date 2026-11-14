// The Codex rollout watcher's file access: bounded first-line reads and whole-line tails.
// see docs/specs/2026-11-13-scheduler-auto-resume.md §3 "Codex adapter"
import { promises as fsp } from 'node:fs';
import type { CodexWatchDeps } from './codex-rollout-watch';

/** Real session_meta lines measured 19–23 KiB (docs/runs/2026-11-13-con-11/spike.md); 1 MiB leaves headroom. */
const ROLLOUT_FIRST_LINE_MAX_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export function createRolloutFs(i: {
  onFirstLineTooLong(file: string): void;
  firstLineMaxBytes?: number;
}): CodexWatchDeps['fs'] {
  const cap = i.firstLineMaxBytes ?? ROLLOUT_FIRST_LINE_MAX_BYTES;
  return {
    readdir: (p) => fsp.readdir(p),
    readFirstLine: async (p) => {
      const h = await fsp.open(p, 'r').catch(() => null);
      if (!h) return null;
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        while (total < cap) {
          const buf = Buffer.alloc(Math.min(CHUNK_BYTES, cap - total));
          const { bytesRead } = await h.read(buf, 0, buf.length, total);
          // A first line still being written: the next folder event reads it again.
          if (bytesRead === 0) return null;
          const chunk = buf.subarray(0, bytesRead);
          const nl = chunk.indexOf(0x0a);
          if (nl >= 0) {
            chunks.push(chunk.subarray(0, nl));
            return Buffer.concat(chunks).toString('utf8');
          }
          chunks.push(chunk);
          total += bytesRead;
        }
        i.onFirstLineTooLong(p);
        return null;
      } finally {
        await h.close();
      }
    },
    // Whole lines only: a byte offset never splits a UTF-8 character, and a line still being
    // written is read again next time.
    readFrom: async (p, offset) => {
      const h = await fsp.open(p, 'r');
      try {
        const { size } = await h.stat();
        if (size <= offset) return { data: '', size: Math.min(size, offset) };
        const buf = Buffer.alloc(size - offset);
        const { bytesRead } = await h.read(buf, 0, buf.length, offset);
        const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
        return { data: buf.subarray(0, end).toString('utf8'), size: offset + end };
      } finally {
        await h.close();
      }
    },
    exists: (p) =>
      fsp.access(p).then(
        () => true,
        () => false,
      ),
  };
}

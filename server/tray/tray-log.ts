import { appendFileSync, renameSync, statSync } from 'node:fs';
import { TRAY_LIMITS } from '../../src/contracts/tray-protocol';
import type { TrayLog } from './contracts';

export interface TrayLogFs {
  /** 0 for a missing file. */
  size(path: string): number;
  append(path: string, text: string): void;
  /** Replaces `to` if it exists. */
  rename(from: string, to: string): void;
}

export const nodeTrayLogFs: TrayLogFs = {
  size(path) {
    try {
      return statSync(path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  },
  append: (path, text) => appendFileSync(path, text, 'utf8'),
  rename: (from, to) => renameSync(from, to),
};

/**
 * Sync writes: the supervisor is the only writer (spec §12) and logs a handful of lines per event,
 * so ordering beats throughput. A log that can't be written must never take supervision down, so
 * the failure and the line go to stderr instead (the supervisor's hc terminal).
 */
export function createTrayLog(
  path: string,
  o: {
    fs?: TrayLogFs;
    now?: () => number;
    capBytes?: number;
    fallback?: (line: string) => void;
  } = {},
): TrayLog {
  const fs = o.fs ?? nodeTrayLogFs;
  const now = o.now ?? Date.now;
  const cap = o.capBytes ?? TRAY_LIMITS.logCapBytes;
  const fallback =
    o.fallback ??
    ((line: string) => {
      process.stderr.write(line);
    });
  return {
    write(level, who, message) {
      const line = `${new Date(now()).toISOString()} ${level} ${who} ${message.replace(/\r?\n|\r/g, ' ')}\n`;
      try {
        if (fs.size(path) + Buffer.byteLength(line, 'utf8') > cap) fs.rename(path, `${path}.1`);
        fs.append(path, line);
      } catch (error) {
        fallback(`tray.log write failed: ${String(error)}\n${line}`);
      }
    },
  };
}

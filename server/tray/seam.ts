import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type HelperToSupervisor, TRAY_LIMITS } from '../../src/contracts/tray-protocol';
import type { TrayLog, TraySeam } from './contracts';
import { parseHelperLine } from './framing';

export const TRAY_SEAM_OUT_FILE = 'tray-seam.jsonl';
export const TRAY_SEAM_IN_FILE = 'tray-seam-in.jsonl';

export interface SeamFs {
  append(path: string, text: string): void;
  /** null for a missing file. */
  read(path: string): Buffer | null;
}

const nodeSeamFs: SeamFs = {
  append: (p, text) => appendFileSync(p, text, 'utf8'),
  read(p) {
    try {
      return readFileSync(p);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
};

/**
 * Dev/e2e only; the caller gates it with `seamEnabled` (spec §14). Each mirrored line is
 * `{"dir":"in"|"out","message":{…}}`: `out` = to the helper, `in` = from it (or injected).
 */
export function createTraySeam(deps: {
  userData: string;
  fs?: SeamFs;
  setTimer(ms: number, cb: () => void): () => void;
  log: TrayLog;
}): TraySeam {
  const fs = deps.fs ?? nodeSeamFs;
  const outPath = path.join(deps.userData, TRAY_SEAM_OUT_FILE);
  const inPath = path.join(deps.userData, TRAY_SEAM_IN_FILE);
  return {
    mirror(dir, message) {
      fs.append(outPath, `${JSON.stringify({ dir, message })}\n`);
    },
    injected(cb: (m: HelperToSupervisor) => void) {
      let consumed = 0;
      let cancel: (() => void) | null = null;
      const poll = () => {
        try {
          const data = fs.read(inPath) ?? Buffer.alloc(0);
          if (data.length < consumed) consumed = 0;
          const end = data.lastIndexOf(0x0a);
          if (end >= consumed) {
            const text = data.subarray(consumed, end).toString('utf8');
            consumed = end + 1;
            for (const line of text.split(/\r?\n/)) {
              if (!line) continue;
              const m = parseHelperLine(line);
              if (m instanceof Error || m.type === 'unknown')
                deps.log.write('warn', 'supervisor', `tray seam: skipped invalid line: ${line}`);
              else cb(m);
            }
          }
        } catch (error) {
          deps.log.write('error', 'supervisor', `tray seam: ${String(error)}`);
        }
        if (cancel) cancel = deps.setTimer(TRAY_LIMITS.seamPollMs, poll);
      };
      cancel = deps.setTimer(TRAY_LIMITS.seamPollMs, poll);
      return () => {
        cancel?.();
        cancel = null;
      };
    },
  };
}

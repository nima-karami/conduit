import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';

export const POLICY_MAX_BYTES = 1024 * 1024;
export interface PolicyIo {
  read(): string | null;
  writeSync(text: string): true;
}
export function createPolicyIo(
  file: string,
  options: { maxBytes: number } = { maxBytes: POLICY_MAX_BYTES },
): PolicyIo {
  return {
    read() {
      let fd: number;
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error('Permissions store is not a regular file');
        if (stat.size > options.maxBytes) throw new Error('Permissions store is too large');
        const chunks: Buffer[] = [];
        let total = 0;
        while (true) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, options.maxBytes - total + 1));
          const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
          if (bytes === 0) return Buffer.concat(chunks, total).toString('utf8');
          total += bytes;
          if (total > options.maxBytes) throw new Error('Permissions store is too large');
          chunks.push(chunk.subarray(0, bytes));
        }
      } finally {
        fs.closeSync(fd);
      }
    },
    writeSync(text) {
      if (Buffer.byteLength(text) > options.maxBytes)
        throw new Error('Permissions store is too large');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteFileSync(file, text, fs, { mode: 0o600, syncData: true, retryLockedRename: true });
      return true;
    },
  };
}

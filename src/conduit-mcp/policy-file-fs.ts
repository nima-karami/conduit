import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';

export const POLICY_MAX_BYTES = 1024 * 1024;
export interface PolicyIo {
  read(): string | null;
  writeSync(text: string): true;
}
export function createPolicyIo(file: string): PolicyIo {
  return {
    read() {
      try {
        return fs.readFileSync(file, 'utf8');
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
    },
    writeSync(text) {
      if (Buffer.byteLength(text) > POLICY_MAX_BYTES)
        throw new Error('Permissions store is too large');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteFileSync(file, text);
      return true;
    },
  };
}

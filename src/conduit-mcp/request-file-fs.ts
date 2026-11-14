import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from '../atomic-write';

export interface RequestsIo {
  read(): string | null;
  write(text: string): Promise<void>;
}

const isMissing = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';

export function createRequestsIo(file: string): RequestsIo {
  return {
    read() {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    async write(text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        atomicWriteFile(file, text, (err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

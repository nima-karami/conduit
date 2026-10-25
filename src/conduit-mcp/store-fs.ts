import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from '../atomic-write';
import type { StoreIo } from './store';

const SHA256_NAME = /^[0-9a-f]{64}$/;
const PARTIAL_BLOB = /^[0-9a-f]{64}\.\d+\.tmp$/;

const isMissing = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';

export function createFsStoreIo(dir: string): StoreIo {
  const logPath = path.join(dir, 'messages.log');
  const blobDir = path.join(dir, 'blobs');
  const blobPath = (sha: string) => path.join(blobDir, sha);

  return {
    async readLog() {
      try {
        return await fs.promises.readFile(logPath, 'utf8');
      } catch (e) {
        if (isMissing(e)) return undefined;
        throw e;
      }
    },

    async appendLog(line) {
      await fs.promises.mkdir(dir, { recursive: true });
      const handle = await fs.promises.open(logPath, 'a');
      try {
        await handle.appendFile(line, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    async rewriteLog(text) {
      await fs.promises.mkdir(dir, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        atomicWriteFile(logPath, text, (err) => (err ? reject(err) : resolve()));
      });
    },

    async writeBlob(sha, data) {
      await fs.promises.mkdir(blobDir, { recursive: true });
      const target = blobPath(sha);
      try {
        await fs.promises.access(target);
        return;
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
      // The bytes are on disk before the rename publishes them under their content address; a
      // crash before the rename leaves only a temp, which sweepPartialBlobs removes at load.
      const tmp = `${target}.${process.pid}.tmp`;
      try {
        const handle = await fs.promises.open(tmp, 'w');
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.promises.rename(tmp, target);
      } catch (e) {
        await fs.promises.rm(tmp, { force: true });
        throw e;
      }
    },

    async readBlob(sha) {
      try {
        return new Uint8Array(await fs.promises.readFile(blobPath(sha)));
      } catch (e) {
        if (isMissing(e)) return undefined;
        throw e;
      }
    },

    async deleteBlob(sha) {
      await fs.promises.rm(blobPath(sha), { force: true });
    },

    async sweepPartialBlobs() {
      let names: string[];
      try {
        names = await fs.promises.readdir(blobDir);
      } catch (e) {
        if (isMissing(e)) return;
        throw e;
      }
      for (const n of names) {
        if (PARTIAL_BLOB.test(n)) await fs.promises.rm(path.join(blobDir, n), { force: true });
      }
    },

    async listBlobs() {
      try {
        return (await fs.promises.readdir(blobDir)).filter((n) => SHA256_NAME.test(n));
      } catch (e) {
        if (isMissing(e)) return [];
        throw e;
      }
    },
  };
}

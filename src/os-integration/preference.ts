import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../atomic-write';
import type { FileManagerStatus } from './status';

interface Integration {
  status(): FileManagerStatus | Promise<FileManagerStatus>;
  setEnabled(enabled: boolean): FileManagerStatus | Promise<FileManagerStatus>;
  reconcileOff(): void | Promise<void>;
}

export function fileManagerPreference(userData: string, integration: Integration) {
  const file = join(userData, 'file-manager-preference.json');

  function save(enabled: boolean): void {
    mkdirSync(userData, { recursive: true });
    atomicWriteFileSync(file, JSON.stringify({ enabled }));
  }

  return {
    status: () => integration.status(),
    async setEnabled(enabled: boolean) {
      // Keep an off request across updates even if cleanup has to be retried on startup.
      if (!enabled) save(false);
      const status = await integration.setEnabled(enabled);
      if (enabled) save(true);
      return status;
    },
    async reconcileStartup() {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (JSON.parse(raw)?.enabled === false) await integration.reconcileOff();
    },
  };
}

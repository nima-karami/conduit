import { join } from 'node:path';
import { atomicWriteFileSync } from '../../src/atomic-write';
import { readBlob } from '../../src/config';
import { SERVER_SETTINGS_KEYS, type ServerSettings } from '../../src/contracts/server-protocol';
import { judgePersistedVersion, SERVER_FILE_VERSION } from '../../src/contracts/session-identity';
import { type AppSettings, coerceSettings, restoreSettings } from '../../src/settings';

const FILE = 'server-settings.json';
const CORRUPT_FILE = 'server-settings.corrupt.json';

const serverPart = (all: AppSettings): ServerSettings =>
  Object.fromEntries(SERVER_SETTINGS_KEYS.map((k) => [k, all[k]])) as ServerSettings;
const pick = (raw: Record<string, unknown>): ServerSettings => serverPart(coerceSettings(raw));

const serverKeysOf = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null
    ? Object.fromEntries(
        Object.entries(raw).filter(([k]) =>
          (SERVER_SETTINGS_KEYS as readonly string[]).includes(k),
        ),
      )
    : {};

/** The sole writer of server-settings.json (D7); the app's settings.json is only ever read, once. */
export class ServerSettingsStore {
  private value: ServerSettings;
  private readonly writable: boolean;
  private readonly file: string;

  constructor(
    userData: string,
    private readonly onError: (message: string) => void,
  ) {
    this.file = join(userData, FILE);
    let parsed: { version?: unknown; settings?: unknown } | undefined;
    const blob = readBlob(this.file);
    try {
      parsed = blob === undefined ? undefined : JSON.parse(blob);
    } catch {
      parsed = undefined;
    }
    const judged = judgePersistedVersion(FILE, parsed?.version);
    if (judged === 'read') {
      this.writable = true;
      this.value = pick(serverKeysOf(parsed?.settings));
      return;
    }
    this.writable = judged !== 'newer' && (blob === undefined || this.backUp(userData, blob));
    // Missing or corrupt: seeded from the app's file, which mirrors these keys (D7). A newer file
    // is unreadable for this run and is never replaced, so the seed only lives in memory.
    this.value = serverPart(restoreSettings(readBlob(join(userData, 'settings.json'))));
    this.write();
  }

  get(): ServerSettings {
    return this.value;
  }

  /** Only server keys, coerced; returns whether anything changed. */
  patch(patch: unknown): boolean {
    const next = pick({ ...this.value, ...serverKeysOf(patch) });
    if (JSON.stringify(next) === JSON.stringify(this.value)) return false;
    this.value = next;
    this.write();
    return true;
  }

  /** A corrupt file is kept for the person to recover from; one that can't be is never replaced. */
  private backUp(userData: string, blob: string): boolean {
    try {
      atomicWriteFileSync(join(userData, CORRUPT_FILE), blob);
      this.onError(`${FILE} is corrupt; backed up to ${CORRUPT_FILE} and re-seeded`);
      return true;
    } catch (e) {
      this.onError(`${FILE} is corrupt and its backup failed; not writing it: ${String(e)}`);
      return false;
    }
  }

  private write(): void {
    if (!this.writable) return;
    try {
      atomicWriteFileSync(
        this.file,
        JSON.stringify({ version: SERVER_FILE_VERSION[FILE], settings: this.value }),
      );
    } catch (e) {
      this.onError(`${FILE} write failed: ${String(e)}`);
    }
  }
}

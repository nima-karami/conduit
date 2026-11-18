import { statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../src/atomic-write';
import {
  coercePolicyLayer,
  DEFAULT_TOOL_POLICY,
  isRecord,
  type PolicyLayer,
  TOOL_NAMES,
  TOOL_SPECS,
} from '../../src/conduit-mcp/tool-policy';
import { readBlob } from '../../src/config';
import { SERVER_SETTINGS_KEYS, type ServerSettings } from '../../src/contracts/server-protocol';
import { judgePersistedVersion, SERVER_FILE_VERSION } from '../../src/contracts/session-identity';
import { type AppSettings, coerceSettings, restoreSettings } from '../../src/settings';

const FILE = 'server-settings.json';
const CORRUPT_FILE = 'server-settings.corrupt.json';

const isFile = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;

const serverPart = (all: AppSettings): ServerSettings =>
  Object.fromEntries(SERVER_SETTINGS_KEYS.map((k) => [k, all[k]])) as ServerSettings;
const pick = (raw: Record<string, unknown>): ServerSettings => serverPart(coerceSettings(raw));

/**
 * Retired server keys a stored file may still hold. They reach coerceSettings on read so it can
 * migrate them (autoResumeOnLimit → autoResume, spec 2026-11-13 §3 "Settings"), and are never
 * written back.
 */
const LEGACY_READ_KEYS: readonly string[] = ['autoResumeOnLimit', 'mcpTools'];

const keysOf = (raw: unknown, keep: readonly string[]): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null
    ? Object.fromEntries(Object.entries(raw).filter(([k]) => keep.includes(k)))
    : {};
const serverKeysOf = (raw: unknown): Record<string, unknown> => keysOf(raw, SERVER_SETTINGS_KEYS);

/** The sole writer of server-settings.json (D7); the app's settings.json is only ever read, once. */
export class ServerSettingsStore {
  private value: ServerSettings;
  readonly explicitGlobal: PolicyLayer | undefined;
  readonly resolvedGlobal: PolicyLayer | undefined;
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
    const appBlob = readBlob(join(userData, 'settings.json'));
    let appPayload: unknown;
    try {
      const app = appBlob ? JSON.parse(appBlob) : undefined;
      appPayload = app?.version === 1 ? app.settings : undefined;
    } catch {
      appPayload = undefined;
    }
    const judged = judgePersistedVersion(FILE, parsed?.version);
    const source = judged === 'read' ? parsed?.settings : appPayload;
    const raw =
      typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {};
    const globalLayer = coercePolicyLayer(raw.mcpToolPolicy);
    const rawGlobal = raw.mcpToolPolicy;
    const complete =
      typeof rawGlobal === 'object' &&
      rawGlobal !== null &&
      TOOL_NAMES.every((tool) => Object.hasOwn(rawGlobal, tool));
    const legacyTools = raw.mcpTools;
    const legacyBooleans =
      !isRecord(rawGlobal) &&
      isRecord(legacyTools) &&
      TOOL_NAMES.some((tool) => typeof Reflect.get(legacyTools, tool) === 'boolean');
    const effectiveGlobal = legacyBooleans ? coerceSettings(raw).mcpToolPolicy : globalLayer;
    this.explicitGlobal = complete ? undefined : globalLayer;
    this.resolvedGlobal =
      complete || legacyBooleans
        ? coercePolicyLayer(
            Object.fromEntries(
              TOOL_NAMES.map((tool) => [
                tool,
                Object.fromEntries(
                  TOOL_SPECS[tool].fields.flatMap((field) => {
                    const value = effectiveGlobal?.[tool]?.[field];
                    return value !== undefined && value !== DEFAULT_TOOL_POLICY[tool][field]
                      ? [[field, value]]
                      : [];
                  }),
                ),
              ]),
            ),
          )
        : undefined;
    if (judged === 'read') {
      this.writable = true;
      this.value = pick(keysOf(parsed?.settings, [...SERVER_SETTINGS_KEYS, ...LEGACY_READ_KEYS]));
      return;
    }
    this.writable = judged !== 'newer' && (blob === undefined || this.backUp(userData, blob));
    // Missing or corrupt: seeded from the app's file, which mirrors these keys (D7). A newer file
    // is unreadable for this run and is never replaced, so the seed only lives in memory.
    this.value = serverPart(restoreSettings(appBlob));
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
    const backup = join(userData, CORRUPT_FILE);
    // The first corruption is the one worth recovering from; a later one never replaces it.
    if (isFile(backup)) {
      this.onError(`${FILE} is corrupt; ${CORRUPT_FILE} already holds an earlier one; re-seeded`);
      return true;
    }
    try {
      atomicWriteFileSync(backup, blob);
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

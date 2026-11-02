import { SERVER_SETTINGS_KEYS, type ServerSettings } from './contracts/server-protocol';
import type { AppSettings } from './settings';

// D7: settings.json is the app's alone; it keeps a mirror of the server's keys, never strips them.
// Pure, so the renderer's settings provider and main share one key split.

/** The server's values overwrite the mirror; every UI key stays the app's. */
export function mirrorServerKeys(ui: AppSettings, server: ServerSettings): AppSettings {
  const next: AppSettings = { ...ui };
  for (const k of SERVER_SETTINGS_KEYS) Object.assign(next, { [k]: server[k] });
  return next;
}

/**
 * A whole-object `updateSettings` changes UI keys only: a stale window's copy of a server key
 * must not revert another window's `updateServerSettings`.
 */
export function uiOnly(incoming: AppSettings, current: AppSettings): AppSettings {
  const next: AppSettings = { ...incoming };
  for (const k of SERVER_SETTINGS_KEYS) Object.assign(next, { [k]: current[k] });
  return next;
}

export function serverPatchOf(patch: Partial<AppSettings>): Partial<ServerSettings> {
  const out: Partial<ServerSettings> = {};
  for (const k of SERVER_SETTINGS_KEYS)
    if (Object.hasOwn(patch, k)) Object.assign(out, { [k]: patch[k] });
  return out;
}

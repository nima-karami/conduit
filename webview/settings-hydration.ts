import { SERVER_SETTINGS_KEYS, type ServerSettings } from '../src/contracts/server-protocol';
import type { AppSettings } from '../src/settings';
import { jsonEqual } from '../src/settings-sync';

export function splitSettingsPatch(patch: Partial<AppSettings>): {
  ui: Partial<AppSettings>;
  server: Partial<ServerSettings>;
} {
  const ui: Partial<AppSettings> = { ...patch };
  for (const key of SERVER_SETTINGS_KEYS) delete ui[key];
  const server: Partial<ServerSettings> = {};
  for (const key of SERVER_SETTINGS_KEYS)
    if (Object.hasOwn(patch, key)) Object.assign(server, { [key]: patch[key] });
  return { ui, server };
}

export function uiSettingsEqual(a: AppSettings, b: AppSettings): boolean {
  const left = splitSettingsPatch(a).ui;
  const right = splitSettingsPatch(b).ui;
  return jsonEqual(left, right);
}

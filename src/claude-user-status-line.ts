import * as path from 'node:path';

export interface StatusLineSetting {
  type: 'command';
  command: string;
  padding?: number;
  refreshInterval?: number;
  hideVimModeIndicator?: boolean;
}

// Conduit's statusLine replaces the user's, so it is re-read here; see spec 2026-11-13-scheduler-auto-resume §3.
// conduit-hook.cjs repeats this precedence.
export function readUserStatusLine(i: {
  projectDir: string;
  configDir: string;
  readFile: (p: string) => string | null;
}): StatusLineSetting | null {
  const files = [
    path.join(i.projectDir, '.claude', 'settings.local.json'),
    path.join(i.projectDir, '.claude', 'settings.json'),
    path.join(i.configDir, 'settings.json'),
  ];
  for (const file of files) {
    const setting = statusLineIn(i.readFile(file));
    if (setting) return setting;
  }
  return null;
}

function statusLineIn(text: string | null): StatusLineSetting | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const sl = isRecord(parsed) ? parsed.statusLine : undefined;
  if (!isRecord(sl) || sl.type !== 'command') return null;
  if (typeof sl.command !== 'string' || sl.command === '') return null;
  if (sl.command.includes('conduit-hook.cjs')) return null;
  const setting: StatusLineSetting = { type: 'command', command: sl.command };
  if (typeof sl.padding === 'number') setting.padding = sl.padding;
  if (typeof sl.refreshInterval === 'number') setting.refreshInterval = sl.refreshInterval;
  if (typeof sl.hideVimModeIndicator === 'boolean')
    setting.hideVimModeIndicator = sl.hideVimModeIndicator;
  return setting;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

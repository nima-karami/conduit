import { AgentRegistry } from './agent-registry';
import { formatCommandLine, splitCommandLine } from './command-line';
import { MAX_CUSTOM_LAUNCHERS } from './launchers';
import type { HostPlatform } from './lsp-binary';
import type { AgentDefinition } from './types';

export interface LauncherUsage {
  count: number;
  lastUsed: number;
}
export interface LaunchersFile {
  version: 1;
  usage: Record<string, LauncherUsage>;
  custom: AgentDefinition[];
}

const MAX_COMMAND_LINE = 1024;
const MAX_LABEL = 80;
const CUSTOM_PREFIX = 'custom:';

const emptyFile = (): LaunchersFile => ({ version: 1, usage: {}, custom: [] });
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isCustomDef = (d: unknown): d is AgentDefinition =>
  isRecord(d) &&
  AgentRegistry.isValid(d as unknown as AgentDefinition) &&
  (d.id as string).startsWith(CUSTOM_PREFIX) &&
  typeof d.label === 'string' &&
  Array.isArray(d.args) &&
  d.args.every((a) => typeof a === 'string');

export function parseLaunchers(blob: string | undefined): LaunchersFile {
  if (!blob) return emptyFile();
  let raw: unknown;
  try {
    raw = JSON.parse(blob);
  } catch {
    return emptyFile();
  }
  if (!isRecord(raw) || raw.version !== 1) return emptyFile();
  const usage: Record<string, LauncherUsage> = {};
  if (isRecord(raw.usage)) {
    for (const [id, u] of Object.entries(raw.usage)) {
      if (isRecord(u) && Number.isFinite(u.count) && Number.isFinite(u.lastUsed)) {
        usage[id] = { count: u.count as number, lastUsed: u.lastUsed as number };
      }
    }
  }
  const custom = Array.isArray(raw.custom)
    ? raw.custom.filter(isCustomDef).slice(0, MAX_CUSTOM_LAUNCHERS)
    : [];
  return { version: 1, usage, custom };
}

export function serializeLaunchers(f: LaunchersFile): string {
  return JSON.stringify(f, null, 2);
}

export function bumpUsage(f: LaunchersFile, agentId: string, now: number): LaunchersFile {
  const count = (f.usage[agentId]?.count ?? 0) + 1;
  return { ...f, usage: { ...f.usage, [agentId]: { count, lastUsed: now } } };
}

export type AddCustomResult =
  | { ok: true; file: LaunchersFile; def: AgentDefinition }
  | { ok: false; error: string };

const slugOf = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'cmd';

export function addCustomLauncher(
  f: LaunchersFile,
  input: { commandLine: unknown; label?: unknown },
  deps: {
    platform: HostPlatform;
    resolveCommand: (command: string) => string | undefined;
    takenIds: ReadonlySet<string>;
    takenLabels: readonly string[];
  },
): AddCustomResult {
  const line = typeof input.commandLine === 'string' ? input.commandLine.trim() : '';
  if (!line) return { ok: false, error: 'Enter a command' };
  if (line.length > MAX_COMMAND_LINE) {
    return { ok: false, error: `Command is too long (max ${MAX_COMMAND_LINE} characters)` };
  }
  if (f.custom.length >= MAX_CUSTOM_LAUNCHERS) {
    return { ok: false, error: `Custom launcher limit reached (${MAX_CUSTOM_LAUNCHERS})` };
  }
  const [cmd = '', ...args] = splitCommandLine(line, deps.platform);
  const command = cmd ? deps.resolveCommand(cmd) : undefined;
  if (!command) return { ok: false, error: `Can't find "${cmd}" on PATH` };

  const given = typeof input.label === 'string' ? input.label.trim().slice(0, MAX_LABEL) : '';
  // With no args the formatted line is exactly the leaf the preview shows.
  const base = given || formatCommandLine({ command, args: [] }, deps.platform);
  const takenIds = new Set([...deps.takenIds, ...f.custom.map((d) => d.id)]);
  const takenLabels = new Set(
    [...deps.takenLabels, ...f.custom.map((d) => d.label)].map((l) => l.toLowerCase()),
  );
  const stem = `${CUSTOM_PREFIX}${slugOf(base)}`;
  let id = stem;
  for (let n = 2; takenIds.has(id); n++) id = `${stem}-${n}`;
  let label = base;
  for (let n = 2; takenLabels.has(label.toLowerCase()); n++) label = `${base} (${n})`;

  const def: AgentDefinition = {
    id,
    label,
    command,
    args,
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  };
  return { ok: true, file: { ...f, custom: [...f.custom, def] }, def };
}

export function removeCustomLauncher(f: LaunchersFile, id: unknown): LaunchersFile | null {
  if (typeof id !== 'string' || !f.custom.some((d) => d.id === id)) return null;
  return { ...f, custom: f.custom.filter((d) => d.id !== id) };
}

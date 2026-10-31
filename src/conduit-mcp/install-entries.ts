import { type CursorEntry, cursorEntry, wiresLaunch } from './cursor-config';
import type {
  AgentCli,
  ClaudeEntry,
  CodexEntry,
  OpenCodeEntry,
  V050CodexEntry,
} from './install-types';

export type ConduitEntry = ClaudeEntry | CodexEntry | CursorEntry | OpenCodeEntry;
export type LegacyConduitEntry = ClaudeEntry | V050CodexEntry | CursorEntry | OpenCodeEntry;
export const SHIM_LEAF = 'conduit-mcp-shim.cjs';
/** Longer than Conduit's ask budget, so the human's card decides, not the CLI's clock. */
export const CODEX_TOOL_TIMEOUT_SEC = 180;

const TOKEN = 'CONDUIT_SESSION_TOKEN';
const ENDPOINT = 'CONDUIT_MCP_ENDPOINT';

/** Claude expands ${VAR} and ${VAR:-default}; the :- form keeps a missing var from failing the load. */
const claudeVar = (name: string, emptyDefault: boolean) =>
  `$${'{'}${name}${emptyDefault ? ':-' : ''}}`;
const openCodeVar = (name: string) => `{env:${name}}`;

const claudeEntry = (execPath: string, shimPath: string): ClaudeEntry => ({
  type: 'stdio',
  command: execPath,
  args: [shimPath],
  env: {
    ELECTRON_RUN_AS_NODE: '1',
    CONDUIT_SESSION_TOKEN: claudeVar(TOKEN, true),
    CONDUIT_MCP_ENDPOINT: claudeVar(ENDPOINT, true),
  },
});

const v050Codex = (execPath: string, shimPath: string): V050CodexEntry => ({
  command: execPath,
  args: [shimPath],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  env_vars: [TOKEN, ENDPOINT],
  default_tools_approval_mode: 'auto',
});

const openCodeEntry = (execPath: string, shimPath: string): OpenCodeEntry => ({
  type: 'local',
  command: [execPath, shimPath],
  environment: {
    ELECTRON_RUN_AS_NODE: '1',
    CONDUIT_SESSION_TOKEN: openCodeVar(TOKEN),
    CONDUIT_MCP_ENDPOINT: openCodeVar(ENDPOINT),
  },
  enabled: true,
});

// No --endpoint in any entry: the endpoint comes from env, so dev and installed builds share one (spec §3.4).
export function conduitEntry(cli: AgentCli, execPath: string, shimPath: string): ConduitEntry {
  switch (cli) {
    case 'claude':
      return claudeEntry(execPath, shimPath);
    case 'codex':
      return { ...v050Codex(execPath, shimPath), tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC };
    case 'cursor':
      return cursorEntry(execPath, shimPath);
    case 'opencode':
      return openCodeEntry(execPath, shimPath);
  }
}

/** What v0.50 installed; classifyEntry counts it as ours so it never reads as another Conduit. */
export function legacyConduitEntry(
  cli: AgentCli,
  execPath: string,
  shimPath: string,
): LegacyConduitEntry {
  // Only the codex entry has changed since v0.50.
  return cli === 'codex' ? v050Codex(execPath, shimPath) : conduitEntry(cli, execPath, shimPath);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function leaf(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}

function stringAt(v: unknown, i: number): string | null {
  if (!Array.isArray(v)) return null;
  const item: unknown = v[i];
  return typeof item === 'string' ? item : null;
}

function claudeForwards(env: Record<string, unknown>, name: string): boolean {
  return env[name] === claudeVar(name, false) || env[name] === claudeVar(name, true);
}

function forwardsIdentity(cli: AgentCli, entry: Record<string, unknown>): boolean {
  switch (cli) {
    case 'claude':
      return (
        isRecord(entry.env) &&
        claudeForwards(entry.env, TOKEN) &&
        claudeForwards(entry.env, ENDPOINT)
      );
    case 'cursor':
      return wiresLaunch(entry);
    case 'opencode':
      return (
        isRecord(entry.environment) &&
        entry.environment[TOKEN] === openCodeVar(TOKEN) &&
        entry.environment[ENDPOINT] === openCodeVar(ENDPOINT)
      );
    case 'codex':
      return (
        Array.isArray(entry.env_vars) &&
        entry.env_vars.includes(TOKEN) &&
        entry.env_vars.includes(ENDPOINT)
      );
  }
}

/** The exe and shim an entry points at, for Repair; null where the shape has no string there. */
export function entryTargets(
  cli: AgentCli,
  entry: unknown,
): { command: string | null; shim: string | null } {
  if (!isRecord(entry)) return { command: null, shim: null };
  if (cli === 'opencode') {
    return { command: stringAt(entry.command, 0), shim: stringAt(entry.command, 1) };
  }
  return {
    command: typeof entry.command === 'string' ? entry.command : null,
    shim: stringAt(entry.args, 0),
  };
}

/**
 * The entry with only the parts given in `to` replaced: `exe` for the command, `shim` for the
 * script; every other key and argument is the user's and stays (spec §14 D2: Repair fixes a moved
 * install, nothing else). A command that becomes Conduit's exe gets ELECTRON_RUN_AS_NODE=1 in the
 * CLI's env shape, or every CLI start would open the Conduit GUI. null: not an object.
 */
export function retargetEntry(
  cli: AgentCli,
  entry: unknown,
  to: { exe?: string; shim?: string },
): Record<string, unknown> | null {
  if (!isRecord(entry)) return null;
  const envKey = cli === 'opencode' ? 'environment' : 'env';
  const env = isRecord(entry[envKey]) ? entry[envKey] : {};
  const asNode = to.exe === undefined ? {} : { [envKey]: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  if (cli === 'opencode') {
    const command: unknown[] = Array.isArray(entry.command) ? [...entry.command] : [];
    if (to.exe !== undefined) command[0] = to.exe;
    if (to.shim !== undefined) command[1] = to.shim;
    return { ...entry, command, ...asNode };
  }
  const args: unknown[] = Array.isArray(entry.args) ? [...entry.args] : [];
  if (to.shim !== undefined) args[0] = to.shim;
  return { ...entry, ...(to.exe === undefined ? {} : { command: to.exe }), args, ...asNode };
}

/** Spec §2.3 "Conduit shape": the shim leaf at the script position, and identity forwarded the CLI's way. */
export function isConduitShaped(cli: AgentCli, entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const { shim } = entryTargets(cli, entry);
  return shim !== null && leaf(shim) === SHIM_LEAF && forwardsIdentity(cli, entry);
}

export type EntryClass = 'absent' | 'ours' | 'other-conduit' | 'conflict';

/** `legacy`: this build's v0.50 entry, also 'ours'; startup repair upgrades it in place. */
export function classifyEntry(
  cli: AgentCli,
  entry: unknown,
  expected: ConduitEntry,
  legacy?: LegacyConduitEntry,
): EntryClass {
  if (entry === undefined) return 'absent';
  if (deepEqualConfig(entry, expected)) return 'ours';
  if (legacy !== undefined && deepEqualConfig(entry, legacy)) return 'ours';
  return isConduitShaped(cli, entry) ? 'other-conduit' : 'conflict';
}

/** Structural equality; Date instances (TOML datetimes) compare by getTime(); arrays by order; object key order ignored. */
export function deepEqualConfig(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqualConfig(item, b[i]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const aKeys = Object.keys(a);
  return (
    aKeys.length === Object.keys(b).length &&
    aKeys.every((k) => Object.hasOwn(b, k) && deepEqualConfig(a[k], b[k]))
  );
}

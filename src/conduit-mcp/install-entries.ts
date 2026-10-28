import { type CursorEntry, cursorEntry, wiresLaunch } from './cursor-config';
import type { AgentCli, ClaudeEntry, CodexEntry, OpenCodeEntry } from './install-types';

export type ConduitEntry = ClaudeEntry | CodexEntry | CursorEntry | OpenCodeEntry;
export const SHIM_LEAF = 'conduit-mcp-shim.cjs';

const TOKEN = 'CONDUIT_SESSION_TOKEN';
const ENDPOINT = 'CONDUIT_MCP_ENDPOINT';

/** Claude expands ${VAR} and ${VAR:-default}; the :- form keeps a missing var from failing the load. */
const claudeVar = (name: string, emptyDefault: boolean) =>
  `$${'{'}${name}${emptyDefault ? ':-' : ''}}`;
const openCodeVar = (name: string) => `{env:${name}}`;

// No --endpoint in any entry: the endpoint comes from env, so dev and installed builds share one (spec §3.4).
export function conduitEntry(cli: AgentCli, execPath: string, shimPath: string): ConduitEntry {
  switch (cli) {
    case 'claude':
      return {
        type: 'stdio',
        command: execPath,
        args: [shimPath],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          CONDUIT_SESSION_TOKEN: claudeVar(TOKEN, true),
          CONDUIT_MCP_ENDPOINT: claudeVar(ENDPOINT, true),
        },
      };
    case 'codex':
      return {
        command: execPath,
        args: [shimPath],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        env_vars: [TOKEN, ENDPOINT],
        default_tools_approval_mode: 'auto',
      };
    case 'cursor':
      return cursorEntry(execPath, shimPath);
    case 'opencode':
      return {
        type: 'local',
        command: [execPath, shimPath],
        environment: {
          ELECTRON_RUN_AS_NODE: '1',
          CONDUIT_SESSION_TOKEN: openCodeVar(TOKEN),
          CONDUIT_MCP_ENDPOINT: openCodeVar(ENDPOINT),
        },
        enabled: true,
      };
  }
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
 * The entry with only the exe and shim entryTargets reads replaced; every other key and argument is
 * the user's and stays (spec §14 D2: Repair fixes a moved install, nothing else). null: not an object.
 */
export function retargetEntry(
  cli: AgentCli,
  entry: unknown,
  execPath: string,
  shimPath: string,
): Record<string, unknown> | null {
  if (!isRecord(entry)) return null;
  if (cli === 'opencode') {
    const rest = Array.isArray(entry.command) ? entry.command.slice(2) : [];
    return { ...entry, command: [execPath, shimPath, ...rest] };
  }
  const rest = Array.isArray(entry.args) ? entry.args.slice(1) : [];
  return { ...entry, command: execPath, args: [shimPath, ...rest] };
}

/** Spec §2.3 "Conduit shape": the shim leaf at the script position, and identity forwarded the CLI's way. */
export function isConduitShaped(cli: AgentCli, entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const { shim } = entryTargets(cli, entry);
  return shim !== null && leaf(shim) === SHIM_LEAF && forwardsIdentity(cli, entry);
}

export type EntryClass = 'absent' | 'ours' | 'other-conduit' | 'conflict';

export function classifyEntry(cli: AgentCli, entry: unknown, expected: ConduitEntry): EntryClass {
  if (entry === undefined) return 'absent';
  if (deepEqualConfig(entry, expected)) return 'ours';
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

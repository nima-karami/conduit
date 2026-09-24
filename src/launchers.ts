import { AgentRegistry } from './agent-registry';
import { commandLeaf } from './launch-args';
import type { AgentDefinition } from './types';

export type LauncherKind = 'cli' | 'shell' | 'config' | 'custom';
export interface LauncherDTO {
  id: string;
  kind: LauncherKind;
  uses: number;
  lastUsed?: number;
}
export const AGENT_CLI_NAMES = [
  'claude',
  'codex',
  'cursor-agent',
  'gemini',
  'aider',
  'opencode',
] as const;
/** Renderer-safe home so the More menu's cap row and the host's store share one number. */
export const MAX_CUSTOM_LAUNCHERS = 50;
export interface LauncherSet {
  defs: AgentDefinition[];
  aliases: Record<string, string>;
  kinds: Record<string, LauncherKind>;
}

/** See mf-new-session spec §3.3 "Shadowing" / D20 for the alias. */
export function composeLaunchers(parts: {
  shells: readonly AgentDefinition[];
  clis: readonly AgentDefinition[];
  config: readonly AgentDefinition[];
  custom: readonly AgentDefinition[];
}): LauncherSet {
  const valid = (list: readonly AgentDefinition[]) => list.filter(AgentRegistry.isValid);
  const config = valid(parts.config);
  const aliases: Record<string, string> = {};
  for (const c of config) {
    const leaf = commandLeaf(c.command);
    const cliId = `cli:${leaf}`;
    if ((AGENT_CLI_NAMES as readonly string[]).includes(leaf) && !(cliId in aliases)) {
      aliases[cliId] = c.id;
    }
  }
  const defs: AgentDefinition[] = [];
  const kinds: Record<string, LauncherKind> = {};
  const add = (list: readonly AgentDefinition[], kind: LauncherKind) => {
    for (const d of list) {
      if (d.id in kinds) continue;
      kinds[d.id] = kind;
      defs.push(d);
    }
  };
  add(valid(parts.shells), 'shell');
  add(
    valid(parts.clis).filter((d) => !(d.id in aliases)),
    'cli',
  );
  add(config, 'config');
  add(valid(parts.custom), 'custom');
  return { defs, aliases, kinds };
}

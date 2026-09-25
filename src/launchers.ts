import { AgentRegistry } from './agent-registry';
import { commandLeaf } from './launch-args';
import type { AgentDefinition } from './types';

export type LauncherKind = 'cli' | 'shell' | 'config' | 'custom';
export interface LauncherDTO {
  id: string;
  kind: LauncherKind;
  uses: number;
  lastUsed?: number;
  /** `cli:<name>` ids this agents.json entry shadows (D20); `registry.list()` never has them. */
  aliases?: string[];
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
    if ((AGENT_CLI_NAMES as readonly string[]).includes(leaf) && !Object.hasOwn(aliases, cliId)) {
      aliases[cliId] = c.id;
    }
  }
  const defs: AgentDefinition[] = [];
  const kinds: Record<string, LauncherKind> = {};
  const add = (list: readonly AgentDefinition[], kind: LauncherKind) => {
    for (const d of list) {
      if (Object.hasOwn(kinds, d.id)) continue;
      kinds[d.id] = kind;
      defs.push(d);
    }
  };
  add(valid(parts.shells), 'shell');
  add(
    valid(parts.clis).filter((d) => !Object.hasOwn(aliases, d.id)),
    'cli',
  );
  add(config, 'config');
  add(valid(parts.custom), 'custom');
  return { defs, aliases, kinds };
}

/** `Shell` pill target: the default terminal when it is a shell, else the first shell. */
export function preferredShellId(
  launchers: readonly LauncherDTO[],
  defaultAgentId: string,
): string | undefined {
  const shells = launchers.filter((l) => l.kind === 'shell');
  return shells.find((l) => l.id === defaultAgentId)?.id ?? shells[0]?.id;
}

export interface LaunchRanking {
  row: string[];
  shellId?: string;
  more: string[];
}

const ROW_SIZE = 3;
const KIND_RANK: Record<LauncherKind, number> = { cli: 0, config: 1, custom: 2, shell: 3 };

/** Spec §3.3 "Ranking"; the `Shell` pill is pinned outside it (D16). */
export function rankLaunchers(
  agents: readonly AgentDefinition[],
  launchers: readonly LauncherDTO[],
  preferredShellId: string | undefined,
): LaunchRanking {
  const byId = new Map(launchers.map((l) => [l.id, l]));
  const order = new Map(agents.map((a, i) => [a.id, i]));
  const within = (l: LauncherDTO) => {
    const cli = (AGENT_CLI_NAMES as readonly string[]).indexOf(l.id.slice('cli:'.length));
    return l.kind === 'cli' && cli >= 0 ? cli : (order.get(l.id) ?? 0);
  };
  const candidates = agents.flatMap((a) => {
    const l = byId.get(a.id);
    return l ? [l] : [];
  });
  const ranked = candidates
    .filter((l) => l.kind !== 'shell')
    .sort(
      (a, b) =>
        b.uses - a.uses ||
        (b.lastUsed ?? 0) - (a.lastUsed ?? 0) ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        within(a) - within(b),
    )
    .map((l) => l.id);
  const otherShells = candidates
    .filter((l) => l.kind === 'shell' && l.id !== preferredShellId)
    .map((l) => l.id);
  return {
    row: ranked.slice(0, ROW_SIZE),
    ...(preferredShellId === undefined ? {} : { shellId: preferredShellId }),
    more: [...ranked.slice(ROW_SIZE), ...otherShells],
  };
}

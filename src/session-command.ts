// Node-free: the renderer imports commandLabel for card labels and the tools dialog.
import { type AgentRegistry, RESERVED_AGENT_ID_PREFIX } from './agent-registry';
import { commandLeaf } from './launch-args';
import type { AgentDefinition, Session, SessionCommand, SessionOpener } from './types';

/** Never registered; the reserved prefix keeps agents.json from shadowing it. */
export const COMMAND_AGENT_ID = `${RESERVED_AGENT_ID_PREFIX}command`;
export const MAX_COMMAND_BYTES = 1024;
export const MAX_ARGS = 64;
export const MAX_ARGS_BYTES = 8 * 1024;

const utf8 = new TextEncoder();
const bytes = (s: string): number => utf8.encode(s).length;

/** commandLeaf(c.command); the default label (spec D2). */
export function commandLabel(c: SessionCommand): string {
  return commandLeaf(c.command);
}

export function commandDef(c: SessionCommand): AgentDefinition {
  return {
    id: COMMAND_AGENT_ID,
    label: commandLabel(c),
    command: c.command,
    args: [...c.args],
    icon: 'terminal',
    color: 'green',
    cwdStrategy: 'workspaceFolder',
  };
}

/** The one launch seam (spec §3.3): commandDef for a command session, else registry.get(agentId). */
export function effectiveDef(
  s: Pick<Session, 'agentId' | 'command'>,
  registry: Pick<AgentRegistry, 'get'>,
): AgentDefinition | undefined {
  if (s.agentId === COMMAND_AGENT_ID) return s.command ? commandDef(s.command) : undefined;
  return registry.get(s.agentId);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function coerceSessionCommand(v: unknown): SessionCommand | undefined {
  if (!isRecord(v)) return undefined;
  const { command, args } = v;
  if (typeof command !== 'string' || command.length === 0 || bytes(command) > MAX_COMMAND_BYTES)
    return undefined;
  if (!Array.isArray(args) || args.length > MAX_ARGS) return undefined;
  let total = 0;
  for (const a of args) {
    if (typeof a !== 'string') return undefined;
    total += bytes(a);
  }
  if (total > MAX_ARGS_BYTES) return undefined;
  return { command, args: [...args] };
}

export function coerceOpenedBy(v: unknown): SessionOpener | undefined {
  if (!isRecord(v)) return undefined;
  const { handle, sessionId } = v;
  if (typeof handle !== 'string' || typeof sessionId !== 'string') return undefined;
  return { handle, sessionId };
}

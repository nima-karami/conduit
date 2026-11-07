// Which agent an open_session `agent` names (flexible-agent-contracts §3.1): a registered id, or a
// bare command on PATH. Pure: the PATH lookup is a dep, so the rules run without a filesystem.
import { MAX_VALID_IDS, type Result, type ToolError, toolError } from './types';

export type AgentArg =
  | { kind: 'registered'; id: string }
  | { kind: 'command'; path: string; leaf: string };

/** Shells, interpreters and system tools: open_terminal runs these, not an agent open. */
export const REFUSED_LEAVES: ReadonlySet<string> = new Set([
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'fish',
  'wsl',
  'node',
  'deno',
  'bun',
  'python',
  'python3',
  'py',
  'ruby',
  'perl',
  'php',
  'wscript',
  'cscript',
  'mshta',
  'rundll32',
  'regsvr32',
  'reg',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rm',
  'del',
  'rmdir',
  'git',
  'npm',
  'npx',
  'pnpm',
  'yarn',
]);

const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEPARATOR = /[\\/]/;

export interface AgentArgDeps {
  registeredIds: readonly string[];
  /** The registered id a name reaches, aliases included; registered always wins over PATH. */
  resolveRegistered?(name: string): string | undefined;
  /** An absolute path for a command on PATH; undefined when it isn't there. */
  resolveCommand(command: string): string | undefined;
}

const refuse = (error: ToolError): Result<never> => ({ ok: false, error });

export function resolveAgentArg(agent: string, deps: AgentArgDeps): Result<AgentArg> {
  const registered =
    deps.resolveRegistered?.(agent) ?? (deps.registeredIds.includes(agent) ? agent : undefined);
  if (registered !== undefined) return { ok: true, value: { kind: 'registered', id: registered } };
  if (SEPARATOR.test(agent))
    return refuse(
      toolError(
        'invalid_args',
        'agent is a registered id or a command name, not a path',
        undefined,
        {
          hint: 'pass the command name, e.g. "kiro"; open_terminal runs a path',
        },
      ),
    );
  const notFound = (): Result<never> =>
    refuse(
      toolError(
        'unknown_agent',
        `no registered agent or command on PATH named "${agent}"`,
        undefined,
        {
          hint: 'call list_agents; a bare command must be an agent CLI on PATH',
          valid: deps.registeredIds.slice(0, MAX_VALID_IDS),
        },
      ),
    );
  if (!BARE_NAME.test(agent)) return notFound();
  const leaf = agent.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (REFUSED_LEAVES.has(leaf))
    return refuse(
      toolError('invalid_args', `"${agent}" is a shell or tool, not an agent CLI`, undefined, {
        hint: 'use open_terminal to run shells and tools',
      }),
    );
  const path = deps.resolveCommand(agent);
  if (path === undefined) return notFound();
  return { ok: true, value: { kind: 'command', path, leaf } };
}

// Which agent an open_session `agent` names (flexible-agent-contracts §3.1): a registered id, or a
// bare command on PATH. Pure: the PATH lookup and the registry are deps, so the rules run without a
// filesystem. What a PATH hit really runs (symlinks, file kind) is checked by the caller, which is async.
import { MAX_VALID_IDS, type Result, type ToolError, toolError } from './types';

export type AgentArg =
  | { kind: 'registered'; id: string }
  | { kind: 'command'; path: string; leaf: string };

/**
 * Shells, interpreters and system tools, by normalized leaf (see normalizeLeaf): open_terminal runs
 * these, not an agent open. Grows by review.
 */
export const REFUSED_LEAVES: ReadonlySet<string> = new Set([
  'cmd',
  'powershell',
  'powershell_ise',
  'pwsh',
  'bash',
  'sh',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'zsh',
  'fish',
  'nu',
  'wsl',
  'node',
  'deno',
  'bun',
  'bunx',
  'python',
  'pythonw',
  'ipython',
  'py',
  'ruby',
  'irb',
  'perl',
  'php',
  'lua',
  'tclsh',
  'tsx',
  'java',
  'javaw',
  'dotnet',
  'wscript',
  'cscript',
  'mshta',
  'rundll32',
  'regsvr32',
  'reg',
  'env',
  'sudo',
  'xargs',
  'busybox',
  'curl',
  'wget',
  'nc',
  'ncat',
  'socat',
  'ssh',
  'scp',
  'rm',
  'del',
  'rmdir',
  'git',
  'gh',
  'docker',
  'npm',
  'npx',
  'pnpm',
  'yarn',
]);

const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEPARATOR = /[\\/]/;
const EXECUTABLE_EXT = /\.(exe|cmd|bat|com)$/;

/** A program's file name, lowercased, without its directory or Windows extension. */
export function programLeaf(name: string): string {
  return (name.split(/[\\/]/).pop() ?? '').toLowerCase().replace(EXECUTABLE_EXT, '');
}

/** programLeaf without a version or -preview suffix: python3.12.exe → python, pwsh-preview → pwsh. */
export function normalizeLeaf(name: string): string {
  return programLeaf(name)
    .replace(/[0-9.]+$/, '')
    .replace(/-preview$/, '');
}

export const isRefusedLeaf = (name: string): boolean => REFUSED_LEAVES.has(normalizeLeaf(name));

/**
 * The registered id a name reaches: the id itself, else the `cli:<name>` entry, which is the
 * launcher alias a shadowing profile holds or the detected CLI (flexible-agent-contracts §3.1).
 */
export function registeredIdFor(
  name: string,
  lookup: (id: string) => string | undefined,
): string | undefined {
  return lookup(name) ?? lookup(`cli:${programLeaf(name)}`);
}

export interface AgentArgDeps {
  registeredIds: readonly string[];
  /** The registered id a name reaches (registeredIdFor); registered always wins over PATH. */
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
  if (isRefusedLeaf(agent))
    return refuse(
      toolError('invalid_args', `"${agent}" is a shell or tool, not an agent CLI`, undefined, {
        hint: 'use open_terminal to run shells and tools',
      }),
    );
  const path = deps.resolveCommand(agent);
  if (path === undefined) return notFound();
  return { ok: true, value: { kind: 'command', path, leaf: programLeaf(agent) } };
}

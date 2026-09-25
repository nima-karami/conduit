// Per-launcher launch args for a session's attached roots (mf-model spec §2.5). Renderer-safe:
// mf-new-session's "Launches as" preview runs the same adapter.
import type { HostPlatform } from './lsp-binary';
import type { AgentDefinition } from './types';

export interface AgentLaunchArgs {
  addDir: boolean;
  args: string[];
  launchedRoots: string[];
  skippedAddDirRoots: string[];
}

const CMD_METACHARS = /["%&|<>^!]/;
const BATCH_EXT = /\.(cmd|bat)$/i;

/** Split on both slash kinds on every platform: `path.basename` is wrong for `C:\x\claude.cmd` on posix. */
export function commandLeaf(command: string): string {
  const leaf = command.split(/[\\/]/).pop() ?? '';
  return leaf.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/** The one metacharacter test (locked L12 S10); the dialog names the char it finds. */
export function firstCmdMetachar(s: string): string | undefined {
  return CMD_METACHARS.exec(s)?.[0];
}

export function launchArgsFor(
  def: Pick<AgentDefinition, 'command' | 'args'>,
  roots: readonly string[],
  opts: { platform: HostPlatform; resolvedCommand: string | undefined },
): AgentLaunchArgs {
  if (commandLeaf(def.command) !== 'claude') {
    return { addDir: false, args: [...def.args], launchedRoots: [], skippedAddDirRoots: [] };
  }
  // cmd.exe re-parses a batch file's arguments; an unresolvable command may turn out to be one (S10).
  const guarded =
    opts.platform === 'win32' &&
    (opts.resolvedCommand === undefined || BATCH_EXT.test(opts.resolvedCommand));
  const launchedRoots: string[] = [];
  const skippedAddDirRoots: string[] = [];
  for (const r of roots) {
    if (guarded && firstCmdMetachar(r) !== undefined) skippedAddDirRoots.push(r);
    else launchedRoots.push(r);
  }
  const args = [...def.args, ...launchedRoots.flatMap((r) => ['--add-dir', r])];
  return { addDir: true, args, launchedRoots, skippedAddDirRoots };
}

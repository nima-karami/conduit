import type { AgentRegistry } from './agent-registry';
import { formatCommandLine } from './command-line';
import type { DroppedRoot, probeFolder } from './folder-validation';
import { buildLaunchSpec } from './launch-spec';
import type { HostPlatform } from './lsp-binary';
import type { LaunchPreviewResult } from './protocol';
import { presentRoots } from './session-folders';

/** Runs exactly what `openRepo` + `term:start` will: the root validator, then `buildLaunchSpec`
 *  (mf-new-session plan, Spec staleness §3.2). No cwd-reporting augmentation (D8). */
export async function previewLaunch(
  input: { agentId: unknown; home: unknown; roots: unknown },
  deps: {
    registry: AgentRegistry;
    probe: (raw: unknown) => ReturnType<typeof probeFolder>;
    resolveInitialRoots: (
      home: string,
      roots: unknown,
    ) => Promise<{ roots: string[]; missing: string[]; dropped: DroppedRoot[] }>;
    exists: (p: string) => boolean;
    resolveCommand: (command: string) => string | undefined;
    platform: HostPlatform;
  },
): Promise<LaunchPreviewResult> {
  const { agentId, home } = input;
  if (typeof agentId !== 'string' || typeof home !== 'string') {
    return { error: 'invalid request', skippedAddDirRoots: [] };
  }
  const def = agentId === 'shell' ? undefined : deps.registry.get(agentId);
  if (!def && agentId !== 'shell') return { error: 'unknown launcher', skippedAddDirRoots: [] };
  const probed = await deps.probe(home);
  const homeMissing = 'reason' in probed || probed.status !== 'present';
  if (homeMissing) return { error: 'home-missing', skippedAddDirRoots: [] };
  const initial = await deps.resolveInitialRoots(home, input.roots);
  const plan = buildLaunchSpec({
    registry: deps.registry,
    agentId,
    cwd: undefined,
    home,
    homeMissing,
    roots: presentRoots({ roots: initial.roots, missingRoots: initial.missing }),
    exists: deps.exists,
    resolveCommand: deps.resolveCommand,
    platform: deps.platform,
  });
  if (!plan.ok) return { error: 'home-missing', skippedAddDirRoots: [] };
  const { cwd, command, args } = plan.spec;
  const skippedAddDirRoots = plan.skippedAddDirRoots;
  if (def && deps.resolveCommand(def.command) === undefined) {
    return { error: 'not found on PATH', cwd, command, args, skippedAddDirRoots };
  }
  const display = formatCommandLine(plan.spec, deps.platform);
  return { cwd, command, args, display, skippedAddDirRoots };
}

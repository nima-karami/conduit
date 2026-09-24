// The one spawn resolution `term:start` launches from (mf-model spec §2.5).
import type { AgentRegistry } from './agent-registry';
import { launchArgsFor } from './launch-args';
import type { HostPlatform } from './lsp-binary';
import { resolveLaunchSpec } from './pty-host';
import type { SpawnSpec } from './types';

export interface LaunchRequest {
  registry: AgentRegistry;
  agentId: string | undefined;
  cwd: string | undefined;
  home: string;
  homeMissing: boolean;
  roots: readonly string[];
  exists: (p: string) => boolean;
  resolveCommand: (command: string) => string | undefined;
  platform: HostPlatform;
}

export type LaunchPlan =
  | {
      ok: true;
      spec: SpawnSpec;
      addDir: boolean;
      launchedRoots: string[];
      skippedAddDirRoots: string[];
    }
  | { ok: false; reason: 'home-missing' };

export function buildLaunchSpec(req: LaunchRequest): LaunchPlan {
  if (req.homeMissing) return { ok: false, reason: 'home-missing' };
  const dir =
    req.cwd && req.exists(req.cwd) ? req.cwd : req.exists(req.home) ? req.home : undefined;
  if (dir === undefined) return { ok: false, reason: 'home-missing' };
  const spec = resolveLaunchSpec(req.registry, req.agentId, dir, req.exists, dir);
  const def = req.agentId && req.agentId !== 'shell' ? req.registry.get(req.agentId) : undefined;
  if (!def) return { ok: true, spec, addDir: false, launchedRoots: [], skippedAddDirRoots: [] };
  const { args, ...lists } = launchArgsFor(def, req.roots, {
    platform: req.platform,
    resolvedCommand: req.resolveCommand(def.command),
  });
  return { ok: true, spec: { ...spec, args }, ...lists };
}

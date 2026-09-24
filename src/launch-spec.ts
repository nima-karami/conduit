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
  | { ok: false; reason: 'home-missing' }
  | { ok: false; reason: 'unresolvable'; command: string };

export function buildLaunchSpec(req: LaunchRequest): LaunchPlan {
  if (req.homeMissing) return { ok: false, reason: 'home-missing' };
  const dir =
    req.cwd && req.exists(req.cwd) ? req.cwd : req.exists(req.home) ? req.home : undefined;
  if (dir === undefined) return { ok: false, reason: 'home-missing' };
  const spec = resolveLaunchSpec(req.registry, req.agentId, dir, req.exists, dir);
  const def = req.agentId && req.agentId !== 'shell' ? req.registry.get(req.agentId) : undefined;
  if (!def) return { ok: true, spec, addDir: false, launchedRoots: [], skippedAddDirRoots: [] };
  // node-pty on win32 neither walks PATHEXT nor finds a `.cmd` by its bare name, so a raw
  // agents.json `claude` fails "File not found" (QA F1): spawn only what was resolved.
  const command = req.resolveCommand(def.command);
  if (command === undefined) return { ok: false, reason: 'unresolvable', command: def.command };
  const { args, ...lists } = launchArgsFor(def, req.roots, {
    platform: req.platform,
    resolvedCommand: command,
  });
  return { ok: true, spec: { ...spec, command, args }, ...lists };
}

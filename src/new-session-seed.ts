import { folderKey } from './folder-key';
import type { LauncherDTO } from './launchers';
import type { RepoDTO } from './protocol';
import type { AgentDefinition, Project, Session } from './types';

export interface NewSessionPrefill {
  agentId?: string;
  projectId?: string | null;
  home?: string;
  roots?: string[];
  cardId?: string;
  cardTitle?: string;
}

export interface SeedContext {
  active: Session | undefined;
  sessions: readonly Session[];
  projects: readonly Project[];
  repos: readonly RepoDTO[];
  agents: readonly AgentDefinition[];
  launchers: readonly LauncherDTO[];
  defaultAgentId: string;
}

export interface NewSessionSeed {
  agentId: string;
  projectId: string | null;
  home?: string;
  roots: string[];
}

/** Pinned to src/ so the host tsconfig and mf-sidebar can share it (spec D18). */
export function projectForNewSession(
  active: Session | undefined,
  projects: readonly Project[],
): string | null {
  const id = active?.projectId;
  return id !== undefined && projects.some((p) => p.id === id) ? id : null;
}

/** A registered id as is; a D20 alias (`cli:claude` shadowed by agents.json) as its target. */
export function registeredAgentId(
  id: string | undefined,
  ctx: Pick<SeedContext, 'agents' | 'launchers'>,
): string | undefined {
  if (id === undefined) return undefined;
  if (ctx.agents.some((a) => a.id === id)) return id;
  const target = ctx.launchers.find((l) => l.aliases?.includes(id))?.id;
  return target !== undefined && ctx.agents.some((a) => a.id === target) ? target : undefined;
}

/** Spec §3.1 "agentId" steps 2–4. */
export function agentForHome(
  home: string | undefined,
  ctx: Pick<SeedContext, 'repos' | 'agents' | 'launchers' | 'defaultAgentId'>,
): string {
  const remembered = home === undefined ? undefined : ctx.repos.find((r) => r.path === home);
  const known =
    registeredAgentId(remembered?.lastAgentId, ctx) ?? registeredAgentId(ctx.defaultAgentId, ctx);
  if (known !== undefined) return known;
  const shell = ctx.launchers.find(
    (l) => l.kind === 'shell' && ctx.agents.some((a) => a.id === l.id),
  );
  return shell?.id ?? ctx.agents[0]?.id ?? '';
}

function folderSeed(
  prefill: NewSessionPrefill,
  projectId: string | null,
  ctx: SeedContext,
): { home?: string; roots: readonly string[] } {
  if (typeof prefill.home === 'string' && prefill.home) {
    return { home: prefill.home, roots: prefill.roots ?? [] };
  }
  if (projectId !== null) {
    const recent = ctx.sessions
      .filter((s) => s.projectId === projectId)
      .reduce<Session | undefined>(
        (a, b) => (a && a.lastActiveAt >= b.lastActiveAt ? a : b),
        undefined,
      );
    if (recent) return { home: recent.home, roots: recent.roots };
  }
  const repo = ctx.repos[0]?.path;
  return repo ? { home: repo, roots: [] } : { roots: [] };
}

/** Spec §3.1; missing folders are kept so the dialog can show them Not found (D17). */
export function seedNewSession(prefill: NewSessionPrefill, ctx: SeedContext): NewSessionSeed {
  const live = (id: string) => ctx.projects.some((p) => p.id === id);
  const projectId =
    prefill.projectId === null
      ? null
      : typeof prefill.projectId === 'string' && live(prefill.projectId)
        ? prefill.projectId
        : projectForNewSession(ctx.active, ctx.projects);
  const { home, roots } = folderSeed(prefill, projectId, ctx);
  const seen = new Set(home === undefined ? [] : [folderKey(home)]);
  const dedupedRoots =
    home === undefined
      ? []
      : roots.filter((r) => {
          const key = folderKey(r);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
  const agentId = registeredAgentId(prefill.agentId, ctx) ?? agentForHome(home, ctx);
  return home === undefined
    ? { agentId, projectId, roots: [] }
    : { agentId, projectId, home, roots: dedupedRoots };
}

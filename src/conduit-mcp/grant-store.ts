// Node-free: pure store with an injected clock and id source. The service persists it.
// see spec 2026-11-14-policy-and-permissions §5.1 (POL-D7)
import { resolveTarget } from './policy-profiles';
import type { Grant, GrantFor, GrantWho, PolicyTarget, Principal, Scope } from './policy-types';
import type { ToolName } from './tool-policy';

export const GRANT_DECAY_MS = 7 * 86_400_000;
export const GRANT_EXPIRING_MS = 10 * 60_000;
export const GRANT_KEEP_EXPIRED_MS = 86_400_000;

export interface GrantChoice {
  who: GrantWho['kind'];
  on: 'target' | 'folder' | 'anywhere';
  for: GrantFor;
}

export interface GrantStoreDeps {
  now(): number;
  newId(): string;
}

export interface GrantStore {
  load(grants: Grant[]): void;
  all(): Grant[];
  create(
    who: GrantWho,
    tool: ToolName,
    on: Scope,
    forDur: GrantFor,
    anchorSessionId: string | null,
    requestId: string | null,
  ): Grant;
  touch(id: string): void;
  revoke(id: string): Grant | null;
  sessionEnded(sessionId: string): Grant[];
  tick(): Grant[];
}

const copyGrant = (g: Grant): Grant => ({ ...g, who: { ...g.who }, on: { ...g.on } });

const expiryFor = (forDur: GrantFor, now: number): string | null => {
  if (forDur === '1h') return new Date(now + 3_600_000).toISOString();
  if (forDur === '24h') return new Date(now + 86_400_000).toISOString();
  return null;
};

export function createGrantStore(deps: GrantStoreDeps): GrantStore {
  const grants = new Map<string, Grant>();
  const iso = (ms: number) => new Date(ms).toISOString();

  const end = (g: Grant, state: Grant['state'], now: number): void => {
    g.state = state;
    g.endedAt = iso(now);
  };

  return {
    load(list) {
      grants.clear();
      for (const g of list) grants.set(g.id, copyGrant(g));
    },

    all() {
      return [...grants.values()].map(copyGrant);
    },

    create(who, tool, on, forDur, anchorSessionId, requestId) {
      const now = deps.now();
      const g: Grant = {
        id: deps.newId(),
        who: { ...who },
        tool,
        on: { ...on },
        for: forDur,
        anchorSessionId,
        createdAt: iso(now),
        expiresAt: expiryFor(forDur, now),
        lastUsedAt: null,
        state: 'active',
        endedAt: null,
        requestId,
      };
      grants.set(g.id, g);
      return copyGrant(g);
    },

    touch(id) {
      const g = grants.get(id);
      if (g?.state === 'active') g.lastUsedAt = iso(deps.now());
    },

    revoke(id) {
      const g = grants.get(id);
      if (!g || (g.state !== 'active' && g.state !== 'suspended')) return null;
      end(g, 'revoked', deps.now());
      return copyGrant(g);
    },

    sessionEnded(sessionId) {
      const now = deps.now();
      const changed: Grant[] = [];
      for (const g of grants.values()) {
        if (g.state !== 'active' && g.state !== 'suspended') continue;
        const ownedBy = g.who.kind === 'session' && g.who.sessionId === sessionId;
        const onSession = g.on.kind === 'session' && g.on.sessionId === sessionId;
        const anchored = g.anchorSessionId === sessionId && g.for === 'session-end';
        if (!ownedBy && !onSession && !anchored) continue;
        end(g, 'expired', now);
        changed.push(copyGrant(g));
      }
      return changed;
    },

    tick() {
      const now = deps.now();
      const changed: Grant[] = [];
      for (const g of grants.values()) {
        if (g.state !== 'active') continue;
        const timedOut = g.expiresAt !== null && Date.parse(g.expiresAt) <= now;
        const idle =
          g.for === 'session-end' && now - Date.parse(g.lastUsedAt ?? g.createdAt) > GRANT_DECAY_MS;
        if (!timedOut && !idle) continue;
        end(g, 'expired', now);
        changed.push(copyGrant(g));
      }
      for (const [id, g] of grants) {
        if (g.state !== 'expired' && g.state !== 'revoked') continue;
        if (g.endedAt !== null && now - Date.parse(g.endedAt) > GRANT_KEEP_EXPIRED_MS) {
          grants.delete(id);
        }
      }
      return changed;
    },
  };
}

// Never widens: a target with no session, path or folder yields null, and the caller refuses.
export function grantScopeFor(
  choice: GrantChoice['on'],
  target: PolicyTarget,
  principal: Principal,
): Scope | null {
  if (choice === 'anywhere') return { kind: 'anywhere' };
  const resolved = resolveTarget(target, principal);
  if (choice === 'folder') {
    return resolved.folder ? { kind: 'folder', path: resolved.folder } : null;
  }
  if (resolved.sessionId) return { kind: 'session', sessionId: resolved.sessionId };
  return resolved.path ? { kind: 'path', path: resolved.path } : null;
}

export function grantWhoFor(choice: GrantChoice['who'], principal: Principal): GrantWho | null {
  if (choice === 'session') {
    return principal.kind === 'session'
      ? { kind: 'session', sessionId: principal.sessionId }
      : null;
  }
  if (choice === 'cli') {
    return principal.kind === 'session' && principal.launchedCli !== null
      ? { kind: 'cli', cli: principal.launchedCli }
      : null;
  }
  return principal.kind === 'remote' ? { kind: 'peer', machineId: principal.machineId } : null;
}

const within = (deadline: number, now: number): boolean => {
  const left = deadline - now;
  return left > 0 && left < GRANT_EXPIRING_MS;
};

export function isExpiring(g: Grant, now: number): boolean {
  if (g.state !== 'active') return false;
  if (g.expiresAt !== null && within(Date.parse(g.expiresAt), now)) return true;
  return (
    g.for === 'session-end' && within(Date.parse(g.lastUsedAt ?? g.createdAt) + GRANT_DECAY_MS, now)
  );
}

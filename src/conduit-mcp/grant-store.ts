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

export const GRANT_WHO_KINDS: readonly GrantWho['kind'][] = ['session', 'cli', 'peer'];
export const GRANT_CHOICE_ON: readonly GrantChoice['on'][] = ['target', 'folder', 'anywhere'];
export const GRANT_FORS: readonly GrantFor[] = ['session-end', '1h', '24h', 'until-revoked'];

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
  extend(id: string, revision: number): Grant | null;
  renew(id: string, revision: number): Grant | null;
  restore(previous: Grant, revision: number): Grant | null;
  revoke(id: string): Grant | null;
  sessionEnded(sessionId: string): Grant[];
  peerRevoked(machineId: string): Grant[];
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
    g.lifecycleRevision = Math.min(Number.MAX_SAFE_INTEGER, (g.lifecycleRevision ?? 0) + 1);
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
        useCount: 0,
        lifecycleRevision: 0,
        state: 'active',
        endedAt: null,
        requestId,
      };
      grants.set(g.id, g);
      return copyGrant(g);
    },

    touch(id) {
      const g = grants.get(id);
      if (g?.state === 'active') {
        g.lastUsedAt = iso(deps.now());
        if (g.useCount !== undefined)
          g.useCount = Math.min(Number.MAX_SAFE_INTEGER, g.useCount + 1);
      }
    },

    extend(id, revision) {
      const g = grants.get(id);
      const now = deps.now();
      if (
        g?.state !== 'active' ||
        g.expiresAt === null ||
        Date.parse(g.expiresAt) <= now ||
        (g.lifecycleRevision ?? 0) !== revision ||
        revision >= Number.MAX_SAFE_INTEGER
      )
        return null;
      const expiry = Math.max(now, Date.parse(g.expiresAt)) + 3_600_000;
      if (!Number.isFinite(new Date(expiry).getTime())) return null;
      g.expiresAt = iso(expiry);
      g.lastConsentedAt = iso(now);
      g.lifecycleRevision = revision + 1;
      return copyGrant(g);
    },

    renew(id, revision) {
      const g = grants.get(id);
      const now = deps.now();
      if (
        g?.state !== 'expired' ||
        (g.lifecycleRevision ?? 0) !== revision ||
        revision >= Number.MAX_SAFE_INTEGER
      )
        return null;
      const duration = g.for === '1h' ? 3_600_000 : g.for === '24h' ? 86_400_000 : 0;
      if (duration && !Number.isFinite(new Date(now + duration).getTime())) return null;
      const expiry = expiryFor(g.for, now);
      if (g.for === 'session-end' && g.anchorSessionId === null) return null;
      g.state = 'active';
      g.endedAt = null;
      g.expiresAt = expiry;
      g.lastConsentedAt = iso(now);
      g.lifecycleRevision = revision + 1;
      return copyGrant(g);
    },

    restore(previous, revision) {
      const current = grants.get(previous.id);
      if (
        current?.state !== 'revoked' ||
        (current.lifecycleRevision ?? 0) !== revision ||
        revision >= Number.MAX_SAFE_INTEGER ||
        (previous.state !== 'active' && previous.state !== 'suspended') ||
        (previous.expiresAt !== null && Date.parse(previous.expiresAt) <= deps.now()) ||
        JSON.stringify([
          current.who,
          current.tool,
          current.on,
          current.for,
          current.anchorSessionId,
          current.createdAt,
          current.requestId,
          current.expiresAt,
          current.lastUsedAt,
          current.lastConsentedAt,
          current.useCount,
        ]) !==
          JSON.stringify([
            previous.who,
            previous.tool,
            previous.on,
            previous.for,
            previous.anchorSessionId,
            previous.createdAt,
            previous.requestId,
            previous.expiresAt,
            previous.lastUsedAt,
            previous.lastConsentedAt,
            previous.useCount,
          ])
      )
        return null;
      const restored = copyGrant(previous);
      restored.lifecycleRevision = revision + 1;
      grants.set(restored.id, restored);
      return copyGrant(restored);
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

    peerRevoked(machineId) {
      const now = deps.now();
      const changed: Grant[] = [];
      for (const g of grants.values()) {
        if (g.state !== 'active' && g.state !== 'suspended') continue;
        if (g.who.kind !== 'peer' || g.who.machineId !== machineId) continue;
        end(g, 'revoked', now);
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
        const idle = g.for === 'session-end' && now - lastActivity(g) > GRANT_DECAY_MS;
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

const lastActivity = (g: Grant): number =>
  Math.max(
    Date.parse(g.createdAt),
    Date.parse(g.lastUsedAt ?? g.createdAt),
    Date.parse(g.lastConsentedAt ?? g.createdAt),
  );

const within = (deadline: number, now: number): boolean => {
  const left = deadline - now;
  return left > 0 && left < GRANT_EXPIRING_MS;
};

export function isExpiring(g: Grant, now: number): boolean {
  if (g.state !== 'active') return false;
  if (g.expiresAt !== null && within(Date.parse(g.expiresAt), now)) return true;
  return g.for === 'session-end' && within(lastActivity(g) + GRANT_DECAY_MS, now);
}

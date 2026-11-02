import { createHash, randomBytes } from 'node:crypto';
import type { TokenRows, TokenStorePort } from '../../../src/contracts/server-ports';
import type { TokenRecord } from '../../../src/contracts/session-identity';
import type { LaunchIds } from '../../../src/contracts/terminal-runtime';

export interface MemTokenStore extends TokenStorePort {
  /** What `rows()` reports; a test sets it to exercise a store that could not be read. */
  state: TokenRows['state'];
  /** Every mutation after `reserve`, in order. */
  readonly calls: string[];
  /** The live row, so a test can see a transition the port does not expose. */
  row(launchId: string): TokenRecord | undefined;
  /** A row as a previous run left it. */
  add(
    sessionId: string,
    ids: LaunchIds,
    state: TokenRecord['state'],
    hcAddress: string | null,
  ): void;
}

/**
 * TokenStorePort over memory with the persistent store's transitions (server/mcp/token-file.ts):
 * a superseded row stays superseded when its address resolves, and only a reserved row becomes
 * unconfirmed. Not the commit-before-publish behavior, which only the file store has.
 */
export function createTokenStore(
  opts: { randomToken?: () => string; now?: () => number } = {},
): MemTokenStore {
  const rows = new Map<string, TokenRecord>();
  const randomToken = opts.randomToken ?? (() => randomBytes(32).toString('hex'));
  const now = opts.now ?? Date.now;
  const store: MemTokenStore = {
    state: 'loaded',
    calls: [],
    row: (launchId) => rows.get(launchId),
    add(sessionId, ids, state, hcAddress) {
      rows.set(ids.launchId, {
        sessionId,
        sha256: 'hash',
        generation: ids.generation,
        launchId: ids.launchId,
        state,
        hcAddress,
        createdAt: '2026-11-02T00:00:00.000Z',
      });
    },
    async reserve(sessionId, ids) {
      for (const [id, row] of rows) {
        if (row.sessionId !== sessionId) continue;
        if (row.state === 'unconfirmed') row.state = 'superseded';
        else if (row.state !== 'superseded') rows.delete(id);
      }
      const token = randomToken();
      rows.set(ids.launchId, {
        sessionId,
        ...ids,
        sha256: createHash('sha256').update(token).digest('hex'),
        state: 'reserved',
        hcAddress: null,
        createdAt: new Date(now()).toISOString(),
      });
      return { token };
    },
    async resolveAddress(launchId, hcAddress) {
      store.calls.push(`resolve ${launchId} ${hcAddress}`);
      const row = rows.get(launchId);
      if (!row) return;
      row.hcAddress = hcAddress;
      if (row.state !== 'superseded') row.state = 'live';
    },
    async markUnconfirmed(launchId) {
      store.calls.push(`unconfirmed ${launchId}`);
      const row = rows.get(launchId);
      if (row?.state === 'reserved') row.state = 'unconfirmed';
    },
    async markSuperseded(launchId) {
      store.calls.push(`superseded ${launchId}`);
      const row = rows.get(launchId);
      if (row) row.state = 'superseded';
    },
    rows() {
      if (store.state !== 'loaded') return { state: store.state };
      return { state: 'loaded', rows: [...rows.values()].map((row) => ({ ...row })) };
    },
    async revoke(key) {
      store.calls.push(`revoke ${'launchId' in key ? key.launchId : key.sessionId}`);
      for (const [id, row] of rows) {
        if ('sessionId' in key ? row.sessionId === key.sessionId : id === key.launchId)
          rows.delete(id);
      }
    },
  };
  return store;
}

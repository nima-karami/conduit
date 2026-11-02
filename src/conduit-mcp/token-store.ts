import { createHash, randomBytes } from 'node:crypto';
import type { TokenStorePort } from '../contracts/server-ports';
import type { TokenRecord } from '../contracts/session-identity';

export function createTokenStore(
  opts: { randomToken?: () => string; now?: () => number } = {},
): TokenStorePort {
  const rows = new Map<string, TokenRecord>();
  const randomToken = opts.randomToken ?? (() => randomBytes(32).toString('hex'));
  const now = opts.now ?? Date.now;
  return {
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
      const row = rows.get(launchId);
      if (!row) return;
      row.hcAddress = hcAddress;
      if (row.state !== 'superseded') row.state = 'live';
    },
    async markUnconfirmed(launchId) {
      const row = rows.get(launchId);
      if (row?.state === 'reserved') row.state = 'unconfirmed';
    },
    async markSuperseded(launchId) {
      const row = rows.get(launchId);
      if (row) row.state = 'superseded';
    },
    rows: () => ({ state: 'loaded', rows: [...rows.values()].map((row) => ({ ...row })) }),
    async revoke(key) {
      for (const [id, row] of rows) {
        if ('sessionId' in key ? row.sessionId === key.sessionId : id === key.launchId)
          rows.delete(id);
      }
    },
  };
}

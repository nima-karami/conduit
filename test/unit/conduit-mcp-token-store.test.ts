import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTokenStore } from '../../server/runtime/testing/token-store';
import type { TokenRecord } from '../../src/contracts/session-identity';

const ids = (generation: number) => ({
  generation,
  launchId: generation.toString(16).padStart(32, '0'),
});
const rowsOf = (store: ReturnType<typeof createTokenStore>): readonly TokenRecord[] => {
  const result = store.rows();
  expect(result.state).toBe('loaded');
  return result.state === 'loaded' ? result.rows : [];
};

describe('in-memory TokenStorePort', () => {
  it('reserves launch identity with only a hash in its row', async () => {
    const store = createTokenStore({ randomToken: () => 'secret', now: () => 123 });
    expect(await store.reserve('s1', ids(1))).toEqual({ token: 'secret' });
    expect(rowsOf(store)).toEqual([
      {
        sessionId: 's1',
        ...ids(1),
        sha256: createHash('sha256').update('secret').digest('hex'),
        state: 'reserved',
        hcAddress: null,
        createdAt: new Date(123).toISOString(),
      },
    ]);
    expect(JSON.stringify(store.rows())).not.toContain('secret');
  });

  it('records unconfirmed and late-confirmed addresses, then supersedes explicitly', async () => {
    const store = createTokenStore();
    await store.reserve('s1', ids(1));
    await store.markUnconfirmed(ids(1).launchId);
    expect(rowsOf(store)[0]?.state).toBe('unconfirmed');
    await store.resolveAddress(ids(1).launchId, 'hc-1');
    expect(rowsOf(store)[0]).toMatchObject({ state: 'live', hcAddress: 'hc-1' });
    await store.markSuperseded(ids(1).launchId);
    expect(rowsOf(store)[0]?.state).toBe('superseded');
  });

  it('replaces ordinary rows but retains an unconfirmed prior launch as superseded', async () => {
    const store = createTokenStore();
    await store.reserve('s1', ids(1));
    await store.reserve('s1', ids(2));
    expect(rowsOf(store).map((r) => r.launchId)).toEqual([ids(2).launchId]);
    await store.markUnconfirmed(ids(2).launchId);
    await store.reserve('s1', ids(3));
    expect(rowsOf(store).map((r) => [r.launchId, r.state])).toEqual([
      [ids(2).launchId, 'superseded'],
      [ids(3).launchId, 'reserved'],
    ]);
    await store.resolveAddress(ids(2).launchId, 'late');
    expect(rowsOf(store)[0]?.state).toBe('superseded');
  });

  it('revokes one launch or every row of a session without changing other sessions', async () => {
    const store = createTokenStore();
    await store.reserve('s1', ids(1));
    await store.markUnconfirmed(ids(1).launchId);
    await store.reserve('s1', ids(2));
    await store.reserve('s2', ids(3));
    await store.revoke({ launchId: ids(2).launchId });
    expect(rowsOf(store).map((r) => r.launchId)).toEqual([ids(1).launchId, ids(3).launchId]);
    await store.revoke({ sessionId: 's1' });
    expect(rowsOf(store).map((r) => r.sessionId)).toEqual(['s2']);
  });
});

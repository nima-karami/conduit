import { describe, expect, it } from 'vitest';
import { createLaunchClaims } from '../../electron/launch-claims';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** term:start's cold path from the isAlive re-check on, with the token store held open. */
function harness() {
  const claims = createLaunchClaims();
  const alive = new Set<string>();
  const calls: string[] = [];
  const tokenStore = deferred();
  const start = async (id: string) => {
    if (alive.has(id)) {
      calls.push('attach');
      return;
    }
    const claim = claims.claim(id);
    if (claim.kind === 'joined') {
      await claim.settled;
      calls.push(alive.has(id) ? 'attach' : 'gave-up');
      return;
    }
    try {
      calls.push('allocateLaunch', 'prepareLaunch');
      await tokenStore.promise;
      calls.push('spawn');
      alive.add(id);
    } finally {
      claim.release();
    }
  };
  return { start, calls, alive, tokenStore };
}

describe('launch claims', () => {
  it('two concurrent starts run one prepareLaunch and one spawn; the second attaches', async () => {
    const h = harness();
    const first = h.start('s1');
    const second = h.start('s1');
    h.tokenStore.resolve();
    await Promise.all([first, second]);
    expect(h.calls).toEqual(['allocateLaunch', 'prepareLaunch', 'spawn', 'attach']);
  });

  it('a start after the launch settled claims afresh', async () => {
    const claims = createLaunchClaims();
    const a = claims.claim('s1');
    expect(a.kind).toBe('owner');
    if (a.kind === 'owner') a.release();
    expect(claims.claim('s1').kind).toBe('owner');
  });

  it('a joiner settles when the owner gives up without spawning', async () => {
    const claims = createLaunchClaims();
    const owner = claims.claim('s1');
    const joined = claims.claim('s1');
    expect(joined.kind).toBe('joined');
    if (owner.kind === 'owner') owner.release();
    if (joined.kind === 'joined') await expect(joined.settled).resolves.toBeUndefined();
  });

  it('claims are per session', () => {
    const claims = createLaunchClaims();
    claims.claim('s1');
    expect(claims.claim('s2').kind).toBe('owner');
  });
});

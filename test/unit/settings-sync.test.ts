import { describe, expect, it } from 'vitest';
import { decideHydrate, makeGate, onLocalEdit, onPostFired, settle } from '../../src/settings-sync';

// A tiny harness mirroring exactly how webview/settings.tsx drives the gate, so the
// interleavings are tested against the same shape the provider uses: a gate ref plus a
// `posted` ref capturing the value+epoch of the last post. Settings are modelled as
// plain objects; the provider compares via JSON.stringify, so we do the same.

type S = Record<string, unknown>;

function harness() {
  const gate = makeGate();
  const posted = { json: '', epoch: -1 };
  let value: S = { sidebarCollapsed: false };

  return {
    /** A user toggle: optimistic local flip + mark dirty (no post yet). */
    edit(patch: S) {
      onLocalEdit(gate);
      value = { ...value, ...patch };
    },
    /** The debounce fires (or unload flush): capture posted value + epoch. */
    post() {
      posted.epoch = onPostFired(gate);
      posted.json = JSON.stringify(value);
    },
    /** A host `state` broadcast arrives carrying `incoming` settings. */
    hydrate(incoming: S): boolean {
      const { apply } = decideHydrate(gate, {
        postedEpoch: posted.epoch,
        incomingMatchesPosted: JSON.stringify(incoming) === posted.json,
      });
      if (apply) value = incoming;
      return apply;
    },
    settle() {
      settle(gate);
    },
    get value() {
      return value;
    },
    get dirty() {
      return gate.dirty;
    },
  };
}

describe('settings-sync gate (K1)', () => {
  it('idle hydrate applies (host authoritative; also the initial-load path)', () => {
    const h = harness();
    expect(h.dirty).toBe(false);
    const applied = h.hydrate({ sidebarCollapsed: true });
    expect(applied).toBe(true);
    expect(h.value).toEqual({ sidebarCollapsed: true });
  });

  it('toggle then stale echo mid-window does NOT revert the optimistic change', () => {
    const h = harness();
    h.edit({ sidebarCollapsed: true }); // user collapses; host not told yet
    // An activity broadcast races in carrying the STALE pre-change value.
    const applied = h.hydrate({ sidebarCollapsed: false });
    expect(applied).toBe(false);
    expect(h.value).toEqual({ sidebarCollapsed: true }); // stays collapsed
  });

  it('stale echo after the post but before confirmation is still ignored', () => {
    const h = harness();
    h.edit({ sidebarCollapsed: true });
    h.post(); // debounce fired; host has our value but a broadcast was already in flight
    const applied = h.hydrate({ sidebarCollapsed: false }); // the in-flight stale one
    expect(applied).toBe(false);
    expect(h.value).toEqual({ sidebarCollapsed: true });
    expect(h.dirty).toBe(true); // still guarding until our value confirms
  });

  it('confirming echo (matches posted value) clears dirty without re-setting', () => {
    const h = harness();
    h.edit({ sidebarCollapsed: true });
    h.post();
    const applied = h.hydrate({ sidebarCollapsed: true }); // host confirms our change
    expect(applied).toBe(false); // value already local; no redundant set
    expect(h.dirty).toBe(false); // gate re-opens
    expect(h.value).toEqual({ sidebarCollapsed: true });
  });

  it('after confirmation, a later authoritative echo applies again', () => {
    const h = harness();
    h.edit({ sidebarCollapsed: true });
    h.post();
    h.hydrate({ sidebarCollapsed: true }); // confirm -> dirty cleared
    // Later the host changes something legitimately (e.g. another field) and echoes.
    const applied = h.hydrate({ sidebarCollapsed: true, theme: 'nord' });
    expect(applied).toBe(true);
    expect(h.value).toEqual({ sidebarCollapsed: true, theme: 'nord' });
  });

  it('two rapid toggles: the first post-epoch confirmation does not re-open the gate', () => {
    const h = harness();
    h.edit({ sidebarCollapsed: true }); // edit 1 (epoch 1)
    h.post(); // posts edit 1's value at epoch 1
    h.edit({ sidebarCollapsed: false }); // edit 2 (epoch 2) before edit 1 confirmed
    // The echo confirming edit 1 arrives — but epoch has moved past it: ignore + stay dirty.
    const applied1 = h.hydrate({ sidebarCollapsed: true });
    expect(applied1).toBe(false);
    expect(h.dirty).toBe(true);
    expect(h.value).toEqual({ sidebarCollapsed: false }); // latest optimistic value preserved

    // Now edit 2 posts and its confirming echo arrives -> clears dirty.
    h.post();
    const applied2 = h.hydrate({ sidebarCollapsed: false });
    expect(applied2).toBe(false);
    expect(h.dirty).toBe(false);
    expect(h.value).toEqual({ sidebarCollapsed: false });
  });

  it('a fresh edit after settling re-arms the guard', () => {
    const h = harness();
    h.edit({ sidebarCollapsed: true });
    h.post();
    h.hydrate({ sidebarCollapsed: true }); // confirm
    expect(h.dirty).toBe(false);

    h.edit({ sidebarCollapsed: false }); // new optimistic change
    expect(h.dirty).toBe(true);
    const applied = h.hydrate({ sidebarCollapsed: true }); // stale echo again
    expect(applied).toBe(false);
    expect(h.value).toEqual({ sidebarCollapsed: false });
  });

  it('settle() force-clears dirty (provider escape hatch)', () => {
    const h = harness();
    h.edit({ sidebarCollapsed: true });
    expect(h.dirty).toBe(true);
    h.settle();
    expect(h.dirty).toBe(false);
    const applied = h.hydrate({ sidebarCollapsed: false });
    expect(applied).toBe(true);
  });
});

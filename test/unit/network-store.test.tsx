// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NetworkState } from '../../src/contracts/network-state';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

const h = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  listeners: new Set<(m: HostToWebview) => void>(),
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => h.posted.push(m),
  subscribe: (cb: (m: HostToWebview) => void) => {
    h.listeners.add(cb);
    return () => h.listeners.delete(cb);
  },
}));

import { useNetworkState } from '../../webview/network-store';

function Probe({ into }: { into: (s: NetworkState | null) => void }) {
  into(useNetworkState());
  return null;
}

const roots: Root[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  document.body.innerHTML = '';
});
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('network-store', () => {
  it('posts network:get once and delivers network:state to every subscriber', async () => {
    const a: (NetworkState | null)[] = [];
    const b: (NetworkState | null)[] = [];
    for (const sink of [a, b]) {
      const r = createRoot(document.body.appendChild(document.createElement('div')));
      roots.push(r);
      await act(async () => r.render(createElement(Probe, { into: (s) => sink.push(s) })));
    }
    expect(h.posted.filter((p) => p.type === 'network:get')).toHaveLength(1);
    expect(a.at(-1)).toBeNull();

    const state: NetworkState = {
      machineId: 'm-00000001',
      selfName: 'this',
      listening: [],
      links: [],
      pairing: null,
      machines: [],
    };
    await act(async () => {
      for (const l of [...h.listeners]) l({ type: 'network:state', state });
    });
    expect(a.at(-1)).toBe(state);
    expect(b.at(-1)).toBe(state);
  });
});

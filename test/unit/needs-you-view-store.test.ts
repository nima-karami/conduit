// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** jsdom in this setup exposes no localStorage, so the tests stub one on the global. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}
let storage = memoryStorage();

const KEY = 'conduit.needsYou.view';
const DEFAULT = { sort: 'soonest', show: { space: false, age: false, machine: false } };

type Store = typeof import('../../webview/needs-you-view-store');
type View = import('../../webview/needs-you-view-store').NeedsYouView;

let store: Store;
let setter: ((v: View) => void) | null = null;
let seen: View | null = null;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

async function fresh(): Promise<void> {
  vi.resetModules();
  store = await import('../../webview/needs-you-view-store');
}

beforeEach(async () => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  await fresh();
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  host?.remove();
  host = null;
  setter = null;
  seen = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(): void {
  function Probe() {
    const [view, set] = store.useNeedsYouView();
    seen = view;
    setter = set;
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(createElement(Probe)));
}

describe('needs-you view store', () => {
  it('defaults when storage is empty', () => {
    mount();
    expect(seen).toEqual(DEFAULT);
  });

  it('persists a choice', () => {
    mount();
    const next: View = { sort: 'newest', show: { space: true, age: false, machine: true } };
    act(() => setter?.(next));
    expect(seen).toEqual(next);
    expect(JSON.parse(storage.getItem(KEY) ?? 'null')).toEqual(next);
  });

  it('ignores garbage in storage', async () => {
    const garbage = [
      '{not json',
      '"just a string"',
      'null',
      JSON.stringify({ sort: 'bogus', show: DEFAULT.show }),
      JSON.stringify({ sort: 'newest' }),
      JSON.stringify({ sort: 'newest', show: { space: 'yes', age: false, machine: false } }),
      JSON.stringify({ sort: 'newest', show: { space: true, age: false } }),
    ];
    for (const raw of garbage) {
      storage.setItem(KEY, raw);
      await fresh();
      mount();
      expect(seen, raw).toEqual(DEFAULT);
      await act(async () => root?.unmount());
      root = null;
      host?.remove();
      host = null;
    }
  });

  it('survives storage that throws', () => {
    storage.getItem = () => {
      throw new Error('blocked');
    };
    storage.setItem = () => {
      throw new Error('blocked');
    };
    mount();
    expect(seen).toEqual(DEFAULT);
    expect(() => act(() => setter?.({ sort: 'session', show: DEFAULT.show }))).not.toThrow();
    expect(seen?.sort).toBe('session');
  });
});

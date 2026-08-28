// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeMarker } from '../../webview/change-decorations';
import { type PeekZoneApi, usePeekZone } from '../../webview/use-peek-zone';

/**
 * Same shape as test/unit/use-change-markers.test.ts: a hand-written stub of the few Monaco
 * surfaces the hook touches, driven through react-dom in jsdom. The regression this guards is
 * the one every view zone ships with — a zone (or its portal) left behind after the thing that
 * owned it went away.
 */

const marker = (over: Partial<ChangeMarker> = {}): ChangeMarker => ({
  kind: 'deleted',
  startLine: 10,
  endLine: 10,
  addedLines: 0,
  removedLines: 2,
  oldRange: [10, 11],
  removedText: ['gone one', 'gone two'],
  ...over,
});

interface ZoneProbe {
  zones: Map<string, { afterLineNumber: number; heightInLines: number; domNode: HTMLElement }>;
  changeModelHandlers: Set<() => void>;
  keyHandlers: Set<(e: unknown) => void>;
  focused: number;
}

function makeEditor() {
  const probe: ZoneProbe = {
    zones: new Map(),
    changeModelHandlers: new Set(),
    keyHandlers: new Set(),
    focused: 0,
  };
  let nextId = 1;
  const editor = {
    changeViewZones: (cb: (a: unknown) => void) =>
      cb({
        addZone: (z: { afterLineNumber: number; heightInLines: number; domNode: HTMLElement }) => {
          const id = `z${nextId++}`;
          probe.zones.set(id, z);
          return id;
        },
        removeZone: (id: string) => {
          probe.zones.delete(id);
        },
      }),
    onDidChangeModel: (cb: () => void) => {
      probe.changeModelHandlers.add(cb);
      return {
        dispose: () => {
          probe.changeModelHandlers.delete(cb);
        },
      };
    },
    onKeyDown: (cb: (e: unknown) => void) => {
      probe.keyHandlers.add(cb);
      return {
        dispose: () => {
          probe.keyHandlers.delete(cb);
        },
      };
    },
    render: () => {},
    revealLineInCenterIfOutsideViewport: () => {},
    focus: () => {
      probe.focused++;
    },
  };
  return { editor, probe };
}

let api: PeekZoneApi | null = null;
let root: Root | null = null;

function Probe({ editor, markers }: { editor: unknown; markers: ChangeMarker[] }): ReactNode {
  // biome-ignore lint/suspicious/noExplicitAny: the stub above is the whole editor surface the hook uses.
  api = usePeekZone({
    editor: editor as any,
    markers,
    render: (index) => createElement('div', { className: 'peek-probe' }, `change ${index}`),
  });
  return api.portal;
}

const render = async (editor: unknown, markers: ChangeMarker[]) => {
  await act(async () => {
    root?.render(createElement(Probe, { editor, markers }));
  });
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  api = null;
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
});

describe('usePeekZone', () => {
  it('adds no zone until something opens one', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    expect(probe.zones.size).toBe(0);
    expect(api?.index).toBeNull();
    expect(api?.portal).toBeNull();
  });

  it('opens one zone above the change and mounts the portal into its dom node', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    expect(probe.zones.size).toBe(1);
    const zone = [...probe.zones.values()][0];
    expect(zone.afterLineNumber).toBe(9);
    expect(zone.heightInLines).toBe(4);
    expect(zone.domNode.querySelector('.peek-probe')?.textContent).toBe('change 0');
  });

  it('keeps exactly one zone when another marker is opened', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker(), marker({ startLine: 40, endLine: 40 })]);
    await act(async () => api?.open(0));
    await act(async () => api?.open(1));
    expect(probe.zones.size).toBe(1);
    expect([...probe.zones.values()][0].afterLineNumber).toBe(39);
  });

  it('removes the zone and unmounts the portal on close, and returns focus', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    const node = [...probe.zones.values()][0].domNode;
    await act(async () => api?.close());
    expect(probe.zones.size).toBe(0);
    expect(api?.portal).toBeNull();
    expect(node.querySelector('.peek-probe')).toBeNull();
    expect(probe.focused).toBeGreaterThan(0);
  });

  it('closes when the model is swapped underneath it', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    expect(probe.zones.size).toBe(1);
    await act(async () => {
      for (const cb of probe.changeModelHandlers) cb();
    });
    expect(probe.zones.size).toBe(0);
    expect(api?.index).toBeNull();
  });

  it('removes the zone when the editor goes away', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    await render(null, [marker()]);
    expect(probe.zones.size).toBe(0);
  });

  it('walks to the next and previous change, wrapping', async () => {
    const { editor } = makeEditor();
    await render(editor, [marker(), marker({ startLine: 40, endLine: 40 })]);
    await act(async () => api?.open(1));
    await act(async () => api?.next());
    expect(api?.index).toBe(0);
    await act(async () => api?.prev());
    expect(api?.index).toBe(1);
  });

  it('clamps an open peek when a recompute shortens the marker list', async () => {
    const { editor } = makeEditor();
    await render(editor, [marker(), marker({ startLine: 40, endLine: 40 })]);
    await act(async () => api?.open(1));
    await render(editor, [marker()]);
    expect(api?.index).toBe(0);
  });

  it('closes when a recompute leaves no markers at all', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    await render(editor, []);
    expect(api?.index).toBeNull();
    expect(probe.zones.size).toBe(0);
  });
});

describe('usePeekZone Esc from the editor', () => {
  /** Monaco focuses the editor while handling the gutter mousedown that opens the peek, so the
   *  key arrives on its textarea and never on the portal — the peek has to hear it here. */
  const pressEscape = (probe: { keyHandlers: Set<(e: unknown) => void> }) => {
    let prevented = 0;
    for (const cb of probe.keyHandlers) {
      cb({
        browserEvent: { key: 'Escape' },
        preventDefault: () => {
          prevented++;
        },
        stopPropagation: () => {},
      });
    }
    return prevented;
  };

  it('closes the peek and swallows the key', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    expect(probe.zones.size).toBe(1);
    await act(async () => {
      pressEscape(probe);
    });
    expect(api?.index).toBeNull();
    expect(probe.zones.size).toBe(0);
    expect(probe.focused).toBeGreaterThan(0);
  });

  it('listens only while a peek is open', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    expect(probe.keyHandlers.size).toBe(0);
    await act(async () => api?.open(0));
    expect(probe.keyHandlers.size).toBe(1);
    await act(async () => api?.close());
    expect(probe.keyHandlers.size).toBe(0);
  });

  it('leaves every other key to the editor', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    let prevented = 0;
    await act(async () => {
      for (const cb of probe.keyHandlers) {
        cb({
          browserEvent: { key: 'a' },
          preventDefault: () => {
            prevented++;
          },
          stopPropagation: () => {},
        });
      }
    });
    expect(prevented).toBe(0);
    expect(api?.index).toBe(0);
  });
});

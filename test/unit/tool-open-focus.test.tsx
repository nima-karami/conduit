// @vitest-environment jsdom
import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GroupIndex } from '../../webview/doc-groups';
import type { DocsState, OpenDoc } from '../../webview/docs';
import { openHidesFocus, runToolOpen, useDrainAfterCommit } from '../../webview/tool-open-focus';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no layout; an element with a display:none ancestor is the one case that matters here.
  Element.prototype.checkVisibility = function (this: Element) {
    for (let el: Element | null = this; el; el = el.parentElement) {
      if (el instanceof HTMLElement && el.style.display === 'none') return false;
    }
    return true;
  };
});

type Change = 'hide' | 'remove' | 'nothing';
let apply: ((c: Change) => void) | null = null;

/** A pane holding an input, which an "open" hides, removes or leaves alone; a control outside. */
function Stage() {
  const [state, setState] = useState<'shown' | Change>('shown');
  apply = (c) => setState(c);
  return (
    <>
      <div className="panes">
        {state !== 'remove' && (
          <div style={{ display: state === 'hide' ? 'none' : 'block' }}>
            <input className="caret" />
          </div>
        )}
        <div className="opened" />
      </div>
      <button type="button" className="outside" />
    </>
  );
}

let root: Root | null = null;
function mount(): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<Stage />));
}
afterEach(() => {
  const r = root;
  root = null;
  if (r) act(() => r.unmount());
  document.body.innerHTML = '';
});

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const panesOnly = (): Element[] => [q('.panes') as Element];
const run = (change: Change, panes: readonly Element[] = panesOnly()) =>
  openHidesFocus(panes, () => apply?.(change));

describe('openHidesFocus (spec 2026-10-30-conduit-mcp-app-control §2.1, QA L1)', () => {
  it('commits the open before it returns', () => {
    mount();
    run('remove');
    expect(q('.caret')).toBeNull();
  });

  it('true when the open hides the focused element inside the panes', () => {
    mount();
    q('.caret')?.focus();
    expect(run('hide')).toBe(true);
  });

  it('true when the open removes it', () => {
    mount();
    q('.caret')?.focus();
    expect(run('remove')).toBe(true);
  });

  it('false when the focused element stays visible (a split partner, a background open)', () => {
    mount();
    q('.caret')?.focus();
    expect(run('nothing')).toBe(false);
  });

  it('false when focus was outside the panes, even if something there hid', () => {
    mount();
    q('.outside')?.focus();
    expect(run('hide')).toBe(false);
  });

  it('false when focus was nowhere (body) to begin with', () => {
    mount();
    expect(run('hide')).toBe(false);
  });

  it('false when the caller has no panes on screen', () => {
    mount();
    q('.caret')?.focus();
    expect(run('hide', [])).toBe(false);
  });

  it('true when focus sat in another surface the caller owns (Board over the center pane)', () => {
    mount();
    q('.caret')?.focus();
    const board = document.createElement('div');
    document.body.appendChild(board);
    expect(run('hide', [board, q('.panes') as Element])).toBe(true);
  });
});

/** A drain whose open hides the focused input, run by useDrainAfterCommit when `n` changes. */
let drained: boolean | null = null;
function Drainer({ n }: { n: number }) {
  const [hidden, setHidden] = useState(false);
  const drain = useCallback(() => {
    if (n === 0) return;
    drained = openHidesFocus([q('.dpanes') as Element], () => setHidden(true));
  }, [n]);
  useDrainAfterCommit(drain);
  return <div className="dpanes">{!hidden && <input className="dcaret" />}</div>;
}

describe('useDrainAfterCommit (final M1)', () => {
  it('a drain started by a commit still sees its open committed before it samples focus', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<Drainer n={0} />));
    q('.dcaret')?.focus();
    drained = null;
    act(() => root?.render(<Drainer n={1} />));
    await Promise.resolve();
    expect(q('.dcaret')).toBeNull();
    expect(drained).toBe(true);
  });
});

const doc = (path: string): OpenDoc => ({
  id: `file:${path}`,
  kind: 'file',
  path,
  title: path,
  sessionId: 'S1',
});

/** Session S1 split in two; `active` is each group's shown tab, `focused` the active group. */
function split(active: [string | null, string], focused: GroupIndex): DocsState {
  const docs = ['/a.ts', '/b.ts'].map(doc);
  const tab = (id: string | null) => (id === null ? [] : [{ id }]);
  return {
    docs,
    activeId: null,
    layouts: {
      S1: {
        groups: [
          { tabs: tab(active[0]), active: active[0] },
          { tabs: tab(active[1]), active: active[1] },
        ],
        activeGroup: focused,
      },
    },
  };
}

describe('runToolOpen (final M3)', () => {
  const isA = (d: OpenDoc) => d.path === '/a.ts';

  it('opens into the target group and lands there, not in another group showing a match', () => {
    mount();
    q('.caret')?.focus();
    let state = split(['file:/a.ts', 'file:/b.ts'], 2);
    const into: GroupIndex[] = [];
    const landed = runToolOpen(
      () => state,
      'S1',
      panesOnly(),
      isA,
      (g) => {
        into.push(g);
        state = split(['file:/a.ts', 'file:/a.ts'], 2);
        apply?.('hide');
      },
    );
    expect(into).toEqual([2]);
    expect(landed).toEqual({ group: 2, id: 'file:/a.ts' });
  });

  it("lands nowhere when the target group doesn't show the opened doc, even if another does", () => {
    mount();
    q('.caret')?.focus();
    const state = split(['file:/a.ts', 'file:/b.ts'], 2);
    const landed = runToolOpen(
      () => state,
      'S1',
      panesOnly(),
      isA,
      () => apply?.('hide'),
    );
    expect(landed).toBeNull();
  });

  it('lands nowhere when the open hid nothing the caller owned', () => {
    mount();
    q('.outside')?.focus();
    const state = split(['file:/a.ts', 'file:/a.ts'], 2);
    expect(
      runToolOpen(
        () => state,
        'S1',
        panesOnly(),
        isA,
        () => apply?.('hide'),
      ),
    ).toBeNull();
  });
});

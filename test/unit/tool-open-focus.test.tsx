// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openHidesFocus } from '../../webview/tool-open-focus';

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
const run = (change: Change, panes: Element | null = q('.panes')) =>
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
    expect(run('hide', null)).toBe(false);
  });
});

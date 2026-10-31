// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ReviewFindBar } from '../../webview/components/review-find-bar';
import { cancelDocFocus, requestDocFocus, useFocusTargetRef } from '../../webview/focus-targets';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const noop = () => {};
/** Review's shape: a find bar (when open) above a scroller registered as the view's focus target. */
function Review({ open, nonce }: { open: boolean; nonce: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const ref = useFocusTargetRef('review', scroller, input);
  return (
    <>
      {open && (
        <ReviewFindBar
          query=""
          caseSensitive={false}
          ordinal={0}
          count={0}
          capped={false}
          partial={null}
          loading={false}
          focusNonce={nonce}
          inputRef={input}
          onQueryChange={noop}
          onToggleCase={noop}
          onNext={noop}
          onPrev={noop}
          onSearchAll={noop}
          onClose={noop}
        />
      )}
      <div ref={ref} className="scroller" tabIndex={-1} />
    </>
  );
}

let root: Root | null = null;
const render = (open: boolean, nonce: number) => {
  if (!root) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root?.render(<Review open={open} nonce={nonce} />));
};
afterEach(() => {
  const r = root;
  root = null;
  if (r) act(() => r.unmount());
  cancelDocFocus();
  document.body.innerHTML = '';
});
const input = () => document.querySelector('.term-find__input');

describe("Review's find bar focus (final M5b)", () => {
  it('a bar restored open when Review mounts leaves focus where it was', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    render(true, 0);
    expect(document.activeElement).toBe(outside);
  });

  it('a bar opened by the user (/ or Mod+F) takes focus', () => {
    render(false, 0);
    render(true, 1);
    expect(document.activeElement).toBe(input());
  });

  it('a focus asked of Review lands in its open find bar, else in the scroller', () => {
    render(true, 0);
    requestDocFocus('review');
    expect(document.activeElement).toBe(input());
    render(false, 0);
    requestDocFocus('review');
    expect(document.activeElement).toBe(document.querySelector('.scroller'));
  });
});

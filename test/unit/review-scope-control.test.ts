// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewSourceControl } from '../../webview/components/review-source-control';
import type { ReviewSource } from '../../webview/docs';

/**
 * The Scope control is what Lane E's e2e locates by role+name, so the accessible names and the
 * radiogroup keyboard model are a contract, not styling (spec 2026-08-27-review-supercharge
 * §2 Lane D, §9).
 */
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(source: ReviewSource | undefined, onSetSource: (s: ReviewSource) => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(ReviewSourceControl, { source, onSetSource }));
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const radios = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="radio"]')];
const group = (el: HTMLElement) => el.querySelector<HTMLElement>('[role="radiogroup"]');

describe('Review scope control', () => {
  it('offers exactly All / Staged / Unstaged on the working source', () => {
    const el = mount({ kind: 'working' }, () => {});
    expect(group(el)?.getAttribute('aria-label')).toBe('Scope');
    expect(radios(el).map((r) => r.getAttribute('aria-label'))).toEqual([
      'All',
      'Staged',
      'Unstaged',
    ]);
  });

  it('defaults to All and marks the selection with more than colour', () => {
    const el = mount({ kind: 'working' }, () => {});
    const [all, staged] = radios(el);
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(all.className).toContain('seg__btn--active');
    expect(staged.getAttribute('aria-checked')).toBe('false');
    expect(staged.className).not.toContain('seg__btn--active');
  });

  it('rovs the tabindex so the group is one tab stop', () => {
    const el = mount({ kind: 'working', scope: 'unstaged' }, () => {});
    expect(radios(el).map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
  });

  it('is absent for commit and range sources', () => {
    const commit = mount({ kind: 'commit', sha: 'abc1234' }, () => {});
    expect(group(commit)).toBeNull();
    act(() => root?.unmount());
    host?.remove();

    const range = mount(
      { kind: 'range', base: { kind: 'commit', sha: 'a' }, head: { kind: 'working' } },
      () => {},
    );
    expect(group(range)).toBeNull();
  });

  it('selects the next scope on ArrowRight and wraps at the end', () => {
    const seen: ReviewSource[] = [];
    const el = mount({ kind: 'working' }, (s) => seen.push(s));
    act(() => {
      group(el)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(seen).toEqual([{ kind: 'working', scope: 'staged' }]);

    act(() => root?.unmount());
    host?.remove();
    const last: ReviewSource[] = [];
    const el2 = mount({ kind: 'working', scope: 'unstaged' }, (s) => last.push(s));
    act(() => {
      group(el2)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(last).toEqual([{ kind: 'working' }]);
  });

  it('selects the previous scope on ArrowLeft and jumps with Home/End', () => {
    const seen: ReviewSource[] = [];
    const el = mount({ kind: 'working', scope: 'unstaged' }, (s) => seen.push(s));
    const fire = (host: HTMLElement, key: string) =>
      act(() => {
        group(host)?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    fire(el, 'ArrowLeft');
    fire(el, 'Home');
    // Already on the last option, so End re-selects nothing — the source is only re-set on a
    // real change.
    fire(el, 'End');
    expect(seen).toEqual([{ kind: 'working', scope: 'staged' }, { kind: 'working' }]);

    act(() => root?.unmount());
    host?.remove();
    const fromAll: ReviewSource[] = [];
    const el2 = mount({ kind: 'working' }, (s) => fromAll.push(s));
    fire(el2, 'End');
    expect(fromAll).toEqual([{ kind: 'working', scope: 'unstaged' }]);
  });

  it('clicking a segment reports that scope', () => {
    const seen: ReviewSource[] = [];
    const el = mount({ kind: 'working' }, (s) => seen.push(s));
    act(() => {
      radios(el)[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(seen).toEqual([{ kind: 'working', scope: 'staged' }]);
  });
});

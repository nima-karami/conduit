// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCK_REASON, ReviewSourceControl } from '../../webview/components/review-source-control';
import type { ReviewSource } from '../../webview/docs';
import { reviewSourceLabel } from '../../webview/review-commit';
import { workingSource } from '../../webview/review-scope';

/**
 * The Scope control is what Lane E's e2e locates by role+name, so the accessible names and the
 * radiogroup keyboard model are a contract, not styling (spec 2026-08-27-review-supercharge
 * §2 Lane D, §9).
 */
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(
  source: ReviewSource | undefined,
  onSetSource: (s: ReviewSource) => void,
  locked = false,
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(ReviewSourceControl, {
        source,
        repoRoot: undefined,
        locked,
        onSetSource,
        onOpenCompare: () => {},
      }),
    );
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
const trigger = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>('button.gh__reffilter.review__source');

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

  it('scope segment renders disabled buttons for a commit source', () => {
    const commit = mount({ kind: 'commit', sha: 'abc1234' }, () => {});
    const buttons = radios(commit) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.disabled).toBe(true);
    const g = group(commit);
    expect(g?.getAttribute('aria-disabled')).toBe('true');
    expect(g?.getAttribute('title')).toContain('commit');
  });

  it('scope segment renders disabled buttons for a range source', () => {
    const range = mount(
      { kind: 'range', base: { kind: 'commit', sha: 'a' }, head: { kind: 'working' } },
      () => {},
    );
    const buttons = radios(range) as HTMLButtonElement[];
    for (const b of buttons) expect(b.disabled).toBe(true);
    expect(group(range)?.getAttribute('aria-disabled')).toBe('true');
  });

  it('working source renders enabled buttons', () => {
    const el = mount({ kind: 'working' }, () => {});
    const buttons = radios(el) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.disabled).toBe(false);
    expect(group(el)?.getAttribute('aria-disabled')).toBeNull();
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

  it('locked → aria-disabled="true", title and aria-describedby text = LOCK_REASON, no menu after click', () => {
    const seen: ReviewSource[] = [];
    const el = mount({ kind: 'working' }, (s) => seen.push(s), true);
    const btn = trigger(el);
    expect(btn?.getAttribute('aria-label')).toBe('Review source');
    expect(btn?.getAttribute('aria-disabled')).toBe('true');
    expect(btn?.disabled).toBe(false);
    expect(btn?.getAttribute('title')).toBe(LOCK_REASON);
    const describedBy = btn?.getAttribute('aria-describedby') ?? '';
    const reason = describedBy ? document.getElementById(describedBy) : null;
    expect(reason?.textContent).toBe(LOCK_REASON);
    expect(reason?.className).toBe('sr-only');
    act(() => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(btn?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(seen).toEqual([]);
    expect(radios(el).every((r) => !(r as HTMLButtonElement).disabled)).toBe(true);
  });

  it('not locked → no aria-disabled', () => {
    const el = mount({ kind: 'working' }, () => {});
    const btn = trigger(el);
    expect(btn?.hasAttribute('aria-disabled')).toBe(false);
    expect(btn?.hasAttribute('aria-describedby')).toBe(false);
    expect(btn?.getAttribute('title')).toBe(reviewSourceLabel({ kind: 'working' }));
  });

  it('setScope keeps repoRoot of a working source', () => {
    const seen: ReviewSource[] = [];
    const el = mount({ kind: 'working', repoRoot: 'G:/a' }, (s) => seen.push(s));
    act(() => {
      radios(el)[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(seen).toEqual([{ kind: 'working', scope: 'staged', repoRoot: 'G:/a' }]);
  });

  it('setScope from a commit source drops to workingSource(scope)', () => {
    const seen: ReviewSource[] = [];
    const el = mount({ kind: 'commit', sha: 'abc1234', repoRoot: 'G:/a' }, (s) => seen.push(s));
    act(() => {
      radios(el)[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      group(el)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(seen).toEqual([]);

    act(() => root?.unmount());
    host?.remove();
    const fromNone: ReviewSource[] = [];
    const el2 = mount(undefined, (s) => fromNone.push(s));
    act(() => {
      radios(el2)[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(fromNone).toEqual([workingSource('unstaged')]);
  });
});

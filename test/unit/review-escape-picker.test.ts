// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RepoPickerMenu } from '../../webview/components/repo-picker-menu';
import { ReviewView } from '../../webview/components/review-view';
import { SettingsProvider } from '../../webview/settings';

/**
 * QA mf-review R2: Escape in Review's source picker closed the whole Review tab. The picker's own
 * Escape was a bare window listener outside the overlay stack, so Review's surface-level Escape
 * fired on the same keypress. Escape must close only the topmost overlay (archived spec
 * 2026-09-07-overlay-layers §2.1).
 */
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  if (!globalThis.CSS?.escape) vi.stubGlobal('CSS', { escape: (s: string) => s });
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(el: ReturnType<typeof createElement>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(el));
}

function pressEscape(target: EventTarget) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

describe('Escape in Review source picker', () => {
  it('closes the picker first, and only a second Escape closes Review', () => {
    const onClose = vi.fn();
    render(
      createElement(
        SettingsProvider,
        null,
        createElement(ReviewView, {
          reviewRepos: [],
          repoChanges: [],
          repoGit: undefined,
          fallbackRoot: '/repo',
          home: undefined,
          diffs: new Map(),
          onRequestDiff: () => {},
          onJumpToHunk: () => {},
          onClose,
          source: { kind: 'working' },
          onSetSource: () => {},
          onOpenCompare: () => {},
          paneTab: 'changes',
          explorerCollapsed: false,
          onTogglePanel: () => {},
          onShowChanges: () => {},
        }),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>('button.review__source');
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());
    const input = document.querySelector<HTMLInputElement>('.commit-picker input');
    expect(input).not.toBeNull();

    pressEscape(input as HTMLInputElement);
    expect(document.querySelector('.commit-picker')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    pressEscape(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Escape in the repo picker', () => {
  it('closes the menu without reaching the surface behind it', () => {
    const onClose = vi.fn();
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      const triggerRef = { current: null };
      render(
        createElement(RepoPickerMenu, {
          rows: [{ root: '/r', name: 'r', tag: 'home', checked: true }],
          triggerRef,
          ariaLabel: 'Repos',
          onPick: () => {},
          onClose,
        }),
      );
      const menu = document.querySelector<HTMLElement>('.repo-picker-menu, [role="menu"]');
      expect(menu).not.toBeNull();
      pressEscape(menu as HTMLElement);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });
});

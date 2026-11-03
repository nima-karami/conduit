// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeDTO } from '../../src/protocol';
import { ReviewView } from '../../webview/components/review-view';
import { setNoteTarget } from '../../webview/review-note-target';
import { reviewViewKey } from '../../webview/review-repos';
import { reviewSourceKey } from '../../webview/review-scope';
import { SettingsProvider } from '../../webview/settings';
import {
  acquireReviewListState,
  adoptReviewSource,
  mergeReviewViewState,
} from '../../webview/view-state-store';

let root: Root | null;
let host: HTMLDivElement;
let nextId = 0;
let width: number;
let cardHeight: number;
let observers: Array<{ target: Element; report: () => void }>;
const changes: ChangeDTO[] = Array.from({ length: 20 }, (_, i) => ({
  path: `f${i.toString().padStart(2, '0')}.txt`,
  added: 1,
  removed: 0,
  kind: 'M',
  staged: false,
}));
const source = { kind: 'working' } as const;

beforeEach(() => {
  width = 225;
  cardHeight = 184;
  observers = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setNoteTarget({ root: '/outside', path: 'absent.txt', line: 1, noteId: 'reset' });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      private report = () => this.callback([], this as unknown as ResizeObserver);
      observe(target: Element) {
        observers.push({ target, report: this.report });
      }
      disconnect() {
        observers = observers.filter((observer) => observer.report !== this.report);
      }
      unobserve() {}
    },
  );
  if (!globalThis.CSS?.escape) vi.stubGlobal('CSS', { escape: (s: string) => s });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => cardHeight);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount({ reveal = false } = {}) {
  const id = `review-scroll-ownership-${nextId++}`;
  adoptReviewSource(id, reviewViewKey(reviewSourceKey(source), '/repo'));
  const memory = acquireReviewListState(id);
  memory.measuredByWidth.set(225, new Map(changes.map((change) => [`/repo/${change.path}`, 200])));
  memory.measuredByWidth.set(524, new Map(changes.map((change) => [`/repo/${change.path}`, 100])));
  mergeReviewViewState(id, { anchor: { topPath: '/repo/f10.txt', offset: 8 } });
  if (reveal) {
    setNoteTarget({ root: '/repo', path: 'f15.txt', line: 1, noteId: id });
  }
  act(() => {
    root?.render(
      <SettingsProvider>
        <ReviewView
          reviewRepos={[{ root: '/repo', name: '.', folder: '/repo', tag: 'home' }]}
          repoChanges={[
            { root: '/repo', name: '.', tag: 'home', changes, lines: true, refreshedAt: 1 },
          ]}
          repoGit={undefined}
          fallbackRoot="/repo"
          home="/repo"
          diffs={new Map()}
          onRequestDiff={() => {}}
          onJumpToHunk={() => {}}
          onClose={() => {}}
          source={source}
          viewStateId={id}
          onSetSource={() => {}}
          onOpenCompare={() => {}}
          paneTab="changes"
          explorerCollapsed={false}
          onTogglePanel={() => {}}
          onShowChanges={() => {}}
        />
      </SettingsProvider>,
    );
  });
  const scroller = host.querySelector<HTMLElement>('.review__scroll');
  if (!scroller) throw new Error('Review scroller missing');
  return scroller;
}

describe('Review scroll ownership on mount', () => {
  it('keeps the saved scroll at the same width after card layout effects', () => {
    expect(mount().scrollTop).toBe(2008);
  });

  it('keeps the restored scroll when cards see the first real width before the parent', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValueOnce(0)
      .mockReturnValue(225);
    expect(mount().scrollTop).toBe(2008);
  });

  it('lets a note reveal on mount supersede the saved scroll', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValueOnce(0)
      .mockReturnValue(225);
    expect(mount({ reveal: true }).scrollTop).toBe(3000);
  });

  it('reanchors a child-first real resize and restores the exact scroll on a width round trip', () => {
    const scroller = mount();
    expect(scroller.scrollTop).toBe(2008);
    const resize = (nextWidth: number, nextCardHeight: number) => {
      width = nextWidth;
      cardHeight = nextCardHeight;
      const cardObserver = observers.find((observer) => observer.target.matches('.rcard'));
      if (!cardObserver) throw new Error('Card measurement observer missing');
      act(() => cardObserver.report());
    };
    resize(524, 84);
    expect(scroller.scrollTop).toBe(1008);
    resize(225, 184);
    expect(scroller.scrollTop).toBe(2008);
  });
});

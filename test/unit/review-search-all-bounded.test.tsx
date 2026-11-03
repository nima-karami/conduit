// @vitest-environment jsdom
import { act, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeDTO, FileDiffDTO } from '../../src/protocol';
import { ReviewView } from '../../webview/components/review-view';
import {
  getPinnedDiffs,
  pruneDiffs,
  setNewest,
  subscribePinnedDiffs,
} from '../../webview/content-cache';
import { reviewViewKey } from '../../webview/review-repos';
import { reviewSourceKey } from '../../webview/review-scope';
import { SettingsProvider } from '../../webview/settings';
import { adoptReviewSource } from '../../webview/view-state-store';

const FILES = 100;
const changes: ChangeDTO[] = Array.from({ length: FILES }, (_, i) => ({
  path: `f${i.toString().padStart(3, '0')}.txt`,
  added: 1,
  removed: 0,
  kind: 'M',
  staged: false,
}));
const source = { kind: 'working' } as const;

let root: Root | null = null;
let host: HTMLDivElement;
let requests: string[];

beforeEach(() => {
  requests = [];
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
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100);
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

const dto = (abs: string): FileDiffDTO => ({
  path: abs,
  head: 'old\n',
  work: 'new line\n',
  binary: false,
});

/** app.tsx's diff cache, cut down: replies land newest-last and the prune effect runs on every
 *  change, exactly as the real `fileDiff` handler and prune effect do. */
function Harness({ id }: { id: string }) {
  const [diffs, setDiffs] = useState<Map<string, FileDiffDTO>>(new Map());
  const pins = useSyncExternalStore(subscribePinnedDiffs, getPinnedDiffs, getPinnedDiffs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: as in app.tsx, every arrival re-prunes
  useEffect(() => {
    setDiffs((m) => pruneDiffs(m, [], pins));
  }, [diffs, pins]);
  const onRequestDiff = (abs: string) => {
    requests.push(abs);
    // A loop would otherwise spin the test forever; well past "each key once" is proof enough.
    if (requests.length > FILES * 5) return;
    setTimeout(() => setDiffs((m) => setNewest(m, abs, dto(abs))), 0);
  };
  return (
    <SettingsProvider>
      <ReviewView
        reviewRepos={[{ root: '/repo', name: '.', folder: '/repo', tag: 'home' }]}
        repoChanges={[
          { root: '/repo', name: '.', tag: 'home', changes, lines: true, refreshedAt: 1 },
        ]}
        repoGit={undefined}
        fallbackRoot="/repo"
        home="/repo"
        diffs={diffs}
        onRequestDiff={onRequestDiff}
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
    </SettingsProvider>
  );
}

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

function typeQuery(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Review "search all files" over a changeset larger than the diff cache', () => {
  it('requests each file once and completes', async () => {
    const id = 'review-search-all-bounded';
    adoptReviewSource(id, reviewViewKey(reviewSourceKey(source), '/repo'));
    act(() => root?.render(<Harness id={id} />));
    await flush();

    const scroller = host.querySelector<HTMLElement>('.review__scroll');
    if (!scroller) throw new Error('Review scroller missing');
    act(() => {
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>('.term-find__input');
    if (!input) throw new Error('find input missing');
    act(() => typeQuery(input, 'new'));
    const all = host.querySelector<HTMLButtonElement>('.review__searchall');
    if (!all) throw new Error('"Search all files" button missing');
    act(() => all.click());

    for (let i = 0; i < 200 && requests.length <= FILES * 5; i++) await flush();

    expect(requests.length).toBe(FILES);
    expect(new Set(requests).size).toBe(FILES);
    expect(host.querySelector('.review__searchall')).toBeNull();
    expect(host.querySelector('.review__searchstatus')?.textContent).not.toContain(' of ');
  });
});

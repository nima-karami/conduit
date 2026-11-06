// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePatch } from '../../src/patch-parse';
import { ReviewView } from '../../webview/components/review-view';
import type { ReviewSource } from '../../webview/docs';
import { reviewViewKey } from '../../webview/review-repos';
import { reviewSourceKey } from '../../webview/review-scope';
import { SettingsProvider } from '../../webview/settings';
import { adoptReviewSource } from '../../webview/view-state-store';

const TWO_HUNKS = `diff --git a/file.txt b/file.txt
index 111..222 100644
--- a/file.txt
+++ b/file.txt
@@ -10,2 +10,2 @@
 ten
-eleven
+changed-eleven
@@ -200,2 +200,2 @@
 two-hundred
-old
+new
`;

const EMPTY_FILES = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..e69de29
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index e69de29..0000000
`;

function patchSource(text: string, handle = 'claude-1'): ReviewSource {
  const parsed = parsePatch(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return { kind: 'patch', files: parsed.files, handle };
}

let root: Root | null;
let host: HTMLDivElement;

beforeEach(() => {
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
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200);
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

function mount(source: ReviewSource, onJumpToHunk = vi.fn(), onOpenDiff = vi.fn()) {
  const id = `review-patch-${Math.random().toString(16).slice(2)}`;
  adoptReviewSource(id, reviewViewKey(reviewSourceKey(source), ''));
  act(() => {
    root?.render(
      <SettingsProvider>
        <ReviewView
          reviewRepos={[]}
          repoChanges={[]}
          repoGit={undefined}
          fallbackRoot="/repo"
          home="/repo"
          diffs={new Map()}
          onRequestDiff={() => {}}
          onJumpToHunk={onJumpToHunk}
          onOpenDiff={onOpenDiff}
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
  return { onJumpToHunk, onOpenDiff };
}

describe('Review patch source', () => {
  it('shows the files and hunks, with original line numbers, and no disk-open controls', () => {
    const { onJumpToHunk, onOpenDiff } = mount(patchSource(TWO_HUNKS));

    expect(host.querySelector('.rcard[data-path="file.txt"]')).not.toBeNull();
    const headers = [...host.querySelectorAll('.rhunk__jump')].map((el) => el.textContent);
    expect(headers.some((t) => t?.includes('-10,') && t.includes('+10,'))).toBe(true);
    expect(headers.some((t) => t?.includes('-200,') && t.includes('+200,'))).toBe(true);

    expect(host.querySelector('.rcard__open')).toBeNull();
    expect(host.querySelector('.rcard__sbs')).toBeNull();
    expect(host.querySelector('.rcard__reviewed')).toBeNull();
    expect(host.querySelector('.rline__note')).toBeNull();
    expect(host.querySelector('.review__source .gh__reffilter-label')?.textContent).toBe(
      'Diff from claude-1',
    );

    const scroller = host.querySelector('.review__scroll');
    expect(scroller).not.toBeNull();
    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true }));
    });
    expect(onJumpToHunk).not.toHaveBeenCalled();
    expect(onOpenDiff).not.toHaveBeenCalled();
  });

  it('labels empty new and deleted files', () => {
    mount(patchSource(EMPTY_FILES));
    expect(host.querySelector('.rcard[data-path="added.txt"]')?.textContent).toContain(
      'empty file added',
    );
    expect(host.querySelector('.rcard[data-path="gone.txt"]')?.textContent).toContain(
      'empty file deleted',
    );
  });

  it('gutter of row 1 of a -200 hunk shows old line 200', () => {
    mount(patchSource(TWO_HUNKS));
    const rows = [...host.querySelectorAll('.rcard[data-path="file.txt"] .rline')];
    const row = rows.find((el) => el.textContent?.includes('two-hundred'));
    expect(row).toBeTruthy();
    const gutters = [...(row?.querySelectorAll('.rline__gutter') ?? [])].map((g) => g.textContent);
    expect(gutters[0]).toBe('200');
  });

  it('search reveal of a hunk-2 unique string lands on that row, not hunk 1', () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView() {
      scrolled.push((this as HTMLElement).closest('.rline')?.textContent ?? '');
    };
    mount(patchSource(TWO_HUNKS));
    const scroller = host.querySelector<HTMLElement>('.review__scroll');
    expect(scroller).not.toBeNull();
    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>('.term-find__input');
    expect(input).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'two-hundred');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const seqs = [...host.querySelectorAll('.rcard[data-path="file.txt"] .rline')].map((el) =>
      el.getAttribute('data-seq'),
    );
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(scrolled.some((t) => t.includes('two-hundred'))).toBe(true);
    expect(scrolled.some((t) => t.includes('ten') && !t.includes('two-hundred'))).toBe(false);
  });

  it('shows both diffs when a patch touches the same path twice', () => {
    const dup = `--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+first
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+second
`;
    mount(patchSource(dup));
    expect(host.querySelector('.rcard[data-path="a.ts"]')).not.toBeNull();
    expect(host.querySelector('.rcard[data-path="a.ts (2)"]')).not.toBeNull();
  });

  it('does not offer Ignore whitespace or LOCK_REASON for a patch source', () => {
    mount(patchSource(TWO_HUNKS));
    expect(host.textContent).not.toContain('All repos reviews the working tree');
    const more = host.querySelector<HTMLButtonElement>('.review__more');
    expect(more).not.toBeNull();
    act(() => {
      more?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const items = [...document.querySelectorAll('.ctxmenu__item')];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((el) => el.textContent?.includes('Ignore whitespace'))).toBe(false);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.ctxmenu')).toBeNull();
    const src = host.querySelector<HTMLButtonElement>('button.review__source');
    expect(src).not.toBeNull();
    act(() => {
      src?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('.commit-picker')).toBeNull();
  });
});

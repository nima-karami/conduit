// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChangesModel } from '../../src/changes-view-model';
import type { ChangeDTO } from '../../src/protocol';
import { RightPane } from '../../webview/components/right-pane';
import type { GitActionIntent } from '../../webview/git-intent';
import { publishReviewNav } from '../../webview/review-nav-store';
import { SettingsProvider } from '../../webview/settings';

/**
 * Review mode's navigator kebab acts on the session's git root even when no repo is detected
 * (the terminal cd'd into a repo outside the session's folders): Review still works there, so
 * its bulk menu must too (mf-changes code review S-4).
 */

const change: ChangeDTO = { path: 'a.txt', added: 1, removed: 0, kind: 'M', staged: false };
const cwdRepo = '/work/cwd-repo';
const noop = () => {};

let host: HTMLDivElement;
let root: Root | null = null;

async function render(changesModel: ChangesModel, onAction: (i: GitActionIntent) => void) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  publishReviewNav({
    source: { kind: 'working' },
    files: [{ ...change, repoRoot: cwdRepo }],
    groups: null,
    repoRoot: cwdRepo,
    repoCount: 1,
    totalCount: 1,
    activeKey: null,
    reviewed: new Set(),
    canMark: () => true,
    filter: '',
    onPick: noop,
    onToggleReviewed: noop,
    onFilter: noop,
  });
  await act(async () => {
    root?.render(
      createElement(
        SettingsProvider,
        null,
        createElement(RightPane, {
          sessionId: 's1',
          sections: [],
          rowChanges: new Map(),
          osDropSeam: false,
          reviewRepoChanges: [{ root: cwdRepo, name: 'cwd-repo', tag: 'home', changes: [change] }],
          changesModel,
          onOpenFile: noop,
          onOpenMatch: noop,
          setMenu: noop,
          revealPath: noop,
          openExternalApp: noop,
          openWithChooser: noop,
          openAsSession: noop,
          copyToClipboard: noop,
          onDeleteFiles: noop,
          onFileRenamed: noop,
          onReviewScope: noop,
          reviewMode: true,
          reviewTitle: 'Review changes',
          onReview: noop,
          onRefresh: noop,
          onSetView: noop,
          onOpenDiff: noop,
          onAction: async (i) => onAction(i),
          onChangeContextMenu: noop,
          onRepoHeadContextMenu: noop,
          onRepoContext: noop,
          onPickActiveRepo: noop,
          renderChip: () => null,
        }),
      ),
    );
  });
}

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
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
  publishReviewNav(null);
});

async function stageAllFromKebab(): Promise<void> {
  const tab = [...document.body.querySelectorAll<HTMLButtonElement>('.rtab')].find((b) =>
    b.textContent?.startsWith('Changes'),
  );
  await act(async () => tab?.click());
  const kebab = document.body.querySelector<HTMLButtonElement>('.rnav .changes__kebab');
  expect(kebab, 'the navigator kebab is rendered').not.toBeNull();
  await act(async () => kebab?.click());
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('.ctxmenu__item')].find(
    (b) => b.textContent?.trim() === 'Stage all',
  );
  expect(item, 'the kebab menu offers Stage all').toBeDefined();
  await act(async () => item?.click());
}

describe('review navigator kebab', () => {
  it('with no detected repo, Stage all acts on the session git root', async () => {
    const onAction = vi.fn();
    await render({ kind: 'no-repos' }, onAction);
    await stageAllFromKebab();
    expect(onAction).toHaveBeenCalledWith({ op: 'stageAll', repoRoot: '/work/cwd-repo' });
  });
});

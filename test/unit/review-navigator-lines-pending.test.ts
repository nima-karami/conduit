// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChangeDTO, RepoChanges } from '../../src/protocol';
import { ReviewNavigator } from '../../webview/components/review-navigator';
import type { ReviewNavModel } from '../../webview/review-nav-store';

/**
 * Before a working-tree repo's line counts arrive (lines:false, plan 2026-10-16-multi-repo-tracking
 * T2.7) the navigator shows the same placeholder as Changes and the Review cards, never `—` or 0.
 */

const repoRoot = '/work/repo';
const change: ChangeDTO = { path: 'a.txt', added: 0, removed: 0, kind: 'M', staged: false };
const noop = () => {};

let host: HTMLDivElement;
let root: Root | null = null;

const repo = (lines: boolean, added = 0): RepoChanges => ({
  root: repoRoot,
  name: 'repo',
  tag: 'home',
  changes: [{ ...change, added }],
  lines,
  refreshedAt: 1,
});

function model(added: number, source: ReviewNavModel['source']): ReviewNavModel {
  return {
    source,
    files: [{ ...change, added, repoRoot }],
    groups: null,
    repoRoot,
    repoCount: 1,
    totalCount: 1,
    activeKey: null,
    reviewed: new Set(),
    canMark: () => true,
    filter: '',
    onPick: noop,
    onToggleReviewed: noop,
    onFilter: noop,
  };
}

async function render(navModel: ReviewNavModel, repoChanges: RepoChanges[]) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(ReviewNavigator, {
        model: navModel,
        repoChanges,
        onAction: async () => {},
        onReviewScope: noop,
      }),
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
  // jsdom lays nothing out; the windowed list mounts rows only into a non-zero viewport.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 400,
  });
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
});

const row = () => host.querySelector('.review__navrow .review__navstat');
const header = () => host.querySelector('.changes__header .diffstat');

describe('ReviewNavigator line-count placeholder', () => {
  it('shows the placeholder in the row and header while the repo is lines:false', async () => {
    await render(model(0, { kind: 'working' }), [repo(false)]);
    expect(row(), 'the file row is mounted').not.toBeNull();
    expect(row()?.querySelector('.diffstat--pending')).not.toBeNull();
    expect(row()?.querySelector('.review__navdash')).toBeNull();
    expect(header()?.querySelector('.diffstat--pending')).not.toBeNull();
  });

  it('shows the counts once lines arrive', async () => {
    await render(model(3, { kind: 'working' }), [repo(true, 3)]);
    expect(host.querySelector('.diffstat--pending')).toBeNull();
    expect(row()?.textContent).toContain('+3');
    expect(header()?.textContent).toContain('+3');
  });

  it('a commit source never shows the placeholder', async () => {
    await render(model(0, { kind: 'commit', sha: 'abc', repoRoot }), [repo(false)]);
    expect(host.querySelector('.diffstat--pending')).toBeNull();
  });
});

describe('ReviewNavigator header total while a repo is counting (engine runtime QA2)', () => {
  it('shows the placeholder alone, not beside a partial total', async () => {
    const other = '/work/other';
    const nav: ReviewNavModel = {
      ...model(0, { kind: 'working' }),
      files: [
        { ...change, added: 0, repoRoot },
        { ...change, path: 'b.txt', added: 3, repoRoot: other },
      ],
    };
    await render(nav, [repo(false), { ...repo(true, 3), root: other, name: 'other' }]);
    expect(header()?.querySelector('.diffstat--pending')).not.toBeNull();
    expect(header()?.textContent).toBe('');
    expect(host.querySelector('.changes__header-summary')?.getAttribute('title')).not.toContain(
      '+3',
    );
  });
});

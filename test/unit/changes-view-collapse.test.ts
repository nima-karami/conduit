// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { changesModel } from '../../src/changes-view-model';
import type { ChangeDTO, WebviewToHost } from '../../src/protocol';
import type { RepoInfo } from '../../src/repo-scan';
import type { ChangesViewMode } from '../../src/settings';
import { ChangesView } from '../../webview/components/changes-view';

vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  isHosted: true,
  post: (_m: WebviewToHost) => {},
}));

const HOME = '/w/home';
const REF = '/w/ref';
const repos: RepoInfo[] = [
  { root: HOME, name: 'home', folder: HOME, tag: 'home' },
  { root: REF, name: 'ref', folder: REF, tag: 'attached' },
];
const change = (path: string): ChangeDTO => ({
  path,
  kind: 'M',
  added: 1,
  removed: 0,
  staged: false,
});
const noop = () => {};
let host: HTMLDivElement;
let root: Root | null = null;

async function render(view: ChangesViewMode) {
  const model = changesModel({
    session: { repos, roots: [REF], activeRepoRoot: HOME },
    repoChanges: repos.map((r) => ({
      root: r.root,
      name: r.name,
      tag: r.tag,
      changes: [change(`src/${r.name}.ts`)],
    })),
    view,
  });
  if (model.kind === 'no-session') throw new Error('no session');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(ChangesView, {
        model,
        reviewTitle: 'Review',
        onReview: noop,
        onRefresh: noop,
        onSetView: noop,
        onOpenDiff: noop,
        onAction: async () => {},
        onChangeContextMenu: noop,
        onRepoHeadContextMenu: noop,
        onRepoContext: noop,
        onPickActiveRepo: noop,
        renderChip: () => null,
      }),
    );
  });
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

describe('ChangesView tree metrics', () => {
  it('change rows lead with a row spacer', async () => {
    await render('all');
    const rows = [...host.querySelectorAll('.change')];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      const first = row.firstElementChild;
      expect(first?.classList.contains('treechev-spacer')).toBe(true);
      expect(first?.classList.contains('treechev-spacer--head')).toBe(false);
      expect(first?.nextElementSibling?.classList.contains('change__kind')).toBe(true);
    }
  });
});

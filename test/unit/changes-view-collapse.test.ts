// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { changesModel } from '../../src/changes-view-model';
import { folderKey } from '../../src/folder-key';
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

async function render(view: ChangesViewMode, cache: Set<string>) {
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
        collapsedRepos: cache,
        activeTarget: null,
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
    await render('all', new Set<string>());
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

const chevrons = () => [...host.querySelectorAll<HTMLButtonElement>('.repo-head__chev')];
/** The repo list rendered after a head, if any: the head's next sibling. */
const listAfter = (head: Element | null | undefined) =>
  head?.nextElementSibling?.classList.contains('repo-head__list') ? head.nextElementSibling : null;

describe('ChangesView collapse cache', () => {
  it('a collapsed repo stays collapsed across a remount with the same cache', async () => {
    const cache = new Set<string>();
    await render('all', cache);
    await act(async () => chevrons()[1].click());
    expect(chevrons()[1].getAttribute('aria-expanded')).toBe('false');
    expect(cache.has(folderKey(REF))).toBe(true);
    await act(async () => root?.unmount());
    host.remove();
    await render('all', cache);
    const [homeChev, refChev] = chevrons();
    expect(refChev.getAttribute('aria-expanded')).toBe('false');
    expect(listAfter(refChev.closest('.repo-head'))).toBeNull();
    expect(homeChev.getAttribute('aria-expanded')).toBe('true');
    expect(listAfter(homeChev.closest('.repo-head'))).not.toBeNull();
  });

  it('the cache is not consulted in the Active view', async () => {
    const cache = new Set([folderKey(HOME)]);
    await render('active', cache);
    expect(chevrons()).toHaveLength(0);
    expect(listAfter(host.querySelector('.repo-head'))).not.toBeNull();
  });
});

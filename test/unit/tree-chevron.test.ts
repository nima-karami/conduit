// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RepoHeadModel } from '../../src/changes-view-model';
import type { FolderSectionModel } from '../../src/session-sections';
import { FolderBar } from '../../webview/components/folder-bar';
import { RepoHead } from '../../webview/components/repo-head';
import { TreeChevron, TreeChevronSpacer } from '../../webview/components/tree-chevron';

let host: HTMLDivElement;
let root: Root | null = null;

async function render(el: ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(el));
  return host;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

describe('TreeChevron', () => {
  it('TreeChevron renders a 12px chevron marked open only when open', async () => {
    const open = (await render(createElement(TreeChevron, { open: true }))).querySelector('svg');
    expect(open?.classList.contains('treechev')).toBe(true);
    expect(open?.classList.contains('treechev--open')).toBe(true);
    expect(open?.getAttribute('width')).toBe('12');
    await act(async () => root?.render(createElement(TreeChevron, { open: false })));
    const shut = host.querySelector('svg');
    expect(shut?.classList.contains('treechev')).toBe(true);
    expect(shut?.classList.contains('treechev--open')).toBe(false);
    expect(shut?.getAttribute('width')).toBe('12');
  });

  it('TreeChevronSpacer is a hidden 12px slot, or the head column with size head', async () => {
    const row = (await render(createElement(TreeChevronSpacer))).firstElementChild;
    expect(row?.getAttribute('class')).toBe('treechev-spacer');
    expect(row?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => root?.render(createElement(TreeChevronSpacer, { size: 'head' })));
    const head = host.firstElementChild;
    expect(head?.getAttribute('class')).toBe('treechev-spacer treechev-spacer--head');
    expect(head?.getAttribute('aria-hidden')).toBe('true');
  });
});

const noop = () => {};
const section: FolderSectionModel = {
  path: '/w/home',
  key: '/w/home',
  kind: 'home',
  missing: false,
  name: 'home',
  label: 'home',
};
const head: RepoHeadModel = {
  repo: { root: '/w/home', name: 'home', folder: '/w/home', tag: 'home' },
  label: 'home',
  changes: [],
  staged: [],
  unstaged: [],
};
const repoHead = (view: 'all' | 'active', collapsed: boolean) =>
  createElement(RepoHead, {
    head,
    view,
    tag: 'home',
    collapsed,
    onToggle: noop,
    chip: null,
    onActivate: noop,
    onContextMenu: noop,
  });

describe('tree headers', () => {
  it('FolderBar leads with the collapse button', async () => {
    await render(
      createElement(FolderBar, {
        section,
        collapsed: false,
        treeId: 't',
        createTarget: section.path,
        collapseRef: null,
        onToggle: noop,
        onRefresh: noop,
        onNewFile: noop,
        onNewFolder: noop,
        onMenu: noop,
      }),
    );
    const bar = host.querySelector('.files__bar');
    expect(bar?.classList.contains('treehead')).toBe(true);
    const first = bar?.firstElementChild;
    expect(first?.matches('button.files__collapse')).toBe(true);
    expect(first?.getAttribute('aria-expanded')).toBe('true');
    const chev = first?.querySelector('svg.treechev');
    expect(chev?.classList.contains('treechev--open')).toBe(true);
    const tag = bar?.querySelector('.repo-head__tag.repo-head__tag--home');
    expect(tag?.textContent).toBe('Home');
  });

  it('RepoHead leads with the chevron in All and a head spacer in Active', async () => {
    await render(repoHead('all', true));
    let el = host.querySelector('.repo-head');
    expect(el?.classList.contains('treehead')).toBe(true);
    const first = el?.firstElementChild;
    expect(first?.matches('button.repo-head__chev')).toBe(true);
    const chev = first?.querySelector('svg.treechev');
    expect(chev).not.toBeNull();
    expect(chev?.classList.contains('treechev--open')).toBe(false);
    await act(async () => root?.render(repoHead('active', false)));
    el = host.querySelector('.repo-head');
    expect(el?.classList.contains('treehead')).toBe(true);
    expect(el?.firstElementChild?.matches('span.treechev-spacer--head')).toBe(true);
    expect(el?.querySelector('.repo-head__chev')).toBeNull();
  });
});

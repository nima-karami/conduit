// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommitNode, HostToWebview, WebviewToHost } from '../../src/protocol';
import { BranchSwitcherList } from '../../webview/components/branch-switcher-menu';
import { CommitPickerMenu } from '../../webview/components/commit-picker-menu';
import { type RepoMenuRow, RepoPickerMenu } from '../../webview/components/repo-picker-menu';

const bus = vi.hoisted(() => ({
  posted: [] as unknown[],
  listeners: new Set<(msg: unknown) => void>(),
}));

vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  post: (m: WebviewToHost) => {
    bus.posted.push(m);
  },
  subscribe: (cb: (msg: HostToWebview) => void) => {
    const l = cb as (msg: unknown) => void;
    bus.listeners.add(l);
    return () => bus.listeners.delete(l);
  },
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};
});

let root: Root | null = null;

async function mount(el: React.ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(el));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  bus.posted.length = 0;
  bus.listeners.clear();
  document.body.innerHTML = '';
});

const emit = (msg: HostToWebview) =>
  act(async () => {
    for (const l of [...bus.listeners]) l(msg);
  });

const rows = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));
const rowByText = (sel: string, text: string) =>
  rows(sel).find((el) => el.textContent?.includes(text)) as HTMLElement;
const activeText = () => document.querySelector('.ctxmenu__item--active')?.textContent ?? null;

/** What a real move onto a row sends it. */
const pointerMove = (el: Element, x: number, y: number) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
  });

/** A row landing under a stationary pointer gets boundary events and possibly a same-point
 *  pointermove; neither is a choice. */
const slidUnder = (el: Element, x: number, y: number) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
  });

/** React tracks a controlled input's value; set it through the native setter so onChange fires. */
const typeInto = (input: HTMLInputElement, value: string) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const pressEnter = (target: Element) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });

describe('BranchSwitcherList under a resting pointer (review r2)', () => {
  const ROW = '.git-branch-menu__row';

  it('a filter keystroke under a resting pointer keeps the top match active, and Enter takes it', async () => {
    const onSelect = vi.fn();
    await mount(
      createElement(BranchSwitcherList, {
        sessionId: 's',
        repoRoot: '/r',
        switchable: true,
        switching: false,
        onSelect,
        onArrowUpFromFilter: () => {},
      }),
    );
    await emit({
      type: 'git:refsResult',
      sessionId: 's',
      repoRoot: '/r',
      branches: ['main', 'feat-a', 'feat-b', 'fix-a'],
      current: 'main',
      remotes: [],
      tags: [],
    });
    await pointerMove(rowByText(ROW, 'fix-a'), 40, 90);
    await pointerMove(rowByText(ROW, 'fix-a'), 41, 90);
    expect(activeText()).toContain('fix-a');

    const input = document.querySelector('.git-branch-menu__filter') as HTMLInputElement;
    await typeInto(input, 'feat');
    await slidUnder(rowByText(ROW, 'feat-b'), 41, 90);
    expect(activeText()).toContain('feat-a');
    expect(document.querySelector('.git-branch-menu')?.getAttribute('data-pointer')).toBe(
      'resting',
    );
    await pressEnter(input);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('feat-a');
  });
});

describe('CommitPickerMenu under a resting pointer (review r2)', () => {
  const ROW = '.commit-picker__row';
  const commit = (sha: string, subject: string): CommitNode => ({
    sha,
    parents: [],
    refs: [],
    author: 'a',
    date: 0,
    subject,
  });

  it('a filter keystroke under a resting pointer keeps row 0 active, and Enter takes it', async () => {
    const onSelect = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    await mount(
      createElement(CommitPickerMenu, {
        sessionId: 's',
        repoRoot: '/r',
        triggerRef,
        onSelect,
        onClose: () => {},
        onOpenCompare: () => {},
      }),
    );
    await emit({
      type: 'git:historyResult',
      sessionId: 's',
      repoRoot: '/r',
      commits: [
        commit('a'.repeat(40), 'fix parser'),
        commit('b'.repeat(40), 'add lexer'),
        commit('c'.repeat(40), 'fix lexer'),
      ],
      layout: { rows: [], edges: [], laneCount: 0 },
      hasMore: false,
      state: 'ok',
    });
    await pointerMove(rowByText(ROW, 'fix lexer'), 40, 90);
    await pointerMove(rowByText(ROW, 'fix lexer'), 41, 90);
    expect(activeText()).toContain('fix lexer');

    const input = document.querySelector('.git-branch-menu__filter') as HTMLInputElement;
    await typeInto(input, 'lexer');
    await slidUnder(rowByText(ROW, 'add lexer'), 41, 90);
    const top = rows(ROW)[0]?.textContent;
    expect(activeText()).toBe(top);
    expect(document.querySelector('.commit-picker')?.getAttribute('data-pointer')).toBe('resting');
    await pressEnter(input);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toMatchObject({ kind: 'working' });
  });
});

describe('RepoPickerMenu under a resting pointer (review r2)', () => {
  const ROW = '.repo-picker-menu__row';
  const repoRows = (roots: string[], checked: string): RepoMenuRow[] =>
    roots.map((root) => ({
      root,
      name: root.slice(1),
      tag: 'nested',
      checked: root === checked,
    }));

  async function open(list: RepoMenuRow[], onPick: (root: string | null) => void) {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const triggerRef = { current: trigger };
    const el = (r: RepoMenuRow[]) =>
      createElement(RepoPickerMenu, {
        rows: r,
        triggerRef,
        ariaLabel: 'Repo',
        onPick,
        onClose: () => {},
      });
    await mount(el(list));
    return (next: RepoMenuRow[]) => act(async () => root?.render(el(next)));
  }

  it('a menu opened under a resting pointer keeps the checked repo active, and Enter takes it', async () => {
    const onPick = vi.fn();
    await open(repoRows(['/one', '/two', '/three'], '/two'), onPick);
    await slidUnder(rowByText(ROW, 'three'), 40, 90);
    await slidUnder(rowByText(ROW, 'three'), 40, 90);
    expect(activeText()).toContain('two');
    await pressEnter(document.querySelector('.repo-picker-menu') as HTMLElement);
    expect(onPick).toHaveBeenCalledExactlyOnceWith('/two');
  });

  it('re-listed repos restart the gate; the same repos in a fresh array do not', async () => {
    const onPick = vi.fn();
    const rerender = await open(repoRows(['/one', '/two', '/three'], '/two'), onPick);
    await pointerMove(rowByText(ROW, 'three'), 40, 90);
    await pointerMove(rowByText(ROW, 'three'), 41, 90);
    const frame = () => document.querySelector('.repo-picker-menu') as HTMLElement;
    expect(frame().dataset.pointer).toBe('armed');
    await rerender(repoRows(['/one', '/two', '/three'], '/two'));
    expect(frame().dataset.pointer).toBe('armed');
    await rerender(repoRows(['/zero', '/one', '/two', '/three'], '/two'));
    expect(frame().dataset.pointer).toBe('resting');
    await slidUnder(rowByText(ROW, 'zero'), 41, 90);
    expect(activeText()).toContain('two');
  });
});

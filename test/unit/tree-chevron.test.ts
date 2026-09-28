// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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

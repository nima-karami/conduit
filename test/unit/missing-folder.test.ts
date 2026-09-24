// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FolderSectionModel } from '../../src/session-sections';
import { MissingFolder } from '../../webview/components/missing-folder';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

async function render(path: string) {
  const section: FolderSectionModel = {
    path,
    key: path,
    kind: 'home',
    missing: true,
    name: 'H2',
    label: 'H2',
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(createElement(MissingFolder, { section, onLocate: () => {} })),
  );
}

describe('MissingFolder path (mf-live-edits QA F6 spillover)', () => {
  it('a /-separated windows folder is shown with native separators', async () => {
    await render('C:/Users/u/H2');
    const code = host.querySelector('.files-missing__path');
    expect(code?.textContent).toBe('C:\\Users\\u\\H2');
    expect(code?.getAttribute('title')).toBe('C:\\Users\\u\\H2');
  });

  it('a posix folder is shown as stored', async () => {
    await render('/home/u/h');
    expect(host.querySelector('.files-missing__path')?.textContent).toBe('/home/u/h');
  });
});

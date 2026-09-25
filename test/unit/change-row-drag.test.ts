// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { changesModel } from '../../src/changes-view-model';
import type { ChangeDTO, WebviewToHost } from '../../src/protocol';
import type { RepoInfo } from '../../src/repo-scan';
import { ChangesView } from '../../webview/components/changes-view';

const posted = vi.hoisted((): WebviewToHost[] => []);
vi.mock('../../webview/bridge', async (orig) => ({
  ...(await orig<typeof import('../../webview/bridge')>()),
  isHosted: true,
  post: (m: WebviewToHost) => posted.push(m),
}));

const HOME = '/w/home';
const home: RepoInfo = { root: HOME, name: 'home', folder: HOME, tag: 'home' };
const change = (path: string, kind: ChangeDTO['kind']): ChangeDTO => ({
  path,
  kind,
  added: 1,
  removed: 0,
  staged: false,
});
const noop = () => {};
let host: HTMLDivElement;
let root: Root | null = null;

async function render() {
  const model = changesModel({
    session: { repos: [home], roots: [], activeRepoRoot: HOME },
    repoChanges: [
      {
        root: HOME,
        name: 'home',
        tag: 'home',
        changes: [change('src/a.txt', 'M'), change('gone.txt', 'D')],
      },
    ],
    view: 'active',
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

function rowFor(file: string): HTMLElement {
  const el = [...host.querySelectorAll<HTMLElement>('.change')].find(
    (r) => r.querySelector('.change__file')?.textContent === file,
  );
  if (!el) throw new Error(`no row for ${file}`);
  return el;
}

function dragStart(el: HTMLElement) {
  const data = new Map<string, string>();
  const dt = { effectAllowed: 'uninitialized', setData: (t: string, v: string) => data.set(t, v) };
  const ev = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  el.dispatchEvent(ev);
  return { data, dt };
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  posted.length = 0;
});

describe('Changes row drag', () => {
  it('a present file drags out and to the terminal with its absolute path', async () => {
    await render();
    const row = rowFor('a.txt');
    expect(row.draggable).toBe(true);
    let r: ReturnType<typeof dragStart> | undefined;
    await act(async () => {
      r = dragStart(row);
    });
    const abs = `${HOME}/src/a.txt`;
    expect(r?.data.get('DownloadURL')).toBe(
      'application/octet-stream:a.txt:file:///w/home/src/a.txt',
    );
    expect(r?.data.get('application/x-conduit-path')).toBe(abs);
    expect(r?.dt.effectAllowed).toBe('copy');
    expect(posted).toEqual([{ type: 'fs:armDragDownload', path: abs }]);
  });

  it('a deleted file is not draggable', async () => {
    await render();
    expect(rowFor('gone.txt').draggable).toBe(false);
  });
});

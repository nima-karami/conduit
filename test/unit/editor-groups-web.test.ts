// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorGroups } from '../../webview/components/editor-groups';
import type { CenterLayout, GroupIndex } from '../../webview/doc-groups';
import type { OpenDoc } from '../../webview/docs';

const web: OpenDoc = {
  id: 'web:https://x.test/',
  kind: 'web',
  path: 'https://x.test/',
  title: 'x',
  sessionId: 'S',
};
const layout = (): CenterLayout => ({
  groups: [
    { group: 1, docs: [], activeDocId: null, previewIds: new Set() },
    { group: 2, docs: [web], activeDocId: web.id, previewIds: new Set() },
  ],
  activeGroup: 1,
  webDocs: [web],
});

let host: HTMLDivElement;
let root: Root | null = null;
const onFocusGroup = vi.fn<(g: GroupIndex) => void>();
const guestFocus: unknown[] = [];

const render = () =>
  act(async () => {
    root?.render(
      createElement(EditorGroups, {
        layout: layout(),
        ratio: 0.5,
        onRatioCommit: () => {},
        renderGroup: () => null,
        webDocs: [web],
        webPlacement: () => ({ group: 2 as GroupIndex, visible: true }),
        renderWeb: (_doc: OpenDoc, onGuestFocus: () => void) => {
          guestFocus.push(onGuestFocus);
          return null;
        },
        onFocusGroup,
        onMoveTab: () => {},
      }),
    );
  });

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  onFocusGroup.mockReset();
  guestFocus.length = 0;
});

describe('EditorGroups web hosts', () => {
  it('a pointerdown on a web host focuses its group', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await render();
    const webhost = host.querySelector('.webhost');
    await act(async () => {
      webhost?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(onFocusGroup).toHaveBeenCalledWith(2);
  });

  it('hands each web view a guest-focus callback that is stable across renders and focuses its group', async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await render();
    await render();
    expect(guestFocus).toHaveLength(2);
    expect(typeof guestFocus[0]).toBe('function');
    expect(guestFocus[1]).toBe(guestFocus[0]);
    (guestFocus[0] as () => void)();
    expect(onFocusGroup).toHaveBeenCalledWith(2);
  });
});

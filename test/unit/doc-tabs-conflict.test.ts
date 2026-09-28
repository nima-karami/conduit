// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DocTabs } from '../../webview/components/doc-tabs';
import type { OpenDoc } from '../../webview/docs';
import type { FileSaveStatus } from '../../webview/file-save-controller';

const docs: OpenDoc[] = [
  { id: 'file:/a.ts', kind: 'file', path: '/a.ts', title: 'a.ts', sessionId: 'S' },
  { id: 'file:/b.ts', kind: 'file', path: '/b.ts', title: 'b.ts', sessionId: 'S' },
];
const LABEL = 'Changed on disk — auto-save paused';
const conflict: FileSaveStatus = {
  phase: 'conflict',
  edited: true,
  conflict: 'changed',
  error: 'x',
};
const dirty: FileSaveStatus = { phase: 'dirty', edited: true, conflict: null, error: null };

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
  if (!globalThis.CSS?.escape) vi.stubGlobal('CSS', { escape: (s: string) => s });
  Element.prototype.scrollIntoView = () => {};
  // An overflowing strip, so the open-editors chevron renders.
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('tabbar') ? 600 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('tabbar') ? 300 : 0;
    },
  });
});

let root: Root | null = null;
let host: HTMLDivElement;

async function render(saveStatuses: ReadonlyMap<string, FileSaveStatus>) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      createElement(DocTabs, {
        docs,
        activeId: null,
        terminalLabel: 'Terminal',
        terminalIcon: { kind: 'terminal' } as never,
        onSelect: () => {},
        onClose: () => {},
        saveStatuses,
      }),
    ),
  );
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
});

const tabEl = (id: string) => host.querySelector(`[data-tabid="${id}"]`) as HTMLElement;

describe('DocTabs conflict marker', () => {
  it('marks only the conflicted tab, in the strip', async () => {
    await render(
      new Map([
        ['/a.ts', dirty],
        ['/b.ts', conflict],
      ]),
    );
    const marker = tabEl('file:/b.ts').querySelector('.tab__conflict');
    expect(marker?.getAttribute('aria-label')).toBe(LABEL);
    expect(marker?.getAttribute('title')).toBe(LABEL);
    expect(tabEl('file:/a.ts').querySelector('.tab__conflict')).toBeNull();
  });

  it('marks the conflicted file in the open-editors list', async () => {
    await render(new Map([['/b.ts', conflict]]));
    const chevron = host.querySelector('.tabbar__overflow-btn') as HTMLButtonElement;
    await act(async () => chevron.click());
    const markers = document.querySelectorAll('.ctxmenu .tab__conflict--inline');
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute('aria-label')).toBe(LABEL);
  });

  it('shows no marker without a conflict', async () => {
    await render(new Map([['/b.ts', dirty]]));
    expect(host.querySelector('.tab__conflict')).toBeNull();
  });
});

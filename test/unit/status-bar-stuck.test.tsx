// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AttentionEntry } from '../../src/attention';
import type { StatusBarModel } from '../../src/status-bar-model';
import { CHROME_STR } from '../../webview/chrome-strings';
import { StatusBar } from '../../webview/components/status-bar';
import {
  type WorkbenchChromeContextValue,
  WorkbenchChromeProvider,
} from '../../webview/workbench-chrome-state';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const noop = () => {};

function chrome(first: AttentionEntry | null): WorkbenchChromeContextValue {
  const status: StatusBarModel = {
    branch: null,
    worktree: null,
    liveCount: 1,
    attentionCount: first ? 1 : 0,
    firstAttention: first,
    showCommandHint: false,
  };
  return {
    rightOpen: false,
    rightTab: 'files',
    togglePanel: noop,
    openPanel: noop,
    status,
    commandHint: '',
    focusAttention: noop,
    update: {
      status: null,
      dismissed: false,
      dismiss: noop,
      reveal: noop,
      openNotes: noop,
    },
  };
}

function render(value: WorkbenchChromeContextValue): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <WorkbenchChromeProvider value={value}>
        <StatusBar />
      </WorkbenchChromeProvider>,
    );
  });
  return host;
}

const session = (detail?: string): AttentionEntry => ({
  key: 'session:s3',
  kind: 'session',
  sessionId: 's3',
  threadId: null,
  reason: null,
  handle: null,
  ...(detail === undefined ? {} : { detail }),
});

describe('StatusBar needs-you button', () => {
  it('titles a stuck session with its reason', () => {
    const host = render(chrome(session('Codex is asking whether to update')));
    const button = host.querySelector('[data-status-item="attention"]');
    expect(button?.getAttribute('title')).toBe('Codex is asking whether to update');
    expect(button?.textContent).toContain(CHROME_STR.needYou(1));
  });

  it('keeps the plain count title when the session has no reason text', () => {
    const host = render(chrome(session()));
    const button = host.querySelector('[data-status-item="attention"]');
    expect(button?.getAttribute('title')).toBe(CHROME_STR.needYou(1));
  });
});

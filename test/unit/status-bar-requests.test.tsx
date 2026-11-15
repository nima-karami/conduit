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
    waitingUntil: null,
  };
  return {
    rightOpen: false,
    rightTab: 'files',
    togglePanel: noop,
    openPanel: noop,
    status,
    commandHint: '',
    presence: null,
    setAway: () => {},
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

const request: AttentionEntry = {
  key: 'request:r1',
  kind: 'request',
  sessionId: 's1',
  threadId: null,
  reason: null,
  handle: null,
  requestId: 'r1',
};

describe('StatusBar — requests', () => {
  it('adds the waiting countdown while a call waits on a request', () => {
    const base = chrome(request);
    const until = new Date(Date.now() + 58_000).toISOString();
    const host = render({ ...base, status: { ...base.status, waitingUntil: until } });
    const attn = host.querySelector('[data-status-item="attention"]');
    expect(attn?.textContent).toMatch(/0:5[78] waiting/);
  });

  it('opens the Away menu, and choosing Until I am back sets away with no end', () => {
    const calls: Array<[boolean, string | null]> = [];
    const host = render({
      ...chrome(null),
      presence: { state: 'here', since: new Date().toISOString(), until: null, lastAway: null },
      setAway: (away, until) => calls.push([away, until]),
    });
    const away = host.querySelector<HTMLButtonElement>('[data-status-item="away"]');
    expect(away?.textContent).toBe(CHROME_STR.away);
    act(() => away?.click());
    const items = [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const back = items.find((i) => i.textContent?.includes("Until I'm back"));
    act(() => back?.click());
    expect(calls).toEqual([[true, null]]);
  });

  it('shows the Away end time while away', () => {
    const until = new Date(2026, 10, 15, 9, 0).toISOString();
    const host = render({
      ...chrome(null),
      presence: { state: 'away', since: new Date().toISOString(), until, lastAway: null },
    });
    expect(host.querySelector('[data-status-item="away"]')?.textContent).toBe('Away until 09:00');
  });
});

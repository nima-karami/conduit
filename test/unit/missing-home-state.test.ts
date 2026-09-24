// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types';

const replies: Array<(m: unknown) => void> = [];
const sent: Array<{ type: string; [k: string]: unknown }> = [];
vi.mock('../../webview/host-request', () => ({
  requestHost: vi.fn((send: (id: number) => { type: string }) => {
    sent.push(send(3));
    return new Promise((resolve) => replies.push(resolve));
  }),
}));
vi.mock('../../webview/toast-store', () => ({ pushToast: vi.fn() }));
vi.mock('../../webview/bridge', () => ({ post: vi.fn() }));

import { MissingHomeState } from '../../webview/components/missing-home-state';
import { pushToast } from '../../webview/toast-store';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement;

function session(o: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 's',
    agentId: 'claude',
    home: 'C:\\src\\room-message-bus',
    homeMissing: true,
    roots: [],
    status: 'stale',
    createdAt: 0,
    lastActiveAt: 0,
    ...o,
  };
}

async function render(s: Session, onFixed = vi.fn()) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(MissingHomeState, { session: s, onFixed })));
  return onFixed;
}

const buttons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button'));
const byText = (t: string) => buttons().find((b) => b.textContent === t);
const click = async (b: HTMLButtonElement | undefined) => {
  await act(async () => b?.click());
};
const answer = async (m: Record<string, unknown>) => {
  await act(async () => {
    replies.shift()?.({ requestId: 3, ...m });
  });
};

beforeEach(() => {
  replies.length = 0;
  sent.length = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('MissingHomeState (12d)', () => {
  it('title, full path, Locate…', async () => {
    await render(session());
    expect(host.querySelector('h2.stale__title')?.textContent).toBe('Home folder not found');
    const path = host.querySelector('.stale__path');
    expect(path?.textContent).toBe('C:\\src\\room-message-bus');
    expect(path?.getAttribute('dir')).toBe('ltr');
    expect(byText('Locate…')?.className).toBe('btn btn--primary');
    expect(buttons()).toHaveLength(1);
    expect(document.activeElement).toBe(document.body);
  });

  it('Use {first present root} as home shown only with a present root', async () => {
    await render(session({ roots: ['D:\\w\\bitbucket-ci-image', 'D:\\w\\other'] }));
    const use = byText('Use bitbucket-ci-image as home');
    expect(use?.title).toBe('D:\\w\\bitbucket-ci-image');
    expect(use?.getAttribute('aria-label')).toBe('Use bitbucket-ci-image as home');
    expect(use?.querySelector('.stale__usehome-name')?.textContent).toBe('bitbucket-ci-image');
  });

  it('missing attached roots are not candidates', async () => {
    await render(
      session({ roots: ['D:\\w\\gone', 'D:\\w\\here'], missingRoots: ['D:\\w\\gone'] }),
    );
    expect(byText('Use here as home')).toBeDefined();
    await act(async () => root?.unmount());
    root = null;
    await render(session({ roots: ['D:\\w\\gone'], missingRoots: ['D:\\w\\gone'] }));
    expect(buttons()).toHaveLength(1);
  });

  it('Locate sends mf-files session:locateFolder for the home; buttons disabled while pending', async () => {
    await render(session({ roots: ['D:\\w\\e'] }));
    await click(byText('Locate…'));
    expect(sent).toEqual([
      {
        type: 'session:locateFolder',
        sessionId: 's1',
        path: 'C:\\src\\room-message-bus',
        requestId: 3,
      },
    ]);
    expect(buttons().every((b) => b.disabled)).toBe(true);
    await answer({ type: 'session:locateResult', ok: false, reason: 'cancelled' });
    expect(buttons().every((b) => !b.disabled)).toBe(true);
    expect(pushToast).not.toHaveBeenCalled();
  });

  it('Locate success calls onFixed', async () => {
    const onFixed = await render(session());
    await click(byText('Locate…'));
    await answer({ type: 'session:locateResult', ok: true, path: 'P:\\new' });
    expect(onFixed).toHaveBeenCalledTimes(1);
  });

  it('setHome failure toasts, success calls onFixed', async () => {
    const onFixed = await render(session({ roots: ['D:\\w\\e'] }));
    await click(byText('Use e as home'));
    expect(sent).toEqual([
      { type: 'session:setHome', sessionId: 's1', path: 'D:\\w\\e', requestId: 3 },
    ]);
    await answer({ type: 'session:opResult', ok: false, reason: 'invalid-path' });
    expect(pushToast).toHaveBeenCalledWith({
      message: "Couldn't make e the home folder",
      variant: 'error',
    });
    expect(onFixed).not.toHaveBeenCalled();
    await click(byText('Use e as home'));
    await answer({ type: 'session:opResult', ok: true });
    expect(onFixed).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Toasts } from '../../webview/components/toasts';
import { type UpdateStatus, updateCardVisible } from '../../webview/components/update-card';
import { __resetToastsForTest, pushToast } from '../../webview/toast-store';
import {
  type WorkbenchChromeContextValue,
  WorkbenchChromeProvider,
} from '../../webview/workbench-chrome-state';

const post = vi.hoisted(() => vi.fn());
vi.mock('../../webview/bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../webview/bridge')>()),
  post,
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  __resetToastsForTest();
  post.mockReset();
});

const noop = () => {};
function chrome(update: WorkbenchChromeContextValue['update']): WorkbenchChromeContextValue {
  return {
    rightOpen: false,
    rightTab: 'files',
    togglePanel: noop,
    openPanel: noop,
    status: {
      branch: null,
      worktree: null,
      liveCount: 0,
      attentionCount: 0,
      firstAttention: null,
      showCommandHint: false,
    },
    commandHint: '',
    focusAttention: noop,
    update,
  };
}

const st = (status: UpdateStatus['status'], extra: Partial<UpdateStatus> = {}): UpdateStatus => ({
  type: 'updateStatus',
  status,
  version: '1.2.3',
  ...extra,
});

function render(
  status: UpdateStatus | null,
  dismissed = false,
  dismiss: () => void = noop,
  dock?: React.ReactNode,
): void {
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  const r = root;
  act(() =>
    r.render(
      <WorkbenchChromeProvider value={chrome({ status, dismissed, dismiss })}>
        <Toasts>{dock}</Toasts>
      </WorkbenchChromeProvider>,
    ),
  );
}

const stack = () => document.querySelector<HTMLElement>('.toasts[data-toast-stack]');
const card = () => document.querySelector<HTMLElement>('.update-card[data-update-toast]');

describe('floating update item (sidebar-agent-tree spec §7, plan T3.4)', () => {
  it('mounts the one outlet even with an empty toast store, as a labelled region', () => {
    render(null);
    expect(stack()?.getAttribute('role')).toBe('region');
    expect(stack()?.getAttribute('aria-label')).toBe('Notifications');
    expect(stack()?.parentElement).toBe(document.body);
    expect(card()).toBeNull();
  });

  it('available: the updating label, Dismiss, no progress and no relaunch', () => {
    render(st('available'));
    expect(card()?.dataset.updateState).toBe('available');
    expect(card()?.querySelector('[role="status"]')?.textContent).toBe('Updating to v1.2.3…');
    expect(card()?.querySelector('[role="progressbar"]')).toBeNull();
    expect(card()?.querySelector('.update-card__action')).toBeNull();
  });

  it('downloading: a clamped, rounded percent and an accessible progressbar', () => {
    render(st('downloading', { percent: 41.6 }));
    const bar = card()?.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-label')).toBe('Update download');
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar?.getAttribute('aria-valuemax')).toBe('100');
    expect(bar?.getAttribute('aria-valuenow')).toBe('42');
    expect(card()?.querySelector('.update-card__percent')?.textContent).toMatch(/42/);
    render(st('downloading', { percent: 180 }));
    expect(card()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '100',
    );
    render(st('downloading'));
    expect(card()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
  });

  it('the percent stays outside the live text, so a tick does not re-announce', () => {
    render(st('downloading', { percent: 10 }));
    const live = card()?.querySelector('[role="status"]');
    expect(live?.textContent).not.toMatch(/10/);
  });

  it('ready: the ready label and Relaunch to update posting the existing message', () => {
    render(st('ready'));
    expect(card()?.dataset.updateState).toBe('ready');
    expect(card()?.querySelector('[role="status"]')?.textContent).toBe('v1.2.3 ready');
    const relaunch = card()?.querySelector<HTMLButtonElement>('.update-card__action');
    expect(relaunch?.textContent).toBe('Relaunch to update');
    act(() => relaunch?.click());
    expect(post).toHaveBeenCalledWith({ type: 'updateRelaunch' });
  });

  it('updates one keyed item in place across available, downloading and ready', () => {
    render(st('available'));
    const first = card();
    render(st('downloading', { percent: 5 }));
    render(st('downloading', { percent: 60 }));
    render(st('ready'));
    expect(card()).toBe(first);
    expect(document.querySelectorAll('.update-card')).toHaveLength(1);
  });

  it('Dismiss calls the App dismissal; dismissed hides it until App resets it on ready', () => {
    const dismiss = vi.fn();
    render(st('downloading', { percent: 5 }), false, dismiss);
    const btn = card()?.querySelector<HTMLButtonElement>('.update-card__dismiss');
    expect(btn?.getAttribute('aria-label')).toBe('Dismiss update');
    act(() => btn?.click());
    expect(dismiss).toHaveBeenCalledTimes(1);
    render(st('downloading', { percent: 5 }), true, dismiss);
    expect(card()).toBeNull();
    render(st('ready'), false, dismiss);
    expect(card()?.dataset.updateState).toBe('ready');
  });

  it('checking, up to date and error raise no card', () => {
    for (const s of ['checking', 'up-to-date', 'error'] as const) {
      render(st(s));
      expect(card()).toBeNull();
      expect(updateCardVisible(st(s), false)).toBe(false);
    }
  });

  it('shares the stack with a generic toast and docked cards; the update sits last', () => {
    render(st('available'), false, noop, <section className="askcard">ask</section>);
    act(() => {
      pushToast({ message: 'Saved elsewhere', variant: 'info' });
    });
    const kids = [...(stack()?.children ?? [])].map((c) => c.className.split(' ')[0]);
    expect(kids).toEqual(['askcard', 'toast', 'update-card']);
    expect(document.querySelectorAll('.toasts')).toHaveLength(1);
  });

  it('offers only Dismiss and Relaunch — no release-notes link', () => {
    render(st('ready', { releaseNotes: 'notes' }));
    expect(card()?.querySelectorAll('a')).toHaveLength(0);
    const labels = [...(card()?.querySelectorAll('button') ?? [])].map(
      (b) => b.getAttribute('aria-label') ?? b.textContent,
    );
    expect(labels).toEqual(['Dismiss update', 'Relaunch to update']);
  });
});

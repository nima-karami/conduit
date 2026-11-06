// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type QuitReason, quitConfirmState } from '../../src/quit-guard';
import { ConfirmDialog } from '../../webview/components/confirm-dialog';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  document.body.innerHTML = '';
});

async function renderQuitConfirm(
  reason: QuitReason,
  running = 2,
  busy = 1,
): Promise<{ resolve: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> }> {
  const resolve = vi.fn();
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const state = quitConfirmState({ reason, running, busy, resolve, onShown: vi.fn() });
  await act(async () => {
    root?.render(createElement(ConfirmDialog, { state, onClose }));
  });
  return { resolve, onClose };
}

describe('quitConfirmState', () => {
  it('sets hideCancel, showClose, and focusClose; never focusCancel', () => {
    const resolve = vi.fn();
    const state = quitConfirmState({ reason: 'quit', running: 2, busy: 1, resolve });
    expect(state.hideCancel).toBe(true);
    expect(state.showClose).toBe(true);
    expect(state.focusClose).toBe(true);
    expect('focusCancel' in state && state.focusCancel).toBeFalsy();
  });

  it('adds Quit and stop all agents only for quit and update', () => {
    const resolve = vi.fn();
    expect(quitConfirmState({ reason: 'quit', running: 2, busy: 0, resolve }).secondaryLabel).toBe(
      'Quit and stop all agents',
    );
    expect(
      quitConfirmState({ reason: 'update', running: 2, busy: 0, resolve }).secondaryLabel,
    ).toBe('Quit and stop all agents');
    expect(
      quitConfirmState({ reason: 'windowClose', running: 2, busy: 0, resolve }).secondaryLabel,
    ).toBeUndefined();
    expect(
      quitConfirmState({ reason: 'quitAndStop', running: 2, busy: 0, resolve }).secondaryLabel,
    ).toBeUndefined();
  });

  it('activating the focused close control resolves false', async () => {
    const { resolve } = await renderQuitConfirm('quit');
    const close = document.querySelector<HTMLButtonElement>('.iconbtn[aria-label="Close"]');
    if (!close) throw new Error('close button missing');
    expect(document.activeElement).toBe(close);
    await act(async () => {
      close.click();
    });
    expect(resolve).toHaveBeenCalledWith(false);
  });

  it('Escape resolves false', async () => {
    const { resolve } = await renderQuitConfirm('update');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(resolve).toHaveBeenCalledWith(false);
  });
});

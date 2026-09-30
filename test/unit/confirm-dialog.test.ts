// @vitest-environment jsdom
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, type ConfirmState } from '../../webview/components/confirm-dialog';
import { useFocusTrap } from '../../webview/use-focus-trap';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let opener: HTMLButtonElement;
let root: Root | null = null;

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
  opener?.remove();
});

async function open(overrides: Partial<ConfirmState> = {}, onClose = vi.fn()) {
  opener = document.createElement('button');
  opener.textContent = 'opener';
  document.body.append(opener);
  opener.focus();
  host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  const state: ConfirmState = {
    title: 'Close session?',
    message: 'It is still running.',
    confirmLabel: 'Close',
    onConfirm: vi.fn(),
    ...overrides,
  };
  await act(async () => {
    r.render(createElement(ConfirmDialog, { state, onClose }));
  });
  const dialog = document.body.querySelector<HTMLElement>('.confirm');
  if (!dialog) throw new Error('dialog not rendered');
  const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
  return { state, onClose, dialog, buttons };
}

async function unmount() {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
}

function click(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function tab(el: Element, shiftKey = false) {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

describe('ConfirmDialog', () => {
  it('Enter with secondary focused does not run onConfirm', async () => {
    const { state, buttons } = await open({ secondaryLabel: 'Keep', onSecondary: vi.fn() });
    buttons[1].focus();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(state.onConfirm).not.toHaveBeenCalled();
  });

  it('Cancel click calls onCancel then onClose', async () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push('close'));
    const { buttons } = await open({ onCancel: () => order.push('cancel') }, onClose);
    await act(async () => click(buttons[0]));
    expect(order).toEqual(['cancel', 'close']);
  });

  it('backdrop click calls onCancel then onClose', async () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push('close'));
    const { dialog } = await open({ onCancel: () => order.push('cancel') }, onClose);
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error('no backdrop');
    await act(async () => click(backdrop));
    expect(order).toEqual(['cancel', 'close']);
  });

  it('Escape calls onCancel then onClose', async () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push('close'));
    await open({ onCancel: () => order.push('cancel') }, onClose);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(order).toEqual(['cancel', 'close']);
  });

  it('primary click does not call onCancel', async () => {
    const onCancel = vi.fn();
    const { state, onClose, buttons } = await open({ onCancel });
    await act(async () => click(buttons[buttons.length - 1]));
    expect(state.onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('secondary click does not call onCancel', async () => {
    const onCancel = vi.fn();
    const onSecondary = vi.fn();
    const { buttons } = await open({ onCancel, secondaryLabel: 'Keep', onSecondary });
    await act(async () => click(buttons[1]));
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Tab from last button wraps to first', async () => {
    const { buttons } = await open({ secondaryLabel: 'Keep', onSecondary: vi.fn() });
    const last = buttons[buttons.length - 1];
    last.focus();
    const e = tab(last);
    expect(document.activeElement).toBe(buttons[0]);
    expect(e.defaultPrevented).toBe(true);
  });

  it('Shift+Tab from first button wraps to last', async () => {
    const { buttons } = await open({ secondaryLabel: 'Keep', onSecondary: vi.fn() });
    buttons[0].focus();
    tab(buttons[0], true);
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('Tab from a middle button is left to the browser', async () => {
    const { buttons } = await open({ secondaryLabel: 'Keep', onSecondary: vi.fn() });
    buttons[1].focus();
    const e = tab(buttons[1]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('Cancel restores focus to the previously focused element', async () => {
    const { buttons } = await open();
    expect(document.activeElement).not.toBe(opener);
    await act(async () => click(buttons[0]));
    await unmount();
    expect(document.activeElement).toBe(opener);
  });

  it('aria-labelledby/aria-describedby point at title/message ids', async () => {
    const { dialog } = await open();
    const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
    const msg = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
    expect(title?.textContent).toBe('Close session?');
    expect(msg?.textContent).toBe('It is still running.');
  });

  it('onShown called once on mount', async () => {
    const onShown = vi.fn();
    const onClose = vi.fn();
    const state: ConfirmState = { title: 't', message: 'm', onConfirm: vi.fn(), onShown };
    await open(state, onClose);
    const r = root;
    await act(async () =>
      r?.render(createElement(ConfirmDialog, { state: { ...state }, onClose })),
    );
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  it('the autofocused button carries data-modal-default: the primary by default', async () => {
    const { buttons } = await open();
    const primary = buttons[buttons.length - 1];
    expect(document.activeElement).toBe(primary);
    expect(primary.hasAttribute('data-modal-default')).toBe(true);
    expect(buttons[0].hasAttribute('data-modal-default')).toBe(false);
  });

  it('the autofocused button carries data-modal-default: Cancel when focusCancel', async () => {
    const { buttons } = await open({ focusCancel: true });
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0].hasAttribute('data-modal-default')).toBe(true);
    expect(buttons[buttons.length - 1].hasAttribute('data-modal-default')).toBe(false);
  });
});

describe('useFocusTrap', () => {
  it('skips disabled buttons when wrapping', async () => {
    function Trap() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref);
      return createElement(
        'div',
        { ref },
        createElement('button', { id: 'a' }),
        createElement('button', { id: 'b' }),
        createElement('button', { id: 'c', disabled: true }),
      );
    }
    host = document.createElement('div');
    document.body.append(host);
    const r = createRoot(host);
    root = r;
    await act(async () => r.render(createElement(Trap)));
    const b = document.getElementById('b') as HTMLButtonElement;
    b.focus();
    tab(b);
    expect(document.activeElement?.id).toBe('a');
  });
});

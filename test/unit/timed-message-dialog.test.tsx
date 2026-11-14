// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_TOO_LONG } from '../../src/message-text';
import type { Session } from '../../src/types';
import { TimedMessageDialog } from '../../webview/components/timed-message-dialog';
import { armTimedMessage } from '../../webview/timer-store';

vi.mock('../../webview/timer-store', () => {
  const snapshot = { schedules: [], loaded: true, offer: null };
  return {
    armTimedMessage: vi.fn(),
    cancelTimedMessage: vi.fn(),
    getTimerSnapshot: () => snapshot,
    renewTimedMessage: vi.fn(),
    resolveLimitOffer: vi.fn(),
    schedulesFor: () => [],
    sendMessageOnce: vi.fn(),
    sendTimedMessageNow: vi.fn(),
    subscribeTimers: () => () => {},
  };
});

vi.mock('../../webview/terminal-bus', () => ({
  hasRegisteredTerminal: () => true,
  subscribeTerminalBus: () => () => {},
}));

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
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const onClose = vi.fn();
const requestConfirm = vi.fn();

beforeEach(() => {
  vi.mocked(armTimedMessage).mockClear();
  onClose.mockClear();
  requestConfirm.mockClear();
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

const SESSION = { id: 's1', name: 'api fix' } as Session;

async function render() {
  host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  await act(async () => {
    r.render(
      createElement(TimedMessageDialog, {
        session: SESSION,
        onClose,
        requestConfirm,
      }),
    );
  });
}

function q<T extends Element>(sel: string): T {
  const el = document.body.querySelector<T>(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
}

async function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(el: Element, k: string, init: KeyboardEventInit = {}): Promise<boolean> {
  let notPrevented = false;
  await act(async () => {
    notPrevented = el.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
  return notPrevented;
}

function messageBox(): HTMLTextAreaElement {
  const box = document.body.querySelector<HTMLTextAreaElement>('textarea.tmdlg__input');
  expect(box).not.toBeNull();
  if (!box) throw new Error('no message textarea');
  return box;
}

function armButton(): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Arm',
  );
  if (!btn) throw new Error('no Arm button');
  return btn;
}

describe('TimedMessageDialog composer', () => {
  it('renders a textarea for the message', async () => {
    await render();
    const label = q<HTMLLabelElement>('label.tmdlg__label');
    const box = messageBox();
    expect(label.htmlFor).toBe(box.id);
  });

  it('Enter inserts a newline, Ctrl+Enter arms', async () => {
    await render();
    const box = messageBox();
    await typeInto(box, 'line1');
    expect(await key(box, 'Enter')).toBe(true);
    expect(armTimedMessage).not.toHaveBeenCalled();
    await typeInto(box, 'line1\nline2');
    expect(await key(box, 'Enter', { ctrlKey: true })).toBe(false);
    expect(vi.mocked(armTimedMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(armTimedMessage).mock.calls[0][0]).toMatchObject({
      sessionId: 's1',
      message: 'line1\nline2',
    });
  });

  it('Cmd+Enter arms from the message field', async () => {
    await render();
    const box = messageBox();
    await typeInto(box, 'cmd');
    expect(await key(box, 'Enter', { metaKey: true })).toBe(false);
    expect(vi.mocked(armTimedMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(armTimedMessage).mock.calls[0][0]).toMatchObject({ message: 'cmd' });
  });

  it('closing over the limit asks before discarding the text', async () => {
    await render();
    await typeInto(messageBox(), 'b'.repeat(16_001));
    await act(async () => {
      q<HTMLButtonElement>('.tmdlg__close').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(requestConfirm).toHaveBeenCalledTimes(1);
    const state = requestConfirm.mock.calls[0][0] as { title: string; message: string };
    expect(state.title).toBe('Discard this message');
    expect(state.message).toBe(`Close without arming "${'b'.repeat(40)}…"?`);
  });

  it('plain Enter in the delay field arms', async () => {
    await render();
    const delay = q<HTMLInputElement>('input[aria-label="Delay"]');
    expect(await key(delay, 'Enter')).toBe(false);
    expect(vi.mocked(armTimedMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(armTimedMessage).mock.calls[0][0]).toMatchObject({
      sessionId: 's1',
      message: 'Continue',
    });
  });

  it('shows n / 16,000 under the message', async () => {
    await render();
    await typeInto(messageBox(), 'abc');
    expect(document.body.textContent).toContain('3 / 16,000');
  });

  it('a whitespace-only message counts as 0', async () => {
    await render();
    await typeInto(messageBox(), '   ');
    expect(document.body.textContent).toContain('0 / 16,000');
  });

  it('over the limit disables Arm and shows the hint', async () => {
    await render();
    const box = messageBox();
    await typeInto(box, 'a'.repeat(16_001));
    expect(armButton().disabled).toBe(true);
    const [countRef, hintRef] = (box.getAttribute('aria-describedby') ?? '').split(' ');
    const hint = document.getElementById(hintRef ?? '');
    expect(hint?.textContent).toBe(MESSAGE_TOO_LONG);
    expect(hint?.classList.contains('tmdlg__hint--error')).toBe(true);
    const count = document.getElementById(countRef ?? '');
    expect(count?.textContent).toBe('16,001 / 16,000');
    expect(count?.classList.contains('tmdlg__hint--error')).toBe(true);
    await key(box, 'Enter', { ctrlKey: true });
    expect(armTimedMessage).not.toHaveBeenCalled();
  });
});

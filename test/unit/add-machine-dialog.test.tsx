// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MachineActionResult } from '../../src/contracts/machines';
import { AddMachineDialog } from '../../webview/components/add-machine-dialog';
import { MACHINES_STR } from '../../webview/machines-strings';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const needsPassword: MachineActionResult = {
  ok: false,
  error: { code: 'ssh_needs_person', detail: { reason: 'password' } },
};

async function render(p: {
  hosts?: string[];
  onSubmit?: (machine: string) => Promise<MachineActionResult>;
  onOpenNeedsPerson?: (target: string) => void;
  onClose?: () => void;
}) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      createElement(AddMachineDialog, {
        hosts: p.hosts ?? ['alpha'],
        onSubmit: p.onSubmit ?? (() => Promise.resolve(needsPassword)),
        onOpenNeedsPerson: p.onOpenNeedsPerson ?? (() => {}),
        onClose: p.onClose ?? (() => {}),
      }),
    ),
  );
}

/** Types into the controlled field the way a keyboard does, so React sees an input event. */
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const buttonNamed = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text) ?? null;

describe('AddMachineDialog', () => {
  it('submits a typed target and shows the needs-person action', async () => {
    const onSubmit = vi.fn((_m: string) => Promise.resolve(needsPassword));
    const onOpenNeedsPerson = vi.fn();
    const onClose = vi.fn();
    await render({ onSubmit, onOpenNeedsPerson, onClose });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const field = document.querySelector<HTMLInputElement>('input');
    expect(field).not.toBeNull();
    await act(async () => type(field as HTMLInputElement, 'user@win:2222'));
    await act(async () => buttonNamed(MACHINES_STR.connect)?.click());
    expect(onSubmit).toHaveBeenCalledWith('user@win:2222');
    expect(document.body.textContent).toContain('enter your password');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => buttonNamed(MACHINES_STR.connectInTerminal)?.click());
    expect(onOpenNeedsPerson).toHaveBeenCalledWith('user@win:2222');
  });

  it('a Host button fills the field and submits it', async () => {
    const onSubmit = vi.fn((_m: string) => Promise.resolve(needsPassword));
    await render({ onSubmit });
    await act(async () => buttonNamed('alpha')?.click());
    expect(onSubmit).toHaveBeenCalledWith('alpha');
  });

  it('closes on success and on Escape', async () => {
    const onClose = vi.fn();
    await render({
      onSubmit: () => Promise.resolve({ ok: true, value: null }),
      onClose,
    });
    const field = document.querySelector<HTMLInputElement>('input') as HTMLInputElement;
    await act(async () => type(field, 'user@win'));
    await act(async () => buttonNamed(MACHINES_STR.connect)?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a second submit while dialing does not dial again', async () => {
    const onSubmit = vi.fn((_m: string) => new Promise<MachineActionResult>(() => {}));
    await render({ onSubmit });
    const field = document.querySelector<HTMLInputElement>('input') as HTMLInputElement;
    await act(async () => type(field, 'user@win'));
    await act(async () => buttonNamed(MACHINES_STR.connect)?.click());
    await act(async () => buttonNamed(MACHINES_STR.connect)?.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      MACHINES_STR.dialing('user@win'),
    );
    expect(field.disabled).toBe(false);
  });

  it('a failed request shows the unreachable line and leaves the dialog usable', async () => {
    const onSubmit = vi.fn((_m: string) => Promise.reject(new Error('link down')));
    await render({ onSubmit });
    const field = document.querySelector<HTMLInputElement>('input') as HTMLInputElement;
    await act(async () => type(field, 'user@win'));
    await act(async () => buttonNamed(MACHINES_STR.connect)?.click());
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      MACHINES_STR.error('ssh_unreachable'),
    );
    expect(buttonNamed(MACHINES_STR.connect)?.disabled).toBe(false);
    await act(async () => buttonNamed(MACHINES_STR.retry)?.click());
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('the fault is announced in the live region and focus moves to its first action', async () => {
    await render({ onSubmit: () => Promise.resolve(needsPassword) });
    const field = document.querySelector<HTMLInputElement>('input') as HTMLInputElement;
    await act(async () => type(field, 'user@win'));
    await act(async () => buttonNamed(MACHINES_STR.connect)?.click());
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      MACHINES_STR.needsYou('user@win', 'password'),
    );
    expect(document.activeElement).toBe(buttonNamed(MACHINES_STR.connectInTerminal));
  });
});

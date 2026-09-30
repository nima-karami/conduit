// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfirmState } from '../../webview/components/confirm-dialog';
import {
  focusOpenModal,
  type ModalEntry,
  type ModalSlot,
  nextModalKey,
  useModalSlot,
} from '../../webview/use-modal-slot';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root | null = null;

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => r.unmount());
  host?.remove();
});

/** Mounts the hook; `renders` records the entry key each render saw. */
async function mountSlot() {
  host = document.createElement('div');
  document.body.append(host);
  const r = createRoot(host);
  root = r;
  const out: { slot: ModalSlot | null; renders: Array<number | null> } = {
    slot: null,
    renders: [],
  };
  function Harness() {
    const slot = useModalSlot();
    out.slot = slot;
    out.renders.push(slot.current?.key ?? null);
    return slot.current?.kind === 'confirm'
      ? createElement('button', { 'data-modal-default': true }, slot.current.state.title)
      : null;
  }
  await act(async () => r.render(createElement(Harness)));
  return out as { slot: ModalSlot; renders: Array<number | null> };
}

function confirm(overrides: Partial<ConfirmState> = {}): ModalEntry {
  return {
    kind: 'confirm',
    key: nextModalKey(),
    state: { title: 't', message: 'm', onConfirm: vi.fn(), ...overrides },
  };
}

describe('useModalSlot', () => {
  it('open displaces and settles the previous entry via onCancel', async () => {
    const h = await mountSlot();
    const onCancel = vi.fn();
    const first = confirm({ onCancel });
    const second = confirm();
    await act(async () => h.slot.open(first));
    await act(async () => h.slot.open(second));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(h.slot.current?.key).toBe(second.key);
    expect(h.renders.at(-1)).toBe(second.key);
  });

  it('current is updated before the displaced settle runs', async () => {
    const h = await mountSlot();
    let seen: number | undefined;
    const first = confirm({ onCancel: () => (seen = h.slot.current?.key) });
    const second = confirm();
    await act(async () => h.slot.open(first));
    await act(async () => h.slot.open(second));
    expect(seen).toBe(second.key);
  });

  it('a displaced settle that closes its own key leaves the newcomer open', async () => {
    const h = await mountSlot();
    const first = confirm();
    first.state.onCancel = () => h.slot.close(first.key);
    const second = confirm();
    await act(async () => h.slot.open(first));
    await act(async () => h.slot.open(second));
    expect(h.slot.current?.key).toBe(second.key);
  });

  it('re-opening the same key does not settle it', async () => {
    const h = await mountSlot();
    const onCancel = vi.fn();
    const first = confirm({ onCancel });
    await act(async () => h.slot.open(first));
    await act(async () => h.slot.open({ ...first }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('update with a different key is a no-op', async () => {
    const h = await mountSlot();
    const first = confirm({ title: 'one' });
    await act(async () => h.slot.open(first));
    const other = confirm({ title: 'two' });
    await act(async () => h.slot.update(other));
    expect(h.slot.current?.key).toBe(first.key);
    await act(async () =>
      h.slot.update({ ...first, state: { ...first.state, title: 'one, updated' } }),
    );
    expect(host.textContent).toBe('one, updated');
  });

  it('close only clears its own key, never settles', async () => {
    const h = await mountSlot();
    const onCancel = vi.fn();
    const first = confirm({ onCancel });
    await act(async () => h.slot.open(first));
    await act(async () => h.slot.close(first.key + 1000));
    expect(h.slot.current?.key).toBe(first.key);
    await act(async () => h.slot.close(first.key));
    expect(h.slot.current).toBeNull();
    expect(h.renders.at(-1)).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('dismiss settles then clears', async () => {
    const h = await mountSlot();
    const order: string[] = [];
    const first = confirm({ onCancel: () => order.push(`cancel:${h.slot.current?.key}`) });
    await act(async () => h.slot.open(first));
    await act(async () => h.slot.dismiss());
    expect(order).toEqual([`cancel:${first.key}`]);
    expect(h.slot.current).toBeNull();
  });

  it('exit-warn during a quit dialog settles the ask', async () => {
    const h = await mountSlot();
    const recorder: unknown[] = [];
    const quitAsk = confirm({
      title: '1 session still running',
      focusCancel: true,
      onCancel: () => recorder.push({ type: 'quitDecision', requestId: 7, proceed: false }),
      onConfirm: () => recorder.push({ type: 'quitDecision', requestId: 7, proceed: true }),
    });
    await act(async () => h.slot.open(quitAsk));
    await act(async () => h.slot.open(confirm({ title: 'Terminal exited' })));
    expect(recorder).toEqual([{ type: 'quitDecision', requestId: 7, proceed: false }]);
    expect(host.textContent).toBe('Terminal exited');
  });

  it('a displaced closeDoc-style confirm resolves false', async () => {
    const h = await mountSlot();
    const answer = new Promise<boolean>((resolve) => {
      h.slot.open(confirm({ onCancel: () => resolve(false), onConfirm: () => resolve(true) }));
    });
    await act(async () => h.slot.open(confirm()));
    await expect(answer).resolves.toBe(false);
  });

  it('slot identity is stable across renders', async () => {
    const h = await mountSlot();
    const before = h.slot;
    await act(async () => h.slot.open(confirm()));
    expect(h.slot).toBe(before);
  });

  it('focusOpenModal focuses the open modal default button', async () => {
    const h = await mountSlot();
    await act(async () => h.slot.open(confirm({ title: 'focus me' })));
    focusOpenModal();
    expect(document.activeElement?.textContent).toBe('focus me');
  });
});

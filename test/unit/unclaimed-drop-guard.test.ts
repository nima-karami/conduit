// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installUnclaimedDropGuard } from '../../webview/unclaimed-drop-guard';

function dragEvent(type: string, types: string[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const dataTransfer = { types, dropEffect: 'copy' };
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
  return { ev, dataTransfer };
}

let el: HTMLDivElement;
let uninstall: () => void = () => {};

beforeEach(() => {
  el = document.createElement('div');
  document.body.append(el);
  uninstall = installUnclaimedDropGuard(window);
});

afterEach(() => {
  uninstall();
  el.remove();
});

describe('installUnclaimedDropGuard', () => {
  it('Files dragover over dead space is cancelled with none', () => {
    const { ev, dataTransfer } = dragEvent('dragover', ['Files']);
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe('none');
  });

  it('a handler that claims keeps its own effect', () => {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dt = (e as DragEvent).dataTransfer;
      if (dt) dt.dropEffect = 'copy';
    });
    const { ev, dataTransfer } = dragEvent('dragover', ['Files']);
    el.dispatchEvent(ev);
    expect(dataTransfer.dropEffect).toBe('copy');
  });

  it('a handler that stops propagation still gets the none default', () => {
    el.addEventListener('dragover', (e) => e.stopPropagation());
    const { ev, dataTransfer } = dragEvent('dragover', ['Files']);
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe('none');
  });

  it('text drags untouched', () => {
    const over = dragEvent('dragover', ['text/plain']);
    el.dispatchEvent(over.ev);
    expect(over.ev.defaultPrevented).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    const drop = dragEvent('drop', ['text/plain']);
    el.dispatchEvent(drop.ev);
    expect(drop.ev.defaultPrevented).toBe(false);
  });

  it('unclaimed Files drop is prevented', () => {
    const { ev } = dragEvent('drop', ['Files']);
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('uninstall removes both listeners', () => {
    uninstall();
    const over = dragEvent('dragover', ['Files']);
    el.dispatchEvent(over.ev);
    const drop = dragEvent('drop', ['Files']);
    el.dispatchEvent(drop.ev);
    expect(over.ev.defaultPrevented).toBe(false);
    expect(drop.ev.defaultPrevented).toBe(false);
  });
});

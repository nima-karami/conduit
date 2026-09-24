// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProjectGroupHeader } from '../../webview/components/project-group-header';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;

type Props = Parameters<typeof ProjectGroupHeader>[0];

function props(over: Partial<Props> = {}): Props {
  return {
    groupKey: 'p-1',
    name: 'RMB',
    labelId: 'lbl-1',
    count: 2,
    collapsed: false,
    attn: false,
    renaming: false,
    dropCue: null,
    drag: undefined,
    onToggle: vi.fn(),
    onNew: vi.fn(),
    onMenu: vi.fn(),
    onStartRename: vi.fn(),
    onRenameEnd: vi.fn(),
    ...over,
  };
}

async function render(p: Props) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(ProjectGroupHeader, p)));
  return p;
}

async function unmount() {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
}

afterEach(unmount);

const q = <T extends Element>(sel: string) => document.querySelector(sel) as T;

async function key(el: Element, init: KeyboardEventInit) {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(ev);
  });
  return ev;
}

const dragHandlers = (withStart: boolean) => ({
  ...(withStart ? { onDragStart: vi.fn() } : {}),
  onDragOver: vi.fn(),
  onDragLeave: vi.fn(),
  onDrop: vi.fn(),
  onDragEnd: vi.fn(),
});

describe('ProjectGroupHeader', () => {
  it('+ has aria-label "New session in RMB" and calls onNew, not onToggle', async () => {
    const p = await render(props());
    const add = q<HTMLButtonElement>('button.proj__add');
    expect(add.getAttribute('aria-label')).toBe('New session in RMB');
    expect(add.getAttribute('title')).toBe('New session in RMB');
    await act(async () => add.click());
    expect(p.onNew).toHaveBeenCalledTimes(1);
    expect(p.onToggle).not.toHaveBeenCalled();
  });

  it('Standalone + is labelled "New standalone session"', async () => {
    await render(props({ groupKey: 'standalone', name: 'Standalone' }));
    expect(q('button.proj__add').getAttribute('aria-label')).toBe('New standalone session');
  });

  it('chevron toggles and carries aria-expanded', async () => {
    const p = await render(props({ collapsed: true }));
    const chev = q<HTMLButtonElement>('button.proj__chevron');
    expect(chev.getAttribute('aria-expanded')).toBe('false');
    expect(chev.getAttribute('aria-label')).toBe('Expand RMB');
    await act(async () => chev.click());
    expect(p.onToggle).toHaveBeenCalledTimes(1);
  });

  it('right-click calls onMenu with the point and preventDefaults', async () => {
    const p = await render(props());
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 12,
      clientY: 34,
    });
    await act(async () => {
      q('.proj__label').dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(p.onMenu).toHaveBeenCalledWith({ x: 12, y: 34 }, null);
  });

  it('Shift+F10 on the chevron calls onMenu with the header rect and keyboard:true', async () => {
    const p = await render(props());
    const label = q<HTMLElement>('.proj__label');
    label.getBoundingClientRect = () =>
      ({ left: 1, right: 201, top: 10, bottom: 30, width: 200, height: 20 }) as DOMRect;
    const chev = q<HTMLButtonElement>('button.proj__chevron');
    const ev = await key(chev, { key: 'F10', shiftKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(p.onMenu).toHaveBeenCalledWith(
      { anchor: { left: 1, right: 201, top: 10, bottom: 30 }, keyboard: true },
      chev,
    );
  });

  it('ContextMenu key on + does the same', async () => {
    const p = await render(props());
    const add = q<HTMLButtonElement>('button.proj__add');
    await key(add, { key: 'ContextMenu' });
    expect(p.onMenu).toHaveBeenCalledTimes(1);
    const [at, focus] = vi.mocked(p.onMenu).mock.calls[0];
    expect(at).toMatchObject({ keyboard: true });
    expect(focus).toBe(add);
    await key(add, { key: 'F10' });
    expect(p.onMenu).toHaveBeenCalledTimes(1);
  });

  it('double-click on the name starts a rename', async () => {
    const p = await render(props());
    await act(async () => {
      q('.proj__name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(p.onStartRename).toHaveBeenCalledTimes(1);
  });

  it('renaming: input focused with the name selected; Enter → onRenameEnd(value); Escape → onRenameEnd(null); blur → onRenameEnd(value)', async () => {
    const enter = await render(props({ renaming: true }));
    let input = q<HTMLInputElement>('input.proj__rename');
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('RMB');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
    expect(input.id).toBe('lbl-1');
    input.value = 'RMB 2';
    await key(input, { key: 'Enter' });
    expect(enter.onRenameEnd).toHaveBeenCalledWith('RMB 2');
    await act(async () => input.blur());
    expect(enter.onRenameEnd).toHaveBeenCalledTimes(1);
    await unmount();

    const esc = await render(props({ renaming: true }));
    input = q<HTMLInputElement>('input.proj__rename');
    await key(input, { key: 'Escape' });
    expect(esc.onRenameEnd).toHaveBeenCalledWith(null);
    await unmount();

    const blur = await render(props({ renaming: true }));
    input = q<HTMLInputElement>('input.proj__rename');
    input.value = 'Other';
    await act(async () => input.blur());
    expect(blur.onRenameEnd).toHaveBeenCalledWith('Other');
  });

  it('renaming: the header is not draggable and input clicks neither toggle nor rename again', async () => {
    const p = await render(props({ renaming: true, drag: dragHandlers(true) }));
    expect(q('.proj__label').getAttribute('draggable')).toBe('false');
    const input = q<HTMLInputElement>('input.proj__rename');
    await act(async () => {
      input.click();
      input.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(p.onToggle).not.toHaveBeenCalled();
    expect(p.onStartRename).not.toHaveBeenCalled();
  });

  it('no drag.onDragStart → not draggable', async () => {
    await render(props({ drag: dragHandlers(false) }));
    expect(q('.proj__label').getAttribute('draggable')).toBe('false');
    await unmount();
    await render(props({ drag: dragHandlers(true) }));
    expect(q('.proj__label').getAttribute('draggable')).toBe('true');
  });

  it('dropCue into → proj__label--dropinto', async () => {
    await render(props({ dropCue: 'into' }));
    expect(q('.proj__label').className).toBe('proj__label proj__label--dropinto');
    await unmount();
    await render(props({ dropCue: 'before' }));
    expect(q('.proj__label').className).toBe('proj__label proj__label--dropbefore');
  });

  it('name span carries labelId and the count shows with its attn modifier', async () => {
    await render(props({ attn: true, count: 7 }));
    expect(q('.proj__name').id).toBe('lbl-1');
    expect(q('.proj__label').getAttribute('title')).toBe('RMB');
    const count = q('.proj__slot .proj__count');
    expect(count.textContent).toBe('7');
    expect(count.className).toContain('proj__count--attn');
  });
});

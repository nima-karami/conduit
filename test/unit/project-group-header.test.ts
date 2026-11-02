// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SpaceRowModel } from '../../src/agent-tree';
import {
  AgentGroupHeader,
  RenameInput,
  SpaceRow,
} from '../../webview/components/project-group-header';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;

async function render(el: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(el));
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

const SPACE: SpaceRowModel = {
  key: 'p-1',
  projectId: 'p-1',
  name: 'RMB',
  letter: 'R',
  hue: 'violet',
  branch: 'main',
  state: 'blocked',
  count: 2,
};

type SpaceProps = Parameters<typeof SpaceRow>[0];
function spaceProps(over: Partial<SpaceProps> = {}): SpaceProps {
  return {
    row: SPACE,
    name: 'RMB',
    detail: 'main',
    selected: false,
    renaming: false,
    dropCue: false,
    drop: undefined,
    onPick: vi.fn(),
    onMenu: vi.fn(),
    onRenameEnd: vi.fn(),
    onStartRename: vi.fn(),
    ...over,
  };
}

describe('SpaceRow', () => {
  it('is a pressed-state button named exactly the Space, described by its branch', async () => {
    const p = spaceProps({ selected: true });
    await render(createElement(SpaceRow, p));
    const btn = q<HTMLButtonElement>('button[data-space-id="p-1"]');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('RMB');
    const desc = document.getElementById(btn.getAttribute('aria-describedby') ?? '');
    expect(desc?.textContent).toBe('main');
    expect(btn.className).toBe('space space--violet space--on');
    expect(btn.querySelector('.space__tile')?.textContent).toBe('R');
    expect(btn.querySelector('.agentmark__dot--blocked')).not.toBeNull();
    expect(btn.querySelectorAll('button')).toHaveLength(0);
    await act(async () => btn.click());
    expect(p.onPick).toHaveBeenCalledTimes(1);
  });

  it('All and No space use their keys as data-space-id; no detail means no description', async () => {
    await render(
      createElement(
        'div',
        null,
        createElement(
          SpaceRow,
          spaceProps({
            row: { ...SPACE, key: 'all', projectId: null, hue: 'neutral', letter: '' },
            name: 'All',
            detail: '3 agents',
          }),
        ),
        createElement(
          SpaceRow,
          spaceProps({
            row: { ...SPACE, key: 'no-space', projectId: null, hue: 'neutral', state: null },
            name: 'No space',
            detail: null,
          }),
        ),
      ),
    );
    expect(q('button[data-space-id="all"]').getAttribute('aria-pressed')).toBe('false');
    const none = q('button[data-space-id="no-space"]');
    expect(none.getAttribute('aria-label')).toBe('No space');
    expect(none.hasAttribute('aria-describedby')).toBe(false);
    expect(none.querySelector('.agentmark')).toBeNull();
  });

  it('a working Space shows a still dot, never the row spinner', async () => {
    await render(createElement(SpaceRow, spaceProps({ row: { ...SPACE, state: 'working' } })));
    expect(q('button.space .agentmark__dot--working')).not.toBeNull();
    expect(q('button.space .agentmark__spin')).toBeNull();
  });

  it('right-click opens the menu at the point and preventDefaults', async () => {
    const p = spaceProps();
    await render(createElement(SpaceRow, p));
    const ev = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 12,
      clientY: 34,
    });
    await act(async () => {
      q('button.space').dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(p.onMenu).toHaveBeenCalledWith({ x: 12, y: 34 }, null);
  });

  it('Shift+F10 and the Menu key open it anchored to the row; plain F10 does not', async () => {
    const p = spaceProps();
    await render(createElement(SpaceRow, p));
    const btn = q<HTMLButtonElement>('button.space');
    btn.getBoundingClientRect = () =>
      ({ left: 1, right: 201, top: 10, bottom: 30, width: 200, height: 20 }) as DOMRect;
    const ev = await key(btn, { key: 'F10', shiftKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(p.onMenu).toHaveBeenCalledWith(
      { anchor: { left: 1, right: 201, top: 10, bottom: 30 }, keyboard: true },
      btn,
    );
    await key(btn, { key: 'ContextMenu' });
    await key(btn, { key: 'F10' });
    expect(p.onMenu).toHaveBeenCalledTimes(2);
  });

  it('double-click renames a Space, never All or No space', async () => {
    const p = spaceProps();
    await render(createElement(SpaceRow, p));
    await act(async () => {
      q('button.space').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(p.onStartRename).toHaveBeenCalledTimes(1);
    await unmount();
    const all = spaceProps({ row: { ...SPACE, key: 'all', projectId: null } });
    await render(createElement(SpaceRow, all));
    await act(async () => {
      q('button.space').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(all.onStartRename).not.toHaveBeenCalled();
  });

  it('a drop cue and the drop handlers ride on the button', async () => {
    const drop = { onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn() };
    await render(createElement(SpaceRow, spaceProps({ dropCue: true, drop })));
    const btn = q('button.space');
    expect(btn.className).toContain('space--drop');
    await act(async () => {
      btn.dispatchEvent(new Event('dragover', { bubbles: true }));
      btn.dispatchEvent(new Event('drop', { bubbles: true }));
    });
    expect(drop.onDragOver).toHaveBeenCalledTimes(1);
    expect(drop.onDrop).toHaveBeenCalledTimes(1);
  });

  it('renaming replaces the button with the rename input', async () => {
    await render(createElement(SpaceRow, spaceProps({ renaming: true })));
    expect(q('button.space')).toBeNull();
    expect(q<HTMLInputElement>('input.proj__rename').getAttribute('aria-label')).toBe('Rename RMB');
  });
});

describe('AgentGroupHeader', () => {
  it('is button.proj__label with the group, expansion, controls and a root count', async () => {
    const onToggle = vi.fn();
    await render(
      createElement(AgentGroupHeader, {
        group: 'blocked',
        roots: 2,
        folded: false,
        controls: 'g-1',
        onToggle,
      }),
    );
    const btn = q<HTMLButtonElement>('button.proj__label');
    expect(btn.dataset.agentGroup).toBe('blocked');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.getAttribute('aria-controls')).toBe('g-1');
    expect(btn.getAttribute('aria-label')).toBe('Needs you (2)');
    expect(btn.className).toBe('proj__label proj__label--attn');
    expect(btn.querySelector('.proj__count')?.textContent).toBe('2');
    await act(async () => btn.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('a folded group says so; only Needs you takes the attention ink', async () => {
    await render(
      createElement(AgentGroupHeader, {
        group: 'stopped',
        roots: 1,
        folded: true,
        controls: 'g-2',
        onToggle: () => {},
      }),
    );
    const btn = q('button.proj__label');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Stopped (1)');
    expect(btn.className).toBe('proj__label');
  });
});

describe('RenameInput', () => {
  it('focused with the name selected; Enter → value; Escape → null; blur → value; first end wins', async () => {
    const enter = vi.fn();
    await render(createElement(RenameInput, { name: 'RMB', onEnd: enter }));
    let input = q<HTMLInputElement>('input.proj__rename');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
    input.value = 'RMB 2';
    await key(input, { key: 'Enter' });
    expect(enter).toHaveBeenCalledWith('RMB 2');
    await act(async () => input.blur());
    expect(enter).toHaveBeenCalledTimes(1);
    await unmount();

    const esc = vi.fn();
    await render(createElement(RenameInput, { name: 'RMB', onEnd: esc }));
    input = q<HTMLInputElement>('input.proj__rename');
    await key(input, { key: 'Escape' });
    expect(esc).toHaveBeenCalledWith(null);
    await unmount();

    const blur = vi.fn();
    await render(createElement(RenameInput, { name: '', label: 'New space name', onEnd: blur }));
    input = q<HTMLInputElement>('input[aria-label="New space name"]');
    input.value = 'Other';
    await act(async () => input.blur());
    expect(blur).toHaveBeenCalledWith('Other');
  });
});

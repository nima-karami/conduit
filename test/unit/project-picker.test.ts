// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import type { Project, Session } from '../../src/types';
import { ProjectPicker } from '../../webview/components/project-picker';

type Reply = Extract<HostToWebview, { type: 'project:created' | 'project:opResult' }> | null;
const requests: { send: (id: number) => WebviewToHost; resolve: (r: Reply) => void }[] = [];
const moveSession = vi.fn();

vi.mock('../../webview/host-request', () => ({
  requestHost: (send: (id: number) => WebviewToHost) =>
    new Promise<Reply>((resolve) => requests.push({ send, resolve })),
}));
vi.mock('../../webview/project-announcer', () => ({
  projectAnnouncer: { moveSession: (...a: unknown[]) => moveSession(...a) },
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

beforeEach(() => {
  requests.length = 0;
  moveSession.mockReset();
});

const PROJECTS: Project[] = [
  { id: 'p1', name: 'RMB pipeline', order: 0 },
  { id: 'p2', name: 'conduit', order: 1 },
];

const S: Session = {
  id: 's1',
  name: 'api fix',
  agentId: 'shell:cmd',
  home: 'G:/w/api',
  roots: [],
  projectId: 'p1',
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
};

let root: Root | null = null;
let onClose = vi.fn();

async function render(session: Session | null = S, projects = PROJECTS) {
  onClose = vi.fn();
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root?.render(
      createElement(ProjectPicker, {
        session: session ?? undefined,
        projects,
        at: { x: 5, y: 5 },
        onClose,
      }),
    ),
  );
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const q = <T extends Element>(sel: string) => document.querySelector(sel) as T;
const rowLabels = () =>
  [...document.querySelectorAll('.projpicker [role="option"]')].map((r) => r.textContent);

async function key(el: Element, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const flush = () => act(async () => {});

async function openCreate(prefill = '') {
  await render();
  if (prefill) await type(q('.projpicker__filter'), prefill);
  await act(async () => q<HTMLElement>('.projpicker__new').click());
  return q<HTMLInputElement>('.projpicker__name');
}

describe('ProjectPicker', () => {
  it('filter input focused on open; rows = projects then Standalone; current row aria-selected with a check', async () => {
    await render();
    expect(document.activeElement).toBe(q('.projpicker__filter'));
    expect(rowLabels()).toEqual(['RMB pipeline', 'conduit', 'Standalone', '+ New project…']);
    const current = document.querySelectorAll('.projpicker [aria-selected="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe('RMB pipeline');
    expect(current[0].querySelector('.projpicker__check')).not.toBeNull();
  });

  it('the focused filter is a combobox controlling an inner listbox that owns only the option rows', async () => {
    await render();
    const filter = q<HTMLInputElement>('.projpicker__filter');
    expect(filter.getAttribute('role')).toBe('combobox');
    expect(filter.getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(filter.getAttribute('aria-controls') ?? '');
    expect(list?.getAttribute('role')).toBe('listbox');
    expect(list?.getAttribute('aria-label')).toBe('Move api fix to project');
    expect(q('.projpicker').getAttribute('role')).not.toBe('listbox');
    expect(list?.contains(filter)).toBe(false);
    const owned = [...(list?.children ?? [])].filter((c) => c.getAttribute('role') !== 'none');
    expect(owned.map((c) => c.getAttribute('role'))).toEqual(owned.map(() => 'option'));
    expect(owned.map((c) => c.textContent)).toEqual(rowLabels());
    await type(filter, 'zzz');
    expect(list?.contains(q('.projpicker__none'))).toBe(false);
  });

  it('no match → a disabled "No projects match" row, Standalone and + New project… still shown', async () => {
    await render();
    await type(q('.projpicker__filter'), 'zzz');
    expect(q('.projpicker__none').textContent).toBe('No projects match');
    expect(q('.projpicker__none').getAttribute('aria-disabled')).toBe('true');
    expect(rowLabels()).toEqual(['Standalone', '+ New project…']);
  });

  it('ArrowDown moves aria-activedescendant; Enter on another row → moveSession(id, …) and onClose', async () => {
    await render();
    const filter = q('.projpicker__filter');
    const first = filter.getAttribute('aria-activedescendant');
    expect(document.getElementById(first ?? '')?.textContent).toBe('RMB pipeline');
    await key(filter, 'ArrowDown');
    const second = filter.getAttribute('aria-activedescendant');
    expect(second).not.toBe(first);
    expect(document.getElementById(second ?? '')?.textContent).toBe('conduit');
    await key(filter, 'Enter');
    expect(moveSession).toHaveBeenCalledWith('s1', 'p2', { session: 'api fix', target: 'conduit' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('picking Standalone moves to null', async () => {
    await render();
    await act(async () =>
      (document.querySelectorAll('.projpicker__row')[2] as HTMLElement).click(),
    );
    expect(moveSession).toHaveBeenCalledWith('s1', null, {
      session: 'api fix',
      target: 'Standalone',
    });
  });

  it('Enter on the current row → onClose only', async () => {
    await render();
    await key(q('.projpicker__filter'), 'Enter');
    expect(moveSession).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('New project: prefilled with the filter; empty name → hint "1–80 characters", nothing posted', async () => {
    const input = await openCreate('RMB  x');
    expect(input.value).toBe('RMB  x');
    expect(document.activeElement).toBe(input);
    await type(input, '   ');
    await key(input, 'Enter');
    expect(q('.projpicker__hint').textContent).toBe('1–80 characters');
    expect(requests).toHaveLength(0);
    await type(input, 'x'.repeat(81));
    await key(input, 'Enter');
    expect(requests).toHaveLength(0);
  });

  it('Enter → requestHost sends project:create, input disabled; a project:created reply → moveSession(sessionId, newId, …) and onClose', async () => {
    const input = await openCreate();
    await type(input, '  New   one ');
    await key(input, 'Enter');
    await key(input, 'Enter');
    expect(requests).toHaveLength(1);
    expect(requests[0].send(3)).toEqual({ type: 'project:create', name: 'New one', requestId: 3 });
    expect(input.disabled).toBe(true);
    await act(async () => requests[0].resolve({ type: 'project:created', requestId: 3, id: 'p9' }));
    await flush();
    expect(moveSession).toHaveBeenCalledWith('s1', 'p9', { session: 'api fix', target: 'New one' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('project:opResult invalid-name → re-enabled with the hint', async () => {
    const input = await openCreate('ok');
    await key(input, 'Enter');
    await act(async () =>
      requests[0].resolve({
        type: 'project:opResult',
        requestId: 1,
        ok: false,
        reason: 'invalid-name',
      }),
    );
    await flush();
    expect(input.disabled).toBe(false);
    expect(q('.projpicker__hint').textContent).toBe('1–80 characters');
    expect(moveSession).not.toHaveBeenCalled();
  });

  it('project:opResult store-unavailable → "Couldn\'t create project"', async () => {
    const input = await openCreate('ok');
    await key(input, 'Enter');
    await act(async () =>
      requests[0].resolve({
        type: 'project:opResult',
        requestId: 1,
        ok: false,
        reason: 'store-unavailable',
      }),
    );
    await flush();
    expect(q('.projpicker__hint').textContent).toBe("Couldn't create project");
  });

  it('null reply (timeout) → re-enabled, nothing chained', async () => {
    const input = await openCreate('ok');
    await key(input, 'Enter');
    await act(async () => requests[0].resolve(null));
    await flush();
    expect(input.disabled).toBe(false);
    expect(moveSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await key(input, 'Enter');
    expect(requests).toHaveLength(2);
  });

  it('Escape while creating returns to the list (onEscape), Escape in the list closes', async () => {
    await openCreate('ab');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(q('.projpicker__name')).toBeNull();
    expect(q('.projpicker__new')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('session undefined → onClose, nothing posted', async () => {
    await render(null);
    expect(onClose).toHaveBeenCalled();
    expect(q('.projpicker')).toBeNull();
    expect(requests).toHaveLength(0);
    expect(moveSession).not.toHaveBeenCalled();
  });

  it('a reply resolving after unmount is ignored', async () => {
    const input = await openCreate('late');
    await key(input, 'Enter');
    await act(async () => root?.unmount());
    root = null;
    await act(async () => requests[0].resolve({ type: 'project:created', requestId: 1, id: 'p9' }));
    await flush();
    expect(moveSession).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a dangling projectId marks Standalone current', async () => {
    await render({ ...S, projectId: 'p-gone' });
    const current = document.querySelectorAll('.projpicker [aria-selected="true"]');
    expect([...current].map((c) => c.textContent)).toEqual(['Standalone']);
  });
});

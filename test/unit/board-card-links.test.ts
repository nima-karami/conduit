// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types';
import { LinkedSessions, TicketHeader } from '../../webview/components/board-card-links';

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

async function render(el: ReturnType<typeof createElement>) {
  if (!root) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  const r = root;
  await act(async () => r.render(el));
  return host;
}

const sess = (id: string, name: string, agentId: string, status: Session['status']): Session => ({
  id,
  name,
  agentId,
  status,
  home: 'C:/h',
  roots: [],
  createdAt: 1,
  lastActiveAt: 1,
  cardId: 'c1',
});

const label = (agentId: string) => (agentId === 'cli:claude' ? 'claude' : 'shell');
const rows = (h: HTMLElement) => [
  ...h.querySelectorAll<HTMLButtonElement>('button.bcard__session'),
];

describe('TicketHeader', () => {
  it('no ticket → nothing rendered', async () => {
    const h = await render(createElement(TicketHeader, { ticket: undefined }));
    expect(h.innerHTML).toBe('');
  });

  it('partial ticket renders only present parts in key, source, status order', async () => {
    const h = await render(
      createElement(TicketHeader, { ticket: { status: 'In progress', key: 'RMB-412' } }),
    );
    const parts = [...(h.querySelector('.bcard__ticket')?.children ?? [])];
    expect(parts.map((p) => p.className)).toEqual(['bcard__tkey', 'bcard__tstatus']);
  });

  it('every part has dir=auto and a title equal to its text', async () => {
    const h = await render(
      createElement(TicketHeader, {
        ticket: { key: 'RMB-412', source: 'Jira', status: 'In progress' },
      }),
    );
    const parts = [...(h.querySelector('.bcard__ticket')?.children ?? [])];
    expect(parts.map((p) => p.textContent)).toEqual(['RMB-412', 'Jira', 'In progress']);
    for (const p of parts) {
      expect(p.getAttribute('dir')).toBe('auto');
      expect(p.getAttribute('title')).toBe(p.textContent);
    }
  });

  it('a part cut at its cap on load ends in an ellipsis', async () => {
    const h = await render(
      createElement(TicketHeader, {
        ticket: { key: 'RMB-412', status: 'Needs review from the platform t' },
      }),
    );
    const status = h.querySelector('.bcard__tstatus');
    expect(status?.textContent).toBe('Needs review from the platform t…');
    expect(status?.getAttribute('title')).toBe(status?.textContent);
    expect(h.querySelector('.bcard__tkey')?.textContent).toBe('RMB-412');
  });
});

describe('LinkedSessions', () => {
  const a = sess('a', 'A', 'cli:claude', 'running');
  const b = sess('b', 'B', 'shell:cmd', 'exited');

  it('empty sessions → no list', async () => {
    const h = await render(
      createElement(LinkedSessions, { sessions: [], agentLabel: label, onActivate: () => {} }),
    );
    expect(h.querySelector('ul')).toBeNull();
  });

  it('one row per session in input order, labelled by the template', async () => {
    const h = await render(
      createElement(LinkedSessions, { sessions: [a, b], agentLabel: label, onActivate: () => {} }),
    );
    expect(h.querySelector('ul')?.getAttribute('aria-label')).toBe('Linked sessions');
    expect(rows(h).map((r) => r.getAttribute('aria-label'))).toEqual([
      'A, claude, running',
      'B, shell, not running',
    ]);
    expect(rows(h).map((r) => r.querySelector('.bcard__sname')?.getAttribute('title'))).toEqual([
      'A',
      'B',
    ]);
    expect(rows(h).map((r) => r.querySelector('.bcard__sagent')?.textContent)).toEqual([
      'claude',
      'shell',
    ]);
    expect(rows(h).every((r) => r.type === 'button')).toBe(true);
  });

  it('stopped row carries bcard__session--stopped and the dot is aria-hidden', async () => {
    const h = await render(
      createElement(LinkedSessions, { sessions: [a, b], agentLabel: label, onActivate: () => {} }),
    );
    const [run, stop] = rows(h);
    expect(run.classList.contains('bcard__session--running')).toBe(true);
    expect(stop.classList.contains('bcard__session--stopped')).toBe(true);
    expect(stop.querySelector('.bcard__sdot')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('click calls onActivate with the id and stops propagation', async () => {
    const onActivate = vi.fn();
    const parent = vi.fn();
    const h = await render(
      createElement(
        'div',
        { onClick: parent },
        createElement(LinkedSessions, { sessions: [a, b], agentLabel: label, onActivate }),
      ),
    );
    await act(async () => rows(h)[1].click());
    expect(onActivate).toHaveBeenCalledWith('b');
    expect(parent).not.toHaveBeenCalled();
  });

  it('li children are keyed by session id', async () => {
    const h = await render(
      createElement(LinkedSessions, { sessions: [a, b], agentLabel: label, onActivate: () => {} }),
    );
    const [ra, rb] = rows(h);
    await render(
      createElement(LinkedSessions, { sessions: [b, a], agentLabel: label, onActivate: () => {} }),
    );
    const after = rows(h);
    expect(after[0]).toBe(rb);
    expect(after[1]).toBe(ra);
  });
});

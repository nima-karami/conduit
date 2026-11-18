// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ActivityEntry } from '../../src/conduit-mcp/activity-log';
import { PermissionsActivity } from '../../webview/components/permissions-activity';

it('queries the scoped activity and opens recorded facts by keyboard', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const row: ActivityEntry = {
    v: 1,
    id: '1',
    at: '2026-11-17T00:00:00.000Z',
    lane: 'observed',
    principal: { handle: 'agent', sessionId: 's1', machineId: null },
    cli: 'claude',
    action: 'open_file',
    target: '/a',
    summary: null,
    decision: null,
    decidedBy: 'cli',
    outcome: 'ok',
    durationMs: 4,
    requestId: null,
    count: null,
  };
  const getActivity = vi.fn(async () => ({
    rows: [row, { ...row, id: '2' }],
    next: 'cursor',
    writable: true,
    error: null,
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PermissionsActivity
        sessionId="s1"
        sessions={[{ id: 's1', name: 'Session One' }]}
        getActivity={getActivity}
      />,
    ),
  );
  expect(getActivity).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', limit: 50 }));
  expect(host.textContent).toContain('Observed');
  expect(host.textContent).toContain('Session One');
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('tbody button')];
  await act(async () => {
    buttons[0].focus();
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  expect(document.activeElement).toBe(buttons[1]);
  await act(async () => buttons[1].click());
  const details = host.querySelector('aside');
  expect(details?.textContent).toContain('observed CLI action');
  expect(details?.textContent).toContain('open_file · /a');
  expect(details?.textContent).not.toContain('How Conduit decided');
  expect(document.activeElement).toBe(details?.querySelector('h2'));
  await act(async () => details?.querySelector('button')?.click());
  expect(document.activeElement).toBe(buttons[1]);
  const more = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Load more');
  await act(async () => more?.click());
  expect(getActivity).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'cursor' }));
  await act(async () => root.unmount());
  host.remove();
});

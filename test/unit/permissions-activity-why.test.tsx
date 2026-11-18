// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ActivityEntry } from '../../src/conduit-mcp/activity-log';
import { PermissionsActivityWhy } from '../../webview/components/permissions-activity-why';

const row: ActivityEntry = {
  v: 1,
  id: 'a1',
  at: '2026-11-14T12:00:00.000Z',
  lane: 'conduit',
  principal: { handle: 'alpha', sessionId: 's1', machineId: null },
  cli: null,
  action: 'close_session',
  target: 's2',
  summary: null,
  decision: 'deny',
  decidedBy: 'deny',
  outcome: 'refused',
  durationMs: null,
  requestId: null,
  count: null,
  trace: {
    v: 1,
    decidedAt: '2026-11-14T11:59:59.000Z',
    facts: {
      v: 1,
      principal: {
        kind: 'session',
        sessionId: 's1',
        launchedCli: null,
        generation: 1,
        projectId: null,
      },
      tool: 'close_session',
      targets: [{ sessionId: 's2', path: null, folder: '/work', projectId: null }],
      masterOn: true,
      toYou: false,
      forceAsk: false,
    },
    decision: 'deny',
    reason: { by: 'deny', point: { kind: 'cli', cli: 'codex' } },
    rule: { when: null, reach: null, move: null },
    forcedAsk: false,
    assignment: {
      point: { kind: 'cli', cli: 'codex' },
      profileId: 'worker',
      profileName: 'Historical Worker',
    },
    runtime: { outcome: 'not-reached', code: null },
    stages: ['floors', 'explicit-deny'],
    withoutWinner: {
      decision: 'ask',
      reason: { by: 'profile', point: { kind: 'default' }, profileId: 'worker' },
    },
  },
};

it('shows recorded evidence and offers exact actions without executing the request', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onAllowOnce = vi.fn(async () => true);
  const onAddException = vi.fn();
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <PermissionsActivityWhy
        row={row}
        canAllowOnce
        onAllowOnce={onAllowOnce}
        onAddException={onAddException}
        onClose={onClose}
      />,
    ),
  );
  expect(host.textContent).toContain('Historical Worker');
  expect(host.textContent).toContain('Without this winner: ASK');
  expect(host.textContent).toContain('Runtime outcome: not-reached');
  expect(document.activeElement?.textContent).toContain('Why was this denied');
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent === label);
  await act(async () => button('Add exception')?.click());
  expect(onAddException).toHaveBeenCalledWith({
    row,
    tool: 'close_session',
    scope: { kind: 'session', sessionId: 's2' },
  });
  await act(async () => button('Allow this once')?.click());
  expect(onAllowOnce).toHaveBeenCalledWith(row);
  expect(host.textContent).toContain('agent may retry this target once');
  await act(async () =>
    host
      .querySelector('aside')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  host.remove();
});

it('does not invent an explanation or offer actions for observed or missing evidence', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    canAllowOnce: true,
    onAllowOnce: vi.fn(async () => true),
    onAddException: vi.fn(),
    onClose: vi.fn(),
  };
  const { trace: _trace, ...withoutTrace } = row;
  await act(async () =>
    root.render(<PermissionsActivityWhy {...props} row={{ ...withoutTrace, lane: 'observed' }} />),
  );
  expect(host.textContent).toContain('observed CLI action');
  expect(host.textContent).not.toContain('Allow this once');
  expect(host.textContent).not.toContain('Add exception');
  await act(async () => root.render(<PermissionsActivityWhy {...props} row={withoutTrace} />));
  expect(host.textContent).toContain('Decision details are unavailable');
  await act(async () => root.unmount());
  host.remove();
});

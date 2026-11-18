// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Assignment } from '../../src/conduit-mcp/policy-types';
import type { Session } from '../../src/types';
import { SessionPermissionActivity } from '../../webview/components/session-permission-activity';
import { SessionPermissionExceptions } from '../../webview/components/session-permission-exceptions';

const session: Session = {
  id: 's1',
  name: 'api',
  agentId: 'cli:claude',
  home: '/project',
  roots: [],
  status: 'running',
  createdAt: 1,
  lastActiveAt: 1,
  projectId: 'p1',
};
const mount = async (element: React.ReactNode) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, root };
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('edits and removes only selected exceptions while preserving pins and other fields', async () => {
  const initial: Assignment = {
    profileId: 'worker',
    onScreenOnly: false,
    pinned: ['open_session.when'],
    exceptions: [
      {
        tool: 'send_input',
        scope: { kind: 'session', sessionId: 's1' },
        rule: { decision: 'ask', reach: 'opened' },
      },
      {
        tool: 'open_file',
        scope: { kind: 'folder', path: '/project' },
        rule: { decision: 'deny' },
      },
    ],
  };
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <SessionPermissionExceptions
        session={session}
        assignment={value}
        disabled={false}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  const { host, root } = await mount(<Harness />);
  const decision = [...host.querySelectorAll('label')]
    .find((label) => label.textContent?.trim().startsWith('Decision'))
    ?.querySelector('select');
  expect(decision).toBeTruthy();
  await act(async () => {
    if (decision) {
      decision.value = 'allow';
      decision.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  expect(changed.mock.lastCall?.[0]).toEqual({
    ...initial,
    exceptions: [
      { ...initial.exceptions[0], rule: { decision: 'allow', reach: 'opened' } },
      initial.exceptions[1],
    ],
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label^="Remove exception 1"]')?.click(),
  );
  expect(changed.mock.lastCall?.[0]).toEqual({ ...initial, exceptions: [initial.exceptions[1]] });
  const add = [...host.querySelectorAll('button')].find(
    (element) => element.textContent === 'Add exception',
  );
  await act(async () => add?.click());
  expect(changed.mock.lastCall?.[0]).toEqual({
    ...initial,
    exceptions: [
      initial.exceptions[1],
      { tool: 'open_session', scope: { kind: 'anywhere' }, rule: { decision: 'ask' } },
    ],
  });
  await act(async () => root.unmount());
  host.remove();
});

it('queries and renders recent activity for the selected session', async () => {
  const getActivity = vi.fn(async () => ({
    rows: [
      {
        v: 1 as const,
        id: 'a1',
        at: '2026-11-17T12:00:00.000Z',
        lane: 'conduit' as const,
        principal: { handle: 'c', sessionId: 's1', machineId: null },
        cli: 'claude' as const,
        action: 'open_session',
        target: 'helper',
        summary: null,
        decision: 'ask' as const,
        decidedBy: 'profile',
        outcome: 'asked' as const,
        durationMs: null,
        requestId: null,
        count: null,
      },
    ],
    next: null,
    writable: true,
    error: null,
  }));
  const { host, root } = await mount(
    <SessionPermissionActivity sessionId="s1" getActivity={getActivity} />,
  );
  expect(getActivity).toHaveBeenCalledWith({ sessionId: 's1', limit: 5 });
  expect(host.textContent).toContain('open_session · helper · ask · asked');
  await act(async () => root.unmount());
  host.remove();
});

it('shows loading, empty and error states from the activity query', async () => {
  let finish:
    | ((page: { rows: []; next: null; writable: boolean; error: null }) => void)
    | undefined;
  const pending = new Promise<{ rows: []; next: null; writable: boolean; error: null }>(
    (resolve) => {
      finish = resolve;
    },
  );
  const { host, root } = await mount(
    <SessionPermissionActivity sessionId="s1" getActivity={() => pending} />,
  );
  expect(host.textContent).toContain('Loading activity');
  await act(async () => finish?.({ rows: [], next: null, writable: true, error: null }));
  expect(host.textContent).toContain('No recent activity');
  await act(async () =>
    root.render(<SessionPermissionActivity sessionId="s2" getActivity={async () => null} />),
  );
  expect(host.textContent).toContain('Activity could not be loaded');
  await act(async () => root.unmount());
  host.remove();
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { PolicyUiState } from '../../src/conduit-mcp/policy-types';
import type { Session } from '../../src/types';
import { PermissionsAssignments } from '../../webview/components/permissions-assignments';
import type { ConduitMcpApi } from '../../webview/use-conduit-mcp';

it('seeds an editable exact exception, preserves its fields, and replays the full draft', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const point = { kind: 'session' as const, sessionId: 's1' };
  const assignment = {
    profileId: 'worker' as const,
    exceptions: [
      {
        tool: 'close_session' as const,
        scope: { kind: 'session' as const, sessionId: 's2' },
        rule: { decision: 'deny' as const, reach: 'opened' as const },
      },
    ],
    onScreenOnly: false,
    applyNative: true,
    pinned: ['close_session.reach'],
  };
  const policy: PolicyUiState = {
    editToken: 'v1',
    saveError: null,
    backupWarning: null,
    profiles: [...BUILT_IN_PROFILES],
    assignments: [{ point, assignment }],
    sessions: {
      s1: {
        profileId: 'worker',
        profileName: 'Worker',
        exceptions: 1,
        source: 'session',
        label: null,
        sourcePoint: point,
        inheritedPoint: { kind: 'default' },
        inheritedProfileId: 'worker',
        launchedCli: null,
      },
    },
    grants: [],
    legacy: { global: {}, byCli: {}, sessions: {} },
    readOnly: false,
  };
  const session: Session = {
    id: 's1',
    name: 'First',
    agentId: 'agent',
    home: '/work',
    roots: [],
    status: 'running',
    createdAt: 0,
    lastActiveAt: 0,
  };
  const replayPolicy = vi.fn(async () => ({
    ok: true as const,
    editToken: 'v1',
    sampled: 12,
    changed: 3,
    skipped: { aggregate: 2, legacy: 1, incomplete: 4, remote: 5 },
    truncated: true,
    since: '2026-11-07T00:00:00.000Z',
  }));
  const previewPolicy = vi.fn(async () => null);
  const reviewLocalPolicy = vi.fn(async () => ({
    ok: true as const,
    requiresNativeReview: false as const,
  }));
  const saveAssignment = vi.fn();
  const mcp = {
    replayPolicy,
    previewPolicy,
    reviewLocalPolicy,
    saveAssignment,
  } as unknown as ConduitMcpApi;
  const onExceptionSeedConsumed = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PermissionsAssignments
        policy={policy}
        sessions={[session]}
        mcp={mcp}
        serverConnected
        exceptionSeed={{
          sessionId: 's1',
          tool: 'close_session',
          scope: { kind: 'session', sessionId: 's2' },
        }}
        onExceptionSeedConsumed={onExceptionSeedConsumed}
      />,
    ),
  );
  expect(onExceptionSeedConsumed).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Edit assignment');
  const button = (name: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent === name);
  const check = [...host.querySelectorAll('h3')]
    .find((element) => element.textContent === 'Check a request')
    ?.closest('section');
  const labels = [...(check?.querySelectorAll('label') ?? [])];
  for (const name of ['Session', 'Target session']) {
    const field = labels.find((label) => label.textContent === name)?.control;
    if (!(field instanceof HTMLSelectElement)) throw new Error(`Missing ${name} control`);
    await act(async () => {
      field.value = 's1';
      field.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  await act(async () => button('Check request')?.click());
  expect(previewPolicy).toHaveBeenCalledWith(
    's1',
    { tool: 'close_session', targetSessionId: 's1' },
    expect.objectContaining({ point }),
    'v1',
  );
  await act(async () => button('Compare Activity')?.click());
  expect(replayPolicy).toHaveBeenCalledWith(
    {
      point,
      assignment: {
        ...assignment,
        exceptions: [{ ...assignment.exceptions[0], rule: { decision: 'allow', reach: 'opened' } }],
      },
    },
    'v1',
  );
  expect(host.textContent).toContain('3 changed of 12 evaluated');
  expect(host.textContent).toContain('newest 1,000 eligible');
  expect(host.textContent).toContain('2 aggregated, 1 without traces, 4 incomplete, 5 remote');
  expect(saveAssignment).not.toHaveBeenCalled();
  await act(async () => button('Review changes')?.click());
  expect(reviewLocalPolicy).toHaveBeenCalledOnce();
  expect(saveAssignment).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  host.remove();
});

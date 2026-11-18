// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { LocalPolicyEdit, PolicyUiState } from '../../src/conduit-mcp/policy-types';
import type { Session } from '../../src/types';
import { SessionPermissionsController } from '../../webview/components/session-permissions-controller';
import type { ConduitMcpApi } from '../../webview/use-conduit-mcp';

it.each([false, true])('binds the draft to its policy token (stale=%s)', async (stale) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const session: Session = {
    id: 's1',
    name: 'api',
    agentId: 'cli:claude',
    home: '/p',
    roots: [],
    status: 'running',
    createdAt: 1,
    lastActiveAt: 1,
  };
  const policy: PolicyUiState = {
    editToken: 'token',
    saveError: null,
    backupWarning: null,
    profiles: [...BUILT_IN_PROFILES],
    assignments: [],
    sessions: {
      s1: {
        profileId: 'worker',
        profileName: 'Worker',
        exceptions: 0,
        source: 'default',
        label: null,
        sourcePoint: { kind: 'default' },
        inheritedPoint: { kind: 'default' },
        inheritedProfileId: 'worker',
        launchedCli: 'claude',
      },
    },
    grants: [],
    legacy: { global: {}, byCli: {}, sessions: {} },
    readOnly: false,
  };
  const approved = {
    ok: true as const,
    requiresNativeReview: true as const,
    digest: 'digest',
  };
  let resolveReview: ((value: typeof approved) => void) | undefined;
  const reviewLocalPolicy = vi.fn(
    (_edit: LocalPolicyEdit, _token: string) =>
      new Promise<typeof approved>((resolve) => {
        resolveReview = resolve;
      }),
  );
  const saveAssignment = vi.fn(async () => ({ ok: true as const }));
  const mcp = {
    state: null,
    reviewLocalPolicy,
    saveAssignment,
    retryPolicy: async () => ({ ok: true as const }),
    getActivity: async () => ({ rows: [], next: null, writable: true, error: null }),
  } as unknown as ConduitMcpApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (currentPolicy: PolicyUiState) =>
    act(async () =>
      root.render(
        <SessionPermissionsController
          session={session}
          policy={currentPolicy}
          native={{ atLaunch: null, next: { status: 'not-applicable' } }}
          mcp={mcp}
          onClose={() => {}}
          onOpenSettings={() => {}}
          onOpenActivity={() => {}}
          onRelaunch={async () => {}}
        />,
      ),
    );
  await render(policy);
  const lead = [...document.querySelectorAll('label')]
    .find((label) => label.textContent?.trim() === 'Lead')
    ?.querySelector('input');
  expect(lead).toBeTruthy();
  await act(async () => lead?.click());
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((element) => element.textContent === label);
  if (stale) {
    await render({ ...policy, editToken: 'new' });
    expect(button('Review changes')?.disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Close and reopen');
    await act(async () => button('Review changes')?.click());
    expect(reviewLocalPolicy).not.toHaveBeenCalled();
    expect(saveAssignment).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    host.remove();
    return;
  }
  await act(async () => button('Review changes')?.click());
  expect(reviewLocalPolicy).toHaveBeenCalledOnce();
  const dialog = document.querySelector('[role="dialog"]');
  expect(document.activeElement).toBe(dialog);
  const tab = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  dialog?.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  expect(dialog?.contains(document.activeElement)).toBe(true);
  await act(async () => resolveReview?.(approved));
  expect(document.activeElement).toBe(button('Back'));
  await act(async () => button('Back')?.click());
  expect(document.activeElement).toBe(button('Review changes'));
  await act(async () => button('Review changes')?.click());
  await act(async () => resolveReview?.(approved));
  const edit = reviewLocalPolicy.mock.calls[0]?.[0] as unknown as { assignment: unknown };
  await act(async () => button('Apply')?.click());
  expect(saveAssignment).toHaveBeenCalledWith(
    { kind: 'session', sessionId: 's1' },
    edit.assignment,
    'token',
    'digest',
  );
  await act(async () => root.unmount());
  host.remove();
});

it('ignores a link result from an earlier launch after the new launch is queried', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const session: Session = {
    id: 's1',
    name: 'api',
    agentId: 'cli:claude',
    home: '/p',
    roots: [],
    status: 'running',
    createdAt: 1,
    lastActiveAt: 1,
  };
  const policy: PolicyUiState = {
    editToken: 'token',
    saveError: null,
    backupWarning: null,
    profiles: [...BUILT_IN_PROFILES],
    assignments: [],
    sessions: {
      s1: {
        profileId: 'worker',
        profileName: 'Worker',
        exceptions: 0,
        source: 'default',
        label: null,
        sourcePoint: { kind: 'default' },
        inheritedPoint: { kind: 'default' },
        inheritedProfileId: 'worker',
        launchedCli: 'claude',
      },
    },
    grants: [],
    legacy: { global: {}, byCli: {}, sessions: {} },
    readOnly: false,
  };
  const runtime = (generation: number) => ({
    generation,
    spawn: 'live' as const,
    reportedStatus: null,
    lastSize: null,
  });
  const view = (sandbox: 'read-only' | 'workspace-write') => ({
    status: 'linked' as const,
    source: 'linked-codex-thread' as const,
    freshness: 'current' as const,
    reading: { status: 'known' as const, sandbox, approval: 'on-request' as const, reportedAt: 1 },
    lastKnown: null,
  });
  let resolveOld: ((result: ReturnType<typeof view>) => void) | undefined;
  const linkCodexThread = vi.fn(
    () =>
      new Promise<ReturnType<typeof view>>((resolve) => {
        resolveOld = resolve;
      }),
  );
  const mcp = {
    state: null,
    linkCodexThread,
    codexPostureQuery: async (_id: string, generation: number) =>
      generation === 2 ? view('workspace-write') : { status: 'unavailable' as const },
    retryPolicy: async () => ({ ok: true as const }),
    getActivity: async () => ({ rows: [], next: null, writable: true, error: null }),
  } as unknown as ConduitMcpApi;
  const native = {
    atLaunch: {
      intent: { family: 'codex' as const, optedIn: false, requested: null },
      preparedAt: 1,
    },
    next: { status: 'not-applicable' as const },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (generation: number) =>
    root.render(
      <SessionPermissionsController
        session={{ ...session, runtime: runtime(generation) }}
        policy={policy}
        native={native}
        mcp={mcp}
        onClose={() => {}}
        onOpenSettings={() => {}}
        onOpenActivity={() => {}}
        onRelaunch={async () => {}}
      />,
    );
  await act(async () => render(1));
  const input = document.querySelector<HTMLInputElement>('input.modal__input');
  expect(input).toBeTruthy();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '123');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const link = [...document.querySelectorAll('button')].find(
    (element) => element.textContent === 'Link thread',
  );
  await act(async () => link?.click());
  expect(linkCodexThread).toHaveBeenCalledOnce();
  await act(async () => render(2));
  expect(document.body.textContent).toContain('workspace-write');
  await act(async () => resolveOld?.(view('read-only')));
  expect(document.body.textContent).toContain('workspace-write');
  expect(document.body.textContent).not.toContain('read-only');
  expect(document.body.textContent).not.toContain('Could not link the thread');
  await act(async () => root.unmount());
  host.remove();
});

it('offers a guarded relaunch for a recognized dormant session', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const session: Session = {
    id: 's1',
    name: 'api',
    agentId: 'cli:claude',
    home: '/p',
    roots: [],
    status: 'running',
    createdAt: 1,
    lastActiveAt: 1,
  };
  const policy: PolicyUiState = {
    editToken: 'token',
    saveError: null,
    backupWarning: null,
    profiles: [...BUILT_IN_PROFILES],
    assignments: [],
    sessions: {
      s1: {
        profileId: 'worker',
        profileName: 'Worker',
        exceptions: 0,
        source: 'default',
        label: null,
        sourcePoint: { kind: 'default' },
        inheritedPoint: { kind: 'default' },
        inheritedProfileId: 'worker',
        launchedCli: 'claude',
      },
    },
    grants: [],
    legacy: { global: {}, byCli: {}, sessions: {} },
    readOnly: false,
  };
  const mcp = {
    state: null,
    reviewLocalPolicy: async () => ({
      ok: true as const,
      requiresNativeReview: true as const,
      digest: 'digest',
    }),
    saveAssignment: async () => ({ ok: true as const }),
    retryPolicy: async () => ({ ok: true as const }),
    getActivity: async () => ({ rows: [], next: null, writable: true, error: null }),
  } as unknown as ConduitMcpApi;
  const relaunch = vi.fn(async (_id: string, _generation: number | null) => {});
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SessionPermissionsController
        session={{
          ...session,
          status: 'exited',
          runtime: { generation: null, spawn: 'none', reportedStatus: null, lastSize: null },
        }}
        policy={policy}
        native={{
          atLaunch: null,
          next: {
            status: 'available',
            intent: { family: 'claude', optedIn: false, requested: null },
          },
        }}
        mcp={mcp}
        onClose={() => {}}
        onOpenSettings={() => {}}
        onOpenActivity={() => {}}
        onRelaunch={relaunch}
      />,
    ),
  );
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((element) => element.textContent === label);
  await act(async () => button('Review changes')?.click());
  expect(button('Apply and relaunch')).toBeTruthy();
  await act(async () => button('Apply and relaunch')?.click());
  expect(relaunch).toHaveBeenCalledWith('s1', null);
  await act(async () => root.unmount());
  host.remove();
});

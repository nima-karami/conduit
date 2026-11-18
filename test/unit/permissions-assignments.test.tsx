// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { LocalPolicyEdit, PolicyUiState } from '../../src/conduit-mcp/policy-types';
import { PermissionsAssignments } from '../../webview/components/permissions-assignments';
import type { ConduitMcpApi } from '../../webview/use-conduit-mcp';

it('reviews and saves the frozen assignment with the token and native digest', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const policy: PolicyUiState = {
    editToken: 'v1',
    saveError: null,
    backupWarning: null,
    profiles: [...BUILT_IN_PROFILES],
    assignments: [],
    sessions: {},
    grants: [],
    legacy: { global: {}, byCli: {}, sessions: {} },
    readOnly: false,
  };
  const reviewLocalPolicy = vi.fn(async (_edit: LocalPolicyEdit, _token: string) => ({
    ok: true as const,
    requiresNativeReview: true as const,
    digest: 'digest',
  }));
  const saveAssignment = vi.fn(async () => ({ ok: true as const }));
  const mcp = { reviewLocalPolicy, saveAssignment } as unknown as ConduitMcpApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<PermissionsAssignments policy={policy} sessions={[]} mcp={mcp} serverConnected />),
  );
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text);
    expect(button).toBeTruthy();
    await act(async () => button?.click());
  };
  await click('Add assignment');
  const native = [...host.querySelectorAll('input')].find((input) =>
    input.parentElement?.textContent?.includes('native modes'),
  );
  await act(async () => native?.click());
  await click('Review changes');
  expect(reviewLocalPolicy).toHaveBeenCalledOnce();
  expect(saveAssignment).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Before');
  expect(host.textContent).toContain('After');
  const candidate = reviewLocalPolicy.mock.calls[0][0];
  expect(candidate).toMatchObject({
    kind: 'assignment',
    point: { kind: 'default' },
    assignment: { applyNative: true },
  });
  await click('Confirm and save');
  expect(saveAssignment).toHaveBeenCalledWith(
    { kind: 'default' },
    candidate.kind === 'assignment' ? candidate.assignment : null,
    'v1',
    'digest',
  );
  await act(async () => root.unmount());
  host.remove();
});

it('resets a row from the table through review, and lists exceptions as a count', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const policy: PolicyUiState = {
    editToken: 'v2',
    saveError: null,
    backupWarning: null,
    profiles: [...BUILT_IN_PROFILES],
    assignments: [
      {
        point: { kind: 'cli', cli: 'claude' },
        assignment: {
          profileId: 'lead',
          onScreenOnly: false,
          exceptions: [
            { tool: 'close_session', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
            { tool: 'open_file', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
          ],
        },
      },
    ],
    sessions: {},
    grants: [],
    legacy: { global: {}, byCli: {}, sessions: {} },
    readOnly: false,
  };
  const reviewLocalPolicy = vi.fn(async (_edit: LocalPolicyEdit, _token: string) => ({
    ok: true as const,
  }));
  const saveAssignment = vi.fn(async () => ({ ok: true as const }));
  const mcp = { reviewLocalPolicy, saveAssignment } as unknown as ConduitMcpApi;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<PermissionsAssignments policy={policy} sessions={[]} mcp={mcp} serverConnected />),
  );
  const row = [...host.querySelectorAll('tr')].find((tr) =>
    tr.textContent?.startsWith('claude sessions'),
  );
  expect(row?.textContent).toContain('2 exceptions');
  expect(row?.textContent).not.toContain('close_session');
  expect(host.querySelector('[aria-label="Reset assignment · Default"]')).toBeNull();
  const reset = host.querySelector<HTMLButtonElement>(
    '[aria-label="Reset assignment · claude sessions"]',
  );
  expect(reset).toBeTruthy();
  await act(async () => reset?.click());
  expect(reviewLocalPolicy).toHaveBeenCalledWith(
    { kind: 'assignment', point: { kind: 'cli', cli: 'claude' }, assignment: null },
    'v2',
  );
  expect(saveAssignment).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Before');
  await act(async () => root.unmount());
  host.remove();
});

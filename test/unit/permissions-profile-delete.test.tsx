// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { PolicyUiState, Profile } from '../../src/conduit-mcp/policy-types';
import { PermissionsSettings } from '../../webview/components/permissions-settings';

const api = vi.hoisted(() => ({
  state: {
    policy: {
      editToken: 'v1',
      readOnly: false,
      profiles: [] as Profile[],
      assignments: [] as PolicyUiState['assignments'],
    },
  },
  reviewLocalPolicy: vi.fn(),
  deleteProfile: vi.fn(),
}));
vi.mock('../../webview/use-conduit-mcp', () => ({ useConduitMcp: () => api }));
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

it('requires replacement, reviews exact deletion and confirms the returned digest', async () => {
  const profile = {
    ...structuredClone(BUILT_IN_PROFILES[1]),
    id: 'p-custom' as const,
    name: 'Custom',
    builtIn: false,
  };
  api.state.policy.profiles = [profile];
  api.state.policy.assignments = [
    {
      point: { kind: 'default' },
      assignment: { profileId: profile.id, exceptions: [], onScreenOnly: false, applyNative: true },
    },
  ];
  api.state.policy.editToken = 'v1';
  api.reviewLocalPolicy.mockResolvedValue({
    ok: true,
    requiresNativeReview: true,
    digest: 'exact-digest',
  });
  api.deleteProfile.mockResolvedValue({ ok: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<PermissionsSettings serverConnected />));
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === label || b.getAttribute('aria-label') === label,
    );
    expect(button).toBeTruthy();
    await act(async () => button?.click());
  };
  await click('Delete Custom');
  expect(host.textContent).toContain('Default · native modes enabled');
  expect(
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Review deletion')?.disabled,
  ).toBe(true);
  const select = host.querySelector('select') as HTMLSelectElement;
  await act(async () => {
    select.value = 'lead';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('Review deletion');
  expect(api.reviewLocalPolicy).toHaveBeenCalledWith(
    { kind: 'delete-profile', profileId: 'p-custom', replacement: 'lead' },
    'v1',
  );
  expect(api.deleteProfile).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Before and after');
  expect(host.textContent).toContain('authorizes the reviewed native mode changes');
  await click('Confirm deletion');
  expect(api.deleteProfile).toHaveBeenCalledWith('p-custom', 'lead', 'v1', 'exact-digest');
  await act(async () => root.unmount());
  host.remove();
});

it('blocks a stale review from being confirmed', async () => {
  const profile = {
    ...structuredClone(BUILT_IN_PROFILES[1]),
    id: 'p-stale' as const,
    name: 'Stale',
    builtIn: false,
  };
  api.state.policy.profiles = [profile];
  api.state.policy.assignments = [];
  api.state.policy.editToken = 'v1';
  api.reviewLocalPolicy.mockClear().mockResolvedValue({ ok: true, requiresNativeReview: false });
  api.deleteProfile.mockClear();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<PermissionsSettings serverConnected />));
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Delete Stale"]')?.click(),
  );
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Review deletion')?.click(),
  );
  api.state.policy.editToken = 'v2';
  await act(async () => root.render(<PermissionsSettings serverConnected />));
  expect(host.textContent).toContain('Permissions changed');
  const confirm = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Confirm deletion',
  );
  expect(confirm?.disabled).toBe(true);
  await act(async () => confirm?.click());
  expect(api.deleteProfile).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  host.remove();
});

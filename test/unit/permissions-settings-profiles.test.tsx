// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { Profile } from '../../src/conduit-mcp/policy-types';
import { PermissionsRoles } from '../../webview/components/permissions-roles';

const api = vi.hoisted(() => ({
  state: { policy: { editToken: 'v1', readOnly: false, profiles: [] as Profile[] } },
  reviewLocalPolicy: vi.fn(),
  saveProfile: vi.fn(),
}));
vi.mock('../../webview/use-conduit-mcp', () => ({ useConduitMcp: () => api }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

it('reviews the frozen copy and requires confirmation before saving its digest', async () => {
  api.reviewLocalPolicy.mockImplementation(async ({ profile }: { profile: Profile }) => ({
    ok: true,
    requiresNativeReview: true,
    digest: 'reviewed',
    profileDisplay: {
      before: null,
      after: profile,
      optedInPoints: [{ kind: 'default' }],
      affectedSessions: [{ sessionId: 's1', family: 'claude', point: { kind: 'default' } }],
      truncated: false,
    },
  }));
  api.saveProfile.mockResolvedValue({ ok: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PermissionsRoles
        serverConnected
        mcp={api as never}
        registerBack={() => {}}
        sessions={[{ id: 's1', name: 'Lane one' } as import('../../src/types').Session]}
      />,
    ),
  );
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(
      (element) => element.textContent === label || element.getAttribute('aria-label') === label,
    );
    expect(button).toBeTruthy();
    await act(async () => button?.click());
  };
  await click(`Copy ${BUILT_IN_PROFILES[0].name}`);
  await click('Review and save');
  expect(api.reviewLocalPolicy).toHaveBeenCalledOnce();
  expect(api.saveProfile).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Before');
  expect(host.textContent).toContain('After');
  expect(host.textContent).toContain('Tool rules in the new profile');
  expect(host.textContent).toContain('open_session');
  expect(host.textContent).toContain('Default assignment');
  expect(host.textContent).toContain('Lane one · claude · default assignment');
  const candidate = api.reviewLocalPolicy.mock.calls[0][0].profile;
  expect(candidate.builtIn).toBe(false);
  await click('Confirm and save');
  expect(api.saveProfile).toHaveBeenCalledWith(candidate, 'v1', 'reviewed');
  await act(async () => root.unmount());
});

it('shows only changed custom rules, including their conditions, in the review', async () => {
  const profile: Profile = {
    ...structuredClone(BUILT_IN_PROFILES[1]),
    id: 'p-custom',
    name: 'Custom',
    builtIn: false,
  };
  api.state.policy.profiles = [profile];
  api.reviewLocalPolicy.mockImplementation(
    async ({ profile: candidate }: { profile: Profile }) => ({
      ok: true,
      requiresNativeReview: false,
      profileDisplay: {
        before: profile,
        after: candidate,
        optedInPoints: [],
        affectedSessions: [],
        truncated: false,
      },
    }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PermissionsRoles serverConnected mcp={api as never} sessions={[]} registerBack={() => {}} />,
    ),
  );
  const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit Custom"]');
  await act(async () => edit?.click());
  const group = host.querySelector('[aria-label="open_session decision"]');
  const next = profile.rules.open_session.decision === 'deny' ? 'allow' : 'deny';
  await act(async () => group?.querySelector<HTMLButtonElement>(`[data-seg="${next}"]`)?.click());
  const review = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Review and save',
  );
  await act(async () => review?.click());
  const rows = [...host.querySelectorAll('tbody tr')];
  const changed = rows.filter((row) => row.querySelector('th')?.textContent === 'open_session');
  expect(changed).toHaveLength(1);
  expect(changed[0].textContent).toContain(profile.rules.open_session.decision);
  expect(changed[0].textContent).toContain(next);
  if (profile.rules.open_session.when)
    expect(changed[0].textContent).toContain(profile.rules.open_session.when);
  expect(rows.some((row) => row.querySelector('th')?.textContent === 'read_screen')).toBe(false);
  await act(async () => root.unmount());
  api.state.policy.profiles = [];
});

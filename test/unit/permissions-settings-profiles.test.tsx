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

const selectRole = async (host: HTMLElement, name: string) => {
  const row = [...host.querySelectorAll('tbody tr')].find((tr) =>
    tr.querySelector('th')?.textContent?.startsWith(name),
  );
  expect(row).toBeTruthy();
  await act(async () => (row as HTMLElement).click());
};

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
  await selectRole(host, BUILT_IN_PROFILES[0].name);
  await click('Duplicate role');
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

it('opens Sessions by default and reveals other groups and options on demand', async () => {
  const profile: Profile = {
    ...structuredClone(BUILT_IN_PROFILES[1]),
    id: 'p-custom',
    name: 'Custom',
    builtIn: false,
  };
  api.state.policy.profiles = [profile];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PermissionsRoles serverConnected mcp={api as never} sessions={[]} registerBack={() => {}} />,
    ),
  );
  await selectRole(host, 'Custom');
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Edit')?.click(),
  );
  expect(host.querySelector('[aria-label="open_session decision"]')).toBeTruthy();
  expect(host.querySelector('[aria-label="send_message decision"]')).toBeNull();
  expect(host.querySelector('.permissions-profile-editor .permissions-pill')).toBeTruthy();
  const messaging = [...host.querySelectorAll('summary')].find((s) =>
    s.textContent?.startsWith('Messaging'),
  );
  await act(async () => messaging?.click());
  expect(host.querySelector('[aria-label="send_message decision"]')).toBeTruthy();
  const row = host.querySelector('[aria-label="open_session decision"]')?.closest('.policyrow');
  expect(row?.querySelector('select')).toBeNull();
  const more = [...(row?.querySelectorAll('summary') ?? [])].find(
    (s) => s.textContent === 'More options',
  );
  await act(async () => more?.click());
  expect(row?.querySelector('select')).toBeTruthy();
  await act(async () => root.unmount());
  api.state.policy.profiles = [];
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
  await selectRole(host, 'Custom');
  const edit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Edit');
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

it('steps back review, editor, drawer, closed, then reports nothing left', async () => {
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
  const registerBack = vi.fn();
  const back = () => (registerBack.mock.lastCall?.[0] as (() => boolean) | null)?.();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PermissionsRoles
        serverConnected
        mcp={api as never}
        sessions={[]}
        registerBack={registerBack}
      />,
    ),
  );
  expect(back()).toBe(false);
  await selectRole(host, 'Custom');
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Edit')?.click(),
  );
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Review and save')?.click(),
  );
  expect(host.textContent).toContain('Review profile changes');
  await act(async () => void back());
  expect(host.textContent).not.toContain('Review profile changes');
  expect(host.querySelector('.permissions-profile-editor')).toBeTruthy();
  await act(async () => void back());
  expect(host.querySelector('.permissions-profile-editor')).toBeNull();
  expect(host.querySelector('.permissions-drawer')).toBeTruthy();
  await act(async () => void back());
  expect(host.querySelector('.permissions-drawer')).toBeNull();
  expect(back()).toBe(false);
  await act(async () => root.unmount());
  api.state.policy.profiles = [];
});

it('counts assignments per role and tags the role that new agents start with', async () => {
  const profile: Profile = {
    ...structuredClone(BUILT_IN_PROFILES[1]),
    id: 'p-custom',
    name: 'Custom',
    builtIn: false,
  };
  const assignment = { exceptions: [], onScreenOnly: false, applyNative: false };
  const policy = api.state.policy as Record<string, unknown>;
  policy.profiles = [profile];
  policy.assignments = [
    { point: { kind: 'default' }, assignment: { ...assignment, profileId: 'p-custom' } },
    { point: { kind: 'cli', cli: 'claude' }, assignment: { ...assignment, profileId: 'worker' } },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PermissionsRoles serverConnected mcp={api as never} sessions={[]} registerBack={() => {}} />,
    ),
  );
  const row = (name: string) =>
    [...host.querySelectorAll('tbody tr')].find((tr) =>
      tr.querySelector('th')?.textContent?.startsWith(name),
    );
  expect(row('Custom')?.textContent).toContain('Used by 1 agent');
  expect(row('Custom')?.textContent).toContain('New agents start here');
  expect(row('Worker')?.textContent).toContain('Used by 1 agent');
  expect(row('Worker')?.textContent).not.toContain('New agents start here');
  await act(async () => root.unmount());
  policy.profiles = [];
  delete policy.assignments;
});

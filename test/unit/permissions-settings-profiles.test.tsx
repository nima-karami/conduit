// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { PolicyEditResult, PolicyUiState, Profile } from '../../src/conduit-mcp/policy-types';
import { PermissionsRoles } from '../../webview/components/permissions-roles';

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
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
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
        onViewAgents={() => {}}
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
  expect(host.textContent).toContain('Tool rules in the new role');
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
      <PermissionsRoles
        onViewAgents={() => {}}
        serverConnected
        mcp={api as never}
        sessions={[]}
        registerBack={() => {}}
      />,
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
      <PermissionsRoles
        onViewAgents={() => {}}
        serverConnected
        mcp={api as never}
        sessions={[]}
        registerBack={() => {}}
      />,
    ),
  );
  const row = [...host.querySelectorAll<HTMLElement>('tbody tr')].find((tr) =>
    tr.querySelector('th')?.textContent?.startsWith('Custom'),
  );
  await act(async () => {
    row?.focus();
    row?.click();
  });
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
        onViewAgents={() => {}}
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
  expect(host.textContent).toContain('Review role changes');
  await act(async () => void back());
  expect(host.textContent).not.toContain('Review role changes');
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
      <PermissionsRoles
        onViewAgents={() => {}}
        serverConnected
        mcp={api as never}
        sessions={[]}
        registerBack={() => {}}
      />,
    ),
  );
  const row = (name: string) =>
    [...host.querySelectorAll('tbody tr')].find((tr) =>
      tr.querySelector('th')?.textContent?.startsWith(name),
    );
  expect(row('Custom')?.querySelectorAll('td')[1]?.textContent).toBe('1 agent');
  expect(row('Custom')?.textContent).toContain('New agents start here');
  expect(row('Worker')?.querySelectorAll('td')[1]?.textContent).toBe('1 agent');
  expect(row('Worker')?.textContent).not.toContain('New agents start here');
  await act(async () => root.unmount());
  policy.profiles = [];
  policy.assignments = [];
});

const customRole = (): Profile => ({
  ...structuredClone(BUILT_IN_PROFILES[1]),
  id: 'p-custom',
  name: 'Custom',
  builtIn: false,
});

async function mountRoles() {
  const registerBack = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <PermissionsRoles
        onViewAgents={() => {}}
        serverConnected
        mcp={api as never}
        sessions={[]}
        registerBack={registerBack}
      />,
    ),
  );
  const back = () => (registerBack.mock.lastCall?.[0] as (() => boolean) | null)?.();
  const click = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === label || b.getAttribute('aria-label') === label,
    );
    expect(button).toBeTruthy();
    await act(async () => button?.click());
  };
  return { host, root, back, click };
}

const reviewOf =
  (before: Profile | null) =>
  async ({ profile }: { profile: Profile }) => ({
    ok: true as const,
    requiresNativeReview: false,
    profileDisplay: {
      before,
      after: profile,
      optedInPoints: [],
      affectedSessions: [],
      truncated: false,
    },
  });

it('has nothing left to step back from after the selected role is deleted', async () => {
  api.state.policy.profiles = [customRole()];
  api.reviewLocalPolicy.mockResolvedValue({ ok: true, requiresNativeReview: false });
  api.deleteProfile.mockImplementation(async () => {
    api.state.policy.profiles = [];
    return { ok: true };
  });
  const { host, root, back, click } = await mountRoles();
  await selectRole(host, 'Custom');
  await click('Delete');
  await click('Review deletion');
  await click('Confirm deletion');
  expect(host.querySelector('.permissions-drawer')).toBeNull();
  expect(back()).toBe(false);
  await act(async () => root.unmount());
  api.state.policy.profiles = [];
});

it('selects the saved copy after a duplicate is saved, then steps back off it', async () => {
  api.state.policy.profiles = [customRole()];
  api.reviewLocalPolicy.mockImplementation(reviewOf(null));
  api.saveProfile.mockImplementation(async (candidate: Profile) => {
    api.state.policy.profiles = [...api.state.policy.profiles, candidate];
    return { ok: true };
  });
  const { host, root, back, click } = await mountRoles();
  await selectRole(host, 'Custom');
  await click('Duplicate');
  await click('Review and save');
  await click('Confirm and save');
  expect(host.querySelector('.permissions-drawer__title')?.textContent).toBe('Custom copy');
  expect(back()).toBe(true);
  await act(async () => void 0);
  expect(host.querySelector('.permissions-drawer')).toBeNull();
  expect(back()).toBe(false);
  await act(async () => root.unmount());
  api.state.policy.profiles = [];
});

it('does not open the review once the editor was backed out of mid-request', async () => {
  const profile = customRole();
  api.state.policy.profiles = [profile];
  let resolve: (result: unknown) => void = () => {};
  api.reviewLocalPolicy.mockImplementation(() => new Promise<unknown>((r) => (resolve = r)));
  const { host, root, back, click } = await mountRoles();
  await selectRole(host, 'Custom');
  await click('Edit');
  await click('Review and save');
  await act(async () => void back());
  expect(host.querySelector('.permissions-profile-editor')).toBeNull();
  await act(async () =>
    resolve({
      ok: true,
      requiresNativeReview: false,
      profileDisplay: {
        before: profile,
        after: profile,
        optedInPoints: [],
        affectedSessions: [],
        truncated: false,
      },
    }),
  );
  expect(host.textContent).not.toContain('Review role changes');
  expect(host.querySelector('.permissions-profile-editor')).toBeNull();
  await act(async () => root.unmount());
  api.state.policy.profiles = [];
});

it('steps back a reviewed deletion, then the deletion, then the drawer', async () => {
  api.state.policy.profiles = [customRole()];
  api.reviewLocalPolicy.mockResolvedValue({ ok: true, requiresNativeReview: false });
  const { host, root, back, click } = await mountRoles();
  await selectRole(host, 'Custom');
  await click('Delete');
  await click('Review deletion');
  expect(host.textContent).toContain('Before and after');
  await act(async () => void back());
  expect(host.textContent).not.toContain('Before and after');
  expect(host.querySelector('section[aria-label="Delete role"]')).toBeTruthy();
  await act(async () => void back());
  expect(host.querySelector('section[aria-label="Delete role"]')).toBeNull();
  expect(host.querySelector('.permissions-drawer')).toBeTruthy();
  expect(back()).toBe(true);
  await act(async () => void 0);
  expect(back()).toBe(false);
  await act(async () => root.unmount());
  api.state.policy.profiles = [];
});

it('swallows Esc while a save is in flight and steps back once it settles', async () => {
  api.state.policy.profiles = [customRole()];
  api.reviewLocalPolicy.mockImplementation(reviewOf(customRole()));
  let settle: (result: PolicyEditResult) => void = () => {};
  api.saveProfile.mockImplementation(() => new Promise<PolicyEditResult>((r) => (settle = r)));
  const { host, root, back, click } = await mountRoles();
  await selectRole(host, 'Custom');
  await click('Edit');
  await click('Review and save');
  await click('Confirm and save');
  expect(back()).toBe(true);
  await act(async () => void 0);
  expect(host.textContent).toContain('Review role changes');
  await act(async () => settle({ ok: false, error: 'conflict' }));
  expect(host.textContent).toContain('Could not save role');
  await act(async () => void back());
  expect(host.textContent).not.toContain('Review role changes');
  expect(host.querySelector('.permissions-profile-editor')).toBeTruthy();
  await act(async () => root.unmount());
  api.state.policy.profiles = [];
});

it('names every per-tool select after its tool', async () => {
  api.state.policy.profiles = [customRole()];
  const { host, root, click } = await mountRoles();
  await selectRole(host, 'Custom');
  await click('Edit');
  const row = host.querySelector('[aria-label="open_session decision"]')?.closest('.policyrow');
  const more = [...(row?.querySelectorAll('summary') ?? [])].find(
    (s) => s.textContent === 'More options',
  );
  await act(async () => more?.click());
  expect(host.querySelectorAll('[aria-label="open_session Screen condition"]')).toHaveLength(1);
  expect(host.querySelectorAll('[aria-label="open_session Move"]')).toHaveLength(1);
  expect(host.querySelectorAll('select[aria-label$="Screen condition"]')).toHaveLength(1);
  await act(async () => root.unmount());
  api.state.policy.profiles = [];
});

it('keeps focus in the side panel when Edit swaps the drawer for the editor', async () => {
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
      <PermissionsRoles
        onViewAgents={() => {}}
        serverConnected
        mcp={api as never}
        sessions={[]}
        registerBack={() => {}}
      />,
    ),
  );
  const row = [...host.querySelectorAll<HTMLElement>('tbody tr')].find((tr) =>
    tr.querySelector('th')?.textContent?.startsWith('Custom'),
  );
  await act(async () => {
    row?.focus();
    row?.click();
  });
  const edit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Edit');
  await act(async () => {
    edit?.focus();
    edit?.click();
  });
  await act(async () => void 0);
  expect(document.activeElement?.textContent).toBe('Edit role · Custom');
  await act(async () => root.unmount());
});

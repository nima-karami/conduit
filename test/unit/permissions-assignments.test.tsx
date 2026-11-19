// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type {
  Assignment,
  AssignmentPoint,
  LocalPolicyEdit,
  PolicyUiState,
} from '../../src/conduit-mcp/policy-types';
import type { Session } from '../../src/types';
import type { BackHandler } from '../../webview/components/mcp-section';
import { PermissionsAssignments } from '../../webview/components/permissions-assignments';
import type { ConduitMcpApi } from '../../webview/use-conduit-mcp';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const session = (id: string, name: string): Session => ({
  id,
  name,
  agentId: 'agent',
  home: '/work',
  roots: [],
  status: 'running',
  createdAt: 0,
  lastActiveAt: 0,
});
const sessionRow = (id: string, point: AssignmentPoint) => ({
  profileId: 'worker' as const,
  profileName: 'Worker',
  exceptions: 0,
  source: 'default' as const,
  label: null,
  sourcePoint: point,
  inheritedPoint: { kind: 'default' } as AssignmentPoint,
  inheritedProfileId: 'worker' as const,
  launchedCli: null,
  id,
});
function policyWith(
  assignments: PolicyUiState['assignments'] = [],
  sessionIds: string[] = [],
): PolicyUiState {
  return {
    editToken: 'v1',
    saveError: null,
    backupWarning: null,
    profiles: [...BUILT_IN_PROFILES],
    assignments,
    sessions: Object.fromEntries(
      sessionIds.map((id) => [id, sessionRow(id, { kind: 'default' })]),
    ) as PolicyUiState['sessions'],
    grants: [],
    legacy: { global: {}, byCli: {}, sessions: {} },
    readOnly: false,
  };
}

type Mount = {
  host: HTMLElement;
  root: Root;
  reviewLocalPolicy: ReturnType<typeof vi.fn>;
  saveAssignment: ReturnType<typeof vi.fn>;
  back: () => BackHandler | null;
  render(over?: {
    policy?: PolicyUiState;
    sessions?: Session[];
    focusAgentKey?: string;
  }): Promise<void>;
};
async function mount(initial: {
  policy?: PolicyUiState;
  sessions?: Session[];
  focusAgentKey?: string;
  onFocusAgentSpent?: () => void;
  reviewResult?: unknown;
}): Promise<Mount> {
  const reviewLocalPolicy = vi.fn(
    async (_edit: LocalPolicyEdit, _token: string) =>
      initial.reviewResult ?? { ok: true as const, requiresNativeReview: false as const },
  );
  const saveAssignment = vi.fn(async () => ({ ok: true as const }));
  const mcp = { reviewLocalPolicy, saveAssignment } as unknown as ConduitMcpApi;
  let handler: BackHandler | null = null;
  const registerBack = (next: BackHandler | null) => {
    handler = next;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (
    over: { policy?: PolicyUiState; sessions?: Session[]; focusAgentKey?: string } = {},
  ) =>
    act(async () =>
      root.render(
        <PermissionsAssignments
          policy={over.policy ?? initial.policy ?? policyWith()}
          sessions={over.sessions ?? initial.sessions ?? []}
          mcp={mcp}
          serverConnected
          focusAgentKey={'focusAgentKey' in over ? over.focusAgentKey : initial.focusAgentKey}
          onFocusAgentSpent={initial.onFocusAgentSpent}
          registerBack={registerBack}
        />,
      ),
    );
  await render();
  return { host, root, reviewLocalPolicy, saveAssignment, back: () => handler, render };
}
function deferred() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent === text);
const click = async (host: HTMLElement, text: string) => {
  const target = button(host, text);
  if (!target) throw new Error(`no button ${text}`);
  await act(async () => target.click());
};
const rowOf = (host: HTMLElement, text: string) => {
  const found = [...host.querySelectorAll<HTMLElement>('tbody tr')].find((tr) =>
    tr.querySelector('th')?.textContent?.startsWith(text),
  );
  if (!found) throw new Error(`no row ${text}`);
  return found;
};
const drawer = (host: HTMLElement) => host.querySelector('aside.permissions-drawer');

const claudeAssignment: Assignment = {
  profileId: 'lead',
  onScreenOnly: false,
  exceptions: [
    { tool: 'close_session', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
    { tool: 'open_file', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
  ],
};

it('draws the agents list instead of the old assignment point select and tables', async () => {
  const { host } = await mount({
    sessions: [session('s1', 'First')],
    policy: policyWith([], ['s1']),
  });
  expect(host.textContent).not.toContain('Assignment point');
  expect(host.textContent).not.toContain('Who gets which profile');
  expect(host.querySelector('h3')?.textContent).toBe('Agents');
  expect(rowOf(host, 'First').textContent).toContain('First');
  expect(drawer(host)).toBeNull();
});

it('opens the drawer for the selected row and closes it again', async () => {
  const { host } = await mount({
    sessions: [session('s1', 'First')],
    policy: policyWith([], ['s1']),
  });
  await act(async () => rowOf(host, 'First').click());
  expect(drawer(host)?.querySelector('h4')?.textContent).toBe('First');
  await act(async () => host.querySelector<HTMLElement>('[aria-label="Close"]')?.click());
  expect(drawer(host)).toBeNull();
});

it('reviews and saves the frozen assignment with the token and native digest', async () => {
  const { host, reviewLocalPolicy, saveAssignment } = await mount({
    reviewResult: { ok: true, requiresNativeReview: true, digest: 'digest' },
  });
  await act(async () => rowOf(host, 'Default').click());
  await click(host, 'Edit changes');
  const native = [...host.querySelectorAll('input')].find((input) =>
    input.parentElement?.textContent?.includes('native modes'),
  );
  await act(async () => native?.click());
  await click(host, 'Review changes');
  expect(reviewLocalPolicy).toHaveBeenCalledOnce();
  expect(saveAssignment).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Before');
  expect(host.textContent).toContain('After');
  const candidate = reviewLocalPolicy.mock.calls[0][0] as LocalPolicyEdit;
  expect(candidate).toMatchObject({
    kind: 'assignment',
    point: { kind: 'default' },
    assignment: { applyNative: true },
  });
  await click(host, 'Confirm and save');
  expect(saveAssignment).toHaveBeenCalledWith(
    { kind: 'default' },
    candidate.kind === 'assignment' ? candidate.assignment : null,
    'v1',
    'digest',
  );
  expect(drawer(host)?.textContent).not.toContain('Review assignment');
});

it('shows exceptions as a count in the row and offers the reset review inside the drawer', async () => {
  const { host, reviewLocalPolicy, saveAssignment } = await mount({
    policy: policyWith([{ point: { kind: 'cli', cli: 'claude' }, assignment: claudeAssignment }]),
  });
  const row = rowOf(host, 'claude sessions');
  expect(row.textContent).toContain('2 changes');
  expect(row.textContent).not.toContain('close_session');
  await act(async () => row.click());
  await click(host, 'Edit changes');
  await click(host, 'Review reset');
  expect(reviewLocalPolicy).toHaveBeenCalledWith(
    { kind: 'assignment', point: { kind: 'cli', cli: 'claude' }, assignment: null },
    'v1',
  );
  expect(saveAssignment).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Before');
});

it('opens the drawer of the focused agent on mount', async () => {
  const { host } = await mount({
    sessions: [session('s1', 'First'), session('s2', 'Second')],
    policy: policyWith([], ['s1', 's2']),
    focusAgentKey: 'session:s2',
  });
  expect(drawer(host)?.querySelector('h4')?.textContent).toBe('Second');
});

it('the spent callback fires once the drawer is opened from the key', async () => {
  const onFocusAgentSpent = vi.fn();
  const { host } = await mount({
    sessions: [session('s1', 'First')],
    policy: policyWith([], ['s1']),
    focusAgentKey: 'session:s1',
    onFocusAgentSpent,
  });
  expect(drawer(host)).not.toBeNull();
  expect(onFocusAgentSpent).toHaveBeenCalledOnce();
});

it('a deep link for the same agent reopens its drawer after it was closed', async () => {
  const onFocusAgentSpent = vi.fn();
  const m = await mount({
    sessions: [session('s1', 'First')],
    policy: policyWith([], ['s1']),
    focusAgentKey: 'session:s1',
    onFocusAgentSpent,
  });
  await act(async () => m.host.querySelector<HTMLElement>('[aria-label="Close"]')?.click());
  expect(drawer(m.host)).toBeNull();
  await m.render({ focusAgentKey: undefined });
  await m.render({ focusAgentKey: 'session:s1' });
  expect(drawer(m.host)?.querySelector('h4')?.textContent).toBe('First');
  expect(onFocusAgentSpent).toHaveBeenCalledTimes(2);
});

it('opens the agent of a focus key that changes after mount', async () => {
  const m = await mount({
    sessions: [session('s1', 'First'), session('s2', 'Second')],
    policy: policyWith([], ['s1', 's2']),
  });
  expect(drawer(m.host)).toBeNull();
  await m.render({ focusAgentKey: 'session:s2' });
  expect(drawer(m.host)?.querySelector('h4')?.textContent).toBe('Second');
});

it('moves focus to the drawer heading when a row is selected', async () => {
  const { host } = await mount({
    sessions: [session('s1', 'First')],
    policy: policyWith([], ['s1']),
  });
  await act(async () => rowOf(host, 'First').click());
  expect(document.activeElement).toBe(drawer(host)?.querySelector('h4'));
});

it('read-only policy disables every drawer control and says why', async () => {
  const { host } = await mount({
    policy: {
      ...policyWith([{ point: { kind: 'cli', cli: 'claude' }, assignment: claudeAssignment }]),
      readOnly: true,
    },
  });
  await act(async () => rowOf(host, 'claude sessions').click());
  const scope = drawer(host) as HTMLElement;
  expect(button(scope, 'Edit changes')?.disabled).toBe(true);
  expect(button(scope, 'Reset all to role')?.disabled).toBe(true);
  expect(scope.querySelector<HTMLSelectElement>('select[aria-label="Role"]')?.disabled).toBe(true);
  expect(host.textContent).toContain('Permissions are read-only');
});

it('closes the drawer when its agent disappears', async () => {
  const policy = policyWith([], ['s1']);
  const m = await mount({ sessions: [session('s1', 'First')], policy });
  await act(async () => rowOf(m.host, 'First').click());
  expect(drawer(m.host)).not.toBeNull();
  await m.render({ sessions: [], policy: policyWith([], []) });
  expect(drawer(m.host)).toBeNull();
});

it('steps back review, edit, drawer, closed, then reports nothing to consume', async () => {
  const m = await mount({ sessions: [session('s1', 'First')], policy: policyWith([], ['s1']) });
  expect(m.back()?.()).toBe(false);
  await act(async () => rowOf(m.host, 'First').click());
  await click(m.host, 'Edit changes');
  await click(m.host, 'Review changes');
  expect(m.host.textContent).toContain('Review assignment');
  await act(async () => void m.back()?.());
  expect(m.host.textContent).toContain('Edit assignment');
  expect(m.host.textContent).not.toContain('Review assignment');
  await act(async () => void m.back()?.());
  expect(m.host.textContent).not.toContain('Edit assignment');
  expect(drawer(m.host)).not.toBeNull();
  expect(m.back()?.()).toBe(true);
  await act(async () => void m.back()?.());
  expect(drawer(m.host)).toBeNull();
  expect(m.back()?.()).toBe(false);
});

it('consumes a back step without acting while a review request is pending', async () => {
  const gate = deferred();
  const m = await mount({ sessions: [session('s1', 'First')], policy: policyWith([], ['s1']) });
  m.reviewLocalPolicy.mockImplementation(() => gate.promise);
  await act(async () => rowOf(m.host, 'First').click());
  await click(m.host, 'Edit changes');
  await click(m.host, 'Review changes');
  let consumed: boolean | undefined;
  await act(async () => {
    consumed = m.back()?.();
  });
  expect(consumed).toBe(true);
  expect(m.host.textContent).toContain('Edit assignment');
  await act(async () => gate.resolve({ ok: true, requiresNativeReview: false }));
});

it('drops a review result that arrives after the user stepped back to the list', async () => {
  const gate = deferred();
  const m = await mount({ sessions: [session('s1', 'First')], policy: policyWith([], ['s1']) });
  m.reviewLocalPolicy.mockImplementation(() => gate.promise);
  await act(async () => rowOf(m.host, 'First').click());
  await click(m.host, 'Edit changes');
  await click(m.host, 'Review changes');
  await act(async () => m.host.querySelector<HTMLElement>('[aria-label="Close"]')?.click());
  await act(async () => gate.resolve({ ok: true, requiresNativeReview: false }));
  expect(m.back()?.()).toBe(false);
});

it('stages a role picked in the list and applies nothing until Review, then Apply', async () => {
  const { host, reviewLocalPolicy, saveAssignment } = await mount({
    sessions: [session('s1', 'First')],
    policy: policyWith([], ['s1']),
  });
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Role for First"]');
  if (!select) throw new Error('missing role select');
  await act(async () => {
    select.value = 'lead';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(drawer(host)?.querySelector('h4')?.textContent).toBe('First');
  expect(host.textContent).toContain('Edit assignment');
  const staged = host.querySelector<HTMLSelectElement>('aside .selectfield');
  expect(staged?.value).toBe('lead');
  expect(reviewLocalPolicy).not.toHaveBeenCalled();
  expect(saveAssignment).not.toHaveBeenCalled();
  await click(host, 'Review changes');
  expect(reviewLocalPolicy).toHaveBeenCalledWith(
    {
      kind: 'assignment',
      point: { kind: 'session', sessionId: 's1' },
      assignment: expect.objectContaining({ profileId: 'lead' }),
    },
    'v1',
  );
  expect(saveAssignment).not.toHaveBeenCalled();
  await click(host, 'Confirm and save');
  expect(saveAssignment).toHaveBeenCalledOnce();
  expect(saveAssignment).toHaveBeenCalledWith(
    { kind: 'session', sessionId: 's1' },
    expect.objectContaining({ profileId: 'lead' }),
    'v1',
    undefined,
  );
});

it('stages the new-agent role on the default assignment', async () => {
  const { host, saveAssignment, reviewLocalPolicy } = await mount({});
  const select = [...host.querySelectorAll('select')].find((s) =>
    s.parentElement?.textContent?.startsWith('New agents start with'),
  );
  if (!select) throw new Error('missing select');
  await act(async () => {
    select.value = 'observer';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click(host, 'Review changes');
  expect(reviewLocalPolicy).toHaveBeenCalledWith(
    {
      kind: 'assignment',
      point: { kind: 'default' },
      assignment: expect.objectContaining({ profileId: 'observer' }),
    },
    'v1',
  );
  expect(saveAssignment).not.toHaveBeenCalled();
});

const sessionWithChanges = (): Assignment => ({
  profileId: 'worker',
  onScreenOnly: false,
  exceptions: [
    { tool: 'close_session', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
    { tool: 'open_file', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
  ],
});
const word = { allow: 'Allow', ask: 'Ask', deny: 'Deny' } as const;
const workerRules = BUILT_IN_PROFILES.find((p) => p.id === 'worker')?.rules;

async function openWithChanges() {
  const m = await mount({
    sessions: [session('s1', 'First')],
    policy: policyWith(
      [{ point: { kind: 'session', sessionId: 's1' }, assignment: sessionWithChanges() }],
      ['s1'],
    ),
  });
  await act(async () => rowOf(m.host, 'First').click());
  return m;
}

it('lists each change as what the role says and what this agent does', async () => {
  const { host } = await openWithChanges();
  const lines = [...(drawer(host)?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
  expect(lines).toContain(
    `close_session: role says ${word[workerRules?.close_session.decision ?? 'ask']} → this agent: Allow`,
  );
  expect(lines).toContain(
    `open_file: role says ${word[workerRules?.open_file.decision ?? 'ask']} → this agent: Deny`,
  );
  expect(drawer(host)?.textContent).toContain('2 changes from Worker');
});

it('says Follows role in the drawer when there are no changes', async () => {
  const m = await mount({ sessions: [session('s1', 'First')], policy: policyWith([], ['s1']) });
  await act(async () => rowOf(m.host, 'First').click());
  expect(drawer(m.host)?.textContent).toContain('Follows role');
  expect(button(m.host, 'Reset all to role')).toBeUndefined();
});

it('enters the existing exceptions editor from Edit changes', async () => {
  const { host } = await openWithChanges();
  await click(host, 'Edit changes');
  expect(host.textContent).toContain('Edit assignment');
});

it('stages a reset of every change and goes to Review without saving', async () => {
  const { host, reviewLocalPolicy, saveAssignment } = await openWithChanges();
  await click(host, 'Reset all to role');
  expect(reviewLocalPolicy).toHaveBeenCalledWith(
    {
      kind: 'assignment',
      point: { kind: 'session', sessionId: 's1' },
      assignment: expect.objectContaining({ profileId: 'worker', exceptions: [] }),
    },
    'v1',
  );
  expect(host.textContent).toContain('Review assignment');
  expect(saveAssignment).not.toHaveBeenCalled();
});

it('stages a role picked inside the drawer', async () => {
  const { host, reviewLocalPolicy } = await openWithChanges();
  const select = host.querySelector<HTMLSelectElement>('aside select[aria-label="Role"]');
  if (!select) throw new Error('missing drawer role select');
  await act(async () => {
    select.value = 'lead';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(reviewLocalPolicy).not.toHaveBeenCalled();
  await click(host, 'Review changes');
  expect(reviewLocalPolicy).toHaveBeenCalledWith(
    expect.objectContaining({ assignment: expect.objectContaining({ profileId: 'lead' }) }),
    'v1',
  );
});

it('summarises what the agent can do per group with a worded pill', async () => {
  const { host } = await openWithChanges();
  const groups = [...(drawer(host)?.querySelectorAll('details') ?? [])];
  expect(groups.length).toBeGreaterThan(0);
  expect(groups[0].closest('section')?.textContent).toContain('What this agent can do');
  for (const group of groups)
    expect(group.querySelector('.permissions-pill')?.textContent).toMatch(/Allowed|Mixed|Denied/);
});

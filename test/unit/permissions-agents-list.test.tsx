// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import {
  type AgentRow,
  PermissionsAgentsList,
  type PermissionsAgentsListProps,
} from '../../webview/components/permissions-agents-list';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const [observer, worker, lead] = BUILT_IN_PROFILES;
const session = (id: string, title: string, changes: number): AgentRow => ({
  point: { kind: 'session', sessionId: id },
  key: `session:${id}`,
  title,
  subtitle: id,
  profile: worker,
  changes,
});
const fallbackRow: AgentRow = {
  point: { kind: 'default' },
  key: 'default',
  title: 'Default',
  subtitle: 'Default',
  profile: worker,
  changes: 0,
};

async function mount(over: Partial<PermissionsAgentsListProps> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const props: PermissionsAgentsListProps = {
    rows: [session('s1', 'First', 2), session('s2', 'Second', 0), fallbackRow],
    profiles: BUILT_IN_PROFILES,
    selectedKey: null,
    readOnly: false,
    newAgentRole: 'worker',
    onNewAgentRole: vi.fn(),
    onSelect: vi.fn(),
    onRoleChange: vi.fn(),
    ...over,
  };
  await act(async () => root.render(<PermissionsAgentsList {...props} />));
  return { host, props };
}
const change = async (select: HTMLSelectElement, value: string) =>
  act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });

it('says there are no agents yet and names the starting role', async () => {
  const { host } = await mount({ rows: [] });
  expect(host.textContent).toContain('No agents yet. New agents start with Worker.');
});

it('draws one row per agent with a named role select and a change chip in words', async () => {
  const { host } = await mount();
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Role for First"]');
  expect([...(select?.options ?? [])].map((o) => o.textContent)).toEqual(
    BUILT_IN_PROFILES.map((p) => p.name),
  );
  expect(select?.value).toBe('worker');
  const rows = [...host.querySelectorAll('table')[0].querySelectorAll('tbody tr')];
  expect(rows.map((r) => r.textContent)).toEqual([
    expect.stringContaining('2 changes'),
    expect.stringContaining('Follows role'),
  ]);
});

it('says "1 change" for a single change', async () => {
  const { host } = await mount({ rows: [session('s1', 'First', 1)] });
  expect(host.textContent).toContain('1 change');
  expect(host.textContent).not.toContain('1 changes');
});

it('reports a role change without applying anything', async () => {
  const { host, props } = await mount();
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Role for First"]');
  if (!select) throw new Error('missing select');
  await change(select, lead.id);
  expect(props.onRoleChange).toHaveBeenCalledWith(props.rows[0], lead.id);
  expect(props.onSelect).not.toHaveBeenCalled();
});

it('selects a row on click and on Enter', async () => {
  const { host, props } = await mount();
  const row = host.querySelectorAll<HTMLElement>('tbody tr')[1];
  await act(async () => row.click());
  expect(props.onSelect).toHaveBeenLastCalledWith(props.rows[1]);
  await act(async () =>
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(props.onSelect).toHaveBeenCalledTimes(2);
});

it('sends the new-agent role', async () => {
  const { host, props } = await mount();
  const select = [...host.querySelectorAll('select')].find((s) =>
    s.parentElement?.textContent?.startsWith('New agents start with'),
  );
  if (!select) throw new Error('missing select');
  await change(select, observer.id);
  expect(props.onNewAgentRole).toHaveBeenCalledWith(observer.id);
});

it('keeps defaults by agent type in a collapsed region', async () => {
  const { host } = await mount();
  const region = host.querySelector('details');
  expect(region?.open).toBe(false);
  expect(region?.querySelector('summary')?.textContent).toBe('Defaults by agent type');
  expect(region?.textContent).toContain('Default');
  expect(host.querySelectorAll('table')[0].textContent).not.toContain('Default');
});

it('disables the selects when read-only and does not open a machine row', async () => {
  const peer: AgentRow = {
    ...fallbackRow,
    point: { kind: 'peer', machineId: 'm1' },
    key: 'peer:m1',
    title: 'Machine m1',
  };
  const { host, props } = await mount({ rows: [session('s1', 'First', 0), peer] });
  const peerRow = [...host.querySelectorAll<HTMLElement>('tbody tr')].find((r) =>
    r.textContent?.includes('Machine m1'),
  );
  await act(async () => peerRow?.click());
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(peerRow?.querySelector('select')?.disabled).toBe(true);
});

it('disables every select when read-only', async () => {
  const { host } = await mount({ readOnly: true });
  const selects = [...host.querySelectorAll('select')];
  expect(selects.length).toBeGreaterThan(0);
  expect(selects.every((select) => select.disabled)).toBe(true);
});

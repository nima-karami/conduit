// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { McpSection, type McpSectionProps } from '../../webview/components/mcp-section';

const api = vi.hoisted(() => ({
  state: { policy: { editToken: 'v1', readOnly: false, profiles: [], assignments: [] } },
  grantLifecycle: vi.fn(),
  getActivity: vi.fn(),
  getActivityRow: vi.fn(),
  allowOnce: vi.fn(),
}));
const mounts = vi.hoisted(() => ({ activity: 0, registerBack: undefined as unknown }));
vi.mock('../../webview/use-conduit-mcp', () => ({ useConduitMcp: () => api }));
vi.mock('../../webview/components/permissions-roles', () => ({
  PermissionsRoles: () => <p>roles panel</p>,
}));
vi.mock('../../webview/components/permissions-assignments', () => ({
  PermissionsAssignments: () => <p>agents panel</p>,
}));
vi.mock('../../webview/components/permissions-grants', () => ({
  PermissionsGrants: ({ policy }: { policy: { readOnly: boolean } }) => (
    <p>grants panel readOnly={String(policy.readOnly)}</p>
  ),
}));
vi.mock('../../webview/components/permissions-activity', async () => {
  const { useEffect } = await import('react');
  return {
    PermissionsActivity: ({
      sessionId,
      machines,
      sessions,
      registerBack,
    }: {
      registerBack?: unknown;
      sessionId?: string;
      machines: Array<{ id: string; name: string }>;
      sessions: Array<{ id: string; name: string }>;
    }) => {
      mounts.registerBack = registerBack;
      useEffect(() => {
        mounts.activity += 1;
      }, []);
      return (
        <p>
          activity panel {sessionId ?? 'none'} {machines.map((m) => m.name).join(',')}{' '}
          {sessions.map((s) => s.name).join(',')}
        </p>
      );
    },
  };
});

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
let root: Root | null = null;
let host: HTMLElement;
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  document.body.innerHTML = '';
  mounts.activity = 0;
});

function props(over: Partial<McpSectionProps> = {}): McpSectionProps {
  return {
    tab: 'settings',
    onTabChange: () => {},
    settings: <p>settings panel</p>,
    serverConnected: true,
    sessions: [{ id: 's1', name: 'Lane one' } as never],
    activityScope: {},
    activityMachines: [{ id: 'm1', name: 'Box' }],
    onAddActivityException: () => {},
    registerBack: () => {},
    ...over,
  };
}
async function render(p: McpSectionProps) {
  if (!root) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root?.render(<McpSection {...p} />));
}
const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];

it('renders five tabs in order and selects the given one', async () => {
  await render(props({ tab: 'agents' }));
  expect(tabs().map((t) => t.textContent)).toEqual([
    'Settings',
    'Roles',
    'Agents',
    'Grants',
    'Activity',
  ]);
  expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual([
    'false',
    'false',
    'true',
    'false',
    'false',
  ]);
  expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('MCP sections');
  expect(host.querySelector('[role="tabpanel"]')?.textContent).toBe('agents panel');
});

it('renders the MCP title, subtitle and a selected underline tab', async () => {
  await render(props({ tab: 'roles' }));
  const heading = host.querySelector('h2');
  expect(heading?.textContent).toBe('MCP');
  expect(heading?.tagName).toBe('H2');
  expect(host.textContent).toContain(
    'How agents talk to Conduit, and what they are allowed to do.',
  );
  const selected = tabs().filter((t) => t.getAttribute('aria-selected') === 'true');
  expect(selected.map((t) => t.textContent)).toEqual(['Roles']);
  expect(selected[0].className).toContain('mcp-section__tab--active');
});

it('ArrowRight, End and Home move the selected tab', async () => {
  const onTabChange = vi.fn();
  await render(props({ tab: 'roles', onTabChange }));
  const key = async (index: number, k: string) =>
    act(async () => {
      tabs()[index].dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
  await key(1, 'ArrowRight');
  expect(onTabChange).toHaveBeenLastCalledWith('agents');
  await key(1, 'End');
  expect(onTabChange).toHaveBeenLastCalledWith('activity');
  await key(1, 'Home');
  expect(onTabChange).toHaveBeenLastCalledWith('settings');
  await key(1, 'ArrowLeft');
  expect(onTabChange).toHaveBeenLastCalledWith('settings');
});

it('Activity panel passes the scope and remounts when it changes', async () => {
  await render(props({ tab: 'activity', activityScope: { sessionId: 's1' } }));
  expect(host.textContent).toContain('activity panel s1 Box Lane one');
  expect(mounts.activity).toBe(1);
  await render(props({ tab: 'activity', activityScope: { sessionId: 's1' } }));
  expect(mounts.activity).toBe(1);
  await render(props({ tab: 'activity', activityScope: { sessionId: 's2' } }));
  expect(mounts.activity).toBe(2);
});

it('Grants gets a read-only policy when the server is disconnected', async () => {
  await render(props({ tab: 'grants', serverConnected: false }));
  expect(host.textContent).toContain('readOnly=true');
  await render(props({ tab: 'grants', serverConnected: true }));
  expect(host.textContent).toContain('readOnly=false');
});

it('registerBack is called with null on unmount', async () => {
  const registerBack = vi.fn();
  await render(props({ registerBack }));
  registerBack.mockClear();
  const current = root;
  root = null;
  await act(async () => current?.unmount());
  expect(registerBack).toHaveBeenCalledWith(null);
});

it('the Activity tab hands registerBack to PermissionsActivity', async () => {
  const registerBack = vi.fn();
  await render(props({ tab: 'activity', registerBack }));
  expect(mounts.registerBack).toBe(registerBack);
});

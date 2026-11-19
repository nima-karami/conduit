import { describe, expect, it, vi } from 'vitest';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { PolicyUiState } from '../../src/conduit-mcp/policy-types';
import type { MenuItem } from '../../webview/components/context-menu';
import { MCP_STR } from '../../webview/conduit-mcp-strings';
import {
  buildPermissionsSubmenu,
  buildSelectionMenu,
  buildSessionMenu,
  canOpenSessionPermissions,
  type SessionMenuAction,
  type SessionMenuInput,
  sessionPermissionSummary,
} from '../../webview/session-menu';

const ACTIONS: SessionMenuAction[] = [
  'select',
  'split',
  'relaunch',
  'snooze',
  'approval',
  'timed',
  'messages',
  'pauseMcp',
  'mcpTools',
  'setupMcp',
  'pin',
  'rename',
  'setIcon',
  'duplicate',
  'moveSpace',
  'copyHome',
  'copyName',
  'reveal',
  'close',
  'closeSubAgents',
  'closeOthers',
  'closeAll',
];

function input(over: Partial<SessionMenuInput> = {}) {
  const calls: { action: SessionMenuAction; arg: unknown }[] = [];
  const actions = Object.fromEntries(
    ACTIONS.map((a) => [a, vi.fn((arg?: unknown) => calls.push({ action: a, arg }))]),
  ) as unknown as SessionMenuInput['actions'];
  const icons = Object.fromEntries(
    ACTIONS.map((a) => [a, `icon:${a}`]),
  ) as unknown as SessionMenuInput['icons'];
  const value: SessionMenuInput = {
    platform: 'win32',
    name: 'claude-1',
    maySplit: false,
    canRelaunch: false,
    pinned: false,
    hasApproval: false,
    waitingTimers: 0,
    hasMcp: false,
    mcpHandle: null,
    mcpPaused: false,
    mcpSwitchable: false,
    mcpSetupNeeded: false,
    mcpLink: null,
    snoozable: false,
    otherCount: 2,
    allCount: 3,
    windowMoves: [],
    icons,
    actions,
    ...over,
  };
  return { value, calls };
}

const labels = (items: MenuItem[]) => items.map((i) => i.label);
const seps = (items: MenuItem[]) => items.filter((i) => i.separatorBefore).map((i) => i.label);
const find = (items: MenuItem[], label: string) => items.find((i) => i.label === label);

const HEAD = ['Go to', 'Pin to top'];
const ATTENTION = ['Timed message…'];
const TAIL = [
  'Rename',
  'Set icon…',
  'Duplicate session',
  'Move to space…',
  'Copy home path',
  'Copy name',
  'Reveal in Explorer',
  'Close',
  'Close others',
  'Close all',
];

describe('buildSessionMenu — reveal label', () => {
  it('follows the platform', () => {
    const revealOn = (platform: 'darwin' | 'linux' | 'win32') =>
      find(buildSessionMenu(input({ platform }).value), 'Reveal in Explorer') ??
      find(buildSessionMenu(input({ platform }).value), 'Reveal in Finder') ??
      find(buildSessionMenu(input({ platform }).value), 'Show in Files');
    expect(revealOn('win32')?.label).toBe('Reveal in Explorer');
    expect(revealOn('darwin')?.label).toBe('Reveal in Finder');
    expect(revealOn('linux')?.label).toBe('Show in Files');
  });
});

describe('buildSessionMenu — entries, order and separators', () => {
  it('a plain session: Go to and Pin lead, then timers, edit, copy and close', () => {
    const items = buildSessionMenu(input().value);
    expect(labels(items)).toEqual([...HEAD, ...ATTENTION, ...TAIL]);
    expect(seps(items)).toEqual(['Timed message…', 'Rename', 'Copy home path', 'Close']);
    expect(items[0].separatorBefore).toBeFalsy();
  });

  it('Pin reads Unpin for a pinned session', () => {
    expect(labels(buildSessionMenu(input({ pinned: true }).value))).toContain('Unpin');
    expect(labels(buildSessionMenu(input({ pinned: true }).value))).not.toContain('Pin to top');
  });

  it('lifecycle entries follow the head when they apply', () => {
    const items = buildSessionMenu(input({ maySplit: true, canRelaunch: true }).value);
    expect(labels(items).slice(0, 5)).toEqual([
      ...HEAD,
      'Open in split pane',
      'Relaunch',
      'Timed message…',
    ]);
    expect(seps(items)).toEqual([
      'Open in split pane',
      'Timed message…',
      'Rename',
      'Copy home path',
      'Close',
    ]);
  });

  it('Snooze appears only when there is something to silence, with any time left', () => {
    expect(labels(buildSessionMenu(input().value))).not.toContain('Snooze for 10 minutes');
    const on = buildSessionMenu(input({ snoozable: true }).value);
    expect(find(on, 'Snooze for 10 minutes')?.detail).toBeUndefined();
    const live = buildSessionMenu(
      input({ snoozable: true, snoozedUntil: 1_000 + 6.5 * 60_000, now: 1_000 }).value,
    );
    expect(find(live, 'Snooze for 10 minutes')?.detail).toBe('7 min left');
    const over = buildSessionMenu(input({ snoozable: true, snoozedUntil: 500, now: 1_000 }).value);
    expect(find(over, 'Snooze for 10 minutes')?.detail).toBeUndefined();
  });

  it('View approval appears only with a waiting ask, ahead of Snooze', () => {
    const items = labels(buildSessionMenu(input({ hasApproval: true, snoozable: true }).value));
    expect(items.slice(2, 5)).toEqual(['View approval', 'Snooze for 10 minutes', 'Timed message…']);
    expect(labels(buildSessionMenu(input().value))).not.toContain('View approval');
  });

  it('Timed message carries the waiting count as detail, none at zero', () => {
    expect(
      find(buildSessionMenu(input({ waitingTimers: 2 }).value), 'Timed message…')?.detail,
    ).toBe('2 waiting');
    expect(find(buildSessionMenu(input().value), 'Timed message…')?.detail).toBeUndefined();
  });

  it('messaging: the connection in words, open, pause or resume, tools and setup, each guarded', () => {
    const on = buildSessionMenu(
      input({
        hasMcp: true,
        mcpHandle: 'claude-1',
        mcpSwitchable: true,
        mcpSetupNeeded: true,
        mcpLink: { kind: 'connected', handle: 'claude-1' },
      }).value,
    );
    const at = labels(on).indexOf('Connected to Conduit as claude-1');
    expect(labels(on).slice(at, at + 6)).toEqual([
      'Connected to Conduit as claude-1',
      'Open messages',
      'Pause notices for claude-1',
      'Permissions',
      'Set up Conduit MCP…',
      'Rename',
    ]);
    // The explanation never acts.
    expect(on[at].disabled).toBe(true);
    expect(on[at].separatorBefore).toBe(true);
    const paused = buildSessionMenu(
      input({ hasMcp: true, mcpHandle: 'claude-1', mcpPaused: true }).value,
    );
    expect(labels(paused)).toContain('Resume notices for claude-1');
    // Tools without a handle yet open their own group.
    const tools = buildSessionMenu(input({ mcpSwitchable: true }).value);
    expect(find(tools, 'Permissions')?.separatorBefore).toBe(true);
    // Not connected or unavailable: the reason in words, with no messaging entries.
    const missing = buildSessionMenu(
      input({ mcpLink: { kind: 'not-connected', cli: 'codex', install: 'not-installed' } }).value,
    );
    expect(labels(missing)).toContain(MCP_STR.install.notConnectedTip('codex'));
    const installed = buildSessionMenu(
      input({ mcpLink: { kind: 'not-connected', cli: 'codex', install: 'installed' } }).value,
    );
    expect(labels(installed)).toContain(MCP_STR.install.notConnectedInstalledTip('codex'));
    const off = buildSessionMenu(
      input({ mcpLink: { kind: 'unavailable', reason: 'messaging-off' } }).value,
    );
    expect(find(off, MCP_STR.unavailable['messaging-off'])?.disabled).toBe(true);
    expect(labels(buildSessionMenu(input().value)).join(' ')).not.toMatch(/Conduit as|unavailable/);
    // A handle-less badge never offers messages.
    expect(labels(buildSessionMenu(input({ hasMcp: true }).value))).not.toContain('Open messages');
  });

  it('inlines the window moves after Move to space…', () => {
    const moves: MenuItem[] = [
      { label: 'Move to new window', onClick: () => {} },
      { label: 'Move to Window 2', onClick: () => {} },
    ];
    const items = labels(buildSessionMenu(input({ windowMoves: moves }).value));
    const at = items.indexOf('Move to space…');
    expect(items.slice(at, at + 4)).toEqual([
      'Move to space…',
      'Move to new window',
      'Move to Window 2',
      'Copy home path',
    ]);
  });

  it('close guards: Close others is disabled with no others; close actions are danger', () => {
    const none = buildSessionMenu(input({ otherCount: 0, allCount: 1 }).value);
    expect(find(none, 'Close others')?.disabled).toBe(true);
    for (const l of ['Close', 'Close others', 'Close all'])
      expect(find(none, l)?.danger).toBe(true);
    expect(find(buildSessionMenu(input().value), 'Close others')?.disabled).toBe(false);
  });

  it('every relocated action is reachable: each entry calls its own callback with the activation', () => {
    const { value, calls } = input({
      maySplit: true,
      canRelaunch: true,
      hasApproval: true,
      snoozable: true,
      hasMcp: true,
      mcpHandle: 'h-1',
      mcpSwitchable: true,
      mcpSetupNeeded: true,
      subAgentCount: 2,
    });
    const items = buildSessionMenu(value).filter((i) => !i.disabled);
    const rect = { left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 };
    for (const item of items) item.onClick({ rect });
    expect(calls.map((c) => c.action)).toEqual([
      'select',
      'pin',
      'split',
      'relaunch',
      'approval',
      'snooze',
      'timed',
      'messages',
      'pauseMcp',
      'mcpTools',
      'setupMcp',
      'rename',
      'setIcon',
      'duplicate',
      'moveSpace',
      'copyHome',
      'copyName',
      'reveal',
      'close',
      'closeSubAgents',
      'closeOthers',
      'closeAll',
    ]);
    // Every SessionMenuAction has an entry, so nothing the card carried is unreachable.
    expect([...new Set(calls.map((c) => c.action))].sort()).toEqual([...ACTIONS].sort());
    expect(calls.find((c) => c.action === 'moveSpace')?.arg).toEqual({ rect });
    expect(items.map((i) => i.icon)).toEqual(calls.map((c) => `icon:${c.action}`));
  });

  it('a bare programmatic call reaches the callback without an activation', () => {
    const { value, calls } = input();
    find(buildSessionMenu(value), 'Move to space…')?.onClick();
    expect(calls).toEqual([{ action: 'moveSpace', arg: undefined }]);
  });
});

describe('close sub-agents and the multi-selection menu', () => {
  it('offers Close all sub-agents (N) only for a lead with children, right after Close', () => {
    expect(labels(buildSessionMenu(input({ subAgentCount: 3 }).value))).toContain(
      'Close all sub-agents (3)',
    );
    const none = labels(buildSessionMenu(input({ subAgentCount: 0 }).value));
    expect(none.some((l) => l.startsWith('Close all sub-agents'))).toBe(false);
    const menu = labels(buildSessionMenu(input({ subAgentCount: 3 }).value));
    expect(menu.indexOf('Close all sub-agents (3)')).toBe(menu.indexOf('Close') + 1);
  });

  it('Close all sub-agents is danger and calls its own action', () => {
    const { value, calls } = input({ subAgentCount: 2 });
    const item = find(buildSessionMenu(value), 'Close all sub-agents (2)');
    expect(item?.danger).toBe(true);
    item?.onClick();
    expect(calls).toEqual([{ action: 'closeSubAgents', arg: undefined }]);
  });

  it('the multi-selection menu is one danger entry, Close N sessions, that calls onClose', () => {
    const onClose = vi.fn();
    const items = buildSelectionMenu({ count: 2, icon: 'x', onClose });
    expect(labels(items)).toEqual(['Close 2 sessions']);
    expect(items[0]?.danger).toBe(true);
    expect(items[0]?.icon).toBe('x');
    items[0]?.onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

it('requires both current window coverage and a policy projection', () => {
  expect(canOpenSessionPermissions('s1', [{ id: 's1' }], { s1: {} })).toBe(true);
  expect(canOpenSessionPermissions('s1', [], { s1: {} })).toBe(false);
  expect(canOpenSessionPermissions('s1', [{ id: 's1' }], {})).toBe(false);
});

describe('Permissions submenu (canvas E1)', () => {
  const policy = {
    profiles: BUILT_IN_PROFILES,
    assignments: [
      {
        point: { kind: 'session', sessionId: 's1' },
        assignment: {
          profileId: 'worker',
          onScreenOnly: false,
          exceptions: [
            { tool: 'close_session', scope: { kind: 'anywhere' }, rule: { decision: 'allow' } },
            { tool: 'open_url', scope: { kind: 'anywhere' }, rule: { decision: 'deny' } },
          ],
        },
      },
    ],
    sessions: {
      s1: { profileId: 'worker', profileName: 'Worker' },
      s2: { profileId: 'lead', profileName: 'Lead' },
    },
  } as unknown as PolicyUiState;

  it('summarises the role and only the session’s own changes', () => {
    expect(sessionPermissionSummary(policy, 's1')).toEqual({
      profileId: 'worker',
      roleName: 'Worker',
      changes: 2,
    });
    expect(sessionPermissionSummary(policy, 's2')?.changes).toBe(0);
    expect(sessionPermissionSummary(policy, 'missing')).toBeNull();
    expect(sessionPermissionSummary(undefined, 's1')).toBeNull();
  });

  it('shows the role and change count beside Permissions in the row menu', () => {
    const items = buildSessionMenu(
      input({ mcpSwitchable: true, mcpPermissions: sessionPermissionSummary(policy, 's1') }).value,
    );
    const item = find(items, 'Permissions');
    expect(item?.detail).toBe('Worker · 2 changes');
    expect(item?.hint).toBe('▸');
  });

  it('lists the roles with the current one ticked, then the changes, Reset and Customize', () => {
    const onPick = vi.fn();
    const onReset = vi.fn();
    const onCustomize = vi.fn();
    const summary = sessionPermissionSummary(policy, 's1');
    if (!summary) throw new Error('no summary');
    const items = buildPermissionsSubmenu({
      name: 'Docs refresh',
      roles: BUILT_IN_PROFILES,
      summary,
      onPick,
      onReset,
      onCustomize,
    });
    expect(labels(items)).toEqual([
      'Role for Docs refresh',
      ...BUILT_IN_PROFILES.map((p) => p.name),
      '2 changes from Worker',
      'Reset to role',
      'Customize…',
    ]);
    expect(items[0].disabled).toBe(true);
    expect(items.filter((i) => i.checked).map((i) => i.label)).toEqual(['Worker']);
    expect(find(items, '2 changes from Worker')?.disabled).toBe(true);
    find(items, 'Lead')?.onClick();
    expect(onPick).toHaveBeenCalledWith('lead');
    find(items, 'Reset to role')?.onClick();
    expect(onReset).toHaveBeenCalledOnce();
    find(items, 'Customize…')?.onClick();
    expect(onCustomize).toHaveBeenCalledOnce();
  });

  it('disables the staging rows but keeps Customize… while read-only', () => {
    const summary = { profileId: 'worker' as const, roleName: 'Worker', changes: 1 };
    const items = buildPermissionsSubmenu({
      name: 'x',
      roles: BUILT_IN_PROFILES,
      summary,
      readOnly: true,
      onPick: () => {},
      onReset: () => {},
      onCustomize: () => {},
    });
    for (const p of BUILT_IN_PROFILES) expect(find(items, p.name)?.disabled).toBe(true);
    expect(find(items, 'Reset to role')?.disabled).toBe(true);
    expect(find(items, 'Customize…')?.disabled).toBeFalsy();
  });

  it('leaves out the change rows when the agent follows its role', () => {
    const summary = { profileId: 'lead' as const, roleName: 'Lead', changes: 0 };
    const items = buildPermissionsSubmenu({
      name: 'x',
      roles: BUILT_IN_PROFILES,
      summary,
      onPick: () => {},
      onReset: () => {},
      onCustomize: () => {},
    });
    expect(labels(items)).not.toContain('Reset to role');
    expect(labels(items).at(-1)).toBe('Customize…');
  });
});

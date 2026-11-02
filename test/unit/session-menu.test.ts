import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../../webview/components/context-menu';
import { MCP_STR } from '../../webview/conduit-mcp-strings';
import {
  buildSessionMenu,
  type SessionMenuAction,
  type SessionMenuInput,
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
      'MCP tools…',
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
    expect(find(tools, 'MCP tools…')?.separatorBefore).toBe(true);
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

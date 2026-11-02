import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../../webview/components/context-menu';
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

const TAIL = [
  'Rename',
  'Set icon…',
  'Timed message…',
  'Duplicate session',
  'Move to project…',
  'Copy home path',
  'Copy name',
  'Reveal in Explorer',
  'Close',
  'Close others',
  'Close all',
];

describe('buildSessionMenu — the original entries, order and separators', () => {
  it('a plain session: the edit, copy and close groups only, no leading divider', () => {
    const items = buildSessionMenu(input().value);
    expect(labels(items)).toEqual(TAIL);
    expect(seps(items)).toEqual(['Copy home path', 'Close']);
  });

  it('lifecycle entries lead when they apply', () => {
    const items = buildSessionMenu(input({ maySplit: true, canRelaunch: true }).value);
    expect(labels(items).slice(0, 3)).toEqual(['Open in split pane', 'Relaunch', 'Rename']);
    expect(seps(items)).toEqual(['Rename', 'Copy home path', 'Close']);
  });

  it('messaging: open, pause or resume with the handle, tools and setup, each guarded', () => {
    const on = buildSessionMenu(
      input({
        canRelaunch: true,
        hasMcp: true,
        mcpHandle: 'claude-1',
        mcpSwitchable: true,
        mcpSetupNeeded: true,
      }).value,
    );
    expect(labels(on).slice(0, 6)).toEqual([
      'Relaunch',
      'Open messages',
      'Pause notices for claude-1',
      'MCP tools…',
      'Set up Conduit MCP…',
      'Rename',
    ]);
    expect(seps(on)).toEqual(['Open messages', 'Rename', 'Copy home path', 'Close']);
    const paused = buildSessionMenu(
      input({ hasMcp: true, mcpHandle: 'claude-1', mcpPaused: true }).value,
    );
    expect(labels(paused)).toContain('Resume notices for claude-1');
    // Tools without a handle yet: its own divider after the lifecycle group.
    const tools = buildSessionMenu(input({ canRelaunch: true, mcpSwitchable: true }).value);
    expect(labels(tools).slice(0, 3)).toEqual(['Relaunch', 'MCP tools…', 'Rename']);
    expect(seps(tools)).toEqual(['MCP tools…', 'Rename', 'Copy home path', 'Close']);
    // A handle-less badge never offers messages.
    expect(labels(buildSessionMenu(input({ hasMcp: true }).value))).not.toContain('Open messages');
  });

  it('inlines the window moves after Move to project…', () => {
    const moves: MenuItem[] = [
      { label: 'Move to new window', onClick: () => {} },
      { label: 'Move to Window 2', onClick: () => {} },
    ];
    const items = labels(buildSessionMenu(input({ windowMoves: moves }).value));
    const at = items.indexOf('Move to project…');
    expect(items.slice(at, at + 4)).toEqual([
      'Move to project…',
      'Move to new window',
      'Move to Window 2',
      'Copy home path',
    ]);
  });

  it('close guards: Close others is disabled with no others; close actions are danger', () => {
    const none = buildSessionMenu(input({ otherCount: 0, allCount: 1 }).value);
    expect(none.find((i) => i.label === 'Close others')?.disabled).toBe(true);
    for (const l of ['Close', 'Close others', 'Close all'])
      expect(none.find((i) => i.label === l)?.danger).toBe(true);
    const some = buildSessionMenu(input().value);
    expect(some.find((i) => i.label === 'Close others')?.disabled).toBe(false);
  });

  it('every entry calls its own supplied callback with the activation and carries its icon', () => {
    const { value, calls } = input({
      maySplit: true,
      canRelaunch: true,
      hasMcp: true,
      mcpHandle: 'h-1',
      mcpSwitchable: true,
      mcpSetupNeeded: true,
    });
    const items = buildSessionMenu(value);
    const rect = { left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 };
    for (const item of items) item.onClick({ rect });
    expect(calls.map((c) => c.action)).toEqual([
      'split',
      'relaunch',
      'messages',
      'pauseMcp',
      'mcpTools',
      'setupMcp',
      'rename',
      'setIcon',
      'timed',
      'duplicate',
      'moveSpace',
      'copyHome',
      'copyName',
      'reveal',
      'close',
      'closeOthers',
      'closeAll',
    ]);
    expect(calls.find((c) => c.action === 'moveSpace')?.arg).toEqual({ rect });
    expect(items.map((i) => i.icon)).toEqual(calls.map((c) => `icon:${c.action}`));
  });

  it('a bare programmatic call reaches the callback without an activation', () => {
    const { value, calls } = input();
    buildSessionMenu(value)
      .find((i) => i.label === 'Move to project…')
      ?.onClick();
    expect(calls).toEqual([{ action: 'moveSpace', arg: undefined }]);
  });
});

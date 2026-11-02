import type { ReactNode } from 'react';
import { SNOOZE_MS } from '../src/attention';
import type { Handle } from '../src/conduit-mcp/types';
import type { MenuActivation, MenuItem } from './components/context-menu';
import { MCP_STR } from './conduit-mcp-strings';
import { SIDEBAR_STR } from './sidebar-strings';

/**
 * The session context menu as declarative entries (docs/plans/2026-11-02-sidebar-agent-tree.plan.md
 * "Session menu seam"). The App supplies a snapshot and callbacks already bound to the session;
 * guards such as close confirmations and MCP gates stay in those callbacks.
 */

export type SessionMenuAction =
  | 'select'
  | 'split'
  | 'relaunch'
  | 'snooze'
  | 'approval'
  | 'timed'
  | 'messages'
  | 'pauseMcp'
  | 'mcpTools'
  | 'setupMcp'
  | 'pin'
  | 'rename'
  | 'setIcon'
  | 'duplicate'
  | 'moveSpace'
  | 'copyHome'
  | 'copyName'
  | 'reveal'
  | 'close'
  | 'closeOthers'
  | 'closeAll';

export interface SessionMenuInput {
  name: string;
  maySplit: boolean;
  canRelaunch: boolean;
  pinned: boolean;
  hasApproval: boolean;
  waitingTimers: number;
  hasMcp: boolean;
  /** The pause entry names the handle; null while the session has none. */
  mcpHandle: Handle | null;
  mcpPaused: boolean;
  mcpSwitchable: boolean;
  mcpSetupNeeded: boolean;
  otherCount: number;
  allCount: number;
  windowMoves: readonly MenuItem[];
  icons: Readonly<Record<SessionMenuAction, ReactNode>>;
  actions: Readonly<Record<SessionMenuAction, (activation?: MenuActivation) => void>>;
}

export function buildSessionMenu(input: SessionMenuInput): MenuItem[] {
  const { icons, actions } = input;
  const M = SIDEBAR_STR.menu;
  const item = (
    action: SessionMenuAction,
    label: string,
    extra: Partial<Omit<MenuItem, 'label' | 'icon' | 'onClick'>> = {},
  ): MenuItem => ({
    label,
    icon: icons[action],
    onClick: (activation) => actions[action](activation),
    ...extra,
  });

  // Go to and Pin are the row's own click and hover button, here too so keyboard and touch
  // reach them (spec §6 relocation table).
  const head = [item('select', M.goTo), item('pin', input.pinned ? M.unpin : M.pin)];

  const lifecycle: MenuItem[] = [];
  if (input.maySplit) lifecycle.push(item('split', M.split));
  if (input.canRelaunch) lifecycle.push(item('relaunch', M.relaunch));

  // What the old card carried as badges and buttons: the waiting ask, Snooze and the timers.
  const attention: MenuItem[] = [];
  if (input.hasApproval) attention.push(item('approval', M.approval));
  attention.push(
    item('snooze', M.snooze(SNOOZE_MS / 60_000)),
    item(
      'timed',
      M.timed,
      input.waitingTimers > 0 ? { detail: M.timedWaiting(input.waitingTimers) } : {},
    ),
  );

  const messaging: MenuItem[] = [];
  if (input.hasMcp && input.mcpHandle !== null) {
    const handle = input.mcpHandle;
    messaging.push(
      // The old card's connection badge, in words: it explains and never acts.
      {
        label: MCP_STR.install.connectedTip(handle),
        icon: icons.messages,
        disabled: true,
        onClick: () => {},
      },
      item('messages', MCP_STR.openMessages),
      item(
        'pauseMcp',
        input.mcpPaused ? MCP_STR.resumeNotices(handle) : MCP_STR.pauseNotices(handle),
      ),
    );
  }
  if (input.mcpSwitchable) messaging.push(item('mcpTools', MCP_STR.tools.menuItem));
  if (input.mcpSetupNeeded) messaging.push(item('setupMcp', MCP_STR.install.setupCommand));

  const groups: MenuItem[][] = [
    head,
    lifecycle,
    attention,
    messaging,
    [
      item('rename', M.rename),
      item('setIcon', M.setIcon),
      item('duplicate', M.duplicate),
      item('moveSpace', M.moveSpace),
      ...input.windowMoves,
    ],
    [item('copyHome', M.copyHome), item('copyName', M.copyName), item('reveal', M.reveal)],
    [
      item('close', M.close, { danger: true }),
      item('closeOthers', M.closeOthers, { danger: true, disabled: input.otherCount === 0 }),
      item('closeAll', M.closeAll, { danger: true }),
    ],
  ];
  // Each group after the first opens with a divider; an empty group adds none.
  return groups
    .filter((g) => g.length > 0)
    .flatMap((g, i) =>
      g.map((it, j) => (i > 0 && j === 0 ? { ...it, separatorBefore: true } : it)),
    );
}

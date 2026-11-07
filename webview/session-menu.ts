import type { ReactNode } from 'react';
import { SNOOZE_MS } from '../src/attention';
import type { Handle, McpUnavailableReason } from '../src/conduit-mcp/types';
import type { MenuActivation, MenuItem } from './components/context-menu';
import { MCP_STR } from './conduit-mcp-strings';
import type { CardMcpStatus } from './mcp-card-status';
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
  | 'closeSubAgents'
  | 'closeOthers'
  | 'closeAll';

/** Why messaging works or does not for this session, as the old card's badge said it. */
export type SessionMcpLink = CardMcpStatus | { kind: 'unavailable'; reason: McpUnavailableReason };

function mcpLinkTip(link: SessionMcpLink): string {
  if (link.kind === 'connected') return MCP_STR.install.connectedTip(link.handle);
  if (link.kind === 'unavailable') return MCP_STR.unavailable[link.reason];
  return link.install === 'installed'
    ? MCP_STR.install.notConnectedInstalledTip(link.cli)
    : MCP_STR.install.notConnectedTip(link.cli);
}

export interface SessionMenuInput {
  name: string;
  maySplit: boolean;
  canRelaunch: boolean;
  pinned: boolean;
  hasApproval: boolean;
  /** A reason or a pending ask: there is something to silence. Absent reads as false. */
  snoozable?: boolean;
  /** Epoch ms a live snooze ends, for its remaining time. */
  snoozedUntil?: number;
  /** The clock snoozedUntil is read against; defaults to now. */
  now?: number;
  waitingTimers: number;
  hasMcp: boolean;
  /** The pause entry names the handle; null while the session has none. */
  mcpHandle: Handle | null;
  mcpPaused: boolean;
  mcpSwitchable: boolean;
  mcpSetupNeeded: boolean;
  mcpLink?: SessionMcpLink | null;
  otherCount: number;
  allCount: number;
  /** Descendants under this row in the agent tree; the sub-agents entry shows only when > 0. */
  subAgentCount?: number;
  windowMoves: readonly MenuItem[];
  icons: Readonly<Record<SessionMenuAction, ReactNode>>;
  actions: Readonly<Record<SessionMenuAction, (activation?: MenuActivation) => void>>;
}

/**
 * The menu for a multi-selection (two or more rows): the one thing that applies to all of them.
 * Single-row items are left out on purpose; each would act on only one of the selected rows.
 */
export function buildSelectionMenu(input: {
  count: number;
  icon: ReactNode;
  onClose: () => void;
}): MenuItem[] {
  return [
    {
      label: SIDEBAR_STR.menu.closeSelected(input.count),
      icon: input.icon,
      danger: true,
      onClick: () => input.onClose(),
    },
  ];
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
  if (input.snoozable) {
    const left =
      input.snoozedUntil === undefined
        ? 0
        : Math.ceil((input.snoozedUntil - (input.now ?? Date.now())) / 60_000);
    attention.push(
      item('snooze', M.snooze(SNOOZE_MS / 60_000), left > 0 ? { detail: M.snoozedLeft(left) } : {}),
    );
  }
  attention.push(
    item(
      'timed',
      M.timed,
      input.waitingTimers > 0 ? { detail: M.timedWaiting(input.waitingTimers) } : {},
    ),
  );

  const messaging: MenuItem[] = [];
  // The old card's connection badge, in words: it explains and never acts.
  if (input.mcpLink)
    messaging.push({
      label: mcpLinkTip(input.mcpLink),
      icon: icons.messages,
      disabled: true,
      onClick: () => {},
    });
  if (input.hasMcp && input.mcpHandle !== null) {
    const handle = input.mcpHandle;
    messaging.push(
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
      ...(input.subAgentCount
        ? [item('closeSubAgents', M.closeSubAgents(input.subAgentCount), { danger: true })]
        : []),
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

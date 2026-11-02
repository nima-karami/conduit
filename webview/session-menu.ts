import type { ReactNode } from 'react';
import type { Handle } from '../src/conduit-mcp/types';
import type { MenuActivation, MenuItem } from './components/context-menu';
import { MCP_STR } from './conduit-mcp-strings';

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

  // Present only for the relevant state, so it can be empty; later dividers are gated on it so
  // the menu never opens with one.
  const lifecycle: MenuItem[] = [];
  if (input.maySplit) lifecycle.push(item('split', 'Open in split pane'));
  if (input.canRelaunch) lifecycle.push(item('relaunch', 'Relaunch'));

  const messaging: MenuItem[] = [];
  if (input.hasMcp && input.mcpHandle !== null) {
    const handle = input.mcpHandle;
    messaging.push(
      item('messages', MCP_STR.openMessages, { separatorBefore: lifecycle.length > 0 }),
      item(
        'pauseMcp',
        input.mcpPaused ? MCP_STR.resumeNotices(handle) : MCP_STR.pauseNotices(handle),
      ),
    );
  }
  if (input.mcpSwitchable)
    messaging.push(
      item('mcpTools', MCP_STR.tools.menuItem, {
        separatorBefore: messaging.length === 0 && lifecycle.length > 0,
      }),
    );
  if (input.mcpSetupNeeded)
    messaging.push(
      item('setupMcp', MCP_STR.install.setupCommand, {
        separatorBefore: messaging.length === 0 && lifecycle.length > 0,
      }),
    );

  return [
    ...lifecycle,
    ...messaging,
    item('rename', 'Rename', { separatorBefore: lifecycle.length + messaging.length > 0 }),
    item('setIcon', 'Set icon…'),
    item('timed', 'Timed message…'),
    item('duplicate', 'Duplicate session'),
    item('moveSpace', 'Move to project…'),
    ...input.windowMoves,
    item('copyHome', 'Copy home path', { separatorBefore: true }),
    item('copyName', 'Copy name'),
    item('reveal', 'Reveal in Explorer'),
    item('close', 'Close', { danger: true, separatorBefore: true }),
    item('closeOthers', 'Close others', { danger: true, disabled: input.otherCount === 0 }),
    item('closeAll', 'Close all', { danger: true }),
  ];
}

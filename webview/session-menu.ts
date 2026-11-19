import type { ReactNode } from 'react';
import { SNOOZE_MS } from '../src/attention';
import { pointKey } from '../src/conduit-mcp/policy-profiles';
import type { PolicyUiState, ProfileId } from '../src/conduit-mcp/policy-types';
import type { Handle, McpUnavailableReason } from '../src/conduit-mcp/types';
import type { HostPlatform } from '../src/lsp-binary';
import { platformWords } from '../src/platform-words';
import type { MenuActivation, MenuEntry, MenuItem } from './components/context-menu';
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

export function canOpenSessionPermissions(
  sessionId: string,
  ownedSessions: readonly { id: string }[],
  policySessions: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return (
    ownedSessions.some((session) => session.id === sessionId) &&
    policySessions?.[sessionId] !== undefined
  );
}

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
  /** Names the file manager in the reveal item. */
  platform: HostPlatform;
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
  permissionsSubmenu?: () => MenuItem[];
  /** The row's role and change count, shown beside Permissions (canvas E1). */
  mcpPermissions?: SessionPermissionSummary | null;
  mcpSetupNeeded: boolean;
  mcpLink?: SessionMcpLink | null;
  otherCount: number;
  allCount: number;
  /** Descendants under this row in the agent tree; the sub-agents entry shows only when > 0. */
  subAgentCount?: number;
  windowMoves: readonly MenuItem[];
  icons: Readonly<Record<SessionMenuAction | 'mcpTools', ReactNode>>;
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

export function buildSessionMenu(input: SessionMenuInput): MenuEntry[] {
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

  const messaging: MenuEntry[] = [];
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
  if (input.permissionsSubmenu)
    messaging.push({
      label: PERM.permissions,
      icon: icons.mcpTools,
      detail: input.mcpPermissions
        ? PERM.detail(input.mcpPermissions.roleName, input.mcpPermissions.changes)
        : undefined,
      submenu: input.permissionsSubmenu,
    });
  if (input.mcpSetupNeeded) messaging.push(item('setupMcp', MCP_STR.install.setupCommand));

  const groups: MenuEntry[][] = [
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
    [
      item('copyHome', M.copyHome),
      item('copyName', M.copyName),
      item('reveal', platformWords(input.platform).reveal),
    ],
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

const PERM = MCP_STR.sections.agents.menu;

export interface SessionPermissionSummary {
  profileId: ProfileId;
  roleName: string;
  /** The session's own changes; inherited assignments count as none, as in MCP › Agents. */
  changes: number;
}

export function sessionPermissionSummary(
  policy: PolicyUiState | undefined,
  sessionId: string,
): SessionPermissionSummary | null {
  const row = policy?.sessions[sessionId];
  if (!policy || !row) return null;
  const key = pointKey({ kind: 'session', sessionId });
  const own = policy.assignments.find((entry) => pointKey(entry.point) === key)?.assignment;
  return {
    profileId: row.profileId,
    roleName: policy.profiles.find((p) => p.id === row.profileId)?.name ?? row.profileName,
    changes: own?.exceptions.length ?? 0,
  };
}

/**
 * The Permissions submenu (canvas E1). Every pick lands in MCP › Agents on this agent's drawer:
 * a role or a reset is staged and opened at Review, never applied from the menu (spec §2).
 */
export function buildPermissionsSubmenu(input: {
  name: string;
  roles: readonly { id: ProfileId; name: string }[];
  summary: SessionPermissionSummary;
  /** Nothing can be staged: role and reset rows are disabled, Customize… still opens the drawer. */
  readOnly?: boolean;
  onPick(id: ProfileId): void;
  onReset(): void;
  onCustomize(): void;
}): MenuItem[] {
  const { summary } = input;
  return [
    { label: PERM.roleFor(input.name), key: 'role-for', disabled: true, onClick: () => {} },
    ...input.roles.map(
      (role): MenuItem => ({
        label: role.name,
        key: `role:${role.id}`,
        checked: role.id === summary.profileId,
        radio: true,
        disabled: input.readOnly === true,
        onClick: () => input.onPick(role.id),
      }),
    ),
    ...(summary.changes > 0
      ? [
          {
            label: MCP_STR.sections.agents.changesFrom(summary.changes, summary.roleName),
            key: 'changes',
            disabled: true,
            separatorBefore: true,
            onClick: () => {},
          },
          {
            label: PERM.resetToRole,
            key: 'reset',
            disabled: input.readOnly === true,
            onClick: input.onReset,
          },
        ]
      : []),
    {
      label: PERM.customize,
      key: 'customize',
      separatorBefore: true,
      onClick: input.onCustomize,
    },
  ];
}

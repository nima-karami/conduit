// User-facing strings for the Messages tab, card badges and the attention chip: one place for the
// future i18n seam (docs/specs/2026-10-25-conduit-mcp-server.md §10).

import type {
  AgentCli,
  ProjectEntryState,
  ProjectScope,
  UserInstallState,
} from '../src/conduit-mcp/install-types';
import type {
  Access,
  CliKind,
  Move,
  PolicyField,
  Reach,
  ToolGroup,
  ToolName,
  When,
} from '../src/conduit-mcp/tool-policy';
import type {
  McpAttentionReason,
  McpUnavailableReason,
  MessageKind,
  Priority,
  RecipientStatus,
  ToolErrorCode,
} from '../src/conduit-mcp/types';
import type { McpGateState } from '../src/conduit-mcp/ui-types';
import { countNoun } from '../src/menu-selection';

// Only the tools whose On bypasses every prompt get a line under their row (spec §8).
const ON_WARNING: Partial<Record<ToolName, string>> = {
  open_terminal: 'Runs without asking. Codex never asks on its own.',
};

const UNAVAILABLE_CAUSE: Record<McpUnavailableReason, string> = {
  'cmd-metachar': 'its launch command can’t carry the server safely',
  'unquotable-path': 'a server path can’t be quoted for this shell',
  'messaging-off': 'messaging is turned off',
  'endpoint-down': 'the message server isn’t running',
  'launch-io': 'its launch files couldn’t be written',
  'cursor-not-connected': 'Install Conduit for Cursor in Settings → MCP',
};

const SETTINGS_TOGGLE = 'Let agents message each other and you';

// Product names stay untranslated (spec 2026-10-27-conduit-mcp-install §10).
const CLI_NAME: Record<AgentCli, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};
// What the user types; the restart hint names it.
const CLI_COMMAND: Record<AgentCli, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'agent',
  opencode: 'opencode',
};

const INSTALL_ERROR_TEXT: Readonly<Record<string, string>> = {
  EJSON: 'it isn’t valid JSON',
  EJSONC: 'it has comments Conduit can’t keep',
  ETOML: 'it isn’t valid TOML',
  EUNEDITABLE: 'the server is defined in a form Conduit can’t edit',
  EGUARD: 'the edit didn’t check out, so nothing was written',
  EBUSY: 'the file changed while Conduit was writing it',
  ESTATE: 'it changed since it was last read',
  EPROJECT: 'that folder isn’t open in Conduit',
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  ENOSPC: 'the disk is full',
  // The host's catch-all and the renderer's rejected-invoke stand-in; the code itself stays in a title.
  EINVAL: 'something went wrong',
};
const PROJECT_SCOPE = { project: 'Project', local: 'Local' } satisfies Record<ProjectScope, string>;
const installErrorText = (code: string): string => INSTALL_ERROR_TEXT[code] ?? code;

export const MCP_STR = {
  tab: 'Messages',
  firstRun: 'Agents in your sessions can message each other and you. Messages appear here.',
  noUnread: 'No unread messages',
  showAll: 'Show all',
  unreadOnly: 'Unread only',
  loadError: 'Messages couldn’t be loaded',
  retry: 'Retry',
  off: 'Messaging is turned off',
  openSettings: 'Open Settings',
  newMessage: 'New message',
  reply: 'Reply',
  allowMore: 'Allow 20 more',
  paused: (n: number) => `Paused after ${countNoun(n, 'agent message', 'agent messages')}`,
  pausedShort: 'Paused',
  // Words inside an accessible name, mid-sentence; not the visible chips' title case.
  a11y: {
    unread: 'unread',
    urgent: 'urgent',
    paused: (n: number) => `paused after ${countNoun(n, 'agent message', 'agent messages')}`,
  },
  attachmentExpired: 'Attachment expired',
  send: 'Send',
  sending: 'Sending…',
  cancel: 'Cancel',
  close: 'Close',
  openAttachment: 'Open attachment',
  unread: (n: number) => countNoun(n, 'unread message', 'unread messages'),
  urgentBadge: (n: number) => countNoun(n, 'urgent message', 'urgent messages'),
  status: {
    queued: 'Queued',
    noticed: 'Noticed',
    read: 'Read',
    undelivered: 'Undelivered',
    expired: 'Expired',
  } satisfies Record<RecipientStatus, string>,
  priority: {
    fyi: 'FYI',
    normal: 'Normal',
    urgent: 'Urgent',
  } satisfies Record<Priority, string>,
  kind: {
    inform: 'Inform',
    request: 'Request',
    question: 'Question',
    done: 'Done',
  } satisfies Record<MessageKind, string>,
  unavailable: Object.fromEntries(
    Object.entries(UNAVAILABLE_CAUSE).map(([k, cause]) => [k, `Messaging unavailable: ${cause}`]),
  ) as Record<McpUnavailableReason, string>,
  // Plan ruling 4: the card names why notices are held.
  gate: {
    open: 'Notices on',
    'pull-only': 'Notices off: this agent reads its inbox when asked',
    off: 'Notices held: messaging is off',
    paused: 'Notices held: paused',
    'not-running': 'Notices held: not running',
    settling: 'Notices held: starting up',
    'no-connection': 'Notices held: agent not connected',
    busy: 'Notices held: busy',
    quiet: 'Notices held: waiting for quiet',
    'blocking-prompt': 'Notices held: prompt on screen',
    'no-empty-input': 'Notices held: input not ready',
    draft: 'Notices held: you are typing',
    spacing: 'Notices held: spacing out notices',
    'no-echo': 'Notices held: last notice not confirmed',
  } satisfies Record<McpGateState, string>,
  attention: {
    'urgent-waiting': (h: string) => `urgent message waiting for ${h}`,
    'message-to-you': (_h: string) => 'a message for you',
    'thread-paused': (h: string) => `a thread with ${h} is paused`,
    'unread-after-renotice': (h: string) => `${h} hasn’t read a message`,
    'unsent-notice': (h: string) => `a notice was left unsent in ${h}`,
  } satisfies Record<McpAttentionReason, (handle: string) => string>,
  pauseNotices: (h: string) => `Pause notices for ${h}`,
  resumeNotices: (h: string) => `Resume notices for ${h}`,
  noticesPaused: 'Notices paused',
  // The card's subtitle carries the handle that chips and threads name (e.g. "Claude · claude-1").
  cardMeta: (subtitle: string, handle: string) => (subtitle ? `${subtitle} · ${handle}` : handle),
  openMessages: 'Open messages',
  newMessages: (n: number) => countNoun(n, 'new message', 'new messages'),
  copyBody: 'Copy body',
  copyId: 'Copy message id',
  markRead: 'Mark read',
  threadList: 'Threads',
  thread: 'Thread',
  back: 'Back to threads',
  filteredTo: (h: string) => `Showing ${h}`,
  clearFilter: 'Clear filter',
  recipients: 'To',
  noRecipients: 'No session has messaging yet',
  subject: 'Subject',
  body: 'Message',
  priorityLabel: 'Priority',
  kindLabel: 'Kind',
  composeHint: 'Ctrl+Enter to send · Esc to cancel',
  sent: 'Sent',
  sendFailed: 'Not sent',
  refused: (h: string, reason: string) => `${h}: ${reason}`,
  refusal: {
    not_in_session: 'not in a session',
    unknown_handle: 'no session by that name',
    self_target: 'can’t message itself',
    too_large: 'too large',
    too_many: 'too many recipients',
    path_outside_roots: 'path outside the session’s folders',
    path_unreadable: 'file couldn’t be read',
    not_found: 'not found',
    unsupported_media: 'unsupported file type',
    rate_limited: 'too many messages, try again shortly',
    thread_limit: 'thread paused',
    store_unavailable: 'messages can’t be saved right now',
    messaging_off: 'messaging is turned off',
    host_unavailable: 'Conduit isn’t reachable',
    invalid_argument: 'the message is incomplete',
    tool_disabled: 'that tool isn’t enabled for this session',
    unknown_agent: 'no agent by that name',
    path_missing: 'path not found',
    not_a_directory: 'not a folder',
    not_a_file: 'not a file',
    invalid_args: 'the request is incomplete',
    command_not_found: 'command not found',
    brief_unavailable: 'the role brief couldn’t be prepared',
    open_failed: 'Conduit couldn’t open it',
    window_not_ready: 'Conduit’s window isn’t ready yet',
    caller_not_visible: 'that tool only works while the session is on screen',
    denied: 'you declined the request',
    approval_timeout: 'the request timed out waiting for you',
    cancelled: 'the request was cancelled',
  } satisfies Record<ToolErrorCode, string>,
  noResponse: 'Conduit didn’t answer. Try again.',
  you: 'you',
  from: (h: string) => `from ${h}`,
  to: (hs: readonly string[]) => `to ${hs.join(', ')}`,
  attachmentBytes: (n: number) => `${new Intl.NumberFormat().format(n)} bytes`,
  attachmentUnsupported: 'This attachment can’t be shown here.',
  attachmentLoading: 'Loading attachment…',
  attachmentMissing: 'The attachment couldn’t be read.',
  noSubject: '(no subject)',
  threadGone: 'This thread is no longer available.',
  settingsTitle: 'Messaging',
  settingsToggle: SETTINGS_TOGGLE,
  settingsDesc:
    'Agents in your sessions can message each other and you through Conduit. Turning it off stops new launches from connecting.',
  // Settings Tools group and the per-session dialog share these (tool-policy spec §8, §10).
  tools: {
    description: {
      list_sessions: 'Lets an agent see the other sessions it can message.',
      send_message: 'Lets an agent message other sessions and you.',
      read_inbox: 'Lets an agent read the messages sent to it.',
      read_attachment: 'Lets an agent open files attached to its messages.',
      open_session: 'Lets an agent start sessions from your profiles.',
      open_terminal: 'Lets an agent run any program as you, outside its own sandbox.',
      open_file: 'Lets an agent open files in your editor.',
    } satisfies Record<ToolName, string>,
    overrideNote: 'Sessions can override these from their menu (MCP tools…).',
    masterOffHint: `Turn on “${SETTINGS_TOGGLE}” to use tools`,
    menuItem: 'MCP tools…',
    dialogTitle: (label: string) => `MCP tools — ${label}`,
    relaunchHint: 'Some agents only see newly enabled tools after Relaunch',
    relaunch: 'Relaunch',
    saveFailed: 'Couldn’t save. Change it again to retry.',
    announce: (tool: string, value: string, label: string) =>
      `${tool} set to ${value} for ${label}`,
    openedBy: (handle: string) => `Opened by ${handle}`,
    // The policy editor (spec 2026-10-30-conduit-mcp-tool-policy §8–§10).
    group: {
      messaging: 'Messaging',
      sessions: 'Sessions',
      editor: 'Editor & views',
    } satisfies Record<ToolGroup, string>,
    accessLabel: (tool: string) => `${tool} access`,
    fieldAria: (tool: string, field: string) => `${tool} ${field}`,
    access: { off: 'Off', ask: 'Ask', on: 'On' } satisfies Record<Access, string>,
    when: { viewing: 'While on screen', always: 'Always' } satisfies Record<When, string>,
    reach: {
      self: 'Itself',
      opened: 'Sessions it opened',
      window: 'Its window',
      any: 'Any session',
    } satisfies Record<Reach, string>,
    move: { yes: 'May switch your view', no: 'Never switch your view' } satisfies Record<
      Move,
      string
    >,
    fieldLabel: { when: 'When', reach: 'Reach', move: 'Move' } satisfies Record<
      Exclude<PolicyField, 'access'>,
      string
    >,
    conditions: 'Conditions',
    inherited: (value: string, from: string) => `Inherit (${value} · from ${from})`,
    layerName: { global: 'All CLIs', session: 'this session' },
    cliName: {
      claude: 'Claude',
      codex: 'Codex',
      cursor: 'Cursor',
      opencode: 'OpenCode',
      agent: 'Other',
    } satisfies Record<CliKind, string>,
    defaultsFor: 'Defaults for',
    cliLayerNote:
      'A session follows the CLI that connected first in it. A convenience, not a security boundary.',
    onWarning: ON_WARNING,
  },
  // Settings → MCP, the card indicator, the setup banner and the Messages empty state
  // (spec 2026-10-27-conduit-mcp-install §2.3–§2.6, §8).
  install: {
    tab: 'MCP',
    clisTitle: 'Agent CLIs',
    toolsTitle: 'Tools',
    suggestTitle: 'Suggestions',
    clisDesc:
      'Adds Conduit to each CLI’s own MCP config, so agents you start in any Conduit terminal can message each other and you. Outside Conduit the server lists no tools. Uninstall here before removing Conduit.',
    messagingNotices:
      'When a message arrives for an idle agent, Conduit types a short notice into its session. Pause notices for one session from its menu.',
    suggestToggle: 'Suggest setup when an agent CLI can’t connect',
    suggestDesc:
      'Shows a banner in a terminal where you start an agent CLI that isn’t set up for Conduit.',
    masterOffHint: 'Messaging is off; installed CLIs get no tools.',
    cliName: CLI_NAME,
    cliCommand: CLI_COMMAND,
    state: {
      'not-installed': 'Not installed',
      installed: 'Installed',
      'other-conduit': 'Installed by another Conduit',
      conflict: 'Another “conduit” server',
      error: 'Configuration error',
      'not-found': 'Not found',
      checking: 'Checking…',
      pending: 'Working…',
    } satisfies Record<UserInstallState | 'checking' | 'pending', string>,
    install: 'Install',
    uninstall: 'Uninstall',
    useThis: 'Use this Conduit',
    replace: 'Replace…',
    checkAgain: 'Check again',
    tryAgain: 'Try again',
    remove: 'Remove',
    installProject: 'Install for this project',
    installAria: (cli: AgentCli) => `Install Conduit for ${CLI_NAME[cli]}`,
    uninstallAria: (cli: AgentCli) => `Uninstall Conduit from ${CLI_NAME[cli]}`,
    adoptAria: (cli: AgentCli) => `Use this Conduit for ${CLI_NAME[cli]}`,
    replaceAria: (cli: AgentCli) => `Replace the “conduit” server for ${CLI_NAME[cli]}`,
    checkAgainAria: (cli: AgentCli) => `Check ${CLI_NAME[cli]} again`,
    tryAgainAria: (cli: AgentCli) => `Try again for ${CLI_NAME[cli]}`,
    removeAria: (cli: AgentCli, scope: ProjectScope) =>
      `Remove the ${PROJECT_SCOPE[scope]} Conduit entry for ${CLI_NAME[cli]}`,
    installProjectAria: (cli: AgentCli) => `Install Conduit for ${CLI_NAME[cli]} in this project`,
    actionFailed: (path: string, code: string) =>
      path
        ? `Couldn’t update ${path}: ${installErrorText(code)}`
        : `Couldn’t update: ${installErrorText(code)}`,
    errorDetail: installErrorText,
    shadowed: (scope: ProjectScope) =>
      `Overridden in this project by its ${PROJECT_SCOPE[scope]} entry`,
    unreadable: 'Couldn’t read the config. Check again.',
    actionDone: (state: string, path: string) => `${state}. ${path}`,
    codexTrustNote: 'Codex reads a project’s config only when you trust the project.',
    cursorNote: 'Cursor may ask you to allow each Conduit tool the first time it runs.',
    projectTitle: 'This project',
    projectNone: 'No Conduit entries in this project.',
    projectWarn:
      'Installing adds a config file to this project. It contains paths on this computer; don’t commit it.',
    projectScope: PROJECT_SCOPE,
    projectState: {
      ours: 'Installed',
      'other-conduit': 'Installed by another Conduit',
      conflict: 'Another “conduit” server',
      error: 'Configuration error',
    } satisfies Record<ProjectEntryState, string>,
    replaceTitle: 'Replace the “conduit” server?',
    replaceConfirm: 'Replace',
    replaceBody: (path: string, backup: string) =>
      `${path} already has a “conduit” server that isn’t Conduit. Replacing it backs the file up first, to ${backup}.`,
    connectedTip: (handle: string) => `Connected to Conduit as ${handle}`,
    notConnectedTip: (cli: AgentCli) =>
      `Not connected: install Conduit for ${CLI_NAME[cli]} in Settings → MCP`,
    notConnectedInstalledTip: (cli: AgentCli) =>
      `${CLI_NAME[cli]} didn’t connect to Conduit. Restart it in this terminal.`,
    bannerBody: (cli: AgentCli) =>
      `${CLI_NAME[cli]} isn’t connected to Conduit. Install Conduit for ${CLI_NAME[cli]} so agents you start in any terminal can message each other and you.`,
    bannerInstall: (cli: AgentCli) => `Install for ${CLI_NAME[cli]}`,
    bannerInstalling: 'Installing…',
    bannerDismiss: 'Don’t suggest again',
    bannerClose: 'Close Conduit setup suggestion',
    // Cursor's command is a bare "agent", which reads as no product at all.
    bannerInstalled: (cli: AgentCli) =>
      cli === 'cursor'
        ? `Installed. Restart ${CLI_NAME.cursor} Agent in this terminal to connect.`
        : `Installed. Restart ${CLI_COMMAND[cli]} in this terminal to connect.`,
    bannerOpenSettings: 'Open MCP settings',
    bannerAnnounce: (cli: AgentCli) => `Conduit setup suggestion for ${CLI_NAME[cli]}`,
    bannerRegion: 'Conduit setup',
    setupCommand: 'Set up Conduit MCP…',
    setupTitle: 'Agents can message each other and you.',
    setupBody: 'Install Conduit for your agent CLIs so ones started in any terminal can join.',
    setupButton: 'Set up agent CLIs',
  },
} as const;

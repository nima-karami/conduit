// User-facing strings for the Machines section, the Add machine dialog and remote panes: one place
// for the future i18n seam (docs/specs/2026-11-16-remote-ssh.md §9.3), in SIDEBAR_STR's style.

import type { Presence } from '../src/conduit-mcp/types';
import type { MachineError, MachineErrorCode, MachineState } from '../src/contracts/machines';
import type { SshNeedsPersonReason } from '../src/contracts/ssh-link';

const plural = new Intl.PluralRules(undefined);
const number = new Intl.NumberFormat(undefined);
const time = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

function count(n: number, one: string, many: string): string {
  return `${number.format(n)} ${plural.select(n) === 'one' ? one : many}`;
}

/** An ISO time as local hours and minutes; an unparseable value is shown as it came. */
function clock(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : time.format(t);
}

const STATE: Record<MachineState, string> = {
  connecting: 'Connecting…',
  up: 'Connected',
  degraded: 'Slow connection',
  down: 'Offline',
  incompatible: 'Needs a Conduit update',
  'identity-changed': 'Its identity changed',
  revoked: 'Removed',
  disabled: 'Disconnected',
};

const ERROR: Record<MachineErrorCode, string> = {
  machine_unknown: 'Conduit doesn’t know that machine.',
  ssh_needs_person: 'ssh needs you to answer a prompt first.',
  ssh_unreachable: 'Couldn’t reach it over ssh.',
  ssh_auth_failed: 'ssh refused the login.',
  remote_unsupported: 'Conduit can’t run on that system yet.',
  install_failed: 'Installing Conduit there failed.',
  identity_changed: 'Its Conduit identity changed since you added it.',
  identity_conflict: 'That computer is already added under another name.',
  peer_incompatible: 'It runs a Conduit version this one can’t talk to.',
};

/** Faults raised on this computer before the remote was reached (electron/machine-replies.ts). */
const LOCAL_REASON: Record<string, string> = {
  timeout: 'Conduit’s background service didn’t answer in time.',
  disconnected: 'Conduit’s background service isn’t running.',
  unavailable: 'Conduit’s background service isn’t running.',
};

/** What a needs-person reason asks of the owner, phrased as the row's status (§9.1). */
const NEEDS: Record<SshNeedsPersonReason, string> = {
  host_key_unknown: 'accept its host key',
  host_key_changed: 'check its changed host key',
  passphrase: 'enter your key passphrase',
  password: 'enter your password',
  mfa: 'answer the sign-in prompt',
};

// The reason arrives as MachineError detail text, so it is checked rather than trusted.
const isNeedsReason = (r: string): r is SshNeedsPersonReason => Object.hasOwn(NEEDS, r);

const PRESENCE: Record<Presence, string> = {
  busy: 'Working',
  idle: 'Idle',
  exited: 'Exited',
};

/** The fault codes a remote pane can get back from C2, as one line of text. */
const PANE_ERROR: Record<string, string> = {
  peer_unreachable: 'That machine isn’t reachable right now.',
  peer_revoked: 'That machine was removed.',
  refused: 'That machine refused.',
  unavailable: 'That session isn’t available.',
};

export const MACHINES_STR = {
  machines: 'Machines',
  addMachine: 'Add machine',
  emptyTitle: 'Add a machine',
  emptyHint: 'Run agents on your other computers over SSH.',
  settingTitle: 'Show Machines in the sidebar',
  settingDesc:
    'Add other computers over SSH and watch their agents here. Shown anyway once a machine is added',
  state: (s: MachineState) => STATE[s],
  offlineSince: (iso: string | null) =>
    iso ? `Offline since ${clock(iso)} · retrying` : 'Offline · retrying',
  needsYou: (name: string, reason: string) =>
    `${name} needs you: ${isNeedsReason(reason) ? NEEDS[reason] : 'answer an ssh prompt'}`,
  error: (code: MachineErrorCode) => ERROR[code],
  /**
   * A machine error as one line. A reason naming the local service (a timeout, a dropped pipe) wins
   * over the code: the app maps those to ssh_unreachable, but the remote was never asked.
   */
  errorText: (e: MachineError) =>
    typeof e.detail.reason === 'string' && Object.hasOwn(LOCAL_REASON, e.detail.reason)
      ? LOCAL_REASON[e.detail.reason]
      : ERROR[e.code],
  sessions: (n: number) => count(n, 'session', 'sessions'),
  os: (os: string | null) =>
    os === 'linux' ? 'Linux' : os === 'windows' ? 'Windows' : 'Unknown OS',
  mode: (m: 'full' | 'light' | null) => (m === 'light' ? 'Light' : m === 'full' ? 'Full' : ''),
  /** The machine row's accessible name: state is words, never colour alone (§9.3). */
  rowLabel: (o: { name: string; status: string; sessions: number }) =>
    `${o.name}, ${o.status}, ${count(o.sessions, 'session', 'sessions')}`,
  // Row actions (§9.1, §9.2).
  connect: 'Connect',
  retryNow: 'Retry now',
  disconnect: 'Disconnect',
  rename: 'Rename',
  remove: 'Remove',
  copyFix: 'Copy fix',
  reconfirm: 'Re-confirm',
  removeTitle: (name: string) => `Remove ${name}?`,
  removeBody:
    'Conduit forgets this machine here. Sessions running on it keep running, and you can add it again.',
  renameLabel: 'Machine name',
  renameHint: '1–64 characters',
  // Palette.
  paletteAdd: 'Add machine…',
  paletteConnect: (name: string) => `Connect ${name}`,
  paletteDisconnect: (name: string) => `Disconnect ${name}`,
  // Remote session rows.
  badge: (machine: string) => `on ${machine}`,
  presence: (p: Presence) => PRESENCE[p],
  remoteRowLabel: (o: { label: string; presence: Presence; machine: string }) =>
    `${o.label}, ${PRESENCE[o.presence]}, on ${o.machine}`,
  // Add dialog.
  addTitle: 'Add a machine',
  hostsLabel: 'Hosts in your ssh config',
  noHosts: 'No hosts in ~/.ssh/config',
  targetLabel: 'Or type an ssh target',
  targetPlaceholder: 'user@host or user@host:port',
  dialing: (target: string) => `Connecting to ${target}…`,
  connectInTerminal: 'Connect in a terminal',
  needsPersonHint: 'Answer ssh in the terminal, then come back and press Retry.',
  retry: 'Retry',
  cancel: 'Cancel',
  // Remote pane.
  reconnecting: (machine: string) => `Reconnecting to ${machine}…`,
  readOnly: (machine: string) => `Read only: ${machine} doesn’t let this computer type here`,
  exited: 'Session ended',
  closeSession: 'Close session',
  attaching: (machine: string) => `Opening the terminal on ${machine}…`,
  paneError: (code: string) => PANE_ERROR[code] ?? 'Something went wrong talking to that machine.',
};

// Pure: the link manager feeds it snapshots and link states; nothing here does IO or timers.
// Plan: 2026-11-14-conduit-network-machinery.plan.md, Slice 5 (T5.1).

import type { RemoteEntry, RemoteResolution } from '../conduit-mcp/remote-routing';
import type { WaitReading } from '../conduit-mcp/session-waits';
import type { Handle } from '../conduit-mcp/types';
import {
  BARE_HANDLE,
  type Capabilities,
  type LinkState,
  type MonitorOpener,
  type MonitorSession,
  type MonitorSnapshot,
} from '../contracts/link-protocol';
import { displayNames, formatAddress, parseAddress, printableName } from './addresses';

export interface RemoteLinkInfo {
  machineId: string;
  name: string;
  state: LinkState;
  peerCapabilities: Capabilities | null;
}

export interface RemoteDirectory {
  /** Ignored for a machine that has no link, and for a seq not newer than the last applied one. */
  apply(machineId: string, snapshot: MonitorSnapshot): void;
  /** The full current link list. A machine missing from it loses its snapshot. */
  setLinks(links: RemoteLinkInfo[], selfName: string): void;
  entries(): RemoteEntry[];
  resolve(target: string): RemoteResolution;
  waitReading(address: string, callerHandle: Handle): WaitReading | 'unreachable' | null;
  snapshotOf(machineId: string): MonitorSnapshot | null;
}

/** A link that has ended for good; its peer's sessions must not be routed to. */
const TERMINAL: ReadonlySet<LinkState> = new Set(['revoked', 'incompatible', 'identity-changed']);

interface Row {
  entry: RemoteEntry;
  session: MonitorSession;
}

type LinkLookup = { link: RemoteLinkInfo } | { hint: string };

/**
 * The name a link is shown by. A peer's own text reaches hints and rows only once it passes
 * printableName; otherwise the machine id stands in (CON-27 R3).
 */
const shownName = (link: RemoteLinkInfo): string =>
  printableName(link.name) ? link.name : link.machineId;

function terminalHint(link: RemoteLinkInfo): string | null {
  switch (link.state) {
    case 'revoked':
      return `${shownName(link)} is revoked`;
    case 'incompatible':
      return `${shownName(link)} is incompatible`;
    case 'identity-changed':
      return `${shownName(link)} changed identity`;
    default:
      return null;
  }
}

/**
 * The opener as I name it. A peer names its own local opener with no machine id, so that one is on
 * the peer. My own machine's opener is my local lead, shown by handle as my own rows are.
 */
function openerOf(
  link: RemoteLinkInfo,
  opener: MonitorOpener | null | undefined,
  selfMachineId: string | null,
): MonitorOpener | null {
  if (!opener) return null;
  if (opener.machineId === null) return { handle: opener.handle, machineId: link.machineId };
  if (opener.machineId === selfMachineId) return { handle: opener.handle, machineId: null };
  return { handle: opener.handle, machineId: opener.machineId };
}

function linkOf(state: LinkState): RemoteEntry['link'] {
  if (state === 'up') return 'up';
  if (state === 'degraded') return 'degraded';
  return 'down';
}

export function createRemoteDirectory(
  selfMachineId: () => string | null = () => null,
): RemoteDirectory {
  let links: RemoteLinkInfo[] = [];
  let selfName = '';
  const snapshots = new Map<string, MonitorSnapshot>();

  // The seq guard lives in `snapshots`: a dropped machine loses its last seq too, so a re-link
  // that restarts the peer's counter is not silently ignored.
  function rows(): Row[] {
    const names = displayNames(
      links.map((l) => ({ machineId: l.machineId, name: shownName(l) })),
      selfName,
    );
    return links.flatMap((link) => {
      if (TERMINAL.has(link.state) || link.peerCapabilities?.messaging !== true) return [];
      const snapshot = snapshots.get(link.machineId);
      if (snapshot === undefined) return [];
      const machine = names.get(link.machineId) ?? shownName(link);
      return snapshot.sessions.flatMap((session): Row[] => {
        const handle = session.handle;
        // The frame parser refuses these too; a row is where a forged address would be shown.
        if (handle === null || !BARE_HANDLE.test(handle)) return [];
        return [
          {
            session,
            entry: {
              handle,
              sessionId: session.sessionId,
              openedBy: null,
              label: session.label,
              agent: session.agent,
              project: null,
              home: session.home,
              roots: session.roots,
              presence: session.presence,
              messaging: session.messaging,
              connectable: session.messageable,
              notices: session.notices,
              address: formatAddress(handle, link.machineId),
              display: `${handle}@${machine}`,
              machineId: link.machineId,
              machine,
              trust: 'own',
              link: linkOf(link.state),
              opener: openerOf(link, session.openedBy, selfMachineId()),
            },
          },
        ];
      });
    });
  }

  function findLink(machine: string): LinkLookup {
    const byId = links.find((l) => l.machineId === machine);
    if (byId !== undefined) return { link: byId };
    const key = machine.trim().toLowerCase();
    const named = links.filter((l) => l.name.trim().toLowerCase() === key);
    if (named.length === 0) {
      return { hint: `no link to ${machine}; link it in Settings → Machines` };
    }
    if (named.length > 1) {
      return { hint: `two machines are named ${machine}; use its machine id` };
    }
    const [only] = named;
    if (only === undefined)
      return { hint: `no link to ${machine}; link it in Settings → Machines` };
    return { link: only };
  }

  function lookup(
    target: string,
  ): { kind: 'row'; row: Row } | { kind: 'resolution'; res: RemoteResolution } {
    const parsed = parseAddress(target);
    if (parsed === null)
      return { kind: 'resolution', res: { kind: 'unknown', hint: 'not a session address' } };
    if (parsed.machine === null) {
      return { kind: 'resolution', res: { kind: 'local', handle: parsed.handle } };
    }
    const found = findLink(parsed.machine);
    if (!('link' in found))
      return { kind: 'resolution', res: { kind: 'unknown', hint: found.hint } };
    const hint = terminalHint(found.link);
    if (hint !== null) return { kind: 'resolution', res: { kind: 'unknown', hint } };
    const row = rows().find(
      (r) => r.entry.machineId === found.link.machineId && r.entry.handle === parsed.handle,
    );
    if (row === undefined) {
      return {
        kind: 'resolution',
        res: { kind: 'unknown', hint: `no session ${parsed.handle} on ${found.link.name}` },
      };
    }
    return { kind: 'row', row };
  }

  return {
    apply(machineId, snapshot) {
      if (!links.some((l) => l.machineId === machineId)) return;
      const last = snapshots.get(machineId);
      if (last !== undefined && snapshot.seq <= last.seq) return;
      snapshots.set(machineId, snapshot);
    },

    setLinks(next, name) {
      links = next.map((l) => ({ ...l }));
      selfName = name;
      const live = new Set(links.map((l) => l.machineId));
      for (const machineId of [...snapshots.keys()]) {
        if (!live.has(machineId)) snapshots.delete(machineId);
      }
    },

    entries() {
      return rows().map((r) => r.entry);
    },

    resolve(target) {
      const found = lookup(target);
      return found.kind === 'row' ? { kind: 'remote', entry: found.row.entry } : found.res;
    },

    // A caller is always local, so its own handle never names a remote row and is not needed here.
    waitReading(address) {
      const found = lookup(address);
      if (found.kind === 'resolution') return null;
      if (found.row.entry.link === 'down') return 'unreachable';
      const { entry, session } = found.row;
      return {
        sessionId: entry.sessionId,
        handle: entry.address,
        presence: session.presence,
        needsYou: session.attention.attentionReason !== null,
        completions: session.completions,
        // The caller fills this from its own message store; the snapshot has no per-caller count.
        unreadFrom: 0,
      };
    },

    snapshotOf(machineId) {
      return snapshots.get(machineId) ?? null;
    },
  };
}

import type { DirectoryEntry } from '../../src/conduit-mcp/tools';
import type {
  Capabilities,
  LinkFrame,
  LinkState,
  MonitorSession,
  MonitorSnapshot,
} from '../../src/contracts/link-protocol';
import type { SessionView } from '../../src/contracts/server-protocol';

// Pushes this server's sessions, attention and asks to each linked peer (plan T5.3). What a peer
// gets follows what *I* enable on its link (NET §4.1): session rows for messaging or monitor,
// asks/unread/presence for monitor, the agent list for drive. Nothing for neither.

export interface MonitorSource {
  sessions(): MonitorSession[];
  requests(): MonitorSnapshot['requests'];
  youUnread(): number;
  ownerPresence(): 'here' | 'away';
  agents(): MonitorSnapshot['agents'];
}

/** A local opener is named by its handle; a session whose opener has no listed handle names none. */
function openerOf(
  entry: DirectoryEntry | undefined,
  bySession: ReadonlyMap<string, DirectoryEntry>,
): MonitorSession['openedBy'] {
  if (!entry?.openedBy) return null;
  const opener = bySession.get(entry.openedBy);
  return opener ? { handle: opener.handle, machineId: null } : null;
}

export function monitorRows(
  sessions: SessionView[],
  directory: DirectoryEntry[],
): MonitorSession[] {
  const bySession = new Map(directory.map((entry) => [entry.sessionId, entry]));
  return sessions.map((session) => {
    const entry = bySession.get(session.id);
    return {
      sessionId: session.id,
      handle: entry?.handle ?? null,
      label: session.name,
      agent: entry?.agent ?? session.agentId,
      presence:
        entry?.presence ??
        (session.status === 'running' ? (session.busy ? 'busy' : 'idle') : 'exited'),
      messaging: entry?.messaging ?? 'unavailable',
      messageable: entry ? entry.connectable || entry.messaging === 'connected' : false,
      notices: entry?.notices ?? 'pull',
      home: session.home,
      roots: session.roots,
      attention: {
        attentionReason: session.attentionReason ?? null,
        completions: session.completions ?? 0,
        ...(session.stuckReason === undefined ? {} : { stuckReason: session.stuckReason }),
      },
      completions: session.completions ?? 0,
      limit: null,
      status: session.status,
      openedBy: openerOf(entry, bySession),
    };
  });
}

export interface PublisherLink {
  machineId: string;
  state: LinkState;
  capabilities: Capabilities;
  /** The peer's protocol minor from its hello; absent until the hello lands. */
  peerMinor?: number;
}

// see docs/plans/2026-11-16-remote-ssh-routed-tools.plan.md, decision 3: an opener is minor 2
// only, so a peer below it never sees the field its strict parser would refuse.
const OPENER_MIN_MINOR = 2;
const withoutOpeners = (s: MonitorSession): MonitorSession => {
  const shown = { ...s };
  delete shown.openedBy;
  return shown;
};

export interface MonitorPublisherDeps {
  source: MonitorSource;
  links(): PublisherLink[];
  send(machineId: string, frame: LinkFrame): boolean | null;
  /** Runs fn after ms; returns its cancel. */
  after(fn: () => void, ms: number): () => void;
  coalesceMs?: number;
}

export interface MonitorPublisher {
  /** Something local changed: push to every up link, coalesced. */
  changed(): void;
  /** A link just came up or its capabilities changed: push to it now. */
  pushTo(machineId: string): void;
  stop(): void;
}

const COALESCE_MS = 500;
const live = (s: LinkState) => s === 'up' || s === 'degraded';

export function snapshotFor(
  caps: Capabilities,
  source: MonitorSource,
  seq: number,
): MonitorSnapshot | null {
  if (!caps.messaging && !caps.monitor) return null;
  if (!caps.monitor) {
    // A messaging-only peer gets the addressing it needs and nothing about the rest of my work.
    return {
      seq,
      sessions: source
        .sessions()
        .filter((s) => s.handle !== null)
        .map((s) => ({
          ...s,
          home: '',
          roots: [],
          attention: { attentionReason: null, completions: 0 },
          completions: 0,
          limit: null,
          // Lineage is part of the rest of my work, which this peer is not shown.
          openedBy: null,
        })),
      requests: [],
      youUnread: 0,
      ownerPresence: 'here',
      agents: caps.drive ? source.agents() : [],
    };
  }
  return {
    seq,
    sessions: source.sessions(),
    requests: source.requests(),
    youUnread: source.youUnread(),
    ownerPresence: source.ownerPresence(),
    agents: caps.drive ? source.agents() : [],
  };
}

export function createMonitorPublisher(deps: MonitorPublisherDeps): MonitorPublisher {
  let seq = 0;
  let cancel: (() => void) | null = null;

  const push = (link: PublisherLink): void => {
    if (!live(link.state)) return;
    seq += 1;
    const snapshot = snapshotFor(link.capabilities, deps.source, seq);
    if (!snapshot) return;
    const openers = link.peerMinor !== undefined && link.peerMinor >= OPENER_MIN_MINOR;
    deps.send(link.machineId, {
      t: 'snapshot',
      snapshot: openers
        ? snapshot
        : { ...snapshot, sessions: snapshot.sessions.map(withoutOpeners) },
    });
  };

  return {
    changed() {
      if (cancel) return;
      cancel = deps.after(() => {
        cancel = null;
        for (const link of deps.links()) push(link);
      }, deps.coalesceMs ?? COALESCE_MS);
    },
    pushTo(machineId) {
      const link = deps.links().find((l) => l.machineId === machineId);
      if (link) push(link);
    },
    stop() {
      cancel?.();
      cancel = null;
    },
  };
}

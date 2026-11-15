import { describe, expect, it } from 'vitest';
import {
  createMonitorPublisher,
  type MonitorSource,
  monitorRows,
  type PublisherLink,
  snapshotFor,
} from '../../server/network/monitor-publisher';
import type { Capabilities, LinkFrame, MonitorSession } from '../../src/contracts/link-protocol';

const session: MonitorSession = {
  sessionId: 's1',
  handle: 'claude-1',
  label: 'Claude',
  agent: 'claude',
  presence: 'idle',
  messaging: 'connected',
  messageable: true,
  notices: 'typed',
  home: '/w',
  roots: [],
  attention: { attentionReason: null, completions: 2 },
  completions: 2,
  limit: null,
  status: 'running',
};
const source: MonitorSource = {
  sessions: () => [session],
  requests: () => [
    {
      requestId: 'r_1',
      type: 'approve',
      summary: 'run tests',
      sessionHandle: 'claude-1',
      createdAt: 'x',
    },
  ],
  youUnread: () => 3,
  ownerPresence: () => 'away',
  agents: () => [{ id: 'claude', label: 'Claude' }],
};
const caps = (messaging: boolean, monitor: boolean, drive: boolean): Capabilities => ({
  messaging,
  monitor,
  drive,
});

describe('snapshotFor', () => {
  it('sends nothing when neither messaging nor monitor is enabled', () => {
    expect(snapshotFor(caps(false, false, true), source, 1)).toBeNull();
  });
  it('messaging only: handled session rows, stripped of home, roots, attention and asks', () => {
    const handleless: MonitorSession = { ...session, sessionId: 's2', handle: null };
    const messagingOnly: MonitorSource = {
      ...source,
      sessions: () => [session, handleless],
    };
    expect(snapshotFor(caps(true, false, false), messagingOnly, 1)).toEqual({
      seq: 1,
      sessions: [
        {
          ...session,
          home: '',
          roots: [],
          attention: { attentionReason: null, completions: 0 },
          completions: 0,
          limit: null,
        },
      ],
      requests: [],
      youUnread: 0,
      ownerPresence: 'here',
      agents: [],
    });
  });
  it('monitor adds asks, unread and presence; drive adds the agent list', () => {
    const s = snapshotFor(caps(true, true, true), source, 4);
    expect(s?.requests).toHaveLength(1);
    expect(s?.youUnread).toBe(3);
    expect(s?.ownerPresence).toBe('away');
    expect(s?.agents).toEqual([{ id: 'claude', label: 'Claude' }]);
  });
});

describe('monitor publisher', () => {
  function setup(links: PublisherLink[]) {
    const sent: Array<{ machineId: string; frame: LinkFrame }> = [];
    let fire: (() => void) | null = null;
    const pub = createMonitorPublisher({
      source,
      links: () => links,
      send: (machineId, frame) => {
        sent.push({ machineId, frame });
        return true;
      },
      after: (fn) => {
        fire = fn;
        return () => {
          fire = null;
        };
      },
    });
    return { pub, sent, fire: () => fire?.() };
  }

  it('coalesces changes into one push per live link, with rising seq', () => {
    const { pub, sent, fire } = setup([
      { machineId: 'm-1', state: 'up', capabilities: caps(true, true, false) },
      { machineId: 'm-2', state: 'down', capabilities: caps(true, true, false) },
      { machineId: 'm-3', state: 'degraded', capabilities: caps(false, false, false) },
    ]);
    pub.changed();
    pub.changed();
    fire();
    expect(sent.map((s) => s.machineId)).toEqual(['m-1']);
    pub.pushTo('m-1');
    const seqs = sent.map((s) => (s.frame.t === 'snapshot' ? s.frame.snapshot.seq : -1));
    expect(seqs[1]).toBeGreaterThan(seqs[0] ?? 0);
  });

  it('stop cancels a pending push', () => {
    const { pub, sent, fire } = setup([
      { machineId: 'm-1', state: 'up', capabilities: caps(true, false, false) },
    ]);
    pub.changed();
    pub.stop();
    fire();
    expect(sent).toEqual([]);
  });
});

it('includes non-MCP sessions in the monitor snapshot without granting messaging', () => {
  const rows = monitorRows(
    [
      {
        id: 'echo',
        name: 'Echo',
        agentId: 'echo',
        home: '/w',
        roots: [],
        status: 'running',
        attentionReason: null,
        completions: 0,
        createdAt: 0,
        lastActiveAt: 0,
        runtime: { generation: null, spawn: 'none', reportedStatus: null, lastSize: null },
      },
    ],
    [],
  );
  expect(rows).toMatchObject([
    {
      sessionId: 'echo',
      handle: null,
      label: 'Echo',
      agent: 'echo',
      messaging: 'unavailable',
      messageable: false,
      notices: 'pull',
    },
  ]);
});

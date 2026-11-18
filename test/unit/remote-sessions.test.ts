import { describe, expect, it } from 'vitest';
import type { MonitorSession, MonitorSnapshot } from '../../src/contracts/link-protocol';
import type { MachineView } from '../../src/contracts/machines';
import type { NetworkLinkView, NetworkState } from '../../src/contracts/network-state';
import { remoteSessionRows } from '../../webview/remote-sessions';

const LOCAL = 'm-00000001';
const B = 'm-0000000b';
const C = 'm-0000000c';

function monitorSession(id: string, o: Partial<MonitorSession> = {}): MonitorSession {
  return {
    sessionId: id,
    handle: `h-${id}`,
    label: id,
    agent: 'claude',
    presence: 'busy',
    messaging: 'connected',
    messageable: true,
    notices: 'typed',
    home: '/w',
    roots: [],
    attention: { attentionReason: null, completions: 0 },
    completions: 0,
    limit: null,
    status: 'running',
    ...o,
  };
}

function snapshot(sessions: MonitorSession[]): MonitorSnapshot {
  return { seq: 1, sessions, requests: [], youUnread: 0, ownerPresence: 'here', agents: [] };
}

function link(machineId: string, name: string, o: Partial<NetworkLinkView> = {}): NetworkLinkView {
  return {
    machineId,
    editToken: 'fixture',
    name,
    trust: 'own',
    transport: 'ssh',
    state: 'up',
    since: '2026-11-16T00:00:00Z',
    revokedBy: null,
    addresses: [],
    capabilities: { messaging: true, monitor: true, drive: false },
    peerCapabilities: null,
    unsupported: [],
    fingerprint: 'fp',
    lastActivity: null,
    snapshot: snapshot([monitorSession('s1')]),
    ...o,
  };
}

function machine(machineId: string, name: string, o: Partial<MachineView> = {}): MachineView {
  return {
    machine: name,
    machine_id: machineId,
    target: `${name}.example`,
    state: 'up',
    mode: 'full',
    os: 'linux',
    arch: 'x64',
    conduit_version: '1',
    agents: [],
    sessions: 1,
    last_seen: null,
    survives_logout: null,
    ...o,
  };
}

function state(links: NetworkLinkView[], machines: MachineView[] = []): NetworkState {
  return {
    machineId: LOCAL,
    selfName: 'this',
    listening: [],
    links,
    pairing: null,
    machines,
  };
}

const lead = { id: 'lead-1', mcpHandle: 'claude-3' };

describe('remoteSessionRows', () => {
  it('nests under the local lead by mcpHandle when the opener machine is this one', () => {
    const s = monitorSession('r1', {
      openedBy: { handle: 'claude-3', machineId: LOCAL },
    });
    const rows = remoteSessionRows(
      state([link(B, 'bee', { snapshot: snapshot([s]) })], [machine(B, 'bee')]),
      [lead, { id: 'other', mcpHandle: 'claude-9' }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].parentSessionId).toBe('lead-1');
    expect(rows[0].machineName).toBe('bee');
    expect(rows[0].id).toBe(`remote:${B}:r1`);
    expect(rows[0].key).toEqual({ machineId: B, sessionId: 'r1' });
  });

  it('a remote opener from another machine has no parent', () => {
    const s = monitorSession('r2', {
      openedBy: { handle: 'claude-3', machineId: C },
    });
    const rows = remoteSessionRows(
      state([link(B, 'bee', { snapshot: snapshot([s]) })], [machine(B, 'bee')]),
      [lead],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].parentSessionId).toBeNull();
  });

  it('non-ssh links and null snapshots give no rows', () => {
    const rows = remoteSessionRows(
      state([link(B, 'tls-peer', { transport: 'tls' }), link(C, 'no-snap', { snapshot: null })]),
      [],
    );
    expect(rows).toEqual([]);
  });

  it('falls back to the link name and link state, keeps exited sessions, and orders by machine then label', () => {
    const rows = remoteSessionRows(
      state([
        link(C, 'zeta', {
          state: 'down',
          snapshot: snapshot([monitorSession('b-label', { label: 'b' })]),
        }),
        link(B, 'alpha', {
          snapshot: snapshot([
            monitorSession('z', { label: 'zeta-task', status: 'exited' }),
            monitorSession('a', { label: 'alpha-task' }),
          ]),
        }),
      ]),
      [],
    );
    expect(rows.map((r) => r.session.label)).toEqual(['alpha-task', 'zeta-task', 'b']);
    expect(rows[1].session.status).toBe('exited');
    expect(rows[2].machineName).toBe('zeta');
    expect(rows[2].machineState).toBe('down');
  });
});

import { describe, expect, it } from 'vitest';
import type {
  Capabilities,
  LinkState,
  MonitorSession,
  MonitorSnapshot,
} from '../../src/contracts/link-protocol';
import { createRemoteDirectory, type RemoteLinkInfo } from '../../src/network/remote-directory';

const ALL_ON: Capabilities = { messaging: true, monitor: true, drive: false };
const MESSAGING_OFF: Capabilities = { messaging: false, monitor: true, drive: false };
const LAPTOP = 'm-0000aaaa';
const DESKTOP = 'm-0000bbbb';

function session(handle: string | null, overrides: Partial<MonitorSession> = {}): MonitorSession {
  return {
    sessionId: `sid-${handle ?? 'none'}`,
    handle,
    label: `${handle} label`,
    agent: 'claude',
    presence: 'idle',
    messaging: 'connected',
    messageable: true,
    notices: 'typed',
    home: '/home/x',
    roots: ['/home/x/repo'],
    attention: { attentionReason: null, completions: 3 },
    completions: 3,
    limit: null,
    status: 'running',
    ...overrides,
  } as MonitorSession;
}

function snapshot(seq: number, sessions: MonitorSession[]): MonitorSnapshot {
  return { seq, sessions, requests: [], youUnread: 0, ownerPresence: 'here', agents: [] };
}

function link(
  machineId: string,
  name: string,
  state: LinkState,
  peer: Capabilities | null = ALL_ON,
): RemoteLinkInfo {
  return { machineId, name, state, peerCapabilities: peer };
}

describe('remote directory entries', () => {
  it('lists each linked peer session with its canonical address and display name', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'up'), link(DESKTOP, 'Desktop', 'up')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('claude-1')]));
    dir.apply(DESKTOP, snapshot(1, [session('claude-2', { presence: 'busy' })]));

    const entries = dir.entries();
    expect(entries.map((e) => e.address)).toEqual([`claude-1@${LAPTOP}`, `claude-2@${DESKTOP}`]);
    expect(entries.map((e) => e.display)).toEqual(['claude-1@Laptop', 'claude-2@Desktop']);
    expect(entries[0]).toMatchObject({
      handle: 'claude-1',
      sessionId: 'sid-claude-1',
      openedBy: null,
      label: 'claude-1 label',
      agent: 'claude',
      project: null,
      home: '/home/x',
      roots: ['/home/x/repo'],
      presence: 'idle',
      messaging: 'connected',
      connectable: true,
      notices: 'typed',
      machineId: LAPTOP,
      machine: 'Laptop',
      trust: 'own',
      link: 'up',
    });
    expect(entries[1]?.presence).toBe('busy');
  });

  it('skips sessions without a handle', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'up')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session(null), session('claude-1')]));
    expect(dir.entries().map((e) => e.handle)).toEqual(['claude-1']);
  });

  it('shows a clashing name as name (machineId) for both peers', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Office', 'up'), link(DESKTOP, ' office ', 'up')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('a')]));
    dir.apply(DESKTOP, snapshot(1, [session('b')]));
    expect(dir.entries().map((e) => e.display)).toEqual([
      `a@Office (${LAPTOP})`,
      `b@office (${DESKTOP})`,
    ]);
  });

  it('shows a peer named like self with its machine id', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Mine', 'up')], 'mine');
    dir.apply(LAPTOP, snapshot(1, [session('a')]));
    expect(dir.entries()[0]?.machine).toBe(`Mine (${LAPTOP})`);
  });

  it('keeps rows of a down link with link down, and degraded as degraded', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'down'), link(DESKTOP, 'Desktop', 'degraded')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('a')]));
    dir.apply(DESKTOP, snapshot(1, [session('b')]));
    expect(dir.entries().map((e) => [e.handle, e.link])).toEqual([
      ['a', 'down'],
      ['b', 'degraded'],
    ]);
  });

  it('treats a connecting link as down', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'connecting')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('a')]));
    expect(dir.entries()[0]?.link).toBe('down');
  });

  it('gives no rows for a terminal link', () => {
    const terminal: LinkState[] = ['revoked', 'incompatible', 'identity-changed'];
    for (const state of terminal) {
      const dir = createRemoteDirectory();
      dir.setLinks([link(LAPTOP, 'Laptop', state)], 'Mine');
      dir.apply(LAPTOP, snapshot(1, [session('a')]));
      expect(dir.entries()).toEqual([]);
    }
  });

  it('gives no rows when the peer has messaging off toward me', () => {
    const dir = createRemoteDirectory();
    dir.setLinks(
      [link(LAPTOP, 'Laptop', 'up', MESSAGING_OFF), link(DESKTOP, 'Desktop', 'up', null)],
      'Mine',
    );
    dir.apply(LAPTOP, snapshot(1, [session('a')]));
    dir.apply(DESKTOP, snapshot(1, [session('b')]));
    expect(dir.entries()).toEqual([]);
  });

  it('ignores a snapshot whose seq is not newer than the last applied one', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'up')], 'Mine');
    dir.apply(LAPTOP, snapshot(5, [session('new')]));
    dir.apply(LAPTOP, snapshot(4, [session('old')]));
    dir.apply(LAPTOP, snapshot(5, [session('same')]));
    expect(dir.entries().map((e) => e.handle)).toEqual(['new']);
    expect(dir.snapshotOf(LAPTOP)?.seq).toBe(5);
  });

  it('replaces a machine sessions with each newer snapshot', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'up')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('a'), session('b')]));
    dir.apply(LAPTOP, snapshot(2, [session('b')]));
    expect(dir.entries().map((e) => e.handle)).toEqual(['b']);
  });

  it('drops a machine rows and snapshot when setLinks no longer lists it', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'up'), link(DESKTOP, 'Desktop', 'up')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('a')]));
    dir.apply(DESKTOP, snapshot(1, [session('b')]));
    dir.setLinks([link(DESKTOP, 'Desktop', 'up')], 'Mine');
    expect(dir.entries().map((e) => e.handle)).toEqual(['b']);
    expect(dir.snapshotOf(LAPTOP)).toBeNull();
  });
});

describe('remote directory resolution', () => {
  function twoMachines() {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'up'), link(DESKTOP, 'Desktop', 'up')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('claude-1')]));
    dir.apply(DESKTOP, snapshot(1, [session('claude-2')]));
    return dir;
  }

  it('resolves a canonical address by machine id', () => {
    const r = twoMachines().resolve(`claude-1@${LAPTOP}`);
    expect(r.kind).toBe('remote');
    if (r.kind === 'remote') expect(r.entry.machineId).toBe(LAPTOP);
  });

  it('resolves a machine name case-insensitively', () => {
    const r = twoMachines().resolve('claude-2@dESKTOP');
    expect(r.kind).toBe('remote');
    if (r.kind === 'remote') expect(r.entry.address).toBe(`claude-2@${DESKTOP}`);
  });

  it('resolves a bare handle as local', () => {
    expect(twoMachines().resolve('claude-1')).toEqual({ kind: 'local', handle: 'claude-1' });
  });

  it('is unknown for text that is not an address', () => {
    expect(twoMachines().resolve('a b')).toEqual({
      kind: 'unknown',
      hint: 'not a session address',
    });
  });

  it('is unknown with a link hint for an unlinked machine id or name', () => {
    const dir = twoMachines();
    expect(dir.resolve('x@m-ffffffff')).toEqual({
      kind: 'unknown',
      hint: 'no link to m-ffffffff; link it in Settings → Machines',
    });
    expect(dir.resolve('x@Tablet')).toEqual({
      kind: 'unknown',
      hint: 'no link to Tablet; link it in Settings → Machines',
    });
  });

  it('is unknown for a handle the linked peer does not have', () => {
    expect(twoMachines().resolve(`ghost@${LAPTOP}`)).toEqual({
      kind: 'unknown',
      hint: 'no session ghost on Laptop',
    });
  });

  it('is unknown with a state hint for a terminal link', () => {
    const dir = createRemoteDirectory();
    dir.setLinks(
      [
        link(LAPTOP, 'Laptop', 'revoked'),
        link(DESKTOP, 'Desktop', 'incompatible'),
        link('m-0000cccc', 'Tab', 'identity-changed'),
      ],
      'Mine',
    );
    expect(dir.resolve(`a@${LAPTOP}`)).toEqual({ kind: 'unknown', hint: 'Laptop is revoked' });
    expect(dir.resolve('a@Desktop')).toEqual({ kind: 'unknown', hint: 'Desktop is incompatible' });
    expect(dir.resolve('a@Tab')).toEqual({ kind: 'unknown', hint: 'Tab changed identity' });
  });

  it('is unknown when two linked machines share the name a target uses', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Office', 'up'), link(DESKTOP, 'Office', 'up')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('a')]));
    expect(dir.resolve('a@Office')).toEqual({
      kind: 'unknown',
      hint: 'two machines are named Office; use its machine id',
    });
    const byId = dir.resolve(`a@${LAPTOP}`);
    expect(byId.kind).toBe('remote');
  });
});

describe('remote directory waitReading', () => {
  it('reads a live remote session from its snapshot', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'up')], 'Mine');
    dir.apply(
      LAPTOP,
      snapshot(1, [
        session('claude-1', {
          presence: 'busy',
          completions: 7,
          attention: { attentionReason: 'blocked', completions: 7 },
        }),
      ]),
    );
    expect(dir.waitReading(`claude-1@${LAPTOP}`, 'me')).toEqual({
      sessionId: 'sid-claude-1',
      handle: `claude-1@${LAPTOP}`,
      presence: 'busy',
      needsYou: true,
      completions: 7,
      // Computed by the caller from its own message store, not from the snapshot.
      unreadFrom: 0,
    });
  });

  it('reports needsYou false when no attention reason is set', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'up')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('claude-1')]));
    expect(dir.waitReading(`claude-1@${LAPTOP}`, 'me')).toMatchObject({ needsYou: false });
  });

  it('is unreachable on a down link and keeps the rows listed', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'down')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('claude-1')]));
    expect(dir.entries()[0]?.link).toBe('down');
    expect(dir.waitReading(`claude-1@${LAPTOP}`, 'me')).toBe('unreachable');
  });

  it('is null for a local handle or an unknown target', () => {
    const dir = createRemoteDirectory();
    dir.setLinks([link(LAPTOP, 'Laptop', 'up')], 'Mine');
    dir.apply(LAPTOP, snapshot(1, [session('claude-1')]));
    expect(dir.waitReading('claude-1', 'me')).toBeNull();
    expect(dir.waitReading(`ghost@${LAPTOP}`, 'me')).toBeNull();
  });
});

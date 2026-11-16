import { describe, expect, it } from 'vitest';
import {
  isRemote,
  mergeDirectory,
  nameOnMachine,
  type RemoteEntry,
  remoteTargetRefusal,
  routedAskSummary,
  routedIntentOf,
} from '../../src/conduit-mcp/remote-routing';
import type { DirectoryEntry } from '../../src/conduit-mcp/tools';

function local(handle: string): DirectoryEntry {
  return {
    handle,
    sessionId: `sid-${handle}`,
    openedBy: null,
    label: handle,
    agent: 'claude',
    project: null,
    home: '/home/x',
    roots: [],
    presence: 'idle',
    messaging: 'connected',
    connectable: true,
    notices: 'typed',
  };
}

function remote(handle: string): RemoteEntry {
  return {
    ...local(handle),
    address: `${handle}@m-0000aaaa`,
    display: `${handle}@Laptop`,
    machineId: 'm-0000aaaa',
    machine: 'Laptop',
    trust: 'own',
    link: 'up',
    opener: null,
  };
}

describe('mergeDirectory', () => {
  it('lists local entries first, in order, then remote entries in order', () => {
    const merged = mergeDirectory([local('a'), local('b')], [remote('x'), remote('y')]);
    expect(merged.map((e) => (isRemote(e) ? e.address : e.handle))).toEqual([
      'a',
      'b',
      'x@m-0000aaaa',
      'y@m-0000aaaa',
    ]);
  });

  it('returns the local list alone when there are no remote entries', () => {
    expect(mergeDirectory([local('a')], [])).toEqual([local('a')]);
  });
});

describe('isRemote', () => {
  it('is true only for entries that carry an address', () => {
    expect(isRemote(remote('x'))).toBe(true);
    expect(isRemote(local('a'))).toBe(false);
  });
});

describe('remoteTargetRefusal', () => {
  it('refuses a target that names another machine as peer_unsupported', () => {
    for (const target of ['claude-1@m-0123abcd', 'claude-1@win-box']) {
      expect(remoteTargetRefusal(target)).toEqual({
        code: 'peer_unsupported',
        message: `${target} is on another machine; opening, typing into or reading sessions on other machines isn't available yet`,
        retryable: false,
        hint: 'message it with send_message instead',
      });
    }
  });

  it('passes a local handle through', () => {
    expect(remoteTargetRefusal('claude-1')).toBeNull();
  });
});

describe('routed session tools: where a call goes (CON-40 S3)', () => {
  it('a local call stays local', () => {
    expect(routedIntentOf('open_session', { path: '/w', agent: 'claude' })).toEqual({
      ok: true,
      value: null,
    });
    expect(routedIntentOf('read_screen', { session: 'claude-1' })).toEqual({
      ok: true,
      value: null,
    });
    expect(routedIntentOf('focus_session', { session: 'claude-1@m-0000aaaa' })).toEqual({
      ok: true,
      value: null,
    });
  });

  it('a machine routes with the machine taken out of the args', () => {
    expect(
      routedIntentOf('open_terminal', { machine: 'win-box', path: 'C:\\w', command: 'pwsh' }),
    ).toEqual({
      ok: true,
      value: {
        tool: 'open_terminal',
        kind: 'machine',
        machine: 'win-box',
        args: { path: 'C:\\w', command: 'pwsh' },
      },
    });
  });

  it('an empty or over-long machine is invalid_args', () => {
    for (const machine of ['', 'x'.repeat(129)]) {
      expect(routedIntentOf('list_agents', { machine })).toMatchObject({
        ok: false,
        error: { code: 'invalid_args' },
      });
    }
    expect(routedIntentOf('list_agents', { machine: 7 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_args' },
    });
  });

  it('an address routes with the handle in place of the address', () => {
    expect(routedIntentOf('send_input', { session: 'claude-1@m-0000aaaa', text: 'hi' })).toEqual({
      ok: true,
      value: {
        tool: 'send_input',
        kind: 'address',
        handle: 'claude-1',
        machine: 'm-0000aaaa',
        address: 'claude-1@m-0000aaaa',
        args: { session: 'claude-1', text: 'hi' },
      },
    });
  });

  it('a malformed address is invalid_args, and a close list with an address is refused', () => {
    for (const session of ['a@b@c', 'claude-1@', '@m-0000aaaa']) {
      expect(routedIntentOf('read_screen', { session })).toMatchObject({
        ok: false,
        error: { code: 'invalid_args' },
      });
    }
    expect(
      routedIntentOf('close_session', { session: 'claude-1@m-0000aaaa', children: true }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
  });

  it('a result names its session on the machine it came from, and list_agents is left alone', () => {
    // Plain bindings, not literals: a result is an open object, checked by its keys, not by the type.
    const screen = { session: 'claude-1', rows: ['x'] };
    const opened = { session_id: 'b-1', handle: null };
    expect(nameOnMachine('read_screen', screen, 'win-box')).toEqual({
      session: 'claude-1@win-box',
      rows: ['x'],
    });
    expect(nameOnMachine('open_session', opened, 'win-box')).toEqual({
      session_id: 'b-1',
      handle: null,
    });
    const rows = { agents: [{ id: 'echo' }] };
    expect(nameOnMachine('list_agents', rows, 'win-box')).toBe(rows);
  });

  it('an open_session ask shows the machine its path is on', () => {
    const intent = routedIntentOf('open_session', {
      machine: 'win-box',
      path: 'C:\\w',
      agent: 'claude',
    });
    if (!intent.ok || intent.value === null) throw new Error('expected a routed intent');
    expect(
      routedAskSummary(
        intent.value,
        { machineId: 'm-0000aaaa', machine: 'win-box', label: '', home: '' },
        null,
      ),
    ).toEqual({
      tool: 'open_session',
      path: 'C:\\w',
      agent: 'claude',
      focus: true,
      machine: 'win-box',
    });
  });
});

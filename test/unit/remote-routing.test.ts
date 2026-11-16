import { describe, expect, it } from 'vitest';
import {
  isRemote,
  mergeDirectory,
  type RemoteEntry,
  remoteTargetRefusal,
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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadIdentity } from '../../server/network/identity';
import { createNetwork, type NetworkService } from '../../server/network/index';
import type { NetworkState } from '../../src/contracts/network-state';

const quiet = { debug: () => undefined, warn: () => undefined, error: () => undefined };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function server(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'conduit-net-'));
  const dir = join(root, 'network');
  const loaded = loadIdentity(dir);
  if (loaded.kind === 'newer') throw new Error('unexpected');
  const states: NetworkState[] = [];
  const net = createNetwork({
    dir,
    identity: loaded.identity,
    settings: () => ({ networkBindHost: '127.0.0.1', networkPort: 0, networkSelfName: name }),
    emit: (s) => states.push(s),
    log: quiet,
    observe: async () => null,
    emitTo: () => {},
    drive: {
      applyHumanInput: () => false,
      resize: () => {},
      liveSession: () => false,
      agentExists: () => false,
      isDirectory: async () => false,
      openSession: async () => {
        throw new Error('drive is not exercised by this test');
      },
      closeSession: async () => {},
    },
    monitor: {
      sessions: () => [],
      requests: () => [],
      youUnread: () => 0,
      ownerPresence: () => 'here',
      agents: () => [],
    },
  });
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(() => net.stop());
  return { net, dir, states };
}

async function call<T>(net: NetworkService, method: string, params: unknown = {}): Promise<T> {
  const answer = net.handle(method, params);
  if (answer === null) throw new Error(`not a network method: ${method}`);
  return (await answer) as T;
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const auditKinds = (dir: string) =>
  readFileSync(join(dir, 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).kind);

describe('network service over C2 calls', { timeout: 60_000 }, () => {
  it('pairs two servers, links them own and up, then a revoke reaches the peer', async () => {
    const a = server('net-a');
    const b = server('net-b');
    await a.net.start();
    await b.net.start();
    const started = await call<{ pairingId: string; code: string[]; addresses: string[] }>(
      a.net,
      'pairing.start',
    );
    const joined = await call<{ pairingId: string }>(b.net, 'pairing.join', {
      code: started.code.join(' '),
      address: started.addresses[0],
    });
    await until(
      () =>
        a.net.state().pairing?.state === 'confirm' && b.net.state().pairing?.state === 'confirm',
    );
    expect(a.net.state().pairing?.fingerprint).toBe(b.net.state().pairing?.fingerprint);
    await call(a.net, 'pairing.confirm', { pairingId: started.pairingId });
    await call(b.net, 'pairing.confirm', { pairingId: joined.pairingId });
    const linkTo = (s: NetworkService, id: string) =>
      s.state().links.find((l) => l.machineId === id);
    const aId = a.net.state().machineId;
    const bId = b.net.state().machineId;
    await until(() => linkTo(a.net, bId)?.state === 'up' && linkTo(b.net, aId)?.state === 'up');
    expect(linkTo(a.net, bId)?.name).toBe('net-b');
    expect(linkTo(b.net, aId)?.capabilities).toEqual({
      messaging: true,
      monitor: true,
      drive: false,
    });
    expect(b.net.state().listening.length).toBeGreaterThan(0);
    await call(b.net, 'link.setCapability', { machineId: aId, capability: 'monitor', on: false });
    await until(() => a.net.port().peerCapabilitiesOf(bId)?.monitor === false);
    expect(linkTo(a.net, bId)?.capabilities.monitor).toBe(true);
    await call(b.net, 'link.setCapability', { machineId: aId, capability: 'monitor', on: true });
    await until(() => a.net.port().peerCapabilitiesOf(bId)?.monitor === true);

    await call(b.net, 'link.revoke', { machineId: aId });
    await until(() => linkTo(a.net, bId)?.state === 'revoked');
    expect(linkTo(a.net, bId)?.revokedBy).toBe('peer');
    expect(auditKinds(b.dir)).toEqual(expect.arrayContaining(['pairing.linked', 'link.revoked']));
    expect(a.states.length).toBeGreaterThan(0);
  });

  it('rejects bad parameters at the boundary', async () => {
    const a = server('net-a');
    await expect(call(a.net, 'pairing.join', { code: 'x', address: 'nope' })).rejects.toThrow(
      'Expected host:port',
    );
    await expect(
      call(a.net, 'pairing.join', { code: 'not three words', address: '127.0.0.1:1' }),
    ).rejects.toThrow('three pairing words');
    await expect(call(a.net, 'link.revoke', { machineId: 'm-00000000' })).rejects.toThrow(
      'No link',
    );
    await expect(
      call(a.net, 'link.setCapability', {
        machineId: 'm-00000000',
        capability: 'orchestrate',
        on: true,
      }),
    ).rejects.toThrow('Expected capability');
    expect(a.net.handle('sessions.list', {})).toBeNull();
  });

  it('owner key: the first-ever link generates one and both servers persist it', async () => {
    const a = server('net-a');
    const b = server('net-b');
    await a.net.start();
    await b.net.start();
    const started = await call<{ pairingId: string; code: string[]; addresses: string[] }>(
      a.net,
      'pairing.start',
    );
    const joined = await call<{ pairingId: string }>(b.net, 'pairing.join', {
      code: started.code.join(' '),
      address: started.addresses[0],
    });
    await until(() => b.net.state().pairing?.state === 'confirm');
    await call(a.net, 'pairing.confirm', { pairingId: started.pairingId });
    await call(b.net, 'pairing.confirm', { pairingId: joined.pairingId });
    await until(
      () => a.net.state().pairing?.state === 'done' && b.net.state().pairing?.state === 'done',
    );
    const ownerOf = (dir: string) => {
      const r = loadIdentity(dir);
      if (r.kind === 'newer') throw new Error('unexpected');
      return r.identity.ownerKey?.publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64');
    };
    expect(ownerOf(a.dir)).toBeDefined();
    // The joiner gets the private key over the first verified link, not during pairing.
    await until(() => ownerOf(b.dir) !== undefined);
    expect(ownerOf(b.dir)).toBe(ownerOf(a.dir));
  });
});

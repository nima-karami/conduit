import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeServerSecret } from '../../server/lifecycle/server-secret';
import type { AuditEvent } from '../../server/network/audit-log';
import { loadIdentity } from '../../server/network/identity';
import { createNetwork, type NetworkService } from '../../server/network/index';
import type { McpNetworkPort, RemoteEntry } from '../../src/conduit-mcp/remote-routing';
import type { MessageRecord } from '../../src/conduit-mcp/types';
import { LINK_PROTOCOL } from '../../src/contracts/link-protocol';
import type { NetworkState } from '../../src/contracts/network-state';
import { personSshArgv } from '../../src/network/ssh-argv';
import {
  LINK_ENDPOINT_FILE,
  readServerVersion,
  SERVER_VERSION_FILE,
} from '../../src/server-secret';
import type { SessionCommand } from '../../src/types';

const quiet = { debug: () => undefined, warn: () => undefined, error: () => undefined };
const TEST_APP_VERSION = '9.8.7';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function server(name: string, endpointIn?: (root: string) => string) {
  const root = mkdtempSync(join(tmpdir(), 'conduit-net-'));
  const dir = join(root, 'network');
  const loaded = loadIdentity(dir);
  if (loaded.kind === 'newer') throw new Error('unexpected');
  const secret = writeServerSecret(root);
  const states: NetworkState[] = [];
  const opened: Array<{ command: SessionCommand; folder: string }> = [];
  const net = createNetwork({
    dir,
    userData: root,
    instance: 'service-test',
    linkEndpoint: endpointIn ? endpointIn(root) : join(root, 'conduit-link.sock'),
    appVersion: TEST_APP_VERSION,
    secret: () => secret,
    identity: loaded.identity,
    settings: () => ({ networkBindHost: '127.0.0.1', networkPort: 0, networkSelfName: name }),
    emit: (s) => states.push(s),
    log: quiet,
    observe: async () => null,
    emitTo: () => {},
    openCommandSession: async (command, folder) => {
      opened.push({ command, folder });
      return 'sess-needs-person';
    },
    bootstrap: {
      local: { version: TEST_APP_VERSION, linkMajor: 1, platform: 'linux', arch: 'x64' },
      runtime: { nodeExe: null, serverDir: root, hcExe: root, shimFile: root },
      noDownload: false,
    },
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
  return { net, dir, states, opened };
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
    const tapped: AuditEvent[] = [];
    b.net.setAuditTap({ record: (e) => tapped.push(e) });
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
    // The snapshot b pushed on up is the baseline; a capability change must push a fresh one.
    await until(() => linkTo(a.net, bId)?.snapshot != null);
    const seqBefore = linkTo(a.net, bId)?.snapshot?.seq ?? 0;
    await call(b.net, 'link.setCapability', { machineId: aId, capability: 'monitor', on: false });
    await until(() => a.net.port().peerCapabilitiesOf(bId)?.monitor === false);
    await until(() => (linkTo(a.net, bId)?.snapshot?.seq ?? 0) > seqBefore);
    expect(linkTo(a.net, bId)?.capabilities.monitor).toBe(true);
    await call(b.net, 'link.setCapability', { machineId: aId, capability: 'monitor', on: true });
    await until(() => a.net.port().peerCapabilitiesOf(bId)?.monitor === true);

    await call(b.net, 'link.revoke', { machineId: aId });
    await until(() => linkTo(a.net, bId)?.state === 'revoked');
    expect(linkTo(a.net, bId)?.revokedBy).toBe('peer');
    expect(auditKinds(b.dir)).toEqual(expect.arrayContaining(['pairing.linked', 'link.revoked']));
    expect(tapped.map((e) => e.kind)).toEqual(auditKinds(b.dir));
    expect(a.states.length).toBeGreaterThan(0);
  });

  it('refuses a link.sshBootstrap target that ssh would read as an option or a shell', async () => {
    // Checked at C2 with the same allowlist sshArgv uses, before any bootstrap or ssh runs.
    const a = server('net-a');
    for (const target of ['-oProxyCommand=x', 'a;rm -rf x', 'a b']) {
      await expect(call(a.net, 'link.sshBootstrap', { target })).rejects.toThrow(
        'Expected an ssh target',
      );
    }
    await expect(call(a.net, 'link.sshBootstrap', { target: '' })).rejects.toThrow(
      'Expected target',
    );
  });

  it('machines.openNeedsPerson refuses a non-target, then opens the pane on the dialer control dir', async () => {
    const a = server('net-a');
    await expect(
      call(a.net, 'machines.openNeedsPerson', { target: '-oProxyCommand=x' }),
    ).rejects.toThrow('Expected an ssh target');
    expect(a.opened).toEqual([]);

    const answer = await call<{ sessionId: string }>(a.net, 'machines.openNeedsPerson', {
      target: 'fake',
    });
    expect(answer).toEqual({ sessionId: 'sess-needs-person' });
    expect(a.opened).toHaveLength(1);
    const [{ command, folder }] = a.opened;
    // The dialer's controlDir is <userData>/ssh; the pane must share it or its master is not reused.
    const controlPath = join(dirname(a.dir), 'ssh', '%C');
    const argv = personSshArgv({ target: 'fake', controlPath });
    if (!Array.isArray(argv)) throw new Error('expected an argv');
    expect(command).toEqual({ command: process.env.CONDUIT_SSH_PATH || 'ssh', args: argv });
    expect(folder).toBe(homedir());
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
    // Every ssh field must be a non-empty string: a missing one never reaches the dialer.
    await expect(
      call(a.net, 'link.sshAdd', { ssh: { target: 'fake', node: '', mainJs: 'm', userData: 'u' } }),
    ).rejects.toThrow('Expected node');
    await expect(call(a.net, 'link.sshAdd', { ssh: { target: 'fake' } })).rejects.toThrow(
      'Expected node',
    );
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

  // The composer's dialer is the real one: CONDUIT_SSH_PATH is read at construction, so the wrapper
  // is set before the server is built. The remote "bridge" is a script that refuses, which proves
  // the whole chain (env, spawn, fake-ssh, remote command, classification) without a real sshd.
  it.skipIf(process.platform === 'win32')('createNetwork wires a working sshDial', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ssh-wire-'));
    cleanup.push(() => rmSync(work, { recursive: true, force: true }));
    const fakeSsh = join(process.cwd(), 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
    const wrapper = join(work, 'ssh');
    writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${fakeSsh}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const remoteMain = join(work, 'bridge.cjs');
    writeFileSync(
      remoteMain,
      "process.stderr.write('conduit-bridge: no_server\\n'); process.exit(3);\n",
    );
    vi.stubEnv('CONDUIT_SSH_PATH', wrapper);
    cleanup.push(() => {
      vi.unstubAllEnvs();
    });

    const a = server('net-a');
    await a.net.start();
    const userData = join(a.dir, '..');
    const result = await a.net.addSshPeer({
      target: 'fake-target',
      node: process.execPath,
      mainJs: remoteMain,
      userData,
    });
    expect(result).toEqual({ ok: false, error: { code: 'bridge_no_server' } });
    // The control dir is the one controlDir() chose under userData, created by the dial.
    expect(existsSync(join(userData, 'ssh'))).toBe(true);
  });

  it('a stale record from a crashed run is dropped before the endpoint listens', async () => {
    // The endpoint sits in a missing directory, so its listen fails and the record must not survive.
    const a = server('net-a', (root) => join(root, 'missing-dir', 'conduit-link.sock'));
    const userData = join(a.dir, '..');
    writeFileSync(join(userData, LINK_ENDPOINT_FILE), join(userData, 'squatter.sock'));
    await a.net.start();
    expect(existsSync(join(userData, LINK_ENDPOINT_FILE))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'records the server version and link major on start, 0600, and removes it on stop',
    async () => {
      const a = server('net-a');
      const userData = join(a.dir, '..');
      await a.net.start();
      const file = join(userData, SERVER_VERSION_FILE);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readServerVersion(userData)).toEqual({
        version: TEST_APP_VERSION,
        linkMajor: LINK_PROTOCOL.major,
      });
      await a.net.stop();
      expect(existsSync(file)).toBe(false);
    },
  );

  it('records the link endpoint on start and removes the record on stop', async () => {
    const a = server('net-a');
    const userData = join(a.dir, '..');
    await a.net.start();
    // The bridge reads this record; a name it derived itself could differ under sshd's environment.
    expect(readFileSync(join(userData, LINK_ENDPOINT_FILE), 'utf8')).toBe(
      join(userData, 'conduit-link.sock'),
    );
    await a.net.stop();
    expect(existsSync(join(userData, LINK_ENDPOINT_FILE))).toBe(false);
  });

  // The bridge is a stand-in here: the real --link-stdio path is the e2e's, and this test can't run TS.
  // It writes the same preamble and pipes the same bytes, so the composed ssh path is what's proven.
  it.skipIf(process.platform === 'win32')(
    'link.sshAdd links two services over fake-ssh and delivers a message',
    async () => {
      const work = mkdtempSync(join(tmpdir(), 'ssh-add-'));
      cleanup.push(() => rmSync(work, { recursive: true, force: true }));
      const fakeSsh = join(process.cwd(), 'test', 'e2e', 'fixtures', 'fake-ssh.cjs');
      const wrapper = join(work, 'ssh');
      writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${fakeSsh}' "$@"\n`);
      chmodSync(wrapper, 0o755);
      const bridge = join(work, 'bridge.cjs');
      writeFileSync(
        bridge,
        [
          "const fs = require('node:fs'); const net = require('node:net'); const path = require('node:path');",
          "const userData = process.argv[process.argv.indexOf('--user-data') + 1];",
          "const secret = fs.readFileSync(path.join(userData, 'server-secret'), 'utf8').trim();",
          "const body = Buffer.from(JSON.stringify({ t: 'bridge', v: 1, secret }));",
          'const pre = Buffer.alloc(4 + body.length); pre.writeUInt32BE(body.length, 0); body.copy(pre, 4);',
          "const sock = net.createConnection(path.join(userData, 'conduit-link.sock'), () => {",
          '  sock.write(pre); process.stdin.pipe(sock); sock.pipe(process.stdout);',
          '});',
          "sock.on('close', () => process.exit(0));",
          '',
        ].join('\n'),
      );
      vi.stubEnv('CONDUIT_SSH_PATH', wrapper);
      cleanup.push(() => {
        vi.unstubAllEnvs();
      });

      const a = server('net-a');
      const b = server('net-b');
      const delivered: string[] = [];
      const mcp = (sink: string[]): McpNetworkPort => ({
        localDirectory: () => [],
        hasMessage: () => false,
        readBlob: async () => undefined,
        threadExportedTo: () => false,
        wireThreadFor: (threadId: string) => threadId,
        deliverInbound: async (msg) => {
          sink.push(msg.body);
          return msg.to.map((handle) => ({ handle, status: 'delivered' as const, reason: null }));
        },
        setRemoteStatus: async () => {},
        onLocalStatus: () => () => {},
        youUnread: () => 0,
        ownerPresence: () => 'here',
        requestsSummary: () => [],
        callAsRemote: () => Promise.reject(new Error('not used by this test')),
      });
      a.net.setMcp(mcp([]));
      b.net.setMcp(mcp(delivered));
      await a.net.start();
      await b.net.start();

      const added = await call<{ ok: boolean; machineId?: string }>(a.net, 'link.sshAdd', {
        ssh: {
          target: 'fake-target',
          node: process.execPath,
          mainJs: bridge,
          userData: join(b.dir, '..'),
        },
      });
      expect(added).toEqual({ ok: true, machineId: b.net.state().machineId });

      const bId = b.net.state().machineId;
      await until(() => a.net.state().links.some((l) => l.machineId === bId && l.state === 'up'));
      const linkA = (await call<NetworkState>(a.net, 'link.list')).links.find(
        (l) => l.machineId === bId,
      );
      expect(linkA?.transport).toBe('ssh');

      const message: MessageRecord = {
        messageId: 'm_abcdefghijklmnop',
        threadId: 't_abcdefghijklmnop',
        from: 'agent-1',
        to: ['agent-2'],
        subject: 'hi',
        kind: 'inform',
        priority: 'normal',
        sentAt: '2026-01-01T00:00:00Z',
        body: 'over ssh',
        attachments: [],
      };
      const recipient = { handle: 'agent-2', address: `agent-2@${bId}`, machineId: bId };
      a.net.port().enqueue(message, [recipient as RemoteEntry]);
      await until(() => delivered.includes('over ssh'));
      expect(delivered).toEqual(['over ssh']);
    },
  );
});

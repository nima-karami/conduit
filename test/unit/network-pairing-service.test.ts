import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../server/network/audit-log';
import {
  type Identity,
  type IdentityIo,
  loadIdentity,
  setOwnerKey,
} from '../../server/network/identity';
import { type Listener, listenPairing } from '../../server/network/listener';
import {
  createPairingService,
  type PairingDeps,
  type PairingService,
} from '../../server/network/pairing-service';
import { PAIRING_WINDOW_MS } from '../../src/contracts/link-protocol';
import type { PairingViewState } from '../../src/contracts/network-state';
import { newCode } from '../../src/network/pairing-code';
import type { OwnerKeyPair } from '../../src/network/pairing-protocol';
import { selfSignedCert } from '../../src/network/self-signed-cert';

const quiet = { debug: () => undefined, warn: () => undefined };
const listeners: Listener[] = [];
afterEach(async () => {
  for (const l of listeners.splice(0)) await l.close();
});

function memoryIo(): IdentityIo {
  const files = new Map<string, string>();
  return {
    read: (p) => files.get(p) ?? null,
    write: (p, text) => {
      files.set(p, text);
    },
    rename: (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw new Error(`no file at ${from}`);
      files.delete(from);
      files.set(to, text);
    },
  };
}

function makeIdentity(
  name: string,
  owner: { publicKey: KeyObject; privateKey: KeyObject } | null,
): Identity {
  const dir = `/mem/${name}`;
  const io = memoryIo();
  const loaded = loadIdentity(dir, io);
  if (loaded.kind === 'newer') throw new Error('unexpected newer identity');
  return owner === null ? loaded.identity : setOwnerKey(dir, loaded.identity, owner, io);
}

function newOwnerKey(): OwnerKeyPair {
  const k = generateKeyPairSync('ed25519');
  return {
    publicKey: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: k.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** Fires only when the test says so: expiry is driven by hand, never by a real clock. */
function manualTimers() {
  const pending = new Map<symbol, () => void>();
  const scheduled: number[] = [];
  return {
    scheduled,
    after(fn: () => void, ms: number): () => void {
      const key = Symbol('timer');
      scheduled.push(ms);
      pending.set(key, fn);
      return () => {
        pending.delete(key);
      };
    },
    fireAll(): void {
      for (const [key, fn] of [...pending]) {
        pending.delete(key);
        fn();
      }
    },
  };
}

interface Side {
  svc: PairingService;
  linked: { linkId: string; machineId: string; dialed: string | null }[];
  audit: AuditEvent[];
  states: PairingViewState[];
  timers: ReturnType<typeof manualTimers>;
}

interface Ports {
  open(): Promise<string[]>;
  close(): void;
}

function side(identity: Identity, selfName: string, ports: Ports, dialTimeoutMs = 2_000): Side {
  const timers = manualTimers();
  const linked: Side['linked'] = [];
  const audit: AuditEvent[] = [];
  const states: PairingViewState[] = [];
  const cert = selfSignedCert(
    { publicKey: identity.serverPublicKey, privateKey: identity.serverPrivateKey },
    identity.machineId,
  );
  const holder: { svc: PairingService | null } = { svc: null };
  const deps: PairingDeps = {
    identity: () => identity,
    selfName: () => selfName,
    cert: () => cert,
    linkAddresses: async () => ['127.0.0.1:47391'],
    openPairingPort: ports.open,
    closePairingPort: ports.close,
    onLinked: (outcome, dialedAddress) => {
      linked.push({
        linkId: outcome.linkId,
        machineId: outcome.peer.machineId,
        dialed: dialedAddress,
      });
    },
    generateOwnerKey: newOwnerKey,
    audit: { record: (e) => audit.push(e) },
    changed: () => {
      const v = holder.svc?.view();
      if (v) states.push(v.state);
    },
    now: () => Date.now(),
    rand: (n) => randomBytes(n),
    after: timers.after,
    newId: () => randomUUID(),
    dialTimeoutMs,
  };
  const svc = createPairingService(deps);
  holder.svc = svc;
  return { svc, linked, audit, states, timers };
}

/** The opener's pairing port, opened per window and shut by the service once used. */
function openerSide(identity: Identity, selfName: string): Side {
  let port: Listener | null = null;
  const s: Side = side(identity, selfName, {
    open: async () => {
      const opened = await listenPairing({
        hosts: ['127.0.0.1'],
        port: 0,
        onPairing: (sock) => s.svc.onPairingSocket(sock),
        log: quiet,
      });
      port = opened;
      listeners.push(opened);
      return opened.addresses();
    },
    close: () => {
      const p = port;
      port = null;
      void p?.close();
    },
  });
  return s;
}

const noPorts: Ports = {
  open: () => Promise.reject(new Error('the joiner opens no pairing port')),
  close: () => undefined,
};

const LIVE: PairingViewState[] = ['showing-code', 'connecting', 'confirm', 'waiting-peer'];
const stateOf = (s: Side): PairingViewState | null => s.svc.view()?.state ?? null;
const isLive = (s: Side): boolean => {
  const st = stateOf(s);
  return st !== null && LIVE.includes(st);
};

async function until(what: string, ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() =>
        typeof a === 'object' && a !== null ? resolve(a.port) : reject(new Error('no port')),
      );
    });
  });
}

async function rig(opts: { openerOwner?: boolean; joinerOwner?: boolean } = {}) {
  const opener = openerSide(
    makeIdentity('opener', opts.openerOwner ? generateKeyPairSync('ed25519') : null),
    'alpha',
  );
  const joiner = side(
    makeIdentity('joiner', opts.joinerOwner ? generateKeyPairSync('ed25519') : null),
    'beta',
    noPorts,
  );
  return { opener, joiner };
}

async function startWindow(opener: Side) {
  const w = await opener.svc.start();
  const address = w.addresses[0];
  if (address === undefined) throw new Error('opener listens nowhere');
  return { ...w, address };
}

describe('pairing service over its pairing port', () => {
  it('happy path: both confirm the same fingerprint, then both link with one linkId', async () => {
    const { opener, joiner } = await rig();
    const w = await startWindow(opener);
    const spoken = ` ${w.code.map((c) => c.toUpperCase()).join('   -  ')} `;
    const j = await joiner.svc.join(spoken, w.address);

    await until(
      'both confirm',
      () => stateOf(opener) === 'confirm' && stateOf(joiner) === 'confirm',
    );
    const fp = opener.svc.view()?.fingerprint;
    expect(fp).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(joiner.svc.view()?.fingerprint).toBe(fp);

    opener.svc.confirm(w.pairingId);
    joiner.svc.confirm(j.pairingId);
    await until('both done', () => stateOf(opener) === 'done' && stateOf(joiner) === 'done');

    expect(opener.linked).toHaveLength(1);
    expect(joiner.linked).toHaveLength(1);
    expect(opener.linked[0]?.linkId).toBe(joiner.linked[0]?.linkId);
    expect(opener.linked[0]?.dialed).toBeNull();
    expect(joiner.linked[0]?.dialed).toBe(w.address);
    expect(opener.audit.map((e) => e.kind)).toContain('pairing.linked');
    expect(joiner.audit.map((e) => e.kind)).toContain('pairing.linked');
  });

  it('a wrong code fails both sides, and a second attempt at the window never reaches confirm', async () => {
    const { opener, joiner } = await rig();
    const w = await startWindow(opener);
    let wrong = newCode(randomBytes).join(' ');
    while (wrong === w.code.join(' ')) wrong = newCode(randomBytes).join(' ');

    await joiner.svc.join(wrong, w.address);
    await until(
      'wrong code',
      () => stateOf(opener) === 'wrong-code' && stateOf(joiner) === 'wrong-code',
    );
    expect(opener.audit.map((e) => e.kind)).toContain('pairing.failed');
    expect(joiner.audit.map((e) => e.kind)).toContain('pairing.failed');

    await joiner.svc.join(w.code.join(' '), w.address);
    await until('second attempt ends', () => !isLive(joiner));
    expect(['unreachable', 'failed']).toContain(stateOf(joiner));
    expect(stateOf(opener)).toBe('wrong-code');
    expect(opener.states).not.toContain('confirm');
    expect(opener.linked).toEqual([]);
  });

  it('a decline by the joiner after confirm links nothing and fails both sides', async () => {
    const { opener, joiner } = await rig();
    const w = await startWindow(opener);
    const j = await joiner.svc.join(w.code.join(' '), w.address);
    await until(
      'both confirm',
      () => stateOf(opener) === 'confirm' && stateOf(joiner) === 'confirm',
    );

    joiner.svc.decline(j.pairingId);
    await until(
      'both declined',
      () => stateOf(opener) === 'declined' && stateOf(joiner) === 'declined',
    );
    expect(opener.linked).toEqual([]);
    expect(joiner.linked).toEqual([]);
    expect(opener.audit.map((e) => e.kind)).toContain('pairing.failed');
    expect(joiner.audit.map((e) => e.kind)).toContain('pairing.failed');
  });

  it('expiry before anyone joins: the opener is expired and nothing is audited', async () => {
    const { opener } = await rig();
    await startWindow(opener);
    expect(opener.timers.scheduled).toEqual([PAIRING_WINDOW_MS]);
    expect(opener.svc.windowOpen()).toBe(true);

    opener.timers.fireAll();
    expect(stateOf(opener)).toBe('expired');
    expect(opener.svc.windowOpen()).toBe(false);
    expect(opener.audit).toEqual([]);
  });

  it('a join with an invalid code throws bad_code and changes no state', async () => {
    const { opener, joiner } = await rig();
    const w = await startWindow(opener);
    const before = opener.svc.view();
    const joinerBefore = joiner.svc.view();
    await expect(joiner.svc.join('not a real code', w.address)).rejects.toThrow('bad_code');
    expect(opener.svc.view()).toEqual(before);
    expect(joiner.svc.view()).toEqual(joinerBefore);
  });

  it('a join to a closed port is unreachable', async () => {
    const { joiner } = await rig();
    const port = await closedPort();
    await joiner.svc.join(newCode(randomBytes).join(' '), `127.0.0.1:${port}`);
    await until('unreachable', () => stateOf(joiner) === 'unreachable');
    expect(joiner.audit).toEqual([]);
  });

  it('different owner keys are refused before anyone confirms a fingerprint', async () => {
    const { opener, joiner } = await rig({ openerOwner: true, joinerOwner: true });
    const w = await startWindow(opener);
    await joiner.svc.join(w.code.join(' '), w.address);
    await until(
      'different owner',
      () => stateOf(opener) === 'different-owner' && stateOf(joiner) === 'different-owner',
    );
    expect(opener.states).not.toContain('confirm');
    expect(joiner.states).not.toContain('confirm');
    expect(opener.linked).toEqual([]);
    expect(joiner.linked).toEqual([]);
  });
});

import type { Duplex } from 'node:stream';
import type tls from 'node:tls';
import {
  type Capabilities,
  type Capability,
  type HelloFrame,
  helloPlatform,
  LINK_FEATURES,
  LINK_PING_MS,
  LINK_PROTOCOL,
  type LinkFrame,
  type LinkState,
  OWN_DEFAULT_CAPABILITIES,
} from '../../src/contracts/link-protocol';
import type { NetworkLinkView } from '../../src/contracts/network-state';
import type {
  AddSshPeerResult,
  SshDial,
  SshDialed,
  SshEndpoint,
  SshFailure,
} from '../../src/contracts/ssh-link';
import { printableName } from '../../src/network/addresses';
import { deriveMachineId } from '../../src/network/identity-file';
import type { LinkRecord } from '../../src/network/link-file';
import {
  backoffMs,
  initialLinkState,
  keepConnection,
  type LinkStateMachine,
  linkEvent,
} from '../../src/network/link-state';
import { MAX_NAME_CHARS } from '../../src/network/pairing-protocol';
import type { AuditSink } from './audit-log';
import type { Identity } from './identity';
import { type ConnectionError, type LinkConnection, openConnection } from './link-connection';
import type { LinkStore } from './link-store';
import { dial, type NetLog } from './listener';

// Owns every linked peer's connection and state (plan decisions 6 and 11). A TLS socket is already
// pinned to the stored server key by the listener or by dial; an ssh stream is pinned by its hello
// alone (plan decision 6), because the ssh session is the proof of access. The hello check below
// adds the owner key and machine id, so a peer whose identity changed never gets a frame through.

export type LinkView = Omit<NetworkLinkView, 'trust' | 'snapshot'>;

export interface LinkManagerDeps {
  identity(): Identity;
  selfName(): string;
  /** This server's version, sent in the hello so an ssh controller can record it. */
  appVersion: string;
  tls(): { cert: string; key: string };
  store: LinkStore;
  audit: AuditSink;
  log: NetLog;
  now(): number;
  rand(): number;
  /** Runs fn after ms; returns its cancel. */
  after(fn: () => void, ms: number): () => void;
  /** Every frame that isn't link control: messages, snapshots, views, drive. */
  onFrame(machineId: string, frame: LinkFrame): void;
  /** Fired on any change a view would show. */
  changed(): void;
  /** The owner private key arrived over this link: verify and store it; false refuses it. */
  onOwnerKey(pair: { publicKey: string; privateKey: string }): boolean;
  /** A live connection was swapped for a new one: frames on the old one may never have landed. */
  reconnected(machineId: string): void;
  /** Opens the ssh child for an ssh peer; the bridge's preamble has already proved access. */
  sshDial: SshDial;
  dialTimeoutMs?: number;
  pingMs?: number;
}

/** A waiter's answer: up, or why the last dial failed (null for a plain timeout or abort). */
export type WaitUpResult = { up: true } | { up: false; failure: SshFailure | null };

export interface LinkManager {
  start(): void;
  stop(): Promise<void>;
  /** The listener's question for a pinned key: a live link or a recent tombstone, else unknown. */
  knows(peerKeyRaw: Buffer): boolean;
  accept(sock: tls.TLSSocket, peerKeyRaw: Buffer): void;
  /** A controller came in over an ssh stream: its hello pins it, then the link runs as usual. */
  acceptStream(stream: Duplex): void;
  /** Dials an ssh target, pins the peer from its hello, and links it. */
  addSshPeer(ssh: SshEndpoint): Promise<AddSshPeerResult>;
  add(record: LinkRecord): void;
  /**
   * Clears `enabled` on a pinned ssh machine and closes its link, so nothing redials it. False for an
   * unknown peer, or one whose record has no machine block to hold the flag (plan decision 1).
   */
  disconnect(machineId: string): boolean;
  /** Sets `enabled` and redials now. False under the same conditions as disconnect. */
  enable(machineId: string): boolean;
  /**
   * Resolves once the link is up, or once a dial has failed (its reason is then in the result), or at
   * ms, on abort, or when the peer is terminal. A failure ends the wait at once: a host key prompt
   * or a refused login does not change while the wait runs.
   */
  waitUp(machineId: string, ms: number, signal: AbortSignal): Promise<WaitUpResult>;
  revoke(machineId: string): boolean;
  setCapability(machineId: string, capability: Capability, on: boolean): boolean;
  setAddresses(machineId: string, addresses: string[]): boolean;
  /** Null when the link isn't up; otherwise whether the socket still has room. */
  send(machineId: string, frame: LinkFrame): boolean | null;
  views(): LinkView[];
  view(machineId: string): LinkView | null;
  /** The protocol minor the peer's hello reported; null until its hello has landed. */
  peerMinor(machineId: string): number | null;
  onRevoked(listener: (machineId: string) => void): () => void;
}

interface Peer {
  record: LinkRecord;
  sm: LinkStateMachine;
  conn: LinkConnection | null;
  dialer: string | null;
  attempt: number;
  cancelRetry: (() => void) | null;
  dialing: boolean;
  /** An address edit landed during a dial: retry at once when it ends, not after backoff. */
  redial: boolean;
  peerHello: HelloFrame | null;
  revokedBy: 'me' | 'peer' | null;
  lastActivity: number | null;
  /** Why the latest dial ended before its hello; cleared when a dial starts, and when the link is up. */
  lastDialFailure: SshFailure | null;
}

const TERMINAL: readonly LinkState[] = ['revoked', 'incompatible', 'identity-changed'];

/** A peer still waiting for the owner key we owe it has none yet; any other mismatch is a change. */
const ownerMatches = (record: LinkRecord, helloOwner: string | null): boolean =>
  helloOwner === record.ownerKey || (record.ownerTransfer === 'send' && helloOwner === null);
const b64 = (b: Buffer): string => b.toString('base64');
// A tick this many intervals apart means the process slept: timers fire late, so redial now.
const WAKE_GAP_FACTOR = 3;
/** A record with no ssh endpoint is one the peer dials, never us: we only accept its stream. */
const dialable = (r: LinkRecord): boolean => r.transport === 'tls' || r.ssh !== null;
const sameCapabilities = (x: Capabilities, y: Capabilities): boolean =>
  x.messaging === y.messaging && x.monitor === y.monitor && x.drive === y.drive;

export function createLinkManager(deps: LinkManagerDeps): LinkManager {
  const peers = new Map<string, Peer>();
  const revokedListeners = new Set<(machineId: string) => void>();
  let stopped = true;
  let cancelTicker: (() => void) | null = null;

  const iso = (t: number) => new Date(t).toISOString();
  const event = (p: Peer, e: Parameters<typeof linkEvent>[1]): void => {
    const before = p.sm.state;
    p.sm = linkEvent(p.sm, e);
    if (p.sm.state !== before) {
      if (p.sm.state === 'down' || before === 'down' || TERMINAL.includes(p.sm.state)) {
        deps.audit.record({
          kind: 'link.state',
          peer: p.record.machineId,
          detail: { from: before, to: p.sm.state },
        });
      }
      deps.changed();
      for (const wake of [...waiters]) wake();
    }
  };

  const ownHello = (capabilities: Capabilities): HelloFrame => {
    const id = deps.identity();
    return {
      t: 'hello',
      protocol: { major: LINK_PROTOCOL.major, minor: LINK_PROTOCOL.minor },
      machineId: id.machineId,
      serverKey: b64(id.serverKeyRaw),
      ownerKey:
        id.ownerKey?.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') ?? null,
      selfName: deps.selfName(),
      features: [...LINK_FEATURES],
      capabilities: { ...capabilities },
      platform: helloPlatform(process.platform, process.arch),
      version: deps.appVersion,
    };
  };

  /**
   * An ssh peer's hello is the only place its os and version come from for a machine we did not
   * install: without this an added machine has no block, so it cannot be connected or disconnected.
   */
  const recordPlatform = (record: LinkRecord, hello: HelloFrame): void => {
    if (record.transport !== 'ssh' || record.ssh === null) return;
    if (hello.platform === undefined || hello.version === undefined) return;
    const { os, arch } = hello.platform;
    // Only linux and windows x64 are machines we can bootstrap, so only those are recorded.
    if (os === 'other' || arch !== 'x64') {
      deps.log.warn('link: ssh peer platform not recorded', {
        peer: record.machineId,
        os,
        arch,
      });
      return;
    }
    const live = deps.store.get(record.machineId)?.machine ?? null;
    // Every attach runs this, so an unchanged hello must not rewrite links.json each time.
    if (live !== null && live.os === os && live.arch === arch && live.version === hello.version)
      return;
    deps.store.setMachine(
      record.machineId,
      live === null
        ? {
            os,
            arch,
            version: hello.version,
            mode: 'full',
            agents: [],
            enabled: true,
            survivesLogout: null,
          }
        : { ...live, os, arch, version: hello.version },
    );
  };

  const peerOf = (machineId: string) => peers.get(machineId) ?? null;
  const ensurePeer = (record: LinkRecord): Peer => {
    const existing = peers.get(record.machineId);
    if (existing) {
      existing.record = record;
      return existing;
    }
    const p: Peer = {
      record,
      sm: initialLinkState(deps.now()),
      conn: null,
      dialer: null,
      attempt: 0,
      cancelRetry: null,
      dialing: false,
      redial: false,
      peerHello: null,
      revokedBy: null,
      lastActivity: null,
      lastDialFailure: null,
    };
    peers.set(record.machineId, p);
    return p;
  };

  const terminal = (p: Peer) => TERMINAL.includes(p.sm.state);
  /** Read from the store, not the peer: the machine block is written after the peer is pinned. */
  const enabledInStore = (machineId: string): boolean =>
    deps.store.get(machineId)?.machine?.enabled !== false;
  const waiters = new Set<() => void>();

  const scheduleDial = (p: Peer, immediately: boolean): void => {
    if (stopped || terminal(p) || p.conn || p.dialing || !dialable(p.record)) return;
    if (!enabledInStore(p.record.machineId)) return;
    p.cancelRetry?.();
    const delay = immediately ? 0 : backoffMs(p.attempt, deps.rand);
    p.cancelRetry = deps.after(() => {
      p.cancelRetry = null;
      void dialPeer(p);
    }, delay);
  };

  const dialPeer = async (p: Peer): Promise<void> => {
    if (stopped || terminal(p) || p.conn || p.dialing || !dialable(p.record)) return;
    if (!enabledInStore(p.record.machineId)) return;
    p.dialing = true;
    p.lastDialFailure = null;
    event(p, { kind: 'dial', at: deps.now() });
    const ssh = p.record.ssh;
    if (p.record.transport === 'ssh' && ssh !== null) {
      const dialed = deps.sshDial(ssh);
      p.dialing = false;
      await adopt(p, dialed.stream, deps.identity().machineId, dialed);
      return;
    }
    const expect = Buffer.from(p.record.serverKey, 'base64');
    let sock: tls.TLSSocket | null = null;
    for (const address of p.record.addresses) {
      try {
        sock = (
          await dial({
            address,
            ...deps.tls(),
            peerCert: p.record.cert,
            peerMachineId: p.record.machineId,
            expectKeyRaw: expect,
            timeoutMs: deps.dialTimeoutMs ?? 5_000,
          })
        ).sock;
        break;
      } catch (err) {
        deps.log.debug('link: dial failed', {
          peer: p.record.machineId,
          address,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    p.dialing = false;
    const redial = p.redial;
    p.redial = false;
    if (sock === null) {
      if (!terminal(p) && !p.conn) event(p, { kind: 'closed', at: deps.now() });
      p.attempt = redial ? 0 : p.attempt + 1;
      scheduleDial(p, redial);
      return;
    }
    await adopt(p, sock, deps.identity().machineId);
  };

  /** Hello exchange for a known peer's fresh stream, then the same attach a TLS socket gets. */
  const adopt = async (
    p: Peer,
    sock: Duplex,
    dialer: string,
    dialed?: SshDialed,
  ): Promise<void> => {
    if (stopped || terminal(p)) {
      sock.destroy();
      return;
    }
    const sentCapabilities = { ...p.record.capabilities };
    const opened = await openConnection(sock, {
      hello: ownHello(sentCapabilities),
      now: deps.now,
      log: deps.log,
      pingMs: deps.pingMs,
    });
    if ('error' in opened) {
      // The ssh child's exit says why it never got to a hello (host key, auth, bridge refusal).
      // It is kept on the peer before the state moves, so a waiter sees the reason with the down.
      if (dialed !== undefined) {
        const failure = await dialed.failure();
        p.lastDialFailure = failure;
        deps.log.debug('link: ssh stream ended before hello', {
          peer: p.record.machineId,
          failure,
        });
      }
      failed(p, opened.error);
      return;
    }
    attach(p, opened, sentCapabilities, dialer);
  };

  /**
   * What an ssh hello must satisfy before it may name a record. The machine id is the hash of the
   * key it arrives with, as pairing checks it over TLS: the store and the outbox key by machine id,
   * so an unbound id would let one peer take another's record. A hello naming this machine is a
   * loop back to ourselves, refused the same way.
   */
  const helloRefused = (hello: HelloFrame): boolean => {
    const raw = Buffer.from(hello.serverKey, 'base64');
    if (raw.length !== 32 || raw.toString('base64') !== hello.serverKey) {
      deps.log.warn('link: ssh hello refused', { peer: hello.machineId, reason: 'malformed key' });
      return true;
    }
    if (hello.machineId !== deriveMachineId(raw)) {
      deps.log.warn('link: ssh hello refused', {
        peer: hello.machineId,
        reason: 'forged machine id',
      });
      return true;
    }
    if (hello.machineId === deps.identity().machineId) {
      deps.log.warn('link: ssh self-link refused', { peer: hello.machineId });
      return true;
    }
    return false;
  };

  /**
   * The peer's record for a sound ssh hello, or why it can't be pinned. One transport per peer
   * while TLS is parked; a changed server key is never accepted. A dial reaches only the host the
   * record was pinned for (spec 4.2.5): a controller record (no endpoint) or another target is a
   * conflict, and the same target may move its node, mainJs or userData.
   */
  const pinSshPeer = (
    hello: HelloFrame,
    ssh: SshEndpoint | null,
  ):
    | { record: LinkRecord }
    | { error: 'identity-changed' }
    | { error: 'identity-conflict'; machine: string } => {
    const live = deps.store.get(hello.machineId);
    if (live !== null) {
      // The conflict names the record it collides with: the hint tells the agent to connect that one.
      if (live.transport !== 'ssh') return { error: 'identity-conflict', machine: live.name };
      if (live.serverKey !== hello.serverKey) return { error: 'identity-changed' };
      if (ssh === null) return { record: live };
      if (live.ssh === null || live.ssh.target !== ssh.target)
        return { error: 'identity-conflict', machine: live.name };
      if (JSON.stringify(live.ssh) === JSON.stringify(ssh)) return { record: live };
      return { record: deps.store.update(live.machineId, { ssh }) ?? live };
    }
    if (deps.store.conflicts(hello.machineId, hello.serverKey))
      return { error: 'identity-changed' };
    // An ssh record we dial is named by the target the owner gave, not by the peer's own text (spec 4.1).
    const name =
      ssh !== null
        ? ssh.target
        : printableName(hello.selfName, MAX_NAME_CHARS)
          ? hello.selfName
          : hello.machineId;
    return {
      record: deps.store.addSsh({
        machineId: hello.machineId,
        serverKey: hello.serverKey,
        // Owner keys are never compared on ssh links, so a server without one still links.
        ownerKey: hello.ownerKey,
        name,
        ssh,
      }),
    };
  };

  const markIdentityChanged = (machineId: string): void => {
    const live = deps.store.get(machineId);
    if (live !== null) event(ensurePeer(live), { kind: 'identity-changed', at: deps.now() });
  };

  /**
   * Identity check, duplicate resolution and up, for a connection whose hello has arrived. TLS
   * peers also check their owner key; ssh peers carry no owner semantics (plan decision 5).
   */
  const attach = (
    p: Peer,
    opened: LinkConnection,
    sentCapabilities: Capabilities,
    dialer: string,
  ): void => {
    // The handshake takes time: a revoke or stop that landed meanwhile must win over this socket,
    // or a revoked link would keep a live connection the peer still believes in.
    if (stopped || terminal(p)) {
      if (p.sm.state === 'revoked') opened.send({ t: 'revoked' });
      opened.close(stopped ? 'shutdown' : p.sm.state);
      return;
    }
    // A disconnect that landed during this peer's hello must win over its stream, as a revoke does.
    if (!enabledInStore(p.record.machineId)) {
      opened.close('disconnect');
      return;
    }
    const hello = opened.peerHello;
    if (
      hello.machineId !== p.record.machineId ||
      hello.serverKey !== p.record.serverKey ||
      (p.record.transport === 'tls' && !ownerMatches(p.record, hello.ownerKey))
    ) {
      opened.close('identity-changed');
      event(p, { kind: 'identity-changed', at: deps.now() });
      return;
    }
    recordPlatform(p.record, hello);
    let replaced = false;
    if (p.conn) {
      // Same dialer: that machine only opens a new stream once its side of the old one is gone, so the
      // old one is stale and the new one stays (review CON-39 T1, B3). Different dialers keep the rule.
      const keep =
        p.dialer === dialer
          ? 'b'
          : keepConnection({ dialerMachineId: p.dialer ?? '' }, { dialerMachineId: dialer });
      if (keep === 'a') {
        opened.send({ t: 'bye', reason: 'duplicate' });
        opened.close('duplicate');
        return;
      }
      const old = p.conn;
      p.conn = null;
      old.send({ t: 'bye', reason: 'duplicate' });
      old.close('duplicate');
      replaced = true;
    }
    p.cancelRetry?.();
    p.cancelRetry = null;
    p.conn = opened;
    p.dialer = dialer;
    p.attempt = 0;
    p.lastDialFailure = null;
    p.peerHello = hello;
    p.lastActivity = deps.now();
    // Pairing's name limit applies to a hello name too; one number, owned by pairing. A dialed ssh
    // record keeps its target as its name (spec 4.1): only the peer's own name would rename it.
    const dialedSsh = p.record.transport === 'ssh' && p.record.ssh !== null;
    if (
      !dialedSsh &&
      printableName(hello.selfName, MAX_NAME_CHARS) &&
      hello.selfName !== p.record.name
    ) {
      p.record = deps.store.update(p.record.machineId, { name: hello.selfName }) ?? p.record;
    }
    event(p, { kind: 'up', at: deps.now() });
    opened.start({ onFrame: (f) => onFrame(p, opened, f), onClose: () => onClose(p, opened) });
    // A change made during the handshake missed this hello, and any connection it went out on.
    if (!sameCapabilities(sentCapabilities, p.record.capabilities))
      opened.send({ t: 'caps', capabilities: { ...p.record.capabilities } });
    if (p.record.ownerTransfer === 'send') sendOwnerKey(p, opened);
    if (replaced) deps.reconnected(p.record.machineId);
    deps.changed();
  };

  /** The controller's hello pins it: the bridge's preamble already proved this stream is ssh. */
  const acceptSsh = async (stream: Duplex): Promise<void> => {
    if (stopped) {
      stream.destroy();
      return;
    }
    const sent = { ...OWN_DEFAULT_CAPABILITIES };
    const opened = await openConnection(stream, {
      hello: ownHello(sent),
      now: deps.now,
      log: deps.log,
      pingMs: deps.pingMs,
    });
    if ('error' in opened) return;
    // Stopped during the hello: nothing is pinned, so nothing is stored for a link that won't run.
    if (stopped) {
      opened.close('shutdown');
      return;
    }
    const hello = opened.peerHello;
    if (helloRefused(hello)) {
      opened.close('bad-hello');
      return;
    }
    // A revoked peer that dials us only hears that it was revoked, as over TLS (tombstones by key).
    const tomb = deps.store.byServerKey(hello.serverKey);
    if (tomb !== null && 'tombstone' in tomb) {
      opened.send({ t: 'revoked' });
      opened.close('revoked');
      return;
    }
    const pinned = pinSshPeer(hello, null);
    if ('error' in pinned) {
      if (pinned.error === 'identity-changed') markIdentityChanged(hello.machineId);
      opened.close(pinned.error);
      return;
    }
    attach(ensurePeer(pinned.record), opened, sent, hello.machineId);
  };

  /** One ssh dial at a time per target: concurrent callers share its result. */
  const adding = new Map<string, Promise<AddSshPeerResult>>();

  const dialSshPeer = async (ssh: SshEndpoint): Promise<AddSshPeerResult> => {
    const dialed = deps.sshDial(ssh);
    const sent = { ...OWN_DEFAULT_CAPABILITIES };
    const opened = await openConnection(dialed.stream, {
      hello: ownHello(sent),
      now: deps.now,
      log: deps.log,
      pingMs: deps.pingMs,
    });
    if ('error' in opened) {
      if (opened.error === 'closed')
        return {
          ok: false,
          error: (await dialed.failure()) ?? { code: 'ssh_failed', detail: 'closed' },
        };
      return { ok: false, error: { code: opened.error } };
    }
    // Stopped during the hello: no record is pinned for a link that will not run.
    if (stopped) {
      opened.close('shutdown');
      return { ok: false, error: { code: 'ssh_failed', detail: 'not_adopted' } };
    }
    const hello = opened.peerHello;
    if (helloRefused(hello)) {
      opened.close('bad-hello');
      return { ok: false, error: { code: 'bad-hello' } };
    }
    // A known target that answers with another machine id is a reinstall or an impostor. The old
    // pin stays until the owner acts (spec 6); a second record for the same target is never made.
    const pinnedElsewhere = deps.store
      .links()
      .find(
        (l) =>
          l.transport === 'ssh' && l.ssh?.target === ssh.target && l.machineId !== hello.machineId,
      );
    if (pinnedElsewhere !== undefined) {
      markIdentityChanged(pinnedElsewhere.machineId);
      opened.close('identity-changed');
      return { ok: false, error: { code: 'identity-changed' } };
    }
    const pinned = pinSshPeer(hello, ssh);
    if ('error' in pinned) {
      if (pinned.error === 'identity-changed') markIdentityChanged(hello.machineId);
      opened.close(pinned.error);
      return {
        ok: false,
        error:
          pinned.error === 'identity-changed'
            ? { code: 'identity-changed' }
            : { code: 'identity-conflict', machine: pinned.machine },
      };
    }
    // An explicit add is the owner asking for this machine, so a disabled one comes back on before its
    // link attaches; attach refuses a disabled peer (its disconnect check), and the add must not lose.
    const meta = pinned.record.machine;
    const enabledRecord =
      meta !== null && !meta.enabled
        ? (deps.store.setMachine(hello.machineId, { ...meta, enabled: true }) ?? pinned.record)
        : pinned.record;
    const p = ensurePeer(enabledRecord);
    // An explicit add re-adds a peer that was revoked or refused, as add() does for TLS.
    p.revokedBy = null;
    if (terminal(p)) p.sm = initialLinkState(deps.now());
    // A duplicate keeps the live connection, which then answers for this target too.
    attach(p, opened, sent, deps.identity().machineId);
    return { ok: true, machineId: hello.machineId };
  };

  const sendOwnerKey = (p: Peer, conn: LinkConnection): void => {
    const owner = deps.identity().ownerKey;
    if (owner === null) {
      deps.log.warn('link: no owner key to hand over', { peer: p.record.machineId });
      return;
    }
    conn.send({
      t: 'owner',
      publicKey: owner.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      privateKey: owner.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    });
  };

  const settleOwner = (
    p: Peer,
    conn: LinkConnection,
    f: { publicKey: string; privateKey: string },
  ) => {
    // Only the key both people confirmed at pairing, and only from the side expected to send it.
    if (p.record.ownerTransfer !== 'receive' || f.publicKey !== p.record.ownerKey) {
      deps.log.warn('link: unexpected owner key refused', { peer: p.record.machineId });
      return;
    }
    if (!deps.onOwnerKey(f)) return;
    p.record = deps.store.update(p.record.machineId, { ownerTransfer: null }) ?? p.record;
    conn.send({ t: 'owner.ack' });
  };

  const failed = (p: Peer, error: ConnectionError): void => {
    if (error === 'incompatible') {
      event(p, { kind: 'incompatible', at: deps.now() });
      return;
    }
    if (!p.conn) {
      event(p, { kind: 'closed', at: deps.now() });
      p.attempt += 1;
      scheduleDial(p, false);
    }
  };

  const onFrame = (p: Peer, conn: LinkConnection, f: LinkFrame): void => {
    // Frames from a connection that lost a duplicate race, or arrive after revoke, are dropped.
    if (p.conn !== conn || terminal(p)) return;
    p.lastActivity = deps.now();
    if (p.sm.state === 'degraded') event(p, { kind: 'frame', at: deps.now() });
    if ((f.t === 'owner' || f.t === 'owner.ack') && p.record.transport === 'ssh') {
      // Owner keys never cross an ssh link: the ssh peer has no owner semantics (plan §4.2.7).
      deps.log.warn('link: owner frame refused on ssh link', { peer: p.record.machineId });
      return;
    }
    switch (f.t) {
      case 'caps':
        if (p.peerHello) p.peerHello = { ...p.peerHello, capabilities: f.capabilities };
        deps.changed();
        return;
      case 'revoked':
        revokedByPeer(p);
        return;
      case 'bye':
        if (f.reason === 'revoked') revokedByPeer(p);
        else conn.close(f.reason);
        return;
      case 'hello':
        return;
      case 'owner':
        settleOwner(p, conn, f);
        return;
      case 'owner.ack':
        if (p.record.ownerTransfer === 'send')
          p.record = deps.store.update(p.record.machineId, { ownerTransfer: null }) ?? p.record;
        return;
      default:
        deps.onFrame(p.record.machineId, f);
    }
  };

  const onClose = (p: Peer, conn: LinkConnection): void => {
    if (p.conn !== conn) return;
    p.conn = null;
    p.dialer = null;
    if (terminal(p)) return;
    event(p, { kind: 'closed', at: deps.now() });
    scheduleDial(p, false);
  };

  const revokedByPeer = (p: Peer): void => {
    p.revokedBy = 'peer';
    finishRevoke(p);
  };

  const finishRevoke = (p: Peer): void => {
    p.cancelRetry?.();
    p.cancelRetry = null;
    const conn = p.conn;
    p.conn = null;
    conn?.close('revoked');
    deps.store.revoke(p.record.machineId, deps.now());
    event(p, { kind: 'revoked', at: deps.now() });
    deps.audit.record({
      kind: 'link.revoked',
      peer: p.record.machineId,
      detail: { by: p.revokedBy ?? 'me' },
    });
    for (const l of revokedListeners) l(p.record.machineId);
  };

  const tick = (): void => {
    for (const p of peers.values()) {
      if (p.conn && !terminal(p)) {
        event(p, { kind: 'silence', at: deps.now(), silentMs: p.conn.silentMs() });
      }
    }
  };

  // Every down ssh peer, enabled ones only, dials now: its backoff was counting time the machine slept.
  const wake = (): void => {
    for (const p of peers.values()) {
      if (p.record.transport === 'ssh' && p.sm.state === 'down') scheduleDial(p, true);
    }
  };

  const viewOf = (p: Peer): LinkView => {
    const peerFeatures = p.peerHello?.features ?? null;
    return {
      machineId: p.record.machineId,
      name: p.record.name,
      transport: p.record.transport,
      state: p.sm.state,
      since: iso(p.sm.since),
      revokedBy: p.revokedBy,
      addresses: [...p.record.addresses],
      capabilities: { ...p.record.capabilities },
      peerCapabilities: p.peerHello ? { ...p.peerHello.capabilities } : null,
      unsupported:
        peerFeatures === null ? [] : LINK_FEATURES.filter((f) => !peerFeatures.includes(f)),
      fingerprint: p.record.fingerprint,
      lastActivity: p.lastActivity === null ? null : iso(p.lastActivity),
    };
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      for (const record of deps.store.links()) scheduleDial(ensurePeer(record), true);
      const every = deps.pingMs ?? LINK_PING_MS;
      let lastTickAt = deps.now();
      const loop = (): void => {
        const at = deps.now();
        if (at - lastTickAt > WAKE_GAP_FACTOR * every) wake();
        lastTickAt = at;
        tick();
        cancelTicker = deps.after(loop, every);
      };
      cancelTicker = deps.after(loop, every);
    },
    async stop() {
      stopped = true;
      cancelTicker?.();
      cancelTicker = null;
      for (const p of peers.values()) {
        p.cancelRetry?.();
        p.cancelRetry = null;
        const conn = p.conn;
        p.conn = null;
        if (conn) {
          conn.send({ t: 'bye', reason: 'shutdown' });
          conn.close('shutdown');
        }
      }
    },
    knows(peerKeyRaw) {
      return deps.store.byServerKey(b64(peerKeyRaw)) !== null;
    },
    acceptStream(stream) {
      void acceptSsh(stream);
    },
    addSshPeer(ssh) {
      const key = JSON.stringify([ssh.target, ssh.node, ssh.mainJs, ssh.userData]);
      const running = adding.get(key);
      if (running) return running;
      const run = dialSshPeer(ssh).finally(() => adding.delete(key));
      adding.set(key, run);
      return run;
    },
    accept(sock, peerKeyRaw) {
      const found = deps.store.byServerKey(b64(peerKeyRaw));
      if (found === null) {
        sock.destroy();
        return;
      }
      if ('tombstone' in found) {
        // A revoked peer only ever learns that it was revoked; no other frame is read or sent.
        const machineId = found.tombstone.machineId;
        void openConnection(sock, {
          hello: ownHello({ messaging: false, monitor: false, drive: false }),
          now: deps.now,
          log: deps.log,
        }).then((c) => {
          if ('error' in c) return;
          c.send({ t: 'revoked' });
          c.close('revoked');
          deps.log.debug('link: told a revoked peer', { peer: machineId });
        });
        return;
      }
      void adopt(ensurePeer(found), sock, found.machineId);
    },
    add(record) {
      deps.store.put(record);
      const p = ensurePeer(record);
      p.revokedBy = null;
      if (terminal(p)) p.sm = initialLinkState(deps.now());
      deps.changed();
      scheduleDial(p, true);
    },
    disconnect(machineId) {
      const meta = deps.store.get(machineId)?.machine ?? null;
      if (meta === null) return false;
      const next = deps.store.setMachine(machineId, { ...meta, enabled: false });
      if (next === null) return false;
      const p = ensurePeer(next);
      p.cancelRetry?.();
      p.cancelRetry = null;
      const conn = p.conn;
      // Detached before close, so its onClose sees no live connection and leaves the state to this.
      p.conn = null;
      p.dialer = null;
      conn?.close('disconnect');
      event(p, { kind: 'closed', at: deps.now() });
      deps.changed();
      return true;
    },
    enable(machineId) {
      const meta = deps.store.get(machineId)?.machine ?? null;
      if (meta === null) return false;
      const next = deps.store.setMachine(machineId, { ...meta, enabled: true });
      if (next === null) return false;
      const p = ensurePeer(next);
      p.attempt = 0;
      // A failure from an earlier attempt is not this wait's answer.
      p.lastDialFailure = null;
      scheduleDial(p, true);
      deps.changed();
      return true;
    },
    waitUp(machineId, ms, signal) {
      const outcome = (): WaitUpResult | null => {
        const p = peerOf(machineId);
        if (p === null) return null;
        if (p.sm.state === 'up') return { up: true };
        if (terminal(p) || p.lastDialFailure !== null) {
          return { up: false, failure: p.lastDialFailure };
        }
        return null;
      };
      const now = outcome();
      if (now !== null) return Promise.resolve(now);
      if (signal.aborted) return Promise.resolve({ up: false, failure: null });
      return new Promise<WaitUpResult>((resolve) => {
        let cancelTimer: (() => void) | null = null;
        const settleWith = (result: WaitUpResult) => {
          waiters.delete(check);
          signal.removeEventListener('abort', onAbort);
          cancelTimer?.();
          resolve(result);
        };
        const onAbort = () => settleWith({ up: false, failure: null });
        const check = () => {
          const result = outcome();
          if (result !== null) settleWith(result);
        };
        waiters.add(check);
        signal.addEventListener('abort', onAbort, { once: true });
        cancelTimer = deps.after(() => settleWith({ up: false, failure: null }), ms);
      });
    },
    revoke(machineId) {
      const p = peerOf(machineId);
      if (!p || p.sm.state === 'revoked') return false;
      p.revokedBy = 'me';
      p.conn?.send({ t: 'revoked' });
      finishRevoke(p);
      return true;
    },
    setCapability(machineId, capability, on) {
      const p = peerOf(machineId);
      if (!p || terminal(p)) return false;
      const capabilities = { ...p.record.capabilities, [capability]: on };
      p.record = deps.store.update(machineId, { capabilities }) ?? p.record;
      p.conn?.send({ t: 'caps', capabilities });
      deps.audit.record({ kind: 'link.capability', peer: machineId, detail: { capability, on } });
      deps.changed();
      return true;
    },
    setAddresses(machineId, addresses) {
      const p = peerOf(machineId);
      if (!p || terminal(p)) return false;
      p.record = deps.store.update(machineId, { addresses }) ?? p.record;
      deps.changed();
      if (!p.conn) {
        p.attempt = 0;
        if (p.dialing) p.redial = true;
        else scheduleDial(p, true);
      }
      return true;
    },
    send(machineId, frame) {
      const p = peerOf(machineId);
      if (!p?.conn || terminal(p)) return null;
      return p.conn.send(frame);
    },
    views: () => [...peers.values()].map(viewOf),
    peerMinor: (machineId) => peerOf(machineId)?.peerHello?.protocol.minor ?? null,
    view: (machineId) => {
      const p = peerOf(machineId);
      return p ? viewOf(p) : null;
    },
    onRevoked(listener) {
      revokedListeners.add(listener);
      return () => revokedListeners.delete(listener);
    },
  };
}

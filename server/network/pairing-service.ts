import type net from 'node:net';
import { LINK_PROTOCOL, PAIRING_WINDOW_MS } from '../../src/contracts/link-protocol';
import type { NetworkPairingView, PairingViewState } from '../../src/contracts/network-state';
import { encodeFrame, FrameDecoder } from '../../src/network/frame-codec';
import { newCode, normalizeCode } from '../../src/network/pairing-code';
import {
  type JoinerState,
  joinerStart,
  joinerStep,
  type OpenerState,
  type OwnerKeyPair,
  openerStart,
  openerStep,
  type PairingFailReason,
  type PairingInput,
  type PairingMsg,
  type PairingOutcome,
  type PairingSelf,
  parsePairingMsg,
  shownFingerprint,
} from '../../src/network/pairing-protocol';
import type { AuditSink } from './audit-log';
import type { Identity } from './identity';
import { dialPairing } from './listener';

// One pairing at a time, driven by the protocol in src/network/pairing-protocol.ts. This file only
// moves bytes and timers; every decision about a message is the protocol's.
// see docs/plans/2026-11-14-conduit-network-machinery.plan.md decisions 3, 5 and 10

export interface PairingService {
  start(): Promise<{
    pairingId: string;
    code: [string, string, string];
    addresses: string[];
    expiresAt: string;
  }>;
  join(code: string, address: string): Promise<{ pairingId: string }>;
  confirm(pairingId: string): void;
  decline(pairingId: string): void;
  cancel(pairingId: string): void;
  /** True only while an opener window shows its code and no joiner has connected yet. */
  windowOpen(): boolean;
  onPairingSocket(sock: net.Socket): void;
  view(): NetworkPairingView | null;
}

export interface PairingDeps {
  identity(): Identity;
  selfName(): string;
  /** This server's certificate (PEM), sent in pair.id so the peer can pin it as the link's CA. */
  cert(): string;
  /** Starts the link listener if needed; its host:port addresses go in pair.id. */
  linkAddresses(): Promise<string[]>;
  /** Opens the pairing port for a window; its addresses are what the joiner types. */
  openPairingPort(): Promise<string[]>;
  /** The window is used or over: nothing more may connect to pair. Idempotent. */
  closePairingPort(): void;
  /** Stores the link; false when it can't be stored (another link holds that machine id). */
  onLinked(
    outcome: Extract<PairingOutcome, { kind: 'linked' }>,
    dialedAddress: string | null,
  ): boolean;
  /**
   * An owner key this server is owed over a link hasn't arrived yet: until it does, this server's
   * owner is undecided, so it may not pair (CON-27 re-review of R1, minor).
   */
  ownerPending(): boolean;
  generateOwnerKey(): OwnerKeyPair;
  audit: AuditSink;
  changed(): void;
  now(): number;
  rand(n: number): Buffer;
  /** Runs fn after ms; returns its cancel. */
  after(fn: () => void, ms: number): () => void;
  newId(): string;
  dialTimeoutMs?: number;
}

// Pairing messages are small and the peer is unauthenticated until the fingerprint is confirmed,
// so it may not make us buffer more than this.
const PAIRING_FRAME_MAX_BYTES = 64 * 1024;
/** A connection to the pairing port must send its first message within this, or it is dropped. */
export const PAIRING_FIRST_FRAME_MS = 10_000;
const LIVE: ReadonlySet<PairingViewState> = new Set([
  'showing-code',
  'connecting',
  'confirm',
  'waiting-peer',
]);
const isLive = (s: PairingViewState): boolean => LIVE.has(s);

// A window that simply expires is not audited: nobody connected, so nothing happened to record.
const FAIL_STATE: Record<PairingFailReason | 'declined' | 'cancelled', PairingViewState> = {
  'wrong-code': 'wrong-code',
  'bad-commit': 'mismatch',
  'different-owner': 'different-owner',
  declined: 'declined',
  expired: 'expired',
  used: 'used',
  incompatible: 'incompatible',
  cancelled: 'cancelled',
  protocol: 'failed',
};

type Proto = { role: 'opener'; s: OpenerState } | { role: 'joiner'; s: JoinerState };

interface Bound {
  sock: net.Socket;
  proto: Proto;
  decoder: FrameDecoder;
}

interface Pairing {
  view: NetworkPairingView;
  /** Normalized 'w1 w2 w3'; the opener's window code, or the joiner's typed code. */
  code: string;
  addresses: string[];
  dialed: string | null;
  /** Set once a socket is attached; null while the joiner is still dialing or the window is open. */
  bound: Bound | null;
  stopExpiry: (() => void) | null;
}

const exportPair = (pair: NonNullable<Identity['ownerKey']>): OwnerKeyPair => ({
  publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
});

export function createPairingService(deps: PairingDeps): PairingService {
  let current: Pairing | null = null;
  // Bumped by every start/join so a call overtaken while it awaits the listener gives up.
  let seq = 0;
  let openSeq = 0;
  const dialTimeoutMs = deps.dialTimeoutMs ?? 10_000;

  const expiresAt = (): string => new Date(deps.now() + PAIRING_WINDOW_MS).toISOString();

  const publish = (p: Pairing, patch: Partial<NetworkPairingView>): void => {
    p.view = { ...p.view, ...patch };
    // One attempt per window: once a joiner connects, or the window ends, the port shuts.
    if (p.view.role === 'opener' && p.view.state !== 'showing-code') deps.closePairingPort();
    deps.changed();
  };

  const stopTimer = (p: Pairing): void => {
    p.stopExpiry?.();
    p.stopExpiry = null;
  };

  const terminate = (p: Pairing, state: PairingViewState): void => {
    stopTimer(p);
    publish(p, { state, code: null });
  };

  const schedule = (p: Pairing): void => {
    p.stopExpiry = deps.after(() => onExpire(p), PAIRING_WINDOW_MS);
  };

  const selfFor = (addresses: string[]): PairingSelf => {
    const id = deps.identity();
    return {
      serverKeyRaw: id.serverKeyRaw,
      machineId: id.machineId,
      selfName: deps.selfName(),
      addresses,
      ownerKey: id.ownerKey === null ? null : exportPair(id.ownerKey),
      protocol: { major: LINK_PROTOCOL.major, minor: LINK_PROTOCOL.minor },
      cert: deps.cert(),
    };
  };

  const send = (b: Bound, out: PairingMsg[]): void => {
    for (const m of out) b.sock.write(encodeFrame(m));
  };

  const peerOf = (b: Bound): string | null => b.proto.s.peerId?.machineId ?? null;

  function attach(p: Pairing, sock: net.Socket, proto: Proto): Bound {
    const b: Bound = { sock, proto, decoder: new FrameDecoder(PAIRING_FRAME_MAX_BYTES) };
    p.bound = b;
    sock.on('data', (chunk: Buffer) => onData(p, b, chunk));
    // A socket error is followed by close; the first one ends the pairing, the second is a no-op.
    sock.on('close', () => lost(p, b));
    sock.on('error', () => lost(p, b));
    sock.resume();
    return b;
  }

  function conclude(p: Pairing, b: Bound, outcome: PairingOutcome, out: PairingMsg[]): void {
    send(b, out);
    stopTimer(p);
    if (outcome.kind === 'linked') {
      publish(p, {
        state: 'done',
        code: null,
        fingerprint: outcome.fingerprint,
        peerName: outcome.peer.selfName,
        peerMachineId: outcome.peer.machineId,
      });
      deps.onLinked(outcome, p.view.role === 'joiner' ? p.dialed : null);
      deps.audit.record({
        kind: 'pairing.linked',
        peer: outcome.peer.machineId,
        detail: { fingerprint: outcome.fingerprint },
      });
    } else {
      publish(p, { state: FAIL_STATE[outcome.reason], code: null });
      deps.audit.record({
        kind: 'pairing.failed',
        peer: peerOf(b),
        detail: { reason: outcome.reason },
      });
    }
    b.sock.end();
  }

  function step(p: Pairing, b: Bound, input: PairingInput): void {
    const r =
      b.proto.role === 'opener' ? openerStep(b.proto.s, input) : joinerStep(b.proto.s, input);
    if (r.done) {
      conclude(p, b, r.done, r.out);
      return;
    }
    send(b, r.out);
    refresh(p, b);
  }

  /** The fingerprint is shown once the protocol has verified the reveal; until then we wait. */
  function refresh(p: Pairing, b: Bound): void {
    if (p.view.state !== 'connecting') return;
    const fp = shownFingerprint(b.proto.s);
    if (fp === null) return;
    const peer = b.proto.s.peerId;
    publish(p, {
      state: 'confirm',
      fingerprint: fp,
      peerName: peer?.selfName ?? null,
      peerMachineId: peer?.machineId ?? null,
    });
  }

  function onData(p: Pairing, b: Bound, chunk: Buffer): void {
    if (!isLive(p.view.state)) return;
    const { frames, error } = b.decoder.push(chunk);
    for (const raw of frames) {
      if (!isLive(p.view.state)) return;
      const msg = parsePairingMsg(raw);
      if (msg === null) {
        conclude(p, b, { kind: 'failed', reason: 'protocol' }, [
          { t: 'pair.fail', reason: 'protocol' },
        ]);
        return;
      }
      step(p, b, { kind: 'msg', msg });
    }
    if (error !== null && isLive(p.view.state)) {
      conclude(p, b, { kind: 'failed', reason: 'protocol' }, [
        { t: 'pair.fail', reason: 'protocol' },
      ]);
    }
  }

  /** The socket went away before the protocol finished: nothing about the peer is trusted. */
  function lost(p: Pairing, b: Bound): void {
    if (!isLive(p.view.state)) return;
    stopTimer(p);
    publish(p, { state: 'failed', code: null });
    deps.audit.record({ kind: 'pairing.failed', peer: peerOf(b), detail: { reason: 'closed' } });
    b.sock.destroy();
  }

  function onExpire(p: Pairing): void {
    p.stopExpiry = null;
    if (!isLive(p.view.state)) return;
    if (p.bound === null) {
      terminate(p, 'expired');
      return;
    }
    step(p, p.bound, { kind: 'expire' });
  }

  function cancelPairing(p: Pairing): void {
    if (p.bound === null) {
      terminate(p, 'cancelled');
      return;
    }
    step(p, p.bound, { kind: 'cancel' });
  }

  function cancelCurrent(): void {
    if (current !== null && isLive(current.view.state)) cancelPairing(current);
  }

  /** The window that can take a joiner right now, or null. */
  function openWindow(): Pairing | null {
    const p = current;
    return p !== null && p.view.role === 'opener' && p.view.state === 'showing-code' ? p : null;
  }

  function live(pairingId: string): Pairing | null {
    const p = current;
    return p !== null && p.view.pairingId === pairingId && isLive(p.view.state) ? p : null;
  }

  return {
    async start() {
      const mine = ++seq;
      const opening = ++openSeq;
      cancelCurrent();
      const code = newCode(deps.rand);
      const addresses = await deps.linkAddresses();
      const shown = await deps.openPairingPort();
      if (mine !== seq) {
        // The port this call opened is orphaned: no pairing will ever own it. Only the newest
        // opener may close the shared port, or it would shut a pairing that has since started.
        if (opening === openSeq) deps.closePairingPort();
        throw new Error('superseded');
      }
      const pairingId = deps.newId();
      const expires = expiresAt();
      const p: Pairing = {
        view: {
          pairingId,
          role: 'opener',
          state: 'showing-code',
          code,
          expiresAt: expires,
          fingerprint: null,
          peerName: null,
          peerMachineId: null,
        },
        code: code.join(' '),
        addresses,
        dialed: null,
        bound: null,
        stopExpiry: null,
      };
      current = p;
      schedule(p);
      deps.changed();
      return { pairingId, code, addresses: shown, expiresAt: expires };
    },

    async join(codeInput, address) {
      const code = normalizeCode(codeInput);
      if (code === null) throw new Error('bad_code');
      const mine = ++seq;
      cancelCurrent();
      // Both sides listen after pairing, so the joiner's own addresses are needed in pair.id.
      const addresses = await deps.linkAddresses();
      if (mine !== seq) throw new Error('superseded');
      const pairingId = deps.newId();
      const p: Pairing = {
        view: {
          pairingId,
          role: 'joiner',
          state: 'connecting',
          code: null,
          expiresAt: expiresAt(),
          fingerprint: null,
          peerName: null,
          peerMachineId: null,
        },
        code,
        addresses,
        dialed: address,
        bound: null,
        stopExpiry: null,
      };
      current = p;
      schedule(p);
      deps.changed();

      let conn: net.Socket;
      try {
        conn = await dialPairing(address, dialTimeoutMs);
      } catch {
        // Every dial failure reads the same to the person: the other machine can't be reached.
        // The cause is not shown, since it is an address or network detail, not a protocol one.
        if (isLive(p.view.state)) terminate(p, 'unreachable');
        return { pairingId };
      }
      // The pairing may have been cancelled or expired while the socket was connecting.
      if (!isLive(p.view.state)) {
        conn.destroy();
        return { pairingId };
      }
      const started = joinerStart({ self: selfFor(addresses), rand: deps.rand }, code);
      const b = attach(p, conn, { role: 'joiner', s: started.state });
      send(b, started.out);
      return { pairingId };
    },

    confirm(pairingId) {
      const p = live(pairingId);
      if (p === null || p.bound === null || p.view.state !== 'confirm') return;
      step(p, p.bound, { kind: 'confirm' });
      if (isLive(p.view.state)) publish(p, { state: 'waiting-peer' });
    },

    decline(pairingId) {
      const p = live(pairingId);
      if (p === null || p.bound === null) return;
      if (p.view.state !== 'confirm' && p.view.state !== 'waiting-peer') return;
      step(p, p.bound, { kind: 'decline' });
    },

    cancel(pairingId) {
      const p = live(pairingId);
      if (p !== null) cancelPairing(p);
    },

    windowOpen: () => openWindow() !== null,

    onPairingSocket(sock) {
      const p = openWindow();
      if (p === null) {
        // The refused socket has no pairing state to update, so its error has no consequence.
        sock.on('error', () => undefined);
        sock.end(encodeFrame({ t: 'pair.fail', reason: 'used' }));
        return;
      }
      const started = openerStart({
        self: selfFor(p.addresses),
        rand: deps.rand,
        code: p.code,
        generateOwnerKey: deps.generateOwnerKey,
      });
      attach(p, sock, { role: 'opener', s: started });
      publish(p, { state: 'connecting' });
    },

    view() {
      return current === null ? null : { ...current.view };
    },
  };
}

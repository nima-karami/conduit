import { createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { deriveMachineId } from './identity-file';
import { commitment, fingerprint, linkIdFor, PAIRING_NONCE_BYTES } from './pairing-transcript';

// Pure pairing state machines, opener (showed the code) and joiner (typed it). The protocol and
// its reasons are docs/plans/2026-11-14-conduit-network-machinery.plan.md decisions 3 and 10. Both
// sides run inside a TLS 1.3 connection whose certificates carry the server keys passed in here.

export const PAIRING_VERSION = 1;
const MAX_NAME_CHARS = 64;
const MAX_ADDRESSES = 16;
const MAX_ADDRESS_CHARS = 255;

export interface OwnerKeyPair {
  publicKey: string; // base64 DER spki
  privateKey: string; // base64 DER pkcs8
}

export type PairingFailReason =
  | 'wrong-code'
  | 'bad-commit'
  | 'different-owner'
  | 'expired'
  | 'used'
  | 'incompatible'
  | 'protocol';

export type PairingMsg =
  | { t: 'pair.hello'; v: number; code: string; commit: string }
  | { t: 'pair.nonce'; nonce: string }
  | { t: 'pair.reveal'; nonce: string }
  | {
      t: 'pair.id';
      machineId: string;
      ownerKey: string | null;
      selfName: string;
      addresses: string[];
      protocol: { major: number; minor: number };
    }
  | { t: 'pair.accept' }
  | { t: 'pair.decline' }
  | { t: 'pair.owner'; publicKey: string; privateKey: string }
  | { t: 'pair.fail'; reason: PairingFailReason };

export type PairingInput =
  | { kind: 'msg'; msg: PairingMsg }
  | { kind: 'confirm' }
  | { kind: 'decline' }
  | { kind: 'cancel' }
  | { kind: 'expire' };

export interface PairingPeer {
  machineId: string;
  serverKey: string; // base64 raw Ed25519, from the TLS certificate
  ownerKey: string; // base64 DER spki, the owner both servers share after linking
  selfName: string;
  addresses: string[];
}

export type PairingOutcome =
  | {
      kind: 'linked';
      peer: PairingPeer;
      linkId: string;
      fingerprint: string;
      /** Set when this server must store a new owner key: received, or generated here. */
      ownerKeyToStore: OwnerKeyPair | null;
    }
  | {
      kind: 'failed';
      reason: PairingFailReason | 'declined' | 'cancelled';
    };

export interface PairingSelf {
  serverKeyRaw: Buffer;
  machineId: string;
  selfName: string;
  addresses: string[];
  ownerKey: OwnerKeyPair | null;
  protocol: { major: number; minor: number };
}

export interface PairingContext {
  self: PairingSelf;
  /** The peer's raw Ed25519 key from its TLS certificate, never from a message. */
  peerKeyRaw: Buffer;
  rand(n: number): Buffer;
}

export interface OpenerContext extends PairingContext {
  /** The window's code, normalized ('w1 w2 w3'). */
  code: string;
  /** Used only when neither server has an owner key yet (first-ever link). */
  generateOwnerKey(): OwnerKeyPair;
}

type Phase =
  | 'await-hello' // opener
  | 'await-reveal' // opener
  | 'await-nonce' // joiner
  | 'await-id'
  | 'confirm'
  | 'await-owner'
  | 'done';

interface Shared {
  phase: Phase;
  nonceOpener: Buffer | null;
  nonceJoiner: Buffer | null;
  peerId: Extract<PairingMsg, { t: 'pair.id' }> | null;
  fingerprint: string | null;
  selfAccepted: boolean;
  peerAccepted: boolean;
}

export interface OpenerState extends Shared {
  role: 'opener';
  ctx: OpenerContext;
  commit: Buffer | null;
}

export interface JoinerState extends Shared {
  role: 'joiner';
  ctx: PairingContext;
  code: string;
}

type AnyState = OpenerState | JoinerState;
export interface StepResult<S> {
  state: S;
  out: PairingMsg[];
  done?: PairingOutcome;
}

const shared = (phase: Phase): Shared => ({
  phase,
  nonceOpener: null,
  nonceJoiner: null,
  peerId: null,
  fingerprint: null,
  selfAccepted: false,
  peerAccepted: false,
});

export function openerStart(ctx: OpenerContext): OpenerState {
  return { role: 'opener', ctx, commit: null, ...shared('await-hello') };
}

/** The joiner speaks first: its commitment binds its nonce before it sees the opener's. */
export function joinerStart(ctx: PairingContext, code: string): StepResult<JoinerState> {
  const nonce = ctx.rand(PAIRING_NONCE_BYTES);
  const state: JoinerState = { role: 'joiner', ctx, code, ...shared('await-nonce') };
  state.nonceJoiner = nonce;
  const commit = commitment(ctx.self.serverKeyRaw, nonce).toString('base64');
  return { state, out: [{ t: 'pair.hello', v: PAIRING_VERSION, code, commit }] };
}

function b64(s: string, bytes: number): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return b.length === bytes && b.toString('base64') === s ? b : null;
}

function isEd25519Spki(s: string): boolean {
  try {
    return (
      createPublicKey({ key: Buffer.from(s, 'base64'), format: 'der', type: 'spki' })
        .asymmetricKeyType === 'ed25519'
    );
  } catch {
    // An unparseable key is a malformed message; the caller fails the pairing with 'protocol'.
    return false;
  }
}

function privateMatches(pair: OwnerKeyPair): boolean {
  try {
    const priv = createPrivateKey({
      key: Buffer.from(pair.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const pub = createPublicKey(priv).export({ type: 'spki', format: 'der' });
    return pub.toString('base64') === pair.publicKey;
  } catch {
    // An unparseable key is a malformed message; the caller fails the pairing with 'protocol'.
    return false;
  }
}

function validId(m: Extract<PairingMsg, { t: 'pair.id' }>, peerKeyRaw: Buffer): boolean {
  const name = m.selfName.trim();
  return (
    m.machineId === deriveMachineId(peerKeyRaw) &&
    name.length > 0 &&
    m.selfName.length <= MAX_NAME_CHARS &&
    m.addresses.length <= MAX_ADDRESSES &&
    m.addresses.every((a) => a.length > 0 && a.length <= MAX_ADDRESS_CHARS) &&
    Number.isInteger(m.protocol.major) &&
    Number.isInteger(m.protocol.minor) &&
    (m.ownerKey === null || isEd25519Spki(m.ownerKey))
  );
}

function idMsg(self: PairingSelf): PairingMsg {
  return {
    t: 'pair.id',
    machineId: self.machineId,
    ownerKey: self.ownerKey?.publicKey ?? null,
    selfName: self.selfName,
    addresses: self.addresses,
    protocol: self.protocol,
  };
}

function end<S extends AnyState>(
  s: S,
  out: PairingMsg[],
  reason: Extract<PairingOutcome, { kind: 'failed' }>['reason'],
): StepResult<S> {
  s.phase = 'done';
  return { state: s, out, done: { kind: 'failed', reason } };
}

const fail = <S extends AnyState>(s: S, reason: PairingFailReason): StepResult<S> =>
  end(s, [{ t: 'pair.fail', reason }], reason);

/** Decision 10: who sends the owner key once both people confirmed. */
type OwnerPlan = 'none' | 'opener-sends' | 'joiner-sends' | 'opener-generates';
function ownerPlan(opener: string | null, joiner: string | null): OwnerPlan | 'different' {
  if (opener !== null && joiner !== null) return opener === joiner ? 'none' : 'different';
  if (opener !== null) return 'opener-sends';
  if (joiner !== null) return 'joiner-sends';
  return 'opener-generates';
}

function ownerKeys(s: AnyState): { opener: string | null; joiner: string | null } {
  const mine = s.ctx.self.ownerKey?.publicKey ?? null;
  const theirs = s.peerId?.ownerKey ?? null;
  return s.role === 'opener' ? { opener: mine, joiner: theirs } : { opener: theirs, joiner: mine };
}

function keys(s: AnyState): { opener: Buffer; joiner: Buffer } {
  const mine = s.ctx.self.serverKeyRaw;
  const theirs = s.ctx.peerKeyRaw;
  return s.role === 'opener' ? { opener: mine, joiner: theirs } : { opener: theirs, joiner: mine };
}

function linked<S extends AnyState>(
  s: S,
  out: PairingMsg[],
  ownerPublic: string,
  ownerKeyToStore: OwnerKeyPair | null,
): StepResult<S> {
  const id = s.peerId;
  const fp = s.fingerprint;
  if (id === null || fp === null) return fail(s, 'protocol');
  s.phase = 'done';
  const k = keys(s);
  return {
    state: s,
    out,
    done: {
      kind: 'linked',
      peer: {
        machineId: id.machineId,
        serverKey: s.ctx.peerKeyRaw.toString('base64'),
        ownerKey: ownerPublic,
        selfName: id.selfName.trim(),
        addresses: id.addresses,
      },
      linkId: linkIdFor(k.opener, k.joiner),
      fingerprint: fp,
      ownerKeyToStore,
    },
  };
}

/** Both accepted: the side decision 10 names sends the owner key and is done; the other waits. */
function settle<S extends AnyState>(s: S, out: PairingMsg[]): StepResult<S> {
  if (!s.selfAccepted || !s.peerAccepted) return { state: s, out };
  const owners = ownerKeys(s);
  const plan = ownerPlan(owners.opener, owners.joiner);
  if (plan === 'different') return fail(s, 'different-owner');
  if (plan === 'none') return linked(s, out, owners.opener ?? '', null);
  const iSend =
    (s.role === 'opener' && (plan === 'opener-sends' || plan === 'opener-generates')) ||
    (s.role === 'joiner' && plan === 'joiner-sends');
  if (!iSend) {
    s.phase = 'await-owner';
    return { state: s, out };
  }
  if (plan === 'opener-generates' && s.role === 'opener') {
    const fresh = s.ctx.generateOwnerKey();
    return linked(
      s,
      [...out, { t: 'pair.owner', publicKey: fresh.publicKey, privateKey: fresh.privateKey }],
      fresh.publicKey,
      fresh,
    );
  }
  const own = s.ctx.self.ownerKey;
  if (own === null) return fail(s, 'protocol');
  return linked(
    s,
    [...out, { t: 'pair.owner', publicKey: own.publicKey, privateKey: own.privateKey }],
    own.publicKey,
    null,
  );
}

function onPeerId<S extends AnyState>(
  s: S,
  m: Extract<PairingMsg, { t: 'pair.id' }>,
  out: PairingMsg[],
): StepResult<S> {
  if (!validId(m, s.ctx.peerKeyRaw)) return fail(s, 'protocol');
  if (m.protocol.major !== s.ctx.self.protocol.major) return fail(s, 'incompatible');
  s.peerId = m;
  // Refused before anyone is asked to confirm a fingerprint for a link that can't exist.
  const owners = ownerKeys(s);
  if (ownerPlan(owners.opener, owners.joiner) === 'different') return fail(s, 'different-owner');
  s.phase = 'confirm';
  return settle(s, out);
}

function onOwner<S extends AnyState>(
  s: S,
  m: Extract<PairingMsg, { t: 'pair.owner' }>,
): StepResult<S> {
  const owners = ownerKeys(s);
  const announced = s.role === 'opener' ? owners.joiner : owners.opener;
  // A key the sender announced in pair.id must be the one it hands over; a generated one is new.
  if (announced !== null && announced !== m.publicKey) return fail(s, 'protocol');
  if (!isEd25519Spki(m.publicKey) || !privateMatches(m)) return fail(s, 'protocol');
  return linked(s, [], m.publicKey, { publicKey: m.publicKey, privateKey: m.privateKey });
}

/** Messages and user actions every phase after the reveal treats the same way. */
function common<S extends AnyState>(s: S, input: PairingInput): StepResult<S> | null {
  if (input.kind === 'cancel') return end(s, [{ t: 'pair.decline' }], 'cancelled');
  if (input.kind === 'decline') return end(s, [{ t: 'pair.decline' }], 'declined');
  if (input.kind === 'expire') return fail(s, 'expired');
  if (input.kind !== 'msg') return null;
  if (input.msg.t === 'pair.decline') return end(s, [], 'declined');
  if (input.msg.t === 'pair.fail') return end(s, [], input.msg.reason);
  return null;
}

function afterReveal<S extends AnyState>(s: S, input: PairingInput): StepResult<S> {
  const c = common(s, input);
  if (c) return c;
  if (s.phase === 'await-id' && input.kind === 'msg' && input.msg.t === 'pair.id')
    return onPeerId(s, input.msg, []);
  if (s.phase === 'await-id' && input.kind === 'msg' && input.msg.t === 'pair.accept') {
    // The peer may confirm before its id reaches us only if it saw ours first; ids precede accepts.
    return fail(s, 'protocol');
  }
  if (s.phase === 'confirm' && input.kind === 'confirm') {
    if (s.selfAccepted) return { state: s, out: [] };
    s.selfAccepted = true;
    return settle(s, [{ t: 'pair.accept' }]);
  }
  if (s.phase === 'confirm' && input.kind === 'msg' && input.msg.t === 'pair.accept') {
    if (s.peerAccepted) return fail(s, 'protocol');
    s.peerAccepted = true;
    return settle(s, []);
  }
  if (s.phase === 'await-owner' && input.kind === 'msg' && input.msg.t === 'pair.owner')
    return onOwner(s, input.msg);
  return fail(s, 'protocol');
}

export function openerStep(s: OpenerState, input: PairingInput): StepResult<OpenerState> {
  if (s.phase === 'done') return { state: s, out: [] };
  if (s.phase === 'await-hello') {
    if (input.kind === 'expire') return fail(s, 'expired');
    if (input.kind === 'cancel') return end(s, [{ t: 'pair.decline' }], 'cancelled');
    if (input.kind !== 'msg' || input.msg.t !== 'pair.hello') return fail(s, 'protocol');
    const m = input.msg;
    if (m.v !== PAIRING_VERSION) return fail(s, 'incompatible');
    if (!safeEqualText(m.code, s.ctx.code)) return fail(s, 'wrong-code');
    const commit = b64(m.commit, 32);
    if (commit === null) return fail(s, 'protocol');
    s.commit = commit;
    s.nonceOpener = s.ctx.rand(PAIRING_NONCE_BYTES);
    s.phase = 'await-reveal';
    return { state: s, out: [{ t: 'pair.nonce', nonce: s.nonceOpener.toString('base64') }] };
  }
  if (s.phase === 'await-reveal') {
    const c = common(s, input);
    if (c) return c;
    if (input.kind !== 'msg' || input.msg.t !== 'pair.reveal') return fail(s, 'protocol');
    const nonce = b64(input.msg.nonce, PAIRING_NONCE_BYTES);
    if (nonce === null || s.commit === null || s.nonceOpener === null) return fail(s, 'protocol');
    // The commitment is checked against the key in the joiner's TLS certificate: a relay that
    // re-terminates TLS with its own key can't make this match the joiner's commitment.
    if (!timingSafeEqual(commitment(s.ctx.peerKeyRaw, nonce), s.commit))
      return fail(s, 'bad-commit');
    s.nonceJoiner = nonce;
    s.fingerprint = fingerprint(s.ctx.self.serverKeyRaw, s.ctx.peerKeyRaw, s.nonceOpener, nonce);
    s.phase = 'await-id';
    return { state: s, out: [idMsg(s.ctx.self)] };
  }
  return afterReveal(s, input);
}

export function joinerStep(s: JoinerState, input: PairingInput): StepResult<JoinerState> {
  if (s.phase === 'done') return { state: s, out: [] };
  if (s.phase === 'await-nonce') {
    const c = common(s, input);
    if (c) return c;
    if (input.kind !== 'msg' || input.msg.t !== 'pair.nonce') return fail(s, 'protocol');
    const nonce = b64(input.msg.nonce, PAIRING_NONCE_BYTES);
    if (nonce === null || s.nonceJoiner === null) return fail(s, 'protocol');
    s.nonceOpener = nonce;
    s.fingerprint = fingerprint(s.ctx.peerKeyRaw, s.ctx.self.serverKeyRaw, nonce, s.nonceJoiner);
    s.phase = 'await-id';
    return {
      state: s,
      out: [{ t: 'pair.reveal', nonce: s.nonceJoiner.toString('base64') }, idMsg(s.ctx.self)],
    };
  }
  return afterReveal(s, input);
}

function safeEqualText(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The fingerprint to show, once the reveal has checked out; null before. */
export const shownFingerprint = (s: OpenerState | JoinerState): string | null =>
  s.phase === 'confirm' || s.phase === 'await-owner' ? s.fingerprint : null;

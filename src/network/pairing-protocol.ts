import { createPublicKey, timingSafeEqual, X509Certificate } from 'node:crypto';
import { deriveMachineId } from './identity-file';
import {
  commitment,
  fingerprint,
  identityDigest,
  linkIdFor,
  PAIRING_NONCE_BYTES,
} from './pairing-transcript';
import { rawEd25519 } from './self-signed-cert';

// Pure pairing state machines, opener (showed the code) and joiner (typed it). The protocol and
// its reasons are docs/plans/2026-11-14-conduit-network-machinery.plan.md decisions 3 and 10.
// It runs over plain TCP: every message is public, keys travel in the messages, and the human
// comparing the fingerprint is what authenticates them (numeric comparison). Possession of each
// key is proven later by the first pinned TLS link handshake, which is also where the owner
// private key crosses, never here.

const PAIRING_VERSION = 1;
const KEY_BYTES = 32;
/** A machine's self-name: pairing and every later hello hold it to this. */
export const MAX_NAME_CHARS = 64;
const MAX_ADDRESSES = 16;
const MAX_ADDRESS_CHARS = 255;
const MAX_CERT_CHARS = 4096;

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
  | { t: 'pair.hello'; v: number; code: string; key: string; commit: string }
  | { t: 'pair.nonce'; nonce: string; key: string }
  | { t: 'pair.reveal'; nonce: string }
  | {
      t: 'pair.id';
      machineId: string;
      ownerKey: string | null;
      /** The opener only, when it holds no owner key: the public half of one it would create. */
      ownerOffer: string | null;
      selfName: string;
      addresses: string[];
      protocol: { major: number; minor: number };
      cert: string;
    }
  | { t: 'pair.accept' }
  | { t: 'pair.decline' }
  | { t: 'pair.fail'; reason: PairingFailReason };

export type PairingInput =
  | { kind: 'msg'; msg: PairingMsg }
  | { kind: 'confirm' }
  | { kind: 'decline' }
  | { kind: 'cancel' }
  | { kind: 'expire' };

export interface PairingPeer {
  machineId: string;
  serverKey: string; // base64 raw Ed25519
  ownerKey: string; // base64 DER spki: the owner both servers share once linked
  selfName: string;
  addresses: string[];
  cert: string; // PEM, verified to carry serverKey and to be self-signed by it
}

export type PairingOutcome =
  | {
      kind: 'linked';
      peer: PairingPeer;
      linkId: string;
      fingerprint: string;
      /** A first-ever link: the owner key this opener generated, to store now. */
      ownerKeyToStore: OwnerKeyPair | null;
      /** Whether the owner private key must still cross the link once it's up, and which way. */
      ownerTransfer: 'send' | 'receive' | null;
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
  cert: string;
}

export interface PairingContext {
  self: PairingSelf;
  rand(n: number): Buffer;
}

export interface OpenerContext extends PairingContext {
  /** The window's code, normalized ('w1 w2 w3'). */
  code: string;
  /**
   * Called at the reveal when this opener holds no owner key: its public half goes out in pair.id
   * as ownerOffer, inside the compared fingerprint, and is kept only if the joiner has none either.
   */
  generateOwnerKey(): OwnerKeyPair;
}

type Phase =
  | 'await-hello' // opener
  | 'await-reveal' // opener
  | 'await-nonce' // joiner
  | 'await-id'
  | 'confirm'
  | 'done';

interface Shared {
  phase: Phase;
  /** Learned from the peer's first message; the fingerprint binds it. */
  peerKeyRaw: Buffer | null;
  nonceOpener: Buffer | null;
  nonceJoiner: Buffer | null;
  peerId: Extract<PairingMsg, { t: 'pair.id' }> | null;
  /** The pair.id this side sent; the fingerprint binds it alongside the peer's. */
  sentId: Extract<PairingMsg, { t: 'pair.id' }> | null;
  fingerprint: string | null;
  selfAccepted: boolean;
  peerAccepted: boolean;
}

export interface OpenerState extends Shared {
  role: 'opener';
  ctx: OpenerContext;
  commit: Buffer | null;
  /** The owner key offered in this opener's pair.id, when it held none. */
  offer: OwnerKeyPair | null;
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
  peerKeyRaw: null,
  nonceOpener: null,
  nonceJoiner: null,
  peerId: null,
  sentId: null,
  fingerprint: null,
  selfAccepted: false,
  peerAccepted: false,
});

export function openerStart(ctx: OpenerContext): OpenerState {
  return { role: 'opener', ctx, commit: null, offer: null, ...shared('await-hello') };
}

/** The joiner speaks first: its commitment binds its key and nonce before it sees the opener's. */
export function joinerStart(ctx: PairingContext, code: string): StepResult<JoinerState> {
  const nonce = ctx.rand(PAIRING_NONCE_BYTES);
  const state: JoinerState = { role: 'joiner', ctx, code, ...shared('await-nonce') };
  state.nonceJoiner = nonce;
  const key = ctx.self.serverKeyRaw;
  return {
    state,
    out: [
      {
        t: 'pair.hello',
        v: PAIRING_VERSION,
        code,
        key: key.toString('base64'),
        commit: commitment(key, nonce).toString('base64'),
      },
    ],
  };
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

/** The peer's certificate must be the one its link will present: its key, self-signed, its id. */
function certMatches(pem: string, peerKeyRaw: Buffer, machineId: string): boolean {
  try {
    const x = new X509Certificate(pem);
    return (
      rawEd25519(x.publicKey).equals(peerKeyRaw) &&
      x.verify(x.publicKey) &&
      x.subject === `CN=${machineId}`
    );
  } catch {
    // Not a certificate, or not Ed25519: a malformed message, failed with 'protocol'.
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
    (m.ownerKey === null || isEd25519Spki(m.ownerKey)) &&
    (m.ownerOffer === null || (m.ownerKey === null && isEd25519Spki(m.ownerOffer))) &&
    m.cert.length <= MAX_CERT_CHARS &&
    certMatches(m.cert, peerKeyRaw, m.machineId)
  );
}

function idMsg(
  self: PairingSelf,
  ownerOffer: string | null,
): Extract<PairingMsg, { t: 'pair.id' }> {
  return {
    t: 'pair.id',
    machineId: self.machineId,
    ownerKey: self.ownerKey?.publicKey ?? null,
    ownerOffer,
    selfName: self.selfName,
    addresses: self.addresses,
    protocol: self.protocol,
    cert: self.cert,
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

/** Decision 10: which server already holds the owner key and so hands it over on the link. */
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

function linked<S extends AnyState>(
  s: S,
  out: PairingMsg[],
  ownerPublic: string,
  ownerKeyToStore: OwnerKeyPair | null,
  ownerTransfer: 'send' | 'receive' | null,
): StepResult<S> {
  const id = s.peerId;
  const fp = s.fingerprint;
  const peerKey = s.peerKeyRaw;
  if (id === null || fp === null || peerKey === null) return fail(s, 'protocol');
  s.phase = 'done';
  const mine = s.ctx.self.serverKeyRaw;
  return {
    state: s,
    out,
    done: {
      kind: 'linked',
      peer: {
        machineId: id.machineId,
        serverKey: peerKey.toString('base64'),
        ownerKey: ownerPublic,
        selfName: id.selfName.trim(),
        addresses: id.addresses,
        cert: id.cert,
      },
      linkId: linkIdFor(mine, peerKey),
      fingerprint: fp,
      ownerKeyToStore,
      ownerTransfer,
    },
  };
}

/** Both accepted: settle the owner key per decision 10; the private half crosses the link later. */
function settle<S extends AnyState>(s: S, out: PairingMsg[]): StepResult<S> {
  if (!s.selfAccepted || !s.peerAccepted) return { state: s, out };
  const owners = ownerKeys(s);
  const plan = ownerPlan(owners.opener, owners.joiner);
  if (plan === 'different') return fail(s, 'different-owner');
  if (plan === 'none') return linked(s, out, owners.opener ?? '', null, null);
  if (plan === 'opener-generates') {
    // The key both people compared, in the opener's pair.id; nothing settles it after the confirm.
    if (s.role === 'opener')
      return s.offer === null
        ? fail(s, 'protocol')
        : linked(s, out, s.offer.publicKey, s.offer, 'send');
    const offered = s.peerId?.ownerOffer ?? null;
    return offered === null ? fail(s, 'protocol') : linked(s, out, offered, null, 'receive');
  }
  const holderIsMe =
    (plan === 'opener-sends' && s.role === 'opener') ||
    (plan === 'joiner-sends' && s.role === 'joiner');
  const ownerPublic = plan === 'opener-sends' ? owners.opener : owners.joiner;
  if (ownerPublic === null) return fail(s, 'protocol');
  return linked(s, out, ownerPublic, null, holderIsMe ? 'send' : 'receive');
}

function onPeerId<S extends AnyState>(
  s: S,
  m: Extract<PairingMsg, { t: 'pair.id' }>,
  out: PairingMsg[],
): StepResult<S> {
  if (s.peerKeyRaw === null || !validId(m, s.peerKeyRaw)) return fail(s, 'protocol');
  // Only the opener may offer an owner key; a joiner's offer is a forged or broken message.
  if (s.role === 'opener' && m.ownerOffer !== null) return fail(s, 'protocol');
  if (m.protocol.major !== s.ctx.self.protocol.major) return fail(s, 'incompatible');
  if (s.sentId === null || s.nonceOpener === null || s.nonceJoiner === null)
    return fail(s, 'protocol');
  s.peerId = m;
  const mine = s.ctx.self.serverKeyRaw;
  const [pkO, pkJ, idO, idJ] =
    s.role === 'opener' ? [mine, s.peerKeyRaw, s.sentId, m] : [s.peerKeyRaw, mine, m, s.sentId];
  s.fingerprint = fingerprint(
    pkO,
    pkJ,
    s.nonceOpener,
    s.nonceJoiner,
    identityDigest(idO),
    identityDigest(idJ),
  );
  // Refused before anyone is asked to confirm a fingerprint for a link that can't exist.
  const owners = ownerKeys(s);
  if (ownerPlan(owners.opener, owners.joiner) === 'different') return fail(s, 'different-owner');
  s.phase = 'confirm';
  return settle(s, out);
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
    const key = b64(m.key, KEY_BYTES);
    if (commit === null || key === null || key.equals(s.ctx.self.serverKeyRaw))
      return fail(s, 'protocol');
    s.commit = commit;
    s.peerKeyRaw = key;
    s.nonceOpener = s.ctx.rand(PAIRING_NONCE_BYTES);
    s.phase = 'await-reveal';
    return {
      state: s,
      out: [
        {
          t: 'pair.nonce',
          nonce: s.nonceOpener.toString('base64'),
          key: s.ctx.self.serverKeyRaw.toString('base64'),
        },
      ],
    };
  }
  if (s.phase === 'await-reveal') {
    const c = common(s, input);
    if (c) return c;
    if (input.kind !== 'msg' || input.msg.t !== 'pair.reveal') return fail(s, 'protocol');
    const nonce = b64(input.msg.nonce, PAIRING_NONCE_BYTES);
    if (nonce === null || s.commit === null || s.nonceOpener === null || s.peerKeyRaw === null)
      return fail(s, 'protocol');
    if (!timingSafeEqual(commitment(s.peerKeyRaw, nonce), s.commit)) return fail(s, 'bad-commit');
    s.nonceJoiner = nonce;
    s.offer = s.ctx.self.ownerKey === null ? s.ctx.generateOwnerKey() : null;
    s.sentId = idMsg(s.ctx.self, s.offer?.publicKey ?? null);
    s.phase = 'await-id';
    return { state: s, out: [s.sentId] };
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
    const key = b64(input.msg.key, KEY_BYTES);
    if (nonce === null || key === null || s.nonceJoiner === null) return fail(s, 'protocol');
    if (key.equals(s.ctx.self.serverKeyRaw)) return fail(s, 'protocol');
    s.peerKeyRaw = key;
    s.nonceOpener = nonce;
    s.sentId = idMsg(s.ctx.self, null);
    s.phase = 'await-id';
    return {
      state: s,
      out: [{ t: 'pair.reveal', nonce: s.nonceJoiner.toString('base64') }, s.sentId],
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
  s.phase === 'confirm' ? s.fingerprint : null;

const FAIL_REASONS: readonly PairingFailReason[] = [
  'wrong-code',
  'bad-commit',
  'different-owner',
  'expired',
  'used',
  'incompatible',
  'protocol',
];
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
/** Exactly these keys: nothing from the pairing peer is trusted until the fingerprint matches. */
const exactly = (r: Rec, keys: readonly string[]): boolean =>
  Object.keys(r).length === keys.length && keys.every((k) => k in r);

/** Strict validator for a message off the wire; anything else is null and fails the pairing. */
export function parsePairingMsg(raw: unknown): PairingMsg | null {
  if (!isRec(raw)) return null;
  switch (raw.t) {
    case 'pair.hello':
      return exactly(raw, ['t', 'v', 'code', 'key', 'commit']) &&
        isInt(raw.v) &&
        isStr(raw.code) &&
        raw.code.length <= 200 &&
        isStr(raw.key) &&
        isStr(raw.commit)
        ? { t: 'pair.hello', v: raw.v, code: raw.code, key: raw.key, commit: raw.commit }
        : null;
    case 'pair.nonce':
      return exactly(raw, ['t', 'nonce', 'key']) && isStr(raw.nonce) && isStr(raw.key)
        ? { t: 'pair.nonce', nonce: raw.nonce, key: raw.key }
        : null;
    case 'pair.reveal':
      return exactly(raw, ['t', 'nonce']) && isStr(raw.nonce)
        ? { t: 'pair.reveal', nonce: raw.nonce }
        : null;
    case 'pair.id': {
      const p = raw.protocol;
      const addresses = raw.addresses;
      if (
        !exactly(raw, [
          't',
          'machineId',
          'ownerKey',
          'ownerOffer',
          'selfName',
          'addresses',
          'protocol',
          'cert',
        ]) ||
        !isStr(raw.machineId) ||
        !(raw.ownerKey === null || isStr(raw.ownerKey)) ||
        !(raw.ownerOffer === null || isStr(raw.ownerOffer)) ||
        !isStr(raw.selfName) ||
        !isStr(raw.cert) ||
        !Array.isArray(addresses) ||
        !addresses.every(isStr) ||
        !isRec(p) ||
        !exactly(p, ['major', 'minor']) ||
        !isInt(p.major) ||
        !isInt(p.minor)
      )
        return null;
      return {
        t: 'pair.id',
        machineId: raw.machineId,
        ownerKey: raw.ownerKey,
        ownerOffer: raw.ownerOffer,
        selfName: raw.selfName,
        addresses: addresses.filter(isStr),
        protocol: { major: p.major, minor: p.minor },
        cert: raw.cert,
      };
    }
    case 'pair.accept':
    case 'pair.decline':
      return exactly(raw, ['t']) ? { t: raw.t } : null;
    case 'pair.fail': {
      const reason = FAIL_REASONS.find((r) => r === raw.reason);
      return exactly(raw, ['t', 'reason']) && reason !== undefined
        ? { t: 'pair.fail', reason }
        : null;
    }
    default:
      return null;
  }
}

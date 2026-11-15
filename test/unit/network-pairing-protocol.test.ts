import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveMachineId } from '../../src/network/identity-file';
import {
  type JoinerState,
  joinerStart,
  joinerStep,
  type OpenerContext,
  type OpenerState,
  type OwnerKeyPair,
  openerStart,
  openerStep,
  type PairingInput,
  type PairingMsg,
  type PairingOutcome,
  type PairingSelf,
  parsePairingMsg,
  shownFingerprint,
} from '../../src/network/pairing-protocol';
import { commitment, fingerprint, linkIdFor } from '../../src/network/pairing-transcript';
import { rawEd25519, selfSignedCert } from '../../src/network/self-signed-cert';

const CODE = 'apple zoo ability';

function ownerKey(): OwnerKeyPair {
  const k = generateKeyPairSync('ed25519');
  return {
    publicKey: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: k.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}
function self(name: string, owner: OwnerKeyPair | null): PairingSelf {
  const k = generateKeyPairSync('ed25519');
  const raw = rawEd25519(k.publicKey);
  const machineId = deriveMachineId(raw);
  return {
    serverKeyRaw: raw,
    machineId,
    selfName: name,
    addresses: ['127.0.0.1:47391'],
    ownerKey: owner,
    protocol: { major: 1, minor: 0 },
    cert: selfSignedCert(k, machineId),
  };
}

interface Pair {
  opener: OpenerState;
  joiner: JoinerState;
  openerDone?: PairingOutcome;
  joinerDone?: PairingOutcome;
  generated: OwnerKeyPair[];
}

function setup(
  o: {
    openerOwner?: OwnerKeyPair | null;
    joinerOwner?: OwnerKeyPair | null;
    code?: string;
    openerSelf?: PairingSelf;
    joinerSelf?: PairingSelf;
  } = {},
): { pair: Pair; first: PairingMsg[] } {
  const generated: OwnerKeyPair[] = [];
  const octx: OpenerContext = {
    self: o.openerSelf ?? self('linux-box', o.openerOwner ?? null),
    rand: (n) => randomBytes(n),
    code: CODE,
    generateOwnerKey: () => {
      const k = ownerKey();
      generated.push(k);
      return k;
    },
  };
  const start = joinerStart(
    { self: o.joinerSelf ?? self('win-box', o.joinerOwner ?? null), rand: (n) => randomBytes(n) },
    o.code ?? CODE,
  );
  return { pair: { opener: openerStart(octx), joiner: start.state, generated }, first: start.out };
}

/** Delivers messages both ways until quiet; user actions are applied by the test between runs. */
function pump(p: Pair, toOpener: PairingMsg[], toJoiner: PairingMsg[] = []): void {
  let a = toOpener;
  let b = toJoiner;
  while (a.length > 0 || b.length > 0) {
    const nextB: PairingMsg[] = [];
    const nextA: PairingMsg[] = [];
    for (const msg of a) {
      const r = openerStep(p.opener, { kind: 'msg', msg });
      nextB.push(...r.out);
      if (r.done) p.openerDone = r.done;
    }
    for (const msg of b) {
      const r = joinerStep(p.joiner, { kind: 'msg', msg });
      nextA.push(...r.out);
      if (r.done) p.joinerDone = r.done;
    }
    a = nextA;
    b = nextB;
  }
}
function act(p: Pair, who: 'opener' | 'joiner', input: PairingInput): void {
  if (who === 'opener') {
    const r = openerStep(p.opener, input);
    if (r.done) p.openerDone = r.done;
    pump(p, [], r.out);
  } else {
    const r = joinerStep(p.joiner, input);
    if (r.done) p.joinerDone = r.done;
    pump(p, r.out);
  }
}
function confirmBoth(p: Pair): void {
  act(p, 'opener', { kind: 'confirm' });
  act(p, 'joiner', { kind: 'confirm' });
}

function nth(out: PairingMsg[], i: number): PairingMsg {
  const m = out[i];
  if (m === undefined) throw new Error(`no message ${i}`);
  return m;
}

function linkedBoth(p: Pair) {
  const a = p.openerDone;
  const b = p.joinerDone;
  if (a?.kind !== 'linked' || b?.kind !== 'linked')
    throw new Error(`not linked: ${JSON.stringify([a, b])}`);
  return { a, b };
}

describe('pairing transcript', () => {
  it('fingerprint is XXXX-XXXX and depends on every input', () => {
    const k = [randomBytes(32), randomBytes(32)];
    const n = [randomBytes(32), randomBytes(32)];
    const fp = fingerprint(k[0], k[1], n[0], n[1]);
    expect(fp).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(fingerprint(k[1], k[0], n[0], n[1])).not.toBe(fp);
    expect(fingerprint(k[0], k[1], n[1], n[0])).not.toBe(fp);
  });
  it('linkIdFor is order-independent', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(linkIdFor(a, b)).toBe(linkIdFor(b, a));
    expect(linkIdFor(a, b)).toMatch(/^l_[a-z2-7]{16}$/);
  });
  it('rejects wrong-length inputs', () => {
    expect(() => commitment(Buffer.alloc(31), randomBytes(32))).toThrow();
    expect(() => commitment(randomBytes(32), Buffer.alloc(16))).toThrow();
  });
});

describe('pairing protocol', () => {
  it('links both sides with the same id, fingerprint and verified certificates', () => {
    const owner = ownerKey();
    const openerSelf = self('linux-box', owner);
    const joinerSelf = self('win-box', owner);
    const { pair, first } = setup({ openerSelf, joinerSelf });
    pump(pair, first);
    expect(shownFingerprint(pair.opener)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(shownFingerprint(pair.opener)).toBe(shownFingerprint(pair.joiner));
    act(pair, 'opener', { kind: 'confirm' });
    expect(pair.openerDone).toBeUndefined();
    act(pair, 'joiner', { kind: 'confirm' });
    const { a, b } = linkedBoth(pair);
    expect(a.linkId).toBe(b.linkId);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.peer.selfName).toBe('win-box');
    expect(b.peer.selfName).toBe('linux-box');
    expect(a.peer.serverKey).toBe(joinerSelf.serverKeyRaw.toString('base64'));
    expect(a.peer.cert).toBe(joinerSelf.cert);
    expect(b.peer.cert).toBe(openerSelf.cert);
    expect([a.ownerTransfer, b.ownerTransfer]).toEqual([null, null]);
    expect(a.ownerKeyToStore).toBeNull();
  });

  it('fails both sides on a wrong code, before any fingerprint exists', () => {
    const { pair, first } = setup({ code: 'apple zoo river' });
    pump(pair, first);
    expect(pair.openerDone).toEqual({ kind: 'failed', reason: 'wrong-code' });
    expect(pair.joinerDone).toEqual({ kind: 'failed', reason: 'wrong-code' });
    expect(shownFingerprint(pair.opener)).toBeNull();
  });

  it('a relay running two pairings (A↔M, M↔B) leaves A and B with different fingerprints', () => {
    const a = self('linux-box', null);
    const m = self('linux-box', null);
    const b = self('win-box', null);
    const left = setup({ openerSelf: a, joinerSelf: m });
    pump(left.pair, left.first);
    const right = setup({ openerSelf: m, joinerSelf: b });
    pump(right.pair, right.first);
    const seenByA = shownFingerprint(left.pair.opener);
    const seenByB = shownFingerprint(right.pair.joiner);
    expect(seenByA).not.toBeNull();
    expect(seenByB).not.toBeNull();
    expect(seenByA).not.toBe(seenByB);
  });

  it('a reveal that does not match the commitment fails', () => {
    const { pair, first } = setup();
    const nonce = openerStep(pair.opener, { kind: 'msg', msg: first[0] });
    expect(nonce.out[0]?.t).toBe('pair.nonce');
    const r = openerStep(pair.opener, {
      kind: 'msg',
      msg: { t: 'pair.reveal', nonce: randomBytes(32).toString('base64') },
    });
    expect(r.done).toEqual({ kind: 'failed', reason: 'bad-commit' });
  });

  it('a hello whose key is swapped after the commitment fails the commitment', () => {
    const { pair, first } = setup();
    const hello = first[0];
    if (hello?.t !== 'pair.hello') throw new Error('no hello');
    const swapped = { ...hello, key: randomBytes(32).toString('base64') };
    const r1 = openerStep(pair.opener, { kind: 'msg', msg: swapped });
    const r2 = joinerStep(pair.joiner, { kind: 'msg', msg: nth(r1.out, 0) });
    const r3 = openerStep(pair.opener, { kind: 'msg', msg: nth(r2.out, 0) });
    expect(r3.done).toEqual({ kind: 'failed', reason: 'bad-commit' });
  });

  it.each([
    ['opener has K, joiner none', 'K', null, ['send', 'receive']],
    ['joiner has K, opener none', null, 'K', ['receive', 'send']],
  ] as const)('%s: the holder sends the private key over the link', (_, o, j, transfers) => {
    const k = ownerKey();
    const { pair, first } = setup({ openerOwner: o ? k : null, joinerOwner: j ? k : null });
    pump(pair, first);
    confirmBoth(pair);
    const { a, b } = linkedBoth(pair);
    expect(a.peer.ownerKey).toBe(k.publicKey);
    expect(b.peer.ownerKey).toBe(k.publicKey);
    expect([a.ownerTransfer, b.ownerTransfer]).toEqual(transfers);
    expect([a.ownerKeyToStore, b.ownerKeyToStore]).toEqual([null, null]);
  });

  it('neither has an owner key: the opener generates it, stores it, and only its public half crosses', () => {
    const { pair, first } = setup();
    pump(pair, first);
    act(pair, 'joiner', { kind: 'confirm' });
    act(pair, 'opener', { kind: 'confirm' });
    const { a, b } = linkedBoth(pair);
    expect(pair.generated).toHaveLength(1);
    const g = pair.generated[0];
    expect(a.ownerKeyToStore).toEqual(g);
    expect(b.ownerKeyToStore).toBeNull();
    expect(b.peer.ownerKey).toBe(g?.publicKey);
    expect([a.ownerTransfer, b.ownerTransfer]).toEqual(['send', 'receive']);
  });

  it('different owner keys refuse before anyone confirms', () => {
    const { pair, first } = setup({ openerOwner: ownerKey(), joinerOwner: ownerKey() });
    pump(pair, first);
    expect(pair.openerDone).toEqual({ kind: 'failed', reason: 'different-owner' });
    expect(pair.joinerDone).toEqual({ kind: 'failed', reason: 'different-owner' });
  });

  it.each(['opener', 'joiner'] as const)('a decline by the %s ends both as declined', (who) => {
    const { pair, first } = setup();
    pump(pair, first);
    act(pair, who, { kind: 'decline' });
    expect(pair.openerDone).toEqual({ kind: 'failed', reason: 'declined' });
    expect(pair.joinerDone).toEqual({ kind: 'failed', reason: 'declined' });
  });

  it('expiry while waiting for the joiner fails the window', () => {
    const { pair } = setup();
    expect(openerStep(pair.opener, { kind: 'expire' }).done).toEqual({
      kind: 'failed',
      reason: 'expired',
    });
  });

  it('an out-of-order message fails with protocol', () => {
    const { pair } = setup();
    const r = openerStep(pair.opener, { kind: 'msg', msg: { t: 'pair.accept' } });
    expect(r.done).toEqual({ kind: 'failed', reason: 'protocol' });
    expect(r.out).toEqual([{ t: 'pair.fail', reason: 'protocol' }]);
  });

  it.each([
    ['a machine id not derived from the key', { machineId: 'm-00000000' }],
    ['a certificate for another key', { cert: self('x', null).cert }],
    ['a certificate that is not one', { cert: 'not a certificate' }],
  ])('a pair.id with %s fails', (_, patch) => {
    const { pair, first } = setup();
    const r1 = openerStep(pair.opener, { kind: 'msg', msg: nth(first, 0) });
    const r2 = joinerStep(pair.joiner, { kind: 'msg', msg: nth(r1.out, 0) });
    const reveal = nth(r2.out, 0);
    const id = nth(r2.out, 1);
    if (id.t !== 'pair.id') throw new Error('no pair.id');
    openerStep(pair.opener, { kind: 'msg', msg: reveal });
    const r3 = openerStep(pair.opener, { kind: 'msg', msg: { ...id, ...patch } });
    expect(r3.done).toEqual({ kind: 'failed', reason: 'protocol' });
  });

  it('a pair.owner when an owner key was announced fails', () => {
    const k = ownerKey();
    const { pair, first } = setup({ openerOwner: k });
    pump(pair, first);
    const r = joinerStep(pair.joiner, {
      kind: 'msg',
      msg: { t: 'pair.owner', publicKey: k.publicKey },
    });
    expect(r.done).toEqual({ kind: 'failed', reason: 'protocol' });
  });
});

describe('parsePairingMsg', () => {
  const samples: PairingMsg[] = [
    { t: 'pair.hello', v: 1, code: CODE, key: 'AAAA', commit: 'AAAA' },
    { t: 'pair.nonce', nonce: 'AAAA', key: 'AAAA' },
    { t: 'pair.reveal', nonce: 'AAAA' },
    {
      t: 'pair.id',
      machineId: 'm-00000000',
      ownerKey: null,
      ownerOffer: null,
      selfName: 'x',
      addresses: ['127.0.0.1:1'],
      protocol: { major: 1, minor: 0 },
      cert: 'PEM',
    },
    { t: 'pair.accept' },
    { t: 'pair.decline' },
    { t: 'pair.owner', publicKey: 'a' },
    { t: 'pair.fail', reason: 'used' },
  ];
  it.each(samples)('round-trips $t', (m) => {
    expect(parsePairingMsg(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });
  it.each(samples)('rejects $t with an extra key', (m) => {
    expect(parsePairingMsg({ ...m, extra: 1 })).toBeNull();
  });
  it('rejects unknown types, bad fields, a private key and unknown fail reasons', () => {
    expect(parsePairingMsg({ t: 'pair.nope' })).toBeNull();
    expect(
      parsePairingMsg({ t: 'pair.hello', v: '1', code: CODE, key: 'A', commit: 'A' }),
    ).toBeNull();
    expect(parsePairingMsg({ t: 'pair.owner', publicKey: 'a', privateKey: 'b' })).toBeNull();
    expect(parsePairingMsg({ t: 'pair.fail', reason: 'whatever' })).toBeNull();
    expect(
      parsePairingMsg({ t: 'pair.hello', v: 1, code: 'x'.repeat(201), key: 'A', commit: 'A' }),
    ).toBeNull();
    expect(parsePairingMsg(null)).toBeNull();
  });
});

// CON-27 security review minor 1: an on-path relay must not be able to change what either side
// learns (names, addresses, owner key) without the two shown fingerprints differing.
describe('the fingerprint binds both identities and the owner key', () => {
  type Rewrite = (msg: PairingMsg, to: 'opener' | 'joiner') => PairingMsg;
  function relay(
    p: Pair,
    toOpener: PairingMsg[],
    rewrite: Rewrite,
    toJoiner: PairingMsg[] = [],
  ): PairingMsg[] {
    const seen: PairingMsg[] = [];
    let a = toOpener;
    let b = toJoiner;
    while (a.length > 0 || b.length > 0) {
      const nextA: PairingMsg[] = [];
      const nextB: PairingMsg[] = [];
      for (const m of a) {
        seen.push(m);
        const r = openerStep(p.opener, { kind: 'msg', msg: rewrite(m, 'opener') });
        nextB.push(...r.out);
        if (r.done) p.openerDone = r.done;
      }
      for (const m of b) {
        seen.push(m);
        const r = joinerStep(p.joiner, { kind: 'msg', msg: rewrite(m, 'joiner') });
        nextA.push(...r.out);
        if (r.done) p.joinerDone = r.done;
      }
      a = nextA;
      b = nextB;
    }
    return seen;
  }
  const shown = (p: Pair) => [shownFingerprint(p.opener), shownFingerprint(p.joiner)];

  it.each([
    [
      'the joiner’s name',
      (m: PairingMsg) => (m.t === 'pair.id' ? { ...m, selfName: 'evil-box' } : m),
    ],
    [
      'the joiner’s addresses',
      (m: PairingMsg) => (m.t === 'pair.id' ? { ...m, addresses: ['10.6.6.6:47391'] } : m),
    ],
  ])('a relay rewriting %s makes the shown fingerprints differ', (_what, change) => {
    const { pair, first } = setup();
    relay(pair, first, (m, to) => (to === 'opener' ? change(m) : m));
    const [a, b] = shown(pair);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('a relay swapping the joiner’s owner key makes the shown fingerprints differ', () => {
    const attacker = ownerKey();
    const { pair, first } = setup({ joinerOwner: ownerKey() });
    relay(pair, first, (m, to) =>
      to === 'opener' && m.t === 'pair.id' ? { ...m, ownerKey: attacker.publicKey } : m,
    );
    const [a, b] = shown(pair);
    expect(a).not.toBe(b);
  });

  it('a first-ever link settles the owner key inside the compared transcript, with no pair.owner', () => {
    const { pair, first } = setup();
    const seen = relay(pair, first, (m) => m);
    const [a, b] = shown(pair);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    const ro = openerStep(pair.opener, { kind: 'confirm' });
    if (ro.done) pair.openerDone = ro.done;
    seen.push(...ro.out, ...relay(pair, [], (m) => m, ro.out));
    const rj = joinerStep(pair.joiner, { kind: 'confirm' });
    if (rj.done) pair.joinerDone = rj.done;
    seen.push(...rj.out, ...relay(pair, rj.out, (m) => m));
    const { a: o, b: j } = linkedBoth(pair);
    expect(pair.generated).toHaveLength(1);
    expect(o.ownerKeyToStore).toEqual(pair.generated[0]);
    expect(j.peer.ownerKey).toBe(pair.generated[0]?.publicKey);
    expect(o.peer.ownerKey).toBe(pair.generated[0]?.publicKey);
    expect(seen.some((m) => (m as { t: string }).t === 'pair.owner')).toBe(false);
  });

  it('a relay swapping the opener’s offered owner key makes the shown fingerprints differ', () => {
    const attacker = ownerKey();
    const { pair, first } = setup();
    relay(pair, first, (m, to) =>
      to === 'joiner' && m.t === 'pair.id' ? { ...m, ownerOffer: attacker.publicKey } : m,
    );
    const [a, b] = shown(pair);
    expect(a).not.toBe(b);
  });

  it('a joiner offering an owner key fails: only the opener generates one', () => {
    const { pair, first } = setup();
    relay(pair, first, (m, to) =>
      to === 'opener' && m.t === 'pair.id' ? { ...m, ownerOffer: ownerKey().publicKey } : m,
    );
    expect(pair.openerDone).toEqual({ kind: 'failed', reason: 'protocol' });
  });

  it('pair.owner is no longer a message', () => {
    expect(parsePairingMsg({ t: 'pair.owner', publicKey: 'a' })).toBeNull();
  });
});

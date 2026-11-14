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
  parsePairingMsg,
  shownFingerprint,
} from '../../src/network/pairing-protocol';
import { commitment, fingerprint, linkIdFor } from '../../src/network/pairing-transcript';

const CODE = 'apple zoo ability';

function serverKey(): Buffer {
  const { x } = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  return Buffer.from(String(x), 'base64url');
}
function ownerKey(): OwnerKeyPair {
  const k = generateKeyPairSync('ed25519');
  return {
    publicKey: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: k.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}
function self(key: Buffer, name: string, owner: OwnerKeyPair | null) {
  return {
    serverKeyRaw: key,
    machineId: deriveMachineId(key),
    selfName: name,
    addresses: ['127.0.0.1:47391'],
    ownerKey: owner,
    protocol: { major: 1, minor: 0 },
  };
}

interface Pair {
  opener: OpenerState;
  joiner: JoinerState;
  openerDone?: PairingOutcome;
  joinerDone?: PairingOutcome;
  generated: OwnerKeyPair[];
}

function setup(o: {
  openerOwner?: OwnerKeyPair | null;
  joinerOwner?: OwnerKeyPair | null;
  code?: string;
  /** What the opener sees as the joiner's certificate key (a relay substitutes its own). */
  joinerKeySeenByOpener?: Buffer;
}): { pair: Pair; first: PairingMsg[] } {
  const ka = serverKey();
  const kb = serverKey();
  const generated: OwnerKeyPair[] = [];
  const octx: OpenerContext = {
    self: self(ka, 'linux-box', o.openerOwner ?? null),
    peerKeyRaw: o.joinerKeySeenByOpener ?? kb,
    rand: (n) => randomBytes(n),
    code: CODE,
    generateOwnerKey: () => {
      const k = ownerKey();
      generated.push(k);
      return k;
    },
  };
  const start = joinerStart(
    {
      self: self(kb, 'win-box', o.joinerOwner ?? null),
      peerKeyRaw: ka,
      rand: (n) => randomBytes(n),
    },
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

function linkedBoth(p: Pair) {
  const a = p.openerDone;
  const b = p.joinerDone;
  if (a?.kind !== 'linked' || b?.kind !== 'linked')
    throw new Error(`not linked: ${JSON.stringify([a, b])}`);
  return { a, b };
}

describe('pairing transcript', () => {
  it('fingerprint is XXXX-XXXX and depends on every input', () => {
    const k = [serverKey(), serverKey()];
    const n = [randomBytes(32), randomBytes(32)];
    const fp = fingerprint(k[0], k[1], n[0], n[1]);
    expect(fp).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(fingerprint(k[1], k[0], n[0], n[1])).not.toBe(fp);
    expect(fingerprint(k[0], k[1], n[1], n[0])).not.toBe(fp);
  });
  it('linkIdFor is order-independent', () => {
    const a = serverKey();
    const b = serverKey();
    expect(linkIdFor(a, b)).toBe(linkIdFor(b, a));
    expect(linkIdFor(a, b)).toMatch(/^l_[a-z2-7]{16}$/);
  });
  it('rejects wrong-length inputs', () => {
    expect(() => commitment(Buffer.alloc(31), randomBytes(32))).toThrow();
    expect(() => commitment(serverKey(), Buffer.alloc(16))).toThrow();
  });
});

describe('pairing protocol', () => {
  it('links both sides with the same id and fingerprint after both confirm', () => {
    const owner = ownerKey();
    const { pair, first } = setup({ openerOwner: owner, joinerOwner: owner });
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
    expect(a.peer.machineId).toBe(deriveMachineId(Buffer.from(a.peer.serverKey, 'base64')));
    expect(a.ownerKeyToStore).toBeNull();
    expect(b.ownerKeyToStore).toBeNull();
  });

  it('fails both sides on a wrong code, before any fingerprint exists', () => {
    const { pair, first } = setup({ code: 'apple zoo river' });
    pump(pair, first);
    expect(pair.openerDone).toEqual({ kind: 'failed', reason: 'wrong-code' });
    expect(pair.joinerDone).toEqual({ kind: 'failed', reason: 'wrong-code' });
    expect(shownFingerprint(pair.opener)).toBeNull();
  });

  it('a relay that re-terminates TLS with its own key fails the commitment', () => {
    const { pair, first } = setup({ joinerKeySeenByOpener: serverKey() });
    pump(pair, first);
    expect(pair.openerDone).toEqual({ kind: 'failed', reason: 'bad-commit' });
    expect(pair.joinerDone).toEqual({ kind: 'failed', reason: 'bad-commit' });
  });

  it('a reveal that does not match the commitment fails', () => {
    const { pair, first } = setup({});
    const nonce = openerStep(pair.opener, { kind: 'msg', msg: first[0] });
    expect(nonce.out[0]?.t).toBe('pair.nonce');
    const r = openerStep(pair.opener, {
      kind: 'msg',
      msg: { t: 'pair.reveal', nonce: randomBytes(32).toString('base64') },
    });
    expect(r.done).toEqual({ kind: 'failed', reason: 'bad-commit' });
  });

  it.each([
    ['opener has K, joiner none: opener sends it', 'K', null, 'joiner'],
    ['joiner has K, opener none: joiner sends it', null, 'K', 'opener'],
  ] as const)('%s', (_, o, j, receiver) => {
    const k = ownerKey();
    const { pair, first } = setup({
      openerOwner: o ? k : null,
      joinerOwner: j ? k : null,
    });
    pump(pair, first);
    act(pair, 'opener', { kind: 'confirm' });
    act(pair, 'joiner', { kind: 'confirm' });
    const { a, b } = linkedBoth(pair);
    expect(a.peer.ownerKey).toBe(k.publicKey);
    expect(b.peer.ownerKey).toBe(k.publicKey);
    const got = receiver === 'joiner' ? b : a;
    const sender = receiver === 'joiner' ? a : b;
    expect(got.ownerKeyToStore).toEqual(k);
    expect(sender.ownerKeyToStore).toBeNull();
  });

  it('neither has an owner key: the opener generates one and both store it', () => {
    const { pair, first } = setup({});
    pump(pair, first);
    act(pair, 'joiner', { kind: 'confirm' });
    act(pair, 'opener', { kind: 'confirm' });
    const { a, b } = linkedBoth(pair);
    expect(pair.generated).toHaveLength(1);
    expect(a.ownerKeyToStore).toEqual(pair.generated[0]);
    expect(b.ownerKeyToStore).toEqual(pair.generated[0]);
  });

  it('different owner keys refuse before anyone confirms', () => {
    const { pair, first } = setup({ openerOwner: ownerKey(), joinerOwner: ownerKey() });
    pump(pair, first);
    expect(pair.openerDone).toEqual({ kind: 'failed', reason: 'different-owner' });
    expect(pair.joinerDone).toEqual({ kind: 'failed', reason: 'different-owner' });
  });

  it.each(['opener', 'joiner'] as const)('a decline by the %s ends both as declined', (who) => {
    const { pair, first } = setup({});
    pump(pair, first);
    act(pair, who, { kind: 'decline' });
    expect(pair.openerDone).toEqual({ kind: 'failed', reason: 'declined' });
    expect(pair.joinerDone).toEqual({ kind: 'failed', reason: 'declined' });
  });

  it('expiry while waiting for the joiner fails the window', () => {
    const { pair } = setup({});
    expect(openerStep(pair.opener, { kind: 'expire' }).done).toEqual({
      kind: 'failed',
      reason: 'expired',
    });
  });

  it('an out-of-order message fails with protocol', () => {
    const { pair } = setup({});
    const r = openerStep(pair.opener, { kind: 'msg', msg: { t: 'pair.accept' } });
    expect(r.done).toEqual({ kind: 'failed', reason: 'protocol' });
    expect(r.out).toEqual([{ t: 'pair.fail', reason: 'protocol' }]);
  });

  it('a pair.id whose machine id is not derived from the certificate key fails', () => {
    const { pair, first } = setup({});
    const r1 = openerStep(pair.opener, { kind: 'msg', msg: first[0] });
    const r2 = joinerStep(pair.joiner, { kind: 'msg', msg: r1.out[0] });
    const reveal = r2.out[0];
    const forged = {
      ...(r2.out[1] as Extract<PairingMsg, { t: 'pair.id' }>),
      machineId: 'm-00000000',
    };
    openerStep(pair.opener, { kind: 'msg', msg: reveal });
    const r3 = openerStep(pair.opener, { kind: 'msg', msg: forged });
    expect(r3.done).toEqual({ kind: 'failed', reason: 'protocol' });
  });

  it('a handed-over owner key must match the one announced', () => {
    const k = ownerKey();
    const { pair, first } = setup({ openerOwner: k });
    pump(pair, first);
    act(pair, 'opener', { kind: 'confirm' });
    const accept = joinerStep(pair.joiner, { kind: 'confirm' });
    expect(accept.out).toEqual([{ t: 'pair.accept' }]);
    const other = ownerKey();
    const r = joinerStep(pair.joiner, { kind: 'msg', msg: { t: 'pair.owner', ...other } });
    expect(r.done).toEqual({ kind: 'failed', reason: 'protocol' });
  });
});

describe('parsePairingMsg', () => {
  const samples: PairingMsg[] = [
    { t: 'pair.hello', v: 1, code: CODE, commit: 'AAAA' },
    { t: 'pair.nonce', nonce: 'AAAA' },
    { t: 'pair.reveal', nonce: 'AAAA' },
    {
      t: 'pair.id',
      machineId: 'm-00000000',
      ownerKey: null,
      selfName: 'x',
      addresses: ['127.0.0.1:1'],
      protocol: { major: 1, minor: 0 },
    },
    { t: 'pair.accept' },
    { t: 'pair.decline' },
    { t: 'pair.owner', publicKey: 'a', privateKey: 'b' },
    { t: 'pair.fail', reason: 'used' },
  ];
  it.each(samples)('round-trips $t', (m) => {
    expect(parsePairingMsg(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });
  it.each(samples)('rejects $t with an extra key', (m) => {
    expect(parsePairingMsg({ ...m, extra: 1 })).toBeNull();
  });
  it('rejects unknown types, bad fields and unknown fail reasons', () => {
    expect(parsePairingMsg({ t: 'pair.nope' })).toBeNull();
    expect(parsePairingMsg({ t: 'pair.hello', v: '1', code: CODE, commit: 'A' })).toBeNull();
    expect(parsePairingMsg({ t: 'pair.fail', reason: 'whatever' })).toBeNull();
    expect(
      parsePairingMsg({ t: 'pair.hello', v: 1, code: 'x'.repeat(201), commit: 'A' }),
    ).toBeNull();
    expect(parsePairingMsg(null)).toBeNull();
  });
});

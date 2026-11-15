import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { deriveMachineId } from '../../src/network/identity-file';
import {
  joinerStart,
  joinerStep,
  type OwnerKeyPair,
  openerStart,
  openerStep,
  type PairingIdentity,
  type PairingMsg,
  type PairingSelf,
  shownFingerprint,
} from '../../src/network/pairing-protocol';
import { fingerprint, identityDigest } from '../../src/network/pairing-transcript';
import { rawEd25519, selfSignedCert } from '../../src/network/self-signed-cert';

// CON-27 re-review R1, the reviewer's proof of concept: a man in the middle who learns every
// nonce before it must fix its identity can grind an unshown field until both screens match.
// This must fail closed.

const CODE = 'apple zoo ability';
const ok = generateKeyPairSync('ed25519');
const owner: OwnerKeyPair = {
  publicKey: ok.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  privateKey: ok.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
};
function self(name: string): PairingSelf {
  const k = generateKeyPairSync('ed25519');
  const raw = rawEd25519(k.publicKey);
  const id = deriveMachineId(raw);
  return {
    serverKeyRaw: raw,
    machineId: id,
    selfName: name,
    addresses: ['10.0.0.1:47391'],
    ownerKey: owner,
    protocol: { major: 1, minor: 0 },
    cert: selfSignedCert(k, id),
  };
}
const b = (s: string) => Buffer.from(s, 'base64');
function one<T extends PairingMsg['t']>(out: PairingMsg[], t: T): Extract<PairingMsg, { t: T }> {
  const m = out.find((x) => x.t === t);
  if (!m) throw new Error(`no ${t}`);
  return m as Extract<PairingMsg, { t: T }>;
}

it('a relay cannot grind identity fields until both fingerprints match', () => {
  const sO = self('linux-box');
  const sJ = self('win-box');
  const sM1 = self('win-box');
  const sM2 = self('linux-box');
  const gen = () => {
    throw new Error('unused');
  };
  const O = openerStart({ self: sO, rand: randomBytes, code: CODE, generateOwnerKey: gen });
  const J0 = joinerStart({ self: sJ, rand: randomBytes }, CODE);
  const J = J0.state;
  const helloJ = one(J0.out, 'pair.hello');
  // M as joiner toward O: its identity is fixed by its commitment before O's nonce exists.
  const Mj0 = joinerStart({ self: sM1, rand: randomBytes }, CODE);
  const Mj = Mj0.state;
  const nonceO = one(
    openerStep(O, { kind: 'msg', msg: one(Mj0.out, 'pair.hello') }).out,
    'pair.nonce',
  );
  const revealM1 = one(joinerStep(Mj, { kind: 'msg', msg: nonceO }).out, 'pair.reveal');
  const fpO = shownFingerprint(Mj);
  // M as opener toward J: its identity goes out with its nonce, before J reveals anything.
  const Mo = openerStart({
    self: sM2,
    rand: randomBytes,
    code: helloJ.code,
    generateOwnerKey: gen,
  });
  const nonceToJ = one(openerStep(Mo, { kind: 'msg', msg: helloJ }).out, 'pair.nonce');
  const revealJ = one(joinerStep(J, { kind: 'msg', msg: nonceToJ }).out, 'pair.reveal');
  const fpJ = shownFingerprint(J);
  expect(fpO).not.toBeNull();
  expect(fpJ).not.toBeNull();

  // Now M knows every nonce. Grinding its identity toward J needs J to take a new one: refused.
  const nJ = b(revealJ.nonce);
  const dJ = identityDigest(revealJ.id);
  let ground: PairingIdentity | null = null;
  for (let i = 0; i < 1 << 16 && !ground; i++) {
    const candidate = { ...nonceToJ.id, addresses: [`10.0.0.1:${i}`] };
    if (
      fingerprint(
        sM2.serverKeyRaw,
        sJ.serverKeyRaw,
        b(nonceToJ.nonce),
        nJ,
        identityDigest(candidate),
        dJ,
      ) === fpO
    )
      ground = candidate;
  }
  const late = joinerStep(J, {
    kind: 'msg',
    msg: { ...nonceToJ, id: ground ?? { ...nonceToJ.id, addresses: ['10.0.0.1:1'] } },
  });
  expect(late.done).toEqual({ kind: 'failed', reason: 'protocol' });

  // Grinding its identity toward O changes what it committed to: the commitment fails.
  const altered = openerStep(O, {
    kind: 'msg',
    msg: { ...revealM1, id: { ...revealM1.id, addresses: ['10.0.0.1:2'] } },
  });
  expect(altered.done).toEqual({ kind: 'failed', reason: 'bad-commit' });

  // Relaying honestly instead leaves two independent 32-bit codes on the two screens.
  expect(fpO).not.toBe(fpJ);
}, 60_000);

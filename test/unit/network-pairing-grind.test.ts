import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { deriveMachineId } from '../../src/network/identity-file';
import {
  joinerStart,
  joinerStep,
  type OwnerKeyPair,
  openerStart,
  openerStep,
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

it('a relay cannot grind pair.id fields until both fingerprints match', () => {
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
  const hello = one(J0.out, 'pair.hello');
  const Mo = openerStart({ self: sM2, rand: randomBytes, code: hello.code, generateOwnerKey: gen });
  const nonceToJ = one(openerStep(Mo, { kind: 'msg', msg: hello }).out, 'pair.nonce');
  const Mj0 = joinerStart({ self: sM1, rand: randomBytes }, CODE);
  const Mj = Mj0.state;
  const nonceO = one(
    openerStep(O, { kind: 'msg', msg: one(Mj0.out, 'pair.hello') }).out,
    'pair.nonce',
  );
  const mjOut = joinerStep(Mj, { kind: 'msg', msg: nonceO }).out;
  const idO = one(openerStep(O, { kind: 'msg', msg: one(mjOut, 'pair.reveal') }).out, 'pair.id');
  const jOut = joinerStep(J, { kind: 'msg', msg: nonceToJ }).out;
  const revealJ = one(jOut, 'pair.reveal');
  const idJ = one(jOut, 'pair.id');
  const idM2base = one(openerStep(Mo, { kind: 'msg', msg: revealJ }).out, 'pair.id');
  const idM1base = one(mjOut, 'pair.id');
  const nO = b(nonceO.nonce);
  const nM1 = Mj.nonceJoiner as Buffer;
  const nM2 = Mo.nonceOpener as Buffer;
  const nJ = b(revealJ.nonce);
  const dO = identityDigest(idO);
  const dJ = identityDigest(idJ);
  const fpO = (i: number) =>
    fingerprint(
      sO.serverKeyRaw,
      sM1.serverKeyRaw,
      nO,
      nM1,
      dO,
      identityDigest({ ...idM1base, addresses: [`10.0.0.1:${i}`] }),
    );
  const fpJ = (i: number) =>
    fingerprint(
      sM2.serverKeyRaw,
      sJ.serverKeyRaw,
      nM2,
      nJ,
      identityDigest({ ...idM2base, addresses: [`10.0.0.1:${i}`] }),
      dJ,
    );
  const seen = new Map<string, number>();
  let hit: [number, number] | null = null;
  for (let i = 0; i < 1 << 18; i++) seen.set(fpO(i), i);
  for (let j = 0; j < 1 << 20 && !hit; j++) {
    const k = seen.get(fpJ(j));
    if (k !== undefined) hit = [k, j];
  }
  if (hit) {
    const [i, j] = hit;
    openerStep(O, { kind: 'msg', msg: { ...idM1base, addresses: [`10.0.0.1:${i}`] } });
    joinerStep(J, { kind: 'msg', msg: { ...idM2base, addresses: [`10.0.0.1:${j}`] } });
  }
  const shownO = shownFingerprint(O);
  expect(shownO === null || shownO !== shownFingerprint(J)).toBe(true);
}, 60_000);

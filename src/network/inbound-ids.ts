import { createHash } from 'node:crypto';

// Message and thread ids that arrive over a link are a peer's choice. They never enter the local
// id namespace as they are: a peer must not collide with a local message (and have it acked as
// delivered and dropped), nor join a local thread it was never part of, nor smuggle text into
// the provenance frame. CON-27 security review B1.

/** The only shape a local or wire message/thread id may take: 'm_' / 't_' + 16 base32 chars. */
export const ID_FORMAT = /^[mt]_[a-z2-7]{16}$/;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** The first 16 base32 chars of a domain-separated hash, so a peer can't aim at a chosen id. */
function derive(prefix: 'm' | 't', origin: string, wireId: string): string {
  const digest = createHash('sha256')
    .update(`conduit-inbound-v1\0${prefix}\0${origin}\0${wireId}`)
    .digest();
  let out = '';
  for (let i = 0; out.length < 16; i++) out += BASE32[(digest[i] ?? 0) & 31];
  return `${prefix}_${out}`;
}

export const isWireMessageId = (id: string): boolean => ID_FORMAT.test(id) && id.startsWith('m_');
export const isWireThreadId = (id: string): boolean => ID_FORMAT.test(id) && id.startsWith('t_');

/** The local id of a message `origin` sent with id `wireId`. Deterministic, so a resend dedupes. */
export function inboundMessageId(origin: string, wireId: string): string {
  return derive('m', origin, wireId);
}

/**
 * The local thread for a thread id `origin` sent. It joins a local thread only when that thread
 * already went to `origin` (a reply to something we sent there); any other id gets a thread of
 * its own, derived per origin.
 */
export function inboundThreadId(
  origin: string,
  wireThreadId: string,
  exportedTo: (threadId: string, machineId: string) => boolean,
): string {
  if (exportedTo(wireThreadId, origin)) return wireThreadId;
  return derive('t', origin, wireThreadId);
}

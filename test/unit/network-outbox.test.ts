import { describe, expect, it } from 'vitest';
import { OUTBOX_TTL_MS, type WireMessage } from '../../src/contracts/link-protocol';
import {
  createOutbox,
  type OutboxEntry,
  parseOutboxFile,
  serializeOutboxFile,
} from '../../src/network/outbox';

const NOW = Date.parse('2026-11-14T00:00:00.000Z');
const A = 'm-0000000a';
const B = 'm-0000000b';

const message = (messageId: string): WireMessage => ({
  messageId,
  threadId: 't-1',
  from: 'ada@m-0000000a',
  to: ['grace'],
  subject: 'hello',
  kind: 'inform',
  priority: 'normal',
  sentAt: '2026-11-14T00:00:00.000Z',
  body: 'body',
  attachments: [{ name: 'a.txt', mime: 'text/plain', data: 'aGk=' }],
});

const entry = (
  machineId: string,
  messageId: string,
  enqueuedAt = NOW,
): Omit<OutboxEntry, 'state'> => ({
  machineId,
  message: message(messageId),
  addresses: ['grace@m-0000000b'],
  enqueuedAt,
});

const ids = (list: OutboxEntry[]) => list.map((e) => e.message.messageId);

describe('outbox model', () => {
  it('keeps FIFO order per machine across interleaved machines', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'a1'));
    outbox.enqueue(entry(B, 'b1'));
    outbox.enqueue(entry(A, 'a2'));
    outbox.enqueue(entry(B, 'b2'));
    outbox.enqueue(entry(A, 'a3'));

    expect(ids(outbox.batchFor(A))).toEqual(['a1', 'a2', 'a3']);
    expect(ids(outbox.batchFor(B))).toEqual(['b1', 'b2']);
  });

  it('ignores a duplicate message id for the same machine', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'a1'));
    outbox.enqueue(entry(A, 'a1', NOW + 5));

    expect(outbox.entries()).toHaveLength(1);
    expect(outbox.entries()[0].enqueuedAt).toBe(NOW);
  });

  it('accepts the same message id for a different machine', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'x'));
    outbox.enqueue(entry(B, 'x'));

    expect(outbox.pending(A)).toBe(1);
    expect(outbox.pending(B)).toBe(1);
  });

  it('batchFor marks entries sent and a second batch returns nothing new', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'a1'));
    outbox.enqueue(entry(A, 'a2'));

    const first = outbox.batchFor(A);
    expect(first.every((e) => e.state === 'sent')).toBe(true);
    expect(outbox.batchFor(A)).toEqual([]);
    expect(outbox.entries().map((e) => e.state)).toEqual(['sent', 'sent']);
  });

  it('batchFor returns copies, not the stored entries', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'a1'));
    const [copy] = outbox.batchFor(A);
    copy.addresses.push('mutated');
    copy.message.to.push('mutated');

    expect(outbox.entries()[0].addresses).toEqual(['grace@m-0000000b']);
    expect(outbox.entries()[0].message.to).toEqual(['grace']);
  });

  it('onDown requeues sent entries in their original order', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'a1'));
    outbox.enqueue(entry(B, 'b1'));
    outbox.enqueue(entry(A, 'a2'));
    outbox.batchFor(A);
    outbox.batchFor(B);

    outbox.onDown(A);

    expect(outbox.entries().map((e) => [e.message.messageId, e.state])).toEqual([
      ['a1', 'queued'],
      ['b1', 'sent'],
      ['a2', 'queued'],
    ]);
    expect(ids(outbox.batchFor(A))).toEqual(['a1', 'a2']);
  });

  it('ack of an unknown id returns null and removes nothing', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'a1'));

    expect(outbox.ack(A, 'nope')).toBeNull();
    expect(outbox.ack(B, 'a1')).toBeNull();
    expect(outbox.pending(A)).toBe(1);
  });

  it('ack of a known id removes it and returns it', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'a1'));
    outbox.enqueue(entry(A, 'a2'));
    outbox.batchFor(A);

    const acked = outbox.ack(A, 'a1');
    expect(acked?.message.messageId).toBe('a1');
    expect(acked?.state).toBe('sent');
    expect(ids(outbox.entries())).toEqual(['a2']);
    expect(outbox.ack(A, 'a1')).toBeNull();
  });

  it('expires an entry at exactly the TTL and keeps one 1 ms younger', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'edge', NOW - OUTBOX_TTL_MS));
    outbox.enqueue(entry(A, 'young', NOW - OUTBOX_TTL_MS + 1));

    expect(ids(outbox.expire(NOW))).toEqual(['edge']);
    expect(ids(outbox.entries())).toEqual(['young']);
  });

  it('expire removes sent entries too', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'a1', NOW - OUTBOX_TTL_MS));
    outbox.batchFor(A);

    expect(ids(outbox.expire(NOW))).toEqual(['a1']);
    expect(outbox.pending(A)).toBe(0);
  });

  it('revoke returns and removes only that machine', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'a1'));
    outbox.enqueue(entry(B, 'b1'));
    outbox.enqueue(entry(A, 'a2'));
    outbox.batchFor(A);

    expect(ids(outbox.revoke(A))).toEqual(['a1', 'a2']);
    expect(ids(outbox.entries())).toEqual(['b1']);
    expect(outbox.revoke(A)).toEqual([]);
  });

  it('createOutbox turns persisted sent entries into queued ones', () => {
    const outbox = createOutbox([
      { ...entry(A, 'a1'), state: 'sent' },
      { ...entry(A, 'a2'), state: 'queued' },
    ]);

    expect(outbox.entries().map((e) => e.state)).toEqual(['queued', 'queued']);
    expect(ids(outbox.batchFor(A))).toEqual(['a1', 'a2']);
  });

  it('pending counts unacked entries for one machine', () => {
    const outbox = createOutbox([]);
    outbox.enqueue(entry(A, 'a1'));
    outbox.enqueue(entry(B, 'b1'));
    outbox.batchFor(A);

    expect(outbox.pending(A)).toBe(1);
    expect(outbox.pending(B)).toBe(1);
    expect(outbox.pending(A)).toBe(outbox.entries().filter((e) => e.machineId === A).length);
  });
});

describe('outbox file', () => {
  const sample: OutboxEntry[] = [
    { ...entry(A, 'a1'), state: 'queued' },
    { ...entry(B, 'b1', NOW + 1), state: 'sent' },
  ];

  it('round-trips entries', () => {
    expect(parseOutboxFile(serializeOutboxFile(sample))).toEqual({ kind: 'ok', entries: sample });
  });

  it('serializes as versioned JSON with a trailing newline', () => {
    expect(serializeOutboxFile(sample)).toBe(
      `${JSON.stringify({ version: 2, entries: sample })}\n`,
    );
  });

  it('loads entries without attachment references from version 1', () => {
    expect(parseOutboxFile(JSON.stringify({ version: 1, entries: sample }))).toEqual({
      kind: 'ok',
      entries: sample,
    });
  });

  it('a newer version is newer', () => {
    expect(parseOutboxFile(JSON.stringify({ version: 3, entries: sample }))).toEqual({
      kind: 'newer',
    });
  });

  it.each([
    ['bad JSON', '{not json'],
    ['non-object root', '[]'],
    ['version 0', JSON.stringify({ version: 0, entries: [] })],
    ['string version', JSON.stringify({ version: '1', entries: [] })],
    ['missing version', JSON.stringify({ entries: [] })],
    ['missing entries', JSON.stringify({ version: 1 })],
    [
      'bad machineId',
      JSON.stringify({ version: 1, entries: [{ ...sample[0], machineId: 'm-XYZ' }] }),
    ],
    [
      'missing body',
      JSON.stringify({
        version: 1,
        entries: [{ ...sample[0], message: { ...sample[0].message, body: undefined } }],
      }),
    ],
    [
      'unknown kind',
      JSON.stringify({
        version: 1,
        entries: [{ ...sample[0], message: { ...sample[0].message, kind: 'shout' } }],
      }),
    ],
    [
      'attachment without data',
      JSON.stringify({
        version: 1,
        entries: [
          {
            ...sample[0],
            message: { ...sample[0].message, attachments: [{ name: 'a', mime: 'x/y' }] },
          },
        ],
      }),
    ],
    [
      'address not a string',
      JSON.stringify({ version: 1, entries: [{ ...sample[0], addresses: [42] }] }),
    ],
    [
      'enqueuedAt not finite',
      JSON.stringify({ version: 1, entries: [{ ...sample[0], enqueuedAt: 'soon' }] }),
    ],
    ['unknown state', JSON.stringify({ version: 1, entries: [{ ...sample[0], state: 'acked' }] })],
  ])('%s is corrupt', (_name, text) => {
    expect(parseOutboxFile(text)).toEqual({ kind: 'corrupt' });
  });

  it('one malformed entry makes the whole file corrupt', () => {
    const text = JSON.stringify({
      version: 1,
      entries: [sample[0], { ...sample[1], machineId: 'bogus' }],
    });
    expect(parseOutboxFile(text)).toEqual({ kind: 'corrupt' });
  });
});

// CON-27 review, minor 6: the caps are 1,000 entries and 64 MiB in total, serialized.
describe('outbox caps', () => {
  const MAX_ENTRIES = 1000;
  const big = (messageId: string, bodyBytes: number) => ({
    ...entry(A, messageId),
    message: { ...message(messageId), body: 'x'.repeat(bodyBytes) },
  });

  it('refuses the 1,001st entry, and stores nothing for it', () => {
    const outbox = createOutbox([]);
    for (let i = 0; i < MAX_ENTRIES; i++) expect(outbox.enqueue(entry(A, `m_${i}`))).toBe(true);
    expect(outbox.enqueue(entry(A, 'm_over'))).toBe(false);
    expect(outbox.entries()).toHaveLength(MAX_ENTRIES);
  });

  it('refuses an entry that would take the outbox past 64 MiB in total', () => {
    const outbox = createOutbox([]);
    const fourMiB = 4 * 1024 * 1024;
    for (let i = 0; i < 15; i++) expect(outbox.enqueue(big(`m_${i}`, fourMiB))).toBe(true);
    expect(outbox.enqueue(big('m_15', fourMiB))).toBe(false);
    expect(outbox.entries()).toHaveLength(15);
  });

  it('an ack frees room under both caps', () => {
    const outbox = createOutbox([]);
    for (let i = 0; i < MAX_ENTRIES; i++) outbox.enqueue(entry(A, `m_${i}`));
    expect(outbox.enqueue(entry(A, 'm_over'))).toBe(false);
    outbox.ack(A, 'm_0');
    expect(outbox.enqueue(entry(A, 'm_over'))).toBe(true);
  });
});

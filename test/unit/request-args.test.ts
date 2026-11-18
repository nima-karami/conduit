import { describe, expect, it } from 'vitest';
import {
  BODY_MAX_BYTES,
  type CreateInput,
  contentKeyOf,
  DRAFT_MAX_BYTES,
  EXPIRES_MAX_MS,
  parseExpiresIn,
  parseListRequests,
  parseRequestInput,
  parseWaitRequest,
  parseWithdrawRequest,
  REASON_MAX,
  TEXT_MAX_BYTES,
  TITLE_MAX,
  validateAnswer,
  WITHDRAW_REASON_MAX,
} from '../../src/conduit-mcp/request-args';
import type { RequestRecord } from '../../src/conduit-mcp/request-types';
import type { Result } from '../../src/conduit-mcp/types';

const OPTIONS = [{ label: 'Yes' }, { label: 'No', description: 'keep it' }];

function codeOf(r: Result<unknown>): string | null {
  return r.ok ? null : r.error.code;
}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function rec(
  kind: RequestRecord['kind'],
  source: RequestRecord['source'],
  options: RequestRecord['options'] = [],
  multi = false,
): Pick<RequestRecord, 'kind' | 'source' | 'options' | 'multi'> {
  return { kind, source, options, multi };
}

function input(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    kind: 'confirm',
    title: 'Ship it?',
    body: '',
    options: [],
    multi: false,
    draft: null,
    thread: null,
    priority: 'normal',
    expiresInMs: null,
    default: null,
    replaces: null,
    waitS: null,
    ...overrides,
  };
}

describe('parseRequestInput', () => {
  it('rejects a default without expires_in', () => {
    const r = parseRequestInput({
      kind: 'confirm',
      title: 'Ship it?',
      default: { outcome: 'approved' },
    });
    expect(codeOf(r)).toBe('invalid_args');
    expect(r.ok ? '' : r.error.message).toContain('a default needs expires_in');
  });

  it('rejects a 201-char title', () => {
    const r = parseRequestInput({ kind: 'confirm', title: 'x'.repeat(TITLE_MAX + 1) });
    expect(codeOf(r)).toBe('too_large');
  });

  it('accepts a title of exactly TITLE_MAX chars', () => {
    const r = parseRequestInput({ kind: 'confirm', title: 'x'.repeat(TITLE_MAX) });
    expect(r.ok).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(codeOf(parseRequestInput({ kind: 'confirm', title: '' }))).toBe('invalid_args');
  });

  it('rejects a missing title', () => {
    expect(codeOf(parseRequestInput({ kind: 'confirm' }))).toBe('invalid_args');
  });

  it('rejects a body over BODY_MAX_BYTES counted in UTF-8 bytes', () => {
    const justOver = 'é'.repeat(BODY_MAX_BYTES / 2 + 1);
    expect(codeOf(parseRequestInput({ kind: 'confirm', title: 't', body: justOver }))).toBe(
      'too_large',
    );
    const exact = 'é'.repeat(BODY_MAX_BYTES / 2);
    expect(parseRequestInput({ kind: 'confirm', title: 't', body: exact }).ok).toBe(true);
  });

  it('defaults body to empty, multi to false and priority to normal', () => {
    const i = unwrap(parseRequestInput({ kind: 'confirm', title: 'Ship it?' }));
    expect(i).toEqual(input());
  });

  it('choose needs 2–8 options', () => {
    expect(codeOf(parseRequestInput({ kind: 'choose', title: 't' }))).toBe('invalid_args');
    expect(
      codeOf(parseRequestInput({ kind: 'choose', title: 't', options: [{ label: 'A' }] })),
    ).toBe('invalid_args');
    const two = parseRequestInput({ kind: 'choose', title: 't', options: OPTIONS });
    expect(unwrap(two).options).toEqual(OPTIONS);
    const eight = Array.from({ length: 8 }, (_, n) => ({ label: `o${n}` }));
    expect(parseRequestInput({ kind: 'choose', title: 't', options: eight }).ok).toBe(true);
    const nine = Array.from({ length: 9 }, (_, n) => ({ label: `o${n}` }));
    expect(codeOf(parseRequestInput({ kind: 'choose', title: 't', options: nine }))).toBe(
      'too_large',
    );
  });

  it('rejects options on a non-choose kind', () => {
    expect(codeOf(parseRequestInput({ kind: 'text', title: 't', options: [{ label: 'A' }] }))).toBe(
      'invalid_args',
    );
  });

  it('rejects duplicate option labels', () => {
    const r = parseRequestInput({
      kind: 'choose',
      title: 't',
      options: [{ label: 'A' }, { label: 'A' }],
    });
    expect(codeOf(r)).toBe('invalid_args');
  });

  it('rejects an option label over OPTION_LABEL_MAX and a description over OPTION_DESC_MAX', () => {
    const longLabel = parseRequestInput({
      kind: 'choose',
      title: 't',
      options: [{ label: 'x'.repeat(101) }, { label: 'B' }],
    });
    expect(codeOf(longLabel)).toBe('too_large');
    const longDesc = parseRequestInput({
      kind: 'choose',
      title: 't',
      options: [{ label: 'A', description: 'x'.repeat(301) }, { label: 'B' }],
    });
    expect(codeOf(longDesc)).toBe('too_large');
  });

  it('rejects multi on a non-choose kind and accepts it on choose', () => {
    expect(codeOf(parseRequestInput({ kind: 'confirm', title: 't', multi: true }))).toBe(
      'invalid_args',
    );
    const r = unwrap(
      parseRequestInput({ kind: 'choose', title: 't', options: OPTIONS, multi: true }),
    );
    expect(r.multi).toBe(true);
  });

  it('review needs a draft', () => {
    expect(codeOf(parseRequestInput({ kind: 'review', title: 't' }))).toBe('invalid_args');
    const r = unwrap(parseRequestInput({ kind: 'review', title: 't', draft: 'hello' }));
    expect(r.draft).toBe('hello');
  });

  it('rejects a draft on a non-review kind', () => {
    expect(codeOf(parseRequestInput({ kind: 'text', title: 't', draft: 'x' }))).toBe(
      'invalid_args',
    );
  });

  it('rejects a draft over DRAFT_MAX_BYTES', () => {
    const r = parseRequestInput({
      kind: 'review',
      title: 't',
      draft: 'x'.repeat(DRAFT_MAX_BYTES + 1),
    });
    expect(codeOf(r)).toBe('too_large');
  });

  it('rejects an unknown kind, including attend', () => {
    expect(codeOf(parseRequestInput({ kind: 'attend', title: 't' }))).toBe('invalid_args');
    expect(codeOf(parseRequestInput({ kind: 'form', title: 't' }))).toBe('invalid_args');
  });

  it('rejects an unknown priority and accepts urgent', () => {
    expect(codeOf(parseRequestInput({ kind: 'confirm', title: 't', priority: 'high' }))).toBe(
      'invalid_args',
    );
    const r = unwrap(parseRequestInput({ kind: 'confirm', title: 't', priority: 'urgent' }));
    expect(r.priority).toBe('urgent');
  });

  it('resolves expires_in and rejects a bad one', () => {
    const r = unwrap(parseRequestInput({ kind: 'confirm', title: 't', expires_in: '2h' }));
    expect(r.expiresInMs).toBe(7_200_000);
    expect(codeOf(parseRequestInput({ kind: 'confirm', title: 't', expires_in: '8d' }))).toBe(
      'invalid_args',
    );
    expect(codeOf(parseRequestInput({ kind: 'confirm', title: 't', expires_in: 3 }))).toBe(
      'invalid_args',
    );
  });

  it('accepts a default with expires_in and validates it against the kind', () => {
    const r = unwrap(
      parseRequestInput({
        kind: 'confirm',
        title: 't',
        expires_in: '1h',
        default: { outcome: 'declined', reason: 'no answer in time' },
      }),
    );
    expect(r.default).toEqual({ outcome: 'declined', reason: 'no answer in time' });
    const bad = parseRequestInput({
      kind: 'confirm',
      title: 't',
      expires_in: '1h',
      default: { outcome: 'chosen', values: ['A'] },
    });
    expect(codeOf(bad)).toBe('invalid_args');
  });

  it('a default may not be dismissed', () => {
    const r = parseRequestInput({
      kind: 'confirm',
      title: 't',
      expires_in: '1h',
      default: { outcome: 'dismissed' },
    });
    expect(codeOf(r)).toBe('invalid_args');
    expect(r.ok ? '' : r.error.message).toContain('dismissed');
  });

  it('validates a choose default against the request options', () => {
    const r = unwrap(
      parseRequestInput({
        kind: 'choose',
        title: 't',
        options: OPTIONS,
        expires_in: '1h',
        default: { outcome: 'chosen', values: ['No'] },
      }),
    );
    expect(r.default).toEqual({ outcome: 'chosen', values: ['No'] });
    expect(
      codeOf(
        parseRequestInput({
          kind: 'choose',
          title: 't',
          options: OPTIONS,
          expires_in: '1h',
          default: { outcome: 'chosen', values: ['Maybe'] },
        }),
      ),
    ).toBe('invalid_args');
  });

  it('accepts replaces and wait_s, and rejects wait_s out of 0..540', () => {
    const r = unwrap(
      parseRequestInput({ kind: 'text', title: 't', replaces: 'r_abc', wait_s: 540 }),
    );
    expect(r.replaces).toBe('r_abc');
    expect(r.waitS).toBe(540);
    expect(codeOf(parseRequestInput({ kind: 'text', title: 't', wait_s: 541 }))).toBe(
      'invalid_args',
    );
    expect(codeOf(parseRequestInput({ kind: 'text', title: 't', wait_s: -1 }))).toBe(
      'invalid_args',
    );
    expect(codeOf(parseRequestInput({ kind: 'text', title: 't', wait_s: 1.5 }))).toBe(
      'invalid_args',
    );
  });

  it('maps thread_id to thread', () => {
    const r = unwrap(parseRequestInput({ kind: 'text', title: 't', thread_id: 'th_1' }));
    expect(r.thread).toBe('th_1');
  });

  it('rejects unknown keys', () => {
    const r = parseRequestInput({ kind: 'confirm', title: 't', from: 'sneaky' });
    expect(codeOf(r)).toBe('invalid_args');
    expect(r.ok ? '' : r.error.message).toBe('unknown argument: from');
    expect(codeOf(parseRequestInput(['not', 'an', 'object']))).toBe('invalid_args');
    expect(codeOf(parseRequestInput(null))).toBe('invalid_args');
  });
});

describe('parseWaitRequest', () => {
  it('reads request_id and an optional wait_s', () => {
    expect(unwrap(parseWaitRequest({ request_id: 'r_1' }))).toEqual({
      requestId: 'r_1',
      waitS: null,
    });
    expect(unwrap(parseWaitRequest({ request_id: 'r_1', wait_s: 30 }))).toEqual({
      requestId: 'r_1',
      waitS: 30,
    });
  });

  it('rejects a missing request_id, a bad wait_s and unknown keys', () => {
    expect(codeOf(parseWaitRequest({}))).toBe('invalid_args');
    expect(codeOf(parseWaitRequest({ request_id: 'r_1', wait_s: 600 }))).toBe('invalid_args');
    expect(codeOf(parseWaitRequest({ request_id: 'r_1', extra: 1 }))).toBe('invalid_args');
  });
});

describe('parseWithdrawRequest', () => {
  it('reads request_id and an optional reason', () => {
    expect(unwrap(parseWithdrawRequest({ request_id: 'r_1' }))).toEqual({
      requestId: 'r_1',
      reason: null,
    });
    expect(unwrap(parseWithdrawRequest({ request_id: 'r_1', reason: 'moot' }))).toEqual({
      requestId: 'r_1',
      reason: 'moot',
    });
  });

  it('rejects a reason over WITHDRAW_REASON_MAX chars', () => {
    const r = parseWithdrawRequest({
      request_id: 'r_1',
      reason: 'x'.repeat(WITHDRAW_REASON_MAX + 1),
    });
    expect(codeOf(r)).toBe('too_large');
  });

  it('rejects a missing request_id', () => {
    expect(codeOf(parseWithdrawRequest({ reason: 'x' }))).toBe('invalid_args');
  });
});

describe('parseListRequests', () => {
  it('defaults to open and 50, and bounds limit to 1..100', () => {
    expect(unwrap(parseListRequests({}))).toEqual({ state: 'open', limit: 50 });
    expect(unwrap(parseListRequests({ state: 'all', limit: 100 }))).toEqual({
      state: 'all',
      limit: 100,
    });
    expect(codeOf(parseListRequests({ limit: 0 }))).toBe('invalid_args');
    expect(codeOf(parseListRequests({ limit: 101 }))).toBe('invalid_args');
    expect(codeOf(parseListRequests({ state: 'ended' }))).toBe('invalid_args');
    expect(codeOf(parseListRequests({ limit: 2.5 }))).toBe('invalid_args');
  });
});

describe('parseExpiresIn', () => {
  it('parseExpiresIn handles 2h, 8d and 0m', () => {
    expect(parseExpiresIn('2h')).toBe(7_200_000);
    expect(parseExpiresIn('8d')).toBe(null);
    expect(parseExpiresIn('0m')).toBe(null);
  });

  it('accepts exactly EXPIRES_MAX_MS and rejects anything over it', () => {
    expect(parseExpiresIn('7d')).toBe(EXPIRES_MAX_MS);
    expect(parseExpiresIn('169h')).toBe(null);
    expect(parseExpiresIn('604800s')).toBe(EXPIRES_MAX_MS);
  });

  it('rejects malformed text', () => {
    expect(parseExpiresIn('')).toBe(null);
    expect(parseExpiresIn('2')).toBe(null);
    expect(parseExpiresIn('2 h')).toBe(null);
    expect(parseExpiresIn('2w')).toBe(null);
    expect(parseExpiresIn('-2h')).toBe(null);
    expect(parseExpiresIn('2H')).toBe(null);
  });
});

describe('validateAnswer', () => {
  it('validateAnswer rejects an unknown choose label', () => {
    const r = validateAnswer(rec('choose', 'agent', [{ label: 'A' }, { label: 'B' }]), {
      outcome: 'chosen',
      values: ['C'],
    });
    expect(codeOf(r)).toBe('invalid_args');
  });

  it('single-choice rejects two values unless multi', () => {
    const opts = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
    const two = { outcome: 'chosen', values: ['A', 'B'] };
    expect(codeOf(validateAnswer(rec('choose', 'agent', opts, false), two))).toBe('invalid_args');
    expect(unwrap(validateAnswer(rec('choose', 'agent', opts, true), two))).toEqual({
      outcome: 'chosen',
      values: ['A', 'B'],
    });
  });

  it('chosen needs at least one value and no duplicates', () => {
    const opts = [{ label: 'A' }, { label: 'B' }];
    expect(
      codeOf(validateAnswer(rec('choose', 'agent', opts, true), { outcome: 'chosen', values: [] })),
    ).toBe('invalid_args');
    expect(
      codeOf(
        validateAnswer(rec('choose', 'agent', opts, true), {
          outcome: 'chosen',
          values: ['A', 'A'],
        }),
      ),
    ).toBe('invalid_args');
  });

  it('chosen accepts optional text', () => {
    const r = unwrap(
      validateAnswer(rec('choose', 'agent', [{ label: 'A' }, { label: 'B' }]), {
        outcome: 'chosen',
        values: ['B'],
        text: 'because',
      }),
    );
    expect(r).toEqual({ outcome: 'chosen', values: ['B'], text: 'because' });
  });

  it('choose answered needs text and is agent-only', () => {
    const opts = [{ label: 'A' }, { label: 'B' }];
    expect(codeOf(validateAnswer(rec('choose', 'agent', opts), { outcome: 'answered' }))).toBe(
      'invalid_args',
    );
    expect(
      unwrap(validateAnswer(rec('choose', 'agent', opts), { outcome: 'answered', text: 'other' })),
    ).toEqual({ outcome: 'answered', text: 'other' });
    expect(
      codeOf(
        validateAnswer(rec('choose', 'scheduler', opts), { outcome: 'answered', text: 'other' }),
      ),
    ).toBe('invalid_args');
  });

  it('confirm answered needs text', () => {
    expect(codeOf(validateAnswer(rec('confirm', 'agent'), { outcome: 'answered' }))).toBe(
      'invalid_args',
    );
    expect(codeOf(validateAnswer(rec('confirm', 'agent'), { outcome: 'answered', text: '' }))).toBe(
      'invalid_args',
    );
    expect(
      unwrap(validateAnswer(rec('confirm', 'agent'), { outcome: 'answered', text: 'maybe' })),
    ).toEqual({ outcome: 'answered', text: 'maybe' });
  });

  it('confirm approved and declined take optional text, declined takes a reason', () => {
    expect(unwrap(validateAnswer(rec('confirm', 'agent'), { outcome: 'approved' }))).toEqual({
      outcome: 'approved',
    });
    expect(
      unwrap(validateAnswer(rec('confirm', 'agent'), { outcome: 'approved', text: 'go' })),
    ).toEqual({ outcome: 'approved', text: 'go' });
    expect(
      unwrap(
        validateAnswer(rec('confirm', 'agent'), {
          outcome: 'declined',
          reason: 'not now',
          text: 'later',
        }),
      ),
    ).toEqual({ outcome: 'declined', reason: 'not now', text: 'later' });
  });

  it('reason is only allowed on declined and at most REASON_MAX chars', () => {
    expect(
      codeOf(validateAnswer(rec('confirm', 'agent'), { outcome: 'approved', reason: 'x' })),
    ).toBe('invalid_args');
    expect(
      codeOf(
        validateAnswer(rec('confirm', 'agent'), {
          outcome: 'declined',
          reason: 'x'.repeat(REASON_MAX + 1),
        }),
      ),
    ).toBe('too_large');
  });

  it('allowed/denied valid only for permission', () => {
    const perm = rec('permission', 'policy');
    expect(unwrap(validateAnswer(perm, { outcome: 'denied', scope: 'session' }))).toEqual({
      outcome: 'denied',
      scope: 'session',
    });
    expect(codeOf(validateAnswer(perm, { outcome: 'allowed', scope: 'session' }))).toBe(
      'invalid_args',
    );
    expect(unwrap(validateAnswer(perm, { outcome: 'allowed' }))).toEqual({ outcome: 'allowed' });
    expect(unwrap(validateAnswer(perm, { outcome: 'denied', reason: 'no' }))).toEqual({
      outcome: 'denied',
      reason: 'no',
    });
    expect(
      unwrap(
        validateAnswer(perm, {
          outcome: 'allowed',
          grant: { who: 'session', on: 'target', for: '1h' },
        }),
      ),
    ).toEqual({ outcome: 'allowed', grant: { who: 'session', on: 'target', for: '1h' } });
    expect(
      codeOf(
        validateAnswer(perm, {
          outcome: 'allowed',
          grant: { who: 'nobody', on: 'target', for: '1h' },
        }),
      ),
    ).toBe('invalid_args');
    expect(
      codeOf(
        validateAnswer(perm, {
          outcome: 'allowed',
          grant: { who: 'session', on: 'target', for: '1h', extra: true },
        }),
      ),
    ).toBe('invalid_args');
    expect(
      codeOf(
        validateAnswer(perm, {
          outcome: 'denied',
          grant: { who: 'session', on: 'target', for: '1h' },
        }),
      ),
    ).toBe('invalid_args');
    expect(codeOf(validateAnswer(perm, { outcome: 'allowed', text: 'x' }))).toBe('invalid_args');
    for (const outcome of ['approved', 'declined', 'answered', 'chosen', 'edited', 'dismissed']) {
      expect(codeOf(validateAnswer(perm, { outcome })), outcome).toBe('invalid_args');
    }
    const others = [
      rec('confirm', 'agent'),
      rec('review', 'agent'),
      rec('text', 'message'),
      rec('choose', 'agent', OPTIONS),
      rec('permission', 'agent'),
      rec('permission', 'observed'),
    ];
    for (const other of others) {
      expect(codeOf(validateAnswer(other, { outcome: 'allowed' })), other.kind).toBe(
        'invalid_args',
      );
      expect(codeOf(validateAnswer(other, { outcome: 'denied' })), other.kind).toBe('invalid_args');
    }
  });

  it('dismissed takes no payload on any kind', () => {
    expect(unwrap(validateAnswer(rec('confirm', 'agent'), { outcome: 'dismissed' }))).toEqual({
      outcome: 'dismissed',
    });
    expect(codeOf(validateAnswer(rec('text', 'agent'), { outcome: 'dismissed', text: 'x' }))).toBe(
      'invalid_args',
    );
  });

  it('text answered needs text and is allowed from agent or message only', () => {
    expect(codeOf(validateAnswer(rec('text', 'agent'), { outcome: 'answered' }))).toBe(
      'invalid_args',
    );
    expect(
      unwrap(validateAnswer(rec('text', 'message'), { outcome: 'answered', text: 'yes' })),
    ).toEqual({ outcome: 'answered', text: 'yes' });
    expect(
      codeOf(validateAnswer(rec('text', 'scheduler'), { outcome: 'answered', text: 'yes' })),
    ).toBe('invalid_args');
  });

  it('text over TEXT_MAX_BYTES is too_large', () => {
    const r = validateAnswer(rec('text', 'agent'), {
      outcome: 'answered',
      text: 'é'.repeat(TEXT_MAX_BYTES / 2 + 1),
    });
    expect(codeOf(r)).toBe('too_large');
  });

  it('review approved takes no payload, declined takes a reason', () => {
    expect(unwrap(validateAnswer(rec('review', 'agent'), { outcome: 'approved' }))).toEqual({
      outcome: 'approved',
    });
    expect(codeOf(validateAnswer(rec('review', 'agent'), { outcome: 'approved', text: 'x' }))).toBe(
      'invalid_args',
    );
    expect(
      unwrap(validateAnswer(rec('review', 'agent'), { outcome: 'declined', reason: 'no' })),
    ).toEqual({ outcome: 'declined', reason: 'no' });
  });

  it('review edited needs text and allows up to DRAFT_MAX_BYTES', () => {
    expect(codeOf(validateAnswer(rec('review', 'agent'), { outcome: 'edited' }))).toBe(
      'invalid_args',
    );
    const big = 'é'.repeat(DRAFT_MAX_BYTES / 2);
    expect(
      unwrap(validateAnswer(rec('review', 'agent'), { outcome: 'edited', text: big })).text,
    ).toBe(big);
    expect(
      codeOf(
        validateAnswer(rec('review', 'agent'), {
          outcome: 'edited',
          text: `${big}é`,
        }),
      ),
    ).toBe('too_large');
  });

  it('rejects an outcome that the kind does not allow', () => {
    expect(codeOf(validateAnswer(rec('review', 'agent'), { outcome: 'chosen' }))).toBe(
      'invalid_args',
    );
    expect(codeOf(validateAnswer(rec('confirm', 'agent'), { outcome: 'edited', text: 'x' }))).toBe(
      'invalid_args',
    );
    expect(codeOf(validateAnswer(rec('confirm', 'agent'), { outcome: 'nope' }))).toBe(
      'invalid_args',
    );
  });

  it('rejects an answer with unknown keys or a non-object', () => {
    expect(codeOf(validateAnswer(rec('confirm', 'agent'), { outcome: 'approved', by: 'me' }))).toBe(
      'invalid_args',
    );
    expect(codeOf(validateAnswer(rec('confirm', 'agent'), 'approved'))).toBe('invalid_args');
  });

  it('returns the normalised answer with only the present fields', () => {
    const r = unwrap(
      validateAnswer(rec('confirm', 'agent'), { outcome: 'approved', text: undefined }),
    );
    expect(Object.keys(r)).toEqual(['outcome']);
  });

  it('attend is never validated here', () => {
    expect(codeOf(validateAnswer(rec('attend', 'observed'), { outcome: 'dismissed' }))).toBe(
      'invalid_args',
    );
  });
});

describe('contentKeyOf', () => {
  it('contentKeyOf ignores replaces and wait_s', () => {
    const base = input({ kind: 'text', title: 'Name?' });
    const other = input({ kind: 'text', title: 'Name?', replaces: 'r_old', waitS: 120 });
    expect(contentKeyOf(other)).toBe(contentKeyOf(base));
  });

  it('differs when any content field differs', () => {
    const base = input({ kind: 'text', title: 'Name?' });
    expect(contentKeyOf(input({ kind: 'text', title: 'Age?' }))).not.toBe(contentKeyOf(base));
    expect(contentKeyOf(input({ kind: 'text', title: 'Name?', priority: 'urgent' }))).not.toBe(
      contentKeyOf(base),
    );
    expect(contentKeyOf(input({ kind: 'text', title: 'Name?', thread: 'th_1' }))).not.toBe(
      contentKeyOf(base),
    );
  });

  it('is stable for equal content', () => {
    const a = input({ kind: 'choose', title: 't', options: OPTIONS, multi: true });
    const b = input({
      kind: 'choose',
      title: 't',
      options: [{ ...OPTIONS[0] }, { ...OPTIONS[1] }],
      multi: true,
    });
    expect(contentKeyOf(a)).toBe(contentKeyOf(b));
  });
});

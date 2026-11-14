import { describe, expect, it } from 'vitest';
import {
  type QuestionMessage,
  reconcileAttention,
  reconcileQuestions,
  SCHEDULER_OPTIONS,
  type SessionNeedsYou,
  type SourceAction,
} from '../../src/conduit-mcp/request-sources';
import type { RequestRecord } from '../../src/conduit-mcp/request-types';

function record(overrides: Partial<RequestRecord>): RequestRecord {
  return {
    id: 'r-1',
    origin: 'm-00000001',
    source: 'agent',
    kind: 'confirm',
    requester: 'beta',
    session: null,
    space: null,
    lead: null,
    machine: 'm-00000001',
    title: 'Ship it?',
    body: '',
    options: [],
    multi: false,
    draft: null,
    thread: null,
    messageId: null,
    blocked: null,
    priority: 'normal',
    createdAt: '2026-11-14T10:00:00.000Z',
    expiresAt: null,
    default: null,
    contentKey: 'k-1',
    state: 'open',
    endedAt: null,
    answer: null,
    withdrawnBy: null,
    withdrawReason: null,
    supersededBy: null,
    deliveredAt: null,
    ...overrides,
  };
}

function fact(overrides: Partial<SessionNeedsYou>): SessionNeedsYou {
  return {
    sessionId: 's-1',
    handle: 'alpha',
    blocked: false,
    visible: true,
    resumeIssue: null,
    ...overrides,
  };
}

function question(overrides: Partial<QuestionMessage>): QuestionMessage {
  return {
    messageId: 'msg-1',
    threadId: 'thread-1',
    from: 'alpha',
    fromSession: 's-1',
    subject: 'Deploy window',
    body: 'Can I ship at 3pm?',
    sentAt: '2026-11-14T10:00:00.000Z',
    ...overrides,
  };
}

function apply(open: readonly RequestRecord[], actions: SourceAction[]): RequestRecord[] {
  let next = [...open];
  let seq = 0;
  for (const action of actions) {
    if (action.kind === 'resolve') {
      next = next.filter((r) => r.id !== action.id);
      continue;
    }
    seq += 1;
    next.push(
      record({
        id: `created-${seq}`,
        source: action.source,
        kind: action.fields.kind,
        requester: action.requester,
        session: action.sessionId,
        title: action.fields.title,
        body: action.fields.body,
        options: [...action.fields.options],
        thread: action.fields.thread,
        messageId: action.fields.messageId,
        blocked: action.fields.blocked,
        priority: action.fields.priority,
      }),
    );
  }
  return next;
}

describe('reconcileAttention', () => {
  it('a hidden blocked session creates one attend request', () => {
    const actions = reconcileAttention(
      [],
      [fact({ sessionId: 's-1', handle: 'alpha', blocked: 'permission', visible: false })],
      new Map(),
    );
    expect(actions).toEqual([
      {
        kind: 'create',
        source: 'observed',
        sessionId: 's-1',
        requester: 'alpha',
        fields: {
          kind: 'attend',
          title: 'alpha is waiting at a prompt in its terminal',
          body: '',
          options: [],
          thread: null,
          messageId: null,
          blocked: 'permission',
          priority: 'normal',
        },
      },
    ]);
  });

  it('a repeat pass creates nothing', () => {
    const facts = [fact({ blocked: 'question', visible: false })];
    const first = reconcileAttention([], facts, new Map());
    const open = apply([], first);
    expect(open).toHaveLength(1);
    expect(reconcileAttention(open, facts, new Map())).toEqual([]);
  });

  it('a visible blocked session creates nothing', () => {
    expect(
      reconcileAttention([], [fact({ blocked: 'permission', visible: true })], new Map()),
    ).toEqual([]);
  });

  it('becoming visible never resolves an attend request', () => {
    const open = [
      record({
        id: 'att-1',
        source: 'observed',
        kind: 'attend',
        session: 's-1',
        blocked: 'permission',
      }),
    ];
    expect(
      reconcileAttention(
        open,
        [fact({ sessionId: 's-1', blocked: 'permission', visible: true })],
        new Map(),
      ),
    ).toEqual([]);
  });

  it('the prompt clearing resolves it', () => {
    const open = [
      record({
        id: 'att-1',
        source: 'observed',
        kind: 'attend',
        session: 's-1',
        blocked: 'permission',
      }),
    ];
    expect(
      reconcileAttention(
        open,
        [fact({ sessionId: 's-1', blocked: false, visible: false })],
        new Map(),
      ),
    ).toEqual([{ kind: 'resolve', id: 'att-1' }]);
  });

  it('a session that disappears resolves its attend request', () => {
    const open = [
      record({ id: 'att-1', source: 'observed', kind: 'attend', session: 's-1', blocked: 'auth' }),
    ];
    expect(reconcileAttention(open, [], new Map())).toEqual([{ kind: 'resolve', id: 'att-1' }]);
  });

  it('a resume issue creates one scheduler choose request with the two options', () => {
    const facts = [fact({ sessionId: 's-2', handle: 'beta', resumeIssue: 'Usage limit reached' })];
    const actions = reconcileAttention([], facts, new Map());
    expect(actions).toEqual([
      {
        kind: 'create',
        source: 'scheduler',
        sessionId: 's-2',
        requester: 'conduit',
        fields: {
          kind: 'choose',
          title: "beta hit a usage limit that auto-resume can't handle",
          body: 'Usage limit reached',
          options: [{ label: 'Resume now' }, { label: 'Turn auto-resume on' }],
          thread: null,
          messageId: null,
          blocked: null,
          priority: 'normal',
        },
      },
    ]);
    expect(apply([], actions)).toHaveLength(1);
    expect(reconcileAttention(apply([], actions), facts, new Map())).toEqual([]);
  });

  it('the issue clearing resolves the scheduler request', () => {
    const open = [
      record({
        id: 'sch-1',
        source: 'scheduler',
        kind: 'choose',
        session: 's-2',
        requester: 'conduit',
      }),
    ];
    expect(
      reconcileAttention(open, [fact({ sessionId: 's-2', resumeIssue: null })], new Map()),
    ).toEqual([{ kind: 'resolve', id: 'sch-1' }]);
  });

  it('a scheduler request resolves when its session disappears', () => {
    const open = [
      record({
        id: 'sch-1',
        source: 'scheduler',
        kind: 'choose',
        session: 's-2',
        requester: 'conduit',
      }),
    ];
    expect(reconcileAttention(open, [], new Map())).toEqual([{ kind: 'resolve', id: 'sch-1' }]);
  });

  it('agent requests are never touched', () => {
    const open = [
      record({ id: 'agent-1', source: 'agent', kind: 'confirm', session: 's-1' }),
      record({
        id: 'msg-req',
        source: 'message',
        kind: 'text',
        session: 's-1',
        messageId: 'msg-1',
      }),
    ];
    expect(reconcileAttention(open, [], new Map())).toEqual([]);
    expect(
      reconcileAttention(
        open,
        [fact({ sessionId: 's-1', blocked: 'permission', visible: false })],
        new Map(),
      ),
    ).toEqual([expect.objectContaining({ kind: 'create', source: 'observed', sessionId: 's-1' })]);
  });

  it('a reconciled scheduler option list is a fresh copy of SCHEDULER_OPTIONS', () => {
    const actions = reconcileAttention([], [fact({ resumeIssue: 'x' })], new Map());
    const first = actions[0];
    expect(first?.kind).toBe('create');
    if (first?.kind !== 'create') return;
    expect(first.fields.options).toEqual(SCHEDULER_OPTIONS);
    expect(first.fields.options).not.toBe(SCHEDULER_OPTIONS);
  });
});

describe('reconcileQuestions', () => {
  it('an unread question creates one text request in its thread', () => {
    const actions = reconcileQuestions([], [question({})], new Set());
    expect(actions).toEqual([
      {
        kind: 'create',
        source: 'message',
        sessionId: 's-1',
        requester: 'alpha',
        fields: {
          kind: 'text',
          title: 'alpha asked you a question',
          body: 'Deploy window\n\nCan I ship at 3pm?',
          options: [],
          thread: 'thread-1',
          messageId: 'msg-1',
          blocked: null,
          priority: 'normal',
        },
      },
    ]);
    const open = apply([], actions);
    expect(reconcileQuestions(open, [question({})], new Set())).toEqual([]);
  });

  it('a read question resolves its request', () => {
    const open = [
      record({
        id: 'msg-req',
        source: 'message',
        kind: 'text',
        messageId: 'msg-1',
        thread: 'thread-1',
      }),
    ];
    expect(reconcileQuestions(open, [], new Set())).toEqual([{ kind: 'resolve', id: 'msg-req' }]);
  });

  it('agent requests are never touched', () => {
    const open = [
      record({ id: 'agent-1', source: 'agent', kind: 'text', session: 's-1' }),
      record({
        id: 'att-1',
        source: 'observed',
        kind: 'attend',
        session: 's-1',
        blocked: 'permission',
      }),
      record({
        id: 'sch-1',
        source: 'scheduler',
        kind: 'choose',
        session: 's-1',
        requester: 'conduit',
      }),
    ];
    expect(reconcileQuestions(open, [], new Set())).toEqual([]);
  });

  it('the body is cut to 600 characters', () => {
    const body = 'x'.repeat(600) + 'y'.repeat(400);
    const actions = reconcileQuestions([], [question({ subject: '', body })], new Set());
    const first = actions[0];
    expect(first?.kind).toBe('create');
    if (first?.kind !== 'create') return;
    expect(first.fields.body).toBe('x'.repeat(600));
  });

  it('counts characters, not UTF-16 units, when cutting the body', () => {
    const body = '😀'.repeat(601);
    const actions = reconcileQuestions([], [question({ subject: '', body })], new Set());
    const first = actions[0];
    expect(first?.kind).toBe('create');
    if (first?.kind !== 'create') return;
    expect(first.fields.body).toBe('😀'.repeat(600));
  });

  it('a question whose request is already open creates nothing and an unread duplicate creates once', () => {
    const open = [record({ id: 'msg-req', source: 'message', kind: 'text', messageId: 'msg-1' })];
    expect(reconcileQuestions(open, [question({})], new Set())).toEqual([]);
    expect(reconcileQuestions([], [question({}), question({})], new Set())).toHaveLength(1);
  });

  it('a handled resume issue is not raised again while it persists', () => {
    const facts = [fact({ sessionId: 's-1', resumeIssue: 'limit' })];
    expect(reconcileAttention([], facts, new Map([['s-1', 'limit']]))).toEqual([]);
    expect(reconcileAttention([], facts, new Map([['s-1', 'other']]))).toHaveLength(1);
  });

  it('a dismissed question is not raised again', () => {
    expect(reconcileQuestions([], [question({})], new Set([question({}).messageId]))).toEqual([]);
  });
});

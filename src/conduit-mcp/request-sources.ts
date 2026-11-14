// see docs/plans/2026-11-14-request-queue-machinery.plan.md C7
import type { NeedsYouFact } from '../contracts/server-ports';
import type { RequestOption, RequestRecord } from './request-types';
import type { Handle } from './types';

export type SessionNeedsYou = NeedsYouFact & { handle: Handle | null };
export interface QuestionMessage {
  messageId: string;
  threadId: string;
  from: Handle;
  fromSession: string | null;
  subject: string;
  body: string;
  sentAt: string;
}
export type SourceAction =
  | {
      kind: 'create';
      source: 'observed' | 'scheduler' | 'message';
      sessionId: string | null;
      requester: Handle | 'conduit';
      fields: Pick<
        RequestRecord,
        'kind' | 'title' | 'body' | 'options' | 'thread' | 'messageId' | 'blocked' | 'priority'
      >;
    }
  | { kind: 'resolve'; id: string };

export const SCHEDULER_OPTIONS: readonly RequestOption[] = [
  { label: 'Resume now' },
  { label: 'Turn auto-resume on' },
];

const QUESTION_BODY_CHARS = 600;

/**
 * `handledIssues`: per session, the resume issue the human already answered or skipped. The issue
 * can outlive the answer until the session resumes, and re-raising it would ask twice.
 */
export function reconcileAttention(
  open: readonly RequestRecord[],
  facts: readonly SessionNeedsYou[],
  handledIssues: ReadonlyMap<string, string>,
): SourceAction[] {
  const factOf = new Map(facts.map((f) => [f.sessionId, f]));
  const resolves: SourceAction[] = [];
  for (const r of open) {
    if (r.source === 'observed') {
      const f = r.session === null ? undefined : factOf.get(r.session);
      if (!f || f.blocked === false) resolves.push({ kind: 'resolve', id: r.id });
    } else if (r.source === 'scheduler') {
      const f = r.session === null ? undefined : factOf.get(r.session);
      if (!f || f.resumeIssue === null) resolves.push({ kind: 'resolve', id: r.id });
    }
  }

  const creates: SourceAction[] = [];
  const hasOpen = (source: 'observed' | 'scheduler', sessionId: string) =>
    open.some((r) => r.source === source && r.session === sessionId);

  for (const f of facts) {
    if (f.blocked === false || f.visible || hasOpen('observed', f.sessionId)) continue;
    creates.push({
      kind: 'create',
      source: 'observed',
      sessionId: f.sessionId,
      requester: f.handle ?? 'conduit',
      fields: {
        kind: 'attend',
        title: `${f.handle ?? 'A session'} is waiting at a prompt in its terminal`,
        body: '',
        options: [],
        thread: null,
        messageId: null,
        blocked: f.blocked,
        priority: 'normal',
      },
    });
  }

  for (const f of facts) {
    if (f.resumeIssue === null || hasOpen('scheduler', f.sessionId)) continue;
    if (handledIssues.get(f.sessionId) === f.resumeIssue) continue;
    creates.push({
      kind: 'create',
      source: 'scheduler',
      sessionId: f.sessionId,
      requester: 'conduit',
      fields: {
        kind: 'choose',
        title: `${f.handle ?? 'A session'} hit a usage limit that auto-resume can't handle`,
        body: f.resumeIssue,
        options: [...SCHEDULER_OPTIONS],
        thread: null,
        messageId: null,
        blocked: null,
        priority: 'normal',
      },
    });
  }

  return [...resolves, ...creates];
}

/** `dismissed`: question message ids the human marked "Not a question"; they stay unread. */
export function reconcileQuestions(
  open: readonly RequestRecord[],
  unread: readonly QuestionMessage[],
  dismissed: ReadonlySet<string>,
): SourceAction[] {
  const unreadIds = new Set(unread.map((q) => q.messageId));
  const openIds = new Set(
    open.filter((r) => r.source === 'message' && r.messageId !== null).map((r) => r.messageId),
  );
  const resolves: SourceAction[] = open
    .filter((r) => r.source === 'message' && (r.messageId === null || !unreadIds.has(r.messageId)))
    .map((r) => ({ kind: 'resolve', id: r.id }));

  const creates: SourceAction[] = [];
  for (const q of unread) {
    if (openIds.has(q.messageId) || dismissed.has(q.messageId)) continue;
    openIds.add(q.messageId);
    const cut = [...q.body].slice(0, QUESTION_BODY_CHARS).join('');
    creates.push({
      kind: 'create',
      source: 'message',
      sessionId: q.fromSession,
      requester: q.from,
      fields: {
        kind: 'text',
        title: `${q.from} asked you a question`,
        body: q.subject ? `${q.subject}\n\n${cut}` : cut,
        options: [],
        thread: q.threadId,
        messageId: q.messageId,
        blocked: null,
        priority: 'normal',
      },
    });
  }

  return [...resolves, ...creates];
}

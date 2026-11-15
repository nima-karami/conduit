import { judgePersistedVersion } from '../contracts/session-identity';
import { GRANT_CHOICE_ON, GRANT_FORS, GRANT_WHO_KINDS, type GrantChoice } from './grant-store';
import type { PolicyTarget } from './policy-types';
import type {
  AnsweredBy,
  AnswerInput,
  BlockedKind,
  HumanPresence,
  RequestAnswer,
  RequestKind,
  RequestOption,
  RequestOutcome,
  RequestPriority,
  RequestRecord,
  RequestSource,
  RequestState,
} from './request-types';
import { TOOL_NAMES, type ToolName } from './tool-policy';

export interface RequestsFile {
  version: 1;
  requests: RequestRecord[];
  presence: HumanPresence;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const oneOf =
  <T extends string>(...values: T[]) =>
  (v: unknown): v is T =>
    values.some((x) => x === v);
const orNull =
  <T>(guard: (v: unknown) => v is T) =>
  (v: unknown): v is T | null =>
    v === null || guard(v);
const nullStr = orNull(isStr);
const arrayOf =
  <T>(guard: (v: unknown) => v is T) =>
  (v: unknown): v is T[] =>
    Array.isArray(v) && v.every(guard);

const isSource = oneOf<RequestSource>('agent', 'message', 'observed', 'scheduler', 'policy');
const isKind = oneOf<RequestKind>('confirm', 'choose', 'text', 'review', 'attend', 'permission');
const isTool = oneOf<ToolName>(...TOOL_NAMES);
const isState = oneOf<RequestState>(
  'open',
  'answered',
  'expired',
  'withdrawn',
  'superseded',
  'resolved',
  'orphaned',
);
const isOutcome = oneOf<RequestOutcome>(
  'approved',
  'declined',
  'answered',
  'chosen',
  'edited',
  'dismissed',
  'allowed',
  'denied',
);
const isPriority = oneOf<RequestPriority>('normal', 'urgent');
const isBlocked = orNull(oneOf<Exclude<BlockedKind, null>>('permission', 'question', 'auth'));
const isWithdrawnBy = orNull(oneOf<'requester' | 'conduit'>('requester', 'conduit'));

const isOption = (v: unknown): v is RequestOption =>
  isObj(v) && isStr(v.label) && (v.description === undefined || isStr(v.description));

const isStoredGrant = (v: unknown): v is GrantChoice =>
  isObj(v) &&
  oneOf(...GRANT_WHO_KINDS)(v.who) &&
  oneOf(...GRANT_CHOICE_ON)(v.on) &&
  oneOf(...GRANT_FORS)(v.for);

const isAnswerInput = (v: unknown): v is AnswerInput =>
  isObj(v) &&
  isOutcome(v.outcome) &&
  (v.text === undefined || isStr(v.text)) &&
  (v.values === undefined || isStrArray(v.values)) &&
  (v.reason === undefined || isStr(v.reason)) &&
  (v.grant === undefined || isStoredGrant(v.grant));

const isAnsweredBy = (v: unknown): v is AnsweredBy =>
  isObj(v) &&
  (v.kind === 'default' ||
    (v.kind === 'you' && (v.windowId === null || typeof v.windowId === 'number')));

const isAnswer = (v: unknown): v is RequestAnswer =>
  isObj(v) && isAnswerInput(v) && isAnsweredBy(v.answeredBy) && isStr(v.at);

const isPolicyTarget = (v: unknown): v is PolicyTarget =>
  isObj(v) && nullStr(v.sessionId) && nullStr(v.path) && nullStr(v.folder) && nullStr(v.projectId);

const isPermission = (v: unknown): v is NonNullable<RequestRecord['permission']> =>
  isObj(v) &&
  isTool(v.tool) &&
  isStr(v.why) &&
  arrayOf(isPolicyTarget)(v.targets) &&
  nullStr(v.lateGrant);

const isRecord = (v: unknown): v is RequestRecord =>
  isObj(v) &&
  isStr(v.id) &&
  isStr(v.origin) &&
  isSource(v.source) &&
  isKind(v.kind) &&
  isStr(v.requester) &&
  nullStr(v.session) &&
  nullStr(v.space) &&
  nullStr(v.lead) &&
  isStr(v.machine) &&
  isStr(v.title) &&
  isStr(v.body) &&
  arrayOf(isOption)(v.options) &&
  isBool(v.multi) &&
  nullStr(v.draft) &&
  nullStr(v.thread) &&
  nullStr(v.messageId) &&
  isBlocked(v.blocked) &&
  isPriority(v.priority) &&
  isStr(v.createdAt) &&
  nullStr(v.expiresAt) &&
  orNull(isAnswerInput)(v.default) &&
  isStr(v.contentKey) &&
  isState(v.state) &&
  nullStr(v.endedAt) &&
  orNull(isAnswer)(v.answer) &&
  isWithdrawnBy(v.withdrawnBy) &&
  nullStr(v.withdrawReason) &&
  nullStr(v.supersededBy) &&
  nullStr(v.deliveredAt) &&
  (v.permission === undefined || v.permission === null
    ? v.kind !== 'permission'
    : v.kind === 'permission' && isPermission(v.permission));

const isLastAway = (v: unknown): v is NonNullable<HumanPresence['lastAway']> =>
  isObj(v) && isStr(v.from) && isStr(v.to);

const isPresence = (v: unknown): v is HumanPresence =>
  isObj(v) &&
  oneOf<HumanPresence['state']>('here', 'away')(v.state) &&
  isStr(v.since) &&
  nullStr(v.until) &&
  orNull(isLastAway)(v.lastAway);

export function emptyPresence(now: number): HumanPresence {
  return { state: 'here', since: new Date(now).toISOString(), until: null, lastAway: null };
}

export function parseRequestsFile(
  text: string | null,
  now: number,
): { kind: 'ok' | 'empty' | 'corrupt' | 'newer'; file: RequestsFile; dropped: number } {
  const empty = (kind: 'empty' | 'corrupt' | 'newer') => ({
    kind,
    file: { version: 1 as const, requests: [], presence: emptyPresence(now) },
    dropped: 0,
  });
  if (text === null) return empty('empty');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty('corrupt');
  }
  if (!isObj(raw)) return empty('corrupt');
  const verdict = judgePersistedVersion('conduit-mcp/requests.json', raw.version);
  if (verdict === 'newer') return empty('newer');
  if (verdict === 'invalid') return empty('corrupt');
  if (!Array.isArray(raw.requests)) return empty('corrupt');
  const requests = raw.requests
    .filter(isRecord)
    .map((r) => ({ ...r, permission: r.permission === undefined ? null : r.permission }));
  return {
    kind: 'ok',
    file: {
      version: 1,
      requests,
      presence: isPresence(raw.presence) ? raw.presence : emptyPresence(now),
    },
    dropped: raw.requests.length - requests.length,
  };
}

export function serializeRequestsFile(f: RequestsFile): string {
  return JSON.stringify(f);
}

import { GRANT_CHOICE_ON, GRANT_FORS, GRANT_WHO_KINDS, type GrantChoice } from './grant-store';
import type {
  AgentRequestKind,
  AnswerInput,
  RequestOption,
  RequestOutcome,
  RequestPriority,
  RequestRecord,
  RequestSource,
} from './request-types';
import { type Result, type ToolError, type ToolErrorCode, toolError } from './types';

export const TITLE_MAX = 200;
export const BODY_MAX_BYTES = 8192;
export const DRAFT_MAX_BYTES = 32768;
export const TEXT_MAX_BYTES = 8192;
export const REASON_MAX = 500;
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 8;
export const OPTION_LABEL_MAX = 100;
export const OPTION_DESC_MAX = 300;
export const EXPIRES_MAX_MS = 7 * 86_400_000;
export const WITHDRAW_REASON_MAX = 200;

const WAIT_MAX_S = 540;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 100;

export interface CreateInput {
  kind: AgentRequestKind;
  title: string;
  body: string;
  options: RequestOption[];
  multi: boolean;
  draft: string | null;
  thread: string | null;
  priority: RequestPriority;
  expiresInMs: number | null;
  default: AnswerInput | null;
  replaces: string | null;
  waitS: number | null;
}

type Args = Record<string, unknown>;
type Failure = { ok: false; error: ToolError };

const fail = (code: ToolErrorCode, message: string): Failure => ({
  ok: false,
  error: toolError(code, message),
});

const KIND_NAMES: readonly AgentRequestKind[] = ['confirm', 'choose', 'text', 'review'];
const OUTCOMES: readonly RequestOutcome[] = [
  'approved',
  'declined',
  'answered',
  'chosen',
  'edited',
  'dismissed',
  'allowed',
  'denied',
];
const GRANT_CHOICE_KEYS = ['who', 'on', 'for'] as const;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const EXPIRES_RE = /^(\d+)(s|m|h|d)$/;

// TextEncoder rather than Buffer: this module must stay Node-free.
const byteLength = (s: string): number => new TextEncoder().encode(s).length;

/** Accepts only the declared keys, so a smuggled field is refused rather than ignored. */
function argsObject(raw: unknown, allowed: readonly string[]): Result<Args> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('invalid_args', 'arguments must be an object');
  }
  const extra = Object.keys(raw).find((k) => !allowed.includes(k));
  return extra === undefined
    ? { ok: true, value: raw as Args }
    : fail('invalid_args', `unknown argument: ${extra}`);
}

function requiredId(args: Args, key: string): Result<string> {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    return fail('invalid_args', `${key} must be a non-empty string`);
  }
  return { ok: true, value: v };
}

function optionalId(args: Args, key: string): Result<string | null> {
  if (args[key] === undefined) return { ok: true, value: null };
  const v = requiredId(args, key);
  return v.ok ? { ok: true, value: v.value } : v;
}

function optionalWaitS(args: Args): Result<number | null> {
  const v = args.wait_s;
  if (v === undefined) return { ok: true, value: null };
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > WAIT_MAX_S) {
    return fail('invalid_args', `wait_s must be an integer from 0 to ${WAIT_MAX_S}`);
  }
  return { ok: true, value: v };
}

function parseOptions(raw: unknown): Result<RequestOption[]> {
  if (!Array.isArray(raw)) return fail('invalid_args', 'options must be an array');
  if (raw.length < OPTIONS_MIN) {
    return fail('invalid_args', `choose needs ${OPTIONS_MIN} to ${OPTIONS_MAX} options`);
  }
  if (raw.length > OPTIONS_MAX) {
    return fail('too_large', `choose takes at most ${OPTIONS_MAX} options`);
  }
  const labels = new Set<string>();
  const out: RequestOption[] = [];
  for (const item of raw) {
    const o = argsObject(item, ['label', 'description']);
    if (!o.ok) return o;
    const label = o.value.label;
    if (typeof label !== 'string' || label.length === 0) {
      return fail('invalid_args', 'each option needs a non-empty label');
    }
    if (label.length > OPTION_LABEL_MAX) {
      return fail('too_large', `option label is over ${OPTION_LABEL_MAX} characters`);
    }
    if (labels.has(label)) return fail('invalid_args', `duplicate option label: ${label}`);
    labels.add(label);
    const description = o.value.description;
    if (description === undefined) {
      out.push({ label });
      continue;
    }
    if (typeof description !== 'string') {
      return fail('invalid_args', 'option description must be a string');
    }
    if (description.length > OPTION_DESC_MAX) {
      return fail('too_large', `option description is over ${OPTION_DESC_MAX} characters`);
    }
    out.push({ label, description });
  }
  return { ok: true, value: out };
}

export function parseExpiresIn(s: string): number | null {
  const m = EXPIRES_RE.exec(s);
  if (m === null) return null;
  const count = Number(m[1]);
  const unit = UNIT_MS[m[2] ?? ''];
  if (unit === undefined || count === 0) return null;
  const ms = count * unit;
  return ms > EXPIRES_MAX_MS ? null : ms;
}

const CREATE_KEYS = [
  'kind',
  'title',
  'body',
  'options',
  'multi',
  'draft',
  'thread_id',
  'priority',
  'expires_in',
  'default',
  'replaces',
  'wait_s',
] as const;

export function parseRequestInput(raw: unknown): Result<CreateInput> {
  const a = argsObject(raw, CREATE_KEYS);
  if (!a.ok) return a;
  const args = a.value;

  const kind = args.kind;
  if (typeof kind !== 'string' || !(KIND_NAMES as readonly string[]).includes(kind)) {
    return fail('invalid_args', 'kind must be one of confirm, choose, text, review');
  }
  const agentKind = kind as AgentRequestKind;

  const title = args.title;
  if (typeof title !== 'string' || title.length === 0) {
    return fail('invalid_args', 'title must be a non-empty string');
  }
  if (title.length > TITLE_MAX) return fail('too_large', `title is over ${TITLE_MAX} characters`);

  if (args.body !== undefined && typeof args.body !== 'string') {
    return fail('invalid_args', 'body must be a string');
  }
  const body = typeof args.body === 'string' ? args.body : '';
  if (byteLength(body) > BODY_MAX_BYTES) {
    return fail('too_large', `body is over ${BODY_MAX_BYTES} bytes`);
  }

  let options: RequestOption[] = [];
  if (agentKind === 'choose') {
    if (args.options === undefined) return fail('invalid_args', 'choose needs options');
    const parsed = parseOptions(args.options);
    if (!parsed.ok) return parsed;
    options = parsed.value;
  } else if (args.options !== undefined) {
    return fail('invalid_args', `options are only allowed for choose, not ${agentKind}`);
  }

  if (args.multi !== undefined && agentKind !== 'choose') {
    return fail('invalid_args', `multi is only allowed for choose, not ${agentKind}`);
  }
  if (args.multi !== undefined && typeof args.multi !== 'boolean') {
    return fail('invalid_args', 'multi must be a boolean');
  }
  const multi = args.multi === true;

  let draft: string | null = null;
  if (agentKind === 'review') {
    if (typeof args.draft !== 'string') return fail('invalid_args', 'review needs a draft');
    if (byteLength(args.draft) > DRAFT_MAX_BYTES) {
      return fail('too_large', `draft is over ${DRAFT_MAX_BYTES} bytes`);
    }
    draft = args.draft;
  } else if (args.draft !== undefined) {
    return fail('invalid_args', `draft is only allowed for review, not ${agentKind}`);
  }

  const thread = optionalId(args, 'thread_id');
  if (!thread.ok) return thread;

  let priority: RequestPriority = 'normal';
  if (args.priority !== undefined) {
    if (args.priority !== 'normal' && args.priority !== 'urgent') {
      return fail('invalid_args', 'priority must be normal or urgent');
    }
    priority = args.priority;
  }

  let expiresInMs: number | null = null;
  if (args.expires_in !== undefined) {
    const ms = typeof args.expires_in === 'string' ? parseExpiresIn(args.expires_in) : null;
    if (ms === null) {
      return fail('invalid_args', 'expires_in must look like 2h or 8d, at most 7d');
    }
    expiresInMs = ms;
  }

  let defaultAnswer: AnswerInput | null = null;
  if (args.default !== undefined) {
    if (expiresInMs === null) return fail('invalid_args', 'a default needs expires_in');
    const checked = validateAnswer(
      { kind: agentKind, source: 'agent', options, multi },
      args.default,
    );
    if (!checked.ok) return checked;
    if (checked.value.outcome === 'dismissed') {
      return fail('invalid_args', 'a default may not be dismissed');
    }
    defaultAnswer = checked.value;
  }

  const replaces = optionalId(args, 'replaces');
  if (!replaces.ok) return replaces;

  const waitS = optionalWaitS(args);
  if (!waitS.ok) return waitS;

  return {
    ok: true,
    value: {
      kind: agentKind,
      title,
      body,
      options,
      multi,
      draft,
      thread: thread.value,
      priority,
      expiresInMs,
      default: defaultAnswer,
      replaces: replaces.value,
      waitS: waitS.value,
    },
  };
}

export function parseWaitRequest(
  raw: unknown,
): Result<{ requestId: string; waitS: number | null }> {
  const a = argsObject(raw, ['request_id', 'wait_s']);
  if (!a.ok) return a;
  const requestId = requiredId(a.value, 'request_id');
  if (!requestId.ok) return requestId;
  const waitS = optionalWaitS(a.value);
  if (!waitS.ok) return waitS;
  return { ok: true, value: { requestId: requestId.value, waitS: waitS.value } };
}

export function parseWithdrawRequest(
  raw: unknown,
): Result<{ requestId: string; reason: string | null }> {
  const a = argsObject(raw, ['request_id', 'reason']);
  if (!a.ok) return a;
  const requestId = requiredId(a.value, 'request_id');
  if (!requestId.ok) return requestId;
  const reason = a.value.reason;
  if (reason === undefined)
    return { ok: true, value: { requestId: requestId.value, reason: null } };
  if (typeof reason !== 'string') return fail('invalid_args', 'reason must be a string');
  if (reason.length > WITHDRAW_REASON_MAX) {
    return fail('too_large', `reason is over ${WITHDRAW_REASON_MAX} characters`);
  }
  return { ok: true, value: { requestId: requestId.value, reason } };
}

export function parseListRequests(raw: unknown): Result<{ state: 'open' | 'all'; limit: number }> {
  const a = argsObject(raw, ['state', 'limit']);
  if (!a.ok) return a;
  const state = a.value.state ?? 'open';
  if (state !== 'open' && state !== 'all') {
    return fail('invalid_args', 'state must be open or all');
  }
  const limit = a.value.limit ?? LIST_LIMIT_DEFAULT;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > LIST_LIMIT_MAX
  ) {
    return fail('invalid_args', `limit must be an integer from 1 to ${LIST_LIMIT_MAX}`);
  }
  return { ok: true, value: { state, limit } };
}

interface Shape {
  text: 'none' | 'optional' | 'required';
  textMax: number;
  values: boolean;
  reason: boolean;
  grant: boolean;
}
const NO_PAYLOAD: Shape = {
  text: 'none',
  textMax: TEXT_MAX_BYTES,
  values: false,
  reason: false,
  grant: false,
};
const OPT_TEXT: Shape = { ...NO_PAYLOAD, text: 'optional' };
const REQ_TEXT: Shape = { ...NO_PAYLOAD, text: 'required' };
const DECLINED_CONFIRM: Shape = { ...OPT_TEXT, reason: true };
const DECLINED_REVIEW: Shape = { ...NO_PAYLOAD, reason: true };
const CHOSEN: Shape = { ...OPT_TEXT, values: true };
const EDITED: Shape = { ...REQ_TEXT, textMax: DRAFT_MAX_BYTES };
const ALLOWED: Shape = { ...NO_PAYLOAD, grant: true };
const DENIED: Shape = { ...NO_PAYLOAD, reason: true };

function shapeFor(
  r: Pick<RequestRecord, 'kind' | 'source'>,
  outcome: RequestOutcome,
): Shape | null {
  const pick = (table: Partial<Record<RequestOutcome, Shape>>): Shape | null =>
    table[outcome] ?? null;
  switch (r.kind) {
    case 'confirm':
      return pick({
        approved: OPT_TEXT,
        declined: DECLINED_CONFIRM,
        answered: REQ_TEXT,
        dismissed: NO_PAYLOAD,
      });
    case 'choose': {
      if (!isAgentOrScheduler(r.source)) return null;
      const table: Partial<Record<RequestOutcome, Shape>> = {
        chosen: CHOSEN,
        dismissed: NO_PAYLOAD,
      };
      if (r.source === 'agent') table.answered = REQ_TEXT;
      return pick(table);
    }
    case 'text':
      if (r.source !== 'agent' && r.source !== 'message') return null;
      return pick({ answered: REQ_TEXT, dismissed: NO_PAYLOAD });
    case 'review':
      return pick({
        approved: NO_PAYLOAD,
        edited: EDITED,
        declined: DECLINED_REVIEW,
        dismissed: NO_PAYLOAD,
      });
    case 'permission':
      if (r.source !== 'policy') return null;
      return pick({ allowed: ALLOWED, denied: DENIED });
    case 'attend':
      return null;
  }
}

const isAgentOrScheduler = (source: RequestSource): boolean =>
  source === 'agent' || source === 'scheduler';

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

const oneOfValues = <T extends string>(values: readonly T[], v: unknown): v is T =>
  values.some((x) => x === v);

export function isGrantChoice(v: unknown): v is GrantChoice {
  const obj = argsObject(v, GRANT_CHOICE_KEYS);
  if (!obj.ok) return false;
  const { who, on, for: forDur } = obj.value;
  return (
    oneOfValues(GRANT_WHO_KINDS, who) &&
    oneOfValues(GRANT_CHOICE_ON, on) &&
    oneOfValues(GRANT_FORS, forDur)
  );
}

export function validateAnswer(
  r: Pick<RequestRecord, 'kind' | 'source' | 'options' | 'multi'>,
  a: unknown,
): Result<AnswerInput> {
  if (r.kind === 'attend') return fail('invalid_args', 'attend requests are not answered here');
  const obj = argsObject(a, ['outcome', 'text', 'values', 'reason', 'grant']);
  if (!obj.ok) return obj;
  const o = obj.value;

  const outcome = o.outcome;
  if (typeof outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(outcome)) {
    return fail(
      'invalid_args',
      'outcome must be one of approved, declined, answered, chosen, edited, dismissed, allowed, denied',
    );
  }
  const answer = outcome as RequestOutcome;
  const shape = shapeFor(r, answer);
  if (shape === null) {
    return fail(
      'invalid_args',
      `${answer} is not an answer for a ${r.kind} request from ${r.source}`,
    );
  }

  const { text, values, reason, grant } = o;
  if (text !== undefined && typeof text !== 'string')
    return fail('invalid_args', 'text must be a string');
  if (reason !== undefined && typeof reason !== 'string') {
    return fail('invalid_args', 'reason must be a string');
  }
  if (values !== undefined && !isStringArray(values)) {
    return fail('invalid_args', 'values must be an array of option labels');
  }
  if (text !== undefined && shape.text === 'none')
    return fail('invalid_args', `${answer} takes no text`);
  if (reason !== undefined && !shape.reason)
    return fail('invalid_args', `reason is not allowed for ${answer}`);
  if (values !== undefined && !shape.values)
    return fail('invalid_args', `values are only allowed for chosen`);
  let chosenGrant: GrantChoice | null = null;
  if (grant !== undefined) {
    if (!shape.grant) return fail('invalid_args', `grant is only allowed for allowed`);
    if (!isGrantChoice(grant)) {
      return fail('invalid_args', 'grant must be {who, on, for} with known values');
    }
    chosenGrant = { who: grant.who, on: grant.on, for: grant.for };
  }
  if (shape.text === 'required' && (typeof text !== 'string' || text.length === 0)) {
    return fail('invalid_args', `${answer} needs text`);
  }
  if (typeof text === 'string' && byteLength(text) > shape.textMax) {
    return fail('too_large', `text is over ${shape.textMax} bytes`);
  }
  if (typeof reason === 'string' && reason.length > REASON_MAX) {
    return fail('too_large', `reason is over ${REASON_MAX} characters`);
  }

  const value: AnswerInput = { outcome: answer };
  if (typeof text === 'string') value.text = text;
  if (typeof reason === 'string') value.reason = reason;
  if (chosenGrant !== null) value.grant = chosenGrant;
  if (shape.values) {
    const chosen = validateValues(r, values);
    if (!chosen.ok) return chosen;
    value.values = chosen.value;
  }
  return { ok: true, value };
}

function validateValues(
  r: Pick<RequestRecord, 'options' | 'multi'>,
  values: string[] | undefined,
): Result<string[]> {
  if (values === undefined || values.length === 0) {
    return fail('invalid_args', 'chosen needs at least one option label');
  }
  if (values.length > 1 && !r.multi) {
    return fail('invalid_args', 'only one option may be chosen for this request');
  }
  const labels = new Set(r.options.map((o) => o.label));
  const seen = new Set<string>();
  for (const v of values) {
    if (!labels.has(v)) return fail('invalid_args', `unknown option label: ${v}`);
    if (seen.has(v)) return fail('invalid_args', `duplicate option label: ${v}`);
    seen.add(v);
  }
  return { ok: true, value: [...values] };
}

export function contentKeyOf(i: CreateInput): string {
  return JSON.stringify({
    kind: i.kind,
    title: i.title,
    body: i.body,
    options: i.options,
    multi: i.multi,
    draft: i.draft,
    thread: i.thread,
    priority: i.priority,
    expiresInMs: i.expiresInMs,
    default: i.default,
  });
}

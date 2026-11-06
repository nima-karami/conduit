// Node-free. wait_sessions (spec 2026-10-25-conduit-mcp-server, CON-150 amendment): one call blocks
// until a listed session meets a condition. The host reads each session; this module owns the wait's
// lifecycle and the per-caller turn-end memory.

import { type Handle, type Presence, type Result, toolError } from './types';
import type { CallKey } from './window-waits';

export const WAIT_CONDITIONS = ['turn_end', 'exited', 'needs_you', 'message'] as const;
export type WaitCondition = (typeof WAIT_CONDITIONS)[number];
export const WAIT_MAX_SESSIONS = 20;
export const WAIT_MAX_PER_CALLER = 4;
export const WAIT_DEFAULT_TIMEOUT_S = 120;
export const WAIT_MAX_TIMEOUT_S = 540;
const MAX_SESSION_CHARS = 128;
const ARG_KEYS: readonly string[] = ['sessions', 'until', 'timeout_s'];

export interface WaitTarget {
  sessionId: string;
  handle: Handle;
}
/** One listed session as the host reads it when a wait is checked. */
export interface WaitReading extends WaitTarget {
  presence: Presence;
  needsYou: boolean;
  /** The server's run counter: a turn end is a rise in it. */
  completions: number;
  /** Unread messages the caller has from this session. */
  unreadFrom: number;
}
export interface WaitState {
  session: Handle;
  presence: Presence;
  needs_you: boolean;
  unread_from: number;
}
export interface WaitFired {
  session: Handle;
  condition: WaitCondition;
}
export interface WaitOutput {
  fired: WaitFired[];
  timed_out: boolean;
  states: WaitState[];
}
export interface WaitArgs {
  sessions: string[];
  until: WaitCondition[];
  timeoutS: number;
}

const isCondition = (v: unknown): v is WaitCondition =>
  typeof v === 'string' && (WAIT_CONDITIONS as readonly string[]).includes(v);
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isConditions = (v: unknown): v is WaitCondition[] =>
  Array.isArray(v) && v.length > 0 && v.every(isCondition);

const invalid = (message: string) => ({
  ok: false as const,
  error: toolError('invalid_args', message),
});

export function parseWaitArgs(raw: unknown): Result<WaitArgs> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return invalid('arguments must be an object');
  const extra = Object.keys(raw).find((k) => !ARG_KEYS.includes(k));
  if (extra !== undefined) return invalid(`unknown argument: ${extra}`);
  const { sessions, until, timeout_s: timeout } = raw as Record<string, unknown>;
  if (!isStrings(sessions) || sessions.length < 1 || sessions.length > WAIT_MAX_SESSIONS)
    return invalid(`sessions must be 1–${WAIT_MAX_SESSIONS} handles or session ids`);
  if (sessions.some((s) => s.length === 0 || s.length > MAX_SESSION_CHARS))
    return invalid(`each session must be a handle or id of 1–${MAX_SESSION_CHARS} chars`);
  if (!isConditions(until))
    return invalid(`until must be one or more of ${WAIT_CONDITIONS.join(', ')}`);
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > WAIT_MAX_TIMEOUT_S)
  )
    return invalid(`timeout_s must be an integer 1–${WAIT_MAX_TIMEOUT_S}`);
  return {
    ok: true,
    value: {
      sessions,
      until: [...new Set(until)],
      timeoutS: timeout ?? WAIT_DEFAULT_TIMEOUT_S,
    },
  };
}

interface WaitEvaluation {
  fired: WaitFired[];
  states: WaitState[];
  /** The readings whose turn_end fired: the host remembers their completions as reported. */
  turnEnds: WaitReading[];
}

/**
 * `seenTurnEnd` is the completions count the caller has already been told about; only a rise above
 * it is a new turn end.
 */
function evaluateWait(
  until: readonly WaitCondition[],
  readings: readonly WaitReading[],
  seenTurnEnd: (r: WaitReading) => number,
): WaitEvaluation {
  const holds = (c: WaitCondition, r: WaitReading): boolean => {
    switch (c) {
      case 'turn_end':
        return r.completions > seenTurnEnd(r);
      case 'exited':
        return r.presence === 'exited';
      case 'needs_you':
        return r.needsYou;
      case 'message':
        return r.unreadFrom > 0;
    }
  };
  const fired: WaitFired[] = [];
  const turnEnds: WaitReading[] = [];
  for (const r of readings) {
    for (const c of WAIT_CONDITIONS) {
      if (!until.includes(c) || !holds(c, r)) continue;
      fired.push({ session: r.handle, condition: c });
      if (c === 'turn_end') turnEnds.push(r);
    }
  }
  const states = readings.map((r) => ({
    session: r.handle,
    presence: r.presence,
    needs_you: r.needsYou,
    unread_from: r.unreadFrom,
  }));
  return { fired, states, turnEnds };
}

export interface OpenWait {
  caller: { sessionId: string; handle: Handle };
  key: CallKey;
  targets: readonly WaitTarget[];
  until: readonly WaitCondition[];
  timeoutMs: number;
}
export interface SessionWaitsDeps {
  read(callerHandle: Handle, target: WaitTarget): WaitReading;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
export interface SessionWaits {
  countFor(callerSessionId: string): number;
  /** Resolves null when the wait is cancelled: no reply is owed then. */
  open(w: OpenWait): Promise<WaitOutput | null>;
  /** Re-reads every open wait. The host calls it on each change of anything a wait reads. */
  notify(): void;
  /** Ends each open wait that matches, unanswered. */
  cancel(match: (w: OpenWait) => boolean): void;
  /** Drops the turn-end memo for a deleted session, as a target and as a caller. */
  forget(sessionId: string, handle: Handle | undefined): void;
  dispose(): void;
}

interface Entry {
  wait: OpenWait;
  timer: unknown;
  resolve(out: WaitOutput | null): void;
}

export function createSessionWaits(deps: SessionWaitsDeps): SessionWaits {
  const open = new Set<Entry>();
  // The run count each caller has been told about, by session then caller handle. Keyed by handle so
  // a reconnected caller keeps its place.
  const reported = new Map<string, Map<Handle, number>>();

  /** A count above the memo's is a turn end; a count below it means the counter reset (restart). */
  const seenTurnEnds = (callerHandle: Handle, r: WaitReading): number => {
    const byCaller = reported.get(r.sessionId);
    const seen = byCaller?.get(callerHandle) ?? 0;
    if (byCaller && seen > r.completions) {
      byCaller.set(callerHandle, r.completions);
      return r.completions;
    }
    return seen;
  };

  const finish = (e: Entry, out: WaitOutput | null, turnEnds: readonly WaitReading[] = []) => {
    if (!open.delete(e)) return;
    deps.clearTimer(e.timer);
    for (const r of turnEnds) {
      let byCaller = reported.get(r.sessionId);
      if (!byCaller) {
        byCaller = new Map();
        reported.set(r.sessionId, byCaller);
      }
      byCaller.set(e.wait.caller.handle, r.completions);
    }
    e.resolve(out);
  };

  const check = (e: Entry, deadline: boolean) => {
    const readings = e.wait.targets.map((t) => deps.read(e.wait.caller.handle, t));
    const ev = evaluateWait(e.wait.until, readings, (r) => seenTurnEnds(e.wait.caller.handle, r));
    if (ev.fired.length > 0)
      finish(e, { fired: ev.fired, timed_out: false, states: ev.states }, ev.turnEnds);
    else if (deadline) finish(e, { fired: [], timed_out: true, states: ev.states });
  };

  return {
    countFor: (callerSessionId) =>
      [...open].filter((e) => e.wait.caller.sessionId === callerSessionId).length,

    open: (w) =>
      new Promise<WaitOutput | null>((resolve) => {
        const e: Entry = { wait: w, timer: undefined, resolve };
        open.add(e);
        check(e, false);
        if (open.has(e)) e.timer = deps.setTimer(() => check(e, true), w.timeoutMs);
      }),

    notify: () => {
      for (const e of [...open]) check(e, false);
    },

    cancel: (match) => {
      for (const e of [...open]) if (match(e.wait)) finish(e, null);
    },

    forget: (sessionId, handle) => {
      reported.delete(sessionId);
      if (handle !== undefined) for (const byCaller of reported.values()) byCaller.delete(handle);
    },

    dispose: () => {
      for (const e of [...open]) finish(e, null);
    },
  };
}

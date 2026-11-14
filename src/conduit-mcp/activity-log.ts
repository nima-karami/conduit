// see spec 2026-11-14-policy-and-permissions §4.6

import { judgePersistedVersion, SERVER_FILE_VERSION } from '../contracts/session-identity';
import type { Decision } from './policy-types';
import type { CliKind, ToolName } from './tool-policy';

export type ActivityLane = 'conduit' | 'observed' | 'note';
export type ActivityOutcome = 'ok' | 'error' | 'denied' | 'expired' | 'withdrawn' | 'asked' | null;

export interface ActivityEntry {
  v: 1;
  id: string;
  at: string;
  lane: ActivityLane;
  principal: { handle: string | null; sessionId: string | null; machineId: string | null };
  cli: CliKind | null;
  action: string;
  target: string | null;
  summary: string | null;
  decision: Decision | null;
  decidedBy: string;
  outcome: ActivityOutcome;
  durationMs: number | null;
  requestId: string | null;
  count: number | null;
}

export const COUNTED_TOOLS: readonly ToolName[] = [
  'list_sessions',
  'list_agents',
  'wait_sessions',
  'read_inbox',
];
const COUNTED: ReadonlySet<string> = new Set(COUNTED_TOOLS);

export const ACTIVITY_RETENTION_MS = 30 * 86_400_000;
export const ACTIVITY_MAX_BYTES = 50 * 1024 * 1024;
const ASK_ARGS_TTL_MS = 24 * 3_600_000;
const ASK_ARGS_FILE = 'conduit-mcp/activity/ask-args.json' as const;
const DENY_WINDOW = 200;

export interface ActivityIo {
  append(day: string, line: string): void;
  list(): Array<{ day: string; bytes: number }>;
  remove(day: string): void;
  readArgs(): string | null;
  writeArgs(text: string): void;
}

export interface ActivityLog {
  record(e: Omit<ActivityEntry, 'v' | 'id' | 'at'>): string;
  recordAskArgs(requestId: string, args: unknown): void;
  flushCounts(all: boolean): void;
  purge(): void;
  writable(): boolean;
  recentDenies(): ReadonlyMap<string, ActivityEntry>;
}

type NewEntry = Omit<ActivityEntry, 'v' | 'id' | 'at'>;
type Principal = ActivityEntry['principal'];
interface Bucket {
  id: string;
  hour: string;
  action: string;
  principal: Principal;
  cli: CliKind | null;
  outcome: ActivityOutcome;
  count: number;
}
interface AskRecord {
  at: number;
  args: unknown;
}

const dayOf = (iso: string): string => iso.slice(0, 10);
const hourOf = (iso: string): string => iso.slice(0, 13);

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Throws on anything that is not a readable, current-version ask store. */
function parseAsks(text: string): Map<string, AskRecord> {
  const root = asObject(JSON.parse(text));
  if (!root) throw new Error('ask args is not an object');
  const verdict = judgePersistedVersion(ASK_ARGS_FILE, root.version);
  if (verdict !== 'read') throw new Error(`ask args version is ${verdict}`);
  const asks = asObject(root.asks);
  if (!asks) throw new Error('ask args has no asks object');
  const store = new Map<string, AskRecord>();
  for (const [id, raw] of Object.entries(asks)) {
    const rec = asObject(raw);
    const at = typeof rec?.at === 'string' ? Date.parse(rec.at) : Number.NaN;
    if (!rec || Number.isNaN(at)) throw new Error(`ask args record ${id} is malformed`);
    store.set(id, { at, args: rec.args });
  }
  return store;
}

export function createActivityLog(deps: {
  io: ActivityIo;
  now(): number;
  newId(): string;
  warn(m: string, e?: unknown): void;
}): ActivityLog {
  const { io, warn } = deps;
  const buckets = new Map<string, Bucket>();
  const denies = new Map<string, ActivityEntry>();
  let failedAt: string | null = null;
  const asks = new Map<string, AskRecord>();
  let asksLoaded = false;
  let asksWritable = false;

  const isoNow = (): string => new Date(deps.now()).toISOString();

  function build(e: NewEntry, id: string, at: string): ActivityEntry {
    return {
      v: 1,
      id,
      at,
      lane: e.lane,
      principal: {
        handle: e.principal.handle,
        sessionId: e.principal.sessionId,
        machineId: e.principal.machineId,
      },
      cli: e.cli,
      action: e.action,
      target: e.target,
      summary: e.summary,
      decision: e.decision,
      decidedBy: e.decidedBy,
      outcome: e.outcome,
      durationMs: e.durationMs,
      requestId: e.requestId,
      count: e.count,
    };
  }

  function emit(row: ActivityEntry, nowIso: string): void {
    try {
      if (failedAt !== null) {
        const gap = build(
          {
            lane: 'note',
            principal: { handle: null, sessionId: null, machineId: null },
            cli: null,
            action: 'gap',
            target: null,
            summary: `${failedAt}/${nowIso}`,
            decision: null,
            decidedBy: 'conduit',
            outcome: null,
            durationMs: null,
            requestId: null,
            count: null,
          },
          deps.newId(),
          nowIso,
        );
        io.append(dayOf(nowIso), `${JSON.stringify(gap)}\n`);
        failedAt = null;
      }
      io.append(dayOf(row.at), `${JSON.stringify(row)}\n`);
    } catch (error) {
      if (failedAt === null) {
        failedAt = nowIso;
        warn('activity log write failed', error);
      }
      return;
    }
    if (row.decision === 'deny') {
      denies.set(row.id, row);
      if (denies.size > DENY_WINDOW) {
        const oldest = denies.keys().next().value;
        if (oldest !== undefined) denies.delete(oldest);
      }
    }
  }

  // Load once. Only a missing file starts a writable store; anything unreadable, corrupt or newer
  // is never overwritten (see SERVER_FILE_VERSION and judgePersistedVersion).
  function loadAsks(): void {
    if (asksLoaded) return;
    asksLoaded = true;
    let text: string | null;
    try {
      text = io.readArgs();
    } catch (error) {
      warn('activity ask args unreadable; ask args are not recorded', error);
      return;
    }
    if (text === null) {
      asksWritable = true;
      return;
    }
    try {
      for (const [id, rec] of parseAsks(text)) asks.set(id, rec);
      asksWritable = true;
    } catch (error) {
      warn('activity ask args corrupt or newer; ask args are not recorded', error);
    }
  }

  function prune(nowMs: number): boolean {
    let removed = false;
    for (const [id, rec] of asks) {
      if (nowMs - rec.at > ASK_ARGS_TTL_MS) {
        asks.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  function persistAsks(): void {
    const body: Record<string, { at: string; args: unknown }> = {};
    for (const [id, rec] of asks) body[id] = { at: new Date(rec.at).toISOString(), args: rec.args };
    try {
      io.writeArgs(JSON.stringify({ version: SERVER_FILE_VERSION[ASK_ARGS_FILE], asks: body }));
    } catch (error) {
      warn('activity ask args write failed', error);
    }
  }

  function removeDay(day: string): boolean {
    try {
      io.remove(day);
      return true;
    } catch (error) {
      warn(`activity purge could not remove ${day}`, error);
      return false;
    }
  }

  return {
    record(e) {
      const at = isoNow();
      if (e.lane === 'conduit' && e.decision === 'allow' && COUNTED.has(e.action)) {
        const hour = hourOf(at);
        const key = JSON.stringify([
          e.principal.handle,
          e.principal.sessionId,
          e.principal.machineId,
          e.action,
          e.outcome,
          hour,
        ]);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            id: deps.newId(),
            hour,
            action: e.action,
            principal: e.principal,
            cli: e.cli,
            outcome: e.outcome,
            count: 0,
          };
          buckets.set(key, bucket);
        }
        bucket.count += 1;
        return bucket.id;
      }
      const row = build(e, deps.newId(), at);
      emit(row, at);
      return row.id;
    },

    recordAskArgs(requestId, args) {
      loadAsks();
      if (!asksWritable) return;
      const nowMs = deps.now();
      prune(nowMs);
      asks.set(requestId, { at: nowMs, args });
      persistAsks();
    },

    flushCounts(all) {
      const nowIso = isoNow();
      const current = hourOf(nowIso);
      for (const [key, bucket] of buckets) {
        if (!all && bucket.hour >= current) continue;
        buckets.delete(key);
        emit(
          build(
            {
              lane: 'conduit',
              principal: bucket.principal,
              cli: bucket.cli,
              action: bucket.action,
              target: null,
              summary: null,
              decision: 'allow',
              decidedBy: 'counted',
              outcome: bucket.outcome,
              durationMs: null,
              requestId: null,
              count: bucket.count,
            },
            bucket.id,
            `${bucket.hour}:00:00.000Z`,
          ),
          nowIso,
        );
      }
    },

    purge() {
      const nowMs = deps.now();
      const today = dayOf(isoNow());
      const todayMs = Date.parse(`${today}T00:00:00.000Z`);
      loadAsks();
      if (asksWritable && prune(nowMs)) persistAsks();

      let files: Array<{ day: string; bytes: number }>;
      try {
        files = io.list();
      } catch (error) {
        warn('activity purge could not list day files', error);
        return;
      }
      let total = 0;
      const kept: Array<{ day: string; bytes: number }> = [];
      for (const file of files) {
        if (
          file.day !== today &&
          todayMs - Date.parse(`${file.day}T00:00:00.000Z`) > ACTIVITY_RETENTION_MS
        ) {
          removeDay(file.day);
          continue;
        }
        total += file.bytes;
        kept.push(file);
      }
      kept.sort((a, b) => a.day.localeCompare(b.day));
      // Today's file is being appended to, so it is never deleted; today alone may exceed the cap (plan C4).
      for (const file of kept) {
        if (total <= ACTIVITY_MAX_BYTES) break;
        if (file.day === today) continue;
        if (removeDay(file.day)) total -= file.bytes;
      }
    },

    writable() {
      return failedAt === null;
    },

    recentDenies() {
      return denies;
    },
  };
}

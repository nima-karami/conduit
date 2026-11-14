// Node-free: the renderer imports the row shape. See spec 2026-11-14-policy-and-permissions §4.6.

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
  flushCounts(): void;
  purge(): void;
  writable(): boolean;
  recentDenies(): ReadonlyMap<string, ActivityEntry>;
}

type NewEntry = Omit<ActivityEntry, 'v' | 'id' | 'at'>;
type Principal = ActivityEntry['principal'];
interface Bucket {
  hour: string;
  action: string;
  principal: Principal;
  cli: CliKind | null;
  count: number;
}
interface AskRecord {
  at: number;
  args: unknown;
}

const dayOf = (iso: string): string => iso.slice(0, 10);
const hourOf = (iso: string): string => iso.slice(0, 13);

function isAskRecord(v: unknown): v is AskRecord {
  return typeof v === 'object' && v !== null && typeof (v as AskRecord).at === 'number';
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
  let asks: Map<string, AskRecord> | null = null;

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

  function emit(row: ActivityEntry): void {
    const day = dayOf(row.at);
    try {
      if (failedAt !== null) {
        const gap = build(
          {
            lane: 'note',
            principal: { handle: null, sessionId: null, machineId: null },
            cli: null,
            action: 'gap',
            target: null,
            summary: `${failedAt}/${row.at}`,
            decision: null,
            decidedBy: 'conduit',
            outcome: null,
            durationMs: null,
            requestId: null,
            count: null,
          },
          deps.newId(),
          row.at,
        );
        io.append(day, `${JSON.stringify(gap)}\n`);
        failedAt = null;
      }
      io.append(day, `${JSON.stringify(row)}\n`);
    } catch (error) {
      if (failedAt === null) {
        failedAt = row.at;
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

  function loadAsks(): Map<string, AskRecord> {
    if (asks) return asks;
    asks = new Map();
    let text: string | null;
    try {
      text = io.readArgs();
    } catch (error) {
      warn('activity ask args unreadable', error);
      return asks;
    }
    if (text === null) return asks;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('ask args is not an object');
      }
      for (const [id, rec] of Object.entries(parsed)) {
        if (!isAskRecord(rec)) throw new Error(`ask args record ${id} is malformed`);
        asks.set(id, rec);
      }
    } catch (error) {
      asks = new Map();
      warn('activity ask args corrupt, starting empty', error);
    }
    return asks;
  }

  function prune(store: Map<string, AskRecord>, nowMs: number): boolean {
    let removed = false;
    for (const [id, rec] of store) {
      if (nowMs - rec.at > ASK_ARGS_TTL_MS) {
        store.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  function persistAsks(store: Map<string, AskRecord>): void {
    try {
      io.writeArgs(JSON.stringify(Object.fromEntries(store)));
    } catch (error) {
      warn('activity ask args write failed', error);
    }
  }

  return {
    record(e) {
      const at = isoNow();
      if (e.lane === 'conduit' && e.decision === 'allow' && COUNTED.has(e.action)) {
        const hour = hourOf(at);
        const key = JSON.stringify([e.principal.sessionId, e.action, hour]);
        const bucket = buckets.get(key) ?? {
          hour,
          action: e.action,
          principal: e.principal,
          cli: e.cli,
          count: 0,
        };
        bucket.count += 1;
        buckets.set(key, bucket);
        return deps.newId();
      }
      const row = build(e, deps.newId(), at);
      emit(row);
      return row.id;
    },

    recordAskArgs(requestId, args) {
      const store = loadAsks();
      const nowMs = deps.now();
      prune(store, nowMs);
      store.set(requestId, { at: nowMs, args });
      persistAsks(store);
    },

    flushCounts() {
      const current = hourOf(isoNow());
      for (const [key, bucket] of buckets) {
        if (bucket.hour >= current) continue;
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
              outcome: 'ok',
              durationMs: null,
              requestId: null,
              count: bucket.count,
            },
            deps.newId(),
            isoNow(),
          ),
        );
      }
    },

    purge() {
      const nowMs = deps.now();
      const today = dayOf(isoNow());
      const todayMs = Date.parse(`${today}T00:00:00.000Z`);
      const store = loadAsks();
      if (prune(store, nowMs)) persistAsks(store);

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

  function removeDay(day: string): boolean {
    try {
      io.remove(day);
      return true;
    } catch (error) {
      warn(`activity purge could not remove ${day}`, error);
      return false;
    }
  }
}

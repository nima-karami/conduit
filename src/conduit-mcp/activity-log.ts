// see spec 2026-11-14-policy-and-permissions §4.6

import { judgePersistedVersion, SERVER_FILE_VERSION } from '../contracts/session-identity';
import {
  type ActivityPage,
  type ActivityQuery,
  activityCursor,
  activityMatches,
  compareActivityRows,
  isActivityDay,
  parseActivityEntry,
  parseActivityQuery,
  parseActivityTrace,
} from './activity-query';
import type { ActivityDecisionTraceV1, Decision } from './policy-types';
import type { CliKind, ToolName } from './tool-policy';

export type ActivityLane = 'conduit' | 'observed' | 'note';
export type ActivityOutcome =
  | 'ok'
  | 'error'
  | 'denied'
  | 'refused'
  | 'expired'
  | 'withdrawn'
  | 'asked'
  | null;

export interface ActivityEntry {
  v: 1;
  id: string;
  at: string;
  lane: ActivityLane;
  principal: {
    handle: string | null;
    sessionId: string | null;
    machineId: string | null;
  };
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
  trace?: ActivityDecisionTraceV1;
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
  read(day: string, maxBytes: number): string;
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
  query(input: ActivityQuery): ActivityPage;
  recentDenies(): ReadonlyMap<string, ActivityEntry>;
  lookup(id: string, at: string): ActivityLookup;
  replaySample(eligible?: (row: ActivityEntry, invalidTrace: boolean) => boolean): ActivitySample;
}

export type ActivityLookup =
  | { ok: true; row: ActivityEntry }
  | { ok: false; error: 'invalid-value' | 'not-found' | 'unavailable' };
export type ActivitySample =
  | { ok: true; rows: ActivityEntry[]; truncated: boolean; since: string }
  | { ok: false; error: 'unavailable' };

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
    const trace = e.lane === 'conduit' && e.count === null ? parseActivityTrace(e.trace) : null;
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
      ...(trace === null ? {} : { trace }),
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

  const countedRow = (bucket: Bucket): ActivityEntry =>
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
    );

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
      io.writeArgs(
        JSON.stringify({
          version: SERVER_FILE_VERSION[ASK_ARGS_FILE],
          asks: body,
        }),
      );
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

  function visit(
    nowMs: number,
    take: (row: ActivityEntry, invalidTrace: boolean) => void,
  ): string | null {
    const now = new Date(nowMs).toISOString();
    const today = dayOf(now);
    const firstDay = dayOf(new Date(nowMs - 29 * 86_400_000).toISOString());
    let files: Array<{ day: string; bytes: number }>;
    try {
      files = io.list();
    } catch {
      return 'Activity day files could not be read';
    }
    if (
      files.some((f) => !isActivityDay(f.day) || !Number.isSafeInteger(f.bytes) || f.bytes < 0) ||
      new Set(files.map((f) => f.day)).size !== files.length
    )
      return 'Activity day listing is corrupt';
    const days = files
      .filter((f) => f.day >= firstDay && f.day <= today)
      .sort((a, b) => b.day.localeCompare(a.day));
    let remaining = ACTIVITY_MAX_BYTES;
    for (const file of days) {
      if (file.bytes > remaining) return 'Activity exceeds the read budget';
      let text: string;
      try {
        text = io.read(file.day, remaining);
      } catch {
        return 'Activity day could not be read within the byte budget';
      }
      remaining -= Buffer.byteLength(text);
      if (remaining < 0) return 'Activity exceeds the read budget';
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.length === 0 && index === lines.length - 1) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          return 'Activity contains a corrupt row';
        }
        const row = parseActivityEntry(raw);
        if (row === null || dayOf(row.at) !== file.day) return 'Activity contains a corrupt row';
        take(
          row,
          typeof raw === 'object' && raw !== null && 'trace' in raw && row.trace === undefined,
        );
      }
    }
    for (const bucket of buckets.values()) {
      const row = countedRow(bucket);
      if (dayOf(row.at) >= firstDay && dayOf(row.at) <= today) take(row, false);
    }
    return null;
  }

  function insert(selected: ActivityEntry[], row: ActivityEntry, limit: number): void {
    let low = 0;
    let high = selected.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareActivityRows(selected[mid], row) < 0) low = mid + 1;
      else high = mid;
    }
    selected.splice(low, 0, row);
    if (selected.length > limit) selected.pop();
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
            principal: { ...e.principal },
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
        emit(countedRow(bucket), nowIso);
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

    query(input) {
      const writable = failedAt === null;
      const fail = (error: string): ActivityPage => ({
        rows: [],
        next: null,
        writable,
        error,
      });
      const query = parseActivityQuery(input);
      if (query === null) return fail('Invalid Activity query');
      const limit = query.limit ?? 100;
      const selected: ActivityEntry[] = [];
      const nowMs = deps.now();
      const now = new Date(nowMs).toISOString();
      const error = visit(nowMs, (row) => {
        if (row.at <= now && activityMatches(row, query)) insert(selected, row, limit + 1);
      });
      if (error !== null) return fail(error);
      const rows = selected.slice(0, limit);
      return {
        rows,
        next: selected.length > limit ? activityCursor(rows[rows.length - 1]) : null,
        writable,
        error: null,
      };
    },

    lookup(id, at) {
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > 512 ||
        /\p{Cc}/u.test(id) ||
        typeof at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at) ||
        !Number.isFinite(Date.parse(at)) ||
        new Date(at).toISOString() !== at
      )
        return { ok: false, error: 'invalid-value' };
      const nowMs = deps.now();
      const now = new Date(nowMs).toISOString();
      let found: ActivityEntry | null = null;
      let matches = 0;
      let gap = failedAt !== null;
      const error = visit(nowMs, (row) => {
        if (row.lane === 'note' && row.action === 'gap') gap = true;
        if (row.id === id) {
          matches++;
          if (row.at === at && row.at <= now) found = row;
        }
      });
      if (error !== null || gap || matches > 1) return { ok: false, error: 'unavailable' };
      if (found === null) return { ok: false, error: 'not-found' };
      return { ok: true, row: found };
    },

    replaySample(eligible = () => true) {
      const nowMs = deps.now();
      const since = new Date(nowMs - 7 * 86_400_000).toISOString();
      const selected: ActivityEntry[] = [];
      const ids = new Set<string>();
      let ambiguous = failedAt !== null;
      const error = visit(nowMs, (row, invalidTrace) => {
        if (row.lane === 'note' && row.action === 'gap') ambiguous = true;
        if (ids.has(row.id)) ambiguous = true;
        ids.add(row.id);
        if (
          row.at >= since &&
          row.at <= new Date(nowMs).toISOString() &&
          eligible(row, invalidTrace)
        )
          insert(selected, row, 1001);
      });
      if (error !== null || ambiguous) return { ok: false, error: 'unavailable' };
      return {
        ok: true,
        rows: selected,
        truncated: selected.length > 1000,
        since,
      };
    },

    writable() {
      return failedAt === null;
    },

    recentDenies() {
      return denies;
    },
  };
}

import { folderKey } from './folder-key';
import type { Session } from './types';

/** `unknown`: the stat could not be issued within the check's window (the cap was saturated). */
export type FolderState = 'present' | 'missing' | 'unknown';

export interface FolderHealthReport {
  sessionId: string;
  homeKey: string;
  states: Map<string, FolderState>;
}

export type Bounded = <T>(work: () => Promise<T>) => Promise<T | undefined>;

export interface FolderHealthDeps {
  isDir: (p: string) => Promise<boolean>;
  get: (id: string) => Session | undefined;
  sessions: () => readonly Session[];
  /** Awaited, so `pending()` and the poll decision both see the marks it applies. */
  apply: (r: FolderHealthReport, bounded: Bounded) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
  maxInFlight?: number;
}

type Measured = Promise<'present' | 'missing'>;

interface Stat {
  path: string;
  result?: Measured;
  onIssue: ((result: Measured) => void)[];
}

/** Capped async existence checks + the reconnect poll; see mf-model spec §2.6 "Health check". */
export class FolderHealth {
  private readonly stats = new Map<string, Stat>();
  private readonly queue: (() => void)[] = [];
  private outstanding = 0;
  private readonly checks = new Map<string, Set<Promise<void>>>();
  private generation = 0;
  private readonly applying = new Map<string, Promise<void>>();
  private readonly measuredGen = new Map<string, Map<string, number>>();
  private poll: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly maxInFlight: number;

  constructor(private readonly deps: FolderHealthDeps) {
    this.timeoutMs = deps.timeoutMs ?? 3000;
    this.pollMs = deps.pollMs ?? 5000;
    this.maxInFlight = deps.maxInFlight ?? 2;
  }

  check(sessionId: string, only?: readonly string[]): Promise<void> {
    const s = this.deps.get(sessionId);
    if (!s || this.disposed) return Promise.resolve();
    const onlyKeys = only && new Set(only.map(folderKey));
    const folders = new Map<string, string>();
    for (const f of [s.home, ...s.roots]) {
      const key = folderKey(f);
      if (!folders.has(key) && (!onlyKeys || onlyKeys.has(key))) folders.set(key, f);
    }
    if (folders.size === 0) return Promise.resolve();
    const homeKey = folderKey(s.home);
    const gen = ++this.generation;
    const run = this.measure(folders)
      .then((states) => this.applyInOrder(sessionId, gen, homeKey, states))
      .finally(() => {
        const set = this.checks.get(sessionId);
        set?.delete(run);
        if (set?.size === 0) {
          this.checks.delete(sessionId);
          this.applying.delete(sessionId);
          this.measuredGen.delete(sessionId);
        }
        this.syncPoll();
      });
    const set = this.checks.get(sessionId) ?? new Set();
    set.add(run);
    this.checks.set(sessionId, set);
    return run;
  }

  pending(sessionId: string): Promise<void> | undefined {
    const set = this.checks.get(sessionId);
    return set ? Promise.all(set).then(() => undefined) : undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  // Checks overlap (a poll tick, a focus) and settle in any order; applying one at a time and
  // dropping each key a newer check already measured keeps a stale 'missing' from re-marking.
  private applyInOrder(
    sessionId: string,
    gen: number,
    homeKey: string,
    states: Map<string, FolderState>,
  ): Promise<void> {
    const go = () => {
      if (this.disposed) return;
      const seen = this.measuredGen.get(sessionId) ?? new Map<string, number>();
      this.measuredGen.set(sessionId, seen);
      const fresh = new Map<string, FolderState>();
      for (const [key, state] of states) {
        if ((seen.get(key) ?? 0) > gen) continue;
        fresh.set(key, state);
        if (state !== 'unknown') seen.set(key, gen);
      }
      return this.deps.apply(
        { sessionId, homeKey, states: fresh },
        this.bounded(Date.now() + this.timeoutMs),
      );
    };
    const prior = this.applying.get(sessionId);
    const next = prior ? prior.then(go, go) : Promise.resolve().then(go);
    this.applying.set(sessionId, next);
    return next;
  }

  private measure(folders: Map<string, string>): Promise<Map<string, FolderState>> {
    return new Promise((resolve) => {
      const got = new Map<string, FolderState>();
      const issued = new Set<string>();
      const settle = (key: string, state: FolderState) => {
        if (got.has(key)) return;
        got.set(key, state);
        if (got.size < folders.size) return;
        clearTimeout(deadline);
        resolve(new Map([...folders.keys()].map((k) => [k, got.get(k) ?? 'unknown'])));
      };
      const deadline = setTimeout(() => {
        for (const key of folders.keys()) if (!issued.has(key)) settle(key, 'unknown');
      }, this.timeoutMs);
      for (const [key, path] of folders) {
        const onIssue = (result: Measured) => {
          issued.add(key);
          void result.then((state) => settle(key, state));
        };
        const stat = this.stat(key, path);
        if (stat.result) onIssue(stat.result);
        else stat.onIssue.push(onIssue);
      }
    });
  }

  private stat(key: string, path: string): Stat {
    const existing = this.stats.get(key);
    if (existing) return existing;
    const stat: Stat = { path, onIssue: [] };
    this.stats.set(key, stat);
    this.queue.push(() => {
      const result: Measured = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('missing'), this.timeoutMs);
        void this.deps
          .isDir(stat.path)
          .then(
            (ok) => ok,
            () => false,
          )
          .then((ok) => {
            clearTimeout(timer);
            resolve(ok ? 'present' : 'missing');
            this.stats.delete(key);
            this.release();
          });
      });
      stat.result = result;
      for (const cb of stat.onIssue.splice(0)) cb(result);
    });
    this.pump();
    return stat;
  }

  // apply's revalidate/realpath touch the same shares and `pending()` waits on apply, so they take
  // the same slots and one window for the whole apply; `undefined` = not done in time (S3).
  private bounded(deadline: number): Bounded {
    return <T>(work: () => Promise<T>) =>
      new Promise<T | undefined>((resolve, reject) => {
        const issue = () => {
          void work()
            .then(resolve, reject)
            .finally(() => {
              clearTimeout(timer);
              this.release();
            });
        };
        const timer = setTimeout(
          () => {
            const queued = this.queue.indexOf(issue);
            if (queued >= 0) this.queue.splice(queued, 1);
            resolve(undefined);
          },
          Math.max(0, deadline - Date.now()),
        );
        this.queue.push(issue);
        this.pump();
      });
  }

  // A timed-out stat or apply op keeps its slot until it settles: a hung share must not pile
  // more work onto libuv's pool, which persistFile shares (S3).
  private pump() {
    while (this.outstanding < this.maxInFlight) {
      const issue = this.queue.shift();
      if (!issue) return;
      this.outstanding++;
      issue();
    }
  }

  private release() {
    this.outstanding--;
    this.pump();
  }

  private syncPoll() {
    const anyMissing = this.deps
      .sessions()
      .some((s) => s.homeMissing === true || (s.missingRoots?.length ?? 0) > 0);
    if (anyMissing && !this.poll && !this.disposed) {
      this.poll = setInterval(() => this.tick(), this.pollMs);
    } else if (!anyMissing && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  private tick() {
    for (const s of this.deps.sessions()) {
      const missing = [...(s.homeMissing ? [s.home] : []), ...(s.missingRoots ?? [])];
      if (missing.length > 0) void this.check(s.id, missing);
    }
    this.syncPoll();
  }
}

/** The marks a report implies; see mf-model plan Contracts "src/folder-health.ts". */
export function applyHealthReport(
  s: Pick<Session, 'home' | 'roots' | 'missingRoots' | 'homeMissing'>,
  r: FolderHealthReport,
  rejected: ReadonlySet<string>,
): { homeKey: string; missingRoots: string[]; homeMissing: boolean } {
  const missing = new Set((s.missingRoots ?? []).map(folderKey));
  for (const [key, state] of r.states) {
    if (state === 'missing') missing.add(key);
    else if (state === 'present' && !rejected.has(key)) missing.delete(key);
  }
  let homeMissing = s.homeMissing === true;
  const homeState = r.homeKey === folderKey(s.home) ? r.states.get(r.homeKey) : undefined;
  if (homeState === 'missing') homeMissing = true;
  else if (homeState === 'present' && !rejected.has(r.homeKey)) homeMissing = false;
  return {
    homeKey: r.homeKey,
    missingRoots: s.roots.filter((x) => missing.has(folderKey(x))),
    homeMissing,
  };
}

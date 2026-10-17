/**
 * Renderer cache for terminal link tokens resolved by the host (paths, commits). Batched requests
 * settle together; path entries are scoped by `cwd\0rootsSig` and expire. See plan
 * 2026-10-16-terminal-path-links Contracts "Cache" and Decisions "The cache is scoped".
 */

interface Pending<T> {
  promise: Promise<T | undefined>;
  resolve(value: T | undefined): void;
  timer: ReturnType<typeof setTimeout>;
  batchId: number;
}

interface Entry<T> {
  value: T;
  at: number;
}

interface Batch {
  generation: number;
  /** Lookup key → the bare token the host answers by. */
  waiting: Map<string, string>;
}

export interface TerminalTokenCacheOptions<T> {
  capacity: number;
  timeoutMs: number;
  /** Entries older than this are misses; none = no expiry (the commit cache). */
  ttlMs?: number;
  now?: () => number;
  /** Negative answers (the path cache's 0 candidates) live at most `ttlMs` and are the only
   *  values a stale-generation settle drops. */
  negative?: { is: (value: T) => boolean; ttlMs: number };
}

const keyOf = (scope: string, token: string) => `${scope}\0${token}`;

export function createTerminalTokenCache<T>(
  request: (batch: { id: number; tokens: string[] }) => void,
  opts: TerminalTokenCacheOptions<T>,
) {
  const { capacity, timeoutMs, ttlMs, negative } = opts;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, Entry<T>>();
  const pending = new Map<string, Pending<T>>();
  const batches = new Map<number, Batch>();
  let nextBatchId = 1;
  // Bumped by clear() and evictWhere(): a batch sent before then may carry a "not there" that is
  // no longer true (a file appeared), so its negative answers are not stored.
  let generation = 0;
  let disposed = false;

  const finish = (key: string, value: T | undefined) => {
    const wait = pending.get(key);
    if (!wait) return;
    clearTimeout(wait.timer);
    pending.delete(key);
    const batch = batches.get(wait.batchId);
    if (batch) {
      batch.waiting.delete(key);
      if (batch.waiting.size === 0) batches.delete(wait.batchId);
    }
    wait.resolve(value);
  };

  const store = (key: string, value: T) => {
    cache.delete(key);
    cache.set(key, { value, at: now() });
    while (cache.size > capacity) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const lookup = (key: string): Entry<T> | undefined => {
    const entry = cache.get(key);
    if (!entry) return undefined;
    const ttl = negative?.is(entry.value) ? negative.ttlMs : ttlMs;
    if (ttl !== undefined && now() - entry.at >= ttl) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  };

  return {
    /** Looks up `scope\0token`; requests the misses as ONE batch of bare tokens. */
    async get(tokens: string[], scope = ''): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      if (disposed) return result;
      const id = nextBatchId;
      const needed: string[] = [];
      const waits = tokens.map(async (token) => {
        const key = keyOf(scope, token);
        const hit = lookup(key);
        if (hit) {
          result.set(token, hit.value);
          return;
        }
        let wait = pending.get(key);
        if (!wait) {
          let settle: (value: T | undefined) => void = () => {};
          const promise = new Promise<T | undefined>((resolve) => {
            settle = resolve;
          });
          wait = {
            promise,
            resolve: settle,
            timer: setTimeout(() => finish(key, undefined), timeoutMs),
            batchId: id,
          };
          pending.set(key, wait);
          let batch = batches.get(id);
          if (!batch) {
            batch = { generation, waiting: new Map() };
            batches.set(id, batch);
          }
          batch.waiting.set(key, token);
          needed.push(token);
        }
        const value = await wait.promise;
        if (value !== undefined) result.set(token, value);
      });
      if (needed.length) {
        nextBatchId += 1;
        request({ id, tokens: needed });
      }
      await Promise.all(waits);
      return result;
    },
    /** A batch reply: stores each value under `replyScope\0token` (the scope the host actually
     *  resolved against), then settles every pending token of batch `id` — absent ones as
     *  uncached misses. A stale-generation (or unknown) batch stores only its positives. */
    settle(id: number, replyScope: string, values: Map<string, T>) {
      if (disposed) return;
      const batch = batches.get(id);
      const stale = !batch || batch.generation !== generation;
      for (const [token, value] of values) {
        if (stale && negative?.is(value)) continue;
        store(keyOf(replyScope, token), value);
      }
      if (!batch) return;
      for (const [key, token] of [...batch.waiting]) finish(key, values.get(token));
    },
    /** Unbatched reply (the commit cache): store + settle by token, scope ''. */
    resolve(token: string, value: T) {
      if (disposed) return;
      const key = keyOf('', token);
      store(key, value);
      finish(key, value);
    },
    evict(token: string, scope = '') {
      cache.delete(keyOf(scope, token));
    },
    /** Drops matching values and bumps the generation. */
    evictWhere(pred: (value: T) => boolean) {
      for (const [key, entry] of [...cache]) if (pred(entry.value)) cache.delete(key);
      generation += 1;
    },
    /** Drops every value and bumps the generation. */
    clear() {
      cache.clear();
      generation += 1;
    },
    dispose() {
      disposed = true;
      for (const key of [...pending.keys()]) finish(key, undefined);
      cache.clear();
      batches.clear();
    },
  };
}

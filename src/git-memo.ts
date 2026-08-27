/**
 * Bounded, TTL'd memo for cheap-but-repeated git interrogations (`rev-parse --show-toplevel`,
 * `rev-parse HEAD`). The PROMISE is cached rather than the value, so N callers arriving in the
 * same tick — which is exactly what one `fsChanged` with N open editors produces — share a
 * single spawn instead of racing N of them. See spec 2026-08-27-review-supercharge §2 Lane A.
 */

export interface AsyncMemo<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
}

interface Entry<T> {
  at: number;
  value: Promise<T>;
}

export function createAsyncMemo<T>({
  ttlMs,
  max,
  now = Date.now,
}: {
  ttlMs: number;
  max: number;
  now?: () => number;
}): AsyncMemo<T> {
  const entries = new Map<string, Entry<T>>();

  return {
    get(key, load) {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;

      const value = load();
      const entry: Entry<T> = { at: now(), value };
      entries.set(key, entry);
      // A failure must not be remembered — the next caller retries rather than inheriting it.
      value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}

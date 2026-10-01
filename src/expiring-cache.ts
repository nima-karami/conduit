export interface ExpiringCacheOptions<V> {
  maxEntries: number;
  maxBytes?: number;
  sizeOf?: (value: V) => number;
  ttlMs: number;
  clock?: () => number;
}

interface CacheEntry<V> {
  value: V;
  bytes: number;
  expiresAt: number;
}

export class ExpiringCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private bytes = 0;
  private readonly clock: () => number;
  private readonly maxBytes: number;

  constructor(private readonly options: ExpiringCacheOptions<V>) {
    this.clock = options.clock ?? Date.now;
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    if (
      !Number.isInteger(options.maxEntries) ||
      options.maxEntries < 0 ||
      !Number.isFinite(options.ttlMs) ||
      options.ttlMs < 0 ||
      (options.maxBytes !== undefined &&
        (!Number.isFinite(options.maxBytes) || options.maxBytes < 0))
    ) {
      throw new RangeError('Invalid cache bounds');
    }
    if (options.maxBytes !== undefined && !options.sizeOf) {
      throw new TypeError('A byte-bounded cache requires sizeOf');
    }
  }

  get size(): number {
    this.prune(this.clock());
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): this {
    const now = this.clock();
    const bytes = this.options.sizeOf?.(value) ?? 0;
    if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('Invalid cache entry size');
    this.prune(now);
    this.delete(key);
    if (bytes > this.maxBytes || this.options.maxEntries === 0 || this.options.ttlMs === 0)
      return this;
    this.entries.set(key, { value, bytes, expiresAt: now + this.options.ttlMs });
    this.bytes += bytes;
    while (this.entries.size > this.options.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.bytes -= entry.bytes;
    return this.entries.delete(key);
  }

  keys(): MapIterator<K> {
    this.prune(this.clock());
    return this.entries.keys();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.delete(key);
    }
  }
}

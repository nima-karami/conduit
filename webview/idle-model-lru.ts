/**
 * Closed tabs keep their Monaco model for cross-file resolution; this bounds how many idle ones
 * stay. Oldest-idle goes first; a model shown again leaves the queue.
 */
export function createIdleLru<K>(cap: number, evict: (key: K) => void) {
  const idle = new Set<K>();
  return {
    markIdle(key: K) {
      idle.delete(key);
      idle.add(key);
      for (const k of idle) {
        if (idle.size <= cap) break;
        idle.delete(k);
        evict(k);
      }
    },
    markActive(key: K) {
      idle.delete(key);
    },
    size: () => idle.size,
  };
}

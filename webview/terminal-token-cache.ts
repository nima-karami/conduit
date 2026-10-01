interface Pending<T> {
  promise: Promise<T | undefined>;
  resolve(value: T | undefined): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createTerminalTokenCache<T>(
  request: (tokens: string[]) => void,
  { capacity, timeoutMs }: { capacity: number; timeoutMs: number },
) {
  const cache = new Map<string, T>();
  const pending = new Map<string, Pending<T>>();
  let disposed = false;
  const finish = (token: string, value: T | undefined) => {
    const wait = pending.get(token);
    if (!wait) return;
    clearTimeout(wait.timer);
    pending.delete(token);
    wait.resolve(value);
  };
  return {
    resolve(token: string, value: T) {
      if (disposed) return;
      cache.delete(token);
      cache.set(token, value);
      while (cache.size > capacity) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      finish(token, value);
    },
    async get(tokens: string[]): Promise<Map<string, T>> {
      const result = new Map<string, T>();
      if (disposed) return result;
      const needed: string[] = [];
      const waits = tokens.map(async (token) => {
        if (cache.has(token)) {
          const value = cache.get(token) as T;
          cache.delete(token);
          cache.set(token, value);
          result.set(token, value);
          return;
        }
        let wait = pending.get(token);
        if (!wait) {
          let settle: (value: T | undefined) => void = () => {};
          const promise = new Promise<T | undefined>((resolve) => {
            settle = resolve;
          });
          wait = {
            promise,
            resolve: settle,
            timer: setTimeout(() => finish(token, undefined), timeoutMs),
          };
          pending.set(token, wait);
          needed.push(token);
        }
        const value = await wait.promise;
        if (value !== undefined) result.set(token, value);
      });
      if (needed.length) request(needed);
      await Promise.all(waits);
      return result;
    },
    dispose() {
      disposed = true;
      for (const token of pending.keys()) finish(token, undefined);
      cache.clear();
    },
  };
}

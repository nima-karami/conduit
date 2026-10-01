export function asyncSingleFlight<T>(
  run: (root: string) => Promise<T>,
  keyFor: (root: string) => string = (root) => root,
): (root: string) => Promise<T> {
  const pending = new Map<string, Promise<T>>();
  return (root) => {
    const key = keyFor(root);
    const existing = pending.get(key);
    if (existing) return existing;
    const promise = run(root).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}

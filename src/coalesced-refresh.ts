/** Requests during a refresh share a fresh follow-up, rather than its possibly stale result. */
export function coalescedRefresh<A extends unknown[], R>(
  run: (...args: A) => Promise<R>,
  key: (...args: A) => string,
): (...args: A) => Promise<R> {
  type Pending = {
    args: A;
    resolve: (value: R) => void;
    reject: (error: unknown) => void;
    promise: Promise<R>;
  };
  type Entry = { pending?: Pending };
  const entries = new Map<string, Entry>();
  const execute = async (id: string, entry: Entry, args: A): Promise<R> => {
    try {
      return await run(...args);
    } finally {
      const pending = entry.pending;
      entry.pending = undefined;
      if (pending) void execute(id, entry, pending.args).then(pending.resolve, pending.reject);
      else entries.delete(id);
    }
  };
  return (...args) => {
    const id = key(...args);
    const existing = entries.get(id);
    if (!existing) {
      const entry: Entry = {};
      entries.set(id, entry);
      return execute(id, entry, args);
    }
    if (existing.pending) {
      existing.pending.args = args;
      return existing.pending.promise;
    }
    let resolve!: Pending['resolve'];
    let reject!: Pending['reject'];
    const promise = new Promise<R>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    existing.pending = { args, resolve, reject, promise };
    return promise;
  };
}

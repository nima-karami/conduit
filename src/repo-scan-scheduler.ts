export function createRepoScanScheduler<T>(deps: {
  scan: (sessionId: string) => Promise<T>;
  apply: (sessionId: string, result: T) => void;
  onError: (sessionId: string, error: unknown) => void;
}) {
  type Scan = {
    version: number;
    running: boolean;
    dirty: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };
  const scans = new Map<string, Scan>();
  const run = async (id: string, entry: Scan) => {
    entry.running = true;
    entry.dirty = false;
    const version = entry.version;
    try {
      const result = await deps.scan(id);
      if (scans.get(id) === entry && entry.version === version) deps.apply(id, result);
    } catch (error) {
      deps.onError(id, error);
    } finally {
      entry.running = false;
      if (scans.get(id) === entry && !entry.timer) {
        if (entry.dirty) void run(id, entry);
        else scans.delete(id);
      }
    }
  };
  return {
    schedule(id: string) {
      const entry = scans.get(id) ?? { version: 0, running: false, dirty: false };
      scans.set(id, entry);
      entry.version++;
      entry.dirty = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (!entry.running) void run(id, entry);
      }, 150);
    },
    forget(id: string) {
      const entry = scans.get(id);
      if (entry?.timer) clearTimeout(entry.timer);
      scans.delete(id);
    },
  };
}

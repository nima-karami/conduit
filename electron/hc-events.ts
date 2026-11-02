import type { HcClient, HcEvent, HcNotification, HcTerminal } from '../src/contracts/hc';
import type { AppLog } from './server-client';

type TerminalEvent = Exclude<HcEvent, { type: 'unknown' }>;

/**
 * The app's one hc subscription (the start rule, F6/F9 watches and C5 size all read it). The hc
 * client never restores a subscription itself, so this re-subscribes on missed, ended and every
 * (re)connection; an older attempt still in flight is closed when it lands.
 */
export function createHcEvents(
  hc: HcClient,
  labels: Record<string, string>,
  log: AppLog,
): {
  on(terminal: string, cb: (e: HcEvent) => void): () => void;
  onSnapshot(cb: (terminals: HcTerminal[]) => void): () => void;
  ready(): Promise<void>;
  close(): void;
} {
  const listeners = new Map<string, Set<(e: HcEvent) => void>>();
  const snapshotListeners = new Set<(terminals: HcTerminal[]) => void>();
  let attempt = 0;
  let current: { close(): void } | undefined;
  let inFlight = false;
  let closed = false;
  let markReady = () => {};
  const readyP = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const dispatch = (e: TerminalEvent) => {
    for (const cb of [...(listeners.get(e.terminal) ?? [])]) {
      try {
        cb(e);
      } catch (error) {
        log('error', 'hc-events: listener threw', { type: e.type, err: String(error) });
      }
    }
  };

  const subscribe = () => {
    if (closed) return;
    const mine = ++attempt;
    current?.close();
    current = undefined;
    inFlight = true;
    const onNotification = (n: HcNotification) => {
      if (mine !== attempt) return;
      if (n.method === 'event') {
        if (n.params.type !== 'unknown') dispatch(n.params);
      } else if (n.method === 'missed' || n.method === 'ended') subscribe();
    };
    hc.subscribe({ labels }, onNotification).then(
      (sub) => {
        if (mine === attempt) inFlight = false;
        if (mine !== attempt || closed) {
          sub.close();
          return;
        }
        current = sub;
        for (const cb of [...snapshotListeners]) {
          try {
            cb(sub.snapshot);
          } catch (error) {
            log('error', 'hc-events: snapshot listener threw', { err: String(error) });
          }
        }
        markReady();
      },
      (error: unknown) => {
        if (mine !== attempt) return;
        inFlight = false;
        // The next connection event subscribes again.
        if (!closed) log('warn', 'hc-events: subscribe failed', { err: String(error) });
      },
    );
  };

  // Seqs restart with a reconnected core; a first connect only matters if the first attempt failed.
  const offConnection = hc.onConnection((state) => {
    if (state === 'reconnected' || (state === 'connected' && !current && !inFlight)) subscribe();
  });
  subscribe();

  return {
    onSnapshot(cb) {
      snapshotListeners.add(cb);
      return () => snapshotListeners.delete(cb);
    },
    on(terminal, cb) {
      let set = listeners.get(terminal);
      if (!set) {
        set = new Set();
        listeners.set(terminal, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0 && listeners.get(terminal) === set) listeners.delete(terminal);
      };
    },
    ready: () => readyP,
    close() {
      closed = true;
      offConnection();
      current?.close();
      current = undefined;
      listeners.clear();
      snapshotListeners.clear();
    },
  };
}

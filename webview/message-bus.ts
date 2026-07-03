/**
 * Buffered host→renderer pub/sub. Messages that arrive before any subscriber exists are held,
 * then — once subscribers appear — delivered to EVERY subscriber in arrival order.
 *
 * Why fan the backlog out to all, not the first subscriber: the host replies to `ready` with a
 * one-shot `state` almost immediately, sometimes before React has mounted. React runs a child's
 * effects before its parent's, so a state-ignoring child (the file tree / search pane) can
 * subscribe first. The original drain-to-the-first-subscriber buffer let that child swallow the
 * initial `state`, so App's hydrate handler — mounting a beat later — got nothing and the app
 * stayed on default settings with empty sessions until the next broadcast (visible after a
 * cold update-relaunch). Deferring the flush by one microtask lets every synchronously-mounted
 * subscriber register first, then delivers the backlog to all of them, in order.
 */
export interface MessageBus<T> {
  emit(msg: T): void;
  subscribe(cb: (msg: T) => void): () => void;
}

export function createMessageBus<T>(
  schedule: (fn: () => void) => void = queueMicrotask,
): MessageBus<T> {
  const listeners = new Set<(msg: T) => void>();
  const pending: T[] = [];
  let flushScheduled = false;

  // Snapshot listeners so a subscribe/unsubscribe triggered mid-delivery can't disturb iteration.
  const deliver = (msg: T) => {
    for (const l of [...listeners]) l(msg);
  };

  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    schedule(() => {
      flushScheduled = false;
      while (pending.length > 0) deliver(pending.shift() as T);
    });
  };

  return {
    emit(msg) {
      // Keep buffering while a backlog is still draining (or before anyone listens) so the
      // startup burst reaches every subscriber in order, not just the first one to mount.
      if (listeners.size === 0 || pending.length > 0) {
        pending.push(msg);
        if (listeners.size > 0) scheduleFlush();
        return;
      }
      deliver(msg);
    },
    subscribe(cb) {
      listeners.add(cb);
      if (pending.length > 0) scheduleFlush();
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

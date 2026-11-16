import type { ServerEvents, ServerMethods } from '../src/contracts/server-protocol';
import type { HostToWebview, WebviewToHost } from '../src/protocol';
import { faultCode } from './server-calls';
import type { ServerCallOptions } from './server-client';

export type RemoteFsMethod =
  | 'remote.fs.list'
  | 'remote.fs.read'
  | 'remote.fs.write'
  | 'remote.fs.stat'
  | 'remote.fs.watch'
  | 'remote.fs.unwatch';
export type RemoteFilesMethod = RemoteFsMethod | 'remote.git';
type Message<T extends WebviewToHost['type']> = Extract<WebviewToHost, { type: T }>;

/** B bounds its own git read at 30 s; C2 waits longer so B's answer, not our timeout, is what the window gets. */
const GIT_TIMEOUT_MS = 35_000;

/** A's file client gives B 30 s for an fs.res (server/network/fs-client.ts FS_REQ_MS); C2 waits a little longer, as for git. */
const WRITE_TIMEOUT_MS = 35_000;

export interface RemoteFilesDeps {
  call<M extends RemoteFilesMethod>(
    method: M,
    params: ServerMethods[M]['params'],
    opts?: ServerCallOptions,
  ): Promise<ServerMethods[M]['result']>;
  sendTo(windowId: number, message: HostToWebview): void;
  log(level: 'info' | 'warn', message: string, data?: Record<string, unknown>): void;
}

export type RemoteFiles = ReturnType<typeof createRemoteFiles>;

/** A watch a window asked for. `watchId` is unset until B's reply lands (see plan CON-43 decision 9). */
interface Watch {
  windowId: number;
  key: string;
  watchId?: string;
  /** Set when the watch is replaced or its window closes, so a reply that lands later is unwatched. */
  released: boolean;
}

/** Routes the remote Files view's listings, reads and watches; the window that watched a key owns it. */
export function createRemoteFiles(d: RemoteFilesDeps) {
  /** windowId → key → the watch that window holds under that key. Keys are scoped to their window. */
  const byWindow = new Map<number, Map<string, Watch>>();
  /** watchId → its watch: the only route for B's change events. */
  const byWatchId = new Map<string, Watch>();

  const unwatchOverC2 = async (watchId: string): Promise<void> => {
    try {
      await d.call('remote.fs.unwatch', { watchId });
    } catch (error) {
      d.log('warn', 'remote unwatch failed', { watchId, err: String(error) });
    }
  };

  const release = (watch: Watch): void => {
    watch.released = true;
    const keys = byWindow.get(watch.windowId);
    if (keys?.get(watch.key) === watch) keys.delete(watch.key);
    if (watch.watchId === undefined) return;
    byWatchId.delete(watch.watchId);
    void unwatchOverC2(watch.watchId);
  };

  const list = async (windowId: number, m: Message<'remoteFs:list'>): Promise<void> => {
    let result: ServerMethods['remote.fs.list']['result'];
    try {
      result = await d.call('remote.fs.list', {
        machineId: m.machineId,
        sessionId: m.sessionId,
        path: m.path,
      });
    } catch (error) {
      d.log('warn', 'remote fs list failed', {
        machineId: m.machineId,
        sessionId: m.sessionId,
        err: String(error),
      });
      d.sendTo(windowId, {
        type: 'remoteFs:listed',
        requestId: m.requestId,
        result: { ok: false, error: faultCode(error) },
      });
      return;
    }
    d.sendTo(windowId, {
      type: 'remoteFs:listed',
      requestId: m.requestId,
      result: { ok: true, path: result.path, entries: result.entries },
    });
  };

  const read = async (windowId: number, m: Message<'remoteFs:read'>): Promise<void> => {
    let file: ServerMethods['remote.fs.read']['result'];
    try {
      file = await d.call('remote.fs.read', {
        machineId: m.machineId,
        sessionId: m.sessionId,
        path: m.path,
      });
    } catch (error) {
      d.log('warn', 'remote fs read failed', {
        machineId: m.machineId,
        sessionId: m.sessionId,
        err: String(error),
      });
      d.sendTo(windowId, {
        type: 'remoteFs:content',
        requestId: m.requestId,
        result: { ok: false, error: faultCode(error) },
      });
      return;
    }
    d.sendTo(windowId, {
      type: 'remoteFs:content',
      requestId: m.requestId,
      result: { ok: true, file },
    });
  };

  // The file content is never logged or echoed back: the reply carries only B's verdict.
  const write = async (windowId: number, m: Message<'remoteFs:write'>): Promise<void> => {
    let result: ServerMethods['remote.fs.write']['result'];
    try {
      result = await d.call(
        'remote.fs.write',
        {
          machineId: m.machineId,
          sessionId: m.sessionId,
          path: m.path,
          data: m.data,
          expect: m.expect,
        },
        { timeoutMs: WRITE_TIMEOUT_MS },
      );
    } catch (error) {
      d.log('warn', 'remote fs write failed', {
        machineId: m.machineId,
        sessionId: m.sessionId,
        err: String(error),
      });
      d.sendTo(windowId, {
        type: 'remoteFs:written',
        requestId: m.requestId,
        result: { kind: 'error', error: faultCode(error) },
      });
      return;
    }
    d.sendTo(windowId, { type: 'remoteFs:written', requestId: m.requestId, result });
  };

  const git = async (windowId: number, m: Message<'remoteGit:request'>): Promise<void> => {
    let value: ServerMethods['remote.git']['result'];
    try {
      value = await d.call(
        'remote.git',
        { machineId: m.machineId, sessionId: m.sessionId, root: m.root, op: m.op, args: m.args },
        { timeoutMs: GIT_TIMEOUT_MS },
      );
    } catch (error) {
      d.log('warn', 'remote git failed', {
        machineId: m.machineId,
        sessionId: m.sessionId,
        op: m.op,
        err: String(error),
      });
      d.sendTo(windowId, {
        type: 'remoteGit:result',
        requestId: m.requestId,
        result: { ok: false, error: faultCode(error) },
      });
      return;
    }
    d.sendTo(windowId, {
      type: 'remoteGit:result',
      requestId: m.requestId,
      result: { ok: true, value },
    });
  };

  // No reply message exists for a watch, so a failure is only logged; the renderer simply gets no
  // change events for that key.
  const watch = async (windowId: number, m: Message<'remoteFs:watch'>): Promise<void> => {
    const keys = byWindow.get(windowId) ?? new Map<string, Watch>();
    byWindow.set(windowId, keys);
    const previous = keys.get(m.key);
    if (previous) release(previous);
    const pending: Watch = { windowId, key: m.key, released: false };
    keys.set(m.key, pending);

    let result: ServerMethods['remote.fs.watch']['result'];
    try {
      result = await d.call('remote.fs.watch', {
        machineId: m.machineId,
        sessionId: m.sessionId,
        path: m.path,
      });
    } catch (error) {
      release(pending);
      d.log('warn', 'remote fs watch failed', {
        machineId: m.machineId,
        sessionId: m.sessionId,
        err: String(error),
      });
      return;
    }
    // The window closed or the key was re-watched while B was answering: drop the watch at once.
    if (pending.released) {
      void unwatchOverC2(result.watchId);
      return;
    }
    pending.watchId = result.watchId;
    byWatchId.set(result.watchId, pending);
  };

  const unwatch = (windowId: number, key: string): void => {
    const watch = byWindow.get(windowId)?.get(key);
    if (watch) release(watch);
  };

  // An event can outlive its watch (an unwatch races the last change), so an unknown watchId is
  // dropped rather than sent to whichever window watched last.
  const changed = (e: ServerEvents['remote.fs.changed']): void => {
    const watch = byWatchId.get(e.watchId);
    if (!watch) return;
    d.sendTo(watch.windowId, { type: 'remoteFs:changed', key: watch.key, paths: e.paths });
  };

  return {
    list,
    read,
    write,
    git,
    watch,
    unwatch,
    changed,
    windowClosed(windowId: number): void {
      const keys = byWindow.get(windowId);
      if (!keys) return;
      byWindow.delete(windowId);
      for (const watch of keys.values()) release(watch);
    },
  };
}

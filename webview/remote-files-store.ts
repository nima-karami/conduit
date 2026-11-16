// Remote file listings, reads and watches over the host (plan CON-43 T4). B is the only judge of
// what may be read: a failure here is B's error string, or 'timeout' when B never answered, never a
// guess made in the renderer.

import { useSyncExternalStore } from 'react';
import type { DirEntryDTO, FileContentDTO, HostToWebview } from '../src/protocol';
import { post, subscribe } from './bridge';
import type { OpenDoc } from './docs';
import { requestHost } from './host-request';

const LIST_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 30_000;

/** The error a request reports when the host never answered. */
export const REMOTE_TIMEOUT = 'timeout';

export type RemoteListResult = { ok: true; entries: DirEntryDTO[] } | { ok: false; error: string };
export type RemoteReadResult = { ok: true; file: FileContentDTO } | { ok: false; error: string };

export async function listRemoteDir(
  machineId: string,
  sessionId: string,
  path: string,
): Promise<RemoteListResult> {
  const reply = await requestHost(
    (requestId) => ({ type: 'remoteFs:list', requestId, machineId, sessionId, path }),
    ['remoteFs:listed'],
    LIST_TIMEOUT_MS,
  );
  if (!reply) return { ok: false, error: REMOTE_TIMEOUT };
  return reply.result.ok
    ? { ok: true, entries: reply.result.entries }
    : { ok: false, error: reply.result.error };
}

export async function readRemoteFile(
  machineId: string,
  sessionId: string,
  path: string,
): Promise<RemoteReadResult> {
  const reply = await requestHost(
    (requestId) => ({ type: 'remoteFs:read', requestId, machineId, sessionId, path }),
    ['remoteFs:content'],
    READ_TIMEOUT_MS,
  );
  if (!reply) return { ok: false, error: REMOTE_TIMEOUT };
  return reply.result.ok
    ? { ok: true, file: reply.result.file }
    : { ok: false, error: reply.result.error };
}

// One host watch per key, shared by every caller that holds it: a second caller on the same
// path must not tear down the first one's watch when it lets go.
const watchCounts = new Map<string, number>();

/**
 * Watch `path` on the machine and call `onChange` with the changed paths. The host sees one
 * `remoteFs:watch` per key and one `remoteFs:unwatch` once the last holder releases it.
 */
export function watchRemote(
  key: string,
  machineId: string,
  sessionId: string,
  path: string,
  onChange: (paths: string[]) => void,
): () => void {
  const unsubscribe = subscribe((m: HostToWebview) => {
    if (m.type === 'remoteFs:changed' && m.key === key) onChange(m.paths);
  });
  const held = watchCounts.get(key) ?? 0;
  if (held === 0) post({ type: 'remoteFs:watch', key, machineId, sessionId, path });
  watchCounts.set(key, held + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unsubscribe();
    const left = (watchCounts.get(key) ?? 1) - 1;
    if (left > 0) {
      watchCounts.set(key, left);
      return;
    }
    watchCounts.delete(key);
    post({ type: 'remoteFs:unwatch', key });
  };
}

// Remote file content by doc id. Local docs read through readFile into their own store; a remote
// doc's content lives here so the path-keyed local code never sees it.
const contents = new Map<string, FileContentDTO>();
const contentListeners = new Set<() => void>();
const readers = new Map<string, () => void>();

function publishContent(): void {
  for (const l of [...contentListeners]) l();
}

const subscribeContent = (cb: () => void): (() => void) => {
  contentListeners.add(cb);
  return () => {
    contentListeners.delete(cb);
  };
};

/** The loaded content of a remote file doc, or undefined until its first read answers. */
export function useRemoteFile(docId: string): FileContentDTO | undefined {
  return useSyncExternalStore(
    subscribeContent,
    () => contents.get(docId),
    () => contents.get(docId),
  );
}

/**
 * Read a remote file doc's content and re-read it whenever B reports the file changed, until the
 * returned function is called. The first caller for a doc id owns its watch; a later call gets the
 * same release, so the doc stops for everyone when the owner releases it.
 */
export function loadRemoteDoc(doc: OpenDoc): () => void {
  if (!doc.machine) throw new Error(`loadRemoteDoc: ${doc.id} is not a remote doc`);
  const { machineId, sessionId } = doc.machine;
  const existing = readers.get(doc.id);
  if (existing) return existing;
  let live = true;
  const read = async (): Promise<void> => {
    const r = await readRemoteFile(machineId, sessionId, doc.path);
    if (!live) return;
    // A failed read is shown as the doc's own error, the way a local read reports one.
    contents.set(
      doc.id,
      r.ok
        ? r.file
        : {
            path: doc.path,
            content: '',
            language: '',
            truncated: false,
            binary: false,
            error: r.error,
          },
    );
    publishContent();
  };
  void read();
  const stopWatch = watchRemote(`file|${doc.id}`, machineId, sessionId, doc.path, () => {
    void read();
  });
  const release = (): void => {
    if (!live) return;
    live = false;
    stopWatch();
    readers.delete(doc.id);
    contents.delete(doc.id);
    publishContent();
  };
  readers.set(doc.id, release);
  return release;
}

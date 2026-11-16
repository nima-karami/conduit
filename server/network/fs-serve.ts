import * as path from 'node:path';
import type { DirWatch, watchDir } from '../../electron/watch-dir';
import type { FsErrorCode, FsOp, FsResult, LinkFrame } from '../../src/contracts/link-protocol';
import { mediaKindForPath, pdfKindForPath } from '../../src/media-kind';
import { confineFsPath } from '../../src/network/fs-confine';
import { isDenied } from '../../src/network/fs-deny';
import type { LinkRecord } from '../../src/network/link-file';
import type { DirEntryDTO, FileContentDTO } from '../../src/protocol';
import type { AuditSink } from './audit-log';
import { isInboundSsh } from './calls';

// B serves files to its ssh controller (CON-43 plan decisions 1-6). A peer's path is confined and
// deny-listed here, never on the far side; a refusal touches no file.

export type FsServeFrame = Extract<LinkFrame, { t: 'fs.req' | 'fs.watch' | 'fs.unwatch' }>;

/** At most one `fs.refused` audit entry per link in this window, as calls.ts does. */
export const FS_REFUSAL_AUDIT_MS = 60_000;
/** A controller may hold this many watches on one link; the next is refused. */
export const FS_WATCH_MAX = 64;
/** Changes under a watch are sent once the folder has been quiet this long. */
export const FS_WATCH_DEBOUNCE_MS = 150;
/** A changed-paths list over this length is sent empty, which means "re-list the watch". */
const FS_CHANGED_MAX = 256;
/** Image and PDF bytes, raw, that B will read; base64 of this is what the frame carries. */
const RAW_MEDIA_MAX = 6 * 1024 * 1024;
/** The whole encoded `fs.res` result. The frame limit is 16 MiB; this leaves the envelope room. */
const ENCODED_RESULT_MAX = 8 * 1024 * 1024;

export interface FsStat {
  kind: 'file' | 'dir' | 'other';
  size: number;
  mtimeMs: number;
}

export interface FsServeDeps {
  /** My record of the link to a machine; only an inbound ssh record is served. */
  linkOf(machineId: string): LinkRecord | null;
  /** Home and roots of a session on this machine, or null when there is no such session. */
  sessionRoots(sessionId: string): readonly string[] | null;
  readDir(absPath: string): Promise<DirEntryDTO[]>;
  readFile(absPath: string): Promise<FileContentDTO>;
  stat(absPath: string): Promise<FsStat>;
  watchDir: typeof watchDir;
  send(machineId: string, frame: LinkFrame): void;
  audit: AuditSink;
  now(): number;
}

export interface FsServe {
  /** Serves one fs.req, fs.watch or fs.unwatch frame from a link. Never throws. */
  onFrame(machineId: string, frame: FsServeFrame): Promise<void>;
  /** The link is down: its watches are closed, so nothing is sent to a controller that is gone. */
  linkDown(machineId: string): void;
  /** How many watches a machine holds; for the tests. */
  watchCount(machineId: string): number;
}

type Reply = { ok: true; result: FsResult } | { ok: false; code: FsErrorCode; message: string };

interface Watch {
  close(): void;
}

const NOT_SERVED = 'that path is not served';
const NOT_FOUND = 'no such file or folder';
const FAILED = 'the file could not be read';
const NO_SESSION = 'no such session on this machine';

export function createFsServe(deps: FsServeDeps): FsServe {
  /** The last `fs.refused` audit per link, so a flood of refusals audits once a minute. */
  const lastRefusal = new Map<string, number>();
  /** Open watches by machine, then by the controller's watch id. */
  const watches = new Map<string, Map<string, Watch>>();

  const refuse = (machineId: string, reason: string): void => {
    const at = deps.now();
    const last = lastRefusal.get(machineId);
    if (last !== undefined && at - last < FS_REFUSAL_AUDIT_MS) return;
    lastRefusal.set(machineId, at);
    deps.audit.record({ kind: 'fs.refused', peer: machineId, detail: { reason } });
  };

  const reply = (machineId: string, id: string, r: Reply): void => {
    deps.send(
      machineId,
      r.ok
        ? { t: 'fs.res', id, ok: true, result: r.result }
        : { t: 'fs.res', id, ok: false, error: { code: r.code, message: r.message } },
    );
  };

  const readFileResult = async (real: string, requested: string): Promise<Reply> => {
    const st = await deps.stat(real);
    if (st.kind !== 'file') return { ok: false, code: 'failed', message: FAILED };
    const media = mediaKindForPath(real) !== null || pdfKindForPath(real);
    if (media && st.size > RAW_MEDIA_MAX)
      return { ok: false, code: 'too_large', message: 'the file is over 6 MiB' };
    const file = await deps.readFile(real);
    // A's tab keys its content by the path it asked for, not by where B found it.
    return {
      ok: true,
      result: { op: 'read', file: { ...file, path: requested, readOnlyReason: 'remote' } },
    };
  };

  const runOp = async (op: FsOp, requested: string, real: string): Promise<Reply> => {
    if (op === 'list') {
      const entries = await deps.readDir(real);
      const visible = entries.filter((e) => !isDenied(path.join(real, e.name)));
      return { ok: true, result: { op: 'list', path: requested, entries: visible } };
    }
    if (op === 'read') return readFileResult(real, requested);
    const st = await deps.stat(real);
    if (st.kind === 'other') return { ok: false, code: 'failed', message: FAILED };
    return {
      ok: true,
      result: { op: 'stat', kind: st.kind, size: st.size, mtimeMs: st.mtimeMs },
    };
  };

  const errorReply = (err: unknown): Reply => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: false, code: 'not_found', message: NOT_FOUND };
    return { ok: false, code: 'failed', message: FAILED };
  };

  const serveRequest = async (machineId: string, frame: Extract<FsServeFrame, { t: 'fs.req' }>) => {
    if (!isInboundSsh(deps.linkOf(machineId))) {
      refuse(machineId, 'not_controller');
      return reply(machineId, frame.id, { ok: false, code: 'refused', message: NOT_SERVED });
    }
    const roots = deps.sessionRoots(frame.sessionId);
    if (roots === null)
      return reply(machineId, frame.id, { ok: false, code: 'not_found', message: NO_SESSION });
    const confined = await confineFsPath(frame.path, roots);
    if (!confined.ok) {
      if (confined.code === 'refused') {
        refuse(machineId, 'path');
        return reply(machineId, frame.id, { ok: false, code: 'refused', message: NOT_SERVED });
      }
      return reply(machineId, frame.id, { ok: false, code: 'not_found', message: NOT_FOUND });
    }
    let answer: Reply;
    try {
      answer = await runOp(frame.op, frame.path, confined.real);
    } catch (err) {
      answer = errorReply(err);
    }
    if (answer.ok && JSON.stringify(answer.result).length > ENCODED_RESULT_MAX)
      answer = { ok: false, code: 'too_large', message: 'the result is over 8 MiB' };
    reply(machineId, frame.id, answer);
  };

  const closeWatch = (machineId: string, watchId: string): void => {
    const mine = watches.get(machineId);
    const w = mine?.get(watchId);
    if (!mine || !w) return;
    mine.delete(watchId);
    if (mine.size === 0) watches.delete(machineId);
    w.close();
  };

  const openWatch = async (
    machineId: string,
    frame: Extract<FsServeFrame, { t: 'fs.watch' }>,
  ): Promise<void> => {
    if (!isInboundSsh(deps.linkOf(machineId))) return refuse(machineId, 'not_controller');
    const roots = deps.sessionRoots(frame.sessionId);
    if (roots === null) return refuse(machineId, 'unknown_session');
    const confined = await confineFsPath(frame.path, roots);
    if (!confined.ok) return refuse(machineId, confined.code === 'refused' ? 'path' : 'not_found');
    let st: FsStat;
    try {
      st = await deps.stat(confined.real);
    } catch {
      return refuse(machineId, 'not_found');
    }
    if (st.kind === 'other') return refuse(machineId, 'path');
    // The link may have dropped while the path was being checked; a watch on it would outlive it.
    if (!isInboundSsh(deps.linkOf(machineId))) return;
    const mine = watches.get(machineId) ?? new Map<string, Watch>();
    if (mine.has(frame.watchId)) return refuse(machineId, 'duplicate_watch');
    if (mine.size >= FS_WATCH_MAX) return refuse(machineId, 'watch_limit');
    const watch = startWatch(machineId, frame, confined.real, st.kind === 'dir');
    if (watch === null) return refuse(machineId, 'watch_failed');
    mine.set(frame.watchId, watch);
    watches.set(machineId, mine);
  };

  /** Starts the watch on the confined path; null when the directory cannot be watched. */
  const startWatch = (
    machineId: string,
    frame: Extract<FsServeFrame, { t: 'fs.watch' }>,
    real: string,
    isDir: boolean,
  ): Watch | null => {
    const folder = isDir ? real : path.dirname(real);
    const only = isDir ? null : path.basename(real);
    const pending = new Set<string>();
    let everything = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const flush = () => {
      timer = null;
      const paths = everything || pending.size > FS_CHANGED_MAX ? [] : [...pending];
      pending.clear();
      everything = false;
      if (closed) return;
      deps.send(machineId, { t: 'fs.changed', watchId: frame.watchId, paths });
    };
    const onEvent = (_event: string, filename: string | null) => {
      if (closed) return;
      if (filename === null) everything = true;
      else if (only === null) {
        // Entries a listing would hide are not reported either, or a change would name them.
        const entry = path.join(real, filename);
        if (!isDenied(entry)) pending.add(path.join(frame.path, filename));
      } else if (filename === only) pending.add(frame.path);
      else return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, FS_WATCH_DEBOUNCE_MS);
    };
    let dirWatch: DirWatch;
    try {
      dirWatch = deps.watchDir(folder, {}, onEvent, () => {
        // The folder went away or its watch failed: the controller re-lists; it may re-watch.
        if (closed) return;
        closed = true;
        if (timer !== null) clearTimeout(timer);
        closeWatch(machineId, frame.watchId);
        deps.send(machineId, { t: 'fs.changed', watchId: frame.watchId, paths: [] });
      });
    } catch {
      return null;
    }
    return {
      close() {
        closed = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        dirWatch.close();
      },
    };
  };

  return {
    async onFrame(machineId, frame) {
      if (frame.t === 'fs.req') return serveRequest(machineId, frame);
      if (frame.t === 'fs.watch') return openWatch(machineId, frame);
      closeWatch(machineId, frame.watchId);
    },
    linkDown(machineId) {
      const mine = watches.get(machineId);
      if (!mine) return;
      watches.delete(machineId);
      for (const w of mine.values()) w.close();
    },
    watchCount: (machineId) => watches.get(machineId)?.size ?? 0,
  };
}

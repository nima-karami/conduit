import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DirWatch, watchDir } from '../../electron/watch-dir';
import type {
  FsErrorCode,
  FsOp,
  FsResult,
  LinkFrame,
  LinkState,
} from '../../src/contracts/link-protocol';
import { MAX_BYTES } from '../../src/file-service';
import { mediaKindForPath, pdfKindForPath } from '../../src/media-kind';
import { confineFsPath } from '../../src/network/fs-confine';
import { isDenied } from '../../src/network/fs-deny';
import type { LinkRecord } from '../../src/network/link-file';
import type { DirEntryDTO, FileContentDTO } from '../../src/protocol';
import type { AuditSink } from './audit-log';
import { isInboundSsh } from './calls';
import { sha256Of } from './sha256';

// B serves files to its ssh controller (CON-43 plan decisions 1-6). A peer's path is confined and
// deny-listed here, never on the far side; a refusal touches no file.

export type FsServeFrame = Extract<
  LinkFrame,
  { t: 'fs.req' | 'fs.write' | 'fs.watch' | 'fs.unwatch' }
>;

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

const isLive = (state: LinkState | null): boolean => state === 'up' || state === 'degraded';

/**
 * Whether a directory entry must stay hidden: its own path is denied, or it is a symlink whose
 * target is. A symlink is followed here because a listing or a change would otherwise name a
 * denied file under an innocent name. A vanished entry is not shown; any other failure hides it.
 */
function entryDenied(dir: string, name: string): boolean {
  const entry = path.join(dir, name);
  if (isDenied(entry)) return true;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(entry);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  if (!st.isSymbolicLink()) return false;
  try {
    return isDenied(fs.realpathSync.native(entry));
  } catch {
    // A dangling link has no real path to check, so its target is taken as written.
    try {
      return isDenied(path.resolve(path.dirname(entry), fs.readlinkSync(entry)));
    } catch {
      return true;
    }
  }
}

export interface FsStat {
  kind: 'file' | 'dir' | 'other';
  size: number;
  mtimeMs: number;
}

export interface FsServeDeps {
  /** My record of the link to a machine; only an inbound ssh record is served. */
  linkOf(machineId: string): LinkRecord | null;
  /** The link's state now; a watch is registered only while the link is up or degraded. */
  linkState(machineId: string): LinkState | null;
  /** Home and roots of a session on this machine, or null when there is no such session. */
  sessionRoots(sessionId: string): readonly string[] | null;
  readDir(absPath: string): Promise<DirEntryDTO[]>;
  readFile(absPath: string): Promise<FileContentDTO>;
  stat(absPath: string): Promise<FsStat>;
  /** SHA-256 hex of the file's raw bytes; null when there is no such file. */
  hashFile(absPath: string): Promise<string | null>;
  /** Writes UTF-8 text so the target is only ever the old or the new content. */
  writeFileAtomic(absPath: string, data: string): Promise<void>;
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

type Reply =
  | { ok: true; result: FsResult }
  | { ok: false; code: Exclude<FsErrorCode, 'conflict'>; message: string }
  | { ok: false; code: 'conflict'; message: string; currentHash: string | null };

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
        : {
            t: 'fs.res',
            id,
            ok: false,
            error:
              r.code === 'conflict'
                ? { code: r.code, message: r.message, currentHash: r.currentHash }
                : { code: r.code, message: r.message },
          },
    );
  };

  const readFileResult = async (real: string, requested: string): Promise<Reply> => {
    const st = await deps.stat(real);
    if (st.kind !== 'file') return { ok: false, code: 'failed', message: FAILED };
    const media = mediaKindForPath(real) !== null || pdfKindForPath(real);
    if (media && st.size > RAW_MEDIA_MAX)
      return { ok: false, code: 'too_large', message: 'the file is over 6 MiB' };
    // Hashed before the read: a change in between leaves the content newer than the hash, so the
    // next save conflicts instead of overwriting what the editor never saw. A file a read can
    // return whole is at most MAX_BYTES, so a larger one is not hashed at all.
    const before = !media && st.size <= MAX_BYTES ? await deps.hashFile(real) : null;
    const file = await deps.readFile(real);
    const editable =
      !file.binary &&
      !file.truncated &&
      file.error === undefined &&
      file.readOnlyReason === undefined;
    // A's tab keys its content by the path it asked for, not by where B found it.
    return {
      ok: true,
      result: {
        op: 'read',
        file: {
          ...file,
          path: requested,
          ...(editable && before !== null ? { hash: before } : {}),
        },
      },
    };
  };

  const runOp = async (op: FsOp, requested: string, real: string): Promise<Reply> => {
    if (op === 'list') {
      const entries = await deps.readDir(real);
      const visible = entries.filter((e) => !entryDenied(real, e.name));
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

  /** A write's parent must be a folder now; a missing one is not_found, not a failed write. */
  const statIfThere = async (p: string): Promise<FsStat | null> => {
    try {
      return await deps.stat(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };

  const serveWrite = async (machineId: string, frame: Extract<FsServeFrame, { t: 'fs.write' }>) => {
    if (!servable(machineId)) {
      refuse(machineId, 'not_controller');
      return reply(machineId, frame.id, { ok: false, code: 'refused', message: NOT_SERVED });
    }
    const roots = deps.sessionRoots(frame.sessionId);
    if (roots === null)
      return reply(machineId, frame.id, { ok: false, code: 'not_found', message: NO_SESSION });
    const confined = await confineFsPath(frame.path, roots, { allowMissing: true });
    if (!confined.ok) {
      if (confined.code === 'refused') {
        refuse(machineId, 'path');
        return reply(machineId, frame.id, { ok: false, code: 'refused', message: NOT_SERVED });
      }
      return reply(machineId, frame.id, { ok: false, code: 'not_found', message: NOT_FOUND });
    }
    if (isDenied(frame.path) || isDenied(confined.real)) {
      refuse(machineId, 'path');
      return reply(machineId, frame.id, { ok: false, code: 'refused', message: NOT_SERVED });
    }
    // The write goes to the resolved file, never the named path: a symlink inside the roots is
    // written through, so it stays a symlink.
    let answer: Reply;
    try {
      const parent = await statIfThere(path.dirname(confined.real));
      if (parent?.kind !== 'dir') answer = { ok: false, code: 'not_found', message: NOT_FOUND };
      else {
        const existing = await statIfThere(confined.real);
        if (existing !== null && existing.kind !== 'file')
          answer = { ok: false, code: 'failed', message: FAILED };
        else {
          const current = await deps.hashFile(confined.real);
          const stale = frame.expect === null ? current !== null : current !== frame.expect;
          if (stale)
            answer = {
              ok: false,
              code: 'conflict',
              message: 'the file changed since it was loaded',
              currentHash: current,
            };
          else {
            await deps.writeFileAtomic(confined.real, frame.data);
            answer = {
              ok: true,
              result: { op: 'write', hash: sha256Of(Buffer.from(frame.data, 'utf8')) },
            };
          }
        }
      }
    } catch (err) {
      answer = errorReply(err);
    }
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

  const servable = (machineId: string): boolean =>
    isInboundSsh(deps.linkOf(machineId)) && isLive(deps.linkState(machineId));

  const openWatch = async (
    machineId: string,
    frame: Extract<FsServeFrame, { t: 'fs.watch' }>,
  ): Promise<void> => {
    if (!servable(machineId)) return refuse(machineId, 'not_controller');
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
    if (!servable(machineId)) return;
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
    /** Entry names that changed, relative to the folder (the file's own name when watching a file). */
    const pending = new Set<string>();
    let everything = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const flush = () => {
      timer = null;
      const names = [...pending];
      pending.clear();
      const wasEverything = everything;
      everything = false;
      if (closed) return;
      // A change to an entry a listing would hide is not reported either, or it would name it.
      const paths =
        wasEverything || names.length > FS_CHANGED_MAX
          ? []
          : [
              ...new Set(
                names
                  .filter((n) => only !== null || !entryDenied(real, n))
                  .map((n) => (only !== null ? frame.path : path.join(frame.path, n))),
              ),
            ];
      deps.send(machineId, { t: 'fs.changed', watchId: frame.watchId, paths });
    };
    const onEvent = (_event: string, filename: string | null) => {
      if (closed) return;
      if (filename === null) everything = true;
      else if (only === null || filename === only) pending.add(filename);
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
      if (frame.t === 'fs.write') return serveWrite(machineId, frame);
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

import * as fs from 'node:fs';
import * as path from 'node:path';

type WriteCallback = (err: NodeJS.ErrnoException | null) => void;
interface Snapshot {
  data: string;
  callbacks: WriteCallback[];
}
interface Writer {
  pending?: Snapshot;
}
const writers = new Map<string, Writer>();
let tempSequence = 0;
const temporaryPath = (filePath: string) => `${filePath}.tmp-${process.pid}-${++tempSequence}`;
const writerKey = (filePath: string) => {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * Durable persistence primitive. A plain `fs.writeFile`/`writeFileSync` TRUNCATES the target
 * before writing its bytes, so a write interrupted partway (e.g. the auto-update installer
 * force-killing the app to replace the exe) leaves a truncated/empty file — which then fails
 * to parse on next launch, silently wiping sessions/settings. Writing to a sibling temp file
 * and `rename`-ing it over the target makes the swap atomic on the same volume: the target is
 * only ever the COMPLETE old content or the COMPLETE new content, never a partial write.
 *
 * See docs (multi-repo run retro) / the update-durability fix.
 */
/** The subset of `node:fs` the sync writer needs; injectable so the failure path is testable. */
type SyncFs = Pick<typeof fs, 'writeFileSync' | 'renameSync' | 'unlinkSync'>;

export function atomicWriteFileSync(
  filePath: string,
  data: string | Uint8Array,
  io: SyncFs = fs,
): void {
  const tmp = temporaryPath(filePath);
  io.writeFileSync(tmp, data);
  try {
    io.renameSync(tmp, filePath);
  } catch (e) {
    try {
      io.unlinkSync(tmp);
    } catch {
      /* temp already gone — nothing to clean */
    }
    throw e;
  }
  const key = writerKey(filePath);
  const previous = writers.get(key);
  writers.delete(key);
  if (previous?.pending) {
    const callbacks = previous.pending.callbacks;
    previous.pending = undefined;
    process.nextTick(() => {
      for (const cb of callbacks) cb(null);
    });
  }
}

/**
 * Async sibling of {@link atomicWriteFileSync} for the hot path (every state change). Same
 * Coalesces pending snapshots per target; every superseded callback completes with the latest
 * snapshot's result. A successful sync flush supersedes all earlier asynchronous snapshots.
 */
export function atomicWriteFile(filePath: string, data: string, cb: WriteCallback): void {
  const key = writerKey(filePath);
  const current = writers.get(key);
  if (current) {
    if (current.pending) {
      current.pending.data = data;
      current.pending.callbacks.push(cb);
    } else current.pending = { data, callbacks: [cb] };
    return;
  }
  const entry: Writer = {};
  writers.set(key, entry);
  writeSnapshot(path.resolve(filePath), key, entry, { data, callbacks: [cb] });
}

function writeSnapshot(filePath: string, key: string, entry: Writer, snapshot: Snapshot): void {
  const tmp = temporaryPath(filePath);
  const finish = (error: NodeJS.ErrnoException | null) => {
    const pending = entry.pending;
    entry.pending = undefined;
    if (writers.get(key) === entry) {
      if (pending) writeSnapshot(filePath, key, entry, pending);
      else writers.delete(key);
    }
    for (const callback of snapshot.callbacks) callback(error);
  };
  fs.writeFile(tmp, snapshot.data, (writeError) => {
    let error = writers.get(key) === entry ? writeError : null;
    let promoted = false;
    if (!error && writers.get(key) === entry) {
      try {
        // An async rename already submitted to libuv can land AFTER the final sync quit flush.
        // Promotion must share an event-loop turn with the ownership check.
        fs.renameSync(tmp, filePath);
        promoted = true;
      } catch (renameError) {
        error = renameError as NodeJS.ErrnoException;
      }
    }
    if (promoted) {
      finish(null);
      return;
    }
    fs.unlink(tmp, () => finish(error));
  });
}

import * as fs from 'node:fs';

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

export function atomicWriteFileSync(filePath: string, data: string, io: SyncFs = fs): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
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
}

/**
 * Async sibling of {@link atomicWriteFileSync} for the hot path (every state change). Same
 * temp-then-rename guarantee; calls back with an error (or null) so the caller can log.
 */
export function atomicWriteFile(
  filePath: string,
  data: string,
  cb: (err: NodeJS.ErrnoException | null) => void,
): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFile(tmp, data, (writeErr) => {
    if (writeErr) {
      cb(writeErr);
      return;
    }
    fs.rename(tmp, filePath, (renameErr) => {
      if (renameErr) {
        fs.unlink(tmp, () => cb(renameErr));
        return;
      }
      cb(null);
    });
  });
}

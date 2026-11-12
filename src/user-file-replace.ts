import * as fs from 'node:fs';

/** The stat fields a save carries over from the file it replaces. */
export interface ReplacedMode {
  mode: number;
  uid: number;
  gid: number;
}

/** The subset of `fs.promises` the mode carry-over needs; injectable so it is testable. */
export interface ModeIo {
  stat(p: string): Promise<Pick<fs.Stats, 'mode' | 'uid' | 'gid'>>;
  access(p: string, mode: number): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  chown(p: string, uid: number, gid: number): Promise<void>;
}

export type ReplaceCheck =
  | { ok: true; original: ReplacedMode | null }
  | { ok: false; error: string };

const realIo: ModeIo = fs.promises;

const errorCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : undefined;

/**
 * Decide, before a user file is atomically replaced, whether the save may proceed and which
 * mode the new file must take. A rename swaps the directory entry, so on POSIX the new file
 * would get default bits and a read-only target would be silently replaced. Windows already
 * refuses the rename over a read-only file, which is the behaviour Conduit relies on, so it is
 * left as it is. A missing target is a new file and keeps default bits.
 */
export async function checkReplaceable(target: string, io: ModeIo = realIo): Promise<ReplaceCheck> {
  if (process.platform === 'win32') return { ok: true, original: null };
  let st: Pick<fs.Stats, 'mode' | 'uid' | 'gid'>;
  try {
    st = await io.stat(target);
  } catch (e) {
    if (errorCode(e) === 'ENOENT') return { ok: true, original: null };
    throw e;
  }
  try {
    await io.access(target, fs.constants.W_OK);
  } catch {
    return { ok: false, error: `Permission denied: ${target} is read-only` };
  }
  return { ok: true, original: { mode: st.mode, uid: st.uid, gid: st.gid } };
}

/**
 * Give the temp file the replaced file's owner and mode before it is renamed over the target.
 * Ownership goes first: chown clears setuid/setgid bits, so the mode is set last.
 */
export async function applyReplacedMode(
  tmp: string,
  original: ReplacedMode,
  io: ModeIo = realIo,
): Promise<void> {
  const current = await io.stat(tmp);
  if (current.uid !== original.uid || current.gid !== original.gid) {
    try {
      await io.chown(tmp, original.uid, original.gid);
    } catch (e) {
      // A non-root process may not hand a file to another owner or to a group it is not in
      // (EPERM), and some filesystems reject ownership changes outright (EINVAL). The save
      // still keeps the mode, so that is not a reason to fail the save.
      const code = errorCode(e);
      if (code !== 'EPERM' && code !== 'EINVAL') throw e;
    }
  }
  await io.chmod(tmp, original.mode & 0o7777);
}

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';

export const TRAY_EXE_NAME = 'conduit-tray.exe';

export interface InstallFs {
  mkdir(dir: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Copies and flushes `to` to disk before resolving. */
  copyFile(from: string, to: string): Promise<void>;
}

export const nodeInstallFs: InstallFs = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  readdir: (dir) => readdir(dir),
  async exists(p) {
    try {
      await access(p);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  unlink: (p) => unlink(p),
  rename: (from, to) => rename(from, to),
  async copyFile(from, to) {
    await copyFile(from, to);
    const handle = await open(to, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

export function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(p)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export interface InstallResult {
  exe: string;
  swapped: boolean;
  note?: string;
}

const STALE = new RegExp(`^${TRAY_EXE_NAME.replace('.', '\\.')}\\..+\\.(old|new)$`);
const reason = (error: unknown) =>
  (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));

/**
 * Spec §4 swap: the helper always runs from one stable path so Windows keeps the user's "show on
 * taskbar" choice (L6, S0-T9). A running image can be renamed but not overwritten (S0-T5), so the
 * old one moves aside to `.old` and is deleted on a later run once it's free. Any failure falls
 * back to the installed binary, else the source. Rejects only when neither exists.
 */
export async function installTray(o: {
  source: string;
  stableDir: string;
  fs: InstallFs;
  sha256: (path: string) => Promise<string>;
  /** Unique per call, e.g. `<pid>.<random>`: two supervisors never share a temp name. */
  tag: string;
  sep?: '/' | '\\';
}): Promise<InstallResult> {
  const { fs, stableDir } = o;
  const sep = o.sep ?? (stableDir.includes('\\') ? '\\' : '/');
  const at = (name: string) => `${stableDir}${sep}${name}`;
  const installed = at(TRAY_EXE_NAME);
  const fresh = `${installed}.${o.tag}.new`;
  const aside = `${installed}.${o.tag}.old`;
  const notes: string[] = [];
  const result = (exe: string, swapped: boolean): InstallResult =>
    notes.length ? { exe, swapped, note: notes.join('; ') } : { exe, swapped };

  try {
    await fs.mkdir(stableDir);
    for (const name of await fs.readdir(stableDir)) {
      if (!STALE.test(name)) continue;
      await fs.unlink(at(name)).catch((error: unknown) => {
        notes.push(`kept ${name} (${reason(error)})`);
      });
    }
  } catch (error) {
    notes.push(`could not sweep ${stableDir}: ${reason(error)}`);
  }

  const exists = async (p: string) => {
    try {
      return await fs.exists(p);
    } catch (error) {
      notes.push(`could not check ${p} (${reason(error)})`);
      return false;
    }
  };
  const hasInstalled = await exists(installed);
  if (!(await exists(o.source))) {
    if (!hasInstalled) throw new Error(`no tray binary at ${o.source} or ${installed}`);
    notes.push(`source ${o.source} missing`);
    return result(installed, false);
  }
  const fallback = (error: unknown, step: string) => {
    notes.push(`${step} failed (${reason(error)})`);
    return result(hasInstalled ? installed : o.source, false);
  };

  try {
    if (hasInstalled && (await o.sha256(installed)) === (await o.sha256(o.source)))
      return result(installed, false);
  } catch (error) {
    return fallback(error, 'hash');
  }

  try {
    await fs.copyFile(o.source, fresh);
  } catch (error) {
    await removeFresh();
    return fallback(error, 'copy');
  }
  if (hasInstalled) {
    try {
      await fs.rename(installed, aside);
    } catch (error) {
      await removeFresh();
      return fallback(error, 'rename installed');
    }
  }
  try {
    await fs.rename(fresh, installed);
  } catch (error) {
    notes.push(`rename new failed (${reason(error)})`);
    await removeFresh();
    if (!hasInstalled) return result(o.source, false);
    try {
      await fs.rename(aside, installed);
      return result(installed, false);
    } catch (restore) {
      notes.push(`restore failed (${reason(restore)})`);
      return result(o.source, false);
    }
  }
  if (hasInstalled)
    await fs.unlink(aside).catch((error: unknown) => {
      notes.push(`kept ${aside} (${reason(error)})`);
    });
  return result(installed, true);

  async function removeFresh() {
    await fs.unlink(fresh).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        notes.push(`kept ${fresh} (${reason(error)})`);
    });
  }
}

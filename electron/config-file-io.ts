import * as fs from 'node:fs';
import * as path from 'node:path';

export type ConfigIo = Pick<
  typeof fs,
  | 'existsSync'
  | 'lstatSync'
  | 'statSync'
  | 'chmodSync'
  | 'realpathSync'
  | 'readFileSync'
  | 'mkdirSync'
  | 'writeFileSync'
  | 'copyFileSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'linkSync'
>;

export interface ConfigRead {
  /** null ⇔ the file (lstat) does not exist. BOM stripped. */
  text: string | null;
  raw: Buffer | null;
  /** realpath when it exists, else the given path. */
  realPath: string;
  bom: boolean;
  mode?: number;
  mtimeMs?: number;
  size?: number;
}

const BOM = 0xfeff;

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

// lstat first: a dangling symlink must surface as an error, never be replaced by a fresh file.
export function readConfigFile(io: ConfigIo, filePath: string): ConfigRead {
  try {
    io.lstatSync(filePath);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return { text: null, raw: null, realPath: filePath, bom: false };
    }
    throw error;
  }
  const realPath = io.realpathSync(filePath);
  const st = io.statSync(realPath);
  const raw = io.readFileSync(realPath);
  const decoded = raw.toString('utf8');
  const bom = decoded.charCodeAt(0) === BOM;
  return {
    text: bom ? decoded.slice(1) : decoded,
    raw,
    realPath,
    bom,
    mode: st.mode & 0o7777,
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
}

let tempSequence = 0;
const tempFor = (target: string) => `${target}.tmp-${process.pid}-${++tempSequence}`;

function unlinkQuietly(io: ConfigIo, file: string): void {
  try {
    io.unlinkSync(file);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error;
  }
}

export function writeConfigAtomic(io: ConfigIo, target: string, data: string, mode?: number): void {
  io.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = tempFor(target);
  try {
    io.writeFileSync(temporary, data, { mode: mode ?? 0o666 });
    // writeFileSync's mode is masked by the umask; chmod restores the user's exact bits.
    if (mode !== undefined) io.chmodSync(temporary, mode);
    io.renameSync(temporary, target);
  } catch (error) {
    unlinkQuietly(io, temporary);
    throw error;
  }
}

// Exclusive create: two Conduit instances racing must not let the second overwrite the first's
// backup of the user's original bytes. The link-from-temp form is atomic; COPYFILE_EXCL covers
// filesystems without hard links.
export function backupOnce(io: ConfigIo, backupPath: string, original: Buffer | null): void {
  if (io.existsSync(backupPath)) return;
  io.mkdirSync(path.dirname(backupPath), { recursive: true });
  const temporary = tempFor(backupPath);
  try {
    io.writeFileSync(temporary, original ?? Buffer.from('null'), { mode: 0o600, flag: 'wx' });
    try {
      io.linkSync(temporary, backupPath);
    } catch (error) {
      if (codeOf(error) === 'EEXIST') return;
      try {
        io.copyFileSync(temporary, backupPath, fs.constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (codeOf(copyError) !== 'EEXIST') throw copyError;
      }
    }
  } finally {
    unlinkQuietly(io, temporary);
  }
}

/** ConfigFormatError carries its code as a string property too, so one lookup covers both. */
export function errorCodeOf(error: unknown): string {
  return codeOf(error) ?? 'EINVAL';
}

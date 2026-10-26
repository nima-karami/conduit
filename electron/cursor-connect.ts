import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type CursorConnectResult,
  type CursorConnectState,
  cursorConfigState,
  cursorEntry,
  isCursorConfigParseError,
  mergeCursorEntry,
  parseCursorConfig,
  removeCursorEntry,
  serializeCursorConfig,
  wiresLaunch,
} from '../src/conduit-mcp/cursor-config';

export interface CursorConnectApi {
  read(): CursorConnectResult;
  connect(): CursorConnectResult;
  disconnect(): CursorConnectResult;
}

export interface CursorConnectOptions {
  homeDir: string;
  execPath: string;
  shimPath: string;
  io?: CursorConnectIo;
}

export type CursorConnectIo = Pick<
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

export function createCursorConnect(options: CursorConnectOptions): CursorConnectApi {
  const cursorDir = path.join(options.homeDir, '.cursor');
  const configPath = path.join(cursorDir, 'mcp.json');
  const backupPath = `${configPath}.conduit-backup`;
  const expected = cursorEntry(options.execPath, options.shimPath);
  const io = options.io ?? fs;

  function readConfig(): {
    config: ReturnType<typeof parseCursorConfig>;
    raw: Buffer | null;
  } {
    try {
      io.lstatSync(configPath);
    } catch (error) {
      if (isMissing(error)) return { config: parseCursorConfig('{}'), raw: null };
      throw error;
    }
    const actualPath = io.realpathSync(configPath);
    const raw = io.readFileSync(actualPath);
    return { config: parseCursorConfig(raw.toString('utf8')), raw };
  }

  function read(): CursorConnectResult {
    try {
      const { config } = readConfig();
      return { state: cursorConfigState(config, expected), path: configPath };
    } catch (error) {
      return { state: 'error', path: configPath, errorCode: errorCode(error) };
    }
  }

  function write(root: Record<string, unknown>): void {
    io.mkdirSync(cursorDir, { recursive: true });
    let targetPath = configPath;
    try {
      targetPath = io.realpathSync(configPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    let mode: number | undefined;
    try {
      mode = io.statSync(targetPath).mode & 0o7777;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    atomicCursorWrite(io, targetPath, serializeCursorConfig(root), mode);
  }

  function failed(previous: CursorConnectState, error: unknown): CursorConnectResult {
    return { state: previous, path: configPath, actionFailed: true, errorCode: errorCode(error) };
  }

  function connect(): CursorConnectResult {
    let loaded: ReturnType<typeof readConfig>;
    try {
      loaded = readConfig();
    } catch (error) {
      return { state: 'error', path: configPath, errorCode: errorCode(error) };
    }
    const previous = cursorConfigState(loaded.config, expected);
    try {
      if (previous === 'connected') return read();
      io.mkdirSync(cursorDir, { recursive: true });
      if (!io.existsSync(backupPath)) {
        createBackupIfMissing(io, backupPath, loaded.raw ?? Buffer.from('null'));
      }
      const merged = mergeCursorEntry(loaded.config, expected);
      write(merged.root);
      return read();
    } catch (error) {
      return failed(previous, error);
    }
  }

  function disconnect(): CursorConnectResult {
    let loaded: ReturnType<typeof readConfig>;
    try {
      loaded = readConfig();
    } catch (error) {
      return { state: 'error', path: configPath, errorCode: errorCode(error) };
    }
    const previous = cursorConfigState(loaded.config, expected);
    try {
      if (loaded.config.servers.conduit !== undefined) {
        const removed = removeCursorEntry(loaded.config);
        write(removed.root);
      }
      return read();
    } catch (error) {
      return failed(previous, error);
    }
  }

  return { read, connect, disconnect };
}

// see docs/specs/2026-10-26-conduit-mcp-cursor.md §3.3
export function readCursorLaunchEntry(homeDir: string): boolean {
  const configPath = path.join(homeDir, '.cursor', 'mcp.json');
  try {
    const realPath = fs.realpathSync(configPath);
    const parsed = parseCursorConfig(fs.readFileSync(realPath, 'utf8'));
    return wiresLaunch(parsed.servers.conduit);
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorCode(error: unknown): string {
  if (isCursorConfigParseError(error)) return 'EJSON';
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'EINVAL';
}

let tempSequence = 0;
function atomicCursorWrite(io: CursorConnectIo, target: string, data: string, mode?: number): void {
  const temporary = `${target}.tmp-${process.pid}-${++tempSequence}`;
  try {
    io.writeFileSync(temporary, data, { mode: mode ?? 0o666 });
    if (mode !== undefined) io.chmodSync(temporary, mode);
    io.renameSync(temporary, target);
  } catch (error) {
    try {
      io.unlinkSync(temporary);
    } catch {
      // The temporary may not have been created.
    }
    throw error;
  }
}

function createBackupIfMissing(io: CursorConnectIo, target: string, data: Buffer): void {
  const temporary = `${target}.tmp-${process.pid}-${++tempSequence}`;
  try {
    io.writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
    try {
      io.linkSync(temporary, target);
    } catch (error) {
      if (isAlreadyExists(error)) return;
      try {
        io.copyFileSync(temporary, target, fs.constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (!isAlreadyExists(copyError)) throw copyError;
      }
    }
  } finally {
    try {
      io.unlinkSync(temporary);
    } catch {
      // The temporary may not have been created.
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

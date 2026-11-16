import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { posix } from 'node:path';

export interface SocketDirectoryIo {
  mkdir(path: string, options: { recursive?: boolean; mode?: number }): unknown;
  chmod(path: string, mode: number): void;
  lstat(path: string): {
    uid: number;
    mode: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  };
}

const NODE_IO: SocketDirectoryIo = { mkdir: mkdirSync, lstat: lstatSync, chmod: chmodSync };

/**
 * Creates a socket's private directory and proves it is ours. A directory another local user
 * pre-created in a shared tmpdir would otherwise receive our socket, so an existing one is repaired
 * to 0700 when it is ours and refused when it is not.
 */
export function ensurePrivateSocketDirectory(
  directory: string,
  label: string,
  io: SocketDirectoryIo = NODE_IO,
  uid = process.getuid?.(),
): void {
  io.mkdir(posix.dirname(directory), { recursive: true });
  try {
    io.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = io.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid)
    throw new Error(`Unsafe ${label} ${directory}: must be owned by uid ${uid} and not a symlink`);
  if ((stat.mode & 0o777) !== 0o700) io.chmod(directory, 0o700);
}

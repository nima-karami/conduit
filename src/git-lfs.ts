import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { runGitBin } from './git-exec';

/** A real pointer is ~130 bytes; anything this large is content, never a pointer. */
const POINTER_MAX_BYTES = 1024;
// The hawser header predates the rename; git-lfs still accepts pointers written with it.
const POINTER_VERSIONS = [
  'version https://git-lfs.github.com/spec/v1\n',
  'version https://hawser.github.com/spec/v1\n',
];

export interface LfsPointer {
  oid: string;
  size: number;
}

/** The object a Git LFS pointer blob names, or null when `buf` is ordinary content. */
export function parseLfsPointer(buf: Buffer): LfsPointer | null {
  if (buf.length > POINTER_MAX_BYTES) return null;
  const text = buf.toString('utf8');
  if (!POINTER_VERSIONS.some((v) => text.startsWith(v))) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size) } : null;
}

/**
 * An image blob as displayable bytes: a Git LFS pointer is swapped for the object it names when
 * that object is in local LFS storage. Never runs the LFS smudge: it downloads, and against an
 * unreachable remote it retries for ~19s, outliving our git timeout as an orphaned git-lfs that
 * keeps the repo open. A missing object (or one over `maxBytes`) leaves the pointer, so the side
 * still exists and the diff keeps its true status.
 */
export async function resolveLfsImage(
  raw: Buffer,
  opts: { gitBin: string; cwd: string; timeoutMs: number; maxBytes: number },
): Promise<Buffer> {
  const ptr = parseLfsPointer(raw);
  if (!ptr || ptr.size > opts.maxBytes) return raw;
  const run = (args: string[]) =>
    runGitBin(opts.gitBin, args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
  const [commonDir, storage] = await Promise.all([
    run(['rev-parse', '--git-common-dir']),
    run(['config', 'lfs.storage']),
  ]);
  if (!commonDir.ok) return raw;
  const common = resolve(opts.cwd, commonDir.stdout.trim());
  const custom = storage.ok ? storage.stdout.trim() : '';
  const root = custom
    ? isAbsolute(custom)
      ? custom
      : resolve(common, custom)
    : join(common, 'lfs');
  const file = join(root, 'objects', ptr.oid.slice(0, 2), ptr.oid.slice(2, 4), ptr.oid);
  // Any unreadable object (not fetched, locked, denied) has one honest answer: keep the pointer,
  // which still fails to render. Throwing would cost the whole multi-file diff its reply.
  const obj = await readFile(file).catch(() => null);
  return obj && obj.length === ptr.size ? obj : raw;
}

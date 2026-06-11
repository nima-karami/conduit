import * as fs from 'node:fs';
import * as path from 'node:path';
import { langFromPath } from './lang';
import { validateWrite, type WriteResult } from './path-guard';
import type { DirEntryDTO, FileContentDTO, FileDiffDTO } from './protocol';

export { langFromPath };

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.vscode-test']);
const MAX_BYTES = 2 * 1024 * 1024;

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function sortEntries(entries: DirEntryDTO[]): DirEntryDTO[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export async function readDir(absPath: string): Promise<DirEntryDTO[]> {
  try {
    const ents = await fs.promises.readdir(absPath, { withFileTypes: true });
    const mapped: DirEntryDTO[] = ents
      .filter((e) => !IGNORED.has(e.name))
      .map((e) => ({ name: e.name, kind: (e.isDirectory() ? 'dir' : 'file') as 'dir' | 'file' }));
    return sortEntries(mapped);
  } catch {
    return [];
  }
}

export async function readFile(absPath: string, cap = MAX_BYTES): Promise<FileContentDTO> {
  const language = langFromPath(absPath);
  try {
    const stat = await fs.promises.stat(absPath);
    const buf = await fs.promises.readFile(absPath);
    if (isBinary(buf))
      return { path: absPath, content: '', language, truncated: false, binary: true };
    const truncated = stat.size > cap;
    const content = (truncated ? buf.subarray(0, cap) : buf).toString('utf8');
    return { path: absPath, content, language, truncated, binary: false };
  } catch {
    return {
      path: absPath,
      content: '',
      language,
      truncated: false,
      binary: false,
      error: 'File could not be read.',
    };
  }
}

/**
 * Write `content` to `absPath`, but ONLY after the path-guard confirms it stays
 * inside one of the open workspace `roots` (see path-guard.ts for the rules). The
 * renderer can request any path, so this is the trust boundary: a path that escapes
 * the workspace (via `..`, an absolute path outside a root, or a symlink) is
 * rejected and NOTHING is written.
 *
 * The write itself is atomic: content goes to a temp file in the same directory,
 * which is then renamed over the target. A failure mid-write (permission denied,
 * disk full) leaves the original file intact and surfaces the error to the caller,
 * so the renderer can keep the buffer dirty rather than falsely clearing it.
 */
export async function writeFile(
  absPath: string,
  content: string,
  roots: readonly string[],
): Promise<WriteResult> {
  const verdict = validateWrite(absPath, roots);
  if (!verdict.ok) return verdict;
  const target = verdict.path;
  const dir = path.dirname(target);
  // Same-directory temp so the final rename is atomic (same filesystem/volume).
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, target);
    return { ok: true, path: target };
  } catch (e: unknown) {
    // Best-effort cleanup of the temp file; never let cleanup mask the real error.
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function readDiff(
  absPath: string,
  gitShow: (p: string) => Promise<string>,
): Promise<FileDiffDTO> {
  let work = '';
  let binary = false;
  try {
    const buf = await fs.promises.readFile(absPath);
    if (isBinary(buf)) binary = true;
    else work = buf.toString('utf8');
  } catch {
    /* file may be deleted in the working tree */
  }
  const head = await gitShow(absPath).catch(() => '');
  const headBinary = head.includes('\0');
  const effectiveBinary = binary || headBinary;
  return {
    path: absPath,
    head: effectiveBinary ? '' : head,
    work: effectiveBinary ? '' : work,
    binary: effectiveBinary,
  };
}

import { isUtf8 } from 'node:buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isBinary } from './content-search';
import { isGoldenPath, langFromPath } from './lang';
import { imageMime, mediaKindForPath, pdfKindForPath } from './media-kind';
import {
  isInsideRoot,
  realPathLeaf,
  validateWrite,
  type WriteOptions,
  type WriteResult,
} from './path-guard';
import type { DiffBase, DiffScope, DirEntryDTO, FileContentDTO, FileDiffDTO } from './protocol';
import type { GrantStore } from './read-grants';

export { isBinary, langFromPath };

// Explorer tree ignore set â€” mirrors VS Code's default `files.exclude`: hide only VCS/OS
// metadata, show everything else (dist/out/node_modules), each read lazily per dir on expand.
const IGNORED = new Set(['.git', '.svn', '.hg', '.DS_Store', 'Thumbs.db']);
/** Text-file ceiling shared by readDiff and the editor's HEAD-blob read â€” the two must agree,
 *  or the editor would mark a file Review refuses to diff. */
export const MAX_BYTES = 2 * 1024 * 1024;

/** Hard cap for image previews: files larger than this return an error notice instead
 *  of a potentially giant base64 payload. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Hard cap for PDF previews. Bounds the base64 IPC payload (a PDF is delivered as a
 *  data URL just like an image); over-cap returns the error notice, no data URL. */
const MAX_PDF_BYTES = 50 * 1024 * 1024;

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
    if (mediaKindForPath(absPath) === 'image') {
      const stat = await fs.promises.stat(absPath);
      const bytes = stat.size;
      if (bytes > MAX_IMAGE_BYTES) {
        const mb = (bytes / (1024 * 1024)).toFixed(1);
        return {
          path: absPath,
          content: '',
          language,
          truncated: false,
          binary: true,
          error: `Image too large to preview (${mb} MB)`,
        };
      }
      const buf = await fs.promises.readFile(absPath);
      const dot = absPath.lastIndexOf('.');
      const ext = dot >= 0 ? absPath.slice(dot) : '';
      const mime = imageMime(ext);
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      return {
        path: absPath,
        content: '',
        language,
        truncated: false,
        binary: true,
        image: { mime, dataUrl, bytes },
      };
    }
    if (pdfKindForPath(absPath)) {
      const stat = await fs.promises.stat(absPath);
      const bytes = stat.size;
      if (bytes > MAX_PDF_BYTES) {
        const mb = (bytes / (1024 * 1024)).toFixed(1);
        const limitMb = Math.round(MAX_PDF_BYTES / (1024 * 1024));
        return {
          path: absPath,
          content: '',
          language,
          truncated: false,
          binary: true,
          error: `PDF too large to preview (${mb} MB; the in-app viewer limit is ${limitMb} MB). Open it in your system PDF app instead.`,
        };
      }
      const buf = await fs.promises.readFile(absPath);
      const dataUrl = `data:application/pdf;base64,${buf.toString('base64')}`;
      return {
        path: absPath,
        content: '',
        language,
        truncated: false,
        binary: true,
        pdf: { dataUrl, bytes },
      };
    }
    const stat = await fs.promises.stat(absPath);
    if (stat.size > cap) {
      const tail = language === 'log';
      const buf = await readWindow(absPath, tail ? stat.size - cap : 0, cap);
      if (isBinary(buf))
        return { path: absPath, content: '', language, truncated: false, binary: true };
      return {
        path: absPath,
        content: (tail ? fromFirstWholeLine(buf) : buf).toString('utf8'),
        language,
        truncated: true,
        binary: false,
        ...(tail ? { window: 'tail' as const } : {}),
      };
    }
    const buf = await fs.promises.readFile(absPath);
    if (isBinary(buf))
      return { path: absPath, content: '', language, truncated: false, binary: true };
    const readOnlyReason = !isUtf8(buf)
      ? 'invalid-utf8'
      : isGoldenPath(absPath) && eolKinds(buf) > 1
        ? 'mixed-eol'
        : undefined;
    return {
      path: absPath,
      content: buf.toString('utf8'),
      language,
      truncated: false,
      binary: false,
      ...(readOnlyReason ? { readOnlyReason } : {}),
    };
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

/** At most `length` bytes from `position`, through a handle: an over-cap file is never read whole
 *  (a 640 MB log cost +645 MB RSS that way â€” spec 2026-10-08-language-support Â§2.5). */
async function readWindow(absPath: string, position: number, length: number): Promise<Buffer> {
  const fh = await fs.promises.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** A tail window starts at an arbitrary byte: drop the partial first line (a split CRLF or UTF-8
 *  sequence with it). With no newline at all, only a split character's continuation bytes go. */
function fromFirstWholeLine(buf: Buffer): Buffer {
  const nl = buf.indexOf(0x0a);
  if (nl !== -1) return buf.subarray(nl + 1);
  let i = 0;
  while (i < 3 && i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
  return buf.subarray(i);
}

/** How many of CRLF, bare LF and bare CR occur in `buf` (0â€“3). */
function eolKinds(buf: Uint8Array): number {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d) {
      if (buf[i + 1] === 0x0a) {
        crlf = 1;
        i++;
      } else cr = 1;
    } else if (buf[i] === 0x0a) lf = 1;
  }
  return crlf + lf + cr;
}

/** Refusal when the target's current content isn't `expected`; null when it matches. Uncapped
 *  and decoded exactly as `readFile` decodes, so a >2 MB or BOM-led file compares whole. */
async function compareOnDisk(target: string, expected: string): Promise<WriteResult | null> {
  let onDisk: string;
  try {
    onDisk = (await fs.promises.readFile(target)).toString('utf8');
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: false, conflict: 'deleted', error: 'The file was deleted on disk.' };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return onDisk === expected
    ? null
    : { ok: false, conflict: 'changed', error: 'The file changed on disk.' };
}

/** IPC trust boundary for `writeFile`'s options: `undefined` â†’ `{}`; a plain object whose
 *  `expected` is absent or a string â†’ `{expected?}` (other keys ignored); anything else â†’ null. */
export function parseWriteOptions(raw: unknown): WriteOptions | null {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { expected } = raw as { expected?: unknown };
  if (expected === undefined) return {};
  return typeof expected === 'string' ? { expected } : null;
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
 *
 * A write is permitted when EITHER `validateWrite` passes against `roots`, OR (K2)
 * the canonical real path of the target is a recorded read-grant â€” a file the host
 * itself served via `readFile`, which can legitimately live outside every root
 * (go-to-definition targets, out-of-root recents). The grant branch still rejects a
 * directory and still re-canonicalizes the CURRENT real path at write time (so a
 * post-read symlink swap can't redirect the write â€” it just fails closed back to the
 * root check). `validateWrite` itself is never weakened. See src/read-grants.ts.
 *
 * `opts.expected` (auto-save) adds a compare-before-write that runs only AFTER the target is
 * confined, so a rejected path answers exactly as it would without it. See
 * docs/specs/2026-09-28-auto-save.md Â§3.
 */
export async function writeFile(
  absPath: string,
  content: string,
  roots: readonly string[],
  grants?: GrantStore,
  opts?: WriteOptions,
): Promise<WriteResult> {
  const verdict = validateWrite(absPath, roots);
  let target: string;
  if (verdict.ok) {
    target = verdict.path;
  } else {
    // Root containment rejected â€” fall back to the read-grant allowance. Resolve the
    // CURRENT real path and check it against the grants the host recorded on read.
    const real = realPathLeaf(path.resolve(absPath));
    if (!grants?.has(real)) return verdict; // neither rooted nor granted â€” original reason
    // A grant is an exact FILE; never clobber a directory even on this branch.
    try {
      if (fs.statSync(real).isDirectory()) {
        return { ok: false, error: `Refusing to write over a directory: ${absPath}` };
      }
    } catch {
      /* missing target â€” a granted file that's since been deleted; the write recreates it */
    }
    target = real;
  }
  if (opts?.expected !== undefined) {
    const refused = await compareOnDisk(target, opts.expected);
    if (refused) return refused;
  }
  const dir = path.dirname(target);
  // Same-directory temp so the final rename is atomic (same filesystem/volume).
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    // Overwrite of a buffer whose folder was deleted under it. Rooted writes only: validateWrite
    // proved the whole path inside a root; a read grant is one exact file, never its folders.
    // And only below a root that still exists â€” a recursive mkdir would otherwise recreate a
    // deleted root and every missing ancestor above it, outside every root.
    if (verdict.ok && !fs.statSync(dir, { throwIfNoEntry: false })) {
      const root = roots.find((r) => isInsideRoot(target, r));
      if (!root || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
        return { ok: false, error: `The workspace folder no longer exists: ${root ?? absPath}` };
      }
      await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, target);
    return { ok: true, path: target };
  } catch (e: unknown) {
    // Best-effort cleanup of the temp file; never let cleanup mask the real error.
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Build the image side of a diff (or the text side as before). Pure over its inputs
 *  so the status/over-cap decision is unit-testable without git or the filesystem. */
export function buildImageDiff(
  absPath: string,
  workBuf: Buffer | null,
  headBuf: Buffer | null,
): FileDiffDTO {
  const dot = absPath.lastIndexOf('.');
  const mime = imageMime(dot >= 0 ? absPath.slice(dot) : '');
  const toData = (buf: Buffer) => `data:${mime};base64,${buf.toString('base64')}`;

  const workOver = workBuf != null && workBuf.length > MAX_IMAGE_BYTES;
  const headOver = headBuf != null && headBuf.length > MAX_IMAGE_BYTES;
  // Either side over the cap â‡’ degrade to the plain "no preview" notice (never a
  // misleading one-sided diff). binary:true keeps non-image consumers unaffected.
  if (workOver || headOver) {
    return {
      path: absPath,
      head: '',
      work: '',
      binary: true,
      image: { status: 'modified', overCap: true },
    };
  }

  const work = workBuf ? { dataUrl: toData(workBuf), bytes: workBuf.length } : undefined;
  const head = headBuf ? { dataUrl: toData(headBuf), bytes: headBuf.length } : undefined;
  // Status is derived from which sides exist â€” the renderer never re-derives it.
  const status: 'modified' | 'added' | 'deleted' = !head ? 'added' : !work ? 'deleted' : 'modified';
  return { path: absPath, head: '', work: '', binary: true, image: { head, work, status } };
}

/** An UNMERGED path, which a blob read reports instead of text/bytes. A conflict leaves no
 *  stage-0 index entry, and an empty read is otherwise indistinguishable from an empty blob â€”
 *  which renders the whole file as deleted. */
export const UNMERGED = { unmerged: true } as const;
export type Unmerged = typeof UNMERGED;
const isUnmerged = (v: unknown): v is Unmerged =>
  typeof v === 'object' && v !== null && 'unmerged' in v;

export async function readDiff(
  absPath: string,
  gitShow: (p: string, ref: DiffBase) => Promise<string | Unmerged>,
  gitShowBuffer?: (p: string, ref: DiffBase) => Promise<Buffer | null | Unmerged>,
  scope: DiffScope = {},
): Promise<FileDiffDTO> {
  const base = scope.base ?? 'head';
  const side = scope.side ?? 'worktree';
  const conflicted: FileDiffDTO = {
    path: absPath,
    head: '',
    work: '',
    binary: false,
    unmerged: true,
  };

  if (mediaKindForPath(absPath) === 'image' && gitShowBuffer) {
    // A missing blob on either side is how "added"/"deleted" is expressed, so both reads
    // collapse a failure to null rather than throwing.
    const workBuf =
      side === 'index'
        ? await gitShowBuffer(absPath, 'index').catch(() => null)
        : await fs.promises.readFile(absPath).catch(() => null);
    const headBuf = await gitShowBuffer(absPath, base).catch(() => null);
    if (isUnmerged(workBuf) || isUnmerged(headBuf)) return conflicted;
    return buildImageDiff(absPath, workBuf, headBuf);
  }

  let work = '';
  let binary = false;
  if (side === 'index') {
    const staged = await gitShow(absPath, 'index').catch(() => '');
    if (isUnmerged(staged)) return conflicted;
    if (staged.length > MAX_BYTES) {
      return {
        path: absPath,
        head: '',
        work: '',
        binary: false,
        oversize: { bytes: staged.length },
      };
    }
    if (staged.includes('\0')) binary = true;
    else work = staged;
  } else {
    try {
      // Stat before reading so a giant file is flagged without ever allocating its buffer.
      const stat = await fs.promises.stat(absPath);
      if (stat.size > MAX_BYTES) {
        return { path: absPath, head: '', work: '', binary: false, oversize: { bytes: stat.size } };
      }
      const buf = await fs.promises.readFile(absPath);
      if (isBinary(buf)) binary = true;
      else work = buf.toString('utf8');
    } catch {
      /* file may be deleted in the working tree */
    }
  }
  const headRead = await gitShow(absPath, base).catch(() => '');
  if (isUnmerged(headRead)) return conflicted;
  const head = headRead;
  if (head.length > MAX_BYTES) {
    return { path: absPath, head: '', work: '', binary: false, oversize: { bytes: head.length } };
  }
  const headBinary = head.includes('\0');
  const effectiveBinary = binary || headBinary;
  return {
    path: absPath,
    // Normalize CRLFâ†’LF for display only (never a write path): under Windows +
    // core.autocrlf=true the working file is CRLF while `git show` returns LF, so the
    // Monaco diff would otherwise mark every line changed. On-disk EOLs are untouched.
    head: effectiveBinary ? '' : toLf(head),
    work: effectiveBinary ? '' : toLf(work),
    binary: effectiveBinary,
  };
}

/** `readDiff` for the IPC reply: a throw becomes `error` on the DTO, so the tab that asked
 *  always gets an answer instead of waiting on `Loading diffâ€¦` forever (spec 2026-09-22 Â§13 D7). */
export async function readDiffReply(
  absPath: string,
  gitShow: (p: string, ref: DiffBase) => Promise<string | Unmerged>,
  gitShowBuffer: ((p: string, ref: DiffBase) => Promise<Buffer | null | Unmerged>) | undefined,
  scope: DiffScope,
): Promise<FileDiffDTO> {
  try {
    return await readDiff(absPath, gitShow, gitShowBuffer, scope);
  } catch (e) {
    return {
      path: absPath,
      head: '',
      work: '',
      binary: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** CRLFâ†’LF for DISPLAY only, never a write path. Shared with src/head-blob.ts. */
export const toLf = (s: string): string => s.replace(/\r\n/g, '\n');

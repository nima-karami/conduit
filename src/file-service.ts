import * as fs from 'node:fs';
import * as path from 'node:path';
import { isBinary } from './content-search';
import { langFromPath } from './lang';
import { imageMime, mediaKindForPath, pdfKindForPath } from './media-kind';
import { realPathLeaf, validateWrite, type WriteResult } from './path-guard';
import type { DirEntryDTO, FileContentDTO, FileDiffDTO } from './protocol';
import type { GrantStore } from './read-grants';

export { isBinary, langFromPath };

// Directory-listing ignore set for the Explorer tree (a narrower set than the search
// walk's content-search IGNORED — the tree intentionally still shows e.g. build/.cache).
const IGNORED = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.vscode-test']);
const MAX_BYTES = 2 * 1024 * 1024;

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
 *
 * A write is permitted when EITHER `validateWrite` passes against `roots`, OR (K2)
 * the canonical real path of the target is a recorded read-grant — a file the host
 * itself served via `readFile`, which can legitimately live outside every root
 * (go-to-definition targets, out-of-root recents). The grant branch still rejects a
 * directory and still re-canonicalizes the CURRENT real path at write time (so a
 * post-read symlink swap can't redirect the write — it just fails closed back to the
 * root check). `validateWrite` itself is never weakened. See src/read-grants.ts.
 */
export async function writeFile(
  absPath: string,
  content: string,
  roots: readonly string[],
  grants?: GrantStore,
): Promise<WriteResult> {
  const verdict = validateWrite(absPath, roots);
  let target: string;
  if (verdict.ok) {
    target = verdict.path;
  } else {
    // Root containment rejected — fall back to the read-grant allowance. Resolve the
    // CURRENT real path and check it against the grants the host recorded on read.
    const real = realPathLeaf(path.resolve(absPath));
    if (!grants?.has(real)) return verdict; // neither rooted nor granted — original reason
    // A grant is an exact FILE; never clobber a directory even on this branch.
    try {
      if (fs.statSync(real).isDirectory()) {
        return { ok: false, error: `Refusing to write over a directory: ${absPath}` };
      }
    } catch {
      /* missing target — a granted file that's since been deleted; the write recreates it */
    }
    target = real;
  }
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
  // Either side over the cap ⇒ degrade to the plain "no preview" notice (never a
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
  // Status is derived from which sides exist — the renderer never re-derives it.
  const status: 'modified' | 'added' | 'deleted' = !head ? 'added' : !work ? 'deleted' : 'modified';
  return { path: absPath, head: '', work: '', binary: true, image: { head, work, status } };
}

export async function readDiff(
  absPath: string,
  gitShow: (p: string) => Promise<string>,
  gitShowBuffer?: (p: string) => Promise<Buffer | null>,
): Promise<FileDiffDTO> {
  if (mediaKindForPath(absPath) === 'image' && gitShowBuffer) {
    let workBuf: Buffer | null = null;
    try {
      workBuf = await fs.promises.readFile(absPath);
    } catch {
      /* file may be deleted in the working tree ⇒ deleted */
    }
    const headBuf = await gitShowBuffer(absPath).catch(() => null);
    return buildImageDiff(absPath, workBuf, headBuf);
  }

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

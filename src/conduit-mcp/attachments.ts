import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { imageMime, mediaKindForPath } from '../media-kind';
import { isInsideRoot, realPathLeaf } from '../path-guard';
import { type Result, toolError } from './types';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
export const TEXT_PAGE_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface AttachmentSender {
  home: string;
  roots: readonly string[];
}
export interface AttachmentSnapshot {
  name: string;
  mime: string;
  data: Uint8Array;
  sha256: string;
}
export interface AttachmentFs {
  /** undefined = missing */
  stat(p: string): Promise<{ size: number; isFile: boolean } | undefined>;
  readFile(p: string): Promise<Uint8Array>;
}

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

export const nodeAttachmentFs: AttachmentFs = {
  async stat(p) {
    try {
      const st = await fs.promises.stat(p);
      return { size: st.size, isFile: st.isFile() };
    } catch (e) {
      if (MISSING.has((e as NodeJS.ErrnoException).code ?? '')) return undefined;
      throw e;
    }
  },
  readFile: async (p) => new Uint8Array(await fs.promises.readFile(p)),
};

type Fail = { ok: false; error: ReturnType<typeof toolError> };
const fail = (code: Parameters<typeof toolError>[0], message: string): Fail => ({
  ok: false,
  error: toolError(code, message),
});
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Snapshot at send time, confined to the sender's roots. The order is fixed (plan Contracts,
 * attachments.ts) and the bytes come from the realpath that was checked (ADR 0005).
 */
export async function snapshotAttachment(
  sender: AttachmentSender,
  rawPath: string,
  afs: AttachmentFs = nodeAttachmentFs,
): Promise<Result<AttachmentSnapshot>> {
  const abs = path.resolve(sender.home, rawPath);
  const root = [sender.home, ...sender.roots].find((r) => isInsideRoot(abs, r));
  if (root === undefined) return fail('path_outside_roots', `${rawPath} is outside your roots`);
  const real = realPathLeaf(abs);
  if (!isInsideRoot(real, realPathLeaf(root))) {
    return fail('path_outside_roots', `${rawPath} resolves outside your roots`);
  }
  let data: Uint8Array;
  try {
    const st = await afs.stat(real);
    if (!st?.isFile) return fail('path_unreadable', `${rawPath} is not a readable file`);
    if (st.size > MAX_ATTACHMENT_BYTES) return fail('too_large', `${rawPath} is over 10 MB`);
    data = await afs.readFile(real);
  } catch (e) {
    return fail('path_unreadable', `${rawPath}: ${messageOf(e)}`);
  }
  if (data.byteLength > MAX_ATTACHMENT_BYTES) return fail('too_large', `${rawPath} is over 10 MB`);
  const name = path.basename(abs);
  return {
    ok: true,
    value: {
      name,
      mime: mimeFor(name, data),
      data,
      sha256: createHash('sha256').update(data).digest('hex'),
    },
  };
}

const TEXT_MIME: Readonly<Record<string, string>> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
};
const PLAIN_TEXT_EXTS = new Set([
  '.txt',
  '.log',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.ini',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.sh',
  '.ps1',
  '.sql',
  '.diff',
  '.patch',
]);

function isUtf8Text(data: Uint8Array): boolean {
  if (data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

export function mimeFor(name: string, data: Uint8Array): string {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot).toLowerCase();
  if (mediaKindForPath(name) === 'image') return imageMime(ext);
  const known = TEXT_MIME[ext] ?? (PLAIN_TEXT_EXTS.has(ext) ? 'text/plain' : undefined);
  if (known) return known;
  return isUtf8Text(data) ? 'text/plain' : 'application/octet-stream';
}

/** One page ending on a UTF-8 character boundary, so a page never splits a character. */
export function textPage(
  data: Uint8Array,
  offset: number,
): { text: string; nextOffset: number | null } {
  if (offset >= data.length) return { text: '', nextOffset: null };
  let end = Math.min(data.length, offset + TEXT_PAGE_BYTES);
  while (end < data.length && end > offset && (data[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: new TextDecoder('utf-8').decode(data.subarray(offset, end)),
    nextOffset: end >= data.length ? null : end,
  };
}

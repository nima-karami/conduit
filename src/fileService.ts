import * as fs from 'fs';
import { DirEntryDTO, FileContentDTO, FileDiffDTO } from './protocol';

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.vscode-test']);
const MAX_BYTES = 2 * 1024 * 1024;

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  json: 'json', md: 'markdown', markdown: 'markdown', css: 'css', scss: 'scss', html: 'html',
  py: 'python', rs: 'rust', go: 'go', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby',
  php: 'php', sql: 'sql', xml: 'xml', svg: 'xml',
};

export function langFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return LANG[ext] ?? 'plaintext';
}

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
    if (isBinary(buf)) return { path: absPath, content: '', language, truncated: false, binary: true };
    const truncated = stat.size > cap;
    const content = (truncated ? buf.subarray(0, cap) : buf).toString('utf8');
    return { path: absPath, content, language, truncated, binary: false };
  } catch {
    return { path: absPath, content: '', language, truncated: false, binary: false };
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
  return { path: absPath, head: binary ? '' : head, work, binary };
}

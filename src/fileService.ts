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

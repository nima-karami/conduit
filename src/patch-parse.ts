// Pure unified-diff parser for open_diff (spec 2026-11-05-open-diff). No I/O.
//
// Accepted formats:
//   - git diff / git format-patch / diff -u / svn diff / hg diff
//   - git extended headers (rename, copy, new/deleted file, mode change, binary)
//   - bare ---/+++ pair with no diff header
//   - \\ No newline at end of file
//   - CRLF patches
//
// Rejects anything that is not a unified diff with a clear `invalid_input` reason.

import type { FileDiffDTO } from './protocol';
import type { ReviewHunk } from './review-hunks';

export type PatchChangeKind = 'M' | 'A' | 'D' | 'R' | 'C' | 'T';

/** One hunk as parsed from a patch, before conversion to the renderer's ReviewHunk shape. */
export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: { kind: 'context' | 'add' | 'del'; text: string; noNewline?: boolean }[];
}

/** A parsed patch file, before keys are assigned; the parser builds these and keys them last. */
type PatchFileDraft = Omit<ParsedPatchFile, 'key'>;

/** A parsed patch file; also the shape that travels to the renderer for a `patch` ReviewSource. */
export interface ParsedPatchFile {
  /** The new/current path (the one Review should list). */
  path: string;
  /** Unique card/diff-map key; set at parse so duplicate paths never collide. */
  key: string;
  /** The previous path, present for renames and copies. */
  oldPath?: string;
  /** Old-side content; empty for adds, binaries, and mode-only changes. */
  head: string;
  /** New-side content; empty for deletes, binaries, and mode-only changes. */
  work: string;
  binary: boolean;
  changeKind: PatchChangeKind;
  /** Mode-change metadata; present when the patch carries old/new mode headers. */
  mode?: { old?: string; new: string };
  /** Line counts derived from the hunks (binary/mode-only files are 0/0). */
  counts: { added: number; removed: number };
  /** Parsed hunks with their original line numbers and content. */
  hunks: PatchHunk[];
}

export interface ParsedPatch {
  ok: true;
  files: ParsedPatchFile[];
}

export interface PatchParseError {
  ok: false;
  reason: string;
}

export type PatchParseResult = ParsedPatch | PatchParseError;

/** Internal result shape for helpers that parse one piece of a patch. */
type ParseResult<T> = { ok: true; value: T } | PatchParseError;

export const MAX_PATCH_BYTES = 5 * 1024 * 1024;

/** True when the patch text exceeds the 5 MB cap. */
export function patchOverSizeCap(text: string): boolean {
  return new TextEncoder().encode(text).length > MAX_PATCH_BYTES;
}

/** Decode patch bytes. A UTF-16 BOM (LE/BE) is honoured; everything else is UTF-8. */
export function decodePatchBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Parse unified diff text. Returns `{ ok: false, reason }` for:
 *   - empty input
 *   - input that never reaches a `---/+++` file header
 *   - malformed hunk headers
 *   - hunk line counts that do not match the header
 *   - stray non-diff text before the first file header
 */
export function parsePatch(text: string): PatchParseResult {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text === '') return { ok: false, reason: 'empty patch' };
  const lines = splitLines(text);
  const state = new ParserState(lines);
  const files: PatchFileDraft[] = [];

  while (!state.done()) {
    const cur = state.current();
    if (cur.startsWith('diff --git ')) {
      const file = parseGitFile(state);
      if (!file.ok) return file;
      files.push(file.value);
      continue;
    }
    if (atFileHeader(state)) {
      const file = parseBareFile(state);
      if (!file.ok) return file;
      files.push(file.value);
      continue;
    }
    // Preamble (format-patch mail headers, svn/hg noise) and inter-file junk are skipped.
    state.advance();
  }

  if (files.length === 0) return { ok: false, reason: 'not a unified diff' };
  return { ok: true, files: keyPatchFiles(files) };
}

/**
 * Convert a parsed patch into the FileDiffDTO shape Review already renders.
 * The original hunks are preserved with their real start lines so a hunk at
 * @@ -100 renders from line 100 and separate hunks stay separate.
 */
export function patchFilesToFileDiffs(files: ParsedPatchFile[]): FileDiffDTO[] {
  return files.map((f) => ({
    path: f.key,
    head: f.head,
    work: f.work,
    binary: f.binary,
    counts: f.binary || f.changeKind === 'T' ? undefined : f.counts,
    hunks: f.binary || f.changeKind === 'T' ? undefined : fileHunksToReviewHunks(f.hunks),
  }));
}

/** O(n) keys: a literal `f.ts (2)` never collides with the second `f.ts`. */
function keyPatchFiles(drafts: PatchFileDraft[]): ParsedPatchFile[] {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return drafts.map((f) => ({ ...f, key: nextDisambiguatedKey(f.path, used, nextSuffix) }));
}

function nextDisambiguatedKey(
  path: string,
  used: Set<string>,
  nextSuffix: Map<string, number>,
): string {
  if (!used.has(path)) {
    used.add(path);
    nextSuffix.set(path, 2);
    return path;
  }
  let n = nextSuffix.get(path) ?? 2;
  let key = `${path} (${n})`;
  while (used.has(key)) {
    n += 1;
    key = `${path} (${n})`;
  }
  used.add(key);
  nextSuffix.set(path, n + 1);
  return key;
}

function fileHunksToReviewHunks(hunks: PatchHunk[]): ReviewHunk[] {
  let seq = 0;
  return hunks.map((h) => hunkToReviewHunk(h, () => seq++));
}

function hunkToReviewHunk(h: PatchHunk, nextSeq: () => number): ReviewHunk {
  const lines: ReviewHunk['lines'] = [];
  let oldLine = h.oldStart;
  let newLine = h.newStart;
  for (const l of h.lines) {
    const seq = nextSeq();
    if (l.kind === 'context') {
      lines.push({ kind: 'context', text: l.text, oldLine, newLine, seq });
      oldLine++;
      newLine++;
    } else if (l.kind === 'add') {
      lines.push({ kind: 'add', text: l.text, oldLine: null, newLine, seq });
      newLine++;
    } else if (l.kind === 'del') {
      lines.push({ kind: 'del', text: l.text, oldLine, newLine: null, seq });
      oldLine++;
    }
  }
  return {
    startNewLine: h.newStart,
    startOldLine: h.oldCount === 0 ? null : h.oldStart,
    lines,
  };
}

class ParserState {
  private i = 0;
  constructor(private readonly lines: string[]) {}
  done(): boolean {
    return this.i >= this.lines.length;
  }
  current(): string {
    return this.lines[this.i] ?? '';
  }
  peek(): string {
    return this.lines[this.i + 1] ?? '';
  }
  advance(): void {
    this.i += 1;
  }
}

function atFileHeader(state: ParserState): boolean {
  return state.current().startsWith('--- ') && state.peek().startsWith('+++ ');
}

function splitLines(text: string): string[] {
  const normalised = text.replace(/\r\n/g, '\n');
  if (normalised === '') return [];
  const lines = normalised.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function stripPrefix(line: string): string {
  return line.slice(1);
}

const BIDI_OVERRIDES = /[\u202A-\u202E\u2066-\u2069]/;

/** Git C-quoting: quoted token → bytes (octal, \\t, \\n, \\", \\) then UTF-8. Unquoted is as-is. */
function unescapeGitPath(token: string): string | null {
  if (!token.startsWith('"')) return token;
  if (token.length < 2 || !token.endsWith('"')) return null;
  const inner = token.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      const cp = inner.charCodeAt(i);
      if (cp > 127) bytes.push(...new TextEncoder().encode(inner[i]));
      else bytes.push(cp);
      continue;
    }
    i++;
    if (i >= inner.length) return null;
    const e = inner[i];
    if (e === 't') bytes.push(0x09);
    else if (e === 'n') bytes.push(0x0a);
    else if (e === '"') bytes.push(0x22);
    else if (e === '\\') bytes.push(0x5c);
    else if (e >= '0' && e <= '7') {
      let val = e.charCodeAt(0) - 48;
      let n = 1;
      while (n < 3 && i + 1 < inner.length) {
        const d = inner[i + 1];
        if (d < '0' || d > '7') break;
        i++;
        n++;
        val = val * 8 + (d.charCodeAt(0) - 48);
      }
      bytes.push(val & 0xff);
    } else return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function hasUnsafeChars(p: string): boolean {
  for (const ch of p) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) return true;
    if (BIDI_OVERRIDES.test(ch)) return true;
  }
  return false;
}

/** Reject paths that could open files outside the patch's scope. */
function isSafePath(p: string): boolean {
  if (p === '/dev/null') return true;
  if (p.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  if (hasUnsafeChars(p)) return false;
  const parts = p.split(/[\\/]/);
  if (parts.some((part) => part === '' || part === '..')) return false;
  return parts.length > 0;
}

function parseGitFile(state: ParserState): ParseResult<PatchFileDraft> {
  const diffLine = state.current();
  const paths = parseDiffGitLine(diffLine);
  if (paths) {
    if (!isSafePath(paths.oldPath)) return { ok: false, reason: 'invalid path in diff header' };
    if (!isSafePath(paths.newPath)) return { ok: false, reason: 'invalid path in diff header' };
  }
  let changeKind: PatchChangeKind = 'M';
  let mode: { old?: string; new: string } | undefined;
  let binary = false;
  let sawRenameOrCopy = false;
  state.advance();

  while (!state.done()) {
    const line = state.current();
    if (line.startsWith('diff --git ') || atFileHeader(state)) break;

    if (line.startsWith('index ')) {
      state.advance();
      continue;
    }
    if (line.startsWith('old mode ')) {
      mode ??= { new: '' };
      mode.old = line.slice('old mode '.length).trim();
      state.advance();
      continue;
    }
    if (line.startsWith('new mode ')) {
      mode ??= { new: '' };
      mode.new = line.slice('new mode '.length).trim();
      state.advance();
      continue;
    }
    if (line.startsWith('new file mode ')) {
      changeKind = 'A';
      mode = { new: line.slice('new file mode '.length).trim() };
      state.advance();
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      changeKind = 'D';
      mode = { new: line.slice('deleted file mode '.length).trim() };
      state.advance();
      continue;
    }
    if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) {
      state.advance();
      continue;
    }
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      changeKind = 'R';
      sawRenameOrCopy = true;
      state.advance();
      continue;
    }
    if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      changeKind = 'C';
      sawRenameOrCopy = true;
      state.advance();
      continue;
    }
    if (line.startsWith('Binary files ')) {
      binary = true;
      state.advance();
      continue;
    }
    if (line === 'GIT binary patch') {
      binary = true;
      while (!state.done()) {
        const cur = state.current();
        if (cur === '' || cur.startsWith('diff --git ') || cur.startsWith('--- ')) break;
        state.advance();
      }
      continue;
    }
    // End of extended headers.
    break;
  }

  // No ---/+++ pair: empty new/deleted, rename/copy, mode-only, or binary. Anything else is an
  // incomplete git header, not a blank card.
  if (!atFileHeader(state)) {
    if (!paths) return { ok: false, reason: 'malformed diff --git header' };
    const { oldPath, newPath } = paths;
    if (binary) {
      return {
        ok: true,
        value: {
          path: newPath,
          oldPath: changeKind === 'D' || changeKind === 'A' ? undefined : oldPath,
          head: '',
          work: '',
          binary: true,
          changeKind,
          mode,
          counts: { added: 0, removed: 0 },
          hunks: [],
        },
      };
    }
    if (mode && changeKind === 'M') {
      return {
        ok: true,
        value: {
          path: newPath,
          oldPath,
          head: '',
          work: '',
          binary: false,
          changeKind: 'T',
          mode,
          counts: { added: 0, removed: 0 },
          hunks: [],
        },
      };
    }
    if (changeKind === 'A' || changeKind === 'D') {
      return {
        ok: true,
        value: {
          path: newPath,
          head: '',
          work: '',
          binary: false,
          changeKind,
          mode,
          counts: { added: 0, removed: 0 },
          hunks: [],
        },
      };
    }
    if (sawRenameOrCopy) {
      return {
        ok: true,
        value: {
          path: newPath,
          oldPath,
          head: '',
          work: '',
          binary: false,
          changeKind,
          mode,
          counts: { added: 0, removed: 0 },
          hunks: [],
        },
      };
    }
    return { ok: false, reason: 'git header has no hunks and no rename, mode, or binary change' };
  }

  const prefixes = paths?.prefixes ?? ['a/', 'b/'];
  const header = parseFileHeaderPair(state, prefixes);
  if (!header.ok) return header;
  const { old: headerOld, new: headerNew } = header.value;
  if (headerOld === '/dev/null' && headerNew === '/dev/null') {
    return { ok: false, reason: 'file header has no hunks' };
  }
  const oldPath = headerOld === '/dev/null' ? (paths?.oldPath ?? headerOld) : headerOld;
  const newPath = headerNew === '/dev/null' ? (paths?.newPath ?? headerNew) : headerNew;
  if (!isSafePath(oldPath) || !isSafePath(newPath)) {
    return { ok: false, reason: 'invalid path in diff header' };
  }

  const hunks = parseHunks(state);
  if (!hunks.ok) return hunks;
  if (hunks.value.length === 0) {
    const emptyOk =
      binary ||
      changeKind === 'A' ||
      changeKind === 'D' ||
      sawRenameOrCopy ||
      !!(mode && changeKind === 'M');
    if (!emptyOk) return { ok: false, reason: 'file header has no hunks' };
  }
  const { head, work } = hunksToSides(hunks.value);
  const path = headerNew === '/dev/null' ? oldPath : newPath;

  return {
    ok: true,
    value: {
      path,
      oldPath: changeKind === 'D' || changeKind === 'A' ? undefined : oldPath,
      head,
      work,
      binary: false,
      changeKind,
      mode,
      counts: countHunkLines(hunks.value),
      hunks: hunks.value,
    },
  };
}

function parseBareFile(state: ParserState): ParseResult<PatchFileDraft> {
  const header = parseFileHeaderPair(state, ['a/', 'b/']);
  if (!header.ok) return header;
  const oldPath = header.value.old;
  const newPath = header.value.new;
  if (oldPath === '/dev/null' && newPath === '/dev/null') {
    return { ok: false, reason: 'file header has no hunks' };
  }
  if (!isSafePath(oldPath)) return { ok: false, reason: 'invalid path in diff header' };
  if (!isSafePath(newPath)) return { ok: false, reason: 'invalid path in diff header' };
  const changeKind: PatchChangeKind =
    oldPath === '/dev/null' ? 'A' : newPath === '/dev/null' ? 'D' : 'M';
  const displayPath = newPath === '/dev/null' ? oldPath : newPath;
  const hunks = parseHunks(state);
  if (!hunks.ok) return hunks;
  if (hunks.value.length === 0) return { ok: false, reason: 'file header has no hunks' };
  const { head, work } = hunksToSides(hunks.value);
  return {
    ok: true,
    value: {
      path: displayPath,
      oldPath: changeKind === 'A' || changeKind === 'D' ? undefined : oldPath,
      head,
      work,
      binary: false,
      changeKind,
      counts: countHunkLines(hunks.value),
      hunks: hunks.value,
    },
  };
}

const MNEMONIC_PREFIXES = ['i/', 'w/', 'c/'] as const;

function takeGitToken(s: string, from: number): { token: string; next: number } | null {
  if (from >= s.length) return null;
  if (s[from] === '"') {
    let i = from + 1;
    while (i < s.length) {
      if (s[i] === '\\') {
        i += i + 1 < s.length ? 2 : 1;
        continue;
      }
      if (s[i] === '"') return { token: s.slice(from, i + 1), next: i + 1 };
      i++;
    }
    return null;
  }
  const sp = s.indexOf(' ', from);
  if (sp === -1) return { token: s.slice(from), next: s.length };
  return { token: s.slice(from, sp), next: sp };
}

function applyGitPrefixes(
  oldP: string,
  newP: string,
): { oldPath: string; newPath: string; prefixes: readonly string[] } {
  if (oldP.startsWith('a/') && newP.startsWith('b/')) {
    return { oldPath: oldP.slice(2), newPath: newP.slice(2), prefixes: ['a/', 'b/'] };
  }
  const oldPre = MNEMONIC_PREFIXES.find((p) => oldP.startsWith(p));
  const newPre = MNEMONIC_PREFIXES.find((p) => newP.startsWith(p));
  if (oldPre && newPre && oldPre !== newPre) {
    return {
      oldPath: oldP.slice(oldPre.length),
      newPath: newP.slice(newPre.length),
      prefixes: MNEMONIC_PREFIXES,
    };
  }
  return { oldPath: oldP, newPath: newP, prefixes: [] };
}

function parseDiffGitLine(
  line: string,
): { oldPath: string; newPath: string; prefixes: readonly string[] } | null {
  const rest = line.slice('diff --git '.length);
  const a = takeGitToken(rest, 0);
  if (!a || a.token === '') return null;
  if (rest[a.next] !== ' ') return null;
  const b = takeGitToken(rest, a.next + 1);
  if (!b || b.token === '' || b.next !== rest.length) return null;
  const oldRaw = unescapeGitPath(a.token);
  const newRaw = unescapeGitPath(b.token);
  if (oldRaw === null || newRaw === null) return null;
  return applyGitPrefixes(oldRaw, newRaw);
}

function parseFileHeaderPair(
  state: ParserState,
  prefixes: readonly string[],
): ParseResult<{ old: string; new: string }> {
  const oldLine = state.current();
  if (!oldLine.startsWith('--- ')) return { ok: false, reason: 'expected --- header' };
  state.advance();
  const newLine = state.current();
  if (!newLine.startsWith('+++ ')) return { ok: false, reason: 'expected +++ header after ---' };
  state.advance();
  const oldPath = pathFromHeader(oldLine, prefixes);
  const newPath = pathFromHeader(newLine, prefixes);
  if (oldPath === null || newPath === null) {
    return { ok: false, reason: 'malformed ---/+++ file header' };
  }
  return { ok: true, value: { old: oldPath, new: newPath } };
}

function pathFromHeader(line: string, prefixes: readonly string[]): string | null {
  let afterMarker = line.slice(4);
  const tab = afterMarker.indexOf('\t');
  if (tab !== -1) afterMarker = afterMarker.slice(0, tab);
  const decoded = unescapeGitPath(afterMarker);
  if (decoded === null) return null;
  if (decoded === '/dev/null') return '/dev/null';
  for (const pre of prefixes) {
    if (decoded.startsWith(pre)) return decoded.slice(pre.length);
  }
  return decoded;
}

function isPatchTrailer(line: string): boolean {
  return /^--\s*$/.test(line);
}

function isSurplusHunkLine(line: string): boolean {
  if (line.startsWith('+') || line.startsWith(' ')) return true;
  if (!line.startsWith('-')) return false;
  if (line.startsWith('--- ')) return false;
  if (isPatchTrailer(line)) return false;
  return true;
}

function parseHunks(state: ParserState): ParseResult<PatchHunk[]> {
  const hunks: PatchHunk[] = [];
  while (!state.done()) {
    const line = state.current();
    // End of this file: next file, format-patch trailer, svn/hg separators, or a blank gap.
    // Bodies are consumed by hunk counts, so a deleted `-- comment` or a context `diff --git`
    // never reaches here.
    if (!line.startsWith('@@ ')) break;
    const header = parseHunkHeader(line);
    if (!header) return { ok: false, reason: 'malformed hunk header' };
    state.advance();
    const lines: PatchHunk['lines'] = [];
    let oldSeen = 0;
    let newSeen = 0;
    while (oldSeen < header.oldCount || newSeen < header.newCount) {
      if (state.done()) {
        return { ok: false, reason: 'hunk line count mismatch' };
      }
      const cur = state.current();
      if (cur.startsWith('\\')) {
        if (lines.length === 0) return { ok: false, reason: 'stray \\ No newline marker' };
        lines[lines.length - 1].noNewline = true;
        state.advance();
        continue;
      }
      if (cur === '') {
        // A blank line inside a hunk body is a context line whose leading space was stripped.
        lines.push({ kind: 'context', text: '', noNewline: false });
        oldSeen++;
        newSeen++;
        state.advance();
        continue;
      }
      const ch = cur.charAt(0);
      if (ch === ' ') {
        lines.push({ kind: 'context', text: stripPrefix(cur), noNewline: false });
        oldSeen++;
        newSeen++;
      } else if (ch === '+') {
        lines.push({ kind: 'add', text: stripPrefix(cur), noNewline: false });
        newSeen++;
      } else if (ch === '-') {
        lines.push({ kind: 'del', text: stripPrefix(cur), noNewline: false });
        oldSeen++;
      } else {
        return { ok: false, reason: 'unexpected line in hunk' };
      }
      state.advance();
    }
    if (oldSeen !== header.oldCount || newSeen !== header.newCount) {
      return { ok: false, reason: 'hunk line count mismatch' };
    }
    // The marker sits after the last counted line, so the count loop has already exited.
    if (!state.done() && state.current().startsWith('\\')) {
      if (lines.length === 0) return { ok: false, reason: 'stray \\ No newline marker' };
      lines[lines.length - 1].noNewline = true;
      state.advance();
    }
    if (!state.done() && isSurplusHunkLine(state.current())) {
      return { ok: false, reason: 'hunk line count mismatch' };
    }
    hunks.push({
      oldStart: header.oldStart,
      oldCount: header.oldCount,
      newStart: header.newStart,
      newCount: header.newCount,
      lines,
    });
  }
  return { ok: true, value: hunks };
}

function parseHunkHeader(
  line: string,
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  const [, oldStartStr, oldCountStr, newStartStr, newCountStr] = m;
  if (oldStartStr === undefined || newStartStr === undefined) return null;
  const oldStart = parseInt(oldStartStr, 10);
  const oldCount = oldCountStr === undefined ? 1 : parseInt(oldCountStr, 10);
  const newStart = parseInt(newStartStr, 10);
  const newCount = newCountStr === undefined ? 1 : parseInt(newCountStr, 10);
  if ([oldStart, oldCount, newStart, newCount].some((n) => Number.isNaN(n) || n < 0)) return null;
  return { oldStart, oldCount, newStart, newCount };
}

function hunksToSides(hunks: PatchHunk[]): { head: string; work: string } {
  const head: { text: string; noNewline: boolean }[] = [];
  const work: { text: string; noNewline: boolean }[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        head.push({ text: line.text, noNewline: !!line.noNewline });
        work.push({ text: line.text, noNewline: !!line.noNewline });
      } else if (line.kind === 'del') {
        head.push({ text: line.text, noNewline: !!line.noNewline });
      } else if (line.kind === 'add') {
        work.push({ text: line.text, noNewline: !!line.noNewline });
      }
    }
  }
  return { head: joinSide(head), work: joinSide(work) };
}

function joinSide(lines: { text: string; noNewline: boolean }[]): string {
  if (lines.length === 0) return '';
  return lines
    .map((l, i) => (i === lines.length - 1 && l.noNewline ? l.text : `${l.text}\n`))
    .join('');
}

function countHunkLines(hunks: PatchHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added += 1;
      else if (line.kind === 'del') removed += 1;
    }
  }
  return { added, removed };
}

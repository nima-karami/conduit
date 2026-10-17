/**
 * Soft-wrapped xterm rows joined into one logical line, so a path split at the wrap is one token
 * (spec 2026-10-16-terminal-path-links row 52; VS Code's getXtermLineContent model). Pure: takes
 * the slice of the xterm buffer API it reads.
 */
import { isPathChar, MAX_LOGICAL_LINE } from './terminal-links';

export interface BufferLike {
  length: number;
  getLine(
    y: number,
  ): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

export interface LogicalLine {
  text: string;
  /** 0-based buffer row of the group's first row. */
  firstRow: number;
  /** Text offset where each row of the group begins. */
  rowStarts: number[];
  /** Cells each row's text skips at its start (an Ink hard-wrap's indent); absent when none. */
  rowIndents?: number[];
  cols: number;
}

// Ink's continuation indent.
const MAX_INK_INDENT = 2;

/** A path char that is not box drawing or a block element: a TUI's frame fills whole rows, and
 *  joining on it would merge every bordered line into one. */
function joinsOn(ch: string | undefined): boolean {
  if (ch === undefined || ch === ' ') return false;
  const c = ch.charCodeAt(0);
  return isPathChar(ch) && !(c >= 0x2500 && c <= 0x259f);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** A row that is one punctuation char repeated (`-----`, `=====`): a separator rule is a full
 *  row of path chars, and joining it would glue it onto the path next to it. */
function isRule(row: string): boolean {
  const body = row.trim();
  if (body.length < 2 || WORD_CHAR.test(body[0])) return false;
  for (let i = 1; i < body.length; i++) if (body[i] !== body[0]) return false;
  return true;
}

/** Row 52, v1: Claude Code's Ink UI hard-wraps (no isWrapped). Row `a` continues into `a + 1`
 *  when it fills every column ending in a path char and the next row, after up to 2 spaces of
 *  indent, starts with one — unless either row is a rule. Returns that indent, or null. */
function inkIndent(buf: BufferLike, a: number, cols: number): number | null {
  const next = buf.getLine(a + 1);
  if (!next || next.isWrapped) return null;
  const cur = buf.getLine(a)?.translateToString(true) ?? '';
  if (cur.length !== cols || !joinsOn(cur[cur.length - 1]) || isRule(cur)) return null;
  const n = next.translateToString(true);
  if (isRule(n)) return null;
  let indent = 0;
  while (indent < MAX_INK_INDENT && n[indent] === ' ') indent++;
  return joinsOn(n[indent]) ? indent : null;
}

/** `y` is 0-based. Null when the row doesn't exist or the joined text exceeds MAX_LOGICAL_LINE. */
export function buildLogicalLine(buf: BufferLike, y: number, cols: number): LogicalLine | null {
  if (!buf.getLine(y)) return null;
  const tooLong = (rows: number) => rows * cols > MAX_LOGICAL_LINE + cols;
  const joinsPrev = (row: number) =>
    buf.getLine(row)?.isWrapped === true || inkIndent(buf, row - 1, cols) !== null;
  let first = y;
  while (first > 0 && joinsPrev(first)) {
    first--;
    if (tooLong(y - first + 1)) return null;
  }
  let last = y;
  while (last + 1 < buf.length && joinsPrev(last + 1)) {
    last++;
    if (tooLong(last - first + 1)) return null;
  }

  let text = '';
  const rowStarts: number[] = [];
  const rowIndents: number[] = [];
  for (let row = first; row <= last; row++) {
    const line = buf.getLine(row);
    if (!line) break;
    const indent = row > first && !line.isWrapped ? (inkIndent(buf, row - 1, cols) ?? 0) : 0;
    rowStarts.push(text.length);
    rowIndents.push(indent);
    // A non-last row is read at full width: its trailing blanks are real cells of the line.
    text += line.translateToString(row === last).slice(indent);
    if (text.length > MAX_LOGICAL_LINE) return null;
  }
  return {
    text,
    firstRow: first,
    rowStarts,
    ...(rowIndents.some((i) => i > 0) ? { rowIndents } : {}),
    cols,
  };
}

function rowOf(ll: LogicalLine, offset: number): number {
  let i = 0;
  while (i + 1 < ll.rowStarts.length && ll.rowStarts[i + 1] <= offset) i++;
  return i;
}

/** Logical offsets (end exclusive) → xterm's 1-based, end-inclusive buffer range. */
export function toBufferRange(
  ll: LogicalLine,
  start: number,
  end: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const startRow = rowOf(ll, start);
  const lastChar = Math.max(start, end - 1);
  const endRow = rowOf(ll, lastChar);
  const cell = (offset: number, row: number) =>
    offset - ll.rowStarts[row] + 1 + (ll.rowIndents?.[row] ?? 0);
  return {
    start: { x: cell(start, startRow), y: ll.firstRow + startRow + 1 },
    end: { x: cell(lastChar, endRow), y: ll.firstRow + endRow + 1 },
  };
}

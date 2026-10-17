/**
 * Soft-wrapped xterm rows joined into one logical line, so a path split at the wrap is one token
 * (spec 2026-10-16-terminal-path-links row 52; VS Code's getXtermLineContent model). Pure: takes
 * the slice of the xterm buffer API it reads.
 */
import { MAX_LOGICAL_LINE } from './terminal-links';

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
  cols: number;
}

/** `y` is 0-based. Null when the row doesn't exist or the joined text exceeds MAX_LOGICAL_LINE. */
export function buildLogicalLine(buf: BufferLike, y: number, cols: number): LogicalLine | null {
  if (!buf.getLine(y)) return null;
  let first = y;
  while (first > 0 && buf.getLine(first)?.isWrapped) first--;
  let last = y;
  while (last + 1 < buf.length && buf.getLine(last + 1)?.isWrapped) last++;
  if ((last - first + 1) * cols > MAX_LOGICAL_LINE + cols) return null;

  let text = '';
  const rowStarts: number[] = [];
  for (let row = first; row <= last; row++) {
    const line = buf.getLine(row);
    if (!line) break;
    rowStarts.push(text.length);
    // A non-last row is read at full width: its trailing blanks are real cells of the line.
    text += line.translateToString(row === last);
    if (text.length > MAX_LOGICAL_LINE) return null;
  }
  return { text, firstRow: first, rowStarts, cols };
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
  return {
    start: { x: start - ll.rowStarts[startRow] + 1, y: ll.firstRow + startRow + 1 },
    end: { x: lastChar - ll.rowStarts[endRow] + 1, y: ll.firstRow + endRow + 1 },
  };
}

import type { editor } from 'monaco-editor';
import type { HunkRange } from '../src/hunk-patch';
import { MAX_LCS_CELLS, type ReviewHunk, type ReviewLine } from '../src/review-hunks';
import { nextChange, prevChange } from './diff-nav';

/**
 * The same ceiling Review uses. It was 250 000, which — because the gate is over the SPAN from
 * the first to the last differing line, not the volume of change — cleared every marker off a
 * file whose two one-line edits were 500 lines apart. See spec 2026-08-31-review-fidelity §4 R3.1
 * for the measurement and §4 AC-T3.2 for why this still fits the recompute debounce.
 */
export const MAX_DECORATION_LCS_CELLS = MAX_LCS_CELLS;

/**
 * Vertical scrollbar width, which in a PLAIN editor is also the overview ruler's: monaco splits it
 * between its two lanes as `floor((width - 1) / 2)`, so 14 gave a change mark 6 px of a 14 px
 * strip. 20 yields a 9 px change lane and keeps 10 px for the error/warning lane (spec §4
 * decision 3, AC-T3.3/T3.4).
 *
 * The diff editor takes the same value for consistent furniture and nothing more: its change map
 * is monaco's own `OverviewRulerPart`, a separate 15 px-per-side strip this does not size, and its
 * sub-editors' rulers carry no change marks at all.
 */
export const OVERVIEW_RULER_WIDTH = 20;

export type ChangeKind = 'added' | 'modified' | 'deleted';

/**
 * One contiguous run of changed lines, in MODEL (new-side) coordinates.
 *
 * Per RUN, not per hunk: computeFileReview keeps unchanged gaps of up to 2*context inside a
 * single hunk, so a per-hunk bar would paint lines the agent never touched.
 */
export interface ChangeMarker {
  kind: ChangeKind;
  /** 1-based model line the marker starts on. For `deleted`, the line AFTER the removal. */
  startLine: number;
  /** 1-based model line the marker ends on (=== startLine for `deleted`). */
  endLine: number;
  addedLines: number;
  removedLines: number;
  /** 1-based old-side (baseline) span of the removed lines; `[k, k-1]` (empty) when none. It is
   *  the ONLY span a pure deletion has, so a stage or a discard from the editor needs it. */
  oldRange: [number, number];
  /** The removed lines, in order — what the change peek renders (spec §2 Lane E). */
  removedText: string[];
}

/** Monaco's enum values, injected so this module needs no runtime monaco import. */
export interface ChangeDecorationStyle {
  colors: Record<ChangeKind, string>;
  /** monaco.editor.OverviewRulerLane */
  rulerLane: number;
  /** monaco.editor.MinimapPosition */
  minimapPosition: number;
}

const clamp = (n: number, max: number): number => Math.min(Math.max(n, 1), Math.max(max, 1));

/** First model line at or after `from` within a hunk, or null when the hunk has none. */
function nextNewLine(lines: ReviewLine[], from: number): number | null {
  for (let i = from; i < lines.length; i++) {
    const n = lines[i].newLine;
    if (n !== null) return n;
  }
  return null;
}

/** Last old-side line number before `before`, or 0 when the run starts the hunk. */
function lastOldLineBefore(lines: ReviewLine[], before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    const o = lines[i].oldLine;
    if (o !== null) return o;
  }
  return 0;
}

const emptyAt = (n: number): [number, number] => [n, n - 1];

export function hunksToMarkers(hunks: ReviewHunk[], modelLineCount: number): ChangeMarker[] {
  const markers: ChangeMarker[] = [];
  for (const hunk of hunks) {
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === 'context') {
        i++;
        continue;
      }
      const start = i;
      while (i < lines.length && lines[i].kind !== 'context') i++;
      const run = lines.slice(start, i);
      const adds = run.filter((l) => l.kind === 'add');
      const dels = run.length - adds.length;
      const delLines = run.filter((l) => l.kind === 'del');
      const removedText = delLines.map((l) => l.text);
      const oldRange: [number, number] =
        delLines.length > 0
          ? [delLines[0].oldLine ?? 1, delLines[delLines.length - 1].oldLine ?? 1]
          : // A pure insertion sits AFTER the last old line before it — the seam, not line 1.
            emptyAt(lastOldLineBefore(lines, start) + 1);

      if (adds.length > 0) {
        const first = adds[0].newLine ?? 1;
        const last = adds[adds.length - 1].newLine ?? first;
        markers.push({
          kind: dels > 0 ? 'modified' : 'added',
          startLine: clamp(first, modelLineCount),
          endLine: clamp(last, modelLineCount),
          addedLines: adds.length,
          removedLines: dels,
          oldRange,
          removedText,
        });
        continue;
      }

      // Pure deletion: nothing on the new side, so anchor on the line that follows it —
      // the last model line when the removal ran to EOF.
      const anchor = clamp(nextNewLine(lines, i) ?? modelLineCount, modelLineCount);
      markers.push({
        kind: 'deleted',
        startLine: anchor,
        endLine: anchor,
        addedLines: 0,
        removedLines: dels,
        oldRange,
        removedText,
      });
    }
  }
  return markers;
}

const plural = (n: number): string => (n === 1 ? 'line' : 'lines');

export function markerTooltip(m: ChangeMarker): string {
  if (m.kind === 'deleted') return `Deleted ${m.removedLines} ${plural(m.removedLines)}`;
  if (m.kind === 'modified') return `Modified ${m.addedLines} ${plural(m.addedLines)}`;
  return `Added ${m.addedLines} ${plural(m.addedLines)}`;
}

/**
 * `map: false` keeps the gutter bars but paints nothing on the overview ruler or the minimap —
 * the answer for a file with no baseline, where one whole-file marker would stripe both surfaces
 * solid and locate nothing (spec 2026-08-31-review-fidelity §4 decision 4).
 */
export function hunksToDecorations(
  markers: ChangeMarker[],
  style: ChangeDecorationStyle,
  opts: { map?: boolean } = {},
): editor.IModelDeltaDecoration[] {
  const map = opts.map !== false;
  return markers.map((m) => ({
    range: {
      startLineNumber: m.startLine,
      startColumn: 1,
      endLineNumber: m.endLine,
      endColumn: 1,
    },
    options: {
      linesDecorationsClassName: `cdec cdec--${m.kind}`,
      hoverMessage: { value: markerTooltip(m) },
      ...(map
        ? {
            overviewRuler: { color: style.colors[m.kind], position: style.rulerLane },
            minimap: { color: style.colors[m.kind], position: style.minimapPosition },
          }
        : {}),
    },
  }));
}

/** Ascending, deduped anchor lines — a deletion can land on an addition's first line. */
export function markerLines(markers: ChangeMarker[]): number[] {
  return [...new Set(markers.map((m) => m.startLine))].sort((a, b) => a - b);
}

export function navigateMarkers(
  markers: ChangeMarker[],
  currentLine: number,
  direction: 'next' | 'prev',
): { line: number; index: number; total: number } | null {
  const lines = markerLines(markers);
  if (lines.length === 0) return null;
  const line =
    direction === 'next' ? nextChange(lines, currentLine) : prevChange(lines, currentLine);
  return { line, index: lines.indexOf(line) + 1, total: lines.length };
}

/** The line range a hunk op needs for this marker. A deletion has no new-side lines, so its new
 *  span is empty at the anchor — see src/hunk-patch.ts for the empty-span encoding. */
export function markerRange(m: ChangeMarker): HunkRange {
  return {
    new: m.addedLines > 0 ? [m.startLine, m.endLine] : [m.startLine, m.startLine - 1],
    old: m.oldRange,
  };
}

/** Which marker a gutter click on `line` landed on, or -1. First match wins: a deletion can be
 *  anchored on an addition's first line, and the peek shows one change at a time regardless. */
export function markerIndexAtLine(markers: ChangeMarker[], line: number): number {
  return markers.findIndex((m) => line >= m.startLine && line <= m.endLine);
}

/** View zones attach AFTER a line, and the removed lines belong above the change. */
export function peekAfterLine(m: ChangeMarker): number {
  return Math.max(0, m.startLine - 1);
}

/** Header + removed lines, floored so an empty peek is still legible and capped so a 400-line
 *  deletion cannot swallow the editor; the list scrolls inside the zone past that. */
export function peekHeightInLines(removedCount: number): number {
  return Math.min(Math.max(removedCount, 1) + 2, 14);
}

export type PeekEvent =
  | { type: 'open'; index: number }
  | { type: 'close' }
  | { type: 'next' }
  | { type: 'prev' }
  /** A recompute changed the marker list under an open peek. */
  | { type: 'sync' };

export function reducePeek(index: number | null, event: PeekEvent, total: number): number | null {
  // Closing, and having nothing left to show, are the same answer.
  if (event.type === 'close' || total === 0) return null;
  switch (event.type) {
    case 'open':
      return Math.min(Math.max(event.index, 0), total - 1);
    case 'next':
      return index === null ? null : (index + 1) % total;
    case 'prev':
      return index === null ? null : (index - 1 + total) % total;
    case 'sync':
      return index === null ? null : Math.min(index, total - 1);
  }
}

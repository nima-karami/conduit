import type { editor } from 'monaco-editor';
import type { ReviewHunk, ReviewLine } from '../src/review-hunks';
import { nextChange, prevChange } from './diff-nav';

/**
 * The editor's own LCS ceiling (~500x500 changed region). Review diffs a file once per load
 * and can afford MAX_LCS_CELLS; this runs on a 300 ms keystroke debounce and must fit inside a
 * frame. See spec 2026-08-27-review-supercharge §2 Lane A.
 */
export const MAX_DECORATION_LCS_CELLS = 250_000;

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

      if (adds.length > 0) {
        const first = adds[0].newLine ?? 1;
        const last = adds[adds.length - 1].newLine ?? first;
        markers.push({
          kind: dels > 0 ? 'modified' : 'added',
          startLine: clamp(first, modelLineCount),
          endLine: clamp(last, modelLineCount),
          addedLines: adds.length,
          removedLines: dels,
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

export function hunksToDecorations(
  markers: ChangeMarker[],
  style: ChangeDecorationStyle,
): editor.IModelDeltaDecoration[] {
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
      overviewRuler: { color: style.colors[m.kind], position: style.rulerLane },
      minimap: { color: style.colors[m.kind], position: style.minimapPosition },
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

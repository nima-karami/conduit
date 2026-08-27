import { describe, expect, it } from 'vitest';
import { computeFileReview } from '../../src/review-hunks';
import {
  type ChangeMarker,
  hunksToDecorations,
  hunksToMarkers,
  MAX_DECORATION_LCS_CELLS,
  markerLines,
  markerTooltip,
  navigateMarkers,
} from '../../webview/change-decorations';

const STYLE = {
  colors: { added: '#0f0', modified: '#fa0', deleted: '#f00' },
  rulerLane: 1,
  minimapPosition: 2,
};

const lines = (n: number, prefix = 'l') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n');

describe('hunksToMarkers', () => {
  it('marks a pure insertion as added over the inserted lines', () => {
    const head = lines(10);
    const work = `${lines(5)}\nnew1\nnew2\nl6\nl7\nl8\nl9\nl10`;
    const markers = hunksToMarkers(computeFileReview(head, work).hunks, 12);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      kind: 'added',
      startLine: 6,
      endLine: 7,
      addedLines: 2,
      removedLines: 0,
    });
  });

  it('marks a replacement as modified', () => {
    const head = lines(10);
    const work = lines(10).replace('l5', 'CHANGED');
    const markers = hunksToMarkers(computeFileReview(head, work).hunks, 10);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      kind: 'modified',
      startLine: 5,
      endLine: 5,
      addedLines: 1,
      removedLines: 1,
    });
  });

  it('anchors a deletion on the line that follows it', () => {
    const head = lines(10);
    const work = ['l1', 'l2', 'l3', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n');
    const markers = hunksToMarkers(computeFileReview(head, work).hunks, 8);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      kind: 'deleted',
      startLine: 4,
      endLine: 4,
      addedLines: 0,
      removedLines: 2,
    });
  });

  it('anchors a deletion at EOF on the last model line', () => {
    const markers = hunksToMarkers(computeFileReview(lines(10), lines(8)).hunks, 8);
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('deleted');
    expect(markers[0].startLine).toBe(8);
  });

  it('splits two change runs inside one hunk into two markers', () => {
    // A 4-line unchanged gap is <= 2*context, so computeFileReview keeps both runs in ONE hunk.
    const head = lines(12);
    const work = lines(12).replace('l4', 'A').replace('l9', 'B');
    const markers = hunksToMarkers(computeFileReview(head, work).hunks, 12);
    expect(markers.map((m) => m.startLine)).toEqual([4, 9]);
    expect(markers.every((m) => m.kind === 'modified')).toBe(true);
  });

  it('clamps a marker to the model line count', () => {
    const markers = hunksToMarkers(computeFileReview(lines(10), `${lines(10)}\nextra`).hunks, 3);
    expect(markers[0].startLine).toBeGreaterThanOrEqual(1);
    expect(markers[0].endLine).toBeLessThanOrEqual(3);
  });

  it('returns nothing for an unchanged file', () => {
    expect(hunksToMarkers(computeFileReview(lines(5), lines(5)).hunks, 5)).toEqual([]);
  });
});

describe('markerTooltip', () => {
  const m = (over: Partial<ChangeMarker>): ChangeMarker => ({
    kind: 'added',
    startLine: 1,
    endLine: 1,
    addedLines: 1,
    removedLines: 0,
    ...over,
  });

  it('names the kind and the line count, singular and plural', () => {
    expect(markerTooltip(m({ kind: 'added', addedLines: 3 }))).toBe('Added 3 lines');
    expect(markerTooltip(m({ kind: 'added', addedLines: 1 }))).toBe('Added 1 line');
    expect(markerTooltip(m({ kind: 'modified', addedLines: 2, removedLines: 2 }))).toBe(
      'Modified 2 lines',
    );
    expect(markerTooltip(m({ kind: 'deleted', addedLines: 0, removedLines: 2 }))).toBe(
      'Deleted 2 lines',
    );
  });
});

describe('hunksToDecorations', () => {
  const markers: ChangeMarker[] = [
    { kind: 'added', startLine: 3, endLine: 4, addedLines: 2, removedLines: 0 },
    { kind: 'deleted', startLine: 9, endLine: 9, addedLines: 0, removedLines: 1 },
  ];

  it('emits one range decoration per marker with a kind class', () => {
    const decos = hunksToDecorations(markers, STYLE);
    expect(decos).toHaveLength(2);
    expect(decos[0].range).toEqual({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
    });
    expect(decos[0].options.linesDecorationsClassName).toBe('cdec cdec--added');
    expect(decos[1].options.linesDecorationsClassName).toBe('cdec cdec--deleted');
  });

  it('carries the injected ruler and minimap colours', () => {
    const decos = hunksToDecorations(markers, STYLE);
    expect(decos[0].options.overviewRuler).toEqual({ color: '#0f0', position: 1 });
    expect(decos[0].options.minimap).toEqual({ color: '#0f0', position: 2 });
    expect(decos[1].options.overviewRuler).toEqual({ color: '#f00', position: 1 });
  });

  it('carries the tooltip as a hover message', () => {
    expect(hunksToDecorations(markers, STYLE)[0].options.hoverMessage).toEqual({
      value: 'Added 2 lines',
    });
  });
});

describe('markerLines / navigateMarkers', () => {
  const markers: ChangeMarker[] = [
    { kind: 'added', startLine: 10, endLine: 12, addedLines: 3, removedLines: 0 },
    { kind: 'deleted', startLine: 10, endLine: 10, addedLines: 0, removedLines: 1 },
    { kind: 'modified', startLine: 30, endLine: 30, addedLines: 1, removedLines: 1 },
  ];

  it('dedupes and sorts anchor lines', () => {
    expect(markerLines(markers)).toEqual([10, 30]);
  });

  it('advances and wraps forward', () => {
    expect(navigateMarkers(markers, 1, 'next')).toEqual({ line: 10, index: 1, total: 2 });
    expect(navigateMarkers(markers, 10, 'next')).toEqual({ line: 30, index: 2, total: 2 });
    expect(navigateMarkers(markers, 30, 'next')).toEqual({ line: 10, index: 1, total: 2 });
  });

  it('retreats and wraps backward', () => {
    expect(navigateMarkers(markers, 30, 'prev')).toEqual({ line: 10, index: 1, total: 2 });
    expect(navigateMarkers(markers, 10, 'prev')).toEqual({ line: 30, index: 2, total: 2 });
  });

  it('a single change wraps to itself', () => {
    const one = markers.slice(2);
    expect(navigateMarkers(one, 30, 'next')).toEqual({ line: 30, index: 1, total: 1 });
  });

  it('returns null when there is nothing to navigate', () => {
    expect(navigateMarkers([], 5, 'next')).toBeNull();
  });
});

describe('decoration budget', () => {
  it('is far below the Review budget, because the editor re-diffs on every keystroke burst', () => {
    expect(MAX_DECORATION_LCS_CELLS).toBe(250_000);
  });

  it('degrades a wholesale rewrite that the Review budget would still diff exactly', () => {
    const head = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n');
    const work = Array.from({ length: 600 }, (_, i) => `b${i}`).join('\n');
    expect(computeFileReview(head, work).approx).toBeUndefined();
    expect(computeFileReview(head, work, 3, MAX_DECORATION_LCS_CELLS).approx).toBe(true);
  });

  // Acceptance criterion, spec §7 Lane A: this runs on a 300 ms keystroke debounce, so it has
  // to fit inside a frame. Median of five, so one scheduling hiccup on CI can't fail the build.
  it('recomputes a 2 000-line file with a 50-line change in under 16 ms', () => {
    const head = Array.from({ length: 2000 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const workLines = head.split('\n');
    for (let i = 900; i < 950; i++) workLines[i] = `const changed${i} = ${i * 2};`;
    const work = workLines.join('\n');

    const run = () =>
      hunksToMarkers(computeFileReview(head, work, 3, MAX_DECORATION_LCS_CELLS).hunks, 2000);

    expect(run().length).toBeGreaterThan(0);

    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      run();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    expect(samples[2]).toBeLessThan(16);
  });
});

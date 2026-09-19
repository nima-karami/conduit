// @vitest-environment jsdom
/**
 * `monaco-editor`'s barrel pulls in workers and CSS jsdom cannot load, so it is substituted
 * for the DOM-free pieces these two functions touch: the real `Uri` (mocking it would test the
 * mock's idea of escaping rather than Monaco's — same reasoning as `path-identity.test.ts`)
 * and the real `MarkerSeverity` values.
 */

import { URI } from 'monaco-editor/esm/vs/base/common/uri.js';
import { describe, expect, it, vi } from 'vitest';
import { blockModelUri, toMarkers, type WorkerDiagnostic } from '../../webview/plan-diagnostics';
import { pathForUri } from '../../webview/project-index';

vi.mock('monaco-editor', async () => ({
  Uri: (await import('monaco-editor/esm/vs/base/common/uri.js')).URI,
  MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
}));

/** Enough model for `toMarkers`: offset → 1-based position, computed independently of Monaco. */
function fakeModel(text: string) {
  return {
    getPositionAt(offset: number) {
      const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
      const lines = before.split('\n');
      return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
    },
  } as unknown as Parameters<typeof toMarkers>[0];
}

describe('toMarkers', () => {
  it('maps start/length to 1-based line/column and severity', () => {
    const text = 'const a = 1;\nconst b: string = a;\n';
    const diags: WorkerDiagnostic[] = [
      {
        start: 13,
        length: 8,
        messageText: "Type 'number' is not assignable",
        category: 1,
        code: 2322,
      },
      {
        start: 6,
        length: 1,
        messageText: { messageText: "'a' is declared but never read." },
        category: 0,
        code: 6133,
      },
      { messageText: 'Prefer const', category: 2, code: 80001 },
    ];

    const markers = toMarkers(fakeModel(text), diags);

    expect(markers).toEqual([
      {
        severity: 8,
        message: "Type 'number' is not assignable",
        code: '2322',
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 9,
      },
      {
        severity: 4,
        message: "'a' is declared but never read.",
        code: '6133',
        startLineNumber: 1,
        startColumn: 7,
        endLineNumber: 1,
        endColumn: 8,
      },
      {
        severity: 2,
        message: 'Prefer const',
        code: '80001',
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 1,
      },
    ]);
  });
});

describe('blockModelUri', () => {
  it('lands under the project root with the lang extension', () => {
    const posix = blockModelUri('/home/n/repo', 'identity', 'r0', 'ts');
    expect(posix.path).toBe('/home/n/repo/.conduit/plans/.blocks/identity.r0.ts');
    expect(posix.scheme).toBe('file');

    const win = blockModelUri('G:\\repo', 'identity', 'r0', 'tsx');
    expect(win.toString()).toContain('/repo/.conduit/plans/.blocks/identity.r0.tsx');
    // Goes through `fileUri`, so it is the one spelling the rest of the renderer keys by.
    expect(pathForUri(win)).toBe('G:\\repo\\.conduit\\plans\\.blocks\\identity.r0.tsx');
    expect(URI.parse(win.toString()).toString()).toBe(win.toString());
  });
});

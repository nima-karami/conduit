import { describe, expect, it } from 'vitest';
import { planFileOpen } from '../../webview/file-open-request';

const base = { type: 'openFileInEditor', path: '/p/a.ts', sessionId: 's1' } as const;

describe('planFileOpen', () => {
  it('an OS open shows the editor as a permanent tab without activating the session', () => {
    expect(planFileOpen({ ...base, source: 'os' })).toEqual({
      activate: false,
      showEditor: true,
      mode: 'permanent',
    });
  });

  it('an MCP open with focus activates the session and opens a preview tab at the position', () => {
    expect(planFileOpen({ ...base, source: 'mcp', focus: true, line: 12, column: 4 })).toEqual({
      activate: true,
      showEditor: true,
      mode: 'preview',
      reveal: { line: 12, column: 4 },
    });
  });

  it('an MCP open without focus opens in the background and leaves the center view alone', () => {
    expect(planFileOpen({ ...base, source: 'mcp', focus: false, line: 3, column: 2 })).toEqual({
      activate: false,
      showEditor: false,
      mode: 'background',
      reveal: { line: 3, column: 2 },
    });
  });

  it('line without column → column 1', () => {
    expect(planFileOpen({ ...base, source: 'mcp', focus: true, line: 7 }).reveal).toEqual({
      line: 7,
      column: 1,
    });
  });

  it('no line → no reveal', () => {
    const p = planFileOpen({ ...base, source: 'mcp', focus: true, column: 9 });
    expect(p.reveal).toBeUndefined();
    expect('reveal' in p).toBe(false);
  });
});

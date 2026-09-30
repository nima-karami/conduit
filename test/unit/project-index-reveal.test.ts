import { describe, expect, it, vi } from 'vitest';

vi.mock('monaco-editor', async () => {
  const { URI } = await import('monaco-editor/esm/vs/base/common/uri.js');
  return { Uri: URI, editor: { getModel: () => null } };
});

import {
  clearReveal,
  hasReveal,
  openDefinitionFile,
  peekReveal,
  setDefinitionOpener,
  setReveal,
  takeReveal,
} from '../../webview/project-index';

describe('group-tagged reveal (split-editor spec §3.2)', () => {
  it('a reveal staged for group 2 is not consumed by group 1', () => {
    setReveal('/w/r.ts', { line: 7, column: 2 }, 2);
    expect(hasReveal('/w/r.ts', 1)).toBe(false);
    expect(takeReveal('/w/r.ts', 1)).toBeUndefined();
    expect(hasReveal('/w/r.ts', 2)).toBe(true);
    expect(hasReveal('/w/r.ts')).toBe(true);
    expect(peekReveal('/w/r.ts')).toEqual({ line: 7, column: 2 });
    expect(takeReveal('/w/r.ts', 2)).toEqual({ line: 7, column: 2 });
    expect(hasReveal('/w/r.ts')).toBe(false);
  });

  it('an ungrouped reveal is consumed by the first taker', () => {
    setReveal('/w/u.ts', { line: 3, column: 1 });
    expect(hasReveal('/w/u.ts', 2)).toBe(true);
    expect(takeReveal('/w/u.ts', 2)).toEqual({ line: 3, column: 1 });
    expect(takeReveal('/w/u.ts', 1)).toBeUndefined();
  });

  it('peekReveal honours the group it is asked for', () => {
    setReveal('/w/p.ts', { line: 4, column: 1 }, 2);
    expect(peekReveal('/w/p.ts', 1)).toBeUndefined();
    expect(peekReveal('/w/p.ts', 2)).toEqual({ line: 4, column: 1 });
    expect(peekReveal('/w/p.ts')).toEqual({ line: 4, column: 1 });
    clearReveal('/w/p.ts');
  });

  it("clearing a group's reveal leaves another group's and an ungrouped one", () => {
    setReveal('/w/c.ts', { line: 5, column: 1 }, 2);
    clearReveal('/w/c.ts', 1);
    expect(hasReveal('/w/c.ts', 2)).toBe(true);
    clearReveal('/w/c.ts', 2);
    expect(hasReveal('/w/c.ts')).toBe(false);
    setReveal('/w/c.ts', { line: 6, column: 1 });
    clearReveal('/w/c.ts', 2);
    expect(hasReveal('/w/c.ts', 1)).toBe(true);
    clearReveal('/w/c.ts');
  });

  it('openDefinitionFile forwards the group', () => {
    const opened = vi.fn();
    setDefinitionOpener(opened);
    openDefinitionFile('/w/d.ts', { line: 1, column: 1 }, 2);
    openDefinitionFile('/w/e.ts', { line: 2, column: 1 });
    expect(opened.mock.calls).toEqual([
      ['/w/d.ts', { line: 1, column: 1 }, 2],
      ['/w/e.ts', { line: 2, column: 1 }, undefined],
    ]);
  });
});

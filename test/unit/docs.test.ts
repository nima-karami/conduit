import { describe, expect, it } from 'vitest';
import { type DocsState, docsReducer, initialDocs, type OpenMode } from '../../webview/docs';

const open = (s: DocsState, kind: 'file' | 'diff', path: string, sessionId = 'S1') =>
  docsReducer(s, { type: 'open', kind, path, sessionId });

const openMode = (
  s: DocsState,
  kind: 'file' | 'diff',
  path: string,
  mode: OpenMode,
  sessionId = 'S1',
) => docsReducer(s, { type: 'open', kind, path, sessionId, mode });

const previewCount = (s: DocsState, sessionId = 'S1') =>
  s.docs.filter(
    (d) => d.sessionId === sessionId && d.preview && (d.kind === 'file' || d.kind === 'diff'),
  ).length;

describe('docsReducer', () => {
  it('opens a document and makes it active', () => {
    const s = open(initialDocs, 'file', '/a.ts');
    expect(s.docs.map((d) => d.path)).toEqual(['/a.ts']);
    expect(s.activeId).toBe('file:/a.ts');
    expect(s.docs[0].title).toBe('a.ts');
    expect(s.docs[0].sessionId).toBe('S1');
  });

  it('closeSession closes only docs owned by that session, keeping others', () => {
    let s = open(initialDocs, 'file', '/a.ts', 'A');
    s = open(s, 'file', '/b.ts', 'B');
    s = open(s, 'file', '/c.ts', 'A');
    s = docsReducer(s, { type: 'closeSession', sessionId: 'A' });
    expect(s.docs.map((d) => d.path)).toEqual(['/b.ts']);
  });

  it('closeSession re-points the active id when the active doc was closed', () => {
    let s = open(initialDocs, 'file', '/a.ts', 'A'); // becomes active
    s = open(s, 'file', '/b.ts', 'B'); // now active
    s = docsReducer(s, { type: 'closeSession', sessionId: 'B' });
    expect(s.activeId).toBe('file:/a.ts'); // fell back to the remaining doc
    s = docsReducer(s, { type: 'closeSession', sessionId: 'A' });
    expect(s.docs).toHaveLength(0);
    expect(s.activeId).toBeNull(); // terminal
  });

  it('re-opening under a different session transfers ownership', () => {
    let s = open(initialDocs, 'file', '/a.ts', 'A');
    s = open(s, 'file', '/a.ts', 'B'); // same path, session B now owns it
    expect(s.docs).toHaveLength(1);
    s = docsReducer(s, { type: 'closeSession', sessionId: 'A' });
    expect(s.docs).toHaveLength(1); // A no longer owns it
    s = docsReducer(s, { type: 'closeSession', sessionId: 'B' });
    expect(s.docs).toHaveLength(0);
  });

  it('dedupes by kind+path, re-activating the existing tab', () => {
    let s = open(initialDocs, 'file', '/a.ts');
    s = open(s, 'file', '/b.ts');
    s = open(s, 'file', '/a.ts');
    expect(s.docs).toHaveLength(2);
    expect(s.activeId).toBe('file:/a.ts');
  });

  it('treats file and diff of the same path as distinct tabs', () => {
    let s = open(initialDocs, 'file', '/a.ts');
    s = open(s, 'diff', '/a.ts');
    expect(s.docs).toHaveLength(2);
    expect(s.activeId).toBe('diff:/a.ts');
  });

  it('closing the active doc activates the previous, or terminal when none', () => {
    let s = open(initialDocs, 'file', '/a.ts');
    s = open(s, 'file', '/b.ts');
    s = docsReducer(s, { type: 'close', id: 'file:/b.ts' });
    expect(s.activeId).toBe('file:/a.ts');
    s = docsReducer(s, { type: 'close', id: 'file:/a.ts' });
    expect(s.docs).toHaveLength(0);
    expect(s.activeId).toBeNull(); // terminal
  });

  it('activate(null) selects the terminal', () => {
    let s = open(initialDocs, 'file', '/a.ts');
    s = docsReducer(s, { type: 'activate', id: null });
    expect(s.activeId).toBeNull();
  });
});

describe('docsReducer — per-session editor scoping', () => {
  it('switchSession restores the session that session last had active', () => {
    // A opens a.ts; B opens b.ts (B now active). Switch back to A -> A's a.ts; to B -> b.ts.
    let s = open(initialDocs, 'file', '/a.ts', 'A');
    s = open(s, 'file', '/b.ts', 'B');
    expect(s.activeId).toBe('file:/b.ts');
    s = docsReducer(s, { type: 'switchSession', sessionId: 'A' });
    expect(s.activeId).toBe('file:/a.ts');
    s = docsReducer(s, { type: 'switchSession', sessionId: 'B' });
    expect(s.activeId).toBe('file:/b.ts');
  });

  it('switching to a session with no editors shows the Terminal (null)', () => {
    let s = open(initialDocs, 'file', '/a.ts', 'A');
    s = docsReducer(s, { type: 'switchSession', sessionId: 'B' });
    expect(s.activeId).toBeNull();
  });

  it('remembers the Terminal choice per session', () => {
    let s = open(initialDocs, 'file', '/a.ts', 'A'); // A active doc = a.ts
    s = docsReducer(s, { type: 'activate', id: null, sessionId: 'A' }); // A chose Terminal
    s = open(s, 'file', '/b.ts', 'B');
    s = docsReducer(s, { type: 'switchSession', sessionId: 'A' });
    expect(s.activeId).toBeNull(); // A is back on its Terminal, not a.ts
  });

  it('falls back to the Terminal when the remembered doc transferred to another session', () => {
    let s = open(initialDocs, 'file', '/a.ts', 'A'); // A owns + remembers a.ts
    s = open(s, 'file', '/a.ts', 'B'); // re-open transfers a.ts to B
    s = docsReducer(s, { type: 'switchSession', sessionId: 'A' });
    expect(s.activeId).toBeNull(); // A no longer owns a.ts -> Terminal
    s = docsReducer(s, { type: 'switchSession', sessionId: 'B' });
    expect(s.activeId).toBe('file:/a.ts');
  });

  it('closing a session-active doc repoints to a sibling in the SAME session', () => {
    let s = open(initialDocs, 'file', '/a.ts', 'A');
    s = open(s, 'file', '/b.ts', 'A'); // A: a.ts, b.ts (b active)
    s = open(s, 'file', '/c.ts', 'B'); // B owns c.ts (now globally active)
    s = docsReducer(s, { type: 'close', id: 'file:/b.ts' });
    // A's remembered active should fall back to a.ts, not B's c.ts.
    s = docsReducer(s, { type: 'switchSession', sessionId: 'A' });
    expect(s.activeId).toBe('file:/a.ts');
  });
});

describe('docsReducer — file preview + pin (VS Code preview tabs)', () => {
  it('open with mode:preview creates exactly one italic preview tab', () => {
    const s = openMode(initialDocs, 'file', '/a.ts', 'preview');
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe('file:/a.ts');
    expect(s.docs[0].preview).toBe(true);
    expect(s.activeId).toBe('file:/a.ts');
    expect(previewCount(s)).toBe(1);
  });

  it('opening another preview replaces the existing one IN PLACE (same index, no growth)', () => {
    let s = openMode(initialDocs, 'file', '/a.ts', 'preview');
    s = openMode(s, 'file', '/b.ts', 'preview');
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe('file:/b.ts');
    expect(s.docs[0].preview).toBe(true);
    expect(s.activeId).toBe('file:/b.ts');
    expect(previewCount(s)).toBe(1);
  });

  it('replace-in-place preserves the preview slot position', () => {
    // Pin a.ts first so it occupies index 0, then a preview at index 1 that retargets.
    let s = openMode(initialDocs, 'file', '/a.ts', 'permanent');
    s = openMode(s, 'file', '/b.ts', 'preview');
    expect(s.docs.map((d) => d.id)).toEqual(['file:/a.ts', 'file:/b.ts']);
    s = openMode(s, 'file', '/c.ts', 'preview');
    expect(s.docs.map((d) => d.id)).toEqual(['file:/a.ts', 'file:/c.ts']);
    expect(s.docs[1].preview).toBe(true);
    expect(previewCount(s)).toBe(1);
  });

  it('opening a file already PERMANENT just activates it — never downgrades to preview', () => {
    let s = openMode(initialDocs, 'file', '/a.ts', 'permanent');
    s = openMode(s, 'file', '/x.ts', 'preview'); // move active to a preview
    expect(s.activeId).toBe('file:/x.ts');
    s = openMode(s, 'file', '/a.ts', 'preview'); // single-click the permanent file
    expect(s.docs.find((d) => d.id === 'file:/a.ts')?.preview).toBeFalsy();
    expect(s.activeId).toBe('file:/a.ts');
    // The other preview is untouched.
    expect(s.docs.find((d) => d.id === 'file:/x.ts')?.preview).toBe(true);
    expect(previewCount(s)).toBe(1);
  });

  it('opening the SAME file already shown as the preview just re-activates it', () => {
    let s = openMode(initialDocs, 'file', '/a.ts', 'preview');
    s = docsReducer(s, { type: 'activate', id: null, sessionId: 'S1' });
    s = openMode(s, 'file', '/a.ts', 'preview');
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].preview).toBe(true);
    expect(s.activeId).toBe('file:/a.ts');
  });

  it('mode:permanent on the current preview promotes it in place (explorer double-click)', () => {
    let s = openMode(initialDocs, 'file', '/a.ts', 'preview'); // first click of the dblclick
    s = openMode(s, 'file', '/a.ts', 'permanent'); // the dblclick promotes
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe('file:/a.ts');
    expect(s.docs[0].preview).toBeFalsy();
    expect(previewCount(s)).toBe(0);
  });

  it('pinDoc clears preview on a file doc, id unchanged (Keep Open / double-click tab)', () => {
    let s = openMode(initialDocs, 'file', '/a.ts', 'preview');
    s = docsReducer(s, { type: 'pinDoc', id: 'file:/a.ts' });
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe('file:/a.ts');
    expect(s.docs[0].preview).toBeFalsy();
    expect(s.activeId).toBe('file:/a.ts');
  });

  it('a permanent preview leaves room for a NEW preview on the next single-click', () => {
    let s = openMode(initialDocs, 'file', '/b.ts', 'preview');
    s = docsReducer(s, { type: 'pinDoc', id: 'file:/b.ts' }); // promote b
    s = openMode(s, 'file', '/c.ts', 'preview'); // new preview opens beside it
    expect(s.docs.map((d) => d.id)).toEqual(['file:/b.ts', 'file:/c.ts']);
    expect(s.docs[0].preview).toBeFalsy();
    expect(s.docs[1].preview).toBe(true);
    expect(previewCount(s)).toBe(1);
  });

  it('maintains the ≤1 preview-per-session invariant across many opens', () => {
    let s: DocsState = initialDocs;
    for (const p of ['/a.ts', '/b.ts', '/c.ts', '/d.ts']) {
      s = openMode(s, 'file', p, 'preview');
      expect(previewCount(s)).toBeLessThanOrEqual(1);
    }
    expect(s.docs).toHaveLength(1);
  });

  it('preview is per-session: each session keeps its own preview slot', () => {
    let s = openMode(initialDocs, 'file', '/a.ts', 'preview', 'A');
    s = openMode(s, 'file', '/b.ts', 'preview', 'B');
    expect(s.docs).toHaveLength(2);
    expect(previewCount(s, 'A')).toBe(1);
    expect(previewCount(s, 'B')).toBe(1);
  });

  it('reorder promotes a dragged preview to permanent (drag-to-promote)', () => {
    let s = openMode(initialDocs, 'file', '/a.ts', 'permanent');
    s = openMode(s, 'file', '/b.ts', 'preview');
    s = docsReducer(s, { type: 'reorder', dragId: 'file:/b.ts', targetId: 'file:/a.ts' });
    expect(s.docs.find((d) => d.id === 'file:/b.ts')?.preview).toBeFalsy();
    expect(previewCount(s)).toBe(0);
  });

  it('mode defaults to permanent (back-compat: callers that omit mode get a permanent tab)', () => {
    const s = open(initialDocs, 'file', '/a.ts');
    expect(s.docs[0].preview).toBeFalsy();
  });

  it('web/review docs are never previewable even with mode:preview', () => {
    const s = docsReducer(initialDocs, {
      type: 'open',
      kind: 'web',
      path: 'https://x',
      sessionId: 'S1',
      mode: 'preview',
    });
    expect(s.docs[0].preview).toBeFalsy();
  });
});

describe('docsReducer — commit-diff preview + pin', () => {
  const SHA = 'a'.repeat(40);
  const openFile = (s: DocsState, sha: string, file: string, pin: boolean, sessionId = 'S1') =>
    docsReducer(s, { type: 'openCommitFile', sha, file, sessionId, pin });

  it('single-click opens ONE preview commit-diff tab and retargets in place', () => {
    let s = openFile(initialDocs, SHA, 'src/a.ts', false);
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe('commit-diff:@preview');
    expect(s.docs[0].preview).toBe(true);
    expect(s.docs[0].path).toBe(`${SHA} src/a.ts`);
    expect(s.activeId).toBe('commit-diff:@preview');
    // Opening another file reuses the same tab (no second tab), retargeted.
    s = openFile(s, SHA, 'src/b.ts', false);
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].path).toBe(`${SHA} src/b.ts`);
    expect(s.docs[0].title).toBe(`b.ts @ ${SHA.slice(0, 7)}`);
  });

  it('double-click pins a per-identity commit-diff tab that single-clicks do not replace', () => {
    let s = openFile(initialDocs, SHA, 'src/a.ts', true); // pinned
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe(`commit-diff:${SHA} src/a.ts`);
    expect(s.docs[0].preview).toBeFalsy();
    // A later single-click on a different file opens a separate preview tab.
    s = openFile(s, SHA, 'src/b.ts', false);
    expect(s.docs.map((d) => d.id)).toEqual([
      `commit-diff:${SHA} src/a.ts`,
      'commit-diff:@preview',
    ]);
  });

  it('pinning the file currently in preview promotes that same tab in place', () => {
    let s = openFile(initialDocs, SHA, 'src/a.ts', false); // preview
    s = openFile(s, SHA, 'src/a.ts', true); // pin same file
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe(`commit-diff:${SHA} src/a.ts`);
    expect(s.docs[0].preview).toBeFalsy();
  });

  it('opening an already-pinned commit-diff just activates it', () => {
    let s = openFile(initialDocs, SHA, 'src/a.ts', true);
    s = open(s, 'file', '/x.ts'); // move active away
    expect(s.activeId).toBe('file:/x.ts');
    s = openFile(s, SHA, 'src/a.ts', false); // single-click the pinned file
    expect(s.docs.filter((d) => d.kind === 'commit-diff')).toHaveLength(1);
    expect(s.activeId).toBe(`commit-diff:${SHA} src/a.ts`);
  });

  it('pinDoc promotes a preview tab and carries activeId across the re-key', () => {
    let s = openFile(initialDocs, SHA, 'src/a.ts', false);
    expect(s.activeId).toBe('commit-diff:@preview');
    s = docsReducer(s, { type: 'pinDoc', id: 'commit-diff:@preview' });
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe(`commit-diff:${SHA} src/a.ts`);
    expect(s.docs[0].preview).toBeFalsy();
    expect(s.activeId).toBe(`commit-diff:${SHA} src/a.ts`);
  });

  it('closeSession closes commit-diff tabs owned by that session', () => {
    let s = openFile(initialDocs, SHA, 'src/a.ts', false, 'A');
    s = open(s, 'file', '/keep.ts', 'B');
    s = docsReducer(s, { type: 'closeSession', sessionId: 'A' });
    expect(s.docs.map((d) => d.id)).toEqual(['file:/keep.ts']);
  });
});

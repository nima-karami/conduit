import { describe, expect, it } from 'vitest';
import { type DocsState, docsReducer, initialDocs } from '../../webview/docs';

const open = (s: DocsState, kind: 'file' | 'diff', path: string, sessionId = 'S1') =>
  docsReducer(s, { type: 'open', kind, path, sessionId });

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

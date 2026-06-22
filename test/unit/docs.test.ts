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

describe('docsReducer — commit / commit-diff preview + pin', () => {
  const SHA = 'a'.repeat(40);
  const SHA2 = 'b'.repeat(40);
  const openCommit = (s: DocsState, sha: string, pin: boolean, sessionId = 'S1') =>
    docsReducer(s, { type: 'openCommit', sha, sessionId, pin });
  const openFile = (s: DocsState, sha: string, file: string, pin: boolean, sessionId = 'S1') =>
    docsReducer(s, { type: 'openCommitFile', sha, file, sessionId, pin });

  it('single-click opens ONE preview commit tab and retargets in place', () => {
    let s = openCommit(initialDocs, SHA, false);
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe('commit:@preview');
    expect(s.docs[0].preview).toBe(true);
    expect(s.docs[0].path).toBe(SHA);
    expect(s.activeId).toBe('commit:@preview');
    // Selecting another commit reuses the same tab (no second tab), retargeted.
    s = openCommit(s, SHA2, false);
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].path).toBe(SHA2);
    expect(s.docs[0].title).toBe(SHA2.slice(0, 7));
  });

  it('double-click pins a per-identity commit tab that single-clicks do not replace', () => {
    let s = openCommit(initialDocs, SHA, true);
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe(`commit:${SHA}`);
    expect(s.docs[0].preview).toBeFalsy();
    // A later single-click on a different commit opens a separate preview tab.
    s = openCommit(s, SHA2, false);
    expect(s.docs.map((d) => d.id)).toEqual([`commit:${SHA}`, 'commit:@preview']);
  });

  it('pinning the commit currently in preview promotes that same tab in place', () => {
    let s = openCommit(initialDocs, SHA, false); // preview
    s = openCommit(s, SHA, true); // pin same sha
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe(`commit:${SHA}`);
    expect(s.docs[0].preview).toBeFalsy();
  });

  it('opening an already-pinned commit just activates it', () => {
    let s = openCommit(initialDocs, SHA, true);
    s = open(s, 'file', '/x.ts'); // move active away
    expect(s.activeId).toBe('file:/x.ts');
    s = openCommit(s, SHA, false); // single-click the pinned commit
    expect(s.docs.filter((d) => d.kind === 'commit')).toHaveLength(1);
    expect(s.activeId).toBe(`commit:${SHA}`);
  });

  it('commit and commit-diff have independent preview slots', () => {
    let s = openCommit(initialDocs, SHA, false);
    s = openFile(s, SHA, 'src/app.ts', false);
    expect(s.docs.map((d) => d.id)).toEqual(['commit:@preview', 'commit-diff:@preview']);
    expect(s.docs[1].path).toBe(`${SHA} src/app.ts`);
    expect(s.docs[1].title).toBe(`app.ts @ ${SHA.slice(0, 7)}`);
  });

  it('double-click a file pins it; preview slot stays free for the next single-click', () => {
    let s = openFile(initialDocs, SHA, 'src/a.ts', true); // pinned
    s = openFile(s, SHA, 'src/b.ts', false); // preview
    expect(s.docs.map((d) => d.id)).toEqual([
      `commit-diff:${SHA} src/a.ts`,
      'commit-diff:@preview',
    ]);
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

  it('closeSession closes commit / commit-diff tabs owned by that session', () => {
    let s = openCommit(initialDocs, SHA, true, 'A');
    s = openFile(s, SHA, 'src/a.ts', false, 'A');
    s = open(s, 'file', '/keep.ts', 'B');
    s = docsReducer(s, { type: 'closeSession', sessionId: 'A' });
    expect(s.docs.map((d) => d.id)).toEqual(['file:/keep.ts']);
  });
});

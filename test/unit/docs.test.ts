import { describe, expect, it } from 'vitest';
import type { PersistedDoc } from '../../src/protocol';
import {
  backgroundOpenOutcome,
  type DocsState,
  docsReducer,
  initialDocs,
  type OpenMode,
  REVIEW_DOC_ID,
  toPersistedDocs,
} from '../../webview/docs';

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
    docsReducer(s, {
      type: 'openCommitFile',
      sha,
      file,
      sessionId,
      mode: pin ? 'permanent' : 'preview',
    });

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

describe('toPersistedDocs — docState → persisted slice', () => {
  const SHA = 'a'.repeat(40);

  it('persists every restorable kind (file/diff/pinned commit-diff/review/git-history/web)', () => {
    let s = open(initialDocs, 'file', '/a.ts', 'S1');
    s = open(s, 'diff', '/a.ts', 'S1');
    s = docsReducer(s, {
      type: 'open',
      kind: 'web',
      path: 'https://example.com/foo',
      sessionId: 'S1',
    });
    s = docsReducer(s, { type: 'openReview', sessionId: 'S1', source: { kind: 'working' } });
    s = docsReducer(s, {
      type: 'open',
      kind: 'git-history',
      path: '@git-history',
      sessionId: 'S1',
    });
    s = docsReducer(s, {
      type: 'openCommitFile',
      sha: SHA,
      file: 'src/a.ts',
      sessionId: 'S1',
      mode: 'permanent',
    });
    const persisted = toPersistedDocs(s);
    expect(persisted.map((d) => ({ kind: d.kind, path: d.path }))).toEqual([
      { kind: 'file', path: '/a.ts' },
      { kind: 'diff', path: '/a.ts' },
      { kind: 'web', path: 'https://example.com/foo' },
      { kind: 'review', path: '@review' },
      { kind: 'git-history', path: '@git-history' },
      { kind: 'commit-diff', path: `${SHA} src/a.ts` },
    ]);
  });

  it('excludes a preview-only commit-diff (@preview slot with no real target)', () => {
    // A single-click leaves the preview slot targeting a real <sha> <file>; but a bare
    // @preview id whose path never parses to a real file (empty file) is transient.
    const s = docsReducer(initialDocs, {
      type: 'openCommitFile',
      sha: SHA,
      file: '', // no real target file
      sessionId: 'S1',
      mode: 'preview',
    });
    expect(s.docs[0].id).toBe('commit-diff:@preview');
    expect(toPersistedDocs(s)).toEqual([]);
  });

  it('persists a real (targeted) preview commit-diff, carrying its preview flag', () => {
    const s = docsReducer(initialDocs, {
      type: 'openCommitFile',
      sha: SHA,
      file: 'src/a.ts',
      sessionId: 'S1',
      mode: 'preview',
    });
    expect(toPersistedDocs(s)).toEqual([
      {
        kind: 'commit-diff',
        path: `${SHA} src/a.ts`,
        sessionId: 'S1',
        preview: true,
        active: true,
      },
    ]);
  });

  it('keeps a scoped working source but canonicalises the unscoped one to absent', () => {
    let s = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'working', scope: 'staged' },
    });
    expect(s.docs.find((d) => d.kind === 'review')?.reviewSource).toEqual({
      kind: 'working',
      scope: 'staged',
    });
    s = docsReducer(s, { type: 'openReview', sessionId: 'S1', source: { kind: 'working' } });
    expect(s.docs.find((d) => d.kind === 'review')?.reviewSource).toBeUndefined();
  });

  it('does not persist reviewSource (a restored Review reopens in working-tree mode)', () => {
    const s = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'commit', sha: 'deadbeef', subject: 'fix' },
    });
    const persisted = toPersistedDocs(s);
    expect(persisted).toEqual([{ kind: 'review', path: '@review', sessionId: 'S1', active: true }]);
    expect('reviewSource' in persisted[0]).toBe(false);
  });

  it('captures the preview flag and the per-session active doc', () => {
    let s = openMode(initialDocs, 'file', '/a.ts', 'permanent', 'S1'); // permanent, will be active
    s = openMode(s, 'file', '/b.ts', 'preview', 'S1'); // preview, now active
    const persisted = toPersistedDocs(s);
    const a = persisted.find((d) => d.path === '/a.ts');
    const b = persisted.find((d) => d.path === '/b.ts');
    expect(a).toEqual({ kind: 'file', path: '/a.ts', sessionId: 'S1' });
    expect(b).toEqual({
      kind: 'file',
      path: '/b.ts',
      sessionId: 'S1',
      preview: true,
      active: true,
    });
  });
});

describe('docsReducer — restore (one-shot startup seed)', () => {
  const docs: PersistedDoc[] = [
    { kind: 'file', path: '/a.ts', sessionId: 'S1' },
    { kind: 'file', path: '/b.ts', sessionId: 'S1', preview: true, active: true },
  ];

  it('rebuilds docs[] and the active session pointer, preserving preview flags', () => {
    const s = docsReducer(initialDocs, { type: 'restore', docs, knownSessionIds: ['S1'] });
    expect(s.docs.map((d) => d.id)).toEqual(['file:/a.ts', 'file:/b.ts']);
    expect(s.docs[0].preview).toBeFalsy();
    expect(s.docs[1].preview).toBe(true);
    expect(s.docs[1].title).toBe('b.ts');
    expect(s.activeBySession.S1).toBe('file:/b.ts');
    // The switchSession effect resolves activeId once a session is selected.
    const after = docsReducer(s, { type: 'switchSession', sessionId: 'S1' });
    expect(after.activeId).toBe('file:/b.ts');
  });

  it('drops orphan docs whose owning session did not restore', () => {
    const withOrphan: PersistedDoc[] = [
      ...docs,
      { kind: 'file', path: '/c.ts', sessionId: 'GONE' },
    ];
    const s = docsReducer(initialDocs, {
      type: 'restore',
      docs: withOrphan,
      knownSessionIds: ['S1'],
    });
    expect(s.docs.map((d) => d.path)).toEqual(['/a.ts', '/b.ts']);
    expect(s.activeBySession.GONE).toBeUndefined();
  });

  it('round-trips through toPersistedDocs', () => {
    let src = openMode(initialDocs, 'file', '/a.ts', 'permanent', 'S1');
    src = openMode(src, 'file', '/b.ts', 'preview', 'S1');
    const restored = docsReducer(initialDocs, {
      type: 'restore',
      docs: toPersistedDocs(src),
      knownSessionIds: ['S1'],
    });
    expect(restored.docs.map((d) => ({ id: d.id, preview: !!d.preview }))).toEqual([
      { id: 'file:/a.ts', preview: false },
      { id: 'file:/b.ts', preview: true },
    ]);
    expect(restored.activeBySession.S1).toBe('file:/b.ts');
  });

  it('rebuilds every restorable kind with the right id/title/kind', () => {
    const SHA = 'a'.repeat(40);
    const mixed: PersistedDoc[] = [
      { kind: 'file', path: '/a.ts', sessionId: 'S1' },
      { kind: 'diff', path: '/a.ts', sessionId: 'S1' },
      { kind: 'commit-diff', path: `${SHA} src/x.ts`, sessionId: 'S1' },
      { kind: 'review', path: '@review', sessionId: 'S1' },
      { kind: 'git-history', path: '@git-history', sessionId: 'S1' },
      { kind: 'web', path: 'https://example.com/foo', sessionId: 'S1', active: true },
    ];
    const s = docsReducer(initialDocs, { type: 'restore', docs: mixed, knownSessionIds: ['S1'] });
    expect(s.docs.map((d) => ({ id: d.id, kind: d.kind, title: d.title }))).toEqual([
      { id: 'file:/a.ts', kind: 'file', title: 'a.ts' },
      { id: 'diff:/a.ts', kind: 'diff', title: 'a.ts' },
      {
        id: `commit-diff:${SHA} src/x.ts`,
        kind: 'commit-diff',
        title: `x.ts @ ${SHA.slice(0, 7)}`,
      },
      { id: 'review:@review', kind: 'review', title: 'Review Changes' },
      { id: 'git-history:@git-history', kind: 'git-history', title: 'History' },
      { id: 'web:https://example.com/foo', kind: 'web', title: 'example.com/foo' },
    ]);
    expect(s.activeBySession.S1).toBe('web:https://example.com/foo');
  });

  it('a restored commit-diff/web has no reviewSource and reopens fresh', () => {
    const restored = docsReducer(initialDocs, {
      type: 'restore',
      docs: [{ kind: 'review', path: '@review', sessionId: 'S1' }],
      knownSessionIds: ['S1'],
    });
    expect(restored.docs[0].reviewSource).toBeUndefined();
  });

  it('dedupes the singleton review/git-history kinds (never two of the same tab)', () => {
    const dupes: PersistedDoc[] = [
      { kind: 'review', path: '@review', sessionId: 'S1' },
      { kind: 'review', path: '@review', sessionId: 'S2', active: true },
      { kind: 'git-history', path: '@git-history', sessionId: 'S1' },
      { kind: 'git-history', path: '@git-history', sessionId: 'S2' },
    ];
    const s = docsReducer(initialDocs, {
      type: 'restore',
      docs: dupes,
      knownSessionIds: ['S1', 'S2'],
    });
    expect(s.docs.map((d) => d.id)).toEqual(['review:@review', 'git-history:@git-history']);
    // First occurrence wins ownership; the later duplicate's active flag is ignored.
    expect(s.docs[0].sessionId).toBe('S1');
  });

  it('round-trips a full mix of kinds (restore∘toPersistedDocs reproduces the docs)', () => {
    const SHA = 'a'.repeat(40);
    let src = open(initialDocs, 'file', '/a.ts', 'S1');
    src = open(src, 'diff', '/a.ts', 'S1');
    src = docsReducer(src, {
      type: 'open',
      kind: 'web',
      path: 'https://example.com/foo',
      sessionId: 'S1',
    });
    src = docsReducer(src, { type: 'openReview', sessionId: 'S1', source: { kind: 'working' } });
    src = docsReducer(src, {
      type: 'open',
      kind: 'git-history',
      path: '@git-history',
      sessionId: 'S1',
    });
    src = docsReducer(src, {
      type: 'openCommitFile',
      sha: SHA,
      file: 'src/x.ts',
      sessionId: 'S1',
      mode: 'permanent',
    });
    const restored = docsReducer(initialDocs, {
      type: 'restore',
      docs: toPersistedDocs(src),
      knownSessionIds: ['S1'],
    });
    expect(restored.docs.map((d) => d.id)).toEqual(src.docs.map((d) => d.id));
  });
});

describe('docsReducer — scoped diff tabs', () => {
  const openScoped = (s: DocsState, path: string, diffScope?: 'staged' | 'unstaged') =>
    docsReducer(s, { type: 'open', kind: 'diff', path, sessionId: 'S1', diffScope });

  it('scoped diff docs have distinct ids and titles', () => {
    let s = openScoped(initialDocs, '/r/both.ts', 'staged');
    s = openScoped(s, '/r/both.ts', 'unstaged');
    s = openScoped(s, '/r/both.ts');
    expect(s.docs.map((d) => [d.id, d.title, d.diffScope])).toEqual([
      ['diff@staged:/r/both.ts', 'both.ts (Index)', 'staged'],
      ['diff@unstaged:/r/both.ts', 'both.ts (Working Tree)', 'unstaged'],
      ['diff:/r/both.ts', 'both.ts', undefined],
    ]);
    expect('diffScope' in s.docs[2]).toBe(false);
  });

  it('reopening a scoped diff activates it', () => {
    let s = openScoped(initialDocs, '/r/both.ts', 'staged');
    s = openScoped(s, '/r/both.ts', 'unstaged');
    s = openScoped(s, '/r/both.ts', 'staged');
    expect(s.docs).toHaveLength(2);
    expect(s.activeId).toBe('diff@staged:/r/both.ts');
  });

  it('restore keeps the scope', () => {
    const s = docsReducer(initialDocs, {
      type: 'restore',
      docs: [{ kind: 'diff', path: '/r/a.ts', sessionId: 'S1', diffScope: 'staged', active: true }],
      knownSessionIds: ['S1'],
    });
    expect(s.docs[0]).toMatchObject({
      id: 'diff@staged:/r/a.ts',
      title: 'a.ts (Index)',
      diffScope: 'staged',
    });
    expect(s.activeBySession.S1).toBe('diff@staged:/r/a.ts');
  });

  it('toPersistedDocs writes diffScope and active', () => {
    let src = openScoped(initialDocs, '/r/a.ts', 'unstaged');
    src = openScoped(src, '/r/a.ts');
    src = openScoped(src, '/r/a.ts', 'staged');
    const persisted = toPersistedDocs(src);
    expect(persisted).toEqual([
      { kind: 'diff', path: '/r/a.ts', sessionId: 'S1', diffScope: 'unstaged' },
      { kind: 'diff', path: '/r/a.ts', sessionId: 'S1' },
      { kind: 'diff', path: '/r/a.ts', sessionId: 'S1', diffScope: 'staged', active: true },
    ]);
    const restored = docsReducer(initialDocs, {
      type: 'restore',
      docs: persisted,
      knownSessionIds: ['S1'],
    });
    const shape = (s: DocsState) =>
      s.docs.map((d) => ({ id: d.id, title: d.title, diffScope: d.diffScope }));
    expect(shape(restored)).toEqual(shape(src));
  });
});

describe('docsReducer — openReview (review source)', () => {
  it('opens the singleton review doc with a working source (stored as absent)', () => {
    const s = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'working' },
    });
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe(REVIEW_DOC_ID);
    expect(s.docs[0].kind).toBe('review');
    expect(s.docs[0].reviewSource).toBeUndefined();
    expect(s.activeId).toBe(REVIEW_DOC_ID);
    expect(s.activeBySession.S1).toBe(REVIEW_DOC_ID);
  });

  it('openReview stores {kind:"working", repoRoot} (not undefined)', () => {
    const s = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'working', repoRoot: '/r/proto' },
    });
    expect(s.docs[0].reviewSource).toEqual({ kind: 'working', repoRoot: '/r/proto' });
  });

  it('openReview {kind:"working"} still stores undefined', () => {
    const s = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'working', scope: 'all' },
    });
    expect(s.docs[0].reviewSource).toBeUndefined();
  });

  it('range repoRoot kept', () => {
    const source = {
      kind: 'range' as const,
      base: { kind: 'branch' as const, ref: 'main' },
      head: { kind: 'working' as const },
      repoRoot: '/r/proto',
    };
    const s = docsReducer(initialDocs, { type: 'openReview', sessionId: 'S1', source });
    expect(s.docs[0].reviewSource).toEqual(source);
  });

  it('opens the singleton review doc with a commit source', () => {
    const s = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'commit', sha: 'deadbeef', subject: 'fix' },
    });
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].reviewSource).toEqual({ kind: 'commit', sha: 'deadbeef', subject: 'fix' });
  });

  it('retargets the SAME singleton in place when reviewing a different commit', () => {
    let s = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'commit', sha: 'aaa', subject: 'A' },
    });
    s = docsReducer(s, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'commit', sha: 'bbb', subject: 'B' },
    });
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe(REVIEW_DOC_ID);
    expect(s.docs[0].reviewSource).toEqual({ kind: 'commit', sha: 'bbb', subject: 'B' });
  });

  it('switching a commit source back to working clears it (absent) in place', () => {
    let s = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'commit', sha: 'aaa' },
    });
    s = docsReducer(s, {
      type: 'openReview',
      sessionId: 'S1',
      source: { kind: 'working' },
    });
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].reviewSource).toBeUndefined();
  });

  it('transfers ownership + reactivates when reopened under another session', () => {
    let s = docsReducer(initialDocs, {
      type: 'openReview',
      sessionId: 'A',
      source: { kind: 'working' },
    });
    s = docsReducer(s, {
      type: 'openReview',
      sessionId: 'B',
      source: { kind: 'commit', sha: 'ccc' },
    });
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].sessionId).toBe('B');
    expect(s.activeId).toBe(REVIEW_DOC_ID);
    expect(s.activeBySession.B).toBe(REVIEW_DOC_ID);
    // The previous owner no longer points at the (now B-owned) review doc.
    s = docsReducer(s, { type: 'closeSession', sessionId: 'A' });
    expect(s.docs).toHaveLength(1);
  });

  // Guards the nav-history cross-session apply ordering (mouse-nav-buttons AC17): a Back that
  // crosses sessions must land on the RECORDED doc, not the session's last-remembered one. The
  // renderer's applyNav dispatches `activate` (which stamps activeBySession) BEFORE the
  // activeId-change effect fires `switchSession`; switchSession must then read that stamp and
  // not clobber the explicit target. See app.tsx applyNav + the switchSession effect.
  it('Back across sessions lands on the recorded doc, not the last-remembered one', () => {
    let s = open(initialDocs, 'file', '/a.ts', 'S1');
    s = open(s, 'file', '/b.ts', 'S1'); // S1 last-remembered = file:/b.ts
    s = docsReducer(s, { type: 'switchSession', sessionId: 'S2' });
    s = open(s, 'file', '/c.ts', 'S2');
    // applyNav order for a Back targeting S1's a.ts: activate first…
    s = docsReducer(s, { type: 'activate', id: 'file:/a.ts', sessionId: 'S1' });
    // …then the switchSession effect for the now-active session.
    s = docsReducer(s, { type: 'switchSession', sessionId: 'S1' });
    expect(s.activeId).toBe('file:/a.ts');
  });
});

describe('docsReducer — background open (middle-click)', () => {
  const SHA = 'b'.repeat(40);
  const bg = (s: DocsState, kind: 'file' | 'diff' | 'web', path: string, sessionId = 'S1') =>
    docsReducer(s, { type: 'open', kind, path, sessionId, mode: 'background' });

  it('appends a pinned tab and keeps activeId/activeBySession references', () => {
    const prev = open(initialDocs, 'file', '/a.ts');
    const next = bg(prev, 'file', '/b.ts');
    expect(next.docs.map((d) => d.id)).toEqual(['file:/a.ts', 'file:/b.ts']);
    expect(next.docs[1].preview).not.toBe(true);
    expect(next.docs[1].sessionId).toBe('S1');
    expect(next.activeId).toBe(prev.activeId);
    expect(next.activeBySession).toBe(prev.activeBySession);
  });

  it('clears preview in place on the preview file, references unchanged', () => {
    let prev = open(initialDocs, 'file', '/a.ts');
    prev = openMode(prev, 'file', '/p.ts', 'preview');
    prev = docsReducer(prev, { type: 'activate', id: 'file:/a.ts', sessionId: 'S1' });
    const next = bg(prev, 'file', '/p.ts');
    expect(next.docs.map((d) => d.id)).toEqual(prev.docs.map((d) => d.id));
    expect(next.docs[1].preview).toBeFalsy();
    expect(next.activeId).toBe(prev.activeId);
    expect(next.activeBySession).toBe(prev.activeBySession);
  });

  it('never transfers ownership of a pinned doc in another session', () => {
    let prev = open(initialDocs, 'file', '/a.ts', 'A');
    prev = open(prev, 'file', '/x.ts', 'B');
    const next = bg(prev, 'file', '/a.ts', 'B');
    expect(next.docs.find((d) => d.id === 'file:/a.ts')?.sessionId).toBe('A');
    expect(next.docs).toEqual(prev.docs);
    expect(next.activeId).toBe(prev.activeId);
    expect(next.activeBySession).toBe(prev.activeBySession);
  });

  it('keys a scoped diff with the same id a foreground open uses', () => {
    const prev = open(initialDocs, 'file', '/a.ts');
    const next = docsReducer(prev, {
      type: 'open',
      kind: 'diff',
      path: '/a.ts',
      sessionId: 'S1',
      mode: 'background',
      diffScope: 'staged',
    });
    expect(next.docs[1].id).toBe('diff@staged:/a.ts');
    expect(next.docs[1].diffScope).toBe('staged');
    expect(next.activeBySession).toBe(prev.activeBySession);
  });

  it('appends a web tab', () => {
    const prev = open(initialDocs, 'file', '/a.ts');
    const next = bg(prev, 'web', 'https://example.com/two');
    expect(next.docs[1]).toMatchObject({ kind: 'web', path: 'https://example.com/two' });
    expect(next.docs[1].preview).not.toBe(true);
    expect(next.activeId).toBe('file:/a.ts');
  });

  const commit = (s: DocsState, file: string, mode: OpenMode, sessionId = 'S1') =>
    docsReducer(s, { type: 'openCommitFile', sha: SHA, file, sessionId, mode });

  it('commit-diff: re-keys the matching preview slot and repoints activeBySession', () => {
    const prev = commit(initialDocs, 'src/a.ts', 'preview');
    const next = commit(prev, 'src/a.ts', 'background');
    const pinned = `commit-diff:${SHA} src/a.ts`;
    expect(next.docs.map((d) => d.id)).toEqual([pinned]);
    expect(next.docs[0].preview).toBeFalsy();
    expect(next.activeBySession.S1).toBe(pinned);
    expect(next.activeId).toBe(pinned);
  });

  it('commit-diff: appends a pinned tab when the preview holds another file', () => {
    const prev = commit(initialDocs, 'src/a.ts', 'preview');
    const next = commit(prev, 'src/b.ts', 'background');
    expect(next.docs.map((d) => d.id)).toEqual([
      'commit-diff:@preview',
      `commit-diff:${SHA} src/b.ts`,
    ]);
    expect(next.docs[1].preview).toBeFalsy();
    expect(next.activeId).toBe(prev.activeId);
    expect(next.activeBySession).toBe(prev.activeBySession);
  });

  it('commit-diff: an already pinned id is a no-op', () => {
    const prev = commit(initialDocs, 'src/a.ts', 'permanent');
    expect(commit(prev, 'src/a.ts', 'background')).toBe(prev);
  });

  it('backgroundOpenOutcome reports opened / pinned / already-open with owner and title', () => {
    let s = open(initialDocs, 'file', '/a.ts', 'A');
    s = openMode(s, 'file', '/p.ts', 'preview', 'A');
    expect(backgroundOpenOutcome(s, 'file', '/n.ts', 'B')).toEqual({
      outcome: 'opened',
      ownerSessionId: 'B',
      id: 'file:/n.ts',
      title: 'n.ts',
    });
    expect(backgroundOpenOutcome(s, 'file', '/p.ts', 'B')).toEqual({
      outcome: 'pinned',
      ownerSessionId: 'A',
      id: 'file:/p.ts',
      title: 'p.ts',
    });
    expect(backgroundOpenOutcome(s, 'file', '/a.ts', 'B')).toMatchObject({
      outcome: 'already-open',
      ownerSessionId: 'A',
    });
    expect(backgroundOpenOutcome(s, 'diff', '/a.ts', 'A', 'staged')).toMatchObject({
      outcome: 'opened',
      id: 'diff@staged:/a.ts',
    });
    const c = commit(initialDocs, 'src/a.ts', 'preview');
    expect(backgroundOpenOutcome(c, 'commit-diff', `${SHA} src/a.ts`, 'S1')).toEqual({
      outcome: 'pinned',
      ownerSessionId: 'S1',
      id: `commit-diff:${SHA} src/a.ts`,
      title: `a.ts @ ${SHA.slice(0, 7)}`,
    });
  });
});

describe('docsReducer — git-history repoRoot', () => {
  const HISTORY_ID = 'git-history:@git-history';
  const openHistory = (s: DocsState, extra: { repoRoot?: string; mode?: OpenMode } = {}) =>
    docsReducer(s, {
      type: 'open',
      kind: 'git-history',
      path: '@git-history',
      sessionId: 'S1',
      ...extra,
    });
  const history = (s: DocsState) => s.docs.find((d) => d.id === HISTORY_ID);

  it('open git-history stores repoRoot', () => {
    expect(history(openHistory(initialDocs, { repoRoot: '/w/a' }))?.repoRoot).toBe('/w/a');
    expect(
      history(openHistory(initialDocs, { repoRoot: '/w/a', mode: 'background' }))?.repoRoot,
    ).toBe('/w/a');
  });

  it('re-open with another repoRoot retargets the singleton, same id', () => {
    for (const mode of [undefined, 'background'] as const) {
      const s = openHistory(openHistory(initialDocs, { repoRoot: '/w/a' }), {
        repoRoot: '/w/b',
        ...(mode ? { mode } : {}),
      });
      expect(s.docs.filter((d) => d.kind === 'git-history')).toHaveLength(1);
      expect(history(s)?.repoRoot).toBe('/w/b');
    }
  });

  it('re-open without the key keeps the stored repoRoot', () => {
    const s = openHistory(openHistory(initialDocs, { repoRoot: '/w/a' }));
    expect(history(s)?.repoRoot).toBe('/w/a');
  });

  it('openCommitFile stamps the history repo on the commit-diff tab', () => {
    const sha = 'b'.repeat(40);
    for (const mode of ['preview', 'permanent', 'background'] as const) {
      const s = docsReducer(initialDocs, {
        type: 'openCommitFile',
        sha,
        file: 'x.ts',
        sessionId: 'S1',
        mode,
        repoRoot: '/w/b',
      });
      expect(s.docs[0].repoRoot).toBe('/w/b');
    }
  });
});

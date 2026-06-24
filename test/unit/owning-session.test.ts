import { describe, expect, it } from 'vitest';
import { resolveOwningSession } from '../../src/owning-session';

const sessions = (list: { id: string; projectPath: string }[]) => list;

describe('resolveOwningSession', () => {
  const sessA = { id: 'A', projectPath: '/projects/alpha' };
  const sessB = { id: 'B', projectPath: '/projects/beta' };
  const sessC = { id: 'C', projectPath: '/projects/alpha/sub' };

  it('originSessionId wins when two sessions share a folder (the split-view bug)', () => {
    // A is active; B is the session whose terminal was clicked. Both roots are equal,
    // so prefix-matching ties and the old code routed to active (A). Origin must win.
    const sameFolderA = { id: 'A', projectPath: '/projects/alpha' };
    const sameFolderB = { id: 'B', projectPath: '/projects/alpha' };
    expect(
      resolveOwningSession({
        path: '/projects/alpha/foo.ts',
        sessions: sessions([sameFolderA, sameFolderB]),
        openDocs: [],
        activeId: 'A',
        originSessionId: 'B',
      }),
    ).toBe('B');
  });

  it('originSessionId beats an already-open copy in another session', () => {
    const result = resolveOwningSession({
      path: '/projects/alpha/foo.ts',
      sessions: sessions([sessA, sessB]),
      openDocs: [{ sessionId: 'A', path: '/projects/alpha/foo.ts' }],
      activeId: 'A',
      originSessionId: 'B',
    });
    expect(result).toBe('B');
  });

  it('ignores a stale originSessionId that is no longer a session', () => {
    const result = resolveOwningSession({
      path: '/projects/alpha/foo.ts',
      sessions: sessions([sessA, sessB]),
      openDocs: [],
      activeId: 'A',
      originSessionId: 'gone',
    });
    expect(result).toBe('A'); // falls through to nearest-ancestor (A's root)
  });

  it('returns activeId when no sessions, no open docs', () => {
    expect(
      resolveOwningSession({
        path: '/projects/alpha/foo.ts',
        sessions: [],
        openDocs: [],
        activeId: 'A',
      }),
    ).toBe('A');
  });

  it('falls back to activeId when path has no ancestor and is not open', () => {
    expect(
      resolveOwningSession({
        path: '/unrelated/foo.ts',
        sessions: sessions([sessA, sessB]),
        openDocs: [],
        activeId: 'A',
      }),
    ).toBe('A');
  });

  it('already-open-elsewhere wins over nearest ancestor', () => {
    // Path is under A's project root but B already has it open
    const result = resolveOwningSession({
      path: '/projects/alpha/foo.ts',
      sessions: sessions([sessA, sessB]),
      openDocs: [{ sessionId: 'B', path: '/projects/alpha/foo.ts' }],
      activeId: 'A',
    });
    expect(result).toBe('B');
  });

  it('multiple sessions have doc open — prefers active if among them', () => {
    const result = resolveOwningSession({
      path: '/projects/alpha/foo.ts',
      sessions: sessions([sessA, sessB]),
      openDocs: [
        { sessionId: 'B', path: '/projects/alpha/foo.ts' },
        { sessionId: 'A', path: '/projects/alpha/foo.ts' },
      ],
      activeId: 'A',
    });
    expect(result).toBe('A');
  });

  it('multiple sessions have doc open — returns first if active not among them', () => {
    const result = resolveOwningSession({
      path: '/projects/alpha/foo.ts',
      sessions: sessions([sessA, sessB]),
      openDocs: [
        { sessionId: 'B', path: '/projects/alpha/foo.ts' },
        { sessionId: 'A', path: '/projects/alpha/foo.ts' },
      ],
      activeId: 'C', // not one of the openers
    });
    expect(result).toBe('B'); // first opener wins
  });

  it('nearest ancestor among multiple roots: longer root wins', () => {
    // sessC has /projects/alpha/sub which is a longer ancestor of the path
    const result = resolveOwningSession({
      path: '/projects/alpha/sub/deep/file.ts',
      sessions: sessions([sessA, sessC]),
      openDocs: [],
      activeId: null,
    });
    expect(result).toBe('C'); // /projects/alpha/sub is longer than /projects/alpha
  });

  it('segment-aware: /foo/bar does NOT match /foo/barbaz', () => {
    const result = resolveOwningSession({
      path: '/projects/alphabeta/foo.ts',
      sessions: sessions([sessA]), // /projects/alpha should NOT match /projects/alphabeta
      openDocs: [],
      activeId: 'X',
    });
    expect(result).toBe('X'); // falls through to activeId fallback
  });

  it('segment-aware: /foo/bar DOES match /foo/bar/baz', () => {
    const result = resolveOwningSession({
      path: '/projects/alpha/bar/baz.ts',
      sessions: sessions([sessA]),
      openDocs: [],
      activeId: null,
    });
    expect(result).toBe('A');
  });

  it('handles Windows-style backslash paths in both path and projectPath', () => {
    const winSess = { id: 'W', projectPath: 'C:\\Users\\foo\\project' };
    const result = resolveOwningSession({
      path: 'C:\\Users\\foo\\project\\src\\index.ts',
      sessions: sessions([winSess]),
      openDocs: [],
      activeId: null,
    });
    expect(result).toBe('W');
  });

  it('fallback to activeId null when no match', () => {
    const result = resolveOwningSession({
      path: '/nowhere/file.ts',
      sessions: [],
      openDocs: [],
      activeId: null,
    });
    expect(result).toBeNull();
  });
});

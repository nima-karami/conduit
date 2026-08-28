import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';
import { anchorFor } from '../../src/review-notes';
import {
  getNotesSnapshot,
  loadNotesFor,
  notesFor,
  notesLoaded,
  patchNotes,
  subscribeNotes,
} from '../../webview/review-notes-store';

const bus = vi.hoisted(() => ({
  posted: [] as WebviewToHost[],
  emit: (_m: HostToWebview): void => {},
}));

vi.mock('../../webview/bridge', () => ({
  post: (m: WebviewToHost) => {
    bus.posted.push(m);
  },
  subscribe: (cb: (m: HostToWebview) => void) => {
    bus.emit = cb;
    return () => {};
  },
}));

const ROOT = 'C:/work/repo';
const note = (id: string) => ({
  id,
  path: 'src/foo.ts',
  side: 'new' as const,
  line: 1,
  anchor: anchorFor('a', null, null),
  snippet: 'a',
  body: 'why?',
  createdAt: '2026-08-28T10:00:00.000Z',
});

beforeEach(() => {
  bus.posted.length = 0;
});

describe('review notes store', () => {
  it('is NOT loaded for a root until a push lands, and posts one load request per root', () => {
    expect(notesLoaded(getNotesSnapshot(), ROOT)).toBe(false);
    loadNotesFor(ROOT);
    loadNotesFor(ROOT);
    expect(bus.posted).toEqual([{ type: 'review:loadNotes', root: 'c:/work/repo' }]);

    bus.emit({ type: 'review:notes', root: 'c:/work/repo', notes: [] });
    expect(notesLoaded(getNotesSnapshot(), ROOT)).toBe(true);
    expect(notesFor(getNotesSnapshot(), ROOT)).toEqual([]);
  });

  it('folds a root key case-insensitively only for a drive-letter root', () => {
    bus.emit({ type: 'review:notes', root: 'C:/Work/Repo', notes: [note('a')] });
    expect(notesFor(getNotesSnapshot(), 'c:/work/repo')).toHaveLength(1);
  });

  it('applies a patch optimistically and posts it', () => {
    bus.emit({ type: 'review:notes', root: ROOT, notes: [] });
    const seen: number[] = [];
    const off = subscribeNotes(() => {
      seen.push(notesFor(getNotesSnapshot(), ROOT).length);
    });

    patchNotes(ROOT, { op: 'add', note: note('n1') });
    expect(notesFor(getNotesSnapshot(), ROOT)).toHaveLength(1);
    expect(seen).toEqual([1]);
    expect(bus.posted.at(-1)).toEqual({
      type: 'review:setNotes',
      root: 'c:/work/repo',
      patch: { op: 'add', note: note('n1') },
    });
    off();
  });

  it('lets the host echo win over the optimistic list', () => {
    bus.emit({ type: 'review:notes', root: ROOT, notes: [] });
    patchNotes(ROOT, { op: 'add', note: note('n1') });
    bus.emit({ type: 'review:notes', root: ROOT, notes: [note('n2')] });
    expect(notesFor(getNotesSnapshot(), ROOT).map((n) => n.id)).toEqual(['n2']);
  });

  it('leaves other roots untouched on a push', () => {
    bus.emit({ type: 'review:notes', root: '/a', notes: [note('a')] });
    bus.emit({ type: 'review:notes', root: '/b', notes: [note('b')] });
    expect(notesFor(getNotesSnapshot(), '/a')).toHaveLength(1);
    expect(notesFor(getNotesSnapshot(), '/b')).toHaveLength(1);
  });

  it('returns a STABLE empty array for an unknown root, so a memo does not re-run', () => {
    const a = notesFor(getNotesSnapshot(), '/never-loaded');
    const b = notesFor(getNotesSnapshot(), '/never-loaded');
    expect(a).toBe(b);
  });
});

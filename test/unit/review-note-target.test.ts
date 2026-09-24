import { describe, expect, it, vi } from 'vitest';
import {
  getNoteTarget,
  setNoteTarget,
  subscribeNoteTarget,
} from '../../webview/review-note-target';

describe('review-note-target', () => {
  it('carries the notes-store root the note was resolved under, and re-nonces a repeat', () => {
    const cb = vi.fn();
    const off = subscribeNoteTarget(cb);
    const t = { root: '/w/repo-b', path: 'src/foo.ts', line: 3, noteId: 'n1' };
    setNoteTarget(t);
    const first = getNoteTarget();
    expect(first).toMatchObject(t);
    setNoteTarget(t);
    expect(getNoteTarget()?.root).toBe('/w/repo-b');
    expect(getNoteTarget()?.nonce).toBe((first?.nonce ?? 0) + 1);
    expect(cb).toHaveBeenCalledTimes(2);
    off();
  });
});

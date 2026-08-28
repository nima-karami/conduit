import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conduitDir, writeReviewNotesArtifactFile } from '../../electron/conduit-fs';
import { NotesWatcher } from '../../electron/notes-watcher';
import {
  anchorFor,
  notesFingerprint,
  type ReviewNote,
  type ReviewNotesData,
} from '../../src/review-notes';

let root: string;
let watcher: NotesWatcher;

const note = (body: string): ReviewNote => ({
  id: `note-${body}`,
  path: 'src/foo.ts',
  side: 'new',
  line: 1,
  anchor: anchorFor('a', null, null),
  snippet: 'a',
  body,
  createdAt: '2026-08-28T10:00:00.000Z',
});

const data = (body: string): ReviewNotesData => ({ version: 1, notes: [note(body)] });

/** Resolve on the first emit, or reject after `ms` — the watcher is debounced, so no polling. */
function nextEmit(w: NotesWatcher, dir: string, ms = 3000): Promise<ReviewNotesData> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no emit')), ms);
    w.watch(dir, (d) => {
      clearTimeout(timer);
      resolve(d);
    });
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-watch-'));
  fs.mkdirSync(conduitDir(root), { recursive: true });
  watcher = new NotesWatcher(20);
});
afterEach(() => {
  watcher.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('NotesWatcher', () => {
  it('emits an external edit to review-notes.json', async () => {
    const emitted = nextEmit(watcher, root);
    await writeReviewNotesArtifactFile(root, data('external'));
    expect((await emitted).notes[0].body).toBe('external');
  });

  it('suppresses the app own write echoing back', async () => {
    let emits = 0;
    watcher.watch(root, () => {
      emits++;
    });
    watcher.recordWrite(notesFingerprint(data('ours')));
    await writeReviewNotesArtifactFile(root, data('ours'));
    await new Promise((r) => setTimeout(r, 200));
    expect(emits).toBe(0);
  });

  it('still emits a genuine edit made after one of our own writes', async () => {
    watcher.recordWrite(notesFingerprint(data('ours')));
    const emitted = nextEmit(watcher, root);
    await writeReviewNotesArtifactFile(root, data('theirs'));
    expect((await emitted).notes[0].body).toBe('theirs');
  });

  it('ignores writes to another file in .conduit/', async () => {
    let emits = 0;
    watcher.watch(root, () => {
      emits++;
    });
    fs.writeFileSync(path.join(conduitDir(root), 'board.json'), '{}');
    await new Promise((r) => setTimeout(r, 200));
    expect(emits).toBe(0);
  });

  it('drops the recorded fingerprint on stop, so it cannot leak across projects', async () => {
    watcher.recordWrite(notesFingerprint(data('ours')));
    watcher.stop();
    const emitted = nextEmit(watcher, root);
    await writeReviewNotesArtifactFile(root, data('ours'));
    expect((await emitted).notes[0].body).toBe('ours');
  });
});

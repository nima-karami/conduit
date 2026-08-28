import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conduitDir,
  conduitPath,
  REVIEW_NOTES_FILE_NAME,
  readReviewNotesBlob,
  readReviewNotesForProject,
  writeReviewNotesArtifactFile,
} from '../../electron/conduit-fs';
import { CONDUIT_VERSION, readReviewNotesArtifact } from '../../src/conduit-store';
import { anchorFor, emptyNotesData, type ReviewNote } from '../../src/review-notes';

let root: string;

const note = (over: Partial<ReviewNote> = {}): ReviewNote => ({
  id: 'note-1',
  path: 'src/foo.ts',
  side: 'new',
  line: 42,
  anchor: anchorFor('const x = 1;', 'a', 'b'),
  snippet: 'const x = 1;',
  body: 'why this?',
  createdAt: '2026-08-28T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-notes-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('.conduit/review-notes.json', () => {
  it('is named review-notes.json inside .conduit/', () => {
    expect(REVIEW_NOTES_FILE_NAME).toBe('review-notes.json');
    expect(conduitPath(root, REVIEW_NOTES_FILE_NAME)).toBe(
      path.join(root, '.conduit', 'review-notes.json'),
    );
  });

  it('writes an ADR 0002 envelope and reads it back', async () => {
    await writeReviewNotesArtifactFile(root, { version: 1, notes: [note()] });
    const raw = JSON.parse(fs.readFileSync(conduitPath(root, REVIEW_NOTES_FILE_NAME), 'utf8'));
    expect(raw.conduit).toBe(CONDUIT_VERSION);
    expect(raw.kind).toBe('review-notes');
    expect(typeof raw.updatedAt).toBe('number');
    expect(raw.data.version).toBe(1);
    expect(raw.data.notes[0].id).toBe('note-1');
    expect(readReviewNotesForProject(root).notes).toHaveLength(1);
  });

  it('leaves no atomic-write temp files behind', async () => {
    await writeReviewNotesArtifactFile(root, { version: 1, notes: [note()] });
    expect(fs.readdirSync(conduitDir(root)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('is EMPTY when the file is absent, and for a falsy root', () => {
    expect(readReviewNotesForProject(root)).toEqual(emptyNotesData());
    expect(readReviewNotesForProject('')).toEqual(emptyNotesData());
    expect(readReviewNotesBlob(root)).toBeUndefined();
  });

  it('is EMPTY for a corrupt file, and the next write replaces it', async () => {
    fs.mkdirSync(conduitDir(root), { recursive: true });
    fs.writeFileSync(conduitPath(root, REVIEW_NOTES_FILE_NAME), '{ not json');
    expect(readReviewNotesForProject(root)).toEqual(emptyNotesData());
    await writeReviewNotesArtifactFile(root, { version: 1, notes: [note()] });
    expect(readReviewNotesForProject(root).notes).toHaveLength(1);
  });

  it('reads a bare (un-enveloped) payload too, like every other kind', () => {
    fs.mkdirSync(conduitDir(root), { recursive: true });
    fs.writeFileSync(
      conduitPath(root, REVIEW_NOTES_FILE_NAME),
      JSON.stringify({ version: 1, notes: [note()] }),
    );
    expect(readReviewNotesForProject(root).notes).toHaveLength(1);
  });

  it('drops a malformed note out of an otherwise valid envelope', () => {
    expect(
      readReviewNotesArtifact(
        JSON.stringify({
          conduit: 1,
          kind: 'review-notes',
          updatedAt: 1,
          data: { version: 1, notes: [note(), { id: 'bad' }] },
        }),
      ).notes,
    ).toHaveLength(1);
  });
});

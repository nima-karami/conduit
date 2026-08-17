import { describe, expect, it } from 'vitest';
import {
  deleteOutcomeAnnouncement,
  permanentConfirmMessage,
  trashConfirmMessage,
} from '../../src/delete-confirm';

// Copy for the bulk-delete flow — see
// docs/specs/2026-08-16-selection-aware-context-menus.md §4.3.

describe('trashConfirmMessage', () => {
  it('names the single file exactly as it always has', () => {
    expect(trashConfirmMessage(['/p/a.txt'])).toBe('Move "a.txt" to the Recycle Bin?');
  });

  it('counts the items and lists their base names', () => {
    expect(trashConfirmMessage(['/p/a.txt', '/p/sub/b.txt'])).toBe(
      'Move 2 items to the Recycle Bin?\n\na.txt\nb.txt',
    );
  });

  it('caps the listing at five names', () => {
    const paths = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `/p/${n}.txt`);
    expect(trashConfirmMessage(paths)).toBe(
      'Move 7 items to the Recycle Bin?\n\na.txt\nb.txt\nc.txt\nd.txt\ne.txt\n…and 2 more',
    );
  });

  it('lists exactly five names without an "and more" line', () => {
    const paths = ['a', 'b', 'c', 'd', 'e'].map((n) => `/p/${n}.txt`);
    expect(trashConfirmMessage(paths)).toBe(
      'Move 5 items to the Recycle Bin?\n\na.txt\nb.txt\nc.txt\nd.txt\ne.txt',
    );
  });
});

describe('permanentConfirmMessage', () => {
  it('keeps the single-file wording verbatim', () => {
    expect(permanentConfirmMessage(['/p/a.txt'])).toBe(
      'Couldn\'t move "a.txt" to the Recycle Bin. Delete it permanently? This cannot be undone.',
    );
  });

  it('counts and lists the failures', () => {
    expect(permanentConfirmMessage(['/p/a.txt', '/p/b.txt'])).toBe(
      "Couldn't move 2 items to the Recycle Bin. Delete permanently? This cannot be undone.\n\na.txt\nb.txt",
    );
  });
});

describe('deleteOutcomeAnnouncement', () => {
  it('announces a clean single delete without a plural', () => {
    expect(deleteOutcomeAnnouncement(1, 0)).toBe('Deleted 1 item');
  });

  it('announces a clean bulk delete', () => {
    expect(deleteOutcomeAnnouncement(3, 0)).toBe('Deleted 3 items');
  });

  it('reports both halves of a partial failure', () => {
    expect(deleteOutcomeAnnouncement(2, 1)).toBe('2 deleted, 1 failed');
  });

  it('is silent when nothing happened', () => {
    expect(deleteOutcomeAnnouncement(0, 0)).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { releaseNotesDecision } from '../../src/release-notes-decision';

describe('releaseNotesDecision', () => {
  it('records a fresh install without showing a toast', () => {
    expect(releaseNotesDecision('0.53.0', undefined, 'notes')).toEqual({
      showToast: false,
      persistVersion: '0.53.0',
    });
  });
  it.each([
    ['same version', '0.53.0', 'notes', false],
    ['newer version', '0.52.0', 'notes', true],
    ['downgrade', '0.54.0', 'notes', false],
    ['missing notes', '0.52.0', null, false],
  ])('%s', (_label, lastSeen, notes, showToast) => {
    expect(
      releaseNotesDecision('0.53.0', lastSeen as string, notes as string | null).showToast,
    ).toBe(showToast);
  });
});

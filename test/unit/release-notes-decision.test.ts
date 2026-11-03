import { describe, expect, it } from 'vitest';
import { releaseNotesAckVersion, releaseNotesDecision } from '../../src/release-notes-decision';

describe('releaseNotesDecision', () => {
  it('records a fresh install without showing a toast', () => {
    expect(releaseNotesDecision('0.53.0', undefined, 'notes', false)).toEqual({
      showToast: false,
      persistVersion: '0.53.0',
    });
  });
  it('shows notes once for an existing settings file without an acknowledgement marker', () => {
    expect(releaseNotesDecision('0.53.0', undefined, 'notes', true)).toEqual({
      showToast: true,
      persistVersion: null,
    });
  });
  it('does not mark an existing install when its notes are missing', () => {
    expect(releaseNotesDecision('0.53.0', undefined, null, true)).toEqual({
      showToast: false,
      persistVersion: null,
    });
  });
  it.each([
    ['same version', '0.53.0', 'notes', false],
    ['newer version', '0.52.0', 'notes', true],
    ['downgrade', '0.54.0', 'notes', false],
    ['missing notes', '0.52.0', null, false],
  ])('%s', (_label, lastSeen, notes, showToast) => {
    expect(
      releaseNotesDecision('0.53.0', lastSeen as string, notes as string | null, true).showToast,
    ).toBe(showToast);
  });
  it('rejects prerelease versions without changing the stored stable version', () => {
    expect(releaseNotesDecision('0.54.0-beta.1', '0.53.0', 'notes', true)).toEqual({
      showToast: false,
      persistVersion: null,
    });
  });
  it('accepts a marker only for the version the host offered to that sender', () => {
    expect(releaseNotesAckVersion('0.53.0', '0.53.0')).toBe('0.53.0');
    expect(releaseNotesAckVersion(undefined, '9.9.9')).toBeNull();
    expect(releaseNotesAckVersion('0.53.0', '9.9.9')).toBeNull();
    expect(releaseNotesAckVersion('0.54.0-beta.1', '0.54.0-beta.1')).toBeNull();
  });
});

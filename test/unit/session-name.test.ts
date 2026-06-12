import { describe, expect, it } from 'vitest';
import { sessionNameFromPath } from '../../src/session-name';

describe('sessionNameFromPath', () => {
  it('returns the basename of a Unix path', () => {
    expect(sessionNameFromPath('/home/user/my-project')).toBe('my-project');
  });

  it('returns the basename of a Windows backslash path', () => {
    expect(sessionNameFromPath('C:\\Users\\user\\my-project')).toBe('my-project');
  });

  it('strips a trailing forward slash', () => {
    expect(sessionNameFromPath('/home/user/my-project/')).toBe('my-project');
  });

  it('strips a trailing backslash', () => {
    expect(sessionNameFromPath('C:\\Users\\user\\my-project\\')).toBe('my-project');
  });

  it('handles a path with multiple trailing slashes', () => {
    expect(sessionNameFromPath('/home/user/my-project///')).toBe('my-project');
  });

  it('handles Windows drive root (C:\\) — returns the drive letter', () => {
    expect(sessionNameFromPath('C:\\')).toBe('C:');
  });

  it('handles Unix root "/" — falls back to the raw input', () => {
    // After stripping trailing slash the string is empty; fallback to raw.
    expect(sessionNameFromPath('/')).toBe('/');
  });

  it('handles a bare folder name with no separators', () => {
    expect(sessionNameFromPath('my-project')).toBe('my-project');
  });

  it('handles mixed separators', () => {
    expect(sessionNameFromPath('C:/Users/user/my-project')).toBe('my-project');
  });

  it('handles empty string — returns empty string', () => {
    expect(sessionNameFromPath('')).toBe('');
  });

  it('preserves folder names that contain spaces or special chars', () => {
    expect(sessionNameFromPath('/home/user/my cool project!')).toBe('my cool project!');
  });

  it('handles deeply nested Windows path without trailing slash', () => {
    expect(sessionNameFromPath('D:\\repos\\client\\project-name')).toBe('project-name');
  });
});

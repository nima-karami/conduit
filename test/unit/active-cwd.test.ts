import { describe, expect, it } from 'vitest';
import { activeCwd } from '../../src/active-cwd';

describe('activeCwd', () => {
  it('returns cwd when cwd is present', () => {
    expect(activeCwd({ cwd: '/tmp/work', projectPath: '/home/project' })).toBe('/tmp/work');
  });

  it('returns projectPath when cwd is undefined', () => {
    expect(activeCwd({ cwd: undefined, projectPath: '/home/project' })).toBe('/home/project');
  });

  it('returns projectPath when cwd is empty string', () => {
    expect(activeCwd({ cwd: '', projectPath: '/home/project' })).toBe('/home/project');
  });
});

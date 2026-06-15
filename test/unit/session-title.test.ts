import { describe, expect, it } from 'vitest';
import { resolveTitleSync } from '../../src/session-title';

const base = { name: 'conduit', projectPath: 'C:\\dev\\conduit' };

describe('resolveTitleSync', () => {
  it('adopts a meaningful app title', () => {
    expect(resolveTitleSync(base, 'Claude Code — fixing paste')).toBe('Claude Code — fixing paste');
  });

  it('ignores empty/whitespace titles', () => {
    expect(resolveTitleSync(base, '')).toBeNull();
    expect(resolveTitleSync(base, '   ')).toBeNull();
  });

  it('lets a meaningful title (CLI /rename) override any current name', () => {
    // Even if the name was set by a prior manual rename, a real title still wins.
    expect(resolveTitleSync({ ...base, name: 'My manual name' }, 'RenamedViaCli')).toBe(
      'RenamedViaCli',
    );
  });

  it('ignores cwd-path titles (Windows drive, unix root, nested)', () => {
    expect(resolveTitleSync(base, 'C:\\dev\\conduit')).toBeNull();
    expect(resolveTitleSync(base, '/home/me/proj')).toBeNull();
    expect(resolveTitleSync(base, 'Users\\me\\proj')).toBeNull();
  });

  it('ignores the project folder name itself', () => {
    expect(resolveTitleSync(base, 'conduit')).toBeNull();
    expect(resolveTitleSync(base, 'CONDUIT')).toBeNull();
  });

  it('ignores a no-op (title already equals the name) and overlong titles', () => {
    expect(resolveTitleSync({ ...base, name: 'X' }, 'X')).toBeNull();
    expect(resolveTitleSync(base, 'a'.repeat(81))).toBeNull();
  });

  it('adopts another recognizable app title', () => {
    expect(resolveTitleSync({ name: 'conduit', projectPath: 'C:\\dev\\conduit' }, 'Aider')).toBe(
      'Aider',
    );
  });
});

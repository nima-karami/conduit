import { describe, expect, it } from 'vitest';
import { acceptRepoChanges } from '../../src/changes-view-model';
import type { RepoChanges } from '../../src/protocol';
import type { RepoInfo } from '../../src/repo-scan';

const repo = (root: string): RepoInfo => ({ root, name: root, folder: root, tag: 'attached' });
const rc = (root: string): RepoChanges => ({ root, name: root, tag: 'attached', changes: [] });

describe('acceptRepoChanges', () => {
  const prev = [rc('/a')];

  it('matching set adopted', () => {
    const incoming = [rc('/b'), rc('C:/A')];
    expect(acceptRepoChanges(prev, incoming, [repo('c:/a/'), repo('/b')])).toBe(incoming);
  });

  it('stale set (repo added since request) keeps prev', () => {
    expect(acceptRepoChanges(prev, [rc('/a')], [repo('/a'), repo('/b')])).toBe(prev);
  });

  it('undefined incoming keeps prev', () => {
    expect(acceptRepoChanges(prev, undefined, [repo('/a')])).toBe(prev);
  });

  it('repos undefined keeps prev', () => {
    expect(acceptRepoChanges(prev, [], undefined)).toBe(prev);
  });

  it('an empty set is adopted when no repos were found', () => {
    const incoming: RepoChanges[] = [];
    expect(acceptRepoChanges(prev, incoming, [])).toBe(incoming);
  });
});

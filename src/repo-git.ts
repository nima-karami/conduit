import type { GitInfo, Session } from './types';

export function gitOf(
  s: Pick<Session, 'repoGit' | 'activeRepoRoot'>,
  root: string | undefined = s.activeRepoRoot,
): GitInfo | undefined {
  return root === undefined ? undefined : s.repoGit?.[root];
}

export function anyRepoDirty(s: Pick<Session, 'repoGit'>): boolean {
  return Object.values(s.repoGit ?? {}).some((g) => g.dirty === true);
}

export function dirtyFileCount(s: Pick<Session, 'repoGit'>): number {
  return Object.values(s.repoGit ?? {}).reduce((n, g) => n + (g.dirtyFiles ?? 0), 0);
}

export function repoGitFingerprint(g: GitInfo | undefined): string {
  if (!g) return '';
  return `${g.kind}|${g.branch ?? ''}|${g.sha ?? ''}|${g.dirty ? 'd' : ''}|${g.operation ?? ''}`;
}

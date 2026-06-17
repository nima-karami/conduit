import { describe, expect, it } from 'vitest';
import { shouldIgnoreWatchPath } from '../../src/watch-filter';

describe('shouldIgnoreWatchPath', () => {
  it('reacts to normal source edits', () => {
    expect(shouldIgnoreWatchPath('src/app.ts')).toBe(false);
    expect(shouldIgnoreWatchPath('webview\\components\\x.tsx')).toBe(false);
    expect(shouldIgnoreWatchPath('README.md')).toBe(false);
  });

  it('reacts to an unknown/empty filename (refresh to be safe)', () => {
    expect(shouldIgnoreWatchPath('')).toBe(false);
  });

  it('ignores heavy/derived directories anywhere in the path', () => {
    expect(shouldIgnoreWatchPath('node_modules/react/index.js')).toBe(true);
    expect(shouldIgnoreWatchPath('packages/a/node_modules/x.js')).toBe(true);
    expect(shouldIgnoreWatchPath('dist/bundle.js')).toBe(true);
    expect(shouldIgnoreWatchPath('coverage/lcov.info')).toBe(true);
  });

  it('reacts to meaningful .git files (branch/commit/index)', () => {
    expect(shouldIgnoreWatchPath('.git/HEAD')).toBe(false);
    expect(shouldIgnoreWatchPath('.git/index')).toBe(false);
    expect(shouldIgnoreWatchPath('.git/refs/heads/main')).toBe(false);
    expect(shouldIgnoreWatchPath('.git/MERGE_HEAD')).toBe(false);
  });

  it('ignores .git object/log churn, locks, and watchman cookies', () => {
    expect(shouldIgnoreWatchPath('.git/objects/ab/cdef')).toBe(true);
    expect(shouldIgnoreWatchPath('.git/logs/HEAD')).toBe(true);
    expect(shouldIgnoreWatchPath('.git/index.lock')).toBe(true);
    expect(shouldIgnoreWatchPath('.git/worktrees/wt/index.lock')).toBe(true);
    expect(shouldIgnoreWatchPath('.git/.watchman-cookie-host-1')).toBe(true);
  });

  it('ignores editor swap/temp files', () => {
    expect(shouldIgnoreWatchPath('src/a.ts~')).toBe(true);
    expect(shouldIgnoreWatchPath('src/.a.ts.swp')).toBe(true);
    expect(shouldIgnoreWatchPath('x.tmp')).toBe(true);
  });
});

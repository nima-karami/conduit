import { describe, expect, it } from 'vitest';
import {
  dotModeFor,
  endpointKey,
  endpointLabel,
  fullyQualifiedRef,
  type RefEndpoint,
  rangeKey,
  shortSha,
} from '../../src/git-range';

const working: RefEndpoint = { kind: 'working' };
const commitA: RefEndpoint = { kind: 'commit', sha: 'a'.repeat(40), subject: 'add a' };
const commitB: RefEndpoint = { kind: 'commit', sha: 'b'.repeat(40) };
const main: RefEndpoint = { kind: 'branch', ref: 'main' };
const feature: RefEndpoint = { kind: 'branch', ref: 'feature/x' };
const remoteMain: RefEndpoint = { kind: 'branch', ref: 'origin/main', remote: true };
const tag: RefEndpoint = { kind: 'tag', ref: 'v1.0.0' };

describe('endpointKey', () => {
  it('encodes each kind distinctly', () => {
    expect(endpointKey(working)).toBe('working');
    expect(endpointKey(commitA)).toBe(`c:${'a'.repeat(40)}`);
    expect(endpointKey(main)).toBe('b:main');
    expect(endpointKey(tag)).toBe('t:v1.0.0');
  });
  it('does not collide a branch named like a sha with a commit', () => {
    expect(endpointKey({ kind: 'branch', ref: 'abc1234' })).not.toBe(
      endpointKey({ kind: 'commit', sha: 'abc1234' }),
    );
  });
  it('distinguishes a local branch from a same-stem remote branch by its ref', () => {
    expect(endpointKey(main)).not.toBe(endpointKey(remoteMain));
    expect(endpointKey(remoteMain)).toBe('b:origin/main');
  });
  it('distinguishes a tag from a branch of the same name', () => {
    expect(endpointKey({ kind: 'tag', ref: 'rel' })).not.toBe(
      endpointKey({ kind: 'branch', ref: 'rel' }),
    );
  });
});

describe('rangeKey', () => {
  it('is order-significant', () => {
    expect(rangeKey(main, feature)).not.toBe(rangeKey(feature, main));
  });
  it('is stable and composes the two endpoint keys', () => {
    expect(rangeKey(main, working)).toBe('b:main...working');
    expect(rangeKey(commitA, commitB)).toBe(`c:${'a'.repeat(40)}...c:${'b'.repeat(40)}`);
  });
});

describe('dotModeFor', () => {
  it('committish vs committish → three-dot', () => {
    expect(dotModeFor(main, feature)).toBe('three');
    expect(dotModeFor(commitA, commitB)).toBe('three');
    expect(dotModeFor(main, commitB)).toBe('three');
  });
  it('treats a tag/remote branch as committish (three-dot vs another committish)', () => {
    expect(dotModeFor(tag, main)).toBe('three');
    expect(dotModeFor(remoteMain, main)).toBe('three');
    expect(dotModeFor(tag, remoteMain)).toBe('three');
  });
  it('committish base + working head → two-dot', () => {
    expect(dotModeFor(main, working)).toBe('two');
    expect(dotModeFor(commitA, working)).toBe('two');
    expect(dotModeFor(tag, working)).toBe('two');
  });
  it('working base (any) → working (degenerate; the dialog forbids)', () => {
    expect(dotModeFor(working, working)).toBe('working');
    expect(dotModeFor(working, main)).toBe('working');
  });
});

describe('endpointLabel', () => {
  it('labels each kind', () => {
    expect(endpointLabel(working)).toBe('Working tree');
    expect(endpointLabel(commitA)).toBe('aaaaaaa');
    expect(endpointLabel(feature)).toBe('feature/x');
    expect(endpointLabel(remoteMain)).toBe('origin/main');
    expect(endpointLabel(tag)).toBe('v1.0.0');
  });
});

describe('fullyQualifiedRef', () => {
  it('maps a local branch to refs/heads', () => {
    expect(fullyQualifiedRef(main)).toBe('refs/heads/main');
  });
  it('maps a remote branch to refs/remotes', () => {
    expect(fullyQualifiedRef(remoteMain)).toBe('refs/remotes/origin/main');
  });
  it('maps a tag to refs/tags', () => {
    expect(fullyQualifiedRef(tag)).toBe('refs/tags/v1.0.0');
  });
  it('keys on the namespace, not the optional remote flag (a mislabeled remote maps to heads)', () => {
    // refs/heads/origin/main won't exist, so a mislabeled endpoint can't be smuggled through.
    expect(fullyQualifiedRef({ kind: 'branch', ref: 'origin/main' })).toBe(
      'refs/heads/origin/main',
    );
  });
  it('rejects a name beginning with "-" (option-like; never reaches an arg array)', () => {
    expect(fullyQualifiedRef({ kind: 'branch', ref: '--upload-pack=x' })).toBeNull();
    expect(fullyQualifiedRef({ kind: 'tag', ref: '-rf' })).toBeNull();
  });
  it('returns null for non-ref endpoints', () => {
    expect(fullyQualifiedRef(working)).toBeNull();
    expect(fullyQualifiedRef(commitA)).toBeNull();
  });
});

describe('shortSha', () => {
  it('takes the first 7 chars', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456');
  });
});

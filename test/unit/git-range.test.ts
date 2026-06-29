import { describe, expect, it } from 'vitest';
import {
  dotModeFor,
  endpointKey,
  endpointLabel,
  type RefEndpoint,
  rangeKey,
  shortSha,
} from '../../src/git-range';

const working: RefEndpoint = { kind: 'working' };
const commitA: RefEndpoint = { kind: 'commit', sha: 'a'.repeat(40), subject: 'add a' };
const commitB: RefEndpoint = { kind: 'commit', sha: 'b'.repeat(40) };
const main: RefEndpoint = { kind: 'branch', ref: 'main' };
const feature: RefEndpoint = { kind: 'branch', ref: 'feature/x' };

describe('endpointKey', () => {
  it('encodes each kind distinctly', () => {
    expect(endpointKey(working)).toBe('working');
    expect(endpointKey(commitA)).toBe(`c:${'a'.repeat(40)}`);
    expect(endpointKey(main)).toBe('b:main');
  });
  it('does not collide a branch named like a sha with a commit', () => {
    expect(endpointKey({ kind: 'branch', ref: 'abc1234' })).not.toBe(
      endpointKey({ kind: 'commit', sha: 'abc1234' }),
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
  it('committish base + working head → two-dot', () => {
    expect(dotModeFor(main, working)).toBe('two');
    expect(dotModeFor(commitA, working)).toBe('two');
  });
  it('working base (any) → working (degenerate; builder forbids)', () => {
    expect(dotModeFor(working, working)).toBe('working');
    expect(dotModeFor(working, main)).toBe('working');
  });
});

describe('endpointLabel', () => {
  it('labels each kind', () => {
    expect(endpointLabel(working)).toBe('Working tree');
    expect(endpointLabel(commitA)).toBe('aaaaaaa');
    expect(endpointLabel(feature)).toBe('feature/x');
  });
});

describe('shortSha', () => {
  it('takes the first 7 chars', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456');
  });
});

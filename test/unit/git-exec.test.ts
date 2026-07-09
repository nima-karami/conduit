import { describe, expect, it } from 'vitest';
import { GIT_TIMEOUT, mapWithConcurrency, runGitBin } from '../../src/git-exec';

// Use node itself as a deterministic fake "git" binary so these tests need no real git and can
// script hangs, oversize output, and exit codes precisely.
const node = process.execPath;
const cwd = process.cwd();

describe('runGitBin (node as a fake binary)', () => {
  it('returns ok + stdout on a clean exit', async () => {
    const r = await runGitBin(node, ['-e', 'process.stdout.write("hello")'], { cwd });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('hello');
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('flags a nonzero exit without throwing', async () => {
    const r = await runGitBin(node, ['-e', 'process.exit(3)'], { cwd });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.notFound).toBe(false);
  });

  it('times out and flags timedOut on a hang', async () => {
    const r = await runGitBin(node, ['-e', 'setTimeout(()=>{}, 60000)'], { cwd, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBe(false);
  });

  it('aborts and flags aborted when the signal fires', async () => {
    const ac = new AbortController();
    const p = runGitBin(node, ['-e', 'setTimeout(()=>{}, 60000)'], { cwd, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.aborted).toBe(true);
  });

  it('flags truncated when output exceeds maxBuffer', async () => {
    const r = await runGitBin(node, ['-e', 'process.stdout.write("x".repeat(5000))'], {
      cwd,
      maxBuffer: 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
  });

  it('captures stderr on a failing exit', async () => {
    const r = await runGitBin(node, ['-e', 'process.stderr.write("boom");process.exit(1)'], {
      cwd,
    });
    expect(r.ok).toBe(false);
    expect(r.stderr).toBe('boom');
  });

  it('flags notFound for a missing binary', async () => {
    const r = await runGitBin('definitely-not-a-real-binary-xyz', ['--version'], { cwd });
    expect(r.notFound).toBe(true);
  });

  it('feeds stdin when provided', async () => {
    const script =
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d.toUpperCase()))';
    const r = await runGitBin(node, ['-e', script], { cwd, stdin: 'abc' });
    expect(r.stdout).toBe('ABC');
  });

  it('exposes ordered timeout tiers', () => {
    expect(GIT_TIMEOUT.metadata).toBeLessThan(GIT_TIMEOUT.diff);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and caps in-flight count', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fn = async (n: number) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return n * 2;
    };
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, fn);
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('returns [] for an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});

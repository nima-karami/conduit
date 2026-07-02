import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  __resetHistoryGitAvailableForTest,
  assignLanes,
  classifyHistory,
  getCommitDiff,
  getHistory,
  getRangeDiff,
  parseCommits,
  parseNameStatusZ,
} from '../../src/git-history';
import type { CommitNode } from '../../src/protocol';

const RS = '\x1e';
const US = '\x1f';

/** Build one PRETTY_FORMAT record (fields US-separated, RS-prefixed) the way git emits. */
function rec(f: {
  sha: string;
  parents?: string;
  refs?: string;
  author?: string;
  email?: string;
  at?: string;
  subject?: string;
  body?: string;
}): string {
  return (
    RS +
    [
      f.sha,
      f.parents ?? '',
      f.refs ?? '',
      f.author ?? 'Ada',
      f.email ?? 'ada@example.com',
      f.at ?? '1700000000',
      f.subject ?? 'subject',
      f.body ?? '',
    ].join(US)
  );
}

describe('parseCommits', () => {
  it('parses sha/parents/author/email/date/subject across a multi-commit log', () => {
    const stdout =
      rec({ sha: 'aaa', parents: 'bbb ccc', subject: 'merge', at: '1700000001' }) +
      rec({ sha: 'bbb', parents: 'ddd', subject: 'feature work', at: '1700000002' }) +
      rec({ sha: 'ddd', parents: '', subject: 'root', at: '1700000003' });
    const commits = parseCommits(stdout);
    expect(commits.map((c) => c.sha)).toEqual(['aaa', 'bbb', 'ddd']);
    expect(commits[0].parents).toEqual(['bbb', 'ccc']);
    expect(commits[1].parents).toEqual(['ddd']);
    expect(commits[2].parents).toEqual([]); // root commit: no parents
    expect(commits[0].author).toBe('Ada');
    expect(commits[0].email).toBe('ada@example.com');
    expect(commits[0].subject).toBe('merge');
  });

  it('stores date as unix SECONDS (the raw %at value), not ms', () => {
    const commits = parseCommits(rec({ sha: 'a', at: '1700000000' }));
    expect(commits[0].date).toBe(1700000000);
  });

  it('parses refs: strips prefixes and keeps HEAD/branch/remote/tag distinction', () => {
    const stdout = rec({
      sha: 'a',
      refs: 'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0',
    });
    const refs = parseCommits(stdout)[0].refs;
    expect(refs).toContainEqual({ kind: 'head', name: 'HEAD' });
    expect(refs).toContainEqual({ kind: 'branch', name: 'main' });
    expect(refs).toContainEqual({ kind: 'remote', name: 'origin/main' });
    expect(refs).toContainEqual({ kind: 'tag', name: 'v1.0' });
  });

  it('treats a bare detached HEAD decoration as a lone head ref', () => {
    expect(parseCommits(rec({ sha: 'a', refs: 'HEAD' }))[0].refs).toEqual([
      { kind: 'head', name: 'HEAD' },
    ]);
  });

  it('keeps a multi-line body (incl. blank lines) and omits an empty body', () => {
    const multiline = parseCommits(rec({ sha: 'a', subject: 's', body: 'line1\n\nline3' }))[0];
    expect(multiline.body).toBe('line1\n\nline3');
    const empty = parseCommits(rec({ sha: 'b', body: '' }))[0];
    expect(empty.body).toBeUndefined();
  });

  it('tolerates a trailing newline/RS and skips malformed records', () => {
    const stdout = `${rec({ sha: 'a' })}\n${RS}too${US}few`;
    const commits = parseCommits(stdout);
    expect(commits).toHaveLength(1);
    expect(commits[0].sha).toBe('a');
  });
});

describe('parseNameStatusZ', () => {
  it('parses A/M/D entries as status + single path', () => {
    const stdout = 'A\0new.ts\0M\0mod.ts\0D\0gone.ts\0';
    expect(parseNameStatusZ(stdout)).toEqual([
      { status: 'A', rel: 'new.ts' },
      { status: 'M', rel: 'mod.ts' },
      { status: 'D', rel: 'gone.ts' },
    ]);
  });

  it('captures BOTH old and new paths for a rename (R) entry', () => {
    // -z rename triple: status \0 OLD \0 NEW \0 — the old path is the head/base side.
    const stdout = 'R096\0src/old-name.ts\0src/new-name.ts\0';
    expect(parseNameStatusZ(stdout)).toEqual([
      { status: 'R096', rel: 'src/new-name.ts', oldPath: 'src/old-name.ts' },
    ]);
  });

  it('captures both paths for a copy (C) entry and mixes with plain entries', () => {
    const stdout = 'M\0a.ts\0C100\0a.ts\0b.ts\0';
    expect(parseNameStatusZ(stdout)).toEqual([
      { status: 'M', rel: 'a.ts' },
      { status: 'C100', rel: 'b.ts', oldPath: 'a.ts' },
    ]);
  });
});

/** Terse CommitNode factory for hand-built topologies. */
function c(sha: string, parents: string[] = []): CommitNode {
  return { sha, parents, refs: [], author: 'a', date: 0, subject: sha };
}

describe('assignLanes', () => {
  it('places a linear chain entirely in lane 0', () => {
    const layout = assignLanes([c('a', ['b']), c('b', ['d']), c('d', [])]);
    expect(layout.rows).toEqual([
      { sha: 'a', lane: 0 },
      { sha: 'b', lane: 0 },
      { sha: 'd', lane: 0 },
    ]);
    expect(layout.laneCount).toBe(1);
    expect(layout.edges).toEqual([
      { fromSha: 'a', toSha: 'b', fromLane: 0, toLane: 0 },
      { fromSha: 'b', toSha: 'd', fromLane: 0, toLane: 0 },
    ]);
  });

  it('routes a fork+merge so the branch gets its own lane and the merge has two edges', () => {
    // Topology (newest first, date-order):
    //   M  (merge of A and B)
    //   A  -> base   (mainline)
    //   B  -> base   (side branch)
    //   base (root)
    const layout = assignLanes([
      c('M', ['A', 'B']),
      c('A', ['base']),
      c('B', ['base']),
      c('base', []),
    ]);
    const laneOf = (sha: string) => layout.rows.find((r) => r.sha === sha)?.lane;
    expect(laneOf('M')).toBe(0);
    expect(laneOf('A')).toBe(0); // first-parent mainline stays in lane 0
    expect(laneOf('B')).toBe(1); // side branch occupies a separate lane
    expect(laneOf('base')).toBe(0); // base reclaims the lowest waiting lane

    // The merge commit M emits one edge per parent, to DIFFERENT lanes.
    const mEdges = layout.edges.filter((e) => e.fromSha === 'M');
    expect(mEdges).toHaveLength(2);
    const aEdge = mEdges.find((e) => e.toSha === 'A');
    const bEdge = mEdges.find((e) => e.toSha === 'B');
    expect(aEdge).toMatchObject({ fromLane: 0, toLane: 0 }); // first parent continues lane 0
    expect(bEdge).toMatchObject({ fromLane: 0, toLane: 1 }); // second parent branches lane 1
    expect(layout.laneCount).toBe(2);

    // Both A and B converge on `base`: A keeps lane 0, B's link joins lane 0 too.
    expect(layout.edges.find((e) => e.fromSha === 'A')).toMatchObject({ toSha: 'base', toLane: 0 });
    expect(layout.edges.find((e) => e.fromSha === 'B')).toMatchObject({ toSha: 'base', toLane: 0 });
  });

  it('terminates a root commit lane (a root emits no edges)', () => {
    const layout = assignLanes([c('a', ['root']), c('root', [])]);
    expect(layout.edges.filter((e) => e.fromSha === 'root')).toHaveLength(0);
    expect(layout.laneCount).toBe(1);
  });
});

describe('classifyHistory', () => {
  it('maps a spawn failure (git missing / not-a-repo / timeout / non-zero exit) to error', () => {
    expect(classifyHistory({ kind: 'exec-error' })).toBe('error');
  });

  it('maps a clean exit with commits to ok', () => {
    expect(classifyHistory({ kind: 'exit-ok', commitCount: 1 })).toBe('ok');
    expect(classifyHistory({ kind: 'exit-ok', commitCount: 42 })).toBe('ok');
  });

  it('maps a clean exit with zero commits to empty (a valid but commit-less repo)', () => {
    expect(classifyHistory({ kind: 'exit-ok', commitCount: 0 })).toBe('empty');
  });
});

describe('getHistory (integration, this repo)', () => {
  const gitPresent = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  // Real-git integration: each spawn needs headroom under full-suite load (the 5s default is
  // starved by parallel import/transform contention; these pass fast in isolation). The timeout
  // MUST be the per-`it` 3rd arg — a `describe(..., 30_000)` 3rd arg does NOT propagate to
  // `it.runIf` tests in vitest 4, which is why this flaked at the 5s default before.
  const INTEGRATION_TIMEOUT_MS = 30_000;

  it.runIf(gitPresent)(
    'returns real commits with HEAD present and valid parent links',
    async () => {
      const { commits } = await getHistory(process.cwd(), { limit: 50 });
      expect(commits.length).toBeGreaterThan(0);
      // HEAD must be decorated on exactly the tip it points at.
      const headCommit = commits.find((cm) => cm.refs.some((r) => r.kind === 'head'));
      expect(headCommit).toBeDefined();
      // Every listed parent that is itself within this page must reference a real sha
      // (40-hex). We assert shape, not exact shas, to stay deterministic across history.
      for (const cm of commits) {
        expect(cm.sha).toMatch(/^[0-9a-f]{40}$/);
        for (const p of cm.parents) expect(p).toMatch(/^[0-9a-f]{40}$/);
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it.runIf(gitPresent)(
    'classifies a non-repo cwd as error (git log fatals), not empty',
    async () => {
      const { commits, hasMore, state } = await getHistory(os.tmpdir(), { limit: 5 });
      expect(commits).toEqual([]);
      expect(hasMore).toBe(false);
      // A not-a-git-repo cwd must surface the retry state, not the misleading "no history".
      expect(state).toBe('error');
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it.runIf(gitPresent)(
    'classifies a freshly-init repo with no commits as empty (valid repo, zero commits)',
    async () => {
      const repo = mkdtempSync(join(os.tmpdir(), 'conduit-empty-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
        const { commits, hasMore, state } = await getHistory(repo, { limit: 5 });
        expect(commits).toEqual([]);
        expect(hasMore).toBe(false);
        expect(state).toBe('empty');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

describe('diff producers: renamed-with-edits (integration, temp repo)', () => {
  const gitPresent = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  const INTEGRATION_TIMEOUT_MS = 30_000;

  let repo = '';
  let firstSha = '';
  let renameSha = '';

  const OLD_CONTENT = ['line one', 'line two', 'line three', 'line four', ''].join('\n');
  const NEW_CONTENT = ['line one', 'line two CHANGED', 'line three', 'line four', ''].join('\n');

  beforeAll(() => {
    if (!gitPresent) return;
    repo = mkdtempSync(join(os.tmpdir(), 'conduit-rename-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'old-name.ts'), OLD_CONTENT);
    git('add', '-A');
    git('commit', '-q', '-m', 'add old-name.ts');
    firstSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    git('mv', 'old-name.ts', 'new-name.ts');
    writeFileSync(join(repo, 'new-name.ts'), NEW_CONTENT);
    git('add', '-A');
    git('commit', '-q', '-m', 'rename + edit');
    renameSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    __resetHistoryGitAvailableForTest();
  });

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it.runIf(gitPresent)(
    'getCommitDiff reports a rename as its true diff (head from old path), not a 100% add',
    async () => {
      const docs = await getCommitDiff(repo, renameSha);
      const doc = docs.find((d) => d.path === 'new-name.ts');
      expect(doc).toBeDefined();
      // The head side MUST come from base:old-name.ts — a bug read base:new-name.ts (absent)
      // and produced an empty head, rendering the whole file as an all-green add.
      expect(doc?.head).toBe(OLD_CONTENT);
      expect(doc?.work).toBe(NEW_CONTENT);
      expect(doc?.head).not.toBe('');
      expect(doc?.head).not.toBe(doc?.work);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it.runIf(gitPresent)(
    'getRangeDiff (three-dot) reports a rename as its true diff across the rename',
    async () => {
      const docs = await getRangeDiff(
        repo,
        { kind: 'commit', sha: firstSha },
        { kind: 'commit', sha: renameSha },
      );
      const doc = docs.find((d) => d.path === 'new-name.ts');
      expect(doc).toBeDefined();
      expect(doc?.head).toBe(OLD_CONTENT);
      expect(doc?.work).toBe(NEW_CONTENT);
      expect(doc?.head).not.toBe('');
    },
    INTEGRATION_TIMEOUT_MS,
  );
});

describe('gitAvailable latch', () => {
  it('latches off when git is missing and short-circuits until reset', async () => {
    // A bogus git binary forces the ENOENT (not-found) path, which trips the process
    // latch so later calls never spawn. Reset afterwards so other suites aren't poisoned.
    const first = await getHistory(process.cwd(), { gitBin: 'definitely-not-git-xyz' });
    expect(first).toEqual({ commits: [], hasMore: false, state: 'error' });
    // Latched: even a valid cwd + the real binary is skipped now.
    const second = await getHistory(process.cwd(), { limit: 5 });
    expect(second).toEqual({ commits: [], hasMore: false, state: 'error' });
    __resetHistoryGitAvailableForTest();
  });
});

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBinary } from './content-search';
import { buildImageDiff } from './file-service';
import { parseBlamePorcelain } from './git-blame';
import { dotModeFor, type RefEndpoint } from './git-range';
import { mediaKindForPath } from './media-kind';
import type { BlameLine, CommitNode, FileDiffDTO, GitRef, HistoryState } from './protocol';

/**
 * Host-side git history (git-history Slice A — backend half). Mirrors `src/git-info.ts`
 * discipline: every spawn is `execFile('git', [argArray])` (never a shell string — the
 * cwd/sha can't inject), bounded by a hard timeout, NON-throwing (errors resolve to an
 * empty result and log host-side), and gated by a process `gitAvailable` latch so a
 * git-less machine never re-spawns.
 *
 * Two halves:
 *  - PURE, I/O-free, unit-tested: `parseCommits` (git-log text → CommitNode[]) and
 *    `assignLanes` (CommitNode[] → GraphLayout, the lane-assignment algorithm).
 *  - Bounded spawns: `getHistory` (git log → parsed commits + hasMore) and
 *    `getCommitDiff` (a commit's per-file FileDiffDTO, reusing the diff-viewer shape).
 *
 * The renderer never imports this module (it pulls node:child_process); the shared TYPES
 * (`CommitNode`/`GraphLayout`) live in `src/protocol.ts` so the renderer imports them
 * type-only without node.
 */

const DEFAULT_TIMEOUT_MS = 4000;
const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_LIMIT = 500;

/** Record separator + field/unit separator. Both are control chars (\x1e RS, \x1f US)
 *  that never appear in commit content, so they frame a log entry unambiguously even
 *  when a body has blank lines. */
const RS = '\x1e';
const US = '\x1f';

/**
 * The `git log` pretty-format this module parses. Field order (US-separated, after a
 * leading RS per record): %H sha · %P space-separated parents · %D decorate refs ·
 * %an author name · %ae author email · %at author unix SECONDS · %s subject · %b body.
 * `--decorate=full` yields fully-qualified ref names so prefixes are unambiguous to strip.
 */
const PRETTY_FORMAT = `format:${RS}%H${US}%P${US}%D${US}%an${US}%ae${US}%at${US}%s${US}%b`;

const LOG_BASE_ARGS = ['log', '--all', '--parents', '--date-order', '--decorate=full'];

let gitAvailable = true;

/** Test-only: reset this module's process-level gitAvailable latch between cases. Named
 *  distinctly from git-info's equivalent so the dead-code gate's duplicate-export check
 *  doesn't conflate the two independent latches. */
export function __resetHistoryGitAvailableForTest(): void {
  gitAvailable = true;
}

interface HistoryOptions {
  limit?: number;
  /** Page older than this sha (uses `<before>~1` as the log start). */
  before?: string;
  gitBin?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

type RunResult = { ok: true; stdout: string } | { ok: false; notFound: boolean };

type RunBufferResult = { ok: true; stdout: Buffer } | { ok: false; notFound: boolean };

function runGit(
  gitBin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      gitBin,
      args,
      { cwd, windowsHide: true, maxBuffer: MAX_BUFFER, timeout: timeoutMs },
      (err, stdout) => {
        if (err) {
          const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
          resolve({ ok: false, notFound });
          return;
        }
        resolve({ ok: true, stdout: stdout.toString() });
      },
    );
  });
}

/** Binary-safe git spawn (raw Buffer) for blob reads, so image bytes aren't utf8-mangled. */
function runGitBuffer(
  gitBin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunBufferResult> {
  return new Promise((resolve) => {
    execFile(
      gitBin,
      args,
      { cwd, windowsHide: true, maxBuffer: MAX_BUFFER, timeout: timeoutMs, encoding: 'buffer' },
      (err, stdout) => {
        if (err) {
          const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
          resolve({ ok: false, notFound });
          return;
        }
        resolve({ ok: true, stdout: stdout as Buffer });
      },
    );
  });
}

/**
 * Parse one `%D` decoration string into structured refs. `--decorate=full` gives e.g.
 * `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1`. We split on
 * `, `, peel a leading `HEAD -> ` (emitting a separate `head` ref), peel `tag: `, then
 * strip the `refs/heads/`/`refs/remotes/`/`refs/tags/` prefix to the human name. A bare
 * `HEAD` (detached) becomes a lone `head` ref named `HEAD`.
 */
function parseRefs(decoration: string): GitRef[] {
  const trimmed = decoration.trim();
  if (!trimmed) return [];
  const refs: GitRef[] = [];
  for (const raw of trimmed.split(',')) {
    let token = raw.trim();
    if (!token) continue;
    if (token.startsWith('HEAD -> ')) {
      refs.push({ kind: 'head', name: 'HEAD' });
      token = token.slice('HEAD -> '.length).trim();
    } else if (token === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD' });
      continue;
    }
    if (token.startsWith('tag: ')) {
      const name = token.slice('tag: '.length).replace(/^refs\/tags\//, '');
      refs.push({ kind: 'tag', name });
    } else if (token.startsWith('refs/remotes/')) {
      refs.push({ kind: 'remote', name: token.slice('refs/remotes/'.length) });
    } else if (token.startsWith('refs/heads/')) {
      refs.push({ kind: 'branch', name: token.slice('refs/heads/'.length) });
    } else if (token.startsWith('refs/tags/')) {
      refs.push({ kind: 'tag', name: token.slice('refs/tags/'.length) });
    } else if (token) {
      // An unrecognized decoration (e.g. a non-standard ref namespace) — keep it as a
      // branch-kind label rather than dropping it so nothing silently disappears.
      refs.push({ kind: 'branch', name: token });
    }
  }
  return refs;
}

/**
 * PURE. Parse `git log` output produced with `PRETTY_FORMAT` into `CommitNode[]`. Robust
 * to a leading/trailing RS, empty bodies, and multi-line bodies (the RS/US framing makes
 * blank lines in a body harmless). Malformed records (too few fields) are skipped.
 */
export function parseCommits(stdout: string): CommitNode[] {
  const commits: CommitNode[] = [];
  // Records are RS-delimited; the format prepends an RS to every record, so the first
  // split chunk is empty. Filtering empties also tolerates a trailing newline/RS.
  for (const record of stdout.split(RS)) {
    if (!record) continue;
    const fields = record.split(US);
    if (fields.length < 8) continue;
    const [sha, parentsRaw, decoration, author, email, atRaw, subject, ...bodyParts] = fields;
    if (!sha) continue;
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
    const date = Number.parseInt(atRaw, 10);
    // Body is the last field; rejoin any stray US splits and drop the trailing newline
    // git appends after %b so an empty body collapses to '' (then omitted below).
    const body = bodyParts.join(US).replace(/\n+$/, '');
    const node: CommitNode = {
      sha,
      parents,
      refs: parseRefs(decoration),
      author,
      date: Number.isFinite(date) ? date : 0,
      subject,
    };
    if (email) node.email = email;
    if (body) node.body = body;
    commits.push(node);
  }
  return commits;
}

/**
 * PURE lane assignment. Moved to the node-free `git-graph-render.ts` so the renderer can
 * re-run it over a client-side filtered commit subset (Slice B). Re-exported here so the
 * host call sites + the existing unit tests keep importing it from this module.
 */
export { assignLanes } from './git-graph-render';

/**
 * A `git log` spawn outcome, normalized for {@link classifyHistory}. `exec-error` is any
 * failure to reach a clean exit: git missing (ENOENT), a timeout/kill, OR a non-zero exit —
 * the last being how a not-a-git-repo cwd manifests (`git log` fatals with code 128). `exit-ok`
 * is a clean (exit 0) read, carrying the parsed commit count (an empty valid repo exits 0 with
 * no output when scoped by `--all`).
 */
export type HistoryOutcome = { kind: 'exec-error' } | { kind: 'exit-ok'; commitCount: number };

/**
 * PURE. Map a `git log` outcome to the 3-state status the renderer branches on. A clean exit
 * with zero commits is a genuinely EMPTY (but valid) repo — distinct from a spawn failure
 * (incl. not-a-repo), which is an ERROR the renderer surfaces with a retry rather than a
 * misleading "no history". Unit-tested so this classification is pinned without spawning git.
 */
export function classifyHistory(outcome: HistoryOutcome): HistoryState {
  if (outcome.kind === 'exec-error') return 'error';
  return outcome.commitCount > 0 ? 'ok' : 'empty';
}

/**
 * Bounded, non-throwing `git log` for the active repo across all refs. Returns parsed commits,
 * `hasMore` (over-fetching one row: `--max-count=limit+1`), and a 3-state `state` (see
 * {@link classifyHistory}) so the renderer distinguishes an empty repo from a transient
 * failure. `before` pages OLDER than that sha via `<before>~1` as the log start.
 */
export async function getHistory(
  cwd: string,
  opts: HistoryOptions = {},
): Promise<{ commits: CommitNode[]; hasMore: boolean; state: HistoryState }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gitBin = opts.gitBin ?? 'git';
  const log = opts.log ?? ((m: string) => console.error(m));
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;

  if (!gitAvailable || !cwd) {
    return { commits: [], hasMore: false, state: classifyHistory({ kind: 'exec-error' }) };
  }

  const args = [...LOG_BASE_ARGS, `--max-count=${limit + 1}`, `--pretty=${PRETTY_FORMAT}`];
  // `before` only narrows the start ref; `--all` still scopes to reachable refs. Append
  // it as a positional revision after the flags so it pages from older history.
  if (opts.before) args.push(`${opts.before}~1`);

  const res = await runGit(gitBin, args, cwd, timeoutMs);
  if (!res.ok) {
    if (res.notFound) {
      gitAvailable = false;
      log('[git-history] git not found on PATH — disabling history for this process');
    }
    return { commits: [], hasMore: false, state: classifyHistory({ kind: 'exec-error' }) };
  }

  const parsed = parseCommits(res.stdout);
  const hasMore = parsed.length > limit;
  const commits = hasMore ? parsed.slice(0, limit) : parsed;
  return {
    commits,
    hasMore,
    state: classifyHistory({ kind: 'exit-ok', commitCount: commits.length }),
  };
}

/** A changed path in a commit, from `git diff-tree --name-status`. */
interface ChangedFile {
  status: string;
  /** New path in the worktree (for media-kind detection + the DTO `path`). */
  rel: string;
  /** For an R (rename) / C (copy) entry: the pre-rename path. The head/base side must be
   *  read from HERE, not `rel`, or the diff reads as a 100% add (the new path is absent at
   *  base → empty head). Undefined for A/M/D. */
  oldPath?: string;
}

/** Parse `git diff-tree -r --name-status -z` NUL-delimited output into changed files.
 *  -z emits `STATUS\0PATH\0` for adds/mods/dels and `R100\0OLD\0NEW\0` for renames. */
export function parseNameStatusZ(stdout: string): ChangedFile[] {
  const parts = stdout.split('\0').filter((p) => p.length > 0);
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      if (newPath) files.push({ status, rel: newPath, oldPath });
    } else {
      const p = parts[i++];
      if (p) files.push({ status, rel: p });
    }
  }
  return files;
}

interface CommitDiffOptions {
  gitBin?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Produce the per-file diff for a commit, reusing the diff-viewer's `FileDiffDTO` shape
 * (the same producer the Changes tab uses — `readDiff`/`buildImageDiff` in
 * src/file-service.ts). `head` is the FIRST-PARENT blob, `work` is the commit's blob (so
 * the viewer's head→work framing reads "before → after this commit"). Semantics:
 *  - normal commit: diff `<sha>^` → `<sha>` (against first parent).
 *  - merge commit (≥2 parents): diff against the FIRST parent (caller labels it).
 *  - root commit (no parent): the empty tree is the base, so every file is an add.
 * Bounded + non-throwing: any failure yields `[]`.
 */
export async function getCommitDiff(
  cwd: string,
  sha: string,
  opts: CommitDiffOptions = {},
): Promise<FileDiffDTO[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gitBin = opts.gitBin ?? 'git';
  const log = opts.log ?? ((m: string) => console.error(m));

  if (!gitAvailable || !cwd || !sha) return [];

  // Resolve parents via `<sha>^@` (lists all parent shas; empty for a root commit). Not
  // `--verify` — that rejects the multi-revision `^@` form. Keep only 40-hex lines so a
  // bad sha (which echoes the literal `<sha>^@`) yields no parents → empty-tree base.
  const parentRes = await runGit(gitBin, ['rev-parse', `${sha}^@`], cwd, timeoutMs);
  if (!parentRes.ok && parentRes.notFound) {
    gitAvailable = false;
    log('[git-history] git not found on PATH — disabling history for this process');
    return [];
  }
  const parents = parentRes.ok
    ? parentRes.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{40}$/.test(l))
    : [];
  // Empty-tree hash: git's well-known SHA for an empty tree, the base for a root commit.
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const base = parents[0] ?? EMPTY_TREE;

  const nameStatus = await runGit(
    gitBin,
    ['diff-tree', '-M', '-r', '--no-commit-id', '--name-status', '-z', base, sha],
    cwd,
    timeoutMs,
  );
  if (!nameStatus.ok) return [];
  const changed = parseNameStatusZ(nameStatus.stdout);

  const showBlob = async (rev: string, rel: string): Promise<Buffer | null> => {
    const res = await runGitBuffer(gitBin, ['show', `${rev}:${rel}`], cwd, timeoutMs);
    return res.ok ? res.stdout : null;
  };

  const docs: FileDiffDTO[] = [];
  for (const file of changed) {
    const isDeleted = file.status.startsWith('D');
    const isAdded = file.status.startsWith('A');
    const headBuf = isAdded ? null : await showBlob(base, file.oldPath ?? file.rel);
    const workBuf = isDeleted ? null : await showBlob(sha, file.rel);

    if (mediaKindForPath(file.rel) === 'image') {
      docs.push(buildImageDiff(file.rel, workBuf, headBuf));
      continue;
    }
    const headBinary = headBuf != null && isBinary(headBuf);
    const workBinary = workBuf != null && isBinary(workBuf);
    const binary = headBinary || workBinary;
    docs.push({
      path: file.rel,
      head: binary || !headBuf ? '' : headBuf.toString('utf8'),
      work: binary || !workBuf ? '' : workBuf.toString('utf8'),
      binary,
    });
  }
  return docs;
}

interface BlameOptions {
  gitBin?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Bounded, non-throwing `git blame --porcelain` for one tracked file (git-blame). `relPath` is
 * relative to `cwd` and passed after `--` so an option-like name can't be misread; the caller
 * (electron/main.ts) has already asserted it is inside the repo root + tracked. Any failure
 * (untracked/binary/new file, timeout, not-a-repo) resolves to `[]` — the UI treats an empty
 * result as a no-op. Mirrors {@link getHistory}'s spawn discipline + `gitAvailable` latch.
 */
export async function getBlame(
  cwd: string,
  relPath: string,
  opts: BlameOptions = {},
): Promise<BlameLine[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gitBin = opts.gitBin ?? 'git';
  const log = opts.log ?? ((m: string) => console.error(m));
  if (!gitAvailable || !cwd || !relPath) return [];

  const res = await runGit(gitBin, ['blame', '--porcelain', '--', relPath], cwd, timeoutMs);
  if (!res.ok) {
    if (res.notFound) {
      gitAvailable = false;
      log('[git-history] git not found on PATH — disabling history for this process');
    }
    return [];
  }
  return parseBlamePorcelain(res.stdout);
}

/** A committish endpoint's git rev string (branch/remote/tag ref or sha). Working tree has none.
 *  git resolves a remote ref ("origin/main") or a tag as a committish for merge-base/diff/show. */
function refStr(ep: RefEndpoint): string {
  return ep.kind === 'branch' || ep.kind === 'tag' ? ep.ref : ep.kind === 'commit' ? ep.sha : '';
}

/**
 * Per-file diff for a comparison between two refs (spec 2026-06-29-review-changes-polish item 4).
 * Mirrors {@link getCommitDiff}'s FileDiffDTO production; the only new wrinkle is the two-dot
 * "ref ↔ working tree" mode, whose `work` side is read from disk rather than `git show`.
 *
 * Modes (see pure `dotModeFor`): both committish → three-dot `A...B` (diff merge-base→B; falls
 * back to two-dot `A..B` when there is no common ancestor, Decision D5); committish base +
 * working head → `git diff <base>` (tracked working-tree changes; untracked excluded, D8).
 * Caller (electron/main.ts) validates both endpoints against the host's own ref set first — the
 * renderer's strings never reach git unchecked.
 */
export async function getRangeDiff(
  cwd: string,
  base: RefEndpoint,
  head: RefEndpoint,
  opts: CommitDiffOptions = {},
): Promise<FileDiffDTO[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gitBin = opts.gitBin ?? 'git';
  const mode = dotModeFor(base, head);
  if (!gitAvailable || !cwd || mode === 'working') return [];

  const baseRef = refStr(base);
  let baseRev = baseRef;
  let nameStatus: Awaited<ReturnType<typeof runGit>>;

  if (mode === 'three') {
    const headRev = refStr(head);
    const mb = await runGit(gitBin, ['merge-base', baseRef, headRev], cwd, timeoutMs);
    // No common ancestor (unrelated histories) → fall back to a direct two-dot diff (D5).
    baseRev = mb.ok && /^[0-9a-f]{40}$/.test(mb.stdout.trim()) ? mb.stdout.trim() : baseRef;
    nameStatus = await runGit(
      gitBin,
      ['diff', '--name-status', '-z', baseRev, headRev],
      cwd,
      timeoutMs,
    );
  } else {
    // mode === 'two': committish base ↔ working tree.
    nameStatus = await runGit(gitBin, ['diff', '--name-status', '-z', baseRev], cwd, timeoutMs);
  }
  if (!nameStatus.ok) return [];
  const changed = parseNameStatusZ(nameStatus.stdout);

  const showBlob = async (rev: string, rel: string): Promise<Buffer | null> => {
    const res = await runGitBuffer(gitBin, ['show', `${rev}:${rel}`], cwd, timeoutMs);
    return res.ok ? res.stdout : null;
  };
  const readWork = async (rel: string): Promise<Buffer | null> => {
    try {
      return await readFile(join(cwd, rel));
    } catch {
      return null;
    }
  };

  const docs: FileDiffDTO[] = [];
  for (const file of changed) {
    const isDeleted = file.status.startsWith('D');
    const isAdded = file.status.startsWith('A');
    const headBuf = isAdded ? null : await showBlob(baseRev, file.oldPath ?? file.rel);
    const workBuf = isDeleted
      ? null
      : mode === 'two'
        ? await readWork(file.rel)
        : await showBlob(refStr(head), file.rel);

    if (mediaKindForPath(file.rel) === 'image') {
      docs.push(buildImageDiff(file.rel, workBuf, headBuf));
      continue;
    }
    const binary = (headBuf != null && isBinary(headBuf)) || (workBuf != null && isBinary(workBuf));
    docs.push({
      path: file.rel,
      head: binary || !headBuf ? '' : headBuf.toString('utf8'),
      work: binary || !workBuf ? '' : workBuf.toString('utf8'),
      binary,
    });
  }
  return docs;
}

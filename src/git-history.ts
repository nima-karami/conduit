import { execFile } from 'node:child_process';
import { isBinary } from './content-search';
import { buildImageDiff } from './file-service';
import { mediaKindForPath } from './media-kind';
import type { CommitNode, FileDiffDTO, GitRef, GraphEdge, GraphLayout, GraphRow } from './protocol';

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
 * PURE. Assign each commit (in the given `--date-order` order) to a lane and produce
 * parent edges, the standard commit-graph algorithm:
 *
 *  - `lanes[i]` holds the sha each active lane is currently *waiting for* (a pending
 *    child→parent reservation). A commit takes the lowest lane reserved for it, or a new
 *    lane if none is.
 *  - Its FIRST parent continues the commit's own lane (the mainline stays straight).
 *  - Each ADDITIONAL parent (a merge) reuses an existing lane already waiting for that
 *    parent, else opens a new lane — yielding ≥2 outgoing edges for a merge commit.
 *  - A lane whose reservation isn't re-established by any parent is freed (tip / root).
 *
 * Deterministic: lowest-index lane always wins. `laneCount` is the max lane ever used.
 */
export function assignLanes(commits: CommitNode[]): GraphLayout {
  const rows: GraphRow[] = [];
  const edges: GraphEdge[] = [];
  // Active lanes; an entry is the sha that lane is waiting to place next, or null = free.
  const lanes: (string | null)[] = [];
  let laneCount = 0;

  const claimLane = (sha: string): number => {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) {
        lanes[i] = sha;
        return i;
      }
    }
    lanes.push(sha);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    // Place this commit in the lowest lane reserved for it; if none, open a fresh lane.
    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) lane = claimLane(commit.sha);
    // This lane's reservation is consumed by placing the commit; clear it, then let the
    // commit's parents re-establish reservations below.
    lanes[lane] = null;
    rows.push({ sha: commit.sha, lane });
    if (lane + 1 > laneCount) laneCount = lane + 1;

    commit.parents.forEach((parent, idx) => {
      let toLane: number;
      if (idx === 0) {
        // First parent continues this commit's lane (mainline stays straight) — unless
        // another lane is ALREADY waiting for this same parent (two children of one
        // commit), in which case join that existing lane to avoid a duplicate.
        const existing = lanes.indexOf(parent);
        if (existing !== -1) {
          toLane = existing;
        } else {
          lanes[lane] = parent;
          toLane = lane;
        }
      } else {
        // Merge parent: reuse a lane already awaiting it, else branch a new lane.
        const existing = lanes.indexOf(parent);
        toLane = existing !== -1 ? existing : claimLane(parent);
      }
      if (toLane + 1 > laneCount) laneCount = toLane + 1;
      edges.push({ fromSha: commit.sha, toSha: parent, fromLane: lane, toLane });
    });
  }

  return { rows, edges, laneCount };
}

/**
 * Bounded, non-throwing `git log` for the active repo across all refs. Returns parsed
 * commits plus `hasMore` (computed by over-fetching one row: `--max-count=limit+1`). On
 * timeout / not-a-repo / error resolves to `{ commits: [], hasMore: false }` and logs.
 * `before` pages OLDER than that sha via `<before>~1` as the log start.
 */
export async function getHistory(
  cwd: string,
  opts: HistoryOptions = {},
): Promise<{ commits: CommitNode[]; hasMore: boolean }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gitBin = opts.gitBin ?? 'git';
  const log = opts.log ?? ((m: string) => console.error(m));
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;

  if (!gitAvailable || !cwd) return { commits: [], hasMore: false };

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
    return { commits: [], hasMore: false };
  }

  const parsed = parseCommits(res.stdout);
  const hasMore = parsed.length > limit;
  return { commits: hasMore ? parsed.slice(0, limit) : parsed, hasMore };
}

/** A changed path in a commit, from `git diff-tree --name-status`. */
interface ChangedFile {
  status: string;
  /** Absolute path in the worktree (for media-kind detection + the DTO `path`). */
  rel: string;
}

/** Parse `git diff-tree -r --name-status -z` NUL-delimited output into changed files.
 *  -z emits `STATUS\0PATH\0` for adds/mods/dels and `R100\0OLD\0NEW\0` for renames. */
function parseNameStatusZ(stdout: string): ChangedFile[] {
  const parts = stdout.split('\0').filter((p) => p.length > 0);
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++];
    if (status.startsWith('R') || status.startsWith('C')) {
      // rename/copy: status, old path, new path — report the new path.
      i++; // skip old path
      const newPath = parts[i++];
      if (newPath) files.push({ status, rel: newPath });
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
    ['diff-tree', '-r', '--no-commit-id', '--name-status', '-z', base, sha],
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
    const headBuf = isAdded ? null : await showBlob(base, file.rel);
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

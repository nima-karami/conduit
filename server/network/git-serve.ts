import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  FsErrorCode,
  GitResult,
  LinkFrame,
  LinkState,
} from '../../src/contracts/link-protocol';
import { readDiffReply } from '../../src/file-service';
import { GIT_TIMEOUT, runGit } from '../../src/git-exec';
import { assignLanes } from '../../src/git-graph-render';
import { getCommitDiff, getHistory } from '../../src/git-history';
import { createGitShow } from '../../src/git-show';
import { confineFsPath } from '../../src/network/fs-confine';
import { isDenied } from '../../src/network/fs-deny';
import type { LinkRecord } from '../../src/network/link-file';
import { isInsideAnyRealRoot, isInsideRoot, realPathLeaf } from '../../src/path-guard';
import { type RepoRead, readRepoChanges } from '../../src/project-info';
import type { FileDiffDTO } from '../../src/protocol';
import type { AuditSink } from './audit-log';
import { isInboundSsh } from './calls';
import { FS_REFUSAL_AUDIT_MS } from './fs-serve';

// B serves git reads to its ssh controller (CON-45 plan decisions 1-3). As fs-serve does: the root,
// the repo git will read, the diff path and every entry shown are confined and deny-filtered here,
// and a refusal runs no git.

export type GitServeFrame = Extract<LinkFrame, { t: 'git.req' }>;

/** The whole encoded `git.res` result. The frame limit is 16 MiB; this leaves the envelope room. */
const ENCODED_RESULT_MAX = 8 * 1024 * 1024;
/** A `log` request that names no page size gets this many commits. */
const LOG_DEFAULT_LIMIT = 100;

/**
 * The git reads this service serves. Production uses `createGitOps()`; tests wrap these to count
 * spawns. Every op after `repoTopLevel` takes the top the service has already checked, so git never
 * recomputes a top from a path the peer named.
 */
export interface GitServeOps {
  /** The repo top level for a directory; '' when it is not in a repo. */
  repoTopLevel(dir: string): Promise<string>;
  /** The git dir git resolves for `dir` (a `.git` file is followed); '' on failure. */
  absoluteGitDir(dir: string): Promise<string>;
  /** The common git dir for `dir`, absolute; '' on failure. */
  gitCommonDir(dir: string): Promise<string>;
  status(top: string): Promise<RepoRead>;
  diff(top: string, absPath: string): Promise<FileDiffDTO>;
  log(
    top: string,
    opts: { limit: number; before: string | undefined },
  ): ReturnType<typeof getHistory>;
  show(top: string, sha: string): ReturnType<typeof getCommitDiff>;
}

/** The production git reads; every one of them spawns through runGit (src/git-exec.ts). */
export function createGitOps(): GitServeOps {
  const gitShow = createGitShow();
  const revParse = async (dir: string, arg: string): Promise<string> => {
    const r = await runGit(['rev-parse', arg], { cwd: dir, timeoutMs: GIT_TIMEOUT.metadata });
    return r.ok ? path.resolve(dir, r.stdout.trim()) : '';
  };
  return {
    repoTopLevel: gitShow.repoTopLevel,
    absoluteGitDir: (dir) => revParse(dir, '--absolute-git-dir'),
    gitCommonDir: (dir) => revParse(dir, '--git-common-dir'),
    status: (top) => readRepoChanges(top, { lines: true }),
    diff: (top, absPath) =>
      readDiffReply(
        absPath,
        (p, ref) => gitShow.gitShowIn(top, p, ref),
        (p, ref) => gitShow.gitShowBufferIn(top, p, ref),
        {},
      ),
    log: (top, opts) => getHistory(top, opts),
    show: (top, sha) => getCommitDiff(top, sha),
  };
}

export interface GitServeDeps {
  /** My record of the link to a machine; only an inbound ssh record is served. */
  linkOf(machineId: string): LinkRecord | null;
  /** The link's state now; a request is served only while the link is up or degraded. */
  linkState(machineId: string): LinkState | null;
  /** Home and roots of a session on this machine, or null when there is no such session. */
  sessionRoots(sessionId: string): readonly string[] | null;
  git: GitServeOps;
  send(machineId: string, frame: LinkFrame): void;
  audit: AuditSink;
  now(): number;
}

export interface GitServe {
  /** Serves one git.req from a link and always answers it. Never throws. */
  onFrame(machineId: string, frame: GitServeFrame): Promise<void>;
}

type Reply = { ok: true; result: GitResult } | { ok: false; code: FsErrorCode; message: string };

/** Where a folder's repo is: none, refused, unreadable, or a top the session may read. */
type Located =
  | { kind: 'none' }
  | { kind: 'repo'; top: string }
  | { kind: 'refused' }
  | { kind: 'failed' };

const NOT_SERVED = 'that path is not served';
const NOT_FOUND = 'no such file or folder';
const NO_SESSION = 'no such session on this machine';
const NOT_A_REPO = 'that folder is not in a git repository';
const REPO_OUTSIDE = 'the git repository reaches outside the session folders';
const STATUS_FAILED = 'git could not read the changes';
const DIFF_FAILED = 'the diff could not be read';
const SHOW_FAILED = 'the commit could not be read';
const FAILED = 'git could not read the repository';

const isLive = (state: LinkState | null): boolean => state === 'up' || state === 'degraded';

const refusedReply: Reply = { ok: false, code: 'refused', message: NOT_SERVED };
const repoRefusedReply: Reply = { ok: false, code: 'refused', message: REPO_OUTSIDE };
const failedReply = (message: string): Reply => ({ ok: false, code: 'failed', message });

/** A path a listing or a commit would name: denied when its own text is, as fs-serve's lists are. */
const deniedUnder = (dir: string, rel: string): boolean => isDenied(path.join(dir, rel));

/** git's own back-link from a linked worktree's admin dir to its `.git` file; null when absent. */
async function readBackLink(file: string): Promise<string | null> {
  try {
    return (await fs.promises.readFile(file, 'utf8')).trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Whether the git dir and common dir git would read for `top` are the session's own. A `.git` file
 * may name any directory, so the dirs must sit inside the session folders, or be a linked worktree
 * whose admin dir points straight back at this top (a worktree's common dir may lie elsewhere).
 */
async function ownsGitDir(
  top: string,
  gitDir: string,
  commonDir: string,
  roots: readonly string[],
): Promise<boolean> {
  if (isInsideAnyRealRoot(gitDir, roots) && isInsideAnyRealRoot(commonDir, roots)) return true;
  // Only an admin dir directly under `<common>/worktrees` can be a worktree's; anything else is a
  // foreign repo whose back-link a peer could not have written without reaching outside.
  if (realPathLeaf(path.dirname(gitDir)) !== realPathLeaf(path.join(commonDir, 'worktrees'))) {
    return false;
  }
  const back = await readBackLink(path.join(gitDir, 'gitdir'));
  if (back === null) return false;
  return realPathLeaf(path.resolve(gitDir, back)) === realPathLeaf(path.join(top, '.git'));
}

export function createGitServe(deps: GitServeDeps): GitServe {
  /** The last `fs.refused` audit per link, so a flood of refusals audits once per window. */
  const lastRefusal = new Map<string, number>();

  const refuse = (machineId: string, reason: string): void => {
    const at = deps.now();
    const last = lastRefusal.get(machineId);
    if (last !== undefined && at - last < FS_REFUSAL_AUDIT_MS) return;
    lastRefusal.set(machineId, at);
    deps.audit.record({ kind: 'fs.refused', peer: machineId, detail: { reason } });
  };

  const servable = (machineId: string): boolean =>
    isInboundSsh(deps.linkOf(machineId)) && isLive(deps.linkState(machineId));

  /**
   * The repo a confined folder belongs to, checked before any git op runs there. Its top must sit
   * inside the session, and the git dir and common dir git would read must be the session's own.
   */
  const locate = async (
    machineId: string,
    folder: string,
    roots: readonly string[],
  ): Promise<Located> => {
    const top = await deps.git.repoTopLevel(folder);
    if (top === '') return { kind: 'none' };
    // A repo whose top sits above the session folder would expose its sibling folders, so it is refused whole.
    if (!isInsideAnyRealRoot(top, roots)) {
      refuse(machineId, 'repo_outside_session');
      return { kind: 'refused' };
    }
    const gitDir = await deps.git.absoluteGitDir(folder);
    const commonDir = await deps.git.gitCommonDir(folder);
    if (gitDir === '' || commonDir === '') return { kind: 'failed' };
    if (!(await ownsGitDir(top, gitDir, commonDir, roots))) {
      refuse(machineId, 'git_dir_outside');
      return { kind: 'refused' };
    }
    return { kind: 'repo', top };
  };

  /** The diff of one file: its path must sit inside the checked top as well as the session folders. */
  const diffOf = async (
    machineId: string,
    frame: GitServeFrame,
    roots: readonly string[],
    top: string,
  ): Promise<Reply> => {
    const wanted = frame.args.path;
    if (wanted === undefined) return failedReply(DIFF_FAILED);
    // A deleted file is still diffed against HEAD, so its missing leaf must be allowed through.
    const file = await confineFsPath(wanted, roots, { allowMissing: true });
    if (!file.ok) {
      if (file.code === 'refused') {
        refuse(machineId, 'path');
        return refusedReply;
      }
      return { ok: false, code: 'not_found', message: NOT_FOUND };
    }
    // Denial is checked on both spellings: the name the peer sent and the file it resolves to.
    if (isDenied(wanted) || isDenied(file.real) || !isInsideRoot(file.real, realPathLeaf(top))) {
      refuse(machineId, 'path');
      return refusedReply;
    }
    const dto = await deps.git.diff(top, file.real);
    // The raw message of a read error can carry file content; the code alone is what the peer gets.
    if (dto.error !== undefined) return failedReply(DIFF_FAILED);
    return { ok: true, result: { op: 'diff', file: { ...dto, path: wanted } } };
  };

  const statusOf = async (top: string): Promise<Reply> => {
    const read = await deps.git.status(top);
    if (!read.ok) return failedReply(STATUS_FAILED);
    // An entry names a path too: a rename out of a denied name is hidden with the denied file.
    const changes = read.changes.filter(
      (c) =>
        !deniedUnder(top, c.path) && (c.origPath === undefined || !deniedUnder(top, c.origPath)),
    );
    return {
      ok: true,
      result: {
        op: 'status',
        root: top,
        snapshot: { changes, lines: true, refreshedAt: deps.now() },
      },
    };
  };

  const logOf = async (frame: GitServeFrame, top: string): Promise<Reply> => {
    const { commits, hasMore, state } = await deps.git.log(top, {
      limit: frame.args.limit ?? LOG_DEFAULT_LIMIT,
      before: frame.args.before,
    });
    return {
      ok: true,
      result: { op: 'log', commits, layout: assignLanes(commits), hasMore, state },
    };
  };

  const showOf = async (frame: GitServeFrame, top: string): Promise<Reply> => {
    const sha = frame.args.sha;
    if (sha === undefined) return failedReply(SHOW_FAILED);
    const shown = await deps.git.show(top, sha);
    if (shown.error !== undefined) return failedReply(SHOW_FAILED);
    // A renamed file's head side is its old path's blob, so the old name is checked as well.
    const files = shown.files.filter((f) => {
      const from = shown.renamedFrom?.[f.path];
      return !deniedUnder(top, f.path) && (from === undefined || !deniedUnder(top, from));
    });
    return {
      ok: true,
      result: { op: 'show', files, truncated: shown.truncated !== undefined },
    };
  };

  /** One request, answered with a Reply. A throw here is caught by the caller and answered as failed. */
  const serve = async (machineId: string, frame: GitServeFrame): Promise<Reply> => {
    if (!servable(machineId)) {
      refuse(machineId, 'not_controller');
      return refusedReply;
    }
    const roots = deps.sessionRoots(frame.sessionId);
    if (roots === null) return { ok: false, code: 'not_found', message: NO_SESSION };
    const root = await confineFsPath(frame.root, roots);
    if (!root.ok) {
      if (root.code === 'refused') {
        refuse(machineId, 'path');
        return refusedReply;
      }
      return { ok: false, code: 'not_found', message: NOT_FOUND };
    }
    const located = await locate(machineId, root.real, roots);
    switch (located.kind) {
      case 'refused':
        return repoRefusedReply;
      case 'failed':
        return failedReply(FAILED);
      case 'none':
        // A folder in no repo has no changes to list: status answers that, the other reads cannot.
        if (frame.op === 'status')
          return { ok: true, result: { op: 'status', root: frame.root, snapshot: null } };
        return failedReply(NOT_A_REPO);
      case 'repo':
        break;
    }
    const { top } = located;
    switch (frame.op) {
      case 'status':
        return statusOf(top);
      case 'diff':
        return diffOf(machineId, frame, roots, top);
      case 'log':
        return logOf(frame, top);
      case 'show':
        return showOf(frame, top);
    }
  };

  const errorReply = (err: unknown): Reply => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: false, code: 'not_found', message: NOT_FOUND };
    return failedReply(FAILED);
  };

  return {
    async onFrame(machineId, frame) {
      let answer: Reply;
      try {
        answer = await serve(machineId, frame);
      } catch (err) {
        answer = errorReply(err);
      }
      if (answer.ok && JSON.stringify(answer.result).length > ENCODED_RESULT_MAX)
        answer = { ok: false, code: 'too_large', message: 'the result is over 8 MiB' };
      deps.send(
        machineId,
        answer.ok
          ? { t: 'git.res', id: frame.id, ok: true, result: answer.result }
          : {
              t: 'git.res',
              id: frame.id,
              ok: false,
              error: { code: answer.code, message: answer.message },
            },
      );
    },
  };
}

import type { GitOp } from '../src/git-actions';

/**
 * An action the Changes tab can request. `discardAll` is a renderer-only intent
 * (no single git op — the handler fans it out / confirms); every other value is a
 * real host GitOp. `path` is omitted for bulk ops.
 */
export type IntentOp = GitOp | 'discardAll';

/** One repo of a fan-out. `paths` limits the op to exactly those repo-relative paths; absent =
 *  the whole repo. */
export interface BulkTarget {
  root: string;
  paths?: string[];
}

/** `targets` (a fan-out, only with `stageAll`/`unstageAll`) and `repoRoot` are exclusive;
 *  neither means the session's active repo. `paths` (bulk ops only) is `BulkTarget.paths` for
 *  the one repo. */
export type GitActionIntent = {
  op: IntentOp;
  path?: string;
  repoRoot?: string;
  paths?: string[];
  targets?: BulkTarget[];
};

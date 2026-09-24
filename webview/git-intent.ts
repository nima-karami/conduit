import type { GitOp } from '../src/git-actions';

/**
 * An action the Changes tab can request. `discardAll` is a renderer-only intent
 * (no single git op — the handler fans it out / confirms); every other value is a
 * real host GitOp. `path` is omitted for bulk ops.
 */
export type IntentOp = GitOp | 'discardAll';
/** `repoRoots` (a fan-out, only with `stageAll`/`unstageAll`) and `repoRoot` are exclusive;
 *  neither means the session's active repo. */
export type GitActionIntent = {
  op: IntentOp;
  path?: string;
  repoRoot?: string;
  repoRoots?: string[];
};

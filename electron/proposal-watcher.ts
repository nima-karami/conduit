// Host-side live watcher for a project's `.conduit/*.proposed.json` siblings (N1). When an
// agent writes (or the app accepts/rejects) a proposal, this debounces the FS events and
// invokes a callback with the affected kind so the open board/canvas can refresh its
// proposal banner + diff live. Shares the fs.watch/debounce plumbing with BoardWatcher via
// ConduitDirWatch. See docs/adr/0002-conduit-artifact-format.md §3.

import { ConduitDirWatch } from './conduit-dir-watch';
import { PROPOSAL_FILE_NAMES, type ProposalKind } from './conduit-fs';

/** Called with the kind whose proposal changed (appeared / edited / deleted). */
export type OnProposalChange = (kind: ProposalKind) => void;

/** Map a watched proposal filename back to its kind. */
const KIND_FOR_FILE: Record<string, ProposalKind> = {
  'board.proposed.json': 'board',
  'architecture.proposed.json': 'architecture',
};

/**
 * Watches one project's `.conduit/` for the two `*.proposed.json` siblings, debounces, and
 * fires the callback with each changed kind on settle. Unlike the board watcher there is no
 * self-echo suppression: proposals are written by an external agent (not the app), and the
 * app's own accept/reject DELETES the proposal — itself a change the renderer should hear
 * about (to clear the banner).
 */
export class ProposalWatcher {
  private readonly watch_: ConduitDirWatch;
  private pendingKinds = new Set<ProposalKind>();
  private onChange: OnProposalChange | null = null;

  constructor(debounceMs = 250) {
    this.watch_ = new ConduitDirWatch(debounceMs, 'proposal-watcher');
  }

  /** Start watching `<projectRoot>/.conduit/`; replaces any prior watch. */
  watch(projectRoot: string, onChange: OnProposalChange): void {
    this.stop();
    if (!projectRoot) return;
    this.onChange = onChange;
    this.watch_.start(
      projectRoot,
      (filename) => {
        // `filename` can be null on some platforms; react to any proposal kind then.
        if (filename && !PROPOSAL_FILE_NAMES.includes(filename)) return false; // unrelated file
        if (filename && KIND_FOR_FILE[filename]) {
          this.pendingKinds.add(KIND_FOR_FILE[filename]);
        } else {
          // Unknown filename (null on this platform): conservatively flag both kinds.
          for (const k of Object.values(KIND_FOR_FILE)) this.pendingKinds.add(k);
        }
        return true;
      },
      () => {
        const cb = this.onChange;
        if (!cb) return;
        const kinds = [...this.pendingKinds];
        this.pendingKinds.clear();
        for (const kind of kinds) cb(kind);
      },
    );
  }

  stop(): void {
    this.watch_.stop();
    this.pendingKinds.clear();
    this.onChange = null;
  }
}

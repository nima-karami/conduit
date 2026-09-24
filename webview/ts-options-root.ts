import { folderKey } from '../src/folder-key';
import type { TsconfigDTO } from '../src/tsconfig-map';

/**
 * Monaco has ONE compiler-options set, so it follows the active session's home (spec D8): each
 * root's seq-0 tsconfig is cached, and only the options root's is ever applied. A plain
 * "first chunk wins" rule let an attached folder's tsconfig, or a previous session's, stick.
 */
export class CompilerOptionsRoot {
  private readonly known = new Map<string, TsconfigDTO | undefined>();
  private rootKey: string | undefined;

  constructor(private readonly apply: (tsconfig: TsconfigDTO | undefined) => void) {}

  /** Caches the root's tsconfig (undefined = none, still "known"); applies iff it is the
   *  options root. */
  noteChunk(root: string, tsconfig: TsconfigDTO | undefined): void {
    const key = folderKey(root);
    this.known.set(key, tsconfig);
    if (key === this.rootKey) this.apply(tsconfig);
  }

  /** Applies the new root's cached tsconfig when known; undefined applies nothing. */
  setRoot(root: string | undefined): void {
    this.rootKey = root === undefined ? undefined : folderKey(root);
    if (this.rootKey !== undefined && this.known.has(this.rootKey)) {
      this.apply(this.known.get(this.rootKey));
    }
  }
}

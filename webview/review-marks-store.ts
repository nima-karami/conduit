import type { ReviewMark, ReviewMarksRepo } from '../src/protocol';
import { applyMarksPush, normalizeRoot, setMarkList } from '../src/review-marks';
import { post, subscribe } from './bridge';

/**
 * Renderer mirror of the host's reviewed marks (spec 2026-08-27-review-supercharge §2 Lane B).
 * A module-singleton external store, mirroring dirty-store.ts: the Review view reads it with
 * useSyncExternalStore, and the host stays the single owner of the file.
 *
 * `loaded` is the LOAD GATE (§4): every mark control is disabled until the first push lands, so a
 * click during startup can't be silently dropped or overwritten by the snapshot that follows.
 */

export interface MarksSnapshot {
  loaded: boolean;
  byRoot: ReadonlyMap<string, readonly ReviewMark[]>;
}

type Listener = () => void;

let snapshot: MarksSnapshot = { loaded: false, byRoot: new Map() };
const listeners = new Set<Listener>();

function apply(repos: readonly ReviewMarksRepo[]): void {
  snapshot = { loaded: true, byRoot: applyMarksPush(snapshot.byRoot, repos) };
  listeners.forEach((l) => {
    l();
  });
}

subscribe((msg) => {
  if (msg.type === 'review:marks') apply(msg.repos);
});

export function subscribeMarks(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getMarksSnapshot(): MarksSnapshot {
  return snapshot;
}

/**
 * Toggle one mark. Applied locally first so the checkbox answers the click in the same frame; the
 * host's echo replaces the optimistic list a tick later and wins any cross-window race.
 */
export function setReviewMark(root: string, mark: ReviewMark, on: boolean): void {
  const key = normalizeRoot(root);
  apply([{ root: key, marks: setMarkList(snapshot.byRoot.get(key) ?? [], mark, on) }]);
  post({ type: 'review:setMark', root: key, mark, on });
}

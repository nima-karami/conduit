import type { ReviewSource } from './docs';
import type { ReviewFile } from './review-repos';

export interface ReviewNavGroup {
  root: string;
  name: string;
  sub?: string;
  files: readonly ReviewFile[];
  reviewed: number;
}

export interface ReviewNavModel {
  source: ReviewSource | undefined;
  files: readonly ReviewFile[];
  groups: readonly ReviewNavGroup[] | null;
  /** null = All repos. */
  repoRoot: string | null;
  repoCount: number;
  totalCount: number;
  activeKey: string | null;
  /** `reviewFileKey`s, never bare paths. */
  reviewed: ReadonlySet<string>;
  canMark: (file: ReviewFile) => boolean;
  filter: string;
  onPick: (file: ReviewFile) => void;
  onToggleReviewed: (file: ReviewFile) => void;
  onFilter: (text: string) => void;
}

type Listener = () => void;

let model: ReviewNavModel | null = null;
const listeners = new Set<Listener>();

export function publishReviewNav(next: ReviewNavModel | null): void {
  if (next === model) return;
  model = next;
  listeners.forEach((l) => {
    l();
  });
}

export function subscribeReviewNav(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getReviewNav(): ReviewNavModel | null {
  return model;
}

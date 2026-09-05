import type { ChangeDTO } from '../src/protocol';
import type { ReviewSource } from './docs';

export interface ReviewNavModel {
  source: ReviewSource | undefined;
  root: string | undefined;
  files: readonly ChangeDTO[];
  totalCount: number;
  activePath: string | null;
  reviewed: ReadonlySet<string>;
  canMark: (path: string) => boolean;
  filter: string;
  onPick: (path: string) => void;
  onToggleReviewed: (path: string) => void;
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

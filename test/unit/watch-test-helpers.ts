// Shared helpers for the `.conduit/` directory-watch tests (board-watcher,
// proposal-watcher). Factored out so the polling/delay/board-builder boilerplate isn't
// duplicated across the two watcher test files.

import type { BoardData } from '../../src/board';

/** A minimal board with the given cards. */
export const board = (cards: BoardData['cards']): BoardData => ({ version: 1, cards });

/** Resolve once `predicate()` is true (polling), or reject after `timeoutMs`. */
export function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** A simple millisecond delay. */
export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

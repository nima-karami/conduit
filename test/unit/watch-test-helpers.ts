// Shared helpers for the `.conduit/` directory-watch tests (board-watcher,
// proposal-watcher). Factored out so the polling/delay/board-builder boilerplate isn't
// duplicated across the two watcher test files.

import * as fs from 'node:fs';
import { expect } from 'vitest';
import type { BoardData } from '../../src/board';
import { serializeBoardArtifact } from '../../src/conduit-store';

/** A minimal board with the given cards. */
export const board = (cards: BoardData['cards']): BoardData => ({ version: 1, cards });

/**
 * Write a serialized board artifact to `filePath`, wait, and assert the watcher
 * stayed silent. Shared by the "stops watching after stop()" cases in both watcher
 * suites, where a post-stop write must produce no callback.
 */
export async function expectNoEventAfterWrite(
  filePath: string,
  cards: BoardData['cards'],
  seen: unknown[],
): Promise<void> {
  fs.writeFileSync(filePath, serializeBoardArtifact(board(cards)));
  await delay(250);
  expect(seen).toEqual([]);
}

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

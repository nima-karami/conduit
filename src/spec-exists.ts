// Pure derivations for batching the has-spec flag across a board's card set (N3). Lives in
// `src/` so both the host and renderer can compute the same mapping. No I/O; takes
// whatever lists the caller already holds. Fully unit-tested.

import { safeSpecFileName } from './spec-path';

/**
 * Build a `Set<string>` of safe spec filename stems from the flat list returned by
 * `listSpecs()` / the `specsList` IPC message. Call `cardHasSpec(card.id, specSet)` to
 * test individual cards.
 *
 * The host sends the spec list as sanitized stems (the raw filenames minus `.md`). The
 * card ids on the renderer side may be un-sanitized, so `cardHasSpec` sanitizes before
 * the lookup — guaranteeing a round-trip match even when an id contains unusual chars.
 *
 * @param specIds  Sanitized stems from the host (e.g. `listSpecs(root)` output).
 */
export function buildSpecSet(specIds: string[]): Set<string> {
  return new Set(specIds);
}

/**
 * True if a card id has a corresponding spec on disk. The id is sanitized to the same
 * stem the host uses when writing the file, so hostile / odd ids still match correctly.
 *
 * @param cardId  The raw card id (may contain characters stripped by `safeSpecFileName`).
 * @param specSet The set built by `buildSpecSet`.
 */
export function cardHasSpec(cardId: string, specSet: Set<string>): boolean {
  return specSet.has(safeSpecFileName(cardId));
}

/**
 * Batch-derive the has-spec flag for every card id in a list. Returns a `Map<id, boolean>`
 * so the renderer can drive indicators without re-deriving on each render cycle.
 *
 * @param cardIds  Raw card ids to test (e.g. `board.cards.map(c => c.id)`).
 * @param specSet  The set built by `buildSpecSet`.
 */
export function batchSpecExists(cardIds: string[], specSet: Set<string>): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const id of cardIds) {
    out.set(id, cardHasSpec(id, specSet));
  }
  return out;
}

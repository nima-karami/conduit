import type { ArchDoc } from '../../../src/architecture';

/** Deterministic large-ArchDoc generator (implementation in arch-corpus.mjs). */
export function makeArchCorpus(opts?: { nodeCount?: number; edgeCount?: number }): ArchDoc;

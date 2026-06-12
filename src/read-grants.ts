import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Read-grant store for the write-file trust boundary (K2 — save reliability).
 *
 * `validateWrite` (src/path-guard.ts) confines writes to the open workspace roots.
 * That is correct for an arbitrary renderer-supplied path, but too strict for a file
 * the HOST ITSELF chose to serve to the editor — a go-to-definition target or an
 * out-of-root recent can live outside every root, so saving an edit to it was being
 * rejected with an easy-to-miss banner ("it doesn't save").
 *
 * The fix records the canonical real path of every file the host serves via the
 * `readFile` IPC. A write is then allowed when EITHER `validateWrite` passes OR the
 * exact canonical target is a recorded grant. This module is the pure, testable core.
 *
 * SECURITY INVARIANT: a grant is an EXACT FILE the host itself chose to serve — never
 * a directory, never a renderer-supplied path without a prior successful read. The
 * grant key is the symlink-resolved, case-folded (win32) real path, computed
 * identically on read and on write, so a symlink can't make a write target merely
 * LOOK like a granted file. See docs/specs/archive/2026-06-11-save-reliability.md for the full analysis.
 */

export interface GrantStore {
  /** Record a served file's path (canonicalized internally). */
  add(p: string): void;
  /** True when `p` (canonicalized) is a recorded grant. */
  has(p: string): boolean;
  /** Number of distinct canonical grants currently held. */
  readonly size: number;
}

export interface GrantStoreOptions {
  /** Canonicalize a path to its comparison key. Injected so tests are deterministic. */
  canonical: (p: string) => string;
  /** Max grants retained; oldest is evicted past this (LRU-lite). Default 500. */
  cap?: number;
}

const DEFAULT_CAP = 500;

/**
 * Build a bounded grant store. Insertion-ordered: re-adding an existing key refreshes
 * its recency, and the OLDEST key is evicted once `cap` is exceeded. Eviction can only
 * REMOVE a grant (fail-closed: an evicted file falls back to the root check), never add
 * a capability.
 */
export function createGrantStore(opts: GrantStoreOptions): GrantStore {
  const cap = opts.cap ?? DEFAULT_CAP;
  // A Map preserves insertion order, so the first key is always the oldest. Re-adding
  // refreshes recency by delete-then-set (moving the key to the end).
  const grants = new Map<string, true>();

  return {
    add(p: string): void {
      const key = opts.canonical(p);
      if (grants.has(key)) grants.delete(key); // refresh recency
      grants.set(key, true);
      while (grants.size > cap) {
        // The first key in iteration order is the oldest; evict it.
        const oldest = grants.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        grants.delete(oldest);
      }
    },
    has(p: string): boolean {
      return grants.has(opts.canonical(p));
    },
    get size(): number {
      return grants.size;
    },
  };
}

/**
 * The host-side canonicalizer: resolve + follow symlinks, then case-fold on win32 to
 * match how the filesystem (and src/path-guard.ts) compares paths. A missing file
 * resolves to its lexical absolute path (lower-cased on win32) — a read only ever
 * grants a file that read successfully, so the realpath call here normally succeeds.
 */
export function hostCanonical(p: string): string {
  const abs = path.resolve(p);
  let real = abs;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    /* missing/unreadable — fall back to the lexical absolute path */
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

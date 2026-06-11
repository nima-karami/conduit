// Host-side FS wiring for the `.conduit/` artifact format. Resolves `.conduit/` at the
// OPENED PROJECT's root (not the Conduit install dir), reads with graceful defaults,
// and writes atomically + surfaces errors. Pure schema/migration lives in
// src/conduit-store.ts. See docs/adr/0002-conduit-artifact-format.md.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ArchDoc, restoreArchitecture } from '../src/architecture';
import type { BoardData } from '../src/board';
import {
  type ConduitKind,
  emptyBoardData,
  readArchitectureArtifact,
  readBoardArtifact,
  serializeArchitectureArtifact,
  serializeBoardArtifact,
} from '../src/conduit-store';

const CONDUIT_DIR = '.conduit';
/** The board artifact's filename — exported so the live watcher filters FS events on the
 *  same single source of truth instead of duplicating the literal. */
export const BOARD_FILE_NAME = 'board.json';
const FILE_FOR: Record<ConduitKind, string> = {
  architecture: 'architecture.json',
  board: BOARD_FILE_NAME,
};

/** The `.conduit/` directory for a project (`<projectRoot>/.conduit`). */
export function conduitDir(projectRoot: string): string {
  return path.join(projectRoot, CONDUIT_DIR);
}

/** A path inside a project's `.conduit/` (e.g. `conduitPath(root, 'specs', 'card-1.md')`). */
export function conduitPath(projectRoot: string, ...parts: string[]): string {
  return path.join(conduitDir(projectRoot), ...parts);
}

function artifactPath(projectRoot: string, kind: ConduitKind): string {
  return conduitPath(projectRoot, FILE_FOR[kind]);
}

function readBlob(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Read the raw `.conduit/board.json` blob for a project, or `undefined` if it can't be
 *  read (absent, mid-write, locked). Lets a caller distinguish "no/unreadable file" from
 *  a successfully-read empty board — the watcher uses this to avoid emitting an empty
 *  board on a transient read failure. */
export function readBoardBlob(projectRoot: string): string | undefined {
  return readBlob(artifactPath(projectRoot, 'board'));
}

/** Read `.conduit/architecture.json`; `null` if absent/invalid (caller seeds). */
export function readArchitectureArtifactFile(projectRoot: string): ArchDoc | null {
  return readArchitectureArtifact(readBlob(artifactPath(projectRoot, 'architecture')));
}

/** Read `.conduit/board.json`; an EMPTY board if absent/invalid (never Conduit's seed). */
export function readBoardArtifactFile(projectRoot: string): BoardData {
  return readBoardArtifact(readBlob(artifactPath(projectRoot, 'board')));
}

/**
 * Read a project's board for the in-app board view. Per-project only: a falsy root
 * yields an empty board (never reads the process cwd, and never the legacy install-root
 * `board.json`). Absent/invalid `.conduit/board.json` is an EMPTY board — Conduit's own
 * seed is never injected into a foreign project (ADR §5). Mirrors
 * `readArchitectureForProject`.
 */
export function readBoardForProject(projectRoot: string): BoardData {
  if (!projectRoot) return emptyBoardData();
  return readBoardArtifactFile(projectRoot);
}

/**
 * Read a project's architecture for the canvas, with one-way legacy migration:
 * prefer the canonical `.conduit/architecture.json`; if it's absent or invalid, fall
 * back to the legacy bare `<root>/architecture.json` (the next save rewrites that
 * forward into `.conduit/`, so no eager rewrite here and no diagram is lost).
 * `null` when neither yields a valid doc — the caller seeds. A falsy root yields
 * `null` rather than reading the process cwd.
 */
export function readArchitectureForProject(projectRoot: string): ArchDoc | null {
  if (!projectRoot) return null;
  const canonical = readArchitectureArtifactFile(projectRoot);
  if (canonical) return canonical;
  return restoreArchitecture(readBlob(path.join(projectRoot, 'architecture.json')));
}

/**
 * Write `text` to `target` atomically: a sibling temp file is written then renamed over
 * the target, so a crash mid-write never leaves a truncated artifact. Errors are
 * SURFACED (the promise rejects) — a failed save must never be silently mistaken for
 * success, since `.conduit/` artifacts are committed and reviewed (ADR §5).
 */
async function writeAtomic(target: string, text: string): Promise<void> {
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, target);
  } catch (err) {
    // Best-effort cleanup of the temp file; never mask the original error.
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Write `.conduit/architecture.json` (mkdir -p, atomic, errors surfaced). */
export function writeArchitectureArtifactFile(projectRoot: string, doc: ArchDoc): Promise<void> {
  return writeAtomic(artifactPath(projectRoot, 'architecture'), serializeArchitectureArtifact(doc));
}

/** Write `.conduit/board.json` (mkdir -p, atomic, errors surfaced). */
export function writeBoardArtifactFile(projectRoot: string, board: BoardData): Promise<void> {
  return writeAtomic(artifactPath(projectRoot, 'board'), serializeBoardArtifact(board));
}

// Host-side FS wiring for the `.conduit/` artifact format. Resolves `.conduit/` at the
// OPENED PROJECT's root (not the Conduit install dir), reads with graceful defaults,
// and writes atomically + surfaces errors. Pure schema/migration lives in
// src/conduit-store.ts. See docs/adr/0002-conduit-artifact-format.md.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArchDoc } from '../src/architecture';
import type { BoardData } from '../src/board';
import {
  type ConduitKind,
  readArchitectureArtifact,
  readBoardArtifact,
  serializeArchitectureArtifact,
  serializeBoardArtifact,
} from '../src/conduit-store';

const CONDUIT_DIR = '.conduit';
const FILE_FOR: Record<ConduitKind, string> = {
  architecture: 'architecture.json',
  board: 'board.json',
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

/** Read `.conduit/architecture.json`; `null` if absent/invalid (caller seeds). */
export function readArchitectureArtifactFile(projectRoot: string): ArchDoc | null {
  return readArchitectureArtifact(readBlob(artifactPath(projectRoot, 'architecture')));
}

/** Read `.conduit/board.json`; an EMPTY board if absent/invalid (never Conduit's seed). */
export function readBoardArtifactFile(projectRoot: string): BoardData {
  return readBoardArtifact(readBlob(artifactPath(projectRoot, 'board')));
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

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
  readPipelineArtifact,
  readPipelineQueueArtifact,
  serializeArchitectureArtifact,
  serializeBoardArtifact,
  serializePipelineArtifact,
  serializePipelineQueueArtifact,
} from '../src/conduit-store';
import {
  appendQueueEntry,
  emptyPipelineConfig,
  type PipelineConfig,
  type PipelineQueueEntry,
} from '../src/pipeline';
import { safeSpecFileName } from '../src/spec-path';

const CONDUIT_DIR = '.conduit';
/** Subdirectory under `.conduit/` holding per-card feature specs (`<card-id>.md`). */
const SPECS_DIR = 'specs';
/** The board artifact's filename — exported so the live watcher filters FS events on the
 *  same single source of truth instead of duplicating the literal. */
export const BOARD_FILE_NAME = 'board.json';
const FILE_FOR: Record<ConduitKind, string> = {
  architecture: 'architecture.json',
  board: BOARD_FILE_NAME,
  pipeline: 'pipeline.json',
  'pipeline-queue': 'pipeline-queue.json',
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

// ---- Pipeline (G4): `.conduit/pipeline.json` + `.conduit/pipeline-queue.json` -------
// `pipeline.json` is the human-owned per-transition → skill config. `pipeline-queue.json`
// is the append-style event stream the app writes on a card move and an EXTERNAL agent
// drains. The app never executes a skill — it only surfaces + records the transition.

/**
 * Read a project's pipeline config. Per-project only: a falsy root yields an empty
 * config. Absent/invalid `.conduit/pipeline.json` is an EMPTY config (never throws).
 */
export function readPipelineForProject(projectRoot: string): PipelineConfig {
  if (!projectRoot) return emptyPipelineConfig();
  return readPipelineArtifact(readBlob(artifactPath(projectRoot, 'pipeline')));
}

/** Write `.conduit/pipeline.json` (mkdir -p, atomic, errors surfaced). */
export function writePipelineArtifactFile(
  projectRoot: string,
  config: PipelineConfig,
): Promise<void> {
  return writeAtomic(artifactPath(projectRoot, 'pipeline'), serializePipelineArtifact(config));
}

// Per-root serialization chain for queue appends. The append is a read-modify-write
// across an `await` (read current → append → atomic write); two in-flight appends to the
// same project could otherwise interleave so the second's read predates the first's
// write, dropping an entry. We tail each project's appends onto a promise chain so the
// read always sees the prior write's result. Keyed by root so unrelated projects don't
// serialize against each other.
const queueAppendChains = new Map<string, Promise<void>>();

/**
 * Append one transition entry to `.conduit/pipeline-queue.json` (read-modify-write,
 * atomic, errors surfaced). The read tolerates an absent/invalid queue (starts empty),
 * so the first surfaced transition creates the file. Appends to the same project are
 * serialized (see `queueAppendChains`) so rapid moves never drop an entry.
 */
export function appendPipelineQueueEntry(
  projectRoot: string,
  entry: PipelineQueueEntry,
): Promise<void> {
  const doAppend = async (): Promise<void> => {
    const current = readPipelineQueueArtifact(
      readBlob(artifactPath(projectRoot, 'pipeline-queue')),
    );
    const next = appendQueueEntry(current, entry);
    await writeAtomic(
      artifactPath(projectRoot, 'pipeline-queue'),
      serializePipelineQueueArtifact(next),
    );
  };
  // Chain onto the prior append for this root; `.catch` so one failed append doesn't
  // wedge the chain (the failure is still surfaced to *this* call's awaiter below).
  const prior = queueAppendChains.get(projectRoot) ?? Promise.resolve();
  const result = prior.then(doAppend, doAppend);
  queueAppendChains.set(
    projectRoot,
    result.catch(() => {}),
  );
  return result;
}

// ---- Feature specs (G3): `.conduit/specs/<card-id>.md` ---------------------
// A card's spec path is DERIVED from its stable id (ADR §2c) — the filename IS the link,
// nothing is stored on the card. Card ids are slug-like, but a hand-edited / agent-written
// board.json could carry a hostile id, so we sanitize defensively (`safeSpecFileName`,
// pure + shared with the renderer in src/spec-path.ts): a spec can never be read from or
// written to a path outside `<root>/.conduit/specs/`.

/** The `.conduit/specs/` directory for a project. */
export function specsDir(projectRoot: string): string {
  return conduitPath(projectRoot, SPECS_DIR);
}

/**
 * Absolute path to a card's spec file. The id is sanitized to a single safe segment, then
 * a normalized containment check asserts the result is inside `.conduit/specs/` (defense
 * in depth — should always hold after sanitization). Throws if it would escape.
 */
export function specPath(projectRoot: string, cardId: string): string {
  const base = specsDir(projectRoot);
  const target = path.join(base, `${safeSpecFileName(cardId)}.md`);
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing spec path outside .conduit/specs/: ${cardId}`);
  }
  return target;
}

/** Read a card's spec markdown, or `null` if absent/unreadable (absent ≠ error). */
export function readSpec(projectRoot: string, cardId: string): string | null {
  return readBlob(specPath(projectRoot, cardId)) ?? null;
}

/** True if a card has a spec file on disk. */
export function hasSpec(projectRoot: string, cardId: string): boolean {
  return fs.existsSync(specPath(projectRoot, cardId));
}

/** Card ids (filename without `.md`) that have a spec; `[]` if `.conduit/specs/` is absent. */
export function listSpecs(projectRoot: string): string[] {
  try {
    return fs.readdirSync(specsDir(projectRoot)).flatMap((f) => {
      if (!f.endsWith('.md')) return []; // skips the atomic-write temps (`.<name>.<hex>.tmp`)
      // Ignore any stray dotfile that still ends in `.md` (e.g. an editor backup); a real
      // spec name can never start with a dot (safeSpecFileName strips leading dots).
      if (f.startsWith('.')) return [];
      return [f.slice(0, -'.md'.length)];
    });
  } catch {
    return [];
  }
}

/** Write a card's spec markdown (mkdir -p `.conduit/specs/`, atomic, errors surfaced). */
export function writeSpec(projectRoot: string, cardId: string, md: string): Promise<void> {
  return writeAtomic(specPath(projectRoot, cardId), md);
}

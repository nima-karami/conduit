// The `.conduit/` artifact format: a thin, versioned envelope wrapping the existing
// domain payloads (`ArchDoc`, `BoardData`). Pure + unit-tested; see
// docs/adr/0002-conduit-artifact-format.md. Host FS wiring lives in
// electron/conduit-fs.ts — this module never touches the disk.

import { type ArchDoc, restoreArchitecture, serializeArchitecture } from './architecture';
import { type BoardData, restoreBoard, serializeBoard } from './board';
import {
  type PipelineConfig,
  type PipelineQueue,
  restorePipeline,
  restorePipelineQueue,
  serializePipeline,
  serializePipelineQueue,
} from './pipeline';

/** Envelope (wrapper) format version. Bumped only if the wrapper shape changes — the
 *  payload self-versions via `data.version`, so this is NOT the schema version. */
export const CONDUIT_VERSION = 1;

/** Which artifact an envelope carries. The canonical knowledge kinds (architecture,
 *  board) plus the pipeline kinds (G4): `pipeline` is the per-transition skill config
 *  (human-owned, stable); `pipeline-queue` is the append-style event stream an external
 *  agent drains. The agent-proposal mechanism (ADR §3) is deferred to F0/G0 and
 *  intentionally not modelled here. */
export type ConduitKind = 'architecture' | 'board' | 'pipeline' | 'pipeline-queue';

interface ConduitEnvelope<T> {
  conduit: number;
  kind: ConduitKind;
  /** Epoch ms of the last write — provenance, not load-bearing. */
  updatedAt: number;
  data: T;
}

/** An empty board — the `.conduit/` default when no board exists yet. Deliberately
 *  NOT `seedBoard()`: that hard-codes Conduit's own backlog and must never be injected
 *  into a foreign project's board (ADR §5). */
export function emptyBoardData(): BoardData {
  return { version: 1, cards: [] };
}

function wrap<T>(kind: ConduitKind, data: T, updatedAt: number): ConduitEnvelope<T> {
  return { conduit: CONDUIT_VERSION, kind, updatedAt, data };
}

/** Serialize an architecture doc as a `.conduit/architecture.json` envelope. */
export function serializeArchitectureArtifact(
  doc: ArchDoc,
  updatedAt: number = Date.now(),
): string {
  // Round the payload through the domain serializer so the embedded shape is exactly
  // what `restoreArchitecture` expects (and stays in lockstep with it).
  const data = JSON.parse(serializeArchitecture(doc)) as ArchDoc;
  return JSON.stringify(wrap('architecture', data, updatedAt), null, 2);
}

/** Serialize a board as a `.conduit/board.json` envelope. */
export function serializeBoardArtifact(board: BoardData, updatedAt: number = Date.now()): string {
  const data = JSON.parse(serializeBoard(board)) as BoardData;
  return JSON.stringify(wrap('board', data, updatedAt), null, 2);
}

/** Serialize the pipeline config as a `.conduit/pipeline.json` envelope (G4). */
export function serializePipelineArtifact(
  config: PipelineConfig,
  updatedAt: number = Date.now(),
): string {
  const data = JSON.parse(serializePipeline(config)) as PipelineConfig;
  return JSON.stringify(wrap('pipeline', data, updatedAt), null, 2);
}

/** Serialize the transition queue as a `.conduit/pipeline-queue.json` envelope (G4). */
export function serializePipelineQueueArtifact(
  queue: PipelineQueue,
  updatedAt: number = Date.now(),
): string {
  const data = JSON.parse(serializePipelineQueue(queue)) as PipelineQueue;
  return JSON.stringify(wrap('pipeline-queue', data, updatedAt), null, 2);
}

/** Unwrap a blob to its payload string: if it's a conduit envelope, return `data`;
 *  if it's a bare (un-enveloped) payload, return it as-is. `undefined` on bad JSON. */
function unwrapPayload(blob: string | undefined): unknown {
  if (!blob) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return undefined;
  }
  if (parsed && typeof parsed === 'object' && 'conduit' in parsed && 'data' in parsed) {
    // An envelope (any `conduit` version — unknown versions degrade gracefully by
    // reading the payload rather than throwing).
    return (parsed as ConduitEnvelope<unknown>).data;
  }
  // A bare payload (today's un-enveloped architecture.json / board.json).
  return parsed;
}

/**
 * Read an architecture envelope (or a bare `ArchDoc`) into a validated `ArchDoc`.
 * Returns `null` when missing/invalid — the caller seeds if it wants to (mirrors
 * `restoreArchitecture`). Domain migrations (e.g. legacy kinds) are applied.
 */
export function readArchitectureArtifact(blob: string | undefined): ArchDoc | null {
  const payload = unwrapPayload(blob);
  if (payload === undefined) return null;
  return restoreArchitecture(JSON.stringify(payload));
}

/**
 * Read a board envelope (or a bare `BoardData`) into a validated `BoardData`.
 * Falls back to an EMPTY board (never `seedBoard()`) when missing/invalid, so the
 * layer is safe to point at any project (ADR §5).
 */
export function readBoardArtifact(blob: string | undefined): BoardData {
  const payload = unwrapPayload(blob);
  if (payload === undefined) return emptyBoardData();
  // `restoreBoard` falls back to `seedBoard()` on invalid input; guard so a malformed
  // `.conduit/board.json` yields an empty board, not Conduit's own backlog.
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as BoardData).cards)) {
    return emptyBoardData();
  }
  return restoreBoard(JSON.stringify(payload));
}

/**
 * Read a pipeline-config envelope (or a bare `PipelineConfig`) into a validated config.
 * Falls back to an EMPTY config when missing/invalid (`restorePipeline` never throws).
 */
export function readPipelineArtifact(blob: string | undefined): PipelineConfig {
  const payload = unwrapPayload(blob);
  if (payload === undefined) return restorePipeline(undefined);
  return restorePipeline(JSON.stringify(payload));
}

/**
 * Read a pipeline-queue envelope (or a bare `PipelineQueue`) into a validated queue.
 * Falls back to an EMPTY queue when missing/invalid; malformed entries are dropped.
 */
export function readPipelineQueueArtifact(blob: string | undefined): PipelineQueue {
  const payload = unwrapPayload(blob);
  if (payload === undefined) return restorePipelineQueue(undefined);
  return restorePipelineQueue(JSON.stringify(payload));
}

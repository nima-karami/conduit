// Pure, id-stable diffs between a canonical `.conduit/` artifact and an agent's
// `*.proposed.json` sibling (the proposal mechanism — ADR 0002 §3, N1). The app shows
// these diffs in a banner and the human accepts (apply the proposed whole document to
// the canonical file) or rejects (delete the proposal). Apply is WHOLE-DOCUMENT: the
// proposed `data` replaces the canonical `data` verbatim, so "apply" needs no merge — it
// is just the proposed payload. These diffs are purely for HUMAN REVIEW. Stable ids
// (card ids, node ids, edge ids) are the diff anchor, per ADR §4.
//
// Host FS wiring (detect/read/accept/reject) lives in electron/conduit-fs.ts +
// electron/board-watcher.ts; this module never touches disk.

import type { ArchDoc, ArchEdge, ArchNode } from './architecture';
import type { BoardCard, BoardData, Stage } from './board';

// ---- Board diff ------------------------------------------------------------

/** A card whose stage changed (a "move" on the Kanban). */
export interface CardMove {
  id: string;
  title: string;
  from: Stage;
  to: Stage;
}

/** A card whose content (title/notes/links) changed without (only) moving. */
export interface CardEdit {
  id: string;
  title: string;
  /** Which fields differ (`title`, `notes`, `links`) — drives the review summary. */
  fields: string[];
}

export interface BoardDiff {
  added: BoardCard[];
  removed: BoardCard[];
  moved: CardMove[];
  edited: CardEdit[];
  hasChanges: boolean;
}

const byId = <T extends { id: string }>(items: T[]): Map<string, T> =>
  new Map(items.map((i) => [i.id, i]));

/** Shallow-equal a card's links array (order-sensitive — agents emit a stable order). */
function linksEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  return aa.every((v, i) => v === bb[i]);
}

/** Content fields that differ between two cards (ignores stage — that's a "move"). */
function cardEditedFields(a: BoardCard, b: BoardCard): string[] {
  const fields: string[] = [];
  if (a.title !== b.title) fields.push('title');
  if (a.notes !== b.notes) fields.push('notes');
  if (!linksEqual(a.links, b.links)) fields.push('links');
  return fields;
}

/**
 * Diff a proposed board against the canonical one by stable card id. A card present only
 * in `proposed` is added; only in `current` is removed; in both with a different stage is
 * moved; in both with different content (title/notes/links) is edited. A card may appear
 * in BOTH `moved` and `edited` (it changed column and content) — they are independent
 * facets so the review reads precisely.
 */
export function diffBoard(current: BoardData, proposed: BoardData): BoardDiff {
  const before = byId(current.cards);
  const after = byId(proposed.cards);
  const added: BoardCard[] = [];
  const removed: BoardCard[] = [];
  const moved: CardMove[] = [];
  const edited: CardEdit[] = [];

  for (const card of proposed.cards) {
    const prev = before.get(card.id);
    if (!prev) {
      added.push(card);
      continue;
    }
    if (prev.stage !== card.stage) {
      moved.push({ id: card.id, title: card.title, from: prev.stage, to: card.stage });
    }
    const fields = cardEditedFields(prev, card);
    if (fields.length) edited.push({ id: card.id, title: card.title, fields });
  }
  for (const card of current.cards) {
    if (!after.has(card.id)) removed.push(card);
  }

  return {
    added,
    removed,
    moved,
    edited,
    hasChanges: added.length + removed.length + moved.length + edited.length > 0,
  };
}

/** A short human summary like "2 added · 1 removed · 1 moved · 1 edited". */
export function summarizeBoardDiff(d: BoardDiff): string {
  const parts: string[] = [];
  if (d.added.length) parts.push(`${d.added.length} added`);
  if (d.removed.length) parts.push(`${d.removed.length} removed`);
  if (d.moved.length) parts.push(`${d.moved.length} moved`);
  if (d.edited.length) parts.push(`${d.edited.length} edited`);
  return parts.length ? parts.join(' · ') : 'No changes';
}

// ---- Architecture diff -----------------------------------------------------

/** A node whose content changed (title/subtitle/description/kind/position/childGraph). */
export interface NodeEdit {
  id: string;
  title: string;
  fields: string[];
}

/** An edge whose endpoints or label changed. */
export interface EdgeEdit {
  id: string;
  fields: string[];
}

export interface ArchDiff {
  addedNodes: ArchNode[];
  removedNodes: ArchNode[];
  editedNodes: NodeEdit[];
  addedEdges: ArchEdge[];
  removedEdges: ArchEdge[];
  editedEdges: EdgeEdit[];
  hasChanges: boolean;
}

/** Flatten every node across every graph in the doc, keyed by node id. Node ids are
 *  globally unique within a doc (the model mints `node-<ts>-<n>`), so a flat map is the
 *  right diff anchor across the whole tree of graphs. */
function allNodes(doc: ArchDoc): Map<string, ArchNode> {
  const map = new Map<string, ArchNode>();
  for (const g of Object.values(doc.graphs)) for (const n of g.nodes) map.set(n.id, n);
  return map;
}

function allEdges(doc: ArchDoc): Map<string, ArchEdge> {
  const map = new Map<string, ArchEdge>();
  for (const g of Object.values(doc.graphs)) for (const e of g.edges) map.set(e.id, e);
  return map;
}

function nodeEditedFields(a: ArchNode, b: ArchNode): string[] {
  const fields: string[] = [];
  if (a.title !== b.title) fields.push('title');
  if ((a.subtitle ?? '') !== (b.subtitle ?? '')) fields.push('subtitle');
  if ((a.description ?? '') !== (b.description ?? '')) fields.push('description');
  if (a.kind !== b.kind) fields.push('kind');
  if (a.x !== b.x || a.y !== b.y) fields.push('position');
  if ((a.childGraph ?? '') !== (b.childGraph ?? '')) fields.push('childGraph');
  return fields;
}

function edgeEditedFields(a: ArchEdge, b: ArchEdge): string[] {
  const fields: string[] = [];
  if (a.source !== b.source) fields.push('source');
  if (a.target !== b.target) fields.push('target');
  if ((a.label ?? '') !== (b.label ?? '')) fields.push('label');
  return fields;
}

/**
 * Diff a proposed architecture against the canonical one by stable node/edge id, across
 * the whole tree of graphs. Added/removed/edited are computed independently for nodes and
 * edges so the review reads at a glance. Id stability (ADR §4) is what makes the
 * whole-document proposal diff cleanly.
 */
export function diffArchitecture(current: ArchDoc, proposed: ArchDoc): ArchDiff {
  const beforeNodes = allNodes(current);
  const afterNodes = allNodes(proposed);
  const beforeEdges = allEdges(current);
  const afterEdges = allEdges(proposed);

  const addedNodes: ArchNode[] = [];
  const removedNodes: ArchNode[] = [];
  const editedNodes: NodeEdit[] = [];
  for (const [id, node] of afterNodes) {
    const prev = beforeNodes.get(id);
    if (!prev) {
      addedNodes.push(node);
      continue;
    }
    const fields = nodeEditedFields(prev, node);
    if (fields.length) editedNodes.push({ id, title: node.title, fields });
  }
  for (const [id, node] of beforeNodes) if (!afterNodes.has(id)) removedNodes.push(node);

  const addedEdges: ArchEdge[] = [];
  const removedEdges: ArchEdge[] = [];
  const editedEdges: EdgeEdit[] = [];
  for (const [id, edge] of afterEdges) {
    const prev = beforeEdges.get(id);
    if (!prev) {
      addedEdges.push(edge);
      continue;
    }
    const fields = edgeEditedFields(prev, edge);
    if (fields.length) editedEdges.push({ id, fields });
  }
  for (const [id, edge] of beforeEdges) if (!afterEdges.has(id)) removedEdges.push(edge);

  const total =
    addedNodes.length +
    removedNodes.length +
    editedNodes.length +
    addedEdges.length +
    removedEdges.length +
    editedEdges.length;

  return {
    addedNodes,
    removedNodes,
    editedNodes,
    addedEdges,
    removedEdges,
    editedEdges,
    hasChanges: total > 0,
  };
}

/** A short human summary of an architecture diff. */
export function summarizeArchDiff(d: ArchDiff): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (d.addedNodes.length) parts.push(`${plural(d.addedNodes.length, 'node')} added`);
  if (d.removedNodes.length) parts.push(`${plural(d.removedNodes.length, 'node')} removed`);
  if (d.editedNodes.length) parts.push(`${plural(d.editedNodes.length, 'node')} edited`);
  if (d.addedEdges.length) parts.push(`${plural(d.addedEdges.length, 'edge')} added`);
  if (d.removedEdges.length) parts.push(`${plural(d.removedEdges.length, 'edge')} removed`);
  if (d.editedEdges.length) parts.push(`${plural(d.editedEdges.length, 'edge')} edited`);
  return parts.length ? parts.join(' · ') : 'No changes';
}

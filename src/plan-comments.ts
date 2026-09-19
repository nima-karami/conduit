import { unwrapPayload, wrap } from './conduit-store';
import { normalizeBlockSource, type PlanBlock } from './plan-blocks';

/**
 * Comments on an interactive plan document (spec 2026-09-19-interactive-plan §3). Node-free and
 * DOM-free on purpose: the HOST validates and persists `.conduit/plans/<slug>.comments.json` with
 * it and the RENDERER folds the same patches optimistically, so the two sides can only disagree by
 * disagreeing with this file. Mirrors src/review-notes.ts.
 */

/** Where a comment hangs: the block's position, content hash and first-line snippet. The `.md`
 *  carries no ids, so a comment is re-anchored on every load — see `reanchorComments`. */
export interface PlanAnchor {
  index: number;
  hash: string;
  snippet: string;
}

export interface PlanComment {
  id: string;
  author: 'human' | 'agent';
  text: string;
  anchor: PlanAnchor;
  status: 'open' | 'resolved';
  /** ISO-8601 UTC. */
  createdAt: string;
  replyTo?: string;
  sentAt?: string;
}

/** The ordered on-disk block hashes at the last sync; see the plan's "Settled decisions". */
export interface PlanBaseline {
  at: string;
  blockHashes: string[];
}

export interface PlanCommentsData {
  version: 1;
  baseline?: PlanBaseline;
  comments: PlanComment[];
}

export const MAX_COMMENT_TEXT = 4096;
export const MAX_COMMENTS = 2000;

export type PlanCommentPatch =
  | { type: 'add'; comment: PlanComment }
  | { type: 'edit'; id: string; text: string }
  | { type: 'resolve'; id: string; resolved: boolean }
  | { type: 'delete'; id: string }
  | { type: 'reattach'; id: string; anchor: PlanAnchor }
  | { type: 'sent'; ids: string[]; baseline: PlanBaseline };

/** Similarity floor for a re-anchor by position (plan: Dice on bigrams ≥ 0.6). */
const REANCHOR_MIN_DICE = 0.6;
/** How far either side of the stored index a moved block is followed before detaching. */
const REANCHOR_RADIUS = 2;

/** The clock is injected so tests can pin it; the suffix keeps two comments made in the same
 *  millisecond apart. */
export function newCommentId(now: number): string {
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += Math.floor(Math.random() * 36).toString(36);
  return `c${now.toString(36)}${suffix}`;
}

function isAnchor(v: unknown): v is PlanAnchor {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.index === 'number' &&
    Number.isFinite(a.index) &&
    typeof a.hash === 'string' &&
    typeof a.snippet === 'string'
  );
}

/** Shape check for anything crossing a boundary — the parse path AND the host write path, which
 *  persists what it is handed into a file the user commits. */
export function isPlanComment(x: unknown): x is PlanComment {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    (c.author === 'human' || c.author === 'agent') &&
    typeof c.text === 'string' &&
    isAnchor(c.anchor) &&
    (c.status === 'open' || c.status === 'resolved') &&
    typeof c.createdAt === 'string' &&
    (c.replyTo === undefined || typeof c.replyTo === 'string') &&
    (c.sentAt === undefined || typeof c.sentAt === 'string')
  );
}

function emptyData(): PlanCommentsData {
  return { version: 1, comments: [] };
}

function withComments(d: PlanCommentsData, comments: PlanComment[]): PlanCommentsData {
  return d.baseline ? { version: 1, baseline: d.baseline, comments } : { version: 1, comments };
}

const validText = (t: string): boolean => t.trim().length > 0 && t.length <= MAX_COMMENT_TEXT;

/**
 * The single merge path, shared by the host (authoritative) and the renderer (optimistic). Every
 * refusal returns `d` itself — identity is the signal the caller tests, and the host must never
 * throw on a message a window could malform.
 */
export function applyPlanCommentPatch(d: PlanCommentsData, p: PlanCommentPatch): PlanCommentsData {
  switch (p.type) {
    case 'add': {
      if (!isPlanComment(p.comment) || !validText(p.comment.text)) return d;
      if (d.comments.length >= MAX_COMMENTS) return d;
      if (d.comments.some((c) => c.id === p.comment.id)) return d;
      return withComments(d, [...d.comments, p.comment]);
    }
    case 'edit': {
      if (!validText(p.text)) return d;
      if (!d.comments.some((c) => c.id === p.id)) return d;
      return withComments(
        d,
        d.comments.map((c) => (c.id === p.id ? { ...c, text: p.text } : c)),
      );
    }
    case 'resolve': {
      const status = p.resolved ? 'resolved' : 'open';
      const current = d.comments.find((c) => c.id === p.id);
      if (!current || current.status === status) return d;
      return withComments(
        d,
        d.comments.map((c) => (c.id === p.id ? { ...c, status } : c)),
      );
    }
    case 'delete': {
      if (!d.comments.some((c) => c.id === p.id)) return d;
      return withComments(
        d,
        d.comments.filter((c) => c.id !== p.id),
      );
    }
    case 'reattach': {
      if (!isAnchor(p.anchor)) return d;
      if (!d.comments.some((c) => c.id === p.id)) return d;
      return withComments(
        d,
        d.comments.map((c) => (c.id === p.id ? { ...c, anchor: p.anchor } : c)),
      );
    }
    case 'sent': {
      // The baseline is persisted verbatim into a file the user commits, and it arrives from a
      // window — so it is shape-checked here like every other patch payload, not trusted.
      if (!Array.isArray(p.ids) || !p.ids.every((id) => typeof id === 'string')) return d;
      if (!isBaseline(p.baseline)) return d;
      const ids = new Set(p.ids);
      return {
        version: 1,
        baseline: p.baseline,
        comments: d.comments.map((c) => (ids.has(c.id) ? { ...c, sentAt: p.baseline.at } : c)),
      };
    }
  }
}

/** Two windows (or a window and the agent) writing the sidecar; there is no conflict banner for
 *  it, so the rules have to be total — see the plan's "Settled decisions". */
export function mergeComments(local: PlanCommentsData, disk: PlanCommentsData): PlanCommentsData {
  const localById = new Map(local.comments.map((c) => [c.id, c]));
  const merged = disk.comments.map((onDisk) => {
    const mine = localById.get(onDisk.id);
    if (!mine) return onDisk;
    // Status/replyTo/sentAt are the host's to decide; the human's own in-flight text is not.
    return onDisk.author === 'human' ? { ...onDisk, text: mine.text } : onDisk;
  });
  const diskIds = new Set(disk.comments.map((c) => c.id));
  for (const c of local.comments) if (!diskIds.has(c.id)) merged.push(c);

  const baseline = local.baseline ?? disk.baseline;
  return baseline ? { version: 1, baseline, comments: merged } : { version: 1, comments: merged };
}

/** A comment and the block it currently sits on; `index` null => detached (never dropped). */
export interface AnchoredComment {
  comment: PlanComment;
  index: number | null;
}

function bigrams(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

export function diceSimilarity(a: string, b: string): number {
  const x = normalizeBlockSource(a);
  const y = normalizeBlockSource(b);
  // Covers the single-character and empty cases, which have no bigrams at all.
  if (x === y) return 1;
  const ga = bigrams(x);
  const gb = bigrams(y);
  const total = Math.max(0, x.length - 1) + Math.max(0, y.length - 1);
  if (total === 0) return 0;
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / total;
}

function locate(anchor: PlanAnchor, blocks: readonly PlanBlock[]): number | null {
  const exact = blocks.findIndex((b) => b.hash === anchor.hash);
  if (exact >= 0) return exact;
  const similar = (i: number): boolean =>
    i >= 0 &&
    i < blocks.length &&
    diceSimilarity(anchor.snippet, blocks[i].snippet) >= REANCHOR_MIN_DICE;
  if (similar(anchor.index)) return anchor.index;
  for (let d = 1; d <= REANCHOR_RADIUS; d++) {
    // Lower index first, so two equidistant candidates resolve deterministically.
    if (similar(anchor.index - d)) return anchor.index - d;
    if (similar(anchor.index + d)) return anchor.index + d;
  }
  return null;
}

/** Pure and view-only: the stored anchor is never rewritten from here, so a read can never
 *  provoke a write — a move is persisted only by an explicit `reattach` patch. */
export function reanchorComments(
  comments: readonly PlanComment[],
  blocks: readonly PlanBlock[],
): AnchoredComment[] {
  return comments.map((comment) => ({ comment, index: locate(comment.anchor, blocks) }));
}

export function serializePlanComments(d: PlanCommentsData): string {
  return `${JSON.stringify(wrap('plan-comments', d, Date.now()), null, 2)}\n`;
}

function isBaseline(v: unknown): v is PlanBaseline {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.at === 'string' &&
    Array.isArray(b.blockHashes) &&
    b.blockHashes.every((h) => typeof h === 'string')
  );
}

/** A corrupt or foreign-version payload is an EMPTY set of comments, never an error. */
export function restorePlanComments(text: string | undefined): PlanCommentsData {
  const payload = unwrapPayload(text);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return emptyData();
  const { version, baseline, comments } = payload as {
    version?: unknown;
    baseline?: unknown;
    comments?: unknown;
  };
  if (version !== 1 || !Array.isArray(comments)) return emptyData();
  const kept = comments.filter(isPlanComment);
  return isBaseline(baseline)
    ? { version: 1, baseline, comments: kept }
    : { version: 1, comments: kept };
}

/** Content fingerprint for the watcher's self-echo guard — never the envelope's `updatedAt`,
 *  which changes on every write. Mirrors `notesFingerprint`. */
export function commentsFingerprint(d: PlanCommentsData): string {
  return JSON.stringify({ baseline: d.baseline, comments: d.comments });
}

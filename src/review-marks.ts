/**
 * The reviewed-marks model (spec 2026-08-27-review-supercharge §2 Lane B). Node-free on purpose:
 * the HOST reads/writes userData/review-marks.json with it and the RENDERER hashes the new-side
 * text and folds the marks into a path set with it, so both sides can only ever disagree by
 * disagreeing with this file.
 *
 * Marks are per-user, per-machine, high-frequency state — the same home as sessions.json — and
 * deliberately NOT `.conduit/` (§5): marking a file read must never show up as a change in the
 * tree the user is reviewing.
 */

/** One "I've read this file" mark. Identity is `source` + `path`; `contentHash` is the receipt. */
export interface ReviewMark {
  /** The Review source it was made under: 'working' | `commit:<sha>` | `range:<rangeKey>`. */
  source: string;
  /** Repo-relative posix path, exactly as ChangeDTO carries it. */
  path: string;
  /** FNV-1a of the new-side text at the moment of marking; a mismatch retires the mark. */
  contentHash: string;
  /** ISO-8601 UTC — also the cap's sort key. */
  at: string;
}

export interface ReviewMarksFile {
  version: 1;
  /** Keyed by repo root, posix, no trailing separator. */
  repos: Record<string, ReviewMark[]>;
}

/** One repo's slice, as it crosses the wire. */
export interface ReviewMarksRepo {
  root: string;
  marks: ReviewMark[];
}

/** Newest-N bound per repo (§5 "Budgets"). */
export const MAX_MARKS_PER_REPO = 2000;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a (32-bit) over UTF-16 code units, as 8 lowercase hex chars. Dependency-free and cheap
 * enough to run on every diff arrival. A collision only produces a stale "reviewed" badge — it
 * can't lose work — which is what makes 32 bits enough here (§2 Lane B).
 */
export function contentHash(text: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Repo roots reach us from three platforms and two APIs; one spelling per repo or the file
 *  would grow a second key for the same directory. */
export function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function emptyMarksFile(): ReviewMarksFile {
  return { version: 1, repos: {} };
}

const isMark = (v: unknown): v is ReviewMark => {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.source === 'string' &&
    typeof m.path === 'string' &&
    typeof m.contentHash === 'string' &&
    typeof m.at === 'string'
  );
};

/** Newest first, then cut to the bound. */
const capped = (marks: readonly ReviewMark[]): ReviewMark[] =>
  [...marks].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, MAX_MARKS_PER_REPO);

/** A corrupt or foreign-version file is an EMPTY set of marks, never an error: the next write
 *  replaces it and the user loses a badge, not their work (§4). */
export function parseMarksFile(blob: string | undefined): ReviewMarksFile {
  if (!blob) return emptyMarksFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return emptyMarksFile();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return emptyMarksFile();
  const { version, repos } = parsed as { version?: unknown; repos?: unknown };
  if (version !== 1 || typeof repos !== 'object' || repos === null) return emptyMarksFile();

  const out = emptyMarksFile();
  for (const [root, value] of Object.entries(repos as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const marks = capped(value.filter(isMark));
    if (marks.length > 0) out.repos[normalizeRoot(root)] = marks;
  }
  return out;
}

export function serializeMarksFile(file: ReviewMarksFile): string {
  return JSON.stringify(file, null, 2);
}

export function marksFor(file: ReviewMarksFile, root: string): ReviewMark[] {
  return file.repos[normalizeRoot(root)] ?? [];
}

const sameMark = (a: ReviewMark, b: ReviewMark) => a.source === b.source && a.path === b.path;

/** Add (replacing any prior mark for the same source+path) or remove one mark, capped. */
export function setMarkList(
  marks: readonly ReviewMark[],
  mark: ReviewMark,
  on: boolean,
): ReviewMark[] {
  const without = marks.filter((m) => !sameMark(m, mark));
  return on ? capped([mark, ...without]) : without;
}

export function setMark(
  file: ReviewMarksFile,
  root: string,
  mark: ReviewMark,
  on: boolean,
): ReviewMarksFile {
  const key = normalizeRoot(root);
  const next: ReviewMarksFile = { version: 1, repos: { ...file.repos } };
  const marks = setMarkList(next.repos[key] ?? [], mark, on);
  // An empty repo entry is noise in the file and in every broadcast that carries it.
  if (marks.length > 0) next.repos[key] = marks;
  else delete next.repos[key];
  return next;
}

/**
 * The paths that should read as reviewed: this source's marks whose file is LOADED and still
 * hashes to what it hashed to when marked. A file with no entry in `hashes` hasn't streamed in
 * yet — it is neither reviewed nor stale, because we can't tell.
 */
export function reviewedPaths(
  marks: readonly ReviewMark[],
  source: string,
  hashes: ReadonlyMap<string, string>,
): Set<string> {
  const out = new Set<string>();
  for (const m of marks) {
    if (m.source !== source) continue;
    if (hashes.get(m.path) === m.contentHash) out.add(m.path);
  }
  return out;
}

/** Marks whose loaded file has changed since — the renderer retires these (§2 Lane B). */
export function staleMarks(
  marks: readonly ReviewMark[],
  source: string,
  hashes: ReadonlyMap<string, string>,
): ReviewMark[] {
  return marks.filter((m) => {
    if (m.source !== source) return false;
    const h = hashes.get(m.path);
    return h !== undefined && h !== m.contentHash;
  });
}

/** Fold a `review:marks` push into the renderer's per-root map. Pushed roots are REPLACED
 *  wholesale (the host is authoritative); untouched roots survive. */
export function applyMarksPush(
  byRoot: ReadonlyMap<string, readonly ReviewMark[]>,
  repos: readonly ReviewMarksRepo[],
): Map<string, readonly ReviewMark[]> {
  const next = new Map(byRoot);
  for (const r of repos) next.set(normalizeRoot(r.root), r.marks);
  return next;
}

import type { PersistedDoc } from '../src/protocol';
import { moveBefore } from '../src/reorder';
import { displayTitleForUrl } from './web-url';

// 'web' is an in-app browser tab; its `path` is the URL (id = `web:<url>`). It has no
// backing file — the viewer renders straight from the URL — so it reuses the doc
// id/ownership/persistence machinery with no extra state.
// 'git-history' is the commit-graph view (git-history Slice A): one per session, scoped
// to that session's repo, with a sentinel path like review — no backing file. A selected
// commit's detail (message + changed files) renders INLINE in the history view's bottom
// pane, not as a tab.
// 'commit-diff' is a history-originated editor tab: one file's diff for a commit. It
// supports PREVIEW (a single reused tab that retargets on single-click) vs PINNED (a
// per-identity persistent tab on double-click). A preview doc's id is the sentinel
// `commit-diff:@preview` while its `path` carries the live target (`<sha> <file>`);
// pinning re-keys it to `commit-diff:${path}`.
export type DocKind = 'file' | 'diff' | 'review' | 'web' | 'git-history' | 'commit-diff';

// What the singleton Review tab is scoped to: the live working tree (default) or one
// commit's diff (vs. its first parent). Rides the review doc so the tab stays a singleton —
// the sha is NOT encoded in the doc id. See docs/specs/2026-06-29-review-commit-source.md §3.1.
export type ReviewSource = { kind: 'working' } | { kind: 'commit'; sha: string; subject?: string };

export interface OpenDoc {
  id: string; // `${kind}:${path}` (preview commit/commit-diff docs use `${kind}:@preview`)
  kind: DocKind;
  path: string;
  title: string;
  // The session that was active when this doc was opened. The doc is "owned" by it,
  // so it only shows while that session is active, and closing that session closes the
  // doc. Re-opening under a different session transfers ownership.
  sessionId: string;
  // A transient "preview" tab (italic, reused on single-click) — VS Code preview-tab
  // model, generalised across previewable kinds. For `commit-diff` the preview is the
  // `@preview` sentinel id and pinning re-keys it to its per-identity form; for `file`/
  // `diff` the id is already the stable identity (`${kind}:${path}`), so pinning just
  // clears this flag in place. `web`/`review`/`git-history` are never previewable. See
  // docs/specs/2026-06-27-editor-tab-behavior.md §3.1.
  preview?: boolean;
  // Review-only: which changeset the singleton Review tab is showing. Absent ⇒ working tree.
  // Never persisted (Review isn't a persisted doc); see review-commit-source spec §3.4.
  reviewSource?: ReviewSource;
}

// Whether a file-open opens a reusable preview tab (single-click / nav) or a permanent
// tab (double-click / OS open). See the entry-point classification in the spec §9.
export type OpenMode = 'preview' | 'permanent';

// The Review-changes view is a singleton editor tab (R5.5) rather than a center-pane
// overlay. It has no backing file, so it uses a sentinel path (the leading "@" can't
// collide with a real working-tree path) and a fixed, human title.
const REVIEW_DOC_PATH = '@review';
export const REVIEW_DOC_ID = `review:${REVIEW_DOC_PATH}`;
const REVIEW_DOC_TITLE = 'Review Changes';

// The git-history graph is a singleton center-pane doc (git-history Slice A), like Review:
// a sentinel path (the "@" can't collide with a real working-tree path), a fixed human
// title, and a single doc id whose ownership transfers to the session that opened it so
// it scopes to that session's repo.
export const GIT_HISTORY_DOC_PATH = '@git-history';
const GIT_HISTORY_DOC_TITLE = 'History';

// Preview-slot sentinel for the history-originated commit-diff tab: one preview doc whose
// `path` carries the live target while the tab stays put. A '@' leader can't collide with a
// real `<sha> <file>` target.
const PREVIEW_PATH = '@preview';
const previewId = (kind: 'commit-diff') => `${kind}:${PREVIEW_PATH}`;
const shortSha = (sha: string) => sha.slice(0, 7);
/** A commit-diff target encodes `<sha> <file>` in `path` (a sha never contains a space). */
const commitDiffPath = (sha: string, file: string) => `${sha} ${file}`;
export function parseCommitDiffPath(path: string): { sha: string; file: string } {
  const i = path.indexOf(' ');
  return i === -1 ? { sha: path, file: '' } : { sha: path.slice(0, i), file: path.slice(i + 1) };
}

export interface DocsState {
  docs: OpenDoc[];
  // The active doc for the CURRENTLY active session (null = that session's Terminal).
  activeId: string | null;
  // Per-session memory of the last active doc (id, or null for Terminal), so switching
  // away and back restores that session's view rather than leaking the other session's.
  activeBySession: Record<string, string | null>;
}

export type DocsAction =
  // `mode` (file/diff only) chooses a reusable preview tab vs a permanent one; defaults to
  // permanent so callers/kinds that don't opt in keep today's behavior.
  | { type: 'open'; kind: DocKind; path: string; sessionId: string; mode?: OpenMode }
  // Update a doc's tab label. Used by the web view to adopt the live page <title>.
  | { type: 'setTitle'; id: string; title: string }
  | { type: 'close'; id: string }
  | { type: 'closeSession'; sessionId: string }
  // `sessionId` records the choice as the session's remembered view; omit it only where
  // the owning session is unknown.
  | { type: 'activate'; id: string | null; sessionId?: string }
  // Restore the now-active session's remembered doc (a closed or transferred-away doc
  // falls back to the Terminal).
  | { type: 'switchSession'; sessionId: string }
  // Open one of a commit's file diffs (`commit-diff`) as an editor tab. `pin: false` =
  // reuse the preview slot (single-click); `pin: true` = a per-identity persistent tab
  // (double-click / keyboard Enter).
  | { type: 'openCommitFile'; sha: string; file: string; sessionId: string; pin: boolean }
  // Open/retarget the singleton Review tab to a source (working tree or a commit). Keeps the
  // stable REVIEW_DOC_ID so it stays a singleton; transfers ownership to `sessionId`.
  | { type: 'openReview'; sessionId: string; source: ReviewSource }
  // Promote a preview commit-diff tab to a pinned one (double-click the tab).
  | { type: 'pinDoc'; id: string }
  | { type: 'reorder'; dragId: string; targetId: string | null }
  // One-shot startup seed from persisted docs.json (editor-tabs-persist). Rebuilds docs[] +
  // activeBySession from `docs`, dropping any whose sessionId isn't in `knownSessionIds` (orphan).
  | { type: 'restore'; docs: PersistedDoc[]; knownSessionIds: string[] };

export const initialDocs: DocsState = { docs: [], activeId: null, activeBySession: {} };

const idOf = (kind: DocKind, path: string) => `${kind}:${path}`;
const titleOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

// A web doc's title starts as the URL's host/path (until the page <title> loads); a
// file/diff title is its basename; review has a fixed human title.
function initialTitle(kind: DocKind, path: string): string {
  if (kind === 'review') return REVIEW_DOC_TITLE;
  if (kind === 'git-history') return GIT_HISTORY_DOC_TITLE;
  if (kind === 'web') return displayTitleForUrl(path);
  if (kind === 'commit-diff') {
    const { sha, file } = parseCommitDiffPath(path);
    return `${titleOf(file)} @ ${shortSha(sha)}`;
  }
  return titleOf(path);
}

/**
 * Open-or-retarget a history-originated `commit-diff` tab. Already-pinned identity →
 * activate it. `pin` → promote the matching preview in place, else add a persistent tab.
 * Otherwise upsert the single preview slot (the tab stays put; only its target/title
 * change). `activeBySession` follows so a session-switch restores it.
 */
function openHistoryDoc(
  state: DocsState,
  kind: 'commit-diff',
  path: string,
  title: string,
  sessionId: string,
  pin: boolean,
): DocsState {
  const pinnedId = idOf(kind, path);
  const prevId = previewId(kind);
  const activeBySession = { ...state.activeBySession };

  if (state.docs.some((d) => d.id === pinnedId)) {
    activeBySession[sessionId] = pinnedId;
    return { ...state, activeId: pinnedId, activeBySession };
  }

  if (pin) {
    const prev = state.docs.find((d) => d.id === prevId);
    const docs: OpenDoc[] =
      prev && prev.path === path
        ? state.docs.map((d) =>
            d.id === prevId
              ? { ...d, id: pinnedId, kind, path, title, sessionId, preview: false }
              : d,
          )
        : [...state.docs, { id: pinnedId, kind, path, title, sessionId }];
    activeBySession[sessionId] = pinnedId;
    return { ...state, docs, activeId: pinnedId, activeBySession };
  }

  const exists = state.docs.some((d) => d.id === prevId);
  const docs: OpenDoc[] = exists
    ? state.docs.map((d) =>
        d.id === prevId ? { ...d, kind, path, title, sessionId, preview: true } : d,
      )
    : [...state.docs, { id: prevId, kind, path, title, sessionId, preview: true }];
  activeBySession[sessionId] = prevId;
  return { ...state, docs, activeId: prevId, activeBySession };
}

/** The remembered doc for a session, but only if it still exists AND is still owned by
 * that session (ownership can transfer on re-open); otherwise the Terminal (null). */
function rememberedDoc(docs: OpenDoc[], sessionId: string, id: string | null): string | null {
  if (id === null) return null;
  return docs.some((d) => d.id === id && d.sessionId === sessionId) ? id : null;
}

export function docsReducer(state: DocsState, action: DocsAction): DocsState {
  switch (action.type) {
    case 'open': {
      const id = idOf(action.kind, action.path);
      const previewable = action.kind === 'file' || action.kind === 'diff';
      const wantPreview = previewable && action.mode === 'preview';
      const activeBySession = { ...state.activeBySession, [action.sessionId]: id };
      if (state.docs.some((d) => d.id === id)) {
        // Transfer ownership to the current session so a later close of the original
        // opener won't yank a doc now in use here. A permanent open promotes the tab if it
        // was the preview (e.g. explorer double-click); a preview open never downgrades an
        // already-permanent tab.
        const docs = state.docs.map((d) =>
          d.id === id
            ? { ...d, sessionId: action.sessionId, ...(wantPreview ? {} : { preview: false }) }
            : d,
        );
        return { docs, activeId: id, activeBySession };
      }
      const newDoc: OpenDoc = {
        id,
        kind: action.kind,
        path: action.path,
        title: initialTitle(action.kind, action.path),
        sessionId: action.sessionId,
      };
      if (wantPreview) {
        // ≤1 preview per session: retarget the session's existing preview slot in place
        // (preserve its array index so the tab doesn't jump), else append a new one.
        const prevIdx = state.docs.findIndex(
          (d) =>
            d.sessionId === action.sessionId &&
            d.preview &&
            (d.kind === 'file' || d.kind === 'diff'),
        );
        const previewDoc: OpenDoc = { ...newDoc, preview: true };
        const docs =
          prevIdx === -1
            ? [...state.docs, previewDoc]
            : state.docs.map((d, i) => (i === prevIdx ? previewDoc : d));
        return { docs, activeId: id, activeBySession };
      }
      return { docs: [...state.docs, newDoc], activeId: id, activeBySession };
    }
    case 'setTitle': {
      const idx = state.docs.findIndex((d) => d.id === action.id);
      if (idx === -1 || state.docs[idx].title === action.title) return state;
      const title = action.title.trim();
      if (!title) return state;
      const docs = state.docs.map((d) => (d.id === action.id ? { ...d, title } : d));
      return { ...state, docs };
    }
    case 'closeSession': {
      const docs = state.docs.filter((d) => d.sessionId !== action.sessionId);
      const { [action.sessionId]: _gone, ...activeBySession } = state.activeBySession;
      if (docs.length === state.docs.length && !(action.sessionId in state.activeBySession)) {
        return state;
      }
      let activeId = state.activeId;
      if (activeId && !docs.some((d) => d.id === activeId)) {
        activeId = docs.length ? docs[docs.length - 1].id : null;
      }
      return { docs, activeId, activeBySession };
    }
    case 'close': {
      const idx = state.docs.findIndex((d) => d.id === action.id);
      if (idx === -1) return state;
      const closed = state.docs[idx];
      const docs = state.docs.filter((d) => d.id !== action.id);
      // Repoint the owning session's remembered doc to a sibling (or Terminal).
      const activeBySession = { ...state.activeBySession };
      if (activeBySession[closed.sessionId] === action.id) {
        const siblings = docs.filter((d) => d.sessionId === closed.sessionId);
        const prevInState = state.docs[idx - 1];
        const fallback =
          prevInState && prevInState.sessionId === closed.sessionId
            ? prevInState.id
            : (siblings[siblings.length - 1]?.id ?? null);
        activeBySession[closed.sessionId] = fallback;
      }
      let activeId = state.activeId;
      if (state.activeId === action.id) {
        const next = docs[idx - 1] ?? docs[idx] ?? null;
        activeId = next ? next.id : null;
      }
      return { docs, activeId, activeBySession };
    }
    case 'activate': {
      const activeBySession = { ...state.activeBySession };
      // Owner is the doc's session, or the caller-supplied session for the Terminal (id=null).
      const owner =
        action.id !== null
          ? state.docs.find((d) => d.id === action.id)?.sessionId
          : action.sessionId;
      if (owner !== undefined) activeBySession[owner] = action.id;
      return { ...state, activeId: action.id, activeBySession };
    }
    case 'switchSession': {
      const activeId = rememberedDoc(
        state.docs,
        action.sessionId,
        state.activeBySession[action.sessionId] ?? null,
      );
      return { ...state, activeId };
    }
    case 'openReview': {
      // Working source is canonically stored as ABSENT (label treats absent === working).
      const reviewSource = action.source.kind === 'working' ? undefined : action.source;
      const activeBySession = { ...state.activeBySession, [action.sessionId]: REVIEW_DOC_ID };
      if (state.docs.some((d) => d.id === REVIEW_DOC_ID)) {
        const docs = state.docs.map((d) =>
          d.id === REVIEW_DOC_ID ? { ...d, sessionId: action.sessionId, reviewSource } : d,
        );
        return { docs, activeId: REVIEW_DOC_ID, activeBySession };
      }
      const newDoc: OpenDoc = {
        id: REVIEW_DOC_ID,
        kind: 'review',
        path: REVIEW_DOC_PATH,
        title: REVIEW_DOC_TITLE,
        sessionId: action.sessionId,
        reviewSource,
      };
      return { docs: [...state.docs, newDoc], activeId: REVIEW_DOC_ID, activeBySession };
    }
    case 'openCommitFile':
      return openHistoryDoc(
        state,
        'commit-diff',
        commitDiffPath(action.sha, action.file),
        `${titleOf(action.file)} @ ${shortSha(action.sha)}`,
        action.sessionId,
        action.pin,
      );
    case 'pinDoc': {
      const doc = state.docs.find((d) => d.id === action.id);
      if (!doc?.preview) return state;
      // file/diff previews already carry their stable identity in the id, so promotion is
      // just clearing the flag in place — no re-key, no activeId/ownership churn.
      if (doc.kind !== 'commit-diff') {
        const docs = state.docs.map((d) => (d.id === action.id ? { ...d, preview: false } : d));
        return { ...state, docs };
      }
      const pinnedId = idOf(doc.kind, doc.path);
      // If a pinned tab for this identity already exists, drop the preview onto it; else
      // re-key the preview in place.
      const already = state.docs.some((d) => d.id === pinnedId);
      const docs = already
        ? state.docs.filter((d) => d.id !== action.id)
        : state.docs.map((d) => (d.id === action.id ? { ...d, id: pinnedId, preview: false } : d));
      const activeBySession = { ...state.activeBySession };
      for (const key of Object.keys(activeBySession)) {
        if (activeBySession[key] === action.id) activeBySession[key] = pinnedId;
      }
      const activeId = state.activeId === action.id ? pinnedId : state.activeId;
      return { ...state, docs, activeId, activeBySession };
    }
    case 'reorder': {
      const order = moveBefore(
        state.docs.map((d) => d.id),
        action.dragId,
        action.targetId,
      );
      const byId = new Map(state.docs.map((d) => [d.id, d]));
      return {
        ...state,
        docs: order.flatMap((id) => {
          const doc = byId.get(id);
          if (!doc) return [];
          // Dragging a preview tab promotes it (VS Code parity, spec §3.1).
          return [id === action.dragId && doc.preview ? { ...doc, preview: false } : doc];
        }),
      };
    }
    case 'restore': {
      const known = new Set(action.knownSessionIds);
      const docs: OpenDoc[] = [];
      const activeBySession: Record<string, string | null> = {};
      for (const pd of action.docs) {
        // File-only (D4) + drop orphans whose owning session didn't restore (spec §3.2).
        if (pd.kind !== 'file' || !known.has(pd.sessionId)) continue;
        const id = idOf('file', pd.path);
        docs.push({
          id,
          kind: 'file',
          path: pd.path,
          title: titleOf(pd.path),
          sessionId: pd.sessionId,
          ...(pd.preview ? { preview: true } : {}),
        });
        if (pd.active) activeBySession[pd.sessionId] = id;
      }
      // activeId stays null (Terminal) here; the renderer's switchSession effect resolves the
      // active session's remembered doc from activeBySession once a session is selected.
      return { docs, activeId: null, activeBySession };
    }
  }
}

/**
 * Derive the persisted-relevant slice of docState for docs.json (editor-tabs-persist). File docs
 * only (D4); each carries its preview flag and whether it is its session's remembered active doc.
 */
export function toPersistedDocs(state: DocsState): PersistedDoc[] {
  return state.docs
    .filter((d) => d.kind === 'file')
    .map((d) => ({
      kind: 'file' as const,
      path: d.path,
      sessionId: d.sessionId,
      ...(d.preview ? { preview: true } : {}),
      ...(state.activeBySession[d.sessionId] === d.id ? { active: true } : {}),
    }));
}

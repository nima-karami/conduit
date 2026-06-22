import { moveBefore } from '../src/reorder';
import { displayTitleForUrl } from './web-url';

// 'web' is an in-app browser tab; its `path` is the URL (id = `web:<url>`). It has no
// backing file — the viewer renders straight from the URL — so it reuses the doc
// id/ownership/persistence machinery with no extra state.
// 'git-history' is the commit-graph view (git-history Slice A): one per session, scoped
// to that session's repo, with a sentinel path like review — no backing file.
// 'commit' / 'commit-diff' are history-originated editor tabs: a commit's message+files,
// and one file's diff for a commit. Both support PREVIEW (a single reused tab per kind
// that retargets on single-click) vs PINNED (a per-identity persistent tab on double-
// click). A preview doc's id is the sentinel `${kind}:@preview` while its `path` carries
// the live target (a sha, or `<sha> <file>`); pinning re-keys it to `${kind}:${path}`.
export type DocKind = 'file' | 'diff' | 'review' | 'web' | 'git-history' | 'commit' | 'commit-diff';

export interface OpenDoc {
  id: string; // `${kind}:${path}` (preview commit/commit-diff docs use `${kind}:@preview`)
  kind: DocKind;
  path: string;
  title: string;
  // The session that was active when this doc was opened. The doc is "owned" by it,
  // so it only shows while that session is active, and closing that session closes the
  // doc. Re-opening under a different session transfers ownership.
  sessionId: string;
  // commit / commit-diff only: a transient "preview" tab (italic, reused on single-click).
  // Pinning (double-click) clears this and re-keys the id to its per-identity form.
  preview?: boolean;
}

// The Review-changes view is a singleton editor tab (R5.5) rather than a center-pane
// overlay. It has no backing file, so it uses a sentinel path (the leading "@" can't
// collide with a real working-tree path) and a fixed, human title.
export const REVIEW_DOC_PATH = '@review';
export const REVIEW_DOC_ID = `review:${REVIEW_DOC_PATH}`;
const REVIEW_DOC_TITLE = 'Review Changes';

// The git-history graph is a singleton center-pane doc (git-history Slice A), like Review:
// a sentinel path (the "@" can't collide with a real working-tree path), a fixed human
// title, and a single doc id whose ownership transfers to the session that opened it so
// it scopes to that session's repo.
export const GIT_HISTORY_DOC_PATH = '@git-history';
const GIT_HISTORY_DOC_TITLE = 'History';

// Preview-slot sentinel for the history-originated commit / commit-diff tabs: one preview
// doc per kind, whose `path` carries the live target while the tab stays put. A '@' leader
// can't collide with a real sha / `<sha> <file>` target.
const PREVIEW_PATH = '@preview';
const previewId = (kind: 'commit' | 'commit-diff') => `${kind}:${PREVIEW_PATH}`;
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
  | { type: 'open'; kind: DocKind; path: string; sessionId: string }
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
  // Open a commit's detail (`commit`) or one of its file diffs (`commit-diff`) as an
  // editor tab. `pin: false` = reuse the kind's preview slot (single-click); `pin: true`
  // = a per-identity persistent tab (double-click / keyboard Enter).
  | { type: 'openCommit'; sha: string; sessionId: string; pin: boolean }
  | { type: 'openCommitFile'; sha: string; file: string; sessionId: string; pin: boolean }
  // Promote a preview commit / commit-diff tab to a pinned one (double-click the tab).
  | { type: 'pinDoc'; id: string }
  | { type: 'reorder'; dragId: string; targetId: string | null };

export const initialDocs: DocsState = { docs: [], activeId: null, activeBySession: {} };

const idOf = (kind: DocKind, path: string) => `${kind}:${path}`;
const titleOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

// A web doc's title starts as the URL's host/path (until the page <title> loads); a
// file/diff title is its basename; review has a fixed human title.
function initialTitle(kind: DocKind, path: string): string {
  if (kind === 'review') return REVIEW_DOC_TITLE;
  if (kind === 'git-history') return GIT_HISTORY_DOC_TITLE;
  if (kind === 'web') return displayTitleForUrl(path);
  if (kind === 'commit') return shortSha(path);
  if (kind === 'commit-diff') {
    const { sha, file } = parseCommitDiffPath(path);
    return `${titleOf(file)} @ ${shortSha(sha)}`;
  }
  return titleOf(path);
}

/**
 * Open-or-retarget a history-originated tab (`commit` / `commit-diff`). Already-pinned
 * identity → activate it. `pin` → promote the matching preview in place, else add a
 * persistent tab. Otherwise upsert the kind's single preview slot (the tab stays put;
 * only its target/title change). `activeBySession` follows so a session-switch restores it.
 */
function openHistoryDoc(
  state: DocsState,
  kind: 'commit' | 'commit-diff',
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
      const activeBySession = { ...state.activeBySession, [action.sessionId]: id };
      if (state.docs.some((d) => d.id === id)) {
        // Transfer ownership to the current session so a later close of the original
        // opener won't yank a doc now in use here.
        const docs = state.docs.map((d) =>
          d.id === id ? { ...d, sessionId: action.sessionId } : d,
        );
        return { docs, activeId: id, activeBySession };
      }
      const doc: OpenDoc = {
        id,
        kind: action.kind,
        path: action.path,
        title: initialTitle(action.kind, action.path),
        sessionId: action.sessionId,
      };
      return { docs: [...state.docs, doc], activeId: id, activeBySession };
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
    case 'openCommit':
      return openHistoryDoc(
        state,
        'commit',
        action.sha,
        shortSha(action.sha),
        action.sessionId,
        action.pin,
      );
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
      if (!doc?.preview || (doc.kind !== 'commit' && doc.kind !== 'commit-diff')) return state;
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
          return doc ? [doc] : [];
        }),
      };
    }
  }
}

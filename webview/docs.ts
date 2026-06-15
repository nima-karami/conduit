import { moveBefore } from '../src/reorder';

export type DocKind = 'file' | 'diff' | 'review';

export interface OpenDoc {
  id: string; // `${kind}:${path}`
  kind: DocKind;
  path: string;
  title: string;
  // The session that was active when this doc was opened. The doc is "owned" by it,
  // so it only shows while that session is active, and closing that session closes the
  // doc. Re-opening under a different session transfers ownership.
  sessionId: string;
}

// The Review-changes view is a singleton editor tab (R5.5) rather than a center-pane
// overlay. It has no backing file, so it uses a sentinel path (the leading "@" can't
// collide with a real working-tree path) and a fixed, human title.
export const REVIEW_DOC_PATH = '@review';
export const REVIEW_DOC_ID = `review:${REVIEW_DOC_PATH}`;
const REVIEW_DOC_TITLE = 'Review Changes';

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
  | { type: 'close'; id: string }
  | { type: 'closeSession'; sessionId: string }
  // Make a doc (or the Terminal, id=null) active. `sessionId` records the choice as the
  // session's remembered view; omit it only where the owning session is unknown.
  | { type: 'activate'; id: string | null; sessionId?: string }
  // The active session changed: restore that session's remembered doc (validated — a
  // closed or transferred-away doc falls back to the Terminal).
  | { type: 'switchSession'; sessionId: string }
  | { type: 'reorder'; dragId: string; targetId: string | null };

export const initialDocs: DocsState = { docs: [], activeId: null, activeBySession: {} };

const idOf = (kind: DocKind, path: string) => `${kind}:${path}`;
const titleOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

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
        // Already open: re-activate, and transfer ownership to the current session
        // so a later close of the original opener won't yank a doc now in use here.
        const docs = state.docs.map((d) =>
          d.id === id ? { ...d, sessionId: action.sessionId } : d,
        );
        return { docs, activeId: id, activeBySession };
      }
      const doc: OpenDoc = {
        id,
        kind: action.kind,
        path: action.path,
        title: action.kind === 'review' ? REVIEW_DOC_TITLE : titleOf(action.path),
        sessionId: action.sessionId,
      };
      return { docs: [...state.docs, doc], activeId: id, activeBySession };
    }
    case 'closeSession': {
      // Close every doc owned by a removed session and forget its remembered view. If
      // the active doc was among them, fall back to the last remaining doc, or Terminal.
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
      // Record the choice under its session: derive the owner from the doc, or use the
      // caller-supplied session for the Terminal (id=null).
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

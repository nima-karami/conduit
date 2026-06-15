import { moveBefore } from '../src/reorder';

export type DocKind = 'file' | 'diff' | 'review';

export interface OpenDoc {
  id: string; // `${kind}:${path}`
  kind: DocKind;
  path: string;
  title: string;
  // The session that was active when this doc was opened. The doc is "owned" by it,
  // so closing that session closes the doc (rather than orphaning it onto another
  // session). Re-opening under a different session transfers ownership.
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
  activeId: string | null; // null = the Terminal tab
}

export type DocsAction =
  | { type: 'open'; kind: DocKind; path: string; sessionId: string }
  | { type: 'close'; id: string }
  | { type: 'closeSession'; sessionId: string }
  | { type: 'activate'; id: string | null }
  | { type: 'reorder'; dragId: string; targetId: string | null };

export const initialDocs: DocsState = { docs: [], activeId: null };

const idOf = (kind: DocKind, path: string) => `${kind}:${path}`;
const titleOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

export function docsReducer(state: DocsState, action: DocsAction): DocsState {
  switch (action.type) {
    case 'open': {
      const id = idOf(action.kind, action.path);
      if (state.docs.some((d) => d.id === id)) {
        // Already open: re-activate, and transfer ownership to the current session
        // so a later close of the original opener won't yank a doc now in use here.
        const docs = state.docs.map((d) =>
          d.id === id ? { ...d, sessionId: action.sessionId } : d,
        );
        return { docs, activeId: id };
      }
      const doc: OpenDoc = {
        id,
        kind: action.kind,
        path: action.path,
        title: action.kind === 'review' ? REVIEW_DOC_TITLE : titleOf(action.path),
        sessionId: action.sessionId,
      };
      return { docs: [...state.docs, doc], activeId: id };
    }
    case 'closeSession': {
      // Close every doc owned by a removed session. If the active doc was among
      // them, fall back to the last remaining doc, or the terminal (null).
      const docs = state.docs.filter((d) => d.sessionId !== action.sessionId);
      if (docs.length === state.docs.length) return state;
      let activeId = state.activeId;
      if (activeId && !docs.some((d) => d.id === activeId)) {
        activeId = docs.length ? docs[docs.length - 1].id : null;
      }
      return { docs, activeId };
    }
    case 'close': {
      const idx = state.docs.findIndex((d) => d.id === action.id);
      if (idx === -1) return state;
      const docs = state.docs.filter((d) => d.id !== action.id);
      let activeId = state.activeId;
      if (state.activeId === action.id) {
        const next = docs[idx - 1] ?? docs[idx] ?? null;
        activeId = next ? next.id : null;
      }
      return { docs, activeId };
    }
    case 'activate':
      return { ...state, activeId: action.id };
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

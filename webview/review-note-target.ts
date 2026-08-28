// "Open Review at this note" — the one signal the editor's glyph needs to send to a view it does
// not own. A tiny external store rather than a prop chain through app → center-pane → doc-view,
// mirroring webview/save-registry.ts. The nonce is what makes clicking the SAME note twice work.

export interface NoteTarget {
  path: string;
  line: number;
  noteId: string;
  nonce: number;
}

type Listener = () => void;

let target: NoteTarget | null = null;
const listeners = new Set<Listener>();
let nonce = 0;

export function subscribeNoteTarget(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getNoteTarget(): NoteTarget | null {
  return target;
}

export function setNoteTarget(t: Omit<NoteTarget, 'nonce'>): void {
  nonce += 1;
  target = { ...t, nonce };
  listeners.forEach((l) => {
    l();
  });
}

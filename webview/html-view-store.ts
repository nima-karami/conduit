export type HtmlView = 'preview' | 'source';

type Listener = () => void;

interface HtmlDocState {
  view?: HtmlView;
  reload: number;
  scroll: number;
}

const states = new Map<string, HtmlDocState>();
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((l) => {
    l();
  });
}

function stateFor(docId: string): HtmlDocState {
  let s = states.get(docId);
  if (!s) {
    s = { reload: 0, scroll: 0 };
    states.set(docId, s);
  }
  return s;
}

export function getHtmlView(docId: string, fallback: HtmlView): HtmlView {
  return states.get(docId)?.view ?? fallback;
}

export function setHtmlView(docId: string, view: HtmlView): void {
  const s = stateFor(docId);
  if (s.view === view) return;
  s.view = view;
  notify();
}

export function toggleHtmlView(docId: string, fallback: HtmlView): HtmlView {
  const next: HtmlView = getHtmlView(docId, fallback) === 'preview' ? 'source' : 'preview';
  setHtmlView(docId, next);
  return next;
}

/** Force the guest to re-fetch. Bumps a nonce the viewer watches. */
export function bumpHtmlReload(docId: string): void {
  stateFor(docId).reload += 1;
  notify();
}

export function getHtmlReload(docId: string): number {
  return states.get(docId)?.reload ?? 0;
}

/** Scroll offset, persisted per doc so it survives BOTH a reload and a tab switch. A tab switch
 *  destroys the guest process outright — center-pane.tsx keys DocView on activeDoc.id and renders
 *  only the active doc — so without this the reader loses their place on every switch. */
export function getHtmlScroll(docId: string): number {
  return states.get(docId)?.scroll ?? 0;
}

export function setHtmlScroll(docId: string, y: number): void {
  const s = stateFor(docId);
  if (s.scroll === y) return;
  s.scroll = y;
  notify();
}

/** Drop a closed doc's entry — called from app.tsx's doc-close path. */
export function clearHtmlView(docId: string): void {
  if (!states.delete(docId)) return;
  notify();
}

export function subscribeHtmlView(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

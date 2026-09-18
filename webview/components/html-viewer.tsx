import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { PreviewReason } from '../../src/preview-url';
import type { FileContentDTO, HostToWebview } from '../../src/protocol';
import { openExternal, post, subscribe } from '../bridge';
import { buildHtmlMenuItems } from '../html-menu';
import {
  bumpHtmlReload,
  getHtmlReload,
  getHtmlScroll,
  getHtmlView,
  type HtmlView,
  setHtmlScroll,
  setHtmlView,
  subscribeHtmlView,
} from '../html-view-store';
import { IconDoc } from '../icons';
import { CodeViewer } from './code-viewer';
import { ContextMenu, type MenuItem, type MenuState } from './context-menu';
import { EmptyState } from './empty-state';
import { MdFindBar } from './md-find-bar';

const HTML_VIEWER_STRINGS = {
  viewSource: 'View source',
  viewRendered: 'View rendered',
  toggleAria: 'Rendered page',
  reload: 'Reload',
  reloadAria: 'Reload preview',
  find: 'Find',
  findAria: 'Find in page',
  openExternally: 'Open externally',
  back: 'Back',
  backAria: 'Back to the previous page',
  reveal: 'Reveal in Explorer',
  emptyTitle: 'Empty document',
  emptyHint: 'This file is empty.',
  dirtyNotice: 'Showing the saved file — you have unsaved changes.',
  saveAndReload: 'Save and reload',
  allowLead: (host: string) => `This page wants to load resources from ${host}.`,
  allow: 'Allow',
  dismiss: 'Dismiss',
  loadFailed: 'This page didn’t load.',
  attachFailed: 'Preview is unavailable in this build.',
  attachFailedHint: 'The preview could not start. Copy the diagnostics from Settings to report it.',
  crashed: 'The preview stopped responding.',
  blocked: 'Preview is only available for files inside an opened folder.',
  unsupported: 'Preview is not available for this location.',
  missing: 'This file no longer exists.',
  tooLarge: 'This page is too large to preview.',
  unreadable: 'This file can’t be read.',
  saidRendered: 'Showing rendered page',
  saidSource: 'Showing HTML source',
  saidReloaded: 'Preview reloaded',
  saidBlocked: (host: string) => `Blocked a request to ${host}`,
} as const;

/** A guest that never reaches this state was refused at `will-attach-webview`, which emits no
 *  event of any kind — silence is the only signal the renderer gets for a page-level failure. */
const GUEST_ATTACH_TIMEOUT_MS = 5000;

/** The subset of Electron's `<webview>` element API this component drives. */
interface PreviewGuest extends HTMLElement {
  src: string;
  getWebContentsId(): number;
  canGoBack(): boolean;
  goBack(): void;
  reload(): void;
  copy(): void;
  selectAll(): void;
  executeJavaScript(code: string): Promise<unknown>;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
}

interface GuestFailEvent extends Event {
  errorCode: number;
  errorDescription: string;
  isMainFrame: boolean;
}

interface GuestFoundEvent extends Event {
  result: { activeMatchOrdinal: number; matches: number };
}

interface GuestContextMenuEvent extends Event {
  params: { x: number; y: number; linkURL: string; selectionText: string };
}

type Verdict = { ok: true; url: string } | { ok: false; reason: PreviewReason; detail?: string };

/** The host messages addressed to one guest by its `webContentsId`. */
type GuestNotice = Extract<HostToWebview, { type: 'html:networkBlocked' | 'html:guestKey' }>;

let requestSeq = 0;

export function HtmlViewer({
  doc,
  docId,
  fallbackView,
  dirty,
  onOpenExternally,
  onSave,
}: {
  doc: FileContentDTO;
  docId: string;
  fallbackView: HtmlView;
  dirty: boolean;
  onOpenExternally: (path: string) => void;
  onSave: () => void;
}) {
  const ref = useRef<PreviewGuest | null>(null);
  const chromeRef = useRef<HTMLButtonElement | null>(null);
  const guestIdRef = useRef<number | null>(null);
  const pendingNoticesRef = useRef<GuestNotice[]>([]);

  const view = useSyncExternalStore(
    subscribeHtmlView,
    useCallback(() => getHtmlView(docId, fallbackView), [docId, fallbackView]),
  );
  const reloadNonce = useSyncExternalStore(
    subscribeHtmlView,
    useCallback(() => getHtmlReload(docId), [docId]),
  );

  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [attached, setAttached] = useState(false);
  const [attachTimedOut, setAttachTimedOut] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<{ code: number; desc: string } | null>(null);
  const [crashed, setCrashed] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [blockedHost, setBlockedHost] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findFocus, setFindFocus] = useState(0);
  const [findStats, setFindStats] = useState({ ordinal: 0, count: 0 });
  const [said, setSaid] = useState('');

  const guestUrl = verdict?.ok ? verdict.url : null;

  const openFind = useCallback(() => {
    setFindOpen(true);
    setFindFocus((n) => n + 1);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindStats({ ordinal: 0, count: 0 });
    ref.current?.stopFindInPage('clearSelection');
  }, []);

  const focusChrome = useCallback(() => chromeRef.current?.focus(), []);

  const showView = useCallback(
    (next: HtmlView) => {
      setHtmlView(docId, next);
      setSaid(
        next === 'source' ? HTML_VIEWER_STRINGS.saidSource : HTML_VIEWER_STRINGS.saidRendered,
      );
    },
    [docId],
  );

  // The guest is a separate process, so even at a synchronous capture point this read is async;
  // one that loses the race with the guest's teardown has no scroll left to record.
  const captureScroll = useCallback(() => {
    void ref.current?.executeJavaScript('window.scrollY').then(
      (y) => {
        if (typeof y === 'number') setHtmlScroll(docId, y);
      },
      () => undefined,
    );
  }, [docId]);

  useEffect(() => {
    const requestId = `html:${++requestSeq}`;
    setVerdict(null);
    const unsub = subscribe((msg) => {
      if (msg.type !== 'html:canPreviewResult' || msg.requestId !== requestId) return;
      setVerdict(msg.result);
    });
    post({ type: 'html:canPreview', requestId, path: doc.path });
    return unsub;
  }, [doc.path]);

  const applyGuestNotice = useCallback(
    (msg: GuestNotice) => {
      if (msg.type === 'html:networkBlocked') {
        setBlockedHost(msg.host);
        setSaid(HTML_VIEWER_STRINGS.saidBlocked(msg.host));
      } else if (msg.key === 'Escape') focusChrome();
      else openFind();
    },
    [focusChrome, openFind],
  );

  // A page that loads a CDN asset at parse time is cancelled — and reported — before the guest
  // has attached, so its id is not yet knowable and the notice cannot be matched. Holding those
  // and replaying them here DEFERS the guest filter; it never widens it. One that turns out to
  // belong to another guest (Conduit is multi-window, one preview session) is still discarded.
  const adoptGuestId = useCallback(
    (guestId: number) => {
      if (guestIdRef.current === guestId) return;
      guestIdRef.current = guestId;
      const held = pendingNoticesRef.current;
      pendingNoticesRef.current = [];
      for (const msg of held) if (msg.guestId === guestId) applyGuestNotice(msg);
    },
    [applyGuestNotice],
  );

  useEffect(
    () =>
      subscribe((msg) => {
        if (msg.type !== 'html:networkBlocked' && msg.type !== 'html:guestKey') return;
        if (guestIdRef.current === null) {
          pendingNoticesRef.current.push(msg);
          return;
        }
        if (msg.guestId !== guestIdRef.current) return;
        applyGuestNotice(msg);
      }),
    [applyGuestNotice],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: guestUrl is the reset trigger — a new URL is a new guest
  useEffect(() => {
    guestIdRef.current = null;
    pendingNoticesRef.current = [];
    setAttached(false);
    setAttachTimedOut(false);
    setLoaded(false);
    setFailure(null);
    setCrashed(false);
    setCanBack(false);
  }, [guestUrl]);

  useEffect(() => {
    if (!guestUrl || attached) return;
    const timer = setTimeout(() => setAttachTimedOut(true), GUEST_ATTACH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [guestUrl, attached]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !guestUrl) return;

    const onStart = () => setAttached(true);
    // `did-attach` is the earliest point `getWebContentsId()` is valid, and it precedes
    // `dom-ready` — which the page's own parse-time requests do not. `onReady` adopts it too so
    // a missed `did-attach` still converges.
    const onAttach = () => {
      setAttached(true);
      adoptGuestId(el.getWebContentsId());
    };
    const onReady = () => {
      setAttached(true);
      const guestId = el.getWebContentsId();
      adoptGuestId(guestId);
      post({ type: 'html:guestReady', docId, guestId });
    };
    const onFinish = () => {
      setLoaded(true);
      const y = getHtmlScroll(docId);
      if (y > 0) void el.executeJavaScript(`window.scrollTo(0, ${y})`);
    };
    const onFail = (e: Event) => {
      const f = e as GuestFailEvent;
      if (!f.isMainFrame || f.errorCode === -3) return;
      setLoaded(true);
      setFailure({ code: f.errorCode, desc: f.errorDescription });
    };
    // `render-process-gone`, not `crashed`: WebviewTag lost the `crashed` event in Electron 22,
    // so a `crashed` listener would be dead code that never fires (electron.d.ts:19803).
    const onGone = () => setCrashed(true);
    const onNavigate = () => setCanBack(el.canGoBack());
    const onFound = (e: Event) => {
      const { result } = e as GuestFoundEvent;
      setFindStats({ ordinal: result.activeMatchOrdinal, count: result.matches });
    };
    // `context-menu` IS exposed as a DOM event on the element, while `before-input-event` is
    // not — which is why the menu is built here and the guest's keys have to ride an IPC
    // message from the host instead.
    const onMenu = (e: Event) => {
      const { params } = e as GuestContextMenuEvent;
      const items: MenuItem[] = buildHtmlMenuItems({
        hasSelection: params.selectionText.length > 0,
        linkURL: params.linkURL,
      }).map((spec) => ({
        label: spec.label,
        disabled: spec.disabled,
        separatorBefore: spec.separatorBefore,
        onClick: () => {
          if (spec.action === 'copy') el.copy();
          else if (spec.action === 'selectAll') el.selectAll();
          else if (spec.action === 'copyLink') void navigator.clipboard.writeText(params.linkURL);
          else if (spec.action === 'openLink') openExternal(params.linkURL);
          else if (spec.action === 'find') openFind();
          else if (spec.action === 'reload') bumpHtmlReload(docId);
          else showView('source');
        },
      }));
      // The guest reports its OWN viewport coordinates; the menu positions in the host's.
      const rect = el.getBoundingClientRect();
      setMenu({ x: rect.left + params.x, y: rect.top + params.y, items });
    };

    el.addEventListener('did-attach', onAttach);
    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('dom-ready', onReady);
    el.addEventListener('did-finish-load', onFinish);
    el.addEventListener('did-fail-load', onFail);
    el.addEventListener('render-process-gone', onGone);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('found-in-page', onFound);
    el.addEventListener('context-menu', onMenu);
    return () => {
      el.removeEventListener('did-attach', onAttach);
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('dom-ready', onReady);
      el.removeEventListener('did-finish-load', onFinish);
      el.removeEventListener('did-fail-load', onFail);
      el.removeEventListener('render-process-gone', onGone);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('found-in-page', onFound);
      el.removeEventListener('context-menu', onMenu);
    };
  }, [guestUrl, docId, adoptGuestId, openFind, showView]);

  // Keyed on the store's nonce, never on `doc.content`: readFile truncates at 2 MB
  // (src/file-service.ts:17), so content is an unreliable change signal for a document.
  const firstReloadRef = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is the trigger, not a value the body reads
  useEffect(() => {
    if (firstReloadRef.current) {
      firstReloadRef.current = false;
      return;
    }
    if (!ref.current) return;
    captureScroll();
    ref.current.reload();
    setSaid(HTML_VIEWER_STRINGS.saidReloaded);
  }, [reloadNonce, captureScroll]);

  // Scroll is written at capture points only — a write per scroll tick would re-render every
  // subscriber of the store. Layout cleanup, not passive: a passive cleanup runs after React
  // has detached the element, and the read would never resolve.
  useLayoutEffect(() => captureScroll, [captureScroll]);

  const runFind = useCallback((q: string, findNext: boolean, forward = true) => {
    const el = ref.current;
    if (!el) return;
    if (q.trim() === '') {
      el.stopFindInPage('clearSelection');
      setFindStats({ ordinal: 0, count: 0 });
      return;
    }
    el.findInPage(q, { findNext, forward });
  }, []);

  const allowNetwork = () => {
    const guestId = guestIdRef.current;
    if (guestId !== null) post({ type: 'html:setNetworkAllowed', guestId, allowed: true });
    setBlockedHost(null);
    bumpHtmlReload(docId);
  };

  const toggle = (label: string, pressed: boolean, onClick: () => void, disabledTitle?: string) => (
    <button
      ref={chromeRef}
      type="button"
      className="viewer__toggle"
      aria-pressed={pressed}
      aria-label={HTML_VIEWER_STRINGS.toggleAria}
      disabled={disabledTitle !== undefined}
      title={disabledTitle}
      onClick={onClick}
    >
      {label}
    </button>
  );

  const live = (
    <div className="sr-only" role="status" aria-live="polite">
      {said}
    </div>
  );

  // §8 answers `blocked` and `unsupported` with the SOURCE view plus an explanation, so the
  // refusal overrides the stored view rather than rendering a pane with nothing in it.
  const forcedSource =
    verdict !== null &&
    !verdict.ok &&
    (verdict.reason === 'blocked' || verdict.reason === 'unsupported');

  if (view === 'source' || forcedSource) {
    const why = !forcedSource
      ? null
      : verdict.reason === 'blocked'
        ? HTML_VIEWER_STRINGS.blocked
        : HTML_VIEWER_STRINGS.unsupported;
    return (
      // Source view IS code, so it re-inks itself out of the document page DocView put it on.
      <div className="viewer inkbox">
        <div className="viewer__controls">
          {toggle(
            HTML_VIEWER_STRINGS.viewRendered,
            false,
            () => showView('preview'),
            why ?? undefined,
          )}
        </div>
        <CodeViewer doc={doc} viewStateId={`html-source:${doc.path}`} />
        {why && (
          <div className="htmlview__bar">
            <span className="htmlview__bar-text">{why}</span>
            <button
              type="button"
              className="viewer__notice-action"
              onClick={() => onOpenExternally(doc.path)}
            >
              {HTML_VIEWER_STRINGS.openExternally}
            </button>
          </div>
        )}
        {live}
      </div>
    );
  }

  return (
    <div className="viewer">
      <div className="viewer__controls">
        {canBack && (
          <button
            type="button"
            className="viewer__toggle"
            aria-label={HTML_VIEWER_STRINGS.backAria}
            onClick={() => ref.current?.goBack()}
          >
            {HTML_VIEWER_STRINGS.back}
          </button>
        )}
        {toggle(HTML_VIEWER_STRINGS.viewSource, true, () => showView('source'))}
        <button
          type="button"
          className="viewer__toggle"
          aria-label={HTML_VIEWER_STRINGS.reloadAria}
          onClick={() => bumpHtmlReload(docId)}
        >
          {HTML_VIEWER_STRINGS.reload}
        </button>
        <button
          type="button"
          className="viewer__toggle"
          aria-label={HTML_VIEWER_STRINGS.findAria}
          onClick={openFind}
        >
          {HTML_VIEWER_STRINGS.find}
        </button>
        <button type="button" className="viewer__toggle" onClick={() => onOpenExternally(doc.path)}>
          {HTML_VIEWER_STRINGS.openExternally}
        </button>
      </div>

      {findOpen && (
        <MdFindBar
          query={findQuery}
          ordinal={findStats.ordinal}
          count={findStats.count}
          focusNonce={findFocus}
          onQueryChange={(q) => {
            setFindQuery(q);
            runFind(q, false);
          }}
          onNext={() => runFind(findQuery, true, true)}
          onPrev={() => runFind(findQuery, true, false)}
          onClose={closeFind}
        />
      )}

      <div className="htmlview__body">
        <PreviewBody
          docPath={doc.path}
          empty={doc.content.trim() === ''}
          verdict={verdict}
          guestUrl={guestUrl}
          guestRef={ref}
          loaded={loaded}
          crashed={crashed}
          failure={failure}
          attachTimedOut={attachTimedOut}
          onViewSource={() => showView('source')}
          onReload={() => bumpHtmlReload(docId)}
          onOpenExternally={onOpenExternally}
        />
      </div>

      {/* Below the page, not above it: `.viewer__controls` floats over the pane's top-right, so
          a bar stacked above the guest would have the control row sitting on its actions. */}
      {dirty && (
        <div className="htmlview__bar">
          <span className="htmlview__bar-text">{HTML_VIEWER_STRINGS.dirtyNotice}</span>
          <button
            type="button"
            className="viewer__notice-action"
            onClick={() => {
              onSave();
              bumpHtmlReload(docId);
            }}
          >
            {HTML_VIEWER_STRINGS.saveAndReload}
          </button>
        </div>
      )}

      {blockedHost !== null && (
        <div
          className="htmlview__bar"
          role="status"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setBlockedHost(null);
          }}
        >
          <span className="htmlview__bar-text" title={blockedHost}>
            {HTML_VIEWER_STRINGS.allowLead(blockedHost)}
          </span>
          <button type="button" className="viewer__notice-action" onClick={allowNetwork}>
            {HTML_VIEWER_STRINGS.allow}
          </button>
          <button
            type="button"
            className="viewer__notice-action"
            onClick={() => setBlockedHost(null)}
          >
            {HTML_VIEWER_STRINGS.dismiss}
          </button>
        </div>
      )}

      {live}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function PreviewBody({
  docPath,
  empty,
  verdict,
  guestUrl,
  guestRef,
  loaded,
  crashed,
  failure,
  attachTimedOut,
  onViewSource,
  onReload,
  onOpenExternally,
}: {
  docPath: string;
  empty: boolean;
  verdict: Verdict | null;
  guestUrl: string | null;
  guestRef: React.RefObject<PreviewGuest | null>;
  loaded: boolean;
  crashed: boolean;
  failure: { code: number; desc: string } | null;
  attachTimedOut: boolean;
  onViewSource: () => void;
  onReload: () => void;
  onOpenExternally: (path: string) => void;
}) {
  if (empty) {
    return (
      <EmptyState
        variant="inline"
        icon={<IconDoc size={26} />}
        title={HTML_VIEWER_STRINGS.emptyTitle}
        hint={HTML_VIEWER_STRINGS.emptyHint}
        action={
          <button type="button" className="viewer__notice-action" onClick={onViewSource}>
            {HTML_VIEWER_STRINGS.viewSource}
          </button>
        }
      />
    );
  }

  if (verdict !== null && !verdict.ok) {
    const title =
      verdict.reason === 'missing'
        ? HTML_VIEWER_STRINGS.missing
        : verdict.reason === 'too-large'
          ? HTML_VIEWER_STRINGS.tooLarge
          : HTML_VIEWER_STRINGS.unreadable;
    return (
      <Panel title={title} detail={verdict.detail}>
        <button type="button" className="viewer__notice-action" onClick={onViewSource}>
          {HTML_VIEWER_STRINGS.viewSource}
        </button>
        {verdict.reason === 'missing' ? (
          <button
            type="button"
            className="viewer__notice-action"
            onClick={() => post({ type: 'revealInExplorer', path: docPath })}
          >
            {HTML_VIEWER_STRINGS.reveal}
          </button>
        ) : (
          <button
            type="button"
            className="viewer__notice-action"
            onClick={() => onOpenExternally(docPath)}
          >
            {HTML_VIEWER_STRINGS.openExternally}
          </button>
        )}
      </Panel>
    );
  }

  if (guestUrl === null) return <div className="htmlview__skeleton" aria-hidden />;

  return (
    <>
      <webview
        ref={guestRef as React.Ref<HTMLElement>}
        className="htmlview__frame"
        partition="conduit-preview"
        src={guestUrl}
      />
      {!loaded && !crashed && !failure && !attachTimedOut && (
        <div className="htmlview__skeleton" aria-hidden />
      )}
      {attachTimedOut && (
        <Panel
          title={HTML_VIEWER_STRINGS.attachFailed}
          detail={HTML_VIEWER_STRINGS.attachFailedHint}
        >
          <button type="button" className="viewer__notice-action" onClick={onViewSource}>
            {HTML_VIEWER_STRINGS.viewSource}
          </button>
          <button
            type="button"
            className="viewer__notice-action"
            onClick={() => onOpenExternally(docPath)}
          >
            {HTML_VIEWER_STRINGS.openExternally}
          </button>
        </Panel>
      )}
      {crashed && (
        <Panel title={HTML_VIEWER_STRINGS.crashed}>
          <button type="button" className="viewer__notice-action" onClick={onReload}>
            {HTML_VIEWER_STRINGS.reload}
          </button>
        </Panel>
      )}
      {failure && !crashed && (
        <Panel title={HTML_VIEWER_STRINGS.loadFailed} detail={`${failure.desc} (${failure.code})`}>
          <button type="button" className="viewer__notice-action" onClick={onReload}>
            {HTML_VIEWER_STRINGS.reload}
          </button>
          <button type="button" className="viewer__notice-action" onClick={onViewSource}>
            {HTML_VIEWER_STRINGS.viewSource}
          </button>
        </Panel>
      )}
    </>
  );
}

function Panel({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className="webview__error" role="status">
      <p className="webview__error-title">{title}</p>
      {detail && <p className="webview__error-detail">{detail}</p>}
      <div className="htmlview__panel-actions">{children}</div>
    </div>
  );
}

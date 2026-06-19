import { useCallback, useEffect, useRef, useState } from 'react';
import { openExternal } from '../bridge';
import { IconChevron, IconClose, IconExternal, IconRefreshCw } from '../icons';
import { normalizeUrl } from '../web-url';

/** The subset of Electron's `<webview>` element API this component drives. */
interface WebviewElement extends HTMLElement {
  src: string;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
}

interface FailEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

/**
 * In-app browser tab over an Electron `<webview>` guest. The guest runs isolated (host
 * hardening in electron/main.ts `will-attach-webview`); this component only ever sets a
 * `normalizeUrl`-approved http(s) URL as `src`. State the page changes itself (in-page
 * link clicks) is NOT written back to `src`, so a parent re-render never reloads the page.
 */
export function WebView({ url, onTitle }: { url: string; onTitle?: (title: string) => void }) {
  const ref = useRef<WebviewElement | null>(null);
  // `src` only changes on an explicit navigate (address bar / retry) — never on the
  // guest's own navigation — so the element doesn't reload underneath the user.
  const [src, setSrc] = useState(url);
  const [address, setAddress] = useState(url);
  const [loading, setLoading] = useState(true);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const [failure, setFailure] = useState<{ code: number; desc: string; url: string } | null>(null);

  const syncNav = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanBack(el.canGoBack());
    setCanFwd(el.canGoForward());
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onStart = () => {
      setLoading(true);
      setFailure(null);
    };
    const onStop = () => {
      setLoading(false);
      syncNav();
    };
    const onTitleUpdated = (e: Event) => {
      const title = (e as Event & { title?: string }).title;
      if (title) onTitle?.(title);
    };
    const onNavigate = (e: Event) => {
      const next = (e as Event & { url?: string }).url ?? el.getURL();
      setAddress(next);
      syncNav();
    };
    const onFail = (e: Event) => {
      const f = e as FailEvent;
      // Ignore sub-frame failures and user-aborted loads (-3); only surface a real,
      // top-level navigation failure as the in-tab error panel.
      if (!f.isMainFrame || f.errorCode === -3) return;
      setLoading(false);
      setFailure({ code: f.errorCode, desc: f.errorDescription, url: f.validatedURL || src });
    };

    el.addEventListener('did-start-loading', onStart);
    el.addEventListener('did-stop-loading', onStop);
    el.addEventListener('page-title-updated', onTitleUpdated);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('did-fail-load', onFail);
    return () => {
      el.removeEventListener('did-start-loading', onStart);
      el.removeEventListener('did-stop-loading', onStop);
      el.removeEventListener('page-title-updated', onTitleUpdated);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('did-fail-load', onFail);
    };
  }, [onTitle, syncNav, src]);

  const navigate = (raw: string) => {
    const normalized = normalizeUrl(raw);
    if (!normalized) {
      // Invalid entry — reset the field to the live URL, don't navigate anywhere.
      setAddress(ref.current?.getURL() ?? src);
      return;
    }
    setFailure(null);
    setAddress(normalized);
    if (normalized === src) ref.current?.reload();
    else setSrc(normalized);
  };

  return (
    <div className="webview">
      <div className="webview__bar">
        <button
          type="button"
          className="webview__btn"
          title="Back"
          disabled={!canBack}
          onClick={() => ref.current?.goBack()}
        >
          <IconChevron size={15} className="webview__icon-back" />
        </button>
        <button
          type="button"
          className="webview__btn"
          title="Forward"
          disabled={!canFwd}
          onClick={() => ref.current?.goForward()}
        >
          <IconChevron size={15} />
        </button>
        <button
          type="button"
          className="webview__btn"
          title={loading ? 'Stop' : 'Reload'}
          onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}
        >
          {loading ? <IconClose size={15} /> : <IconRefreshCw size={15} />}
        </button>
        <input
          className="webview__address"
          value={address}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate((e.target as HTMLInputElement).value);
          }}
          onFocus={(e) => e.target.select()}
        />
        <button
          type="button"
          className="webview__btn"
          title="Open in system browser"
          onClick={() => openExternal(ref.current?.getURL() ?? src)}
        >
          <IconExternal size={15} />
        </button>
      </div>

      <div className="webview__body">
        {failure ? (
          <div className="webview__error">
            <p className="webview__error-title">This page didn’t load</p>
            <p className="webview__error-detail">
              {failure.desc} ({failure.code})
            </p>
            <p className="webview__error-url">{failure.url}</p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => navigate(failure.url)}
            >
              ↻ Retry
            </button>
          </div>
        ) : (
          <webview
            ref={ref as React.Ref<HTMLElement>}
            className="webview__frame"
            src={src}
            partition="persist:webview"
          />
        )}
      </div>
    </div>
  );
}

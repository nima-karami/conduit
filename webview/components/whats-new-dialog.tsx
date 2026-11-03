import { type ImgHTMLAttributes, useId, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openExternal, post } from '../bridge';
import { CHROME_STR } from '../chrome-strings';
import { MARKDOWN_SAFETY_PLUGINS } from '../markdown-safety';
import { remoteImageHost } from '../md-links';
import { middleClickProps } from '../middle-click';
import { useFocusTrap } from '../use-focus-trap';
import { ModalLayer } from './modal-layer';

export interface ReleaseNotesView {
  version: string;
  notes: string;
  currentVersion?: string;
}

const REMARK_PLUGINS = [remarkGfm];
function ReleaseNoteImage({ src, alt, title }: ImgHTMLAttributes<HTMLImageElement>) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const remoteSrc =
    typeof src === 'string' && /^(?:https?:)?\/\//i.test(src)
      ? src.startsWith('//')
        ? `https:${src}`
        : src
      : null;
  if (remoteSrc && loadedSrc !== remoteSrc) {
    const label = CHROME_STR.update.loadImage(remoteImageHost(remoteSrc), alt);
    return (
      <button
        type="button"
        className="markdown-img-status markdown-img-load"
        title={title}
        aria-label={label}
        onClick={() => setLoadedSrc(remoteSrc)}
      >
        {label}
      </button>
    );
  }
  if (remoteSrc || (typeof src === 'string' && /^data:image\//i.test(src))) {
    return <img src={remoteSrc ?? src} alt={alt ?? ''} title={title} />;
  }
  return (
    <span
      className="markdown-img-status"
      role="img"
      aria-label={alt || CHROME_STR.update.imageUnavailable}
    >
      {alt || CHROME_STR.update.imageUnavailable}
    </span>
  );
}
const COMPONENTS: Components = {
  img: ReleaseNoteImage,
  a: ({ href, children }) => (
    <a
      href={href}
      {...middleClickProps(() => {
        if (href) openExternal(href);
      })}
      onClick={(e) => {
        e.preventDefault();
        if (href) openExternal(href);
      }}
    >
      {children}
    </a>
  ),
};

export function WhatsNewDialog({
  release,
  ready,
  onClose,
}: {
  release: ReleaseNotesView;
  ready: boolean;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { restoreFocus } = useFocusTrap(dialogRef);
  const close = () => {
    restoreFocus();
    onClose();
  };
  return (
    <ModalLayer onDismiss={close}>
      <div
        ref={dialogRef}
        className="whats-new"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        data-whats-new
      >
        <h2 id={titleId} className="whats-new__title">
          {CHROME_STR.update.title(release.version)}
        </h2>
        {release.currentVersion && (
          <p className="whats-new__current">{CHROME_STR.update.current(release.currentVersion)}</p>
        )}
        <div className="whats-new__body">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={MARKDOWN_SAFETY_PLUGINS}
            components={COMPONENTS}
          >
            {release.notes}
          </ReactMarkdown>
        </div>
        <div className="whats-new__footer">
          <a
            href={`https://github.com/nima-karami/conduit/releases/tag/v${release.version}`}
            {...middleClickProps(() =>
              openExternal(
                `https://github.com/nima-karami/conduit/releases/tag/v${release.version}`,
              ),
            )}
            onClick={(e) => {
              e.preventDefault();
              openExternal(e.currentTarget.href);
            }}
          >
            {CHROME_STR.update.fullNotes}
          </a>
          <span className="whats-new__spacer" />
          <button type="button" className="btn" autoFocus onClick={close}>
            {CHROME_STR.update.later}
          </button>
          {ready && release.currentVersion && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => post({ type: 'updateRelaunch' })}
            >
              {CHROME_STR.update.relaunch}
            </button>
          )}
        </div>
      </div>
    </ModalLayer>
  );
}

import { useId, useRef } from 'react';
import { openExternal, post } from '../bridge';
import { CHROME_STR } from '../chrome-strings';
import { middleClickProps } from '../middle-click';
import { useFocusTrap } from '../use-focus-trap';
import { ModalLayer } from './modal-layer';
import { ReleaseNotesMarkdown, releaseTagUrl } from './release-notes-markdown';

export interface ReleaseNotesView {
  version: string;
  notes: string;
  currentVersion?: string;
}

export function WhatsNewDialog({
  release,
  ready,
  onClose,
  onShowAllNotes,
}: {
  release: ReleaseNotesView;
  ready: boolean;
  onClose(): void;
  /** Settings takes focus from here, so the dialog does not hand it back to its opener. */
  onShowAllNotes(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { restoreFocus } = useFocusTrap(dialogRef);
  const close = () => {
    onClose();
    requestAnimationFrame(restoreFocus);
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
          <ReleaseNotesMarkdown markdown={release.notes} />
        </div>
        <div className="whats-new__footer">
          <button type="button" className="whats-new__linkbtn" onClick={onShowAllNotes}>
            {CHROME_STR.update.allNotes}
          </button>
          <a
            href={releaseTagUrl(release.version)}
            {...middleClickProps(() => openExternal(releaseTagUrl(release.version)))}
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

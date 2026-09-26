import { useMemo, useState } from 'react';
import { presentRoots } from '../../src/session-folders';
import { sessionNameFromPath } from '../../src/session-name';
import { sessionSections } from '../../src/session-sections';
import type { Session } from '../../src/types';
import {
  asHomeFailedToast,
  asHomeLabel,
  asHomeSegments,
  CANT_START_TITLE,
  LOCATE_LABEL,
  MISSING_HOME_TITLE,
  nativePath,
  notFoundSegments,
  RELAUNCH_LABEL,
} from '../agent-scope-copy';
import { post } from '../bridge';
import { getDirtySnapshot } from '../dirty-store';
import { createFolderActions } from '../folder-actions';
import { requestHost } from '../host-request';
import { pushToast } from '../toast-store';

const SET_HOME_TIMEOUT_MS = 10_000;

/** The 12d centre state for a non-running session whose home is gone (mf-live-edits §2.6).
 *  A fragment: CenterPane owns the `.session-stale` wrapper and its Waiting line. No autofocus — it
 *  must never take focus from the terminal (spec §9). */
export function MissingHomeState({ session, onFixed }: { session: Session; onFixed: () => void }) {
  const [pending, setPending] = useState(false);
  const id = session.id;
  // Locate is mf-files' one renderer helper (locked L11): its picker, replace and toasts.
  const actions = useMemo(
    () =>
      createFolderActions({
        sessionId: id,
        request: requestHost,
        post,
        toast: pushToast,
        dirtyPaths: getDirtySnapshot,
      }),
    [id],
  );
  const home = sessionSections(session).find((f) => f.kind === 'home');
  const candidate = presentRoots(session)[0];
  const candidateName = candidate === undefined ? '' : sessionNameFromPath(candidate);

  const run = async (op: () => Promise<boolean>) => {
    setPending(true);
    const fixed = await op().finally(() => setPending(false));
    if (fixed) onFixed();
  };

  const locate = () =>
    run(async () => (home ? (await actions.locate(home)).kind === 'located' : false));

  const makeHome = (path: string, folder: string) =>
    run(async () => {
      const r = await requestHost(
        (requestId) => ({ type: 'session:setHome', sessionId: id, path, requestId }),
        ['session:opResult'],
        SET_HOME_TIMEOUT_MS,
      );
      if (r?.ok) return true;
      pushToast({ message: asHomeFailedToast(folder), variant: 'error' });
      return false;
    });

  return (
    <>
      <h2 className="session-stale__title">{MISSING_HOME_TITLE}</h2>
      <p className="session-stale__path" dir="ltr">
        {nativePath(session.home)}
      </p>
      <div className="session-stale__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={pending}
          onClick={() => void locate()}
        >
          {LOCATE_LABEL}
        </button>
        {candidate !== undefined && (
          <button
            type="button"
            className="btn session-stale__usehome"
            disabled={pending}
            title={candidate}
            aria-label={asHomeLabel(candidateName)}
            onClick={() => void makeHome(candidate, candidateName)}
          >
            {asHomeSegments(candidateName).map((seg) =>
              seg.kind === 'name' ? (
                <span key="name" className="session-stale__usehome-name">
                  {seg.text}
                </span>
              ) : (
                seg.text
              ),
            )}
          </button>
        )}
      </div>
    </>
  );
}

/** The centre state for a session whose last start was refused because its command isn't on
 *  PATH (review B1). Relaunch is the retry; the same fragment contract as MissingHomeState. */
export function StartRefusedState({
  session,
  onRelaunch,
  relaunchRef,
}: {
  session: Session;
  onRelaunch: (id: string) => void;
  relaunchRef: ((el: HTMLButtonElement | null) => void) | null;
}) {
  if (!session.startRefusal) return null;
  return (
    <>
      <h2 className="session-stale__title">{CANT_START_TITLE}</h2>
      <p className="session-stale__detail">
        {notFoundSegments(session.startRefusal.command).map((seg) =>
          seg.kind === 'name' ? (
            <span key="name" className="session-stale__cmd" dir="ltr">
              {seg.text}
            </span>
          ) : (
            seg.text
          ),
        )}
      </p>
      <button
        ref={relaunchRef}
        type="button"
        className="btn btn--primary"
        onClick={() => onRelaunch(session.id)}
      >
        {RELAUNCH_LABEL}
      </button>
    </>
  );
}

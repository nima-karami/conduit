import { type KeyboardEvent, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { folderKey } from '../../src/folder-key';
import type { DroppedRoot } from '../../src/folder-validation';
import { preferredShellId, rankLaunchers } from '../../src/launchers';
import {
  type NewSessionPrefill,
  type SeedContext,
  seedNewSession,
} from '../../src/new-session-seed';
import { type HostToWebview, MAX_PROBE_PATHS } from '../../src/protocol';
import { post } from '../bridge';
import { requestHost } from '../host-request';
import {
  initialNewSessionState,
  type LaunchPreviewView,
  MAX_DIALOG_FOLDERS,
  type NewSessionAction,
  type NewSessionState,
  reduceNewSession,
  startBlock,
} from '../new-session-state';
import { ModalLayer } from './modal-layer';
import { NewSessionFolders } from './new-session-folders';
import { NewSessionLaunchRow } from './new-session-launch-row';
import { NewSessionPreview } from './new-session-preview';
import { NewSessionProjectChip } from './new-session-project-chip';

const REPLY_TIMEOUT_MS = 5000;

type OpenRepoError = NonNullable<Extract<HostToWebview, { type: 'openRepo:result' }>['error']>;
/** mf-new-session plan, Spec staleness §3.2: one copy per mf-model error. */
const START_ERROR: Record<OpenRepoError, string> = {
  'home-missing': 'home folder not found',
  'invalid-path': 'home is not a folder',
  'unknown-agent': 'launcher is no longer available',
};

export interface NewSessionModalProps {
  prefill: NewSessionPrefill;
  ctx: SeedContext;
  onClose: () => void;
  onStarted: (sessionId: string, dropped: DroppedRoot[]) => void;
}

export function NewSessionModal({ prefill, ctx, onClose, onStarted }: NewSessionModalProps) {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [state, dispatch] = useReducer(
    (s: NewSessionState, a: NewSessionAction) => reduceNewSession(s, a, ctxRef.current),
    undefined,
    () => initialNewSessionState(seedNewSession(prefill, ctx)),
  );
  const [preview, setPreview] = useState<LaunchPreviewView>({ loading: false });
  const frameRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const probed = useRef(new Set<string>());
  const previewSeq = useRef(0);
  const startingRef = useRef(false);

  // Ids only: the seed is never recomputed mid-edit (spec §4 "State updates mid-edit").
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new ctx is the trigger.
  useEffect(() => {
    dispatch({ type: 'revalidate' });
  }, [ctx]);

  useEffect(() => {
    post({ type: 'launchers:rescan' });
    // In priority order: one selector list would match whichever comes first in the DOM.
    const frame = frameRef.current;
    const target = ['.ns-pill[aria-checked="true"]', '.ns-pill', '.ns-folders__add']
      .map((sel) => frame?.querySelector<HTMLElement>(sel))
      .find(Boolean);
    target?.focus();
  }, []);

  useEffect(() => {
    const fresh = state.folders.filter((f) => !probed.current.has(folderKey(f)));
    for (const f of fresh) probed.current.add(folderKey(f));
    for (let i = 0; i < fresh.length; i += MAX_PROBE_PATHS) {
      const paths = fresh.slice(i, i + MAX_PROBE_PATHS);
      void requestHost(
        (requestId) => ({ type: 'folder:probe', requestId, paths }),
        ['folder:probeResult'],
        REPLY_TIMEOUT_MS,
      ).then((reply) => {
        if (reply) dispatch({ type: 'probed', results: reply.results });
      });
    }
  }, [state.folders]);

  useEffect(() => {
    const [home, ...roots] = state.folders;
    const seq = ++previewSeq.current;
    if (home === undefined) {
      setPreview({ loading: false });
      return;
    }
    setPreview((p) => ({ ...p, loading: true }));
    void requestHost(
      (requestId) => ({ type: 'launch:preview', requestId, agentId: state.agentId, home, roots }),
      ['launch:previewResult'],
      REPLY_TIMEOUT_MS,
    ).then((reply) => {
      // Latest request wins; an older reply landing late is dropped (spec §4).
      if (seq !== previewSeq.current) return;
      // A timed-out reply must not leave the previous folders' result standing in for these.
      if (!reply) {
        setPreview({ loading: false });
        return;
      }
      const { type: _type, requestId: _id, ...result } = reply;
      setPreview({ result, loading: false });
    });
  }, [state.agentId, state.folders]);

  const agents = useMemo(() => [...ctx.agents], [ctx.agents]);
  const launchers = useMemo(() => [...ctx.launchers], [ctx.launchers]);
  const ranking = useMemo(
    () => rankLaunchers(agents, launchers, preferredShellId(launchers, ctx.defaultAgentId)),
    [agents, launchers, ctx.defaultAgentId],
  );
  const block = startBlock(state, preview, agents);
  const label = agents.find((a) => a.id === state.agentId)?.label ?? state.agentId;
  const starting = state.phase === 'starting';

  const start = async () => {
    if (startingRef.current || block) return;
    startingRef.current = true;
    dispatch({ type: 'start' });
    let started = false;
    try {
      let projectId = state.projectId;
      if (state.pendingProjectName !== undefined) {
        const name = state.pendingProjectName;
        const created = await requestHost(
          (requestId) => ({ type: 'project:create', name, requestId }),
          ['project:created', 'project:opResult'],
          REPLY_TIMEOUT_MS,
        );
        if (created?.type !== 'project:created') {
          dispatch({ type: 'startFailed', reason: "couldn't create project", project: true });
          return;
        }
        projectId = created.id;
        // A retry after a failed openRepo reuses this project instead of creating a second one.
        dispatch({ type: 'setProject', projectId });
      }
      const [path, ...roots] = state.folders;
      const reply = await requestHost(
        (requestId) => ({
          type: 'openRepo',
          path,
          agentId: state.agentId,
          roots,
          projectId,
          ...(prefill.cardId ? { cardId: prefill.cardId } : {}),
          requestId,
        }),
        ['openRepo:result'],
        REPLY_TIMEOUT_MS,
      );
      if (reply?.sessionId) {
        started = true;
        onStarted(reply.sessionId, reply.droppedRoots);
        return;
      }
      const reason = reply?.error ? START_ERROR[reply.error] : 'no reply from host';
      dispatch({ type: 'startFailed', reason, project: false });
    } finally {
      // The unmount lands a render after onStarted; a held Enter in that gap must not re-arm.
      if (!started) startingRef.current = false;
    }
  };

  const onFrameKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter') return;
    const t = e.target as HTMLElement;
    // Enter is Start only from the frame or a pill; every other control owns its own Enter.
    if (t !== e.currentTarget && t.getAttribute('role') !== 'radio') return;
    e.preventDefault();
    void start();
  };

  return (
    <ModalLayer onDismiss={onClose}>
      <div
        ref={frameRef}
        className="modal ns"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onFrameKey}
      >
        <div className="ns__head">
          <div className="ns__titles">
            <span id={titleId} className="modal__title modal__title--compact">
              New session
            </span>
            {prefill.cardTitle && (
              <span className="modal__sub">{`Start a session for "${prefill.cardTitle}"`}</span>
            )}
          </div>
          <span className="ns__esc" aria-hidden>
            Esc
          </span>
        </div>

        <div className="ns__body">
          <section className="ns__section">
            <span className="ns__label">Launch</span>
            <NewSessionLaunchRow
              agents={agents}
              launchers={launchers}
              ranking={ranking}
              selectedId={state.agentId}
              extraPillId={state.extraPillId}
              onPick={(id, fromMore) => dispatch({ type: 'pickAgent', id, fromMore })}
              customCount={launchers.filter((l) => l.kind === 'custom').length}
            />
          </section>

          <section className="ns__section">
            <NewSessionProjectChip
              projects={[...ctx.projects]}
              projectId={state.projectId}
              pendingName={state.pendingProjectName}
              error={state.projectError}
              onSet={(projectId) => dispatch({ type: 'setProject', projectId })}
              onNew={(name) => dispatch({ type: 'newProject', name })}
            />
          </section>

          <section className="ns__section">
            <span className="ns__label">Folders</span>
            <NewSessionFolders
              folders={state.folders}
              probes={state.probes}
              repos={[...ctx.repos]}
              flashKey={state.flashKey}
              hint={state.hint}
              atCap={state.folders.length >= MAX_DIALOG_FOLDERS}
              onAdd={(path) => dispatch({ type: 'addFolder', path })}
              onRemove={(path) => dispatch({ type: 'removeFolder', path })}
              onMakeHome={(path) => dispatch({ type: 'makeHome', path })}
            />
          </section>

          <section className="ns__section">
            <span className="ns__label">Launches as</span>
            <NewSessionPreview view={preview} hasFolders={state.folders.length > 0} label={label} />
          </section>
        </div>

        {state.startError && (
          <div className="ns__error" role="alert">
            {state.startError}
          </div>
        )}
        <div className="modal__foot ns__foot">
          <span id={reasonId} className="ns__reason">
            {block?.reason}
          </span>
          <div className="modal__actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={block !== null || starting}
              aria-describedby={block ? reasonId : undefined}
              onClick={() => void start()}
            >
              Start session
            </button>
          </div>
        </div>
        <div className="ns__live" aria-live="polite">
          {state.announce}
        </div>
      </div>
    </ModalLayer>
  );
}

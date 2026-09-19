import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { composePlan, splitPlan } from '../../src/plan-blocks';
import { planSlugFromPath } from '../../src/plan-path';
import type { OpenDoc } from '../docs';
import {
  getPlanState,
  loadPlan,
  markPending,
  resolveConflict,
  subscribePlans,
  writePlan,
} from '../plan-store';
import { PlanEditor, type PlanEditorHandle } from './plan-editor';

/**
 * The document tab for `<root>/.conduit/plans/<slug>.md`: binds the plan store to the editor and
 * renders the states of spec docs/specs/2026-09-19-interactive-plan.md §8. Routed by PATH from
 * `DocBody`, so there is no `DocKind` for it.
 *
 * The editor speaks in bodies; the file is frontmatter + body, so every write recomposes the two.
 */

export interface PlanViewProps {
  doc: OpenDoc;
  root: string;
  sessionId?: string;
  onClose?: ((id: string) => void) | undefined;
}

const WRITE_DEBOUNCE_MS = 300;

const noop = (): void => {};

function copyPath(path: string): void {
  void navigator.clipboard?.writeText(path);
}

function PlanState({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="plan">
      <div className="plan__state" role="status">
        <p>{message}</p>
        {children && <div className="plan__state-actions">{children}</div>}
      </div>
    </div>
  );
}

export function PlanView({ doc, root, onClose }: PlanViewProps) {
  const slug = planSlugFromPath(doc.path);

  useEffect(() => {
    if (slug) loadPlan(root, slug);
  }, [root, slug]);

  const state = useSyncExternalStore(
    subscribePlans,
    useCallback(() => (slug === null ? undefined : getPlanState(root, slug)), [root, slug]),
  );

  const editorRef = useRef<PlanEditorHandle>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [armed, setArmed] = useState(false);
  const [everWrote, setEverWrote] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const cancelWrite = useCallback((): void => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setArmed(false);
  }, []);

  useEffect(() => cancelWrite, [cancelWrite]);

  const save = useCallback(
    (body: string): void => {
      if (slug === null) return;
      const current = getPlanState(root, slug);
      setEverWrote(true);
      writePlan(root, slug, composePlan(splitPlan(current?.disk ?? '').frontmatter, body));
    },
    [root, slug],
  );

  const handleBody = useCallback(
    (next: string): void => {
      if (slug === null) return;
      setRefused(null);
      markPending(root, slug);
      cancelWrite();
      setArmed(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setArmed(false);
        save(next);
      }, WRITE_DEBOUNCE_MS);
    },
    [root, slug, save, cancelWrite],
  );

  const handleBodyRefused = useCallback(
    (reason: string): void => {
      cancelWrite();
      setRefused(reason);
    },
    [cancelWrite],
  );

  if (slug === null) {
    return (
      <PlanState message={`Can't open this plan: "${doc.title}" is not a usable plan name.`}>
        <button type="button" className="btn" onClick={() => copyPath(doc.path)}>
          Copy path
        </button>
      </PlanState>
    );
  }

  if (state === undefined || state.status === 'loading') {
    return (
      <div className="plan">
        <div className="plan__state" role="status" aria-busy="true" aria-label="Loading plan">
          <span className="plan__skel plan__skel--head" />
          <span className="plan__skel" />
          <span className="plan__skel" />
          <span className="plan__skel plan__skel--short" />
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <PlanState message={`Can't open this plan: ${state.error ?? 'unknown error'}`}>
        <button type="button" className="btn" onClick={() => copyPath(doc.path)}>
          Copy path
        </button>
      </PlanState>
    );
  }

  if (state.status === 'not-found') {
    return (
      <PlanState message="This plan was deleted.">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => writePlan(root, slug, `# ${slug}\n`)}
        >
          Recreate empty
        </button>
        <button type="button" className="btn" onClick={() => onClose?.(doc.id)}>
          Close
        </button>
      </PlanState>
    );
  }

  const { conflict, readOnly, disk, agentChanged, saveError, pendingWrite } = state;
  const split = splitPlan(disk ?? '');
  const failure = refused ?? saveError;
  const saveState: 'idle' | 'saving' | 'saved' | 'failed' | 'readonly' = readOnly
    ? 'readonly'
    : failure !== null
      ? 'failed'
      : armed || pendingWrite
        ? 'saving'
        : everWrote
          ? 'saved'
          : 'idle';

  const keepMine = (): void => {
    cancelWrite();
    resolveConflict(
      root,
      slug,
      'mine',
      composePlan(split.frontmatter, editorRef.current?.getBody() ?? split.body),
    );
  };

  return (
    <div className="plan">
      {conflict && (
        <div
          className="plan__conflict"
          role="alertdialog"
          aria-label="This plan changed on disk while you were editing"
        >
          <span>The agent changed this plan while you were editing it.</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              cancelWrite();
              resolveConflict(root, slug, 'theirs', '');
            }}
          >
            Load theirs
          </button>
          <button type="button" className="btn btn--primary" onClick={keepMine}>
            Keep mine
          </button>
        </div>
      )}
      {readOnly && (
        <div className="plan__state plan__state--bar" role="status">
          <p>This file is read-only.</p>
        </div>
      )}
      {saveState === 'failed' && (
        <div className="plan__state plan__state--bar" role="status">
          <p>{`Couldn't save: ${failure}`}</p>
          <div className="plan__state-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                const body = editorRef.current?.getBody();
                if (body !== undefined) handleBody(body);
              }}
            >
              Retry
            </button>
          </div>
        </div>
      )}
      {(saveState === 'saving' || saveState === 'saved') && (
        <span className="plan__save" role="status">
          {saveState === 'saving' ? 'Saving…' : 'Saved'}
        </span>
      )}
      {agentChanged.size > 0 && (
        <span className="plan__changed">
          {agentChanged.size === 1
            ? '1 block changed by the agent'
            : `${agentChanged.size} blocks changed by the agent`}
        </span>
      )}
      <PlanEditor
        ref={editorRef}
        body={split.body}
        readOnly={readOnly || conflict !== null}
        onBody={handleBody}
        onBodyRefused={handleBodyRefused}
        onBlockFocus={noop}
        agentChanged={agentChanged}
      />
    </div>
  );
}

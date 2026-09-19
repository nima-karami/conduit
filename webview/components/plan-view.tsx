import { type ReactNode, useCallback, useEffect, useSyncExternalStore } from 'react';
import { splitPlan } from '../../src/plan-blocks';
import { planSlugFromPath } from '../../src/plan-path';
import type { OpenDoc } from '../docs';
import { getPlanState, loadPlan, resolveConflict, subscribePlans, writePlan } from '../plan-store';
import { PlanEditor } from './plan-editor';

/**
 * The document tab for `<root>/.conduit/plans/<slug>.md`: binds the plan store to the editor and
 * renders the states of spec docs/specs/2026-09-19-interactive-plan.md §8. Routed by PATH from
 * `DocBody`, so there is no `DocKind` for it.
 *
 * Write-through (Task 4.4) and the agent-changed block decorations (4.5) are not wired yet: the
 * editor is mounted read-only-in-effect by handing it no-op callbacks.
 */

export interface PlanViewProps {
  doc: OpenDoc;
  root: string;
  sessionId?: string;
  onClose?: ((id: string) => void) | undefined;
}

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

  const { conflict, readOnly, disk, agentChanged } = state;
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
            onClick={() => resolveConflict(root, slug, 'theirs', disk ?? '')}
          >
            Load theirs
          </button>
          {/* 4.4 replaces `disk` with the editor's live body — the store has no other copy yet. */}
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => resolveConflict(root, slug, 'mine', disk ?? '')}
          >
            Keep mine
          </button>
        </div>
      )}
      {readOnly && (
        <div className="plan__state plan__state--bar" role="status">
          <p>This file is read-only.</p>
        </div>
      )}
      {agentChanged.size > 0 && (
        <span className="plan__changed">
          {agentChanged.size === 1
            ? '1 block changed by the agent'
            : `${agentChanged.size} blocks changed by the agent`}
        </span>
      )}
      <PlanEditor
        body={splitPlan(disk ?? '').body}
        readOnly={readOnly || conflict !== null}
        onBody={noop}
        onBodyRefused={noop}
        onBlockFocus={noop}
        agentChanged={agentChanged}
      />
    </div>
  );
}

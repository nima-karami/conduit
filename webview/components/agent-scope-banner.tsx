import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../src/types';
import {
  ADD_DIR_BUSY_TITLE,
  ADD_DIR_LABEL,
  agentScopeToast,
  bannerActions,
  bannerCopy,
  CANCEL_LABEL,
  type CopySegment,
  DISMISS_LABEL,
  RESTART_CONFIRM,
  RESTART_CONFIRM_LABEL,
  RESTART_LABEL,
} from '../agent-scope-copy';
import { post } from '../bridge';
import { requestHost } from '../host-request';
import { IconClose } from '../icons';
import { requestTerminalFocus } from '../terminal-bus';
import { pushToast } from '../toast-store';

// Typing N paths takes ~420 ms each; the host answers when the last Enter is written.
const ADD_DIR_TIMEOUT_MS = 60_000;
const RESTART_TIMEOUT_MS = 10_000;

type Phase = 'ready' | 'sending' | 'confirming' | 'restarting';

function Segments({ segments }: { segments: CopySegment[] }) {
  return segments.map((s, i) =>
    s.kind === 'name' ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: a static, positional copy list
      <span key={i} className="scope-banner__name" dir="ltr">
        {s.text}
      </span>
    ) : (
      s.text
    ),
  );
}

/** The 12c strip over a running claude whose folders drifted (mf-live-edits spec §2.2). */
export function AgentScopeBanner({ session }: { session: Session }) {
  const [phase, setPhase] = useState<Phase>('ready');
  const focusAfter = useRef<'cancel' | 'restart' | null>(null);
  // Each button is a fresh element when the confirm swaps in or out, so its ref runs on mount.
  const focusOnMount = (which: 'cancel' | 'restart') => (el: HTMLButtonElement | null) => {
    if (el && focusAfter.current === which) {
      focusAfter.current = null;
      el.focus();
    }
  };
  const view = session.agentScope;
  const id = session.id;

  // A banner that went away mid-confirm must not come back already confirming.
  useEffect(() => {
    if (!view) setPhase('ready');
  }, [view]);

  if (!view) return null;
  const copy = bannerCopy(view);
  const actions = bannerActions(view, { busy: !!session.busy, homeMissing: !!session.homeMissing });

  const runAddDir = async () => {
    setPhase('sending');
    requestTerminalFocus(id);
    const r = await requestHost(
      (requestId) => ({ type: 'session:addDirsToAgent', sessionId: id, requestId }),
      ['agentScope:result'],
      ADD_DIR_TIMEOUT_MS,
    );
    setPhase('ready');
    if (r && !r.ok && r.reason) {
      const message = agentScopeToast(r.reason);
      if (message) pushToast({ message, variant: 'error' });
    }
  };

  const confirmRestart = async () => {
    setPhase('restarting');
    await requestHost(
      (requestId) => ({ type: 'session:restart', sessionId: id, requestId }),
      ['agentScope:result'],
      RESTART_TIMEOUT_MS,
    );
    setPhase('ready');
    // The restart remounts the pane; focus the new terminal once it has registered.
    requestAnimationFrame(() => requestTerminalFocus(id));
  };

  const cancel = () => {
    focusAfter.current = 'restart';
    setPhase('ready');
  };

  const confirming = phase === 'confirming' || phase === 'restarting';
  const addDisabled = actions.addDirDisabled || phase === 'sending';

  return (
    <div
      className="scope-banner"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && phase === 'confirming') {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <span className="scope-banner__dot" aria-hidden />
      {confirming ? (
        <>
          <div className="scope-banner__msg" role="status" aria-live="polite">
            {RESTART_CONFIRM}
          </div>
          <div className="scope-banner__actions">
            <button
              type="button"
              className="btn btn--warn"
              disabled={phase === 'restarting'}
              onClick={() => void confirmRestart()}
            >
              {RESTART_CONFIRM_LABEL}
            </button>
            <button
              ref={focusOnMount('cancel')}
              type="button"
              className="btn btn--ghost"
              disabled={phase === 'restarting'}
              onClick={cancel}
            >
              {CANCEL_LABEL}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="scope-banner__msg" role="status" aria-live="polite" title={copy.title}>
            <Segments segments={copy.segments} />
            {copy.second && (
              <div className="scope-banner__second">
                <Segments segments={copy.second} />
              </div>
            )}
          </div>
          <div className="scope-banner__actions">
            {actions.showAddDir && (
              <button
                type="button"
                className={actions.primary === 'addDir' ? 'btn btn--warn' : 'btn'}
                disabled={addDisabled}
                title={actions.addDirDisabled ? ADD_DIR_BUSY_TITLE : undefined}
                onClick={() => void runAddDir()}
              >
                {ADD_DIR_LABEL}
              </button>
            )}
            {actions.showRestart && (
              <button
                ref={focusOnMount('restart')}
                type="button"
                className={actions.primary === 'restart' ? 'btn btn--warn' : 'btn'}
                onClick={() => {
                  focusAfter.current = 'cancel';
                  setPhase('confirming');
                }}
              >
                {RESTART_LABEL}
              </button>
            )}
            <button
              type="button"
              className="scope-banner__close"
              aria-label={DISMISS_LABEL}
              title={DISMISS_LABEL}
              onClick={() => post({ type: 'session:dismissAgentScope', sessionId: id })}
            >
              <IconClose size={12} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

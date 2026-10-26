import { type KeyboardEvent, useId, useRef } from 'react';
import { BRIEF_MAX_BYTES, briefByteCount } from '../../src/role-brief';
import type { BriefAction, BriefDialogState, BriefMode } from '../role-brief-state';
import { BRIEF_STR } from '../role-brief-strings';

export interface NewSessionRoleBriefProps {
  state: BriefDialogState;
  dispatch: (a: BriefAction) => void;
  onBrowse: () => void;
  /** Id of the status line the text and path fields point `aria-describedby` at. */
  liveId: string;
}

const LABEL: Record<BriefMode, string> = {
  agent: BRIEF_STR.fromAgent,
  none: BRIEF_STR.none,
  text: BRIEF_STR.text,
  file: BRIEF_STR.file,
};

export function NewSessionRoleBrief({
  state,
  dispatch,
  onBrowse,
  liveId,
}: NewSessionRoleBriefProps) {
  const labelId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  if (!state.supported) return null;

  const modes: BriefMode[] = state.agentHas
    ? ['agent', 'none', 'text', 'file']
    : ['none', 'text', 'file'];

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const at = Math.max(modes.indexOf(state.mode), 0);
    const next = modes[(at + step + modes.length) % modes.length];
    dispatch({ type: 'setMode', mode: next });
    requestAnimationFrame(() => {
      groupRef.current?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
    });
  };

  const bytes = briefByteCount(state.text);
  const textError = state.mode === 'text' && bytes > BRIEF_MAX_BYTES;
  const error =
    state.mode === 'agent'
      ? state.agentError
      : textError
        ? 'brief-too-large'
        : state.mode === 'file' && state.probe.phase === 'error'
          ? state.probe.error
          : undefined;
  const status =
    state.mode === 'text'
      ? BRIEF_STR.count(bytes)
      : state.mode === 'file'
        ? state.probe.phase === 'checking'
          ? BRIEF_STR.checking
          : state.probe.phase === 'ok'
            ? BRIEF_STR.count(state.probe.bytes)
            : undefined
        : undefined;

  return (
    <section className="ns__section ns-brief">
      <span id={labelId} className="ns__label">
        {BRIEF_STR.label}
      </span>
      <div
        ref={groupRef}
        className="ns-brief__modes"
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={onKey}
      >
        {modes.map((m) => {
          const on = m === state.mode;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              data-mode={m}
              tabIndex={on ? 0 : -1}
              className={`ns-pill${on ? ' ns-pill--on chamfer--sm' : ''}`}
              onClick={() => dispatch({ type: 'setMode', mode: m })}
            >
              {LABEL[m]}
            </button>
          );
        })}
      </div>

      {state.mode === 'agent' && (
        <div className="ns-brief__agent">
          {state.agentFirstLine && <span className="ns-brief__first">{state.agentFirstLine}</span>}
          {state.agentPath && (
            <span className="ns-brief__path" dir="ltr">
              {state.agentPath}
            </span>
          )}
        </div>
      )}

      {state.mode === 'text' && (
        <textarea
          className="ns-input ns-brief__text"
          aria-label={BRIEF_STR.textLabel}
          aria-describedby={liveId}
          aria-invalid={textError}
          placeholder={BRIEF_STR.placeholder}
          rows={4}
          value={state.text}
          onChange={(e) => dispatch({ type: 'setText', text: e.target.value })}
        />
      )}

      {state.mode === 'file' && (
        <div className="ns-brief__file">
          <input
            className="ns-input ns-brief__input"
            dir="ltr"
            aria-label={BRIEF_STR.pathLabel}
            aria-describedby={liveId}
            aria-invalid={state.probe.phase === 'error'}
            spellCheck={false}
            value={state.path}
            onChange={(e) => dispatch({ type: 'setPath', path: e.target.value })}
          />
          <button
            type="button"
            className="btn"
            aria-label={BRIEF_STR.browseName}
            onClick={onBrowse}
          >
            {BRIEF_STR.browse}
          </button>
        </div>
      )}

      <span id={liveId} className="ns-brief__status">
        {status}
      </span>
      {error && (
        <span className="ns-brief__error" role="alert">
          {BRIEF_STR.errors[error]}
        </span>
      )}
    </section>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import { AGENT_CLIS, type AgentCli, CLI_DISPLAY_NAME } from '../../src/conduit-mcp/install-types';
import type {
  AgentSetupStep,
  MachineActionResult,
  MachineMode,
  MachineView,
} from '../../src/contracts/machines';
import { MACHINES_STR } from '../machines-strings';
import { ModalLayer } from './modal-layer';
import { SegmentedRadios } from './segmented-radios';

const MODES: { id: MachineMode; label: string }[] = [
  { id: 'full', label: MACHINES_STR.modeFull },
  { id: 'light', label: MACHINES_STR.modeLight },
];

/**
 * Set up a machine's agent CLIs (docs/specs/2026-11-16-remote-ssh.md §9.1, §9.2). Full lists each
 * CLI with Install or Log in, each run in a visible terminal; Light says the machine runs none.
 * Esc closes through the overlay stack, so there is no key handler here.
 */
export function AgentSetupDialog({
  machine,
  onSetMode,
  onOpenPane,
  onRefresh,
  onClose,
}: {
  machine: MachineView;
  onSetMode: (mode: MachineMode) => Promise<MachineActionResult>;
  onOpenPane: (
    cli: AgentCli,
    step: AgentSetupStep,
  ) => Promise<{ sessionId: string | null; error: string | null }>;
  onRefresh: () => Promise<{ agents: string[] | null; error: string | null }>;
  onClose: () => void;
}) {
  const titleId = useId();
  const sourceMode = machine.mode ?? 'full';
  const [mode, setMode] = useState<MachineMode>(sourceMode);
  const [saving, setSaving] = useState(false);
  // A ref as well as the state: a second click in the same tick must not send a second change.
  const savingRef = useRef(false);
  // The host's mode is the source of truth: a failed change falls back to it, never to a value
  // captured before the change, which a quick second toggle would have left stale.
  const sourceRef = useRef(sourceMode);
  const modeRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  const [agents, setAgents] = useState<readonly string[]>(machine.agents);
  const [modeError, setModeError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [opening, setOpening] = useState<AgentCli | null>(null);
  const [paneErrors, setPaneErrors] = useState<Partial<Record<AgentCli, string>>>({});

  // The row's network state may arrive after the dialog opened; the newer value wins.
  useEffect(() => {
    sourceRef.current = sourceMode;
    setMode(sourceMode);
  }, [sourceMode]);
  useEffect(() => setAgents(machine.agents), [machine.agents]);
  // Opening the dialog lands the owner on the mode they are in, so a key press acts on it.
  useEffect(() => {
    modeRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, []);

  // The control is locked while a change is in flight, so only one change runs at a time.
  const chooseMode = async (next: MachineMode) => {
    if (savingRef.current || next === mode) return;
    savingRef.current = true;
    setSaving(true);
    setModeError(null);
    setMode(next);
    try {
      const result = await onSetMode(next);
      if (!result.ok) {
        setMode(sourceRef.current);
        setModeError(MACHINES_STR.errorText(result.error));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const runPane = async (cli: AgentCli, step: AgentSetupStep) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setOpening(cli);
    // Retrying a row starts clean: its last failure stays up only until the next attempt.
    setPaneErrors((cur) => {
      const next = { ...cur };
      delete next[cli];
      return next;
    });
    try {
      const result = await onOpenPane(cli, step);
      if (result.error !== null) {
        const code = result.error;
        setPaneErrors((cur) => ({ ...cur, [cli]: code }));
      }
    } finally {
      busyRef.current = false;
      setOpening(null);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    const result = await onRefresh();
    setRefreshing(false);
    if (result.error !== null) setRefreshError(MACHINES_STR.probeFailed);
    else if (result.agents !== null) setAgents(result.agents);
  };

  // One polite region carries progress and the last failure, so both are announced.
  const status = refreshing
    ? MACHINES_STR.checking
    : opening !== null
      ? MACHINES_STR.openingTerminal
      : (refreshError ?? modeError ?? '');
  const statusIsError = !refreshing && opening === null && status !== '';

  return (
    <ModalLayer onDismiss={onClose}>
      <div
        className="modal agent-setup"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <span id={titleId} className="modal__title modal__title--compact">
            {MACHINES_STR.setupTitle(machine.machine)}
          </span>
        </div>
        <div className="modal__body">
          <div ref={modeRef} className="agent-setup__mode">
            <SegmentedRadios
              label={MACHINES_STR.modeLabel}
              value={mode}
              options={MODES}
              onChange={(next) => void chooseMode(next)}
              // Each selection is a request to the host, so arrow keys only move focus.
              selectOnArrow={false}
              disabled={saving}
            />
          </div>
          {mode === 'light' ? (
            <p className="agent-setup__hint">{MACHINES_STR.modeLightHint}</p>
          ) : (
            <>
              <p className="agent-setup__hint">{MACHINES_STR.modeFullHint}</p>
              <ul className="agent-setup__list" aria-label={MACHINES_STR.agentsLabel}>
                {AGENT_CLIS.map((cli) => {
                  const installed = agents.includes(cli);
                  const error = paneErrors[cli];
                  return (
                    <li key={cli} className="agent-setup__row">
                      <span className="agent-setup__name">{CLI_DISPLAY_NAME[cli]}</span>
                      <span
                        className="agent-setup__state"
                        data-installed={installed ? 'true' : 'false'}
                      >
                        {opening === cli
                          ? MACHINES_STR.openingTerminal
                          : installed
                            ? MACHINES_STR.installed
                            : MACHINES_STR.notInstalled}
                      </span>
                      {installed ? (
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={opening !== null}
                          aria-label={`${MACHINES_STR.logIn} ${CLI_DISPLAY_NAME[cli]}`}
                          onClick={() => void runPane(cli, 'login')}
                        >
                          {MACHINES_STR.logIn}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={opening !== null}
                          aria-label={`${MACHINES_STR.install} ${CLI_DISPLAY_NAME[cli]}`}
                          onClick={() => void runPane(cli, 'install')}
                        >
                          {MACHINES_STR.install}
                        </button>
                      )}
                      {error !== undefined && (
                        <p className="agent-setup__error">{MACHINES_STR.paneError(error)}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
              <div className="agent-setup__refresh">
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={refreshing || opening !== null}
                  aria-busy={refreshing}
                  onClick={() => void refresh()}
                >
                  {MACHINES_STR.refresh}
                </button>
              </div>
              <p className="agent-setup__note">{MACHINES_STR.setupNote}</p>
            </>
          )}
          <p
            className={`agent-setup__status${statusIsError ? ' agent-setup__status--error' : ''}`}
            role="status"
            aria-live="polite"
          >
            {status}
          </p>
          <div className="modal__actions">
            <button type="button" className="btn" onClick={onClose}>
              {MACHINES_STR.close}
            </button>
          </div>
        </div>
      </div>
    </ModalLayer>
  );
}

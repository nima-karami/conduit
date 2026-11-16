import { useEffect, useId, useState } from 'react';
import { AGENT_CLIS, type AgentCli, CLI_DISPLAY_NAME } from '../../src/conduit-mcp/install-types';
import type {
  AgentSetupStep,
  MachineActionResult,
  MachineMode,
  MachineView,
} from '../../src/contracts/machines';
import { MACHINES_STR } from '../machines-strings';
import { ModalLayer } from './modal-layer';

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
  const modeLabelId = useId();
  const [mode, setMode] = useState<MachineMode>(machine.mode ?? 'full');
  const [agents, setAgents] = useState<readonly string[]>(machine.agents);
  const [modeError, setModeError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [opening, setOpening] = useState<AgentCli | null>(null);
  const [paneErrors, setPaneErrors] = useState<Partial<Record<AgentCli, string>>>({});

  // The row's network state may arrive after the dialog opened; the newer value wins.
  useEffect(() => setMode(machine.mode ?? 'full'), [machine.mode]);
  useEffect(() => setAgents(machine.agents), [machine.agents]);

  const chooseMode = async (next: MachineMode) => {
    if (next === mode) return;
    const previous = mode;
    setModeError(null);
    setMode(next);
    const result = await onSetMode(next);
    if (!result.ok) {
      setMode(previous);
      setModeError(MACHINES_STR.errorText(result.error));
    }
  };

  const runPane = async (cli: AgentCli, step: AgentSetupStep) => {
    if (opening !== null) return;
    setOpening(cli);
    setPaneErrors((cur) => {
      const next = { ...cur };
      delete next[cli];
      return next;
    });
    const result = await onOpenPane(cli, step);
    setOpening(null);
    if (result.error !== null) {
      const code = result.error;
      setPaneErrors((cur) => ({ ...cur, [cli]: code }));
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
          <div className="agent-setup__mode" role="group" aria-labelledby={modeLabelId}>
            <span id={modeLabelId} className="agent-setup__label">
              {MACHINES_STR.modeLabel}
            </span>
            <div className="seg">
              {MODES.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`seg__btn${mode === o.id ? ' seg__btn--active' : ''}`}
                  aria-pressed={mode === o.id}
                  onClick={() => void chooseMode(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
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
        </div>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onClose}>
            {MACHINES_STR.close}
          </button>
        </div>
      </div>
    </ModalLayer>
  );
}

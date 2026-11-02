import type { ServerUiState } from '../../src/protocol';

type Tone = 'warn' | 'error' | 'info';

interface BannerView {
  tone: Tone;
  message: string;
  logPath?: string;
  action?: { label: string; run: () => void };
}

const SERVICE = "Conduit's background service";

function viewOf(
  state: ServerUiState,
  onRetry: () => void,
  onStopAllAndContinue: () => void,
): BannerView | null {
  switch (state.state) {
    case 'unavailable':
      return {
        tone: 'error',
        message: `${SERVICE} isn't running.`,
        logPath: state.logPath,
        action: { label: 'Retry', run: onRetry },
      };
    case 'downgrade':
      return {
        tone: 'warn',
        message: `A newer Conduit is running its agents (version ${state.serverVersion}).`,
        action: { label: 'Stop all agents and continue', run: onStopAllAndContinue },
      };
    case 'stopped':
      return {
        tone: 'error',
        message: `${SERVICE} stopped: ${state.reason}.`,
        logPath: state.logPath,
        action: { label: 'Retry', run: onRetry },
      };
    case 'connected':
      break;
    // Connecting and reconnecting show on each terminal ("input paused"), not here.
    default:
      return null;
  }
  const runtime = state.runtime;
  if (runtime?.state === 'starting') return { tone: 'info', message: `${SERVICE} is starting…` };
  if (runtime?.state === 'degraded')
    return { tone: 'warn', message: `${SERVICE} is degraded: ${runtime.reason}.` };
  if (runtime?.state === 'unavailable')
    return {
      tone: 'error',
      message: `${SERVICE} can't run agents: ${runtime.reason}.`,
      logPath: runtime.logPath,
    };
  return null;
}

/** The app-wide server lifecycle notice under the top bar (W7 plan, Slice 4). */
export function ServerBanner({
  state,
  onRetry,
  onStopAllAndContinue,
}: {
  state: ServerUiState;
  onRetry: () => void;
  onStopAllAndContinue: () => void;
}) {
  const view = viewOf(state, onRetry, onStopAllAndContinue);
  if (!view) return null;
  return (
    <div className={`server-banner server-banner--${view.tone}`} role="region" aria-label={SERVICE}>
      <div className="server-banner__msg" role="status" aria-live="polite">
        {view.message}
        {view.logPath && (
          <>
            {' '}
            Log: <span className="server-banner__path">{view.logPath}</span>
          </>
        )}
      </div>
      {view.action && (
        <button type="button" className="btn" onClick={view.action.run}>
          {view.action.label}
        </button>
      )}
    </div>
  );
}

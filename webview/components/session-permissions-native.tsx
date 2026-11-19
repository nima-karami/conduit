import { useId, useState } from 'react';
import type {
  CodexPostureView,
  NativeLaunchFailure,
  NativeLaunchIntent,
  NativeSessionUi,
} from '../../src/contracts/native-launch';
import { NATIVE_LAUNCH_REFUSAL_MESSAGES } from '../../src/contracts/native-launch';
import type { StartRefusal } from '../../src/types';
import { MCP_STR } from '../conduit-mcp-strings';

export interface SessionPermissionsNativeProps {
  native: NativeSessionUi;
  posture: CodexPostureView;
  handStarted: boolean;
  refusal?: StartRefusal;
  onOpenSettings(): void;
  onLinkThread?: (uuid: string) => Promise<CodexPostureView>;
}

function describeIntent(intent: NativeLaunchIntent): string {
  if (!intent.optedIn) return 'Not opted in; no native mode requested';
  if (!intent.requested) return 'No native mode requested';
  if (intent.family === 'claude') return intent.requested.mode;
  return `${intent.requested.sandbox} · ${intent.requested.approval}`;
}

const RECOVERY: Record<NativeLaunchFailure, string> = {
  conflict: 'Remove the conflicting native permission flags from the agent launcher, then retry.',
  unsupported: 'Use a directly launched, supported Claude or Codex agent to apply a native mode.',
  'policy-unavailable': MCP_STR.sections.agents.nativeRecovery.policyUnavailable,
  'save-failed': MCP_STR.sections.agents.nativeRecovery.saveFailed,
};

function reportedTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function SessionPermissionsNative({
  native,
  posture,
  handStarted,
  refusal,
  onOpenSettings,
  onLinkThread,
}: SessionPermissionsNativeProps) {
  const fieldId = useId();
  const [uuid, setUuid] = useState('');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const linkThread = async () => {
    if (!onLinkThread || !uuid.trim() || pending) return;
    setPending(true);
    setFailed(false);
    try {
      const result = await onLinkThread(uuid.trim());
      if (result.status !== 'linked') {
        setFailed(true);
      } else {
        setUuid('');
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  const reading = posture.status === 'linked' ? posture.reading : null;
  const lastKnown = posture.status === 'linked' ? posture.lastKnown : null;

  return (
    <section className="session-permissions__section" aria-labelledby={fieldId}>
      <h3 className="session-permissions__heading" id={fieldId}>
        Agent’s own permissions
      </h3>
      {handStarted && (
        <p>
          This agent was started by hand. Its identity cannot be verified, and it is capped at
          Worker unless you choose otherwise. Its native mode is unknown.
        </p>
      )}
      {refusal?.reason === 'native_permissions' && (
        <div role="alert" className="session-permissions__refusal">
          <strong>Native launch refused</strong>
          <p>{NATIVE_LAUNCH_REFUSAL_MESSAGES[refusal.problem]}</p>
          <p>{RECOVERY[refusal.problem]}</p>
          <button type="button" className="btn btn--sm" onClick={onOpenSettings}>
            {MCP_STR.sections.agents.openInAgents}
          </button>
        </div>
      )}
      <p>
        <strong>Next launch:</strong>{' '}
        {native.next.status === 'available'
          ? describeIntent(native.next.intent)
          : native.next.status === 'not-applicable'
            ? 'Not applicable'
            : 'Unavailable'}
      </p>
      <p>
        <strong>At launch:</strong>{' '}
        {native.atLaunch
          ? `${native.atLaunch.intent.requested ? 'Requested ' : ''}${describeIntent(native.atLaunch.intent)} (${reportedTime(native.atLaunch.preparedAt)})`
          : 'Unknown: no launch request recorded'}
      </p>
      {posture.status === 'linked' ? (
        <div>
          <p>Linked Codex thread</p>
          <p>
            <strong>reported by the Codex thread:</strong>{' '}
            {reading?.status === 'known'
              ? `${reading.sandbox} · ${reading.approval} (${reportedTime(reading.reportedAt)})`
              : 'Unknown'}{' '}
            · {posture.freshness}
          </p>
          {reading?.status !== 'known' && lastKnown && (
            <p>
              Last known: {lastKnown.sandbox} · {lastKnown.approval} (
              {reportedTime(lastKnown.reportedAt)})
            </p>
          )}
        </div>
      ) : (
        <p>Codex thread unavailable; reported mode unknown.</p>
      )}
      {onLinkThread && (
        <div>
          <label htmlFor={`${fieldId}-thread`}>Codex thread UUID from /status</label>
          <input
            id={`${fieldId}-thread`}
            className="modal__input"
            value={uuid}
            onChange={(event) => setUuid(event.target.value)}
            disabled={pending}
          />
          <button
            type="button"
            className="btn btn--sm"
            disabled={pending || !uuid.trim()}
            onClick={() => void linkThread()}
          >
            {pending ? 'Linking…' : 'Link thread'}
          </button>
          {failed && <p role="alert">Could not link the thread. Check the UUID and try again.</p>}
        </div>
      )}
    </section>
  );
}

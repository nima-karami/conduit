import { useId, useRef, useState } from 'react';
import type {
  PreviewDraft,
  PreviewIntent,
  PreviewResult,
  Reason,
} from '../../src/conduit-mcp/policy-types';

export interface CheckRequestSession {
  id: string;
  label: string;
}

function reasonLabel(reason: Reason): string {
  switch (reason.by) {
    case 'floor':
      return `Policy floor: ${reason.floor}`;
    case 'deny':
      return `Denied by an exception at ${reason.point.kind}`;
    case 'session-deny':
      return 'Denied for this session';
    case 'override':
      return 'One-use override';
    case 'grant':
      return 'Active grant';
    case 'exception':
      return `Exception at ${reason.point.kind}`;
    case 'profile':
      return `Role at ${reason.point.kind}`;
  }
}

export function PermissionsCheckRequest({
  sessions,
  draft,
  expectedToken,
  previewPolicy,
}: {
  sessions: readonly CheckRequestSession[];
  draft: PreviewDraft | null;
  expectedToken: string;
  previewPolicy: (
    sessionId: string,
    intent: PreviewIntent,
    draft: PreviewDraft | null,
    expectedToken: string,
  ) => Promise<PreviewResult | null>;
}) {
  const fieldsId = useId();
  const [sessionId, setSessionId] = useState('');
  const [tool, setTool] = useState<PreviewIntent['tool']>('close_session');
  const [targetSessionId, setTargetSessionId] = useState('');
  const [filePath, setFilePath] = useState('');
  const [response, setResponse] = useState<{ key: string; result: PreviewResult | null } | null>(
    null,
  );
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const request = useRef(0);
  const key = JSON.stringify([
    sessionId,
    tool,
    targetSessionId,
    filePath,
    draft,
    expectedToken,
    sessions,
  ]);
  const currentKey = useRef(key);
  if (currentKey.current !== key) {
    currentKey.current = key;
    request.current++;
  }
  const result = response?.key === key ? response.result : null;
  const unavailable = response?.key === key && response.result === null;
  const pending = pendingKey === key;
  const selectedSession = sessions.some((session) => session.id === sessionId);
  const selectedTarget = sessions.some((session) => session.id === targetSessionId);
  const canCheck =
    selectedSession && (tool === 'close_session' ? selectedTarget : filePath.trim().length > 0);
  const check = async () => {
    if (!canCheck) return;
    const id = ++request.current;
    const intent: PreviewIntent =
      tool === 'close_session' ? { tool, targetSessionId } : { tool, path: filePath };
    setPendingKey(key);
    setResponse(null);
    try {
      const next = await previewPolicy(sessionId, intent, draft, expectedToken);
      if (id !== request.current || currentKey.current !== key) return;
      setResponse({ key, result: next });
    } catch {
      if (id !== request.current || currentKey.current !== key) return;
      setResponse({ key, result: null });
    } finally {
      if (id === request.current) setPendingKey(null);
    }
  };
  return (
    <section className="session-permissions__section" aria-labelledby={`${fieldsId}-heading`}>
      <h3 id={`${fieldsId}-heading`}>Check a request</h3>
      <p>
        Check current policy without running the request.{' '}
        {draft ? 'The current draft is included.' : 'No draft is included.'}
      </p>
      <div className="permissions-fields">
        <span className="permissions-field">
          <label htmlFor={`${fieldsId}-session`}>Session</label>
          <select
            id={`${fieldsId}-session`}
            className="session-permissions__select"
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
          >
            <option value="">Choose a session</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.label}
              </option>
            ))}
          </select>
        </span>
        <span className="permissions-field">
          <label htmlFor={`${fieldsId}-action`}>Action</label>
          <select
            id={`${fieldsId}-action`}
            className="session-permissions__select"
            value={tool}
            onChange={(event) =>
              setTool(event.target.value === 'open_file' ? 'open_file' : 'close_session')
            }
          >
            <option value="close_session">close_session</option>
            <option value="open_file">open_file</option>
          </select>
        </span>
        {tool === 'close_session' ? (
          <span className="permissions-field">
            <label htmlFor={`${fieldsId}-target`}>Target session</label>
            <select
              id={`${fieldsId}-target`}
              className="session-permissions__select"
              value={targetSessionId}
              onChange={(event) => setTargetSessionId(event.target.value)}
            >
              <option value="">Choose a target</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.label}
                </option>
              ))}
            </select>
          </span>
        ) : (
          <label className="permissions-field">
            Absolute file path
            <input value={filePath} onChange={(event) => setFilePath(event.target.value)} />
          </label>
        )}
        <button
          type="button"
          className="btn btn--sm"
          disabled={!canCheck || pending}
          onClick={() => void check()}
        >
          {pending ? 'Checking…' : 'Check request'}
        </button>
      </div>
      <div role="status" aria-live="polite">
        {result?.ok && (
          <p>
            <strong>{result.decision.decision.toUpperCase()}</strong> —{' '}
            {reasonLabel(result.decision.reason)}. Runtime conditions have not been evaluated.
          </p>
        )}
        {result && !result.ok && (
          <p>
            {result.error === 'conflict'
              ? 'Policy changed. Refresh the policy and check again.'
              : result.error === 'not-found'
                ? 'The session is no longer available.'
                : result.error === 'read-only'
                  ? 'Policy is read-only; this request cannot be checked.'
                  : 'The request or draft is invalid or unsupported.'}
          </p>
        )}
        {unavailable && <p>The check is unavailable. Try again.</p>}
      </div>
    </section>
  );
}

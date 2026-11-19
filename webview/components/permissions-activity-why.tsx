import { useEffect, useId, useRef, useState } from 'react';
import type { ActivityEntry } from '../../src/conduit-mcp/activity-log';
import type { Reason, Scope } from '../../src/conduit-mcp/policy-types';
import type { ToolName } from '../../src/conduit-mcp/tool-policy';

function pointLabel(point: Extract<Reason, { point: unknown }>['point']): string {
  switch (point.kind) {
    case 'default':
      return 'default';
    case 'cli':
      return `${point.cli} sessions`;
    case 'session':
      return `session ${point.sessionId}`;
    case 'peer':
      return `machine ${point.machineId}`;
  }
}
function reasonLabel(reason: Reason): string {
  switch (reason.by) {
    case 'floor':
      return `Floor: ${reason.floor}`;
    case 'deny':
      return `Deny exception at ${pointLabel(reason.point)}`;
    case 'session-deny':
      return 'Session denial';
    case 'override':
      return 'One-use override';
    case 'grant':
      return 'Grant';
    case 'exception':
      return `Exception at ${pointLabel(reason.point)}`;
    case 'profile':
      return `Role at ${pointLabel(reason.point)}`;
  }
}

export interface ActivityExceptionSource {
  row: ActivityEntry;
  tool: ToolName;
  scope: Scope;
}

export function PermissionsActivityWhy({
  row,
  canAllowOnce,
  canEditException = true,
  onAllowOnce,
  onAddException,
  onClose,
}: {
  row: ActivityEntry;
  canAllowOnce: boolean;
  canEditException?: boolean;
  onAllowOnce: (row: ActivityEntry) => Promise<boolean>;
  onAddException: (source: ActivityExceptionSource) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [pendingRow, setPendingRow] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ key: string; result: 'allowed' | 'refused' } | null>(null);
  const key = JSON.stringify([row.id, row.at]);
  const current = useRef(key);
  current.current = key;
  const pending = pendingRow === key;
  const result = answer?.key === key ? answer.result : null;
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const trace = row.trace;
  const facts = trace?.facts;
  const target =
    facts?.principal.kind === 'session' && facts.targets.length === 1 ? facts.targets[0] : null;
  const exactScope: Scope | null =
    target && facts?.tool === 'close_session' && target.sessionId !== null
      ? { kind: 'session', sessionId: target.sessionId }
      : target && facts?.tool === 'open_file' && target.path !== null
        ? { kind: 'path', path: target.path }
        : null;
  const eligibleOnce =
    canAllowOnce &&
    trace?.decision === 'deny' &&
    trace.reason.by === 'deny' &&
    facts?.tool === 'close_session' &&
    exactScope?.kind === 'session';
  const allow = async () => {
    setPendingRow(key);
    try {
      const result = (await onAllowOnce(row)) ? 'allowed' : 'refused';
      if (current.current === key) setAnswer({ key, result });
    } catch {
      if (current.current === key) setAnswer({ key, result: 'refused' });
    } finally {
      setPendingRow((pendingKey) => (pendingKey === key ? null : pendingKey));
    }
  };
  return (
    <aside
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <h2 id={titleId} ref={heading} tabIndex={-1}>
        Why {row.decision === 'deny' ? 'was this denied' : 'did this happen'}?
      </h2>
      <p>
        {row.principal.handle ?? 'Unknown session'} · {row.action}
        {row.target ? ` · ${row.target}` : ''} · {row.at}
      </p>
      {row.lane === 'observed' ? (
        <p>This is an observed CLI action. Conduit did not record a policy decision for it.</p>
      ) : !trace ? (
        <p>Decision details are unavailable for this Activity entry.</p>
      ) : (
        <>
          <h3>How Conduit decided</h3>
          <p>
            <strong>{trace.decision.toUpperCase()}</strong> — {reasonLabel(trace.reason)}
          </p>
          {trace.assignment && (
            <p>
              Role: {trace.assignment.profileName} ({pointLabel(trace.assignment.point)})
            </p>
          )}
          <p>Decision time: {trace.decidedAt}</p>
          {trace.withoutWinner && (
            <p>
              Without this winner: {trace.withoutWinner.decision.toUpperCase()} —{' '}
              {reasonLabel(trace.withoutWinner.reason)}
            </p>
          )}
          <h3>What happened</h3>
          <p>
            Runtime outcome: {trace.runtime.outcome}
            {trace.runtime.code ? ` (${trace.runtime.code})` : ''}
          </p>
          {(eligibleOnce || exactScope) && <h3>Change it</h3>}
          {eligibleOnce && (
            <button
              type="button"
              className="btn btn--sm"
              disabled={pending || result === 'allowed'}
              onClick={() => void allow()}
            >
              {pending ? 'Checking…' : 'Allow this once'}
            </button>
          )}
          {canEditException && trace?.reason.by !== 'floor' && exactScope && facts && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onAddException({ row, tool: facts.tool, scope: exactScope })}
            >
              Add exception
            </button>
          )}
          {eligibleOnce && (
            <p>
              The agent must retry. The current policy and runtime conditions are checked again.
            </p>
          )}
          {result === 'allowed' && <p role="status">The agent may retry this target once.</p>}
          {result === 'refused' && (
            <p role="status">Allow once is unavailable. The policy or session may have changed.</p>
          )}
        </>
      )}
      <button type="button" className="btn btn--sm" onClick={onClose}>
        Back
      </button>
    </aside>
  );
}

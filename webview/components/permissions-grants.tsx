import { useEffect, useRef, useState } from 'react';
import type { Grant, PolicyUiState } from '../../src/conduit-mcp/policy-types';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { describeExceptionScope } from './session-permission-exceptions';

export interface PermissionsGrantsProps {
  policy: PolicyUiState;
  grantLifecycle: ConduitMcpApi['grantLifecycle'];
}

type Operation = Parameters<ConduitMcpApi['grantLifecycle']>[0];

function owner(grant: Grant, policy: PolicyUiState): string {
  if (grant.who.kind === 'session')
    return `Session ${policy.sessions[grant.who.sessionId]?.label ?? grant.who.sessionId}`;
  if (grant.who.kind === 'cli') return `${grant.who.cli} sessions`;
  return `Machine ${grant.who.machineId}`;
}

function expiry(grant: Grant): string {
  return grant.expiresAt
    ? `Expires ${new Date(grant.expiresAt).toLocaleString()}`
    : 'No timed expiry';
}

export function PermissionsGrants({ policy, grantLifecycle }: PermissionsGrantsProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!receipt) return;
    undoRef.current?.focus();
    const timer = window.setTimeout(() => {
      setReceipt(null);
      if (document.activeElement === undoRef.current) headingRef.current?.focus();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [receipt]);

  async function run(operation: Operation) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await grantLifecycle(operation);
      if (!result) setError('Could not reach the permissions service. Try again.');
      else if (!result.ok)
        setError(
          `Could not save the grant change (${result.error}).${result.applied === 'tightening' ? ' The restriction was applied in memory.' : ''}`,
        );
      else if (operation.kind === 'revoke' && result.undoToken) setReceipt(result.undoToken);
      else if (operation.kind === 'undo') {
        setReceipt(null);
        headingRef.current?.focus();
      }
    } catch {
      setError('Could not save the grant change. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="permissions-grants" aria-labelledby="permissions-grants-heading">
      <h3 id="permissions-grants-heading" ref={headingRef} tabIndex={-1}>
        Grants
      </h3>
      <p>Permissions granted for a specific action and scope. Other restrictions still apply.</p>
      {policy.readOnly && <p>Permissions are read-only.</p>}
      {error && <p role="alert">{error}</p>}
      {pending && <p role="status">Saving grant change…</p>}
      {receipt && (
        <div role="status">
          Grant revoked.{' '}
          <button
            ref={undoRef}
            type="button"
            disabled={pending || policy.readOnly}
            onClick={() => void run({ kind: 'undo', token: receipt })}
          >
            Undo
          </button>
        </div>
      )}
      {policy.grants.length === 0 ? (
        <p>No grants yet.</p>
      ) : (
        <ul className="permissions-grants__list">
          {policy.grants.map((grant) => {
            const operation = (kind: 'extend' | 'renew' | 'revoke'): Operation => ({
              kind,
              id: grant.id,
              revision: grant.lifecycleRevision ?? 0,
              expectedToken: policy.editToken,
            });
            const active =
              grant.state === 'active' &&
              (grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.now());
            const canExtend = active && grant.expiresAt !== null;
            const canRenew =
              grant.state === 'expired' && (grant.for === '1h' || grant.for === '24h');
            const canRevoke = grant.state === 'active' || grant.state === 'suspended';
            return (
              <li className="permissions-grants__item" key={grant.id}>
                <strong>{grant.tool}</strong>{' '}
                <span>
                  {grant.state}
                  {grant.expiring && active ? ' · Expiring soon' : ''}
                </span>
                <p>
                  {owner(grant, policy)} · {describeExceptionScope(grant.on)} · {grant.for}
                </p>
                <p>
                  {expiry(grant)} ·{' '}
                  {grant.useCount !== undefined
                    ? `${grant.useCount} uses`
                    : grant.lastUsedAt
                      ? `Last used ${new Date(grant.lastUsedAt).toLocaleString()}`
                      : 'No recorded use'}{' '}
                  · {grant.requestId ? 'From permission request' : 'Grant'}
                </p>
                {canExtend && (
                  <button
                    type="button"
                    disabled={pending || policy.readOnly}
                    aria-label={`Extend ${grant.tool} grant by one hour`}
                    onClick={() => void run(operation('extend'))}
                  >
                    Extend +1h
                  </button>
                )}
                {canRenew && (
                  <button
                    type="button"
                    disabled={pending || policy.readOnly}
                    aria-label={`Renew ${grant.tool} grant`}
                    onClick={() => void run(operation('renew'))}
                  >
                    Renew
                  </button>
                )}
                {canRevoke && (
                  <button
                    type="button"
                    disabled={pending || policy.readOnly}
                    aria-label={`Revoke ${grant.tool} grant`}
                    onClick={() => void run(operation('revoke'))}
                  >
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

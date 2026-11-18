import { useId, useState } from 'react';
import type { PolicyEditResult, ProfileId } from '../../src/conduit-mcp/policy-types';
import type { RemotePolicyUi } from '../../src/conduit-mcp/ui-types';
import type { NetworkLinkView } from '../../src/contracts/network-state';
import { setLinkCapability } from '../network-store';
import type { ConduitMcpApi } from '../use-conduit-mcp';

interface OwnMachinePermissionsProps {
  link: NetworkLinkView;
  remote: RemotePolicyUi | null;
  mcp: ConduitMcpApi;
  sshController: boolean;
  onOpenRequest?: (id: string) => void;
  onOpenActivity?: () => void;
}

function resultText(result: PolicyEditResult | null): string | null {
  if (!result)
    return 'The machine did not confirm the change. Check its rules before trying again.';
  if (result.ok) return null;
  if (result.error === 'conflict')
    return 'The rules changed. Review the latest version before trying again.';
  if (result.error === 'native-review-required')
    return 'These rules need native launch review before they can be applied.';
  return `The change could not be saved (${result.error}).`;
}

/** Rules and capability facts for one own-linked machine. */
export function OwnMachinePermissions({
  link,
  remote,
  mcp,
  sshController,
  onOpenRequest,
  onOpenActivity,
}: OwnMachinePermissionsProps) {
  const profileId = useId();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const capabilityChange = async (capability: 'messaging' | 'monitor' | 'drive', on: boolean) => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await setLinkCapability(link.machineId, capability, on, link.editToken);
      if (result === 'conflict')
        setFailure('This link changed. Review its current settings and try again.');
      else if (result === 'failed') setFailure('The capability could not be changed.');
    } catch {
      setFailure('The capability could not be changed.');
    } finally {
      setPending(false);
    }
  };
  const policy = remote?.policy;
  const assignment = policy
    ? (policy.assignments.find(({ point }) => point.kind === 'default')?.assignment ?? {
        profileId: 'worker' as const,
        exceptions: [],
        onScreenOnly: false,
      })
    : null;
  const edit = async (profileId: ProfileId) => {
    if (!remote || !assignment || pending) return;
    setPending(true);
    setFailure(null);
    try {
      setFailure(
        resultText(
          await mcp.remoteEdit(remote.machineId, policy?.editToken ?? '', {
            kind: 'assignment',
            point: { kind: 'default' },
            assignment: { ...assignment, profileId },
          }),
        ),
      );
    } catch {
      setFailure('The machine did not confirm the change. Check its rules before trying again.');
    } finally {
      setPending(false);
    }
  };
  const resolve = async (action: 'discard' | 'reapply' | 'retry-save') => {
    if (!remote || pending) return;
    setPending(true);
    setFailure(null);
    try {
      setFailure(
        resultText(await mcp.remotePolicy(remote.machineId, action, remote.policy.editToken)),
      );
    } catch {
      setFailure('The machine did not confirm the change. Check its rules before trying again.');
    } finally {
      setPending(false);
    }
  };
  const revoke = async (id: string) => {
    if (!remote || pending) return;
    setPending(true);
    setFailure(null);
    try {
      if (!(await mcp.revokeGrant(id, remote.machineId)))
        setFailure('The grant could not be revoked.');
    } catch {
      setFailure('The grant could not be revoked.');
    } finally {
      setPending(false);
    }
  };
  return (
    <section aria-label={`${link.name} permissions`}>
      <h3>
        {link.name} <small>own machine</small>
      </h3>
      <p>{link.state === 'up' ? 'Connected' : 'Not connected'}</p>
      <h4>What crosses this link</h4>
      <dl>
        {(['messaging', 'monitor', 'drive'] as const).map((capability) => (
          <div key={capability}>
            <dt>{capability[0].toUpperCase() + capability.slice(1)}</dt>
            <dd>
              <button
                type="button"
                className="btn btn--sm"
                aria-label={`${capability} for ${link.name}`}
                aria-pressed={link.capabilities[capability]}
                disabled={pending || (capability === 'drive' && sshController)}
                onClick={() => void capabilityChange(capability, !link.capabilities[capability])}
              >
                {link.capabilities[capability] ? 'On' : 'Off'}
              </button>
            </dd>
          </div>
        ))}
      </dl>
      <p>
        Agents on this machine still follow your rules. On-screen-only permissions do not apply
        remotely.
      </p>
      {sshController && <p>Drive is granted by the SSH connection.</p>}
      <h4>Sessions on {link.name}</h4>
      {!link.snapshot ? (
        <p>Session details are unavailable.</p>
      ) : link.snapshot.sessions.length === 0 ? (
        <p>No sessions.</p>
      ) : (
        <ul>
          {link.snapshot.sessions.map((session) => (
            <li key={session.sessionId}>
              {session.label} · {session.agent}
            </li>
          ))}
        </ul>
      )}
      <h4>Requests from {link.name}</h4>
      {(mcp.state?.requests.open ?? []).filter(
        (request) => request.origin === link.machineId && request.remote,
      ).length === 0 ? (
        <p>No pending requests.</p>
      ) : (
        <ul>
          {(mcp.state?.requests.open ?? [])
            .filter((request) => request.origin === link.machineId && request.remote)
            .map((request) => (
              <li key={request.id}>
                {request.title} {request.remote?.stale && '(connection unavailable)'}{' '}
                {onOpenRequest && (
                  <button type="button" onClick={() => onOpenRequest(request.id)}>
                    Open request
                  </button>
                )}
              </li>
            ))}
        </ul>
      )}
      <h4>Rules on {link.name}</h4>
      {!remote || remote.rev === null ? (
        <p>No rules have been received from this machine yet.</p>
      ) : (
        <>
          <p role="status">
            {remote.status === 'applied'
              ? 'Rules applied'
              : remote.status === 'pushing'
                ? 'Sending rules'
                : remote.status === 'waiting'
                  ? 'Waiting for this machine'
                  : remote.status === 'conflict'
                    ? 'Rules changed on both machines'
                    : `Rules refused${remote.refusal ? `: ${remote.refusal}` : ''}`}
          </p>
          {policy?.saveError && <p role="alert">{policy.saveError}</p>}
          {policy?.backupWarning && <p role="status">{policy.backupWarning}</p>}
          {assignment && (
            <div>
              <label htmlFor={profileId}>Default profile</label>{' '}
              <select
                id={profileId}
                className="selectfield"
                value={assignment.profileId}
                disabled={pending || policy?.readOnly || remote.status === 'conflict'}
                onChange={(event) => void edit(event.target.value as ProfileId)}
              >
                {policy?.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {remote.status === 'conflict' && (
            <div>
              <button type="button" disabled={pending} onClick={() => void resolve('discard')}>
                Use machine's rules
              </button>
              <button type="button" disabled={pending} onClick={() => void resolve('reapply')}>
                Apply my changes
              </button>
            </div>
          )}
          {policy?.saveError && (
            <button type="button" disabled={pending} onClick={() => void resolve('retry-save')}>
              Retry saving
            </button>
          )}
          <h4>Grants on {link.name}</h4>
          {remote.grants.length === 0 ? (
            <p>No active grants.</p>
          ) : (
            <ul>
              {remote.grants.map((grant) => (
                <li key={grant.id}>
                  {grant.who}: {grant.tool} ·{' '}
                  {grant.on.kind === 'anywhere'
                    ? 'Anywhere'
                    : grant.on.kind === 'space'
                      ? grant.on.projectId
                      : grant.on.kind === 'session'
                        ? grant.on.sessionId
                        : grant.on.path}{' '}
                  · {grant.for}{' '}
                  <button
                    type="button"
                    disabled={pending || link.state !== 'up'}
                    onClick={() => void revoke(grant.id)}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {onOpenActivity && (
        <button type="button" className="btn btn--sm" onClick={onOpenActivity}>
          Activity involving {link.name}
        </button>
      )}
      {failure && <p role="alert">{failure}</p>}
    </section>
  );
}

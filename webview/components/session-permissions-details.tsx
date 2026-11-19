import { useEffect, useRef, useState } from 'react';
import type { ActivityEntry } from '../../src/conduit-mcp/activity-log';
import type { PolicyUiState } from '../../src/conduit-mcp/policy-types';
import type { CodexPostureView } from '../../src/contracts/native-launch';
import type { Session } from '../../src/types';
import { subscribe } from '../bridge';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { PermissionStoreNotice } from './permission-store-notice';
import { SessionPermissionActivity } from './session-permission-activity';
import { describeExceptionScope } from './session-permission-exceptions';
import { SessionPermissionsNative } from './session-permissions-native';

export type OpenSessionActivity = (
  sessionId: string,
  item?: Pick<ActivityEntry, 'id' | 'at'>,
) => void;

export function SessionActiveGrants({
  sessionId,
  policy,
  readOnly,
  revokeGrant,
}: {
  sessionId: string;
  policy: PolicyUiState;
  readOnly: boolean;
  revokeGrant: ConduitMcpApi['revokeGrant'];
}) {
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const cli = policy.sessions[sessionId]?.launchedCli;
  const grants = policy.grants.filter(
    (grant) =>
      grant.state === 'active' &&
      (grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.now()) &&
      ((grant.who.kind === 'session' && grant.who.sessionId === sessionId) ||
        (grant.who.kind === 'cli' && grant.who.cli === cli)),
  );
  const revoke = async (id: string) => {
    setRevoking(id);
    setError(false);
    try {
      setError(!(await revokeGrant(id)));
    } catch {
      setError(true);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="permissions-stack" aria-label="Active grants">
      <h4 className="permissions-agents-drawer__canhead">Active grants · {grants.length}</h4>
      <p>Grants apply when their scope matches. Other restrictions still apply.</p>
      {grants.length === 0 ? (
        <p>None</p>
      ) : (
        <ul className="permissions-agents-drawer__changes">
          {grants.map((grant) => (
            <li key={grant.id} className="permissions-agents-drawer__change">
              <div>
                <code>{grant.tool}</code>
                <span>
                  {' '}
                  · {describeExceptionScope(grant.on)} · {grant.for}
                  {grant.who.kind === 'cli' ? ` · All ${grant.who.cli} agents` : ''}
                  {grant.expiresAt
                    ? ` · Expires ${new Date(grant.expiresAt).toLocaleString()}`
                    : ''}
                </span>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                aria-label={`Revoke ${grant.tool} grant`}
                disabled={readOnly || revoking !== null}
                onClick={() => void revoke(grant.id)}
              >
                {revoking === grant.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert">Could not revoke the grant. Try again.</p>}
    </section>
  );
}

export function SessionPermissionsDetails({
  session,
  policy,
  mcp,
  onOpenActivity,
  applyNative,
  onApplyNativeChange,
}: {
  session: Session;
  policy: PolicyUiState;
  mcp: ConduitMcpApi;
  onOpenActivity?: OpenSessionActivity;
  applyNative?: boolean;
  onApplyNativeChange?(apply: boolean): void;
}) {
  const row = policy.sessions[session.id];
  const native = mcp.state?.native[session.id];
  const generation = session.runtime?.spawn === 'live' ? session.runtime.generation : null;
  const canLink = generation !== null && native?.atLaunch?.intent.family === 'codex';
  const [posture, setPosture] = useState<CodexPostureView>({ status: 'unavailable' });
  const alive = useRef(true);
  const postureVersion = useRef(0);
  const currentPostureScope = useRef({ id: session.id, generation });
  currentPostureScope.current = { id: session.id, generation };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    postureVersion.current += 1;
    setPosture({ status: 'unavailable' });
    if (!canLink || generation === null) return;
    let active = true;
    let changed = false;
    const queryVersion = postureVersion.current;
    const unsubscribe = subscribe((message) => {
      if (
        message.type === 'mcp:codexPostureChanged' &&
        message.sessionId === session.id &&
        message.generation === generation
      ) {
        changed = true;
        postureVersion.current += 1;
        setPosture(message.view);
      }
    });
    void mcp.codexPostureQuery(session.id, generation).then((view) => {
      if (active && !changed && postureVersion.current === queryVersion) setPosture(view);
    });
    return () => {
      active = false;
      postureVersion.current += 1;
      unsubscribe();
    };
  }, [canLink, generation, session.id, mcp.codexPostureQuery]);
  return (
    <>
      <PermissionStoreNotice
        saveError={policy.saveError}
        backupWarning={policy.backupWarning}
        readOnly={policy.readOnly}
        onRetry={mcp.retryPolicy}
      />
      {native && (
        <SessionPermissionsNative
          key={`${session.id}:${generation ?? 'none'}:${session.runtime?.spawn ?? 'unknown'}`}
          refusal={session.startRefusal}
          native={native}
          applyNative={applyNative}
          onApplyNativeChange={onApplyNativeChange}
          posture={posture}
          handStarted={
            row?.launchedCli === null &&
            generation !== null &&
            mcp.state?.sessions[session.id]?.connected === true
          }
          onLinkThread={
            canLink && generation !== null
              ? async (uuid) => {
                  const version = postureVersion.current;
                  const result = await mcp.linkCodexThread(session.id, generation, uuid);
                  if (
                    alive.current &&
                    postureVersion.current === version &&
                    currentPostureScope.current.id === session.id &&
                    currentPostureScope.current.generation === generation
                  ) {
                    postureVersion.current += 1;
                    setPosture(result);
                    return result;
                  }
                  return { status: 'unavailable' };
                }
              : undefined
          }
        />
      )}
      <SessionPermissionActivity
        sessionId={session.id}
        getActivity={mcp.getActivity}
        onOpenActivity={onOpenActivity && ((item) => onOpenActivity(session.id, item))}
      />
      {onOpenActivity && (
        <button
          type="button"
          className="permissions-drawer__link"
          onClick={() => onOpenActivity(session.id)}
        >
          View Activity
        </button>
      )}
    </>
  );
}

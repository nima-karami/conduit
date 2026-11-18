import { useEffect, useRef, useState } from 'react';
import type { ActivityEntry } from '../../src/conduit-mcp/activity-log';
import { pointKey } from '../../src/conduit-mcp/policy-profiles';
import type {
  Assignment,
  AssignmentPoint,
  PolicyUiState,
  ProfileId,
} from '../../src/conduit-mcp/policy-types';
import type { CodexPostureView, NativeSessionUi } from '../../src/contracts/native-launch';
import type { Session } from '../../src/types';
import { subscribe } from '../bridge';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import {
  PermissionsSessionDialog,
  type SessionPermissionsReview,
} from './permissions-session-dialog';

function atPoint(policy: PolicyUiState, point: AssignmentPoint, profileId: ProfileId): Assignment {
  return structuredClone(
    policy.assignments.find((entry) => pointKey(entry.point) === pointKey(point))?.assignment ?? {
      profileId,
      exceptions: [],
      onScreenOnly: false,
    },
  );
}

export function SessionPermissionsController({
  session,
  policy,
  native,
  mcp,
  onClose,
  onOpenSettings,
  onOpenActivity,
  onRelaunch,
}: {
  session: Session;
  policy: PolicyUiState;
  native: NativeSessionUi;
  mcp: ConduitMcpApi;
  onClose(): void;
  onOpenSettings(): void;
  onOpenActivity(item?: Pick<ActivityEntry, 'id' | 'at'>): void;
  onRelaunch(id: string, generation: number | null): Promise<void>;
}) {
  const row = policy.sessions[session.id];
  const [draft] = useState(() => ({
    inherited: atPoint(policy, row.inheritedPoint, row.inheritedProfileId),
    initial: atPoint(policy, row.sourcePoint, row.profileId),
    isInherited: row.sourcePoint.kind !== 'session',
    token: policy.editToken,
  }));
  const stale = draft.token !== policy.editToken;
  const generation = session.runtime?.spawn === 'live' ? session.runtime.generation : null;
  const canLink = generation !== null && native.atLaunch?.intent.family === 'codex';
  const [posture, setPosture] = useState<CodexPostureView>({ status: 'unavailable' });
  const [review, setReview] = useState<
    | (SessionPermissionsReview & {
        candidate: Assignment | null;
        generation: number | null;
        token: string;
        digest?: string;
      })
    | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invoker] = useState(() => document.activeElement);
  const close = () => {
    onClose();
    if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus();
    else
      document
        .querySelector<HTMLElement>(`.session[data-sessionid="${CSS.escape(session.id)}"]`)
        ?.focus();
  };
  const alive = useRef(true);
  const postureVersion = useRef(0);
  const currentPostureScope = useRef({ id: session.id, generation });
  currentPostureScope.current = { id: session.id, generation };
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
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
  const point: AssignmentPoint = { kind: 'session', sessionId: session.id };
  const requestReview = async (candidate: Assignment | null) => {
    if (stale) return;
    const frozen = candidate === null ? null : structuredClone(candidate);
    const token = draft.token;
    setPending(true);
    setError(null);
    const result = await mcp.reviewLocalPolicy(
      { kind: 'assignment', point, assignment: frozen },
      token,
    );
    if (!alive.current) return;
    setPending(false);
    if (!result?.ok) {
      setError(`Could not review permissions (${result?.error ?? 'timeout'}). Reload and retry.`);
      return;
    }
    setReview({
      before: draft.initial,
      after: frozen ?? draft.inherited,
      nativeRelaunch:
        result.requiresNativeReview &&
        native.next.status === 'available' &&
        row.launchedCli !== null &&
        (session.runtime?.spawn === 'none' ||
          (session.runtime?.spawn === 'live' && generation !== null)),
      candidate: frozen,
      generation,
      token,
      ...(result.requiresNativeReview ? { digest: result.digest } : {}),
    });
  };
  const apply = async (relaunch: boolean) => {
    if (!review || review.token !== policy.editToken || review.generation !== generation) {
      setError('Permissions changed. Go back and review again.');
      return;
    }
    setPending(true);
    setError(null);
    const result = await mcp.saveAssignment(point, review.candidate, review.token, review.digest);
    if (!alive.current) return;
    if (!result?.ok) {
      setPending(false);
      setError(
        `Could not save permissions (${result?.error ?? 'timeout'}). Go back and review again.`,
      );
      return;
    }
    if (relaunch) {
      try {
        await onRelaunch(session.id, review.generation);
      } catch (failure) {
        if (alive.current) {
          setPending(false);
          setError(
            `Saved, but could not relaunch: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
          setReview(null);
        }
        return;
      }
    }
    if (alive.current) {
      setPending(false);
      close();
    }
  };
  return (
    <PermissionsSessionDialog
      session={session}
      policy={policy}
      draft={draft.isInherited ? draft.inherited : draft.initial}
      inherited={draft.isInherited}
      native={native}
      posture={posture}
      handStarted={
        row.launchedCli === null &&
        session.runtime?.spawn === 'live' &&
        mcp.state?.sessions[session.id]?.connected === true
      }
      nativeOptInSupported={native.next.status === 'available'}
      review={stale ? null : review}
      pending={pending}
      stale={stale}
      error={stale ? 'Permissions changed. Close and reopen this dialog to edit.' : error}
      onClose={close}
      onOpenSettings={onOpenSettings}
      onOpenActivity={onOpenActivity}
      onRetry={mcp.retryPolicy}
      getActivity={mcp.getActivity}
      onReview={(candidate) => void requestReview(candidate)}
      onBack={() => {
        setReview(null);
        setError(null);
      }}
      onConfirm={(relaunch) => void apply(relaunch)}
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
  );
}

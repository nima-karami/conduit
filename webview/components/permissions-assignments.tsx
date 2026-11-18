import { useEffect, useRef, useState } from 'react';
import { pointKey } from '../../src/conduit-mcp/policy-profiles';
import type {
  Assignment,
  AssignmentPoint,
  PolicyUiState,
  PreviewDraft,
  Profile,
  ProfileId,
  ReplayResult,
  Scope,
} from '../../src/conduit-mcp/policy-types';
import { CLI_KINDS, TOOL_NAMES, type ToolName } from '../../src/conduit-mcp/tool-policy';
import { folderKey } from '../../src/folder-key';
import type { Session } from '../../src/types';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import { PermissionsAssignmentExceptions } from './permissions-assignment-exceptions';
import { PermissionsCheckRequest } from './permissions-check-request';
import {
  describeExceptionScope,
  SessionPermissionExceptions,
} from './session-permission-exceptions';

type Edit = {
  point: AssignmentPoint;
  draft: Assignment;
  before: Assignment;
  token: string;
};
type Review = Edit & {
  candidate: Assignment | null;
  after: Assignment;
  digest?: string;
};
const fallback: Assignment = {
  profileId: 'worker',
  exceptions: [],
  onScreenOnly: false,
};

function label(point: AssignmentPoint): string {
  switch (point.kind) {
    case 'default':
      return 'Default';
    case 'cli':
      return `${point.cli} sessions`;
    case 'session':
      return `Session ${point.sessionId}`;
    case 'peer':
      return `Machine ${point.machineId}`;
  }
}
function assignmentAt(policy: PolicyUiState, point: AssignmentPoint): Assignment | undefined {
  return policy.assignments.find((entry) => pointKey(entry.point) === pointKey(point))?.assignment;
}
function inheritedAt(policy: PolicyUiState, point: AssignmentPoint): Assignment {
  if (point.kind === 'session') {
    const row = policy.sessions[point.sessionId];
    if (row)
      return (
        assignmentAt(policy, row.inheritedPoint) ?? {
          ...fallback,
          profileId: row.inheritedProfileId,
        }
      );
  }
  return point.kind === 'default'
    ? fallback
    : (assignmentAt(policy, { kind: 'default' }) ?? fallback);
}
function profileFor(policy: PolicyUiState, assignment: Assignment): Profile | undefined {
  return policy.profiles.find((profile) => profile.id === assignment.profileId);
}
function exceptionEntries(assignment: Assignment) {
  const seen = new Map<string, number>();
  return assignment.exceptions.map((entry, index) => {
    const signature = JSON.stringify(entry);
    const count = seen.get(signature) ?? 0;
    seen.set(signature, count + 1);
    return { entry, index, key: `${signature}:${count}` };
  });
}
/** A count, not the list: the list lives in the edit view, where it has room. */
function exceptionCount(assignment: Assignment): string {
  const n = assignment.exceptions.length;
  return n === 0 ? 'None' : n === 1 ? '1 exception' : `${n} exceptions`;
}
function facts(policy: PolicyUiState, assignment: Assignment) {
  const profile = profileFor(policy, assignment);
  return (
    <>
      <p>
        Profile: {profile?.name ?? assignment.profileId} · On-screen only:{' '}
        {assignment.onScreenOnly ? 'yes' : 'no'} · Native modes enabled:{' '}
        {assignment.applyNative ? 'yes' : 'no'}
      </p>
      <p>
        Claude at launch:{' '}
        {assignment.applyNative ? (profile?.nativeModes?.claude ?? 'CLI default') : 'CLI default'} ·
        Codex at launch:{' '}
        {assignment.applyNative ? (profile?.nativeModes?.codex ?? 'CLI default') : 'CLI default'}
      </p>
      <ul>
        {profile &&
          TOOL_NAMES.map((tool) => (
            <li key={tool}>
              {tool}:{' '}
              {Object.entries(profile.rules[tool])
                .filter(([, value]) => value !== null)
                .map(([field, value]) => `${field}: ${value}`)
                .join(', ')}
            </li>
          ))}
      </ul>
      <p>Exceptions: {assignment.exceptions.length}</p>
      <ul>
        {exceptionEntries(assignment).map(({ entry, key }) => (
          <li key={key}>
            {entry.tool} · {describeExceptionScope(entry.scope)} ·{' '}
            {Object.entries(entry.rule)
              .map(([field, value]) => `${field}: ${value}`)
              .join(', ')}
          </li>
        ))}
      </ul>
    </>
  );
}
export interface AssignmentExceptionSeed {
  sessionId: string;
  tool: ToolName;
  scope: Scope;
}

function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind === 'session' && b.kind === 'session') return a.sessionId === b.sessionId;
  if (a.kind === 'path' && b.kind === 'path') return folderKey(a.path) === folderKey(b.path);
  return false;
}

function ReplayPreview({
  draft,
  token,
  replayPolicy,
}: {
  draft: PreviewDraft;
  token: string;
  replayPolicy: ConduitMcpApi['replayPolicy'];
}) {
  const key = JSON.stringify([draft, token]);
  const current = useRef(key);
  const generation = useRef(0);
  if (current.current !== key) {
    current.current = key;
    generation.current++;
  }
  const [response, setResponse] = useState<{
    key: string;
    generation: number;
    result: ReplayResult | null;
  } | null>(null);
  const [pendingKey, setPendingKey] = useState<{ key: string; generation: number } | null>(null);
  const pending = pendingKey?.key === key && pendingKey.generation === generation.current;
  const result =
    response?.key === key && response.generation === generation.current
      ? response.result
      : undefined;
  const run = async () => {
    const runGeneration = ++generation.current;
    setPendingKey({ key, generation: runGeneration });
    setResponse(null);
    try {
      const value = await replayPolicy(draft, token);
      if (current.current === key && generation.current === runGeneration)
        setResponse({ key, generation: runGeneration, result: value });
    } catch {
      if (current.current === key && generation.current === runGeneration)
        setResponse({ key, generation: runGeneration, result: null });
    } finally {
      if (generation.current === runGeneration) setPendingKey(null);
    }
  };
  return (
    <section aria-label="Seven-day policy replay">
      <h3>Over the last seven days</h3>
      <p>Compare this draft with current policy using recorded facts. No requests are run.</p>
      <button type="button" className="btn btn--sm" disabled={pending} onClick={() => void run()}>
        {pending ? 'Checking…' : 'Compare Activity'}
      </button>
      <div role="status" aria-live="polite">
        {result?.ok && (
          <p>
            {result.changed} changed of {result.sampled} evaluated since {result.since}.{' '}
            {result.truncated ? 'The sample is limited to the newest 1,000 eligible entries. ' : ''}
            Skipped: {result.skipped.aggregate} aggregated, {result.skipped.legacy} without traces,{' '}
            {result.skipped.incomplete} incomplete, {result.skipped.remote} remote. Runtime
            conditions were not evaluated.
          </p>
        )}
        {result && !result.ok && (
          <p>
            {result.error === 'conflict'
              ? 'Permissions changed. Cancel and reopen this assignment.'
              : `Comparison unavailable (${result.error}).`}
          </p>
        )}
        {result === null && <p>Comparison unavailable. Try again.</p>}
      </div>
    </section>
  );
}

export function PermissionsAssignments({
  policy,
  sessions,
  mcp,
  serverConnected,
  exceptionSeed,
  onExceptionSeedConsumed,
}: {
  policy: PolicyUiState;
  sessions: Session[];
  mcp: ConduitMcpApi;
  serverConnected: boolean;
  exceptionSeed?: AssignmentExceptionSeed | null;
  onExceptionSeedConsumed?: () => void;
}) {
  const [selected, setSelected] = useState('default');
  const [editing, setEditing] = useState<Edit | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = policy.readOnly || !serverConnected;
  const points: AssignmentPoint[] = [
    { kind: 'default' },
    ...CLI_KINDS.map((cli): AssignmentPoint => ({ kind: 'cli', cli })),
    ...sessions
      .filter((session) => policy.sessions[session.id])
      .map(
        (session): AssignmentPoint => ({
          kind: 'session',
          sessionId: session.id,
        }),
      ),
  ];
  const point = points.find((item) => pointKey(item) === selected) ?? points[0];
  const consumedSeed = useRef<string | null>(null);
  useEffect(() => {
    if (!exceptionSeed) {
      consumedSeed.current = null;
      return;
    }
    const seedKey = JSON.stringify(exceptionSeed);
    if (consumedSeed.current === seedKey) return;
    consumedSeed.current = seedKey;
    const { sessionId, tool, scope } = exceptionSeed;
    const supported =
      (tool === 'close_session' && scope.kind === 'session') ||
      (tool === 'open_file' && scope.kind === 'path');
    if (
      readOnly ||
      !supported ||
      !sessions.some((session) => session.id === sessionId) ||
      !policy.sessions[sessionId]
    ) {
      setError('This Activity entry cannot seed a local assignment.');
      onExceptionSeedConsumed?.();
      return;
    }
    const target: AssignmentPoint = { kind: 'session', sessionId };
    const before = structuredClone(assignmentAt(policy, target) ?? inheritedAt(policy, target));
    const matches = before.exceptions
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.tool === tool && sameScope(entry.scope, scope));
    if (matches.length > 1) {
      setError('This assignment has multiple exceptions for that target. Edit them directly.');
      onExceptionSeedConsumed?.();
      return;
    }
    const exceptions =
      matches.length === 1
        ? before.exceptions.map((entry, index) =>
            index === matches[0].index
              ? { ...entry, rule: { ...entry.rule, decision: 'allow' as const } }
              : entry,
          )
        : [
            ...before.exceptions,
            { tool, scope: structuredClone(scope), rule: { decision: 'allow' as const } },
          ];
    setSelected(pointKey(target));
    setReview(null);
    setEditing({
      point: target,
      before,
      draft: { ...structuredClone(before), exceptions },
      token: policy.editToken,
    });
    setError(null);
    onExceptionSeedConsumed?.();
  }, [exceptionSeed, onExceptionSeedConsumed, policy, readOnly, sessions]);
  const checkSessions = sessions
    .filter((session) => policy.sessions[session.id])
    .map((session) => ({ id: session.id, label: session.name }));

  const start = (target: AssignmentPoint): Edit => {
    const current = assignmentAt(policy, target) ?? inheritedAt(policy, target);
    const edit: Edit = {
      point: target,
      draft: structuredClone(current),
      before: structuredClone(current),
      token: policy.editToken,
    };
    setEditing(edit);
    setError(null);
    return edit;
  };
  // Reset goes through the same review as an edit, so its impact is shown before saving.
  const reviewReset = (target: AssignmentPoint) => void requestReview(null, start(target));
  const actions = (item: AssignmentPoint, explicit: boolean, name: string) => (
    <td className="permissions-assignments__actions">
      <button
        type="button"
        className="btn btn--sm"
        disabled={readOnly}
        aria-label={`${explicit ? 'Edit' : 'Add'} assignment · ${name}`}
        onClick={() => start(item)}
      >
        {explicit ? 'Edit' : 'Add'}
      </button>
      {explicit && (
        <button
          type="button"
          className="btn btn--sm"
          disabled={readOnly || pending}
          aria-label={`Reset assignment · ${name}`}
          title="Remove this assignment so it inherits again"
          onClick={() => reviewReset(item)}
        >
          Reset
        </button>
      )}
    </td>
  );
  const requestReview = async (candidate: Assignment | null, from: Edit | null = editing) => {
    if (!from) return;
    const frozen = candidate === null ? null : structuredClone(candidate);
    setPending(true);
    setError(null);
    try {
      const result = await mcp.reviewLocalPolicy(
        { kind: 'assignment', point: from.point, assignment: frozen },
        from.token,
      );
      if (!result?.ok) {
        setError(`Could not review permissions (${result?.error ?? 'timeout'}).`);
        return;
      }
      setReview({
        ...from,
        candidate: frozen,
        after: structuredClone(frozen ?? inheritedAt(policy, from.point)),
        ...(result.requiresNativeReview ? { digest: result.digest } : {}),
      });
    } catch {
      setError('Could not review permissions.');
    } finally {
      setPending(false);
    }
  };
  const save = async () => {
    if (!review || review.token !== policy.editToken) {
      setError('Permissions changed. Cancel and review again.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await mcp.saveAssignment(
        review.point,
        review.candidate,
        review.token,
        review.digest,
      );
      if (!result?.ok) setError(`Could not save permissions (${result?.error ?? 'timeout'}).`);
      else {
        setReview(null);
        setEditing(null);
      }
    } catch {
      setError('Could not save permissions.');
    } finally {
      setPending(false);
    }
  };
  const stale =
    (review ?? editing)?.token !== undefined && (review ?? editing)?.token !== policy.editToken;
  if (review)
    return (
      <section className="permissions-assignments">
        <h2>Review assignment · {label(review.point)}</h2>
        <h3>Before</h3>
        {facts(policy, review.before)}
        <h3>After</h3>
        {facts(policy, review.after)}
        {!stale && (
          <>
            <PermissionsCheckRequest
              sessions={checkSessions}
              draft={{ point: review.point, assignment: review.candidate }}
              expectedToken={review.token}
              previewPolicy={mcp.previewPolicy}
            />
            <ReplayPreview
              draft={{ point: review.point, assignment: review.candidate }}
              token={review.token}
              replayPolicy={mcp.replayPolicy}
            />
          </>
        )}
        {review.digest && (
          <p>Confirming authorizes the reviewed native mode changes for future launches.</p>
        )}
        {stale && <p role="alert">Permissions changed. Cancel and review again.</p>}
        {error && <p role="alert">{error}</p>}
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => {
            setReview(null);
            setError(null);
          }}
        >
          Back
        </button>{' '}
        <button
          type="button"
          className="btn btn--primary"
          disabled={pending || readOnly || stale}
          onClick={() => void save()}
        >
          Confirm and save
        </button>
      </section>
    );
  if (editing) {
    const session =
      editing.point.kind === 'session'
        ? sessions.find(
            (item) => item.id === (editing.point.kind === 'session' ? editing.point.sessionId : ''),
          )
        : undefined;
    const disabled = readOnly || pending || stale;
    const update = (draft: Assignment) => setEditing({ ...editing, draft });
    return (
      <section className="permissions-assignments">
        <h2>Edit assignment · {label(editing.point)}</h2>
        {stale && <p role="alert">Permissions changed. Cancel and reopen this assignment.</p>}
        {error && <p role="alert">{error}</p>}
        <label>
          Profile{' '}
          <select
            className="selectfield"
            value={editing.draft.profileId}
            disabled={disabled}
            onChange={(event) => {
              const profile = policy.profiles.find((item) => item.id === event.target.value);
              if (profile)
                update({
                  ...editing.draft,
                  profileId: profile.id as ProfileId,
                });
            }}
          >
            {policy.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          <input
            type="checkbox"
            checked={editing.draft.onScreenOnly}
            disabled={disabled}
            onChange={(event) => update({ ...editing.draft, onScreenOnly: event.target.checked })}
          />{' '}
          On-screen only
        </label>{' '}
        <label>
          <input
            type="checkbox"
            checked={editing.draft.applyNative === true}
            disabled={disabled}
            onChange={(event) => update({ ...editing.draft, applyNative: event.target.checked })}
          />{' '}
          Apply profile native modes at future launch
        </label>
        {session ? (
          <SessionPermissionExceptions
            session={session}
            assignment={editing.draft}
            disabled={disabled}
            onChange={update}
          />
        ) : (
          <PermissionsAssignmentExceptions
            assignment={editing.draft}
            disabled={disabled}
            onChange={update}
          />
        )}
        {!stale && (
          <>
            <PermissionsCheckRequest
              sessions={checkSessions}
              draft={{ point: editing.point, assignment: editing.draft }}
              expectedToken={editing.token}
              previewPolicy={mcp.previewPolicy}
            />
            <ReplayPreview
              draft={{ point: editing.point, assignment: editing.draft }}
              token={editing.token}
              replayPolicy={mcp.replayPolicy}
            />
          </>
        )}
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => {
            setEditing(null);
            setError(null);
          }}
        >
          Cancel
        </button>{' '}
        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled}
          onClick={() => void requestReview(editing.draft)}
        >
          Review changes
        </button>{' '}
        {assignmentAt(policy, editing.point) && (
          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => void requestReview(null)}
          >
            Review reset
          </button>
        )}
      </section>
    );
  }
  return (
    <section className="permissions-assignments">
      <h2>Assignments</h2>
      {readOnly && (
        <p role="status">
          Permissions are read-only while the policy store is unavailable or disconnected.
        </p>
      )}
      <label>
        Assignment point{' '}
        <select
          className="selectfield"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {points.map((item) => (
            <option key={pointKey(item)} value={pointKey(item)}>
              {item.kind === 'session'
                ? (sessions.find((session) => session.id === item.sessionId)?.name ?? label(item))
                : label(item)}
            </option>
          ))}
        </select>
      </label>{' '}
      <button type="button" className="btn" disabled={readOnly} onClick={() => start(point)}>
        {assignmentAt(policy, point) ? 'Edit assignment' : 'Add assignment'}
      </button>
      <PermissionsCheckRequest
        sessions={checkSessions}
        draft={null}
        expectedToken={policy.editToken}
        previewPolicy={mcp.previewPolicy}
      />
      {error && <p role="alert">{error}</p>}
      <h3>Who gets which profile</h3>
      <table className="permissions-assignments__table">
        <thead>
          <tr>
            <th scope="col">Applies to</th>
            <th scope="col">Profile</th>
            <th scope="col">Exceptions</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {points
            .filter((item) => item.kind !== 'session')
            .map((item) => {
              const explicit = assignmentAt(policy, item);
              const value = explicit ?? inheritedAt(policy, item);
              return (
                <tr key={pointKey(item)}>
                  <th scope="row">{label(item)}</th>
                  <td>
                    {profileFor(policy, value)?.name ?? value.profileId}
                    {!explicit && item.kind !== 'default' && (
                      <span className="permissions-assignments__muted"> · inherited</span>
                    )}
                  </td>
                  <td>{exceptionCount(value)}</td>
                  {actions(item, explicit !== undefined, label(item))}
                </tr>
              );
            })}
          {policy.assignments
            .filter(({ point: item }) => item.kind === 'peer')
            .map(({ point: item, assignment }) => (
              <tr key={pointKey(item)}>
                <th scope="row">{label(item)}</th>
                <td>{profileFor(policy, assignment)?.name ?? assignment.profileId}</td>
                <td>{exceptionCount(assignment)}</td>
                <td />
              </tr>
            ))}
        </tbody>
      </table>
      {Object.keys(policy.sessions).length > 0 && (
        <details className="permissions-assignments__sessions">
          <summary>Sessions ({Object.keys(policy.sessions).length})</summary>
          <table className="permissions-assignments__table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Profile</th>
                <th scope="col">Exceptions</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(policy.sessions).map(([id, row]) => {
                const item: AssignmentPoint = { kind: 'session', sessionId: id };
                const explicit = assignmentAt(policy, item);
                const value = explicit ?? inheritedAt(policy, item);
                const name = sessions.find((session) => session.id === id)?.name ?? id;
                return (
                  <tr key={id}>
                    <th scope="row">{name}</th>
                    <td>
                      {row.profileName}
                      {!explicit && (
                        <span className="permissions-assignments__muted">
                          {' '}
                          · from {label(row.sourcePoint)}
                        </span>
                      )}
                    </td>
                    <td>{exceptionCount(value)}</td>
                    {sessions.some((session) => session.id === id) ? (
                      actions(item, explicit !== undefined, name)
                    ) : (
                      <td />
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

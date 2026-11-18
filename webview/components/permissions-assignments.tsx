import { useState } from 'react';
import { pointKey } from '../../src/conduit-mcp/policy-profiles';
import type {
  Assignment,
  AssignmentPoint,
  PolicyUiState,
  Profile,
  ProfileId,
} from '../../src/conduit-mcp/policy-types';
import { CLI_KINDS, TOOL_NAMES } from '../../src/conduit-mcp/tool-policy';
import type { Session } from '../../src/types';
import type { ConduitMcpApi } from '../use-conduit-mcp';
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
export function PermissionsAssignments({
  policy,
  sessions,
  mcp,
  serverConnected,
}: {
  policy: PolicyUiState;
  sessions: Session[];
  mcp: ConduitMcpApi;
  serverConnected: boolean;
}) {
  const [selected, setSelected] = useState('default');
  const [editing, setEditing] = useState<Edit | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<'allow' | 'ask' | 'deny'>('ask');
  const [tool, setTool] = useState<(typeof TOOL_NAMES)[number]>('open_session');
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
  const start = (target: AssignmentPoint) => {
    const current = assignmentAt(policy, target) ?? inheritedAt(policy, target);
    setEditing({
      point: target,
      draft: structuredClone(current),
      before: structuredClone(current),
      token: policy.editToken,
    });
    setError(null);
  };
  const requestReview = async (candidate: Assignment | null) => {
    if (!editing) return;
    const frozen = candidate === null ? null : structuredClone(candidate);
    setPending(true);
    setError(null);
    try {
      const result = await mcp.reviewLocalPolicy(
        { kind: 'assignment', point: editing.point, assignment: frozen },
        editing.token,
      );
      if (!result?.ok) {
        setError(`Could not review permissions (${result?.error ?? 'timeout'}).`);
        return;
      }
      setReview({
        ...editing,
        candidate: frozen,
        after: structuredClone(frozen ?? inheritedAt(policy, editing.point)),
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
      <section>
        <h2>Review assignment · {label(review.point)}</h2>
        <h3>Before</h3>
        {facts(policy, review.before)}
        <h3>After</h3>
        {facts(policy, review.after)}
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
      <section>
        <h2>Edit assignment · {label(editing.point)}</h2>
        {stale && <p role="alert">Permissions changed. Cancel and reopen this assignment.</p>}
        {error && <p role="alert">{error}</p>}
        <label>
          Profile{' '}
          <select
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
          <section>
            <h3>Exceptions</h3>
            {exceptionEntries(editing.draft).map(({ entry, index, key }) => (
              <p key={key}>
                {entry.tool} · {describeExceptionScope(entry.scope)} ·{' '}
                {Object.entries(entry.rule)
                  .map(([field, value]) => `${field}: ${value}`)
                  .join(', ')}{' '}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    update({
                      ...editing.draft,
                      exceptions: editing.draft.exceptions.filter((_, at) => at !== index),
                    })
                  }
                >
                  Remove
                </button>
              </p>
            ))}
            <label>
              Action{' '}
              <select
                value={tool}
                disabled={disabled}
                onChange={(event) => {
                  const found = TOOL_NAMES.find((item) => item === event.target.value);
                  if (found) setTool(found);
                }}
              >
                {TOOL_NAMES.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>{' '}
            <label>
              Decision{' '}
              <select
                value={decision}
                disabled={disabled}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'allow' || value === 'ask' || value === 'deny') setDecision(value);
                }}
              >
                <option value="allow">Allow</option>
                <option value="ask">Ask</option>
                <option value="deny">Deny</option>
              </select>
            </label>{' '}
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                update({
                  ...editing.draft,
                  exceptions: [
                    ...editing.draft.exceptions,
                    {
                      tool,
                      scope: { kind: 'anywhere' },
                      rule: { decision },
                    },
                  ],
                })
              }
            >
              Add exception anywhere
            </button>
          </section>
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
    <section>
      <h2>Assignments</h2>
      {readOnly && (
        <p role="status">
          Permissions are read-only while the policy store is unavailable or disconnected.
        </p>
      )}
      <label>
        Assignment point{' '}
        <select value={selected} onChange={(event) => setSelected(event.target.value)}>
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
      <h3>Who gets which profile</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">Applies to</th>
            <th scope="col">Profile</th>
            <th scope="col">Exceptions</th>
            <th scope="col">Actions</th>
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
                    {!explicit && item.kind !== 'default' ? ' (default)' : ''}
                  </td>
                  <td>
                    {value.exceptions.length
                      ? value.exceptions
                          .map(
                            (entry) =>
                              `${entry.tool}: ${Object.entries(entry.rule)
                                .map(([field, v]) => `${field} ${v}`)
                                .join(', ')} · ${describeExceptionScope(entry.scope)}`,
                          )
                          .join('; ')
                      : 'none'}
                  </td>
                  <td>
                    <button type="button" disabled={readOnly} onClick={() => start(item)}>
                      {explicit ? 'Edit' : 'Add'}
                    </button>
                  </td>
                </tr>
              );
            })}
          {Object.entries(policy.sessions).map(([id, row]) => {
            const item: AssignmentPoint = { kind: 'session', sessionId: id };
            const explicit = assignmentAt(policy, item);
            const value = explicit ?? inheritedAt(policy, item);
            return (
              <tr key={id}>
                <th scope="row">{sessions.find((session) => session.id === id)?.name ?? id}</th>
                <td>
                  {row.profileName} · {label(row.sourcePoint)}
                </td>
                <td>
                  {value.exceptions.length
                    ? value.exceptions
                        .map(
                          (entry) =>
                            `${entry.tool}: ${Object.entries(entry.rule)
                              .map(([field, v]) => `${field} ${v}`)
                              .join(', ')} · ${describeExceptionScope(entry.scope)}`,
                        )
                        .join('; ')
                    : 'none'}
                </td>
                <td>
                  {sessions.some((session) => session.id === id) && (
                    <button type="button" disabled={readOnly} onClick={() => start(item)}>
                      {explicit ? 'Edit' : 'Add'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {policy.assignments
            .filter(({ point: item }) => item.kind === 'peer')
            .map(({ point: item, assignment }) => (
              <tr key={pointKey(item)}>
                <th scope="row">{label(item)}</th>
                <td>{profileFor(policy, assignment)?.name ?? assignment.profileId}</td>
                <td>{assignment.exceptions.length} exceptions</td>
                <td />
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}

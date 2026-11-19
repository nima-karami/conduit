import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
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
import {
  CLI_KINDS,
  TOOL_GROUPS,
  TOOL_NAMES,
  type ToolName,
} from '../../src/conduit-mcp/tool-policy';
import { folderKey } from '../../src/folder-key';
import type { Session } from '../../src/types';
import { MCP_STR } from '../conduit-mcp-strings';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import type { BackHandler } from './mcp-section';
import { type AgentRow, PermissionsAgentsList } from './permissions-agents-list';
import { PermissionsAssignmentExceptions } from './permissions-assignment-exceptions';
import { PermissionsCheckRequest } from './permissions-check-request';
import { groupCounts, groupState, groupText } from './permissions-role-summary';
import {
  describeExceptionScope,
  SessionPermissionExceptions,
} from './session-permission-exceptions';

const STR = MCP_STR.sections.agents;

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

function AgentDrawer({
  title,
  subtitle,
  profile,
  profiles,
  changes,
  readOnly,
  error,
  onClose,
  onRoleChange,
  onEditChanges,
  onResetAll,
  staged,
  check,
}: {
  title: string;
  subtitle: string;
  profile: Profile | undefined;
  profiles: readonly Profile[];
  changes: { key: string; tool: ToolName; text: string }[];
  readOnly: boolean;
  error: string | null;
  onClose(): void;
  onRoleChange(id: ProfileId): void;
  onEditChanges(): void;
  onResetAll(): void;
  staged: ReactNode;
  check: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  useEffect(() => heading.current?.focus(), []);
  return (
    <aside className="permissions-drawer" aria-labelledby={titleId}>
      <header className="permissions-drawer__head">
        <h4 id={titleId} ref={heading} tabIndex={-1}>
          {title}
        </h4>
        <button type="button" className="iconbtn" aria-label={STR.closeDrawer} onClick={onClose}>
          ✕
        </button>
      </header>
      <p className="permissions-drawer__note">{subtitle}</p>
      {staged ?? (
        <>
          <label className="permissions-agents-drawer__role">
            {STR.role}
            <select
              className="selectfield"
              aria-label={STR.role}
              value={profile?.id ?? ''}
              disabled={readOnly}
              onChange={(event) => {
                const next = profiles.find((item) => item.id === event.target.value);
                if (next) onRoleChange(next.id as ProfileId);
              }}
            >
              {!profile && <option value="" />}
              {profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className="permissions-agents-drawer__summary">
            <p>
              {changes.length > 0 && profile
                ? STR.changesFrom(changes.length, profile.name)
                : STR.changes(0)}
            </p>
            {changes.length > 0 && (
              <button
                type="button"
                className="btn btn--sm"
                disabled={readOnly}
                onClick={onResetAll}
              >
                {STR.resetAll}
              </button>
            )}
          </div>
          {changes.length > 0 && (
            <ul className="permissions-agents-drawer__changes">
              {changes.map((change) => (
                <li key={change.key}>{change.text}</li>
              ))}
            </ul>
          )}
          {error && <p role="alert">{error}</p>}
          <button type="button" className="btn btn--sm" disabled={readOnly} onClick={onEditChanges}>
            {STR.editChanges}
          </button>
          {profile && (
            <section aria-label={STR.canDo}>
              <h5>{STR.canDo}</h5>
              {TOOL_GROUPS.map(({ group, tools }) => {
                const counts = groupCounts(profile, tools);
                return (
                  <details key={group} className="permissions-drawer__group">
                    <summary>
                      {MCP_STR.tools.group[group]}{' '}
                      <span className="permissions-pill" data-state={groupState(counts)}>
                        {MCP_STR.sections.roles.pill[groupState(counts)]}
                      </span>
                      <span className="permissions-drawer__summary">{groupText(counts)}</span>
                    </summary>
                    <ul>
                      {tools.map((tool) => (
                        <li key={tool}>
                          <code>{tool}</code>
                          <span data-decision={profile.rules[tool].decision}>
                            {MCP_STR.sections.roles.decision[profile.rules[tool].decision]}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </section>
          )}
          {check}
        </>
      )}
    </aside>
  );
}

export function PermissionsAssignments({
  policy,
  sessions,
  mcp,
  serverConnected,
  exceptionSeed,
  onExceptionSeedConsumed,
  focusAgentKey,
  onFocusAgentSpent,
  registerBack,
}: {
  policy: PolicyUiState;
  sessions: Session[];
  mcp: ConduitMcpApi;
  serverConnected: boolean;
  exceptionSeed?: AssignmentExceptionSeed | null;
  onExceptionSeedConsumed?: () => void;
  focusAgentKey?: string;
  onFocusAgentSpent?(): void;
  registerBack(handler: BackHandler | null): void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Edit | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
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
  const peerPoints = policy.assignments
    .map(({ point }) => point)
    .filter((point) => point.kind === 'peer');
  const rowFor = (item: AssignmentPoint): AgentRow => {
    const name =
      item.kind === 'session'
        ? (sessions.find((session) => session.id === item.sessionId)?.name ?? label(item))
        : label(item);
    return {
      point: item,
      key: pointKey(item),
      title: name,
      subtitle: item.kind === 'session' ? item.sessionId : label(item),
      profile: profileFor(policy, assignmentAt(policy, item) ?? inheritedAt(policy, item)),
      changes: assignmentAt(policy, item)?.exceptions.length ?? 0,
    };
  };
  const rows = [...points, ...peerPoints].map(rowFor);
  const selectedRow = rows.find((row) => row.key === selected);
  const openRow = editing ? rowFor(editing.point) : selectedRow;
  const consumedFocus = useRef<string | undefined>(undefined);
  const focusPresent = focusAgentKey !== undefined && rows.some((row) => row.key === focusAgentKey);
  useEffect(() => {
    if (!focusAgentKey) {
      consumedFocus.current = undefined;
      return;
    }
    if (!focusPresent || consumedFocus.current === focusAgentKey) return;
    consumedFocus.current = focusAgentKey;
    setSelected(focusAgentKey);
    onFocusAgentSpent?.();
  }, [focusAgentKey, focusPresent, onFocusAgentSpent]);
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
  // Esc ladder, spec 2026-11-18-mcp-full-screen §2.
  useEffect(() => {
    registerBack(() => {
      if (pending) return true;
      if (review) {
        setReview(null);
        setError(null);
        return true;
      }
      if (editing) {
        setEditing(null);
        setError(null);
        return true;
      }
      if (selectedRow) {
        setSelected(null);
        return true;
      }
      return false;
    });
    return () => registerBack(null);
  }, [registerBack, pending, review, editing, selectedRow]);
  const checkSessions = sessions
    .filter((session) => policy.sessions[session.id])
    .map((session) => ({ id: session.id, label: session.name }));

  const start = (target: AssignmentPoint, profileId?: ProfileId): Edit => {
    const current = assignmentAt(policy, target) ?? inheritedAt(policy, target);
    const edit: Edit = {
      point: target,
      draft: { ...structuredClone(current), ...(profileId ? { profileId } : {}) },
      before: structuredClone(current),
      token: policy.editToken,
    };
    setEditing(edit);
    setSelected(pointKey(target));
    setReview(null);
    setError(null);
    return edit;
  };
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
      if (editingRef.current !== from) return;
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
      if (editingRef.current === from) setError('Could not review permissions.');
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
  const reviewing = review ? (
    <section>
      <h3>Review assignment · {label(review.point)}</h3>
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
  ) : null;
  const editor = (() => {
    if (!editing) return null;
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
        <h3>Edit assignment · {label(editing.point)}</h3>
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
  })();
  const changesFor = (row: AgentRow) => {
    const assignment = assignmentAt(policy, row.point);
    if (!assignment || !row.profile) return [];
    const { rules } = row.profile;
    return exceptionEntries(assignment).map(({ entry, key }) => ({
      key,
      tool: entry.tool,
      text: STR.changeLine(
        entry.tool,
        MCP_STR.sections.roles.decision[rules[entry.tool].decision],
        MCP_STR.sections.roles.decision[entry.rule.decision ?? rules[entry.tool].decision],
      ),
    }));
  };
  const resetAll = (target: AssignmentPoint) => {
    const edit = start(target);
    const cleared = { ...edit, draft: { ...edit.draft, exceptions: [] } };
    setEditing(cleared);
    void requestReview(cleared.draft, cleared);
  };
  return (
    <>
      {readOnly && (
        <p role="status">
          Permissions are read-only while the policy store is unavailable or disconnected.
        </p>
      )}
      {error && !openRow && <p role="alert">{error}</p>}
      <div className="permissions-roles">
        <PermissionsAgentsList
          rows={rows}
          profiles={policy.profiles}
          selectedKey={openRow?.key ?? null}
          readOnly={readOnly}
          newAgentRole={(assignmentAt(policy, { kind: 'default' }) ?? fallback).profileId}
          onNewAgentRole={(id) => start({ kind: 'default' }, id)}
          onSelect={(row) => {
            setSelected(row.key);
            setEditing(null);
            setReview(null);
            setError(null);
          }}
          onRoleChange={(row, id) => start(row.point, id)}
        />
        {openRow && (
          <div className="permissions-roles__side">
            <AgentDrawer
              key={openRow.key}
              title={openRow.title}
              subtitle={openRow.subtitle}
              profile={openRow.profile}
              profiles={policy.profiles}
              changes={changesFor(openRow)}
              readOnly={readOnly}
              error={error}
              onClose={() => {
                setSelected(null);
                setEditing(null);
                setReview(null);
                setError(null);
              }}
              onRoleChange={(id) => start(openRow.point, id)}
              onEditChanges={() => start(openRow.point)}
              onResetAll={() => resetAll(openRow.point)}
              staged={reviewing ?? editor}
              check={
                <PermissionsCheckRequest
                  sessions={checkSessions}
                  draft={null}
                  expectedToken={policy.editToken}
                  previewPolicy={mcp.previewPolicy}
                />
              }
            />
          </div>
        )}
      </div>
    </>
  );
}

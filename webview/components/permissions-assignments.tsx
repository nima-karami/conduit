import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { PermissionsDrawer } from './permissions-drawer';
import { groupCounts, groupState, groupText } from './permissions-role-summary';
import {
  describeExceptionScope,
  SessionPermissionAddChange,
  SessionPermissionExceptions,
} from './session-permission-exceptions';
import {
  type OpenSessionActivity,
  SessionActiveGrants,
  SessionPermissionsDetails,
} from './session-permissions-details';

const STR = MCP_STR.sections.agents;

type Edit = {
  point: AssignmentPoint;
  draft: Assignment;
  before: Assignment;
  token: string;
  inline?: boolean;
};
type Review = Edit & {
  candidate: Assignment | null;
  after: Assignment;
  digest?: string;
  nativeRelaunch?: { sessionId: string; generation: number | null };
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
function cliOf(policy: PolicyUiState, sessionId: string): string | null {
  const cli = policy.sessions[sessionId]?.launchedCli;
  return cli ? MCP_STR.tools.cliName[cli] : null;
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
        Role: {profile?.name ?? assignment.profileId} · On-screen only:{' '}
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

export type AgentStage = { kind: 'role'; profileId: ProfileId } | { kind: 'reset' };

interface StagedDrawer {
  body: ReactNode;
  actions: ReactNode;
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
  onResetChange,
  inlineChange,
  details,
  footer,
  opener,
  phase,
  staged,
  check,
}: {
  title: string;
  subtitle: ReactNode;
  profile: Profile | undefined;
  profiles: readonly Profile[];
  changes: { key: string; index: number; tool: ToolName; text: string }[];
  readOnly: boolean;
  error: string | null;
  onClose(): void;
  onRoleChange(id: ProfileId): void;
  onEditChanges(): void;
  onResetAll(): void;
  onResetChange(index: number): void;
  inlineChange?: ReactNode;
  details?: ReactNode;
  footer?: ReactNode;
  opener?: HTMLElement;
  phase: string;
  staged: StagedDrawer | null;
  check: ReactNode;
}) {
  return (
    <PermissionsDrawer
      title={title}
      subtitle={subtitle}
      closeLabel={STR.closeDrawer}
      closeGlyph={STR.closeGlyph}
      onClose={onClose}
      footer={staged?.actions ?? footer}
      opener={opener}
      scrollKey={phase}
    >
      {staged?.body ?? (
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
                <li key={change.key} className="permissions-agents-drawer__change">
                  <div>
                    <code>{change.tool}</code>
                    <span>{change.text}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={readOnly}
                    aria-label={STR.resetChange(change.tool)}
                    onClick={() => onResetChange(change.index)}
                  >
                    {STR.reset}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p role="alert">{error}</p>}
          {inlineChange}
          {details}
          {profile && (
            <section aria-label={STR.canDo}>
              <h4 className="permissions-agents-drawer__canhead">{STR.canDo}</h4>
              <div className="permissions-drawer__groups">
                {TOOL_GROUPS.map(({ group, tools }) => {
                  const counts = groupCounts(profile, tools);
                  return (
                    <details key={group} className="permissions-drawer__group">
                      <summary>
                        <span className="permissions-drawer__groupname">
                          {MCP_STR.tools.group[group]}
                        </span>
                        <span className="permissions-drawer__summary">{groupText(counts)}</span>
                        <span className="permissions-pill" data-state={groupState(counts)}>
                          {MCP_STR.sections.roles.pill[groupState(counts)]}
                        </span>
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
              </div>
            </section>
          )}
          {check}
          <details className="permissions-drawer__group">
            <summary className="permissions-drawer__link">{STR.advancedSettings}</summary>
            <button
              type="button"
              className="btn btn--sm"
              disabled={readOnly}
              onClick={onEditChanges}
            >
              {STR.editAssignment}
            </button>
          </details>
        </>
      )}
    </PermissionsDrawer>
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
  focusAgentStage,
  onFocusAgentSpent,
  onOpenActivity,
  onRelaunch,
  workspace,
  registerBack,
}: {
  policy: PolicyUiState;
  sessions: Session[];
  mcp: ConduitMcpApi;
  serverConnected: boolean;
  exceptionSeed?: AssignmentExceptionSeed | null;
  onExceptionSeedConsumed?: () => void;
  focusAgentKey?: string;
  /** With `focusAgentKey`: a change picked in the row menu (E1), staged and opened at Review. */
  focusAgentStage?: AgentStage;
  onFocusAgentSpent?(): void;
  onOpenActivity?: OpenSessionActivity;
  onRelaunch?(sessionId: string, generation: number | null): Promise<void>;
  workspace?: { onClose(): void; onOpenInSettings(): void; opener?: HTMLElement };
  registerBack(handler: BackHandler | null): void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Edit | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingChange, setAddingChange] = useState(false);
  const reviewBack = useRef<HTMLButtonElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const wasReview = useRef(false);
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
  const openSessionId = openRow?.point.kind === 'session' ? openRow.point.sessionId : undefined;
  const openSession = sessions.find((session) => session.id === openSessionId);
  const closeWorkspace = workspace?.onClose;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const applyStageRef = useRef<((target: AssignmentPoint, stage: AgentStage) => void) | null>(null);
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
    // Another agent's staged edit is dropped, as a row click drops it; the same agent's survives
    // a plain Customize… (no stage).
    if (
      focusAgentStage ||
      (editingRef.current && pointKey(editingRef.current.point) !== focusAgentKey)
    ) {
      setEditing(null);
      setReview(null);
    }
    const target = rowsRef.current.find((row) => row.key === focusAgentKey)?.point;
    if (target && focusAgentStage) applyStageRef.current?.(target, focusAgentStage);
    onFocusAgentSpent?.();
  }, [focusAgentKey, focusAgentStage, focusPresent, onFocusAgentSpent]);
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
      if (closeWorkspace) {
        closeWorkspace();
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
  }, [registerBack, pending, review, editing, selectedRow, closeWorkspace]);
  useLayoutEffect(() => {
    if (review) reviewBack.current?.focus();
    else if (wasReview.current) reviewButton.current?.focus();
    wasReview.current = review !== null;
  }, [review]);
  const checkSessions = sessions
    .filter((session) => policy.sessions[session.id])
    .map((session) => ({ id: session.id, label: session.name }));

  const start = (target: AssignmentPoint, profileId?: ProfileId, inline = false): Edit => {
    const current = assignmentAt(policy, target) ?? inheritedAt(policy, target);
    const edit: Edit = {
      point: target,
      draft: { ...structuredClone(current), ...(profileId ? { profileId } : {}) },
      before: structuredClone(current),
      token: policy.editToken,
      inline,
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
      const sessionId = from.point.kind === 'session' ? from.point.sessionId : undefined;
      const session = sessions.find((current) => current.id === sessionId);
      const runtime = session?.runtime;
      const generation = runtime?.spawn === 'live' ? runtime.generation : null;
      const canRelaunch =
        onRelaunch &&
        sessionId &&
        result.requiresNativeReview &&
        mcp.state?.native[sessionId]?.next.status === 'available' &&
        policy.sessions[sessionId]?.launchedCli != null &&
        (runtime?.spawn === 'none' || generation !== null);
      setReview({
        ...from,
        candidate: frozen,
        after: structuredClone(frozen ?? inheritedAt(policy, from.point)),
        ...(result.requiresNativeReview ? { digest: result.digest } : {}),
        ...(canRelaunch && sessionId ? { nativeRelaunch: { sessionId, generation } } : {}),
      });
    } catch {
      if (editingRef.current === from) setError('Could not review permissions.');
    } finally {
      setPending(false);
    }
  };
  const restart = review?.nativeRelaunch;
  const launchChanged =
    restart !== undefined && (openSession?.runtime?.generation ?? null) !== restart.generation;
  const save = async (relaunch = false) => {
    if (!review || review.token !== policy.editToken || launchChanged) {
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
        if (relaunch && restart && onRelaunch) {
          try {
            await onRelaunch(restart.sessionId, restart.generation);
          } catch (failure) {
            setError(
              `Saved, but could not relaunch: ${failure instanceof Error ? failure.message : String(failure)}`,
            );
            return;
          }
        }
        closeWorkspace?.();
      }
    } catch {
      setError('Could not save permissions.');
    } finally {
      setPending(false);
    }
  };
  const draftToken = (review ?? editing)?.token;
  const stale = launchChanged || (draftToken !== undefined && draftToken !== policy.editToken);
  const reviewing = review ? (
    <section className="permissions-stack">
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
      {review.nativeRelaunch && (
        <p>
          {openSession?.busy
            ? 'This session is busy. Relaunch later is recommended.'
            : 'You can relaunch now to apply the native mode.'}
        </p>
      )}
      {stale && <p role="alert">Permissions changed. Cancel and review again.</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  ) : null;
  const reviewActions = (
    <>
      <button
        ref={reviewBack}
        type="button"
        className="btn"
        disabled={pending}
        onClick={() => {
          setReview(null);
          setError(null);
        }}
      >
        {STR.back}
      </button>
      <button
        type="button"
        className={review?.nativeRelaunch && !openSession?.busy ? 'btn' : 'btn btn--primary'}
        disabled={pending || readOnly || stale}
        onClick={() => void save()}
      >
        {review?.nativeRelaunch ? 'Apply, relaunch later' : STR.confirm}
      </button>
      {review?.nativeRelaunch && (
        <button
          type="button"
          className={openSession?.busy ? 'btn' : 'btn btn--primary'}
          disabled={pending || readOnly || stale}
          onClick={() => void save(true)}
        >
          Apply and relaunch
        </button>
      )}
    </>
  );
  const editor = (() => {
    if (!editing || editing.inline) return null;
    const session =
      editing.point.kind === 'session'
        ? sessions.find(
            (item) => item.id === (editing.point.kind === 'session' ? editing.point.sessionId : ''),
          )
        : undefined;
    const disabled = readOnly || pending || stale;
    const update = (draft: Assignment) => setEditing({ ...editing, draft });
    return (
      <section className="permissions-stack">
        <h3>Edit assignment · {label(editing.point)}</h3>
        {stale && <p role="alert">Permissions changed. Cancel and reopen this assignment.</p>}
        {error && <p role="alert">{error}</p>}
        <div className="permissions-fields">
          <label className="permissions-field">
            Role
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
          </label>
          <label className="permissions-field">
            <input
              type="checkbox"
              checked={editing.draft.onScreenOnly}
              disabled={disabled}
              onChange={(event) => update({ ...editing.draft, onScreenOnly: event.target.checked })}
            />
            On-screen only
          </label>
          <label className="permissions-field">
            <input
              type="checkbox"
              checked={editing.draft.applyNative === true}
              disabled={disabled}
              onChange={(event) => update({ ...editing.draft, applyNative: event.target.checked })}
            />
            Apply role native modes at future launch
          </label>
        </div>
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
      </section>
    );
  })();
  const editorActions = editing ? (
    <>
      {assignmentAt(policy, editing.point) && (
        <button
          type="button"
          className="btn permissions-drawer__lead"
          disabled={readOnly || pending || stale}
          onClick={() => void requestReview(null)}
        >
          {STR.reviewReset}
        </button>
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
        {STR.cancel}
      </button>
      <button
        type="button"
        ref={reviewButton}
        className="btn btn--primary"
        disabled={readOnly || pending || stale}
        onClick={() => void requestReview(editing.draft)}
      >
        Review changes
      </button>
    </>
  ) : null;
  const staged: StagedDrawer | null = reviewing
    ? { body: reviewing, actions: reviewActions }
    : editor
      ? { body: editor, actions: editorActions }
      : null;
  const changesFor = (row: AgentRow) => {
    const assignment = editing?.inline ? editing.draft : assignmentAt(policy, row.point);
    const profile = assignment ? profileFor(policy, assignment) : row.profile;
    if (!assignment || !profile) return [];
    const { rules, name: roleName } = profile;
    return exceptionEntries(assignment).map(({ entry, key, index }) => ({
      key,
      index,
      tool: entry.tool,
      text: STR.changeLine(
        roleName,
        MCP_STR.sections.roles.decision[rules[entry.tool].decision],
        MCP_STR.sections.roles.decision[entry.rule.decision ?? rules[entry.tool].decision],
      ),
    }));
  };
  const updateInline = (target: AssignmentPoint, update: (draft: Assignment) => Assignment) => {
    const edit = editing?.inline ? editing : start(target, undefined, true);
    setEditing({ ...edit, draft: update(edit.draft) });
    setError(null);
  };
  const resetAll = (target: AssignmentPoint) => {
    const edit = start(target, undefined, Boolean(workspace));
    const cleared = { ...edit, draft: { ...edit.draft, exceptions: [] } };
    setEditing(cleared);
    void requestReview(cleared.draft, cleared);
  };
  const resetChange = (target: AssignmentPoint, index: number) => {
    const edit = start(target);
    const trimmed = {
      ...edit,
      draft: { ...edit.draft, exceptions: edit.draft.exceptions.filter((_, i) => i !== index) },
    };
    setEditing(trimmed);
    void requestReview(trimmed.draft, trimmed);
  };
  applyStageRef.current = (target, stage) => {
    if (readOnly) return;
    if (stage.kind === 'reset') {
      resetAll(target);
      return;
    }
    const edit = start(target, stage.profileId, Boolean(workspace));
    void requestReview(edit.draft, edit);
  };
  const closeDrawer = () => {
    if (pending && closeWorkspace) return;
    if (closeWorkspace) {
      closeWorkspace();
      return;
    }
    setSelected(null);
    setEditing(null);
    setReview(null);
    setError(null);
    setAddingChange(false);
  };
  const drawerFooter = (workspace || editing?.inline) && (
    <>
      <button type="button" className="btn" disabled={pending} onClick={closeDrawer}>
        Cancel
      </button>
      <button
        ref={reviewButton}
        type="button"
        className="btn btn--primary"
        disabled={!editing || pending || readOnly || stale}
        onClick={() => editing && void requestReview(editing.draft)}
      >
        Review
      </button>
    </>
  );
  const drawerAssignment = openRow
    ? editing?.inline
      ? editing.draft
      : (assignmentAt(policy, openRow.point) ?? inheritedAt(policy, openRow.point))
    : undefined;
  const drawerProfile = editing?.inline ? profileFor(policy, editing.draft) : openRow?.profile;
  const handle = openSession ? mcp.state?.sessions[openSession.id]?.handle : undefined;
  const subtitle = openSession
    ? [handle ?? openSession.id, cliOf(policy, openSession.id)].filter(Boolean).join(' · ')
    : openRow?.subtitle;
  return (
    <>
      {!workspace && readOnly && (
        <p role="status">
          Permissions are read-only while the policy store is unavailable or disconnected.
        </p>
      )}
      {error && !openRow && <p role="alert">{error}</p>}
      <div className={workspace ? 'workspace-permissions__layout' : 'permissions-roles'}>
        {!workspace && (
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
              setAddingChange(false);
            }}
            onRoleChange={(row, id) => start(row.point, id)}
          />
        )}
        {openRow && (
          <div className={workspace ? 'workspace-permissions__side' : 'permissions-roles__side'}>
            <AgentDrawer
              key={openRow.key}
              title={openRow.title}
              subtitle={
                workspace ? (
                  <>
                    {subtitle} ·{' '}
                    <button
                      type="button"
                      className="permissions-drawer__link"
                      disabled={pending}
                      onClick={workspace.onOpenInSettings}
                    >
                      {STR.openInAgents}
                    </button>
                  </>
                ) : (
                  subtitle
                )
              }
              profile={drawerProfile}
              profiles={policy.profiles}
              changes={changesFor(openRow)}
              readOnly={readOnly || pending || stale}
              error={stale ? 'Permissions changed. Cancel and reopen this assignment.' : error}
              onClose={closeDrawer}
              opener={workspace?.opener}
              footer={drawerFooter || undefined}
              onRoleChange={(id) =>
                workspace || editing?.inline
                  ? updateInline(openRow.point, (draft) => ({ ...draft, profileId: id }))
                  : start(openRow.point, id)
              }
              onEditChanges={() => {
                if (editing?.inline) setEditing({ ...editing, inline: false });
                else start(openRow.point);
              }}
              onResetAll={() =>
                workspace || editing?.inline
                  ? updateInline(openRow.point, (draft) => ({ ...draft, exceptions: [] }))
                  : resetAll(openRow.point)
              }
              onResetChange={(index) =>
                workspace || editing?.inline
                  ? updateInline(openRow.point, (draft) => ({
                      ...draft,
                      exceptions: draft.exceptions.filter((_, i) => i !== index),
                    }))
                  : resetChange(openRow.point, index)
              }
              inlineChange={
                openSession &&
                (addingChange ? (
                  <SessionPermissionAddChange
                    key={openSession.id}
                    session={openSession}
                    role={drawerProfile}
                    disabled={readOnly || pending || stale}
                    onCancel={() => setAddingChange(false)}
                    onAdd={(entry) => {
                      updateInline(openRow.point, (draft) => ({
                        ...draft,
                        exceptions: [...draft.exceptions, entry],
                      }));
                      setAddingChange(false);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm permissions-agents-drawer__add"
                    disabled={readOnly || pending || stale}
                    onClick={() => setAddingChange(true)}
                  >
                    Add a change
                  </button>
                ))
              }
              details={
                openSession && (
                  <>
                    <SessionActiveGrants
                      key={`grants:${openSession.id}`}
                      sessionId={openSession.id}
                      policy={policy}
                      readOnly={readOnly}
                      revokeGrant={mcp.revokeGrant}
                    />
                    <SessionPermissionsDetails
                      key={`details:${openSession.id}`}
                      session={openSession}
                      mcp={mcp}
                      policy={policy}
                      onOpenActivity={onOpenActivity}
                      applyNative={drawerAssignment?.applyNative === true}
                      onApplyNativeChange={
                        readOnly || pending || stale
                          ? undefined
                          : (applyNative) =>
                              updateInline(openRow.point, (draft) => ({ ...draft, applyNative }))
                      }
                    />
                  </>
                )
              }
              phase={review ? 'review' : editor ? 'editor' : 'overview'}
              staged={staged}
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

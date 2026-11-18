import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ActivityPage, ActivityQuery } from '../../src/conduit-mcp/activity-query';
import type {
  Assignment,
  PolicyEditResult,
  PolicyUiState,
  Profile,
  ProfileId,
  ToolRule,
} from '../../src/conduit-mcp/policy-types';
import type { CodexPostureView, NativeSessionUi } from '../../src/contracts/native-launch';
import type { Session } from '../../src/types';
import { IconClose } from '../icons';
import { useFocusTrap } from '../use-focus-trap';
import { ModalLayer } from './modal-layer';
import { PermissionStoreNotice } from './permission-store-notice';
import { SessionPermissionActivity } from './session-permission-activity';
import {
  describeExceptionScope,
  SessionPermissionExceptions,
} from './session-permission-exceptions';
import { SessionPermissionsNative } from './session-permissions-native';

export interface SessionPermissionsReview {
  before: Assignment;
  after: Assignment;
  /** The owner has determined that this change can apply a native mode on relaunch. */
  nativeRelaunch: boolean;
}

export interface PermissionsSessionDialogProps {
  session: Session;
  policy: PolicyUiState;
  /** Parent-resolved initial draft; an existing session assignment must retain exceptions and pins. */
  draft: Assignment;
  inherited: boolean;
  native: NativeSessionUi;
  posture: CodexPostureView;
  handStarted: boolean;
  nativeOptInSupported: boolean;
  review: SessionPermissionsReview | null;
  pending: boolean;
  stale?: boolean;
  error: string | null;
  getActivity(query: ActivityQuery): Promise<ActivityPage | null>;
  onRetry(): Promise<PolicyEditResult | null>;
  onOpenSettings(): void;
  onOpenActivity(): void;
  onClose(): void;
  onReview(candidate: Assignment | null): void;
  onBack(): void;
  onConfirm(relaunch: boolean): void;
  onLinkThread?: (uuid: string) => Promise<CodexPostureView>;
}

function ruleText(rule: ToolRule): string {
  return [rule.decision, rule.when, rule.reach, rule.move].filter(Boolean).join(' · ');
}

function profileName(profiles: readonly Profile[], id: ProfileId): string {
  return profiles.find((profile) => profile.id === id)?.name ?? id;
}

function ReviewDifferences({
  review,
  profiles,
}: {
  review: SessionPermissionsReview;
  profiles: readonly Profile[];
}) {
  const before = profiles.find((profile) => profile.id === review.before.profileId);
  const after = profiles.find((profile) => profile.id === review.after.profileId);
  const changes =
    before && after
      ? (Object.keys(after.rules) as Array<keyof Profile['rules']>).filter(
          (tool) =>
            ruleText(before.rules[tool]) !== ruleText(after.rules[tool]) ||
            review.before.exceptions.some((exception) => exception.tool === tool) ||
            review.after.exceptions.some((exception) => exception.tool === tool),
        )
      : [];
  return (
    <section
      className="session-permissions__section session-permissions__review"
      aria-label="Review changes"
    >
      <h3 className="session-permissions__heading">Review changes</h3>
      <p>
        Profile: {profileName(profiles, review.before.profileId)} →{' '}
        {profileName(profiles, review.after.profileId)}
      </p>
      {changes.length > 0 && (
        <table className="session-permissions__table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Before profile</th>
              <th>After profile</th>
            </tr>
          </thead>
          <tbody>
            {before &&
              after &&
              changes.map((tool) => (
                <tr key={tool}>
                  <th scope="row">{tool}</th>
                  <td>{ruleText(before.rules[tool])}</td>
                  <td>{ruleText(after.rules[tool])}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <p>
        On-screen only: {review.before.onScreenOnly ? 'On' : 'Off'} →{' '}
        {review.after.onScreenOnly ? 'On' : 'Off'}
      </p>
      <p>
        Apply native mode: {review.before.applyNative ? 'On' : 'Off'} →{' '}
        {review.after.applyNative ? 'On' : 'Off'}
      </p>
      <p>
        Native modes:{' '}
        {review.before.applyNative
          ? `${before?.nativeModes?.claude ?? 'unset'} · ${before?.nativeModes?.codex ?? 'unset'}`
          : 'Not applied'}{' '}
        →{' '}
        {review.after.applyNative
          ? `${after?.nativeModes?.claude ?? 'unset'} · ${after?.nativeModes?.codex ?? 'unset'}`
          : 'Not applied'}
      </p>
      <p>
        Exceptions: {review.before.exceptions.length} → {review.after.exceptions.length}
      </p>
      {(review.before.exceptions.length > 0 || review.after.exceptions.length > 0) && (
        <>
          <p>
            Before:{' '}
            {review.before.exceptions
              .map(
                (item) =>
                  `${item.tool} (${describeExceptionScope(item.scope)}): ${Object.entries(item.rule)
                    .map(([field, value]) => `${field} ${value}`)
                    .join(', ')}`,
              )
              .join('; ') || 'None'}
          </p>
          <p>
            After:{' '}
            {review.after.exceptions
              .map(
                (item) =>
                  `${item.tool} (${describeExceptionScope(item.scope)}): ${Object.entries(item.rule)
                    .map(([field, value]) => `${field} ${value}`)
                    .join(', ')}`,
              )
              .join('; ') || 'None'}
          </p>
        </>
      )}
      {changes.length > 0 && (
        <p>Profile rules are shown above; matching exceptions can change individual fields.</p>
      )}
    </section>
  );
}

export function PermissionsSessionDialog({
  session,
  policy,
  draft,
  native,
  inherited,
  posture,
  handStarted,
  nativeOptInSupported,
  review,
  pending,
  stale,
  error,
  onClose,
  onRetry,
  getActivity,
  onOpenSettings,
  onOpenActivity,
  onReview,
  onBack,
  onConfirm,
  onLinkThread,
}: PermissionsSessionDialogProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { restoreFocus } = useFocusTrap(rootRef);
  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')
      ?.focus();
  }, []);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasReview = useRef(false);
  const wasPending = useRef(false);
  useLayoutEffect(() => {
    if (pending) rootRef.current?.focus();
    else if (review) backButtonRef.current?.focus();
    else if ((wasReview.current || wasPending.current) && !stale && !policy.readOnly)
      reviewButtonRef.current?.focus();
    else if (wasReview.current || wasPending.current) closeButtonRef.current?.focus();
    wasReview.current = review !== null;
    wasPending.current = pending;
  }, [pending, policy.readOnly, review, stale]);
  const titleId = useId();
  const profileId = useId();
  const [candidate, setCandidate] = useState<Assignment | null>(inherited ? null : draft);
  const effective = policy.sessions[session.id];
  const disabled = pending || policy.readOnly || stale === true;
  const activeGrants = policy.grants.filter(
    (grant) =>
      grant.state === 'active' &&
      (grant.expiresAt === null || Date.parse(grant.expiresAt) > Date.now()) &&
      ((grant.who.kind === 'session' && grant.who.sessionId === session.id) ||
        (grant.who.kind === 'cli' &&
          effective?.launchedCli != null &&
          grant.who.cli === effective.launchedCli)),
  );
  const close = () => {
    if (!pending) {
      restoreFocus();
      onClose();
    }
  };
  const edit = (patch: Partial<Assignment>) =>
    setCandidate((current) => ({ ...(current ?? draft), ...patch }));
  const source =
    effective?.source === 'session'
      ? 'This session'
      : effective?.source === 'cli'
        ? `${effective.sourcePoint.kind === 'cli' ? effective.sourcePoint.cli : 'Agent'} default`
        : 'Default';

  return (
    <ModalLayer onDismiss={close} onEscape={review && !pending ? onBack : close}>
      <div
        ref={rootRef}
        className="mcptools chamfer"
        role="dialog"
        aria-modal
        tabIndex={-1}
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mcptools__head">
          <span className="mcptools__title" id={titleId}>
            Permissions · {session.name}
          </span>
          <button
            ref={closeButtonRef}
            type="button"
            className="iconbtn"
            aria-label="Close"
            disabled={pending}
            onClick={close}
          >
            <IconClose size={12} />
          </button>
        </div>
        <div className="mcptools__scroll">
          <p>
            Effective profile:{' '}
            {effective?.profileName ?? profileName(policy.profiles, draft.profileId)} · {source}
          </p>
          <PermissionStoreNotice
            saveError={policy.saveError}
            backupWarning={policy.backupWarning}
            readOnly={policy.readOnly}
            onRetry={onRetry}
          />
          {(policy.readOnly || policy.saveError || policy.backupWarning) && (
            <button type="button" className="btn" onClick={onOpenSettings}>
              Open Settings
            </button>
          )}
          {error && <p role="alert">{error}</p>}
          {review ? (
            <>
              <ReviewDifferences review={review} profiles={policy.profiles} />
              {review.nativeRelaunch && (
                <p>
                  {session.busy
                    ? 'This session is busy. Relaunch later is recommended.'
                    : 'This session is idle. You can relaunch now to apply the native mode.'}
                </p>
              )}
              <div className="confirm__actions">
                <button
                  ref={backButtonRef}
                  type="button"
                  className="btn"
                  disabled={pending}
                  onClick={onBack}
                >
                  Back
                </button>
                {review.nativeRelaunch ? (
                  <>
                    <button
                      type="button"
                      className={session.busy ? 'btn btn--primary' : 'btn'}
                      disabled={disabled}
                      onClick={() => onConfirm(false)}
                    >
                      Apply, relaunch later
                    </button>
                    <button
                      type="button"
                      className={session.busy ? 'btn' : 'btn btn--primary'}
                      disabled={disabled}
                      onClick={() => onConfirm(true)}
                    >
                      Apply and relaunch
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={disabled}
                    onClick={() => onConfirm(false)}
                  >
                    Apply
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <fieldset
                className="session-permissions__fieldset session-permissions__profiles"
                disabled={disabled}
              >
                <legend className="session-permissions__heading" id={profileId}>
                  Profile
                </legend>
                <label className="session-permissions__profile">
                  <input
                    type="radio"
                    name={`${profileId}-profile`}
                    checked={candidate === null}
                    onChange={() => setCandidate(null)}
                  />{' '}
                  Use inherited profile
                </label>
                {policy.profiles.map((profile) => (
                  <label className="session-permissions__profile" key={profile.id}>
                    <input
                      type="radio"
                      name={`${profileId}-profile`}
                      checked={candidate?.profileId === profile.id}
                      onChange={() => edit({ profileId: profile.id })}
                    />{' '}
                    {profile.name}
                    {profile.builtIn ? '' : ' · Custom'}
                  </label>
                ))}
              </fieldset>
              {candidate && (
                <fieldset className="session-permissions__fieldset" disabled={disabled}>
                  <legend className="session-permissions__heading">Session options</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={candidate.onScreenOnly}
                      onChange={(event) => edit({ onScreenOnly: event.target.checked })}
                    />{' '}
                    Only while this session is on screen
                  </label>
                  {nativeOptInSupported && (
                    <label>
                      <input
                        type="checkbox"
                        checked={candidate.applyNative === true}
                        onChange={(event) => edit({ applyNative: event.target.checked })}
                      />{' '}
                      Apply the profile’s native mode on launch
                    </label>
                  )}
                  <p>
                    Exceptions: {candidate.exceptions.length}
                    {candidate.pinned?.length
                      ? ` · ${candidate.pinned.length} pinned settings`
                      : ''}
                  </p>
                </fieldset>
              )}
              <SessionPermissionExceptions
                session={session}
                assignment={candidate ?? draft}
                disabled={disabled}
                onChange={setCandidate}
              />
              <SessionPermissionsNative
                key={`${session.id}:${session.runtime?.generation ?? 'none'}:${session.runtime?.spawn ?? 'unknown'}`}
                refusal={session.startRefusal}
                onOpenSettings={onOpenSettings}
                native={native}
                posture={posture}
                handStarted={handStarted}
                onLinkThread={onLinkThread}
              />
              <section className="session-permissions__section" aria-label="Active grants">
                <h3 className="session-permissions__heading">Active grants</h3>
                <p>
                  These grants may apply when their scope matches. Other restrictions still apply.
                </p>
                {activeGrants.length === 0 ? (
                  <p>None</p>
                ) : (
                  <ul>
                    {activeGrants.map((grant) => (
                      <li key={grant.id}>
                        {grant.tool} · {describeExceptionScope(grant.on)} · {grant.for}
                        {grant.expiresAt ? ` · Expires ${grant.expiresAt}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <SessionPermissionActivity sessionId={session.id} getActivity={getActivity} />
              <button type="button" onClick={onOpenActivity}>
                View Activity
              </button>
              <div className="confirm__actions">
                <button type="button" className="btn" disabled={pending} onClick={close}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={disabled}
                  ref={reviewButtonRef}
                  onClick={() => onReview(candidate)}
                >
                  Review changes
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalLayer>
  );
}

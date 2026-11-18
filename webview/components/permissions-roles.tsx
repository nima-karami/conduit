import { useEffect, useRef, useState } from 'react';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type {
  AssignmentPoint,
  PolicyEditResult,
  Profile,
  ProfileId,
  ProfileReviewDisplay,
  ToolRule,
} from '../../src/conduit-mcp/policy-types';
import { TOOL_NAMES } from '../../src/conduit-mcp/tool-policy';
import type { Session } from '../../src/types';
import type { ConduitMcpApi } from '../use-conduit-mcp';
import type { BackHandler } from './mcp-section';
import { PermissionsProfileEditor } from './permissions-profile-editor';
import { PermissionsProfiles } from './permissions-profiles';

type Editing = { draft: Profile; before: Profile | null; token: string };
type Review = Editing & { candidate: Profile; digest?: string; display: ProfileReviewDisplay };
type Deletion = {
  profile: Profile;
  token: string;
  replacement: ProfileId | '';
  points: Array<{ point: AssignmentPoint; native: boolean }>;
  reviewed?: { replacement: Profile; digest?: string };
};

function mode(profile: Profile | null, cli: 'claude' | 'codex'): string {
  if (!profile) return 'No profile';
  const value = profile.nativeModes?.[cli];
  return !value || value === 'unset' ? 'CLI default' : value;
}

function ruleText(rule: ToolRule): string {
  return [rule.decision, rule.when, rule.reach, rule.move]
    .filter((value) => value !== null)
    .join(' · ');
}

export function PermissionsRoles({
  serverConnected,
  mcp,
  sessions,
  registerBack,
}: {
  serverConnected: boolean;
  mcp: ConduitMcpApi;
  sessions: Session[];
  registerBack(handler: BackHandler | null): void;
}) {
  const policy = mcp.state?.policy;
  useEffect(() => {
    registerBack(null);
    return () => registerBack(null);
  }, [registerBack]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [deletion, setDeletion] = useState<Deletion | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!policy) return <p>Loading permissions…</p>;

  const currentPolicy = policy;
  const readOnly = currentPolicy.readOnly || !serverConnected;
  function start(profile: Profile, copy: boolean) {
    const draft = structuredClone(profile);
    if (copy) {
      draft.id = `p-${crypto.randomUUID()}`;
      draft.name = `${profile.name} copy`;
      draft.builtIn = false;
    }
    setEditing({
      draft,
      before: copy ? null : structuredClone(profile),
      token: currentPolicy.editToken,
    });
    setReview(null);
    setError(null);
  }
  async function requestReview(candidate: Profile): Promise<PolicyEditResult | null> {
    if (!editing) return { ok: false, error: 'conflict' };
    const frozen = structuredClone(candidate);
    const result = await mcp.reviewLocalPolicy({ kind: 'profile', profile: frozen }, editing.token);
    if (!result) return null;
    if (!result.ok) return result;
    if (!result.profileDisplay) return { ok: false, error: 'invalid-value' };
    setReview({
      ...editing,
      before: result.profileDisplay.before,
      candidate: result.profileDisplay.after,
      display: result.profileDisplay,
      ...(result.requiresNativeReview ? { digest: result.digest } : {}),
    });
    return { ok: true };
  }
  async function save() {
    if (!review) return;
    if (review.token !== currentPolicy.editToken) {
      setError('Permissions changed while you were reviewing. Go back and reopen the profile.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await mcp.saveProfile(review.candidate, review.token, review.digest);
      if (!result?.ok) {
        setError(
          `Could not save profile (${result?.error ?? 'timeout'}). Review the current permissions before retrying.`,
        );
      } else {
        setReview(null);
        setEditing(null);
      }
    } catch {
      setError('Could not save profile. Review the current permissions before retrying.');
    } finally {
      setPending(false);
    }
  }

  async function reviewDeletion() {
    if (
      !deletion ||
      !deletion.replacement ||
      inFlight.current ||
      readOnly ||
      deletion.token !== currentPolicy.editToken
    )
      return;
    const replacement = [...BUILT_IN_PROFILES, ...currentPolicy.profiles].find(
      (p) => p.id === deletion.replacement,
    );
    if (!replacement) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await mcp.reviewLocalPolicy(
        { kind: 'delete-profile', profileId: deletion.profile.id, replacement: replacement.id },
        deletion.token,
      );
      if (!result?.ok)
        setError(
          `Could not review deletion (${result?.error ?? 'timeout'}). Reopen the profile and try again.`,
        );
      else
        setDeletion({
          ...deletion,
          reviewed: {
            replacement: structuredClone(replacement),
            ...(result.requiresNativeReview ? { digest: result.digest } : {}),
          },
        });
    } catch {
      setError('Could not review deletion. Reopen the profile and try again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  async function confirmDeletion() {
    if (
      !deletion?.reviewed ||
      inFlight.current ||
      readOnly ||
      deletion.token !== currentPolicy.editToken
    )
      return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await mcp.deleteProfile(
        deletion.profile.id,
        deletion.reviewed.replacement.id,
        deletion.token,
        deletion.reviewed.digest,
      );
      if (!result?.ok)
        setError(
          `Could not delete profile (${result?.error ?? 'timeout'}). Review current permissions before retrying.`,
        );
      else setDeletion(null);
    } catch {
      setError('Could not delete profile. Review current permissions before retrying.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  if (deletion) {
    const stale = deletion.token !== currentPolicy.editToken;
    const options = [
      ...BUILT_IN_PROFILES,
      ...currentPolicy.profiles.filter((p) => !p.builtIn),
    ].filter((p) => p.id !== deletion.profile.id);
    const replacement = deletion.reviewed?.replacement;
    return (
      <section aria-label="Delete profile">
        <h2>Delete {deletion.profile.name}</h2>
        {deletion.points.length ? (
          <>
            <p>
              These assignments will use the replacement profile. Their exceptions and native mode
              setting stay in place.
            </p>
            <ul>
              {deletion.points.map(({ point, native }) => (
                <li key={JSON.stringify(point)}>
                  {point.kind === 'default'
                    ? 'Default'
                    : point.kind === 'cli'
                      ? `${point.cli} sessions`
                      : point.kind === 'session'
                        ? (sessions.find((s) => s.id === point.sessionId)?.name ?? point.sessionId)
                        : `Machine ${point.machineId}`}
                  {native ? ' · native modes enabled' : ''}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No assignments directly use this profile.</p>
        )}
        {!replacement ? (
          <label>
            Replacement profile{' '}
            <select
              value={deletion.replacement}
              disabled={pending || readOnly || stale}
              onChange={(e) =>
                setDeletion({ ...deletion, replacement: e.target.value as ProfileId | '' })
              }
            >
              <option value="">Choose a profile…</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <p>
              Replace {deletion.profile.name} with {replacement.name} in these assignments.
            </p>
            <h3>Before and after</h3>
            <table>
              <thead>
                <tr>
                  <th scope="col">Setting</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {(['claude', 'codex'] as const).map((cli) => (
                  <tr key={cli}>
                    <th scope="row">{cli} at next launch, where enabled</th>
                    <td>{mode(deletion.profile, cli)}</td>
                    <td>{mode(replacement, cli)}</td>
                  </tr>
                ))}
                {TOOL_NAMES.filter(
                  (tool) =>
                    ruleText(deletion.profile.rules[tool]) !== ruleText(replacement.rules[tool]),
                ).map((tool) => (
                  <tr key={tool}>
                    <th scope="row">{tool}</th>
                    <td>{ruleText(deletion.profile.rules[tool])}</td>
                    <td>{ruleText(replacement.rules[tool])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {deletion.reviewed?.digest && (
              <p>
                Confirming authorizes the reviewed native mode changes. They apply at the next
                launch where native modes are enabled.
              </p>
            )}
          </>
        )}
        {stale && <p role="alert">Permissions changed. Cancel and reopen this profile.</p>}
        {error && <p role="alert">{error}</p>}
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => {
            if (replacement) setDeletion({ ...deletion, reviewed: undefined });
            else setDeletion(null);
            setError(null);
          }}
        >
          {replacement ? 'Back' : 'Cancel'}
        </button>{' '}
        <button
          type="button"
          className="btn btn--primary"
          disabled={pending || readOnly || stale || !deletion.replacement}
          onClick={() => void (replacement ? confirmDeletion() : reviewDeletion())}
        >
          {pending ? 'Working…' : replacement ? 'Confirm deletion' : 'Review deletion'}
        </button>
      </section>
    );
  }

  if (review)
    return (
      <section className="permissions-settings__review" aria-labelledby="permissions-review-title">
        <h2 id="permissions-review-title">Review profile changes</h2>
        <p>
          Confirm the profile before saving. Native modes apply at a future launch only when enabled
          for an assignment.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Agent mode at launch</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {(['claude', 'codex'] as const).map((cli) => (
              <tr key={cli}>
                <th scope="row">{cli === 'claude' ? 'Claude' : 'Codex'}</th>
                <td>{mode(review.before, cli)}</td>
                <td>{mode(review.candidate, cli)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Profile: {review.before?.name ?? 'New profile'} → {review.candidate.name}
        </p>
        <h3>{review.before ? 'Changed tool rules' : 'Tool rules in the new profile'}</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
            </tr>
          </thead>
          <tbody>
            {TOOL_NAMES.filter(
              (tool) =>
                !review.before ||
                ruleText(review.before.rules[tool]) !== ruleText(review.candidate.rules[tool]),
            ).map((tool) => (
              <tr key={tool}>
                <th scope="row">{tool}</th>
                <td>{review.before ? ruleText(review.before.rules[tool]) : 'No profile'}</td>
                <td>{ruleText(review.candidate.rules[tool])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {review.digest && (
          <section aria-label="Native mode reach">
            <h3>Where native modes are enabled</h3>
            {review.display.optedInPoints.length === 0 ? (
              <p>No assignment currently enables this profile's native modes.</p>
            ) : (
              <ul>
                {review.display.optedInPoints.map((point) => (
                  <li key={JSON.stringify(point)}>
                    {point.kind === 'default'
                      ? 'Default assignment'
                      : point.kind === 'cli'
                        ? `${point.cli} assignment`
                        : point.kind === 'session'
                          ? `Session ${sessions.find((s) => s.id === point.sessionId)?.name ?? point.sessionId}`
                          : `Machine ${point.machineId}`}
                  </li>
                ))}
              </ul>
            )}
            <h3>Known sessions affected at their next launch</h3>
            {review.display.affectedSessions.length === 0 ? (
              <p>No currently known session has a changed next-launch mode.</p>
            ) : (
              <ul>
                {review.display.affectedSessions.map((row) => (
                  <li key={row.sessionId}>
                    {sessions.find((s) => s.id === row.sessionId)?.name ?? row.sessionId} ·{' '}
                    {row.family} ·{' '}
                    {row.point.kind === 'default'
                      ? 'default assignment'
                      : row.point.kind === 'cli'
                        ? `${row.point.cli} assignment`
                        : row.point.kind === 'session'
                          ? 'session assignment'
                          : 'machine assignment'}
                  </li>
                ))}
              </ul>
            )}
            {review.display.truncated && <p>Additional assignments or sessions are not shown.</p>}
            <p>Sessions and their launch choices can change after this review.</p>
          </section>
        )}
        {review.digest && (
          <p>Confirming authorizes these native mode changes for the reviewed profile.</p>
        )}
        {review.token !== currentPolicy.editToken && (
          <p role="alert">Permissions changed. Go back and reopen this profile.</p>
        )}
        {error && <p role="alert">{error}</p>}
        <button
          className="btn"
          type="button"
          disabled={pending}
          onClick={() => {
            setEditing({ ...review, draft: review.candidate });
            setReview(null);
            setError(null);
          }}
        >
          Back
        </button>{' '}
        <button
          className="btn btn--primary"
          type="button"
          disabled={pending || readOnly || review.token !== currentPolicy.editToken}
          onClick={() => void save()}
        >
          {pending ? 'Saving…' : 'Confirm and save'}
        </button>
      </section>
    );
  if (editing)
    return (
      <>
        {editing.token !== currentPolicy.editToken && (
          <p role="alert">
            Permissions changed. Cancel and reopen the profile to edit the current version.
          </p>
        )}
        <PermissionsProfileEditor
          key={`${editing.draft.id}-${editing.token}`}
          draft={editing.draft}
          readOnly={readOnly || editing.token !== currentPolicy.editToken}
          onCancel={() => setEditing(null)}
          onReviewAndSave={requestReview}
        />
      </>
    );
  return (
    <>
      {readOnly && (
        <p role="status">
          Permissions are read-only while the policy store is unavailable or disconnected.
        </p>
      )}
      <PermissionsProfiles
        profiles={currentPolicy.profiles}
        readOnly={readOnly}
        onDelete={(profile) => {
          if (profile.builtIn || readOnly) return;
          const points = (currentPolicy.assignments ?? [])
            .filter(({ assignment }) => assignment.profileId === profile.id)
            .map(({ point, assignment }) => ({
              point: structuredClone(point),
              native: assignment.applyNative === true,
            }));
          setDeletion({
            profile: structuredClone(profile),
            token: currentPolicy.editToken,
            replacement: points.length ? '' : 'worker',
            points,
          });
          setError(null);
        }}
        onCopy={(profile) => start(profile, true)}
        onEdit={(profile) => {
          if (!profile.builtIn) start(profile, false);
        }}
      />
    </>
  );
}

import { useId, useRef, useState } from 'react';
import type { PolicyEditResult, Profile, ToolRule } from '../../src/conduit-mcp/policy-types';
import { TOOL_NAMES } from '../../src/conduit-mcp/tool-policy';
import type { Session } from '../../src/types';
import { type ConduitMcpApi, useConduitMcp } from '../use-conduit-mcp';
import { PermissionsAssignments } from './permissions-assignments';
import { PermissionsGrants } from './permissions-grants';
import { PermissionsProfileEditor } from './permissions-profile-editor';
import { PermissionsProfiles } from './permissions-profiles';

type Editing = { draft: Profile; before: Profile | null; token: string };
type Review = Editing & { candidate: Profile; digest?: string };

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

function Profiles({ serverConnected, mcp }: { serverConnected: boolean; mcp: ConduitMcpApi }) {
  const policy = mcp.state?.policy;
  const [editing, setEditing] = useState<Editing | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState(false);
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
    setReview({
      ...editing,
      candidate: frozen,
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
        onCopy={(profile) => start(profile, true)}
        onEdit={(profile) => {
          if (!profile.builtIn) start(profile, false);
        }}
      />
    </>
  );
}

const sections = [
  { id: 'profiles', name: 'Profiles' },
  { id: 'assignments', name: 'Assignments' },
  { id: 'grants', name: 'Grants' },
] as const;

export function PermissionsSettings({
  serverConnected,
  sessions = [],
  onOpenActivity,
}: {
  serverConnected: boolean;
  sessions?: Session[];
  onOpenActivity?: () => void;
}) {
  const mcp = useConduitMcp();
  const policy = mcp.state?.policy;
  const [section, setSection] = useState<(typeof sections)[number]['id']>('profiles');
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const tabsId = useId();
  return (
    <>
      <div className="permissions-settings__tabs">
        <div role="tablist" aria-label="Permission sections">
          {sections.map(({ id, name }, index) => (
            <button
              key={id}
              ref={(node) => {
                tabButtons.current[index] = node;
              }}
              type="button"
              role="tab"
              id={tabsId + '-' + id}
              aria-selected={section === id}
              aria-controls={tabsId + '-section'}
              tabIndex={section === id ? 0 : -1}
              className={section === id ? 'btn btn--sm btn--primary' : 'btn btn--sm'}
              onClick={() => setSection(id)}
              onKeyDown={(event) => {
                let next: number;
                if (event.key === 'ArrowRight') next = (index + 1) % sections.length;
                else if (event.key === 'ArrowLeft')
                  next = (index + sections.length - 1) % sections.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = sections.length - 1;
                else return;
                event.preventDefault();
                setSection(sections[next].id);
                tabButtons.current[next]?.focus();
              }}
            >
              {name}
            </button>
          ))}
        </div>
        {onOpenActivity && (
          <button type="button" className="btn btn--sm" onClick={onOpenActivity}>
            Activity
          </button>
        )}
      </div>
      <div role="tabpanel" id={tabsId + '-section'} aria-labelledby={tabsId + '-' + section}>
        {section === 'profiles' && <Profiles mcp={mcp} serverConnected={serverConnected} />}
        {section !== 'profiles' && !policy && <p>Loading permissions…</p>}
        {section === 'assignments' && policy && (
          <PermissionsAssignments
            policy={policy}
            sessions={sessions}
            mcp={mcp}
            serverConnected={serverConnected}
          />
        )}
        {section === 'grants' && policy && (
          <PermissionsGrants
            policy={serverConnected ? policy : { ...policy, readOnly: true }}
            grantLifecycle={mcp.grantLifecycle}
          />
        )}
      </div>
    </>
  );
}

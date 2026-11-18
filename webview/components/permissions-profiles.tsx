import { useId, useState } from 'react';
import { BUILT_IN_PROFILES } from '../../src/conduit-mcp/policy-profiles';
import type { Decision, Profile, ToolRule } from '../../src/conduit-mcp/policy-types';
import { TOOL_GROUPS, type ToolName } from '../../src/conduit-mcp/tool-policy';
import { MCP_STR } from '../conduit-mcp-strings';

export interface PermissionsProfilesProps {
  /** Custom profiles from the current policy state. Built-ins are supplied by the catalog. */
  profiles: readonly Profile[];
  onCopy(profile: Profile): void;
  onEdit(profile: Profile): void;
}

const DECISION_LABEL: Record<Decision, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };
const DESCRIPTIONS: Record<string, string> = {
  observer: 'For observing and communicating, with other actions denied.',
  worker: 'The standard tool policy for day-to-day work.',
  lead: 'For coordinating work, with broader access to sessions and machines.',
};
const SUMMARY_TOOLS: readonly ToolName[] = [
  'open_session',
  'open_terminal',
  'read_screen',
  'send_input',
  'close_session',
];

function refinements(rule: ToolRule): string[] {
  return [
    rule.when === null ? null : MCP_STR.tools.when[rule.when],
    rule.reach === null ? null : MCP_STR.tools.reach[rule.reach],
    rule.move === null ? null : MCP_STR.tools.move[rule.move],
  ].filter((value): value is string => value !== null);
}

function RuleCell({ rule }: { rule: ToolRule }) {
  const conditions = refinements(rule);
  return (
    <>
      <span className="permissions-profiles__decision" data-decision={rule.decision}>
        {DECISION_LABEL[rule.decision]}
      </span>
      {conditions.length > 0 && (
        <span className="permissions-profiles__conditions">{conditions.join(' · ')}</span>
      )}
    </>
  );
}

function groupSummary(profile: Profile, tools: readonly ToolName[]): string {
  const counts = { allow: 0, ask: 0, deny: 0 };
  for (const tool of tools) counts[profile.rules[tool].decision] += 1;
  return (Object.keys(counts) as Decision[])
    .filter((decision) => counts[decision] > 0)
    .map((decision) => `${counts[decision]} ${DECISION_LABEL[decision].toLowerCase()}`)
    .join(' · ');
}

export function PermissionsProfiles({ profiles, onCopy, onEdit }: PermissionsProfilesProps) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const shownProfiles = [...BUILT_IN_PROFILES, ...profiles.filter((profile) => !profile.builtIn)];

  return (
    <section className="permissions-profiles" aria-labelledby={`${detailId}-heading`}>
      <div className="permissions-profiles__heading">
        <div>
          <h3 id={`${detailId}-heading`}>Profiles</h3>
          <p>A profile is a named set of tool permissions. Copy a built-in to make your own.</p>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Hide tool details' : 'Show all tools'}
        </button>
      </div>
      <div className="permissions-profiles__scroll">
        <table className="permissions-profiles__table">
          <thead>
            <tr>
              <th scope="col">What</th>
              {shownProfiles.map((profile) => (
                <th scope="col" key={profile.id}>
                  <span>
                    {profile.name}
                    {profile.id === 'worker' ? ' (default)' : ''}
                  </span>
                  <span className="permissions-profiles__description">
                    {profile.builtIn ? DESCRIPTIONS[profile.id] : 'Custom profile'}
                  </span>
                  <span className="permissions-profiles__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => onCopy(profile)}
                      aria-label={`Copy ${profile.name}`}
                    >
                      Copy
                    </button>
                    {!profile.builtIn && (
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => onEdit(profile)}
                        aria-label={`Edit ${profile.name}`}
                      >
                        Edit
                      </button>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TOOL_GROUPS.map(({ group, tools }) => (
              <tr key={group}>
                <th scope="row">{MCP_STR.tools.group[group]}</th>
                {shownProfiles.map((profile) => (
                  <td key={profile.id}>{groupSummary(profile, tools)}</td>
                ))}
              </tr>
            ))}
            {SUMMARY_TOOLS.map((tool) => (
              <tr key={tool}>
                <th scope="row">
                  <code>{tool}</code>
                  <span className="permissions-profiles__description">
                    {MCP_STR.tools.description[tool]}
                  </span>
                </th>
                {shownProfiles.map((profile) => (
                  <td key={profile.id}>
                    <RuleCell rule={profile.rules[tool]} />
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">Agent’s own mode at launch</th>
              {shownProfiles.map((profile) => (
                <td key={profile.id}>
                  <div>
                    Claude:{' '}
                    {profile.nativeModes?.claude === undefined ||
                    profile.nativeModes.claude === 'unset'
                      ? 'not set'
                      : profile.nativeModes.claude}
                  </div>
                  <div>
                    Codex:{' '}
                    {profile.nativeModes?.codex === undefined ||
                    profile.nativeModes.codex === 'unset'
                      ? 'not set'
                      : profile.nativeModes.codex}
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div id={detailId} hidden={!expanded}>
        {expanded &&
          TOOL_GROUPS.map(({ group, tools }) => (
            <section className="permissions-profiles__group" key={group}>
              <h4>{MCP_STR.tools.group[group]}</h4>
              <div className="permissions-profiles__scroll">
                <table className="permissions-profiles__table">
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      {shownProfiles.map((profile) => (
                        <th scope="col" key={profile.id}>
                          {profile.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tools.map((tool) => (
                      <tr key={tool}>
                        <th scope="row">
                          <code>{tool}</code>
                          <span className="permissions-profiles__description">
                            {MCP_STR.tools.description[tool]}
                          </span>
                        </th>
                        {shownProfiles.map((profile) => (
                          <td key={profile.id}>
                            <RuleCell rule={profile.rules[tool]} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
      </div>
      <p className="permissions-profiles__note">
        Native modes apply at launch when enabled for an assignment. Tool conditions are shown
        alongside each decision.
      </p>
    </section>
  );
}

import type { KeyboardEvent } from 'react';
import type { Profile, ProfileId } from '../../src/conduit-mcp/policy-types';
import { TOOL_GROUPS } from '../../src/conduit-mcp/tool-policy';
import { MCP_STR } from '../conduit-mcp-strings';
import { groupCounts, groupState, groupText } from './permissions-role-summary';

export interface PermissionsRoleListProps {
  profiles: readonly Profile[];
  selectedId: ProfileId | null;
  usage: ReadonlyMap<ProfileId, number>;
  newAgentRole: ProfileId;
  readOnly: boolean;
  onSelect(profile: Profile): void;
  onNew(): void;
}

const STR = MCP_STR.sections.roles;

export function PermissionsRoleList({
  profiles,
  selectedId,
  usage,
  newAgentRole,
  readOnly,
  onSelect,
  onNew,
}: PermissionsRoleListProps) {
  const onKeyDown = (event: KeyboardEvent, profile: Profile) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect(profile);
  };
  return (
    <section className="permissions-role-list" aria-label={STR.title}>
      <div className="permissions-role-list__heading">
        <div>
          <h3>{STR.title}</h3>
          <p>{STR.intro}</p>
        </div>
        <button type="button" className="btn btn--sm" disabled={readOnly} onClick={onNew}>
          {STR.newRole}
        </button>
      </div>
      <table className="permissions-role-list__table">
        <thead>
          <tr>
            <th scope="col">{STR.columns.role}</th>
            <th scope="col">{STR.columns.type}</th>
            <th scope="col">{STR.columns.usedBy}</th>
            {TOOL_GROUPS.map(({ group }) => (
              <th scope="col" key={group} className="permissions-role-list__group">
                {MCP_STR.tools.group[group]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => (
            <tr
              key={profile.id}
              className="permissions-role-list__row"
              tabIndex={0}
              aria-current={profile.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(profile)}
              onKeyDown={(event) => onKeyDown(event, profile)}
            >
              <th scope="row">
                <span className="permissions-role-list__name">{profile.name}</span>
                {profile.id === newAgentRole && (
                  <span className="permissions-role-list__tag">{STR.newAgentsStartHere}</span>
                )}
              </th>
              <td>{profile.builtIn ? STR.builtIn : STR.custom}</td>
              <td>{STR.usedBy(usage.get(profile.id) ?? 0)}</td>
              {TOOL_GROUPS.map(({ group, tools }) => {
                const counts = groupCounts(profile, tools);
                const state = groupState(counts);
                return (
                  <td key={group} className="permissions-role-list__group">
                    <span className="permissions-pill" data-state={state}>
                      {STR.pill[state]}
                    </span>
                    <span className="permissions-role-list__counts">{groupText(counts)}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

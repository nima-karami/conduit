import type { KeyboardEvent } from 'react';
import type { AssignmentPoint, Profile, ProfileId } from '../../src/conduit-mcp/policy-types';
import { MCP_STR } from '../conduit-mcp-strings';

export interface AgentRow {
  point: AssignmentPoint;
  key: string;
  title: string;
  subtitle: string;
  profile: Profile | undefined;
  changes: number;
}

export interface PermissionsAgentsListProps {
  rows: readonly AgentRow[];
  profiles: readonly Profile[];
  selectedKey: string | null;
  readOnly: boolean;
  newAgentRole: ProfileId;
  onNewAgentRole(id: ProfileId): void;
  onSelect(row: AgentRow): void;
  onRoleChange(row: AgentRow, id: ProfileId): void;
}

const STR = MCP_STR.sections.agents;

function AgentTable({
  rows,
  profiles,
  selectedKey,
  readOnly,
  onSelect,
  onRoleChange,
}: Pick<
  PermissionsAgentsListProps,
  'rows' | 'profiles' | 'selectedKey' | 'readOnly' | 'onSelect' | 'onRoleChange'
>) {
  const onKeyDown = (event: KeyboardEvent, row: AgentRow) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect(row);
  };
  return (
    <table className="permissions-agents-list__table">
      <thead>
        <tr>
          <th scope="col">{STR.columns.agent}</th>
          <th scope="col">{STR.columns.role}</th>
          <th scope="col">{STR.columns.changes}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          // A machine's assignment has no editor on this tab, as before the redraw.
          const editable = row.point.kind !== 'peer';
          return (
            <tr
              key={row.key}
              className="permissions-agents-list__row"
              tabIndex={editable ? 0 : undefined}
              aria-current={editable && row.key === selectedKey ? 'true' : undefined}
              onClick={editable ? () => onSelect(row) : undefined}
              onKeyDown={editable ? (event) => onKeyDown(event, row) : undefined}
            >
              <th scope="row">
                <span className="permissions-agents-list__title">{row.title}</span>
                <span className="permissions-agents-list__subtitle">{row.subtitle}</span>
              </th>
              <td>
                <select
                  className="selectfield"
                  aria-label={STR.roleFor(row.title)}
                  value={row.profile?.id ?? ''}
                  disabled={readOnly || !editable}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const next = profiles.find((profile) => profile.id === event.target.value);
                    if (next) onRoleChange(row, next.id as ProfileId);
                  }}
                >
                  {!row.profile && <option value="" />}
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <span className="permissions-agents-list__chip" data-changes={row.changes > 0}>
                  {STR.changes(row.changes)}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function PermissionsAgentsList({
  rows,
  profiles,
  selectedKey,
  readOnly,
  newAgentRole,
  onNewAgentRole,
  onSelect,
  onRoleChange,
}: PermissionsAgentsListProps) {
  const agents = rows.filter((row) => row.point.kind === 'session');
  const defaults = rows.filter((row) => row.point.kind !== 'session');
  const table = { profiles, selectedKey, readOnly, onSelect, onRoleChange };
  return (
    <section className="permissions-agents-list" aria-label={STR.title}>
      <h3>{STR.title}</h3>
      <label className="permissions-agents-list__new">
        {STR.newAgentsStartWith}
        <select
          className="selectfield"
          value={newAgentRole}
          disabled={readOnly}
          onChange={(event) => {
            const next = profiles.find((profile) => profile.id === event.target.value);
            if (next) onNewAgentRole(next.id as ProfileId);
          }}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
      {agents.length === 0 ? (
        <p>
          {STR.empty(profiles.find((profile) => profile.id === newAgentRole)?.name ?? newAgentRole)}
        </p>
      ) : (
        <AgentTable rows={agents} {...table} />
      )}
      {defaults.length > 0 && (
        <details className="permissions-agents-list__defaults">
          <summary>{STR.defaultsByType}</summary>
          <AgentTable rows={defaults} {...table} />
        </details>
      )}
    </section>
  );
}

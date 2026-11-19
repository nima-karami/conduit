import type { Profile, ToolRule } from '../../src/conduit-mcp/policy-types';
import { TOOL_GROUPS } from '../../src/conduit-mcp/tool-policy';
import { MCP_STR } from '../conduit-mcp-strings';
import { PermissionsDrawer } from './permissions-drawer';
import { groupCounts, groupState, groupText } from './permissions-role-summary';

export interface PermissionsRoleDrawerProps {
  profile: Profile;
  used: number;
  readOnly: boolean;
  onClose(): void;
  onDuplicate(profile: Profile): void;
  onEdit(profile: Profile): void;
  onDelete(profile: Profile): void;
  onViewAgents(): void;
}

const STR = MCP_STR.sections.roles;

function conditions(rule: ToolRule): string {
  return [
    rule.when === null ? null : MCP_STR.tools.when[rule.when],
    rule.reach === null ? null : MCP_STR.tools.reach[rule.reach],
    rule.move === null ? null : MCP_STR.tools.move[rule.move],
  ]
    .filter((value): value is string => value !== null)
    .join(' · ');
}

export function PermissionsRoleDrawer({
  profile,
  used,
  readOnly,
  onClose,
  onDuplicate,
  onEdit,
  onDelete,
  onViewAgents,
}: PermissionsRoleDrawerProps) {
  const description = profile.builtIn
    ? (STR.builtInDescription[profile.id] ?? STR.customDescription)
    : STR.customDescription;
  return (
    <PermissionsDrawer
      title={profile.name}
      badge={profile.builtIn ? STR.builtIn : STR.custom}
      subtitle={description}
      closeLabel={STR.closeDrawer}
      closeGlyph={STR.closeGlyph}
      onClose={onClose}
      footer={
        profile.builtIn ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={readOnly}
            onClick={() => onDuplicate(profile)}
          >
            {STR.duplicateRole}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--danger permissions-drawer__lead"
              disabled={readOnly}
              onClick={() => onDelete(profile)}
            >
              {STR.delete}
            </button>
            <button
              type="button"
              className="btn"
              disabled={readOnly}
              onClick={() => onDuplicate(profile)}
            >
              {STR.duplicate}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={readOnly}
              onClick={() => onEdit(profile)}
            >
              {STR.edit}
            </button>
          </>
        )
      }
    >
      <p className="permissions-drawer__used">
        {STR.usedBy(used)}
        {used > 0 && (
          <>
            {' · '}
            <button type="button" className="permissions-drawer__link" onClick={onViewAgents}>
              {STR.viewAgents}
            </button>
          </>
        )}
      </p>
      {profile.builtIn && <p className="permissions-drawer__note">{STR.builtInNote}</p>}
      <div className="permissions-drawer__groups">
        {TOOL_GROUPS.map(({ group, tools }) => {
          const counts = groupCounts(profile, tools);
          return (
            <details key={group} className="permissions-drawer__group">
              <summary>
                <span className="permissions-drawer__groupname">{MCP_STR.tools.group[group]}</span>
                <span className="permissions-drawer__summary">{groupText(counts)}</span>
                <span className="permissions-pill" data-state={groupState(counts)}>
                  {STR.pill[groupState(counts)]}
                </span>
              </summary>
              <ul>
                {tools.map((tool) => {
                  const rule = profile.rules[tool];
                  const extra = conditions(rule);
                  return (
                    <li key={tool}>
                      <code>{tool}</code>
                      <span data-decision={rule.decision}>{STR.decision[rule.decision]}</span>
                      {extra && <span className="permissions-drawer__conditions">{extra}</span>}
                    </li>
                  );
                })}
              </ul>
            </details>
          );
        })}
      </div>
    </PermissionsDrawer>
  );
}

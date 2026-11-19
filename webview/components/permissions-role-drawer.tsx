import { useEffect, useRef } from 'react';
import type { Profile, ToolRule } from '../../src/conduit-mcp/policy-types';
import { TOOL_GROUPS } from '../../src/conduit-mcp/tool-policy';
import { MCP_STR } from '../conduit-mcp-strings';
import { groupCounts, groupText } from './permissions-role-summary';

export interface PermissionsRoleDrawerProps {
  profile: Profile;
  used: number;
  readOnly: boolean;
  onClose(): void;
  onDuplicate(profile: Profile): void;
  onEdit(profile: Profile): void;
  onDelete(profile: Profile): void;
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
}: PermissionsRoleDrawerProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const description = profile.builtIn
    ? (STR.builtInDescription[profile.id] ?? STR.customDescription)
    : STR.customDescription;
  return (
    <aside className="permissions-drawer" aria-labelledby="permissions-drawer-title">
      <header className="permissions-drawer__head">
        <h4 id="permissions-drawer-title" ref={heading} tabIndex={-1}>
          {profile.name}
        </h4>
        <span className="permissions-drawer__badge">
          {profile.builtIn ? STR.builtIn : STR.custom}
        </span>
        <button type="button" className="iconbtn" aria-label={STR.closeDrawer} onClick={onClose}>
          {STR.closeGlyph}
        </button>
      </header>
      <p>{description}</p>
      <p className="permissions-drawer__used">{STR.usedBy(used)}</p>
      {profile.builtIn && <p className="permissions-drawer__note">{STR.builtInNote}</p>}
      {TOOL_GROUPS.map(({ group, tools }) => (
        <details key={group} className="permissions-drawer__group">
          <summary>
            {MCP_STR.tools.group[group]}
            <span className="permissions-drawer__summary">
              {groupText(groupCounts(profile, tools))}
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
      ))}
      <footer className="permissions-drawer__actions">
        {profile.builtIn ? (
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
              className="btn"
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
        )}
      </footer>
    </aside>
  );
}

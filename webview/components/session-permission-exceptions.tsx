import { useId, useState } from 'react';
import type {
  Assignment,
  Decision,
  Exception,
  Profile,
  Scope,
} from '../../src/conduit-mcp/policy-types';
import {
  MOVE_VALUES,
  REACH_VALUES,
  TOOL_NAMES,
  TOOL_SPECS,
  type ToolName,
  WHEN_VALUES,
} from '../../src/conduit-mcp/tool-policy';
import type { Session } from '../../src/types';
import { MCP_STR } from '../conduit-mcp-strings';

const DECISION_LABEL = MCP_STR.sections.roles.decision;

export function describeExceptionScope(scope: Scope): string {
  switch (scope.kind) {
    case 'anywhere':
      return 'Anywhere';
    case 'space':
      return `Space ${scope.projectId}`;
    case 'folder':
      return `Folder ${scope.path}`;
    case 'path':
      return `Path ${scope.path}`;
    case 'session':
      return `Session ${scope.sessionId}`;
  }
}

export function SessionPermissionExceptions({
  session,
  assignment,
  disabled,
  onChange,
}: {
  session: Session;
  assignment: Assignment;
  disabled: boolean;
  onChange(assignment: Assignment): void;
}) {
  const id = useId();
  const update = (exceptions: Exception[]) => onChange({ ...assignment, exceptions });
  const seen = new Map<string, number>();
  const entries = assignment.exceptions.map((exception, index) => {
    const signature = JSON.stringify(exception);
    const count = seen.get(signature) ?? 0;
    seen.set(signature, count + 1);
    return { exception, index, key: `${signature}:${count}` };
  });
  return (
    <section className="session-permissions__section" aria-labelledby={`${id}-title`}>
      <h3 className="session-permissions__heading" id={`${id}-title`}>
        Exceptions · {assignment.exceptions.length || 'none'}
      </h3>
      {entries.map(({ exception, index, key }) => (
        <div className="session-permissions__exception" key={key}>
          <span>
            {exception.tool} · {describeExceptionScope(exception.scope)} ·{' '}
            {Object.entries(exception.rule)
              .map(([field, value]) => `${field}: ${value}`)
              .join(', ')}
          </span>
          <label className="permissions-field">
            Target
            <select
              className="session-permissions__select"
              disabled={disabled}
              value={JSON.stringify(exception.scope)}
              onChange={(event) => {
                const choices: Scope[] = [
                  { kind: 'anywhere' },
                  { kind: 'session', sessionId: session.id },
                  ...(session.projectId
                    ? [{ kind: 'space' as const, projectId: session.projectId }]
                    : []),
                  exception.scope,
                ];
                const selected = choices.find(
                  (choice) => JSON.stringify(choice) === event.target.value,
                );
                if (selected)
                  update(
                    assignment.exceptions.map((entry, at) =>
                      at === index ? { ...entry, scope: selected } : entry,
                    ),
                  );
              }}
            >
              {[
                { kind: 'anywhere' } as Scope,
                { kind: 'session', sessionId: session.id } as Scope,
                ...(session.projectId
                  ? [{ kind: 'space' as const, projectId: session.projectId }]
                  : []),
                exception.scope,
              ]
                .filter(
                  (choice, at, all) =>
                    all.findIndex((item) => JSON.stringify(item) === JSON.stringify(choice)) === at,
                )
                .map((choice) => (
                  <option key={JSON.stringify(choice)} value={JSON.stringify(choice)}>
                    {describeExceptionScope(choice)}
                  </option>
                ))}
            </select>
          </label>
          <label className="permissions-field">
            Decision
            <select
              className="session-permissions__select"
              value={exception.rule.decision ?? ''}
              disabled={disabled}
              onChange={(event) => {
                const value = event.target.value;
                const exceptions = assignment.exceptions.map((entry, at) => {
                  if (at !== index) return entry;
                  const rule = { ...entry.rule };
                  if (value === '') delete rule.decision;
                  else if (value === 'allow' || value === 'ask' || value === 'deny')
                    rule.decision = value;
                  return { ...entry, rule };
                });
                update(exceptions);
              }}
            >
              <option value="">Use role</option>
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </select>
          </label>
          {(['when', 'reach', 'move'] as const)
            .filter((field) => TOOL_SPECS[exception.tool].fields.includes(field))
            .map((field) => {
              const choices =
                field === 'when'
                  ? WHEN_VALUES
                  : field === 'reach'
                    ? (TOOL_SPECS[exception.tool].reach ?? REACH_VALUES)
                    : MOVE_VALUES;
              return (
                <label key={field} className="permissions-field">
                  {field}
                  <select
                    className="session-permissions__select"
                    value={exception.rule[field] ?? ''}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = event.target.value;
                      update(
                        assignment.exceptions.map((entry, at) => {
                          if (at !== index) return entry;
                          const rule = { ...entry.rule };
                          if (value === '') delete rule[field];
                          else if (field === 'when' && (value === 'viewing' || value === 'always'))
                            rule.when = value;
                          else if (
                            field === 'reach' &&
                            (value === 'self' ||
                              value === 'opened' ||
                              value === 'window' ||
                              value === 'any')
                          )
                            rule.reach = value;
                          else if (field === 'move' && (value === 'yes' || value === 'no'))
                            rule.move = value;
                          return { ...entry, rule };
                        }),
                      );
                    }}
                  >
                    <option value="">Use role</option>
                    {choices.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          <button
            type="button"
            className="btn btn--sm"
            disabled={disabled}
            aria-label={`Remove exception ${index + 1}: ${exception.tool}`}
            onClick={() => update(assignment.exceptions.filter((_, at) => at !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <SessionPermissionAddChange
        session={session}
        disabled={disabled}
        onAdd={(entry) => update([...assignment.exceptions, entry])}
      />
    </section>
  );
}

export function SessionPermissionAddChange({
  session,
  disabled,
  role,
  onAdd,
  onCancel,
}: {
  session: Session;
  disabled: boolean;
  role?: Profile;
  onAdd(entry: Exception): void;
  onCancel?(): void;
}) {
  const id = useId();
  const [tool, setTool] = useState<ToolName>('send_input');
  const [decision, setDecision] = useState<Decision>('ask');
  const [scopeKind, setScopeKind] = useState<Scope['kind']>('anywhere');
  const [path, setPath] = useState(session.home ?? '');
  const scope: Scope | null =
    scopeKind === 'anywhere'
      ? { kind: 'anywhere' }
      : scopeKind === 'session'
        ? { kind: 'session', sessionId: session.id }
        : scopeKind === 'space'
          ? session.projectId
            ? { kind: 'space', projectId: session.projectId }
            : null
          : path.trim()
            ? { kind: scopeKind, path: path.trim() }
            : null;
  return (
    <fieldset className="permissions-add-change" disabled={disabled}>
      <legend className="session-permissions__heading">Add a change</legend>
      <label className="permissions-add-change__field">
        Tool
        <select
          className="session-permissions__select"
          aria-label="Tool"
          value={tool}
          onChange={(event) => {
            const selected = TOOL_NAMES.find((name) => name === event.target.value);
            if (selected) setTool(selected);
          }}
        >
          {TOOL_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <div className="permissions-add-change__decision" role="radiogroup" aria-label="This agent">
        {(['allow', 'ask', 'deny'] as const).map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={id}
              value={option}
              checked={decision === option}
              onChange={() => setDecision(option)}
            />
            {option === 'allow' ? 'Allow' : option === 'ask' ? 'Ask' : 'Deny'}
          </label>
        ))}
        {role && (
          <span>
            {role.name} says {DECISION_LABEL[role.rules[tool].decision]}
          </span>
        )}
      </div>
      <label className="permissions-add-change__field">
        Where
        <select
          className="session-permissions__select"
          aria-label="Where"
          value={scopeKind}
          onChange={(event) => {
            const selected = event.target.value;
            if (
              selected === 'anywhere' ||
              selected === 'session' ||
              selected === 'space' ||
              selected === 'folder' ||
              selected === 'path'
            )
              setScopeKind(selected);
          }}
        >
          <option value="anywhere">Anywhere</option>
          <option value="session">This session</option>
          {session.projectId && <option value="space">This space</option>}
          <option value="folder">Folder</option>
          <option value="path">Exact path</option>
        </select>
      </label>
      {(scopeKind === 'folder' || scopeKind === 'path') && (
        <label className="permissions-add-change__field">
          Path
          <input
            className="modal__input"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
      )}
      <div className="permissions-add-change__actions">
        {onCancel && (
          <button type="button" className="btn btn--sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={!scope}
          onClick={() => {
            if (scope) onAdd({ tool, scope, rule: { decision } });
          }}
        >
          Add change
        </button>
      </div>
    </fieldset>
  );
}

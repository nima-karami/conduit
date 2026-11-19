import { useId, useState } from 'react';
import type { Assignment, Decision, Exception, Scope } from '../../src/conduit-mcp/policy-types';
import {
  MOVE_VALUES,
  REACH_VALUES,
  TOOL_NAMES,
  TOOL_SPECS,
  type ToolName,
  WHEN_VALUES,
} from '../../src/conduit-mcp/tool-policy';
import { describeExceptionScope } from './session-permission-exceptions';

function decisionsFor(tool: ToolName): Decision[] {
  return TOOL_SPECS[tool].access.map((access) =>
    access === 'on' ? 'allow' : access === 'off' ? 'deny' : 'ask',
  );
}

function scopeFrom(kind: Scope['kind'], raw: string): Scope | null {
  const value = raw.trim();
  if (kind === 'anywhere') return { kind };
  if (!value) return null;
  if (kind === 'session') return { kind, sessionId: value };
  if (kind === 'space') return { kind, projectId: value };
  if (!/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(value)) return null;
  return { kind, path: value };
}
function scopeValue(scope: Scope): string {
  if (scope.kind === 'session') return scope.sessionId;
  if (scope.kind === 'space') return scope.projectId;
  if (scope.kind === 'folder' || scope.kind === 'path') return scope.path;
  return '';
}
function scopeName(kind: Scope['kind']): string {
  if (kind === 'session') return 'Session ID';
  if (kind === 'space') return 'Space ID';
  return 'Absolute path';
}
function TargetEditor({
  scope,
  disabled,
  onApply,
}: {
  scope: Scope;
  disabled: boolean;
  onApply: (scope: Scope) => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<Scope['kind']>(scope.kind);
  const [value, setValue] = useState(scopeValue(scope));
  const candidate = scopeFrom(kind, value);
  return (
    <fieldset className="session-permissions__fieldset" disabled={disabled}>
      <legend className="session-permissions__heading">Target</legend>
      <span className="permissions-field">
        <label htmlFor={`${id}-kind`}>Scope</label>
        <select
          id={`${id}-kind`}
          value={kind}
          onChange={(event) => {
            const found = (['anywhere', 'space', 'session', 'folder', 'path'] as const).find(
              (item) => item === event.target.value,
            );
            if (found) setKind(found);
          }}
        >
          <option value="anywhere">Anywhere</option>
          <option value="space">Space</option>
          <option value="session">Session</option>
          <option value="folder">Folder</option>
          <option value="path">Exact path</option>
        </select>
      </span>
      {kind !== 'anywhere' && (
        <label className="permissions-field">
          {scopeName(kind)}
          <input value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
      )}
      <button
        type="button"
        className="btn btn--sm"
        disabled={!candidate}
        onClick={() => {
          if (candidate) onApply(candidate);
        }}
      >
        Apply target
      </button>
    </fieldset>
  );
}

export function PermissionsAssignmentExceptions({
  assignment,
  disabled,
  onChange,
}: {
  assignment: Assignment;
  disabled: boolean;
  onChange: (draft: Assignment) => void;
}) {
  const [tool, setTool] = useState<ToolName>('open_session');
  const [decision, setDecision] = useState<Decision>('ask');
  const update = (exceptions: Exception[]) => onChange({ ...assignment, exceptions });
  const seen = new Map<string, number>();
  const rows = assignment.exceptions.map((entry, index) => {
    const text = JSON.stringify(entry);
    const count = seen.get(text) ?? 0;
    seen.set(text, count + 1);
    return { entry, index, key: `${text}:${count}` };
  });
  return (
    <section className="session-permissions__section">
      <h3 className="session-permissions__heading">Exceptions</h3>
      {rows.map(({ entry, index, key }) => (
        <div className="session-permissions__exception" key={key}>
          <p>
            {entry.tool} · {describeExceptionScope(entry.scope)}
          </p>
          <TargetEditor
            scope={entry.scope}
            disabled={disabled}
            onApply={(scope) =>
              update(
                assignment.exceptions.map((item, at) => (at === index ? { ...item, scope } : item)),
              )
            }
          />
          <label className="permissions-field">
            Decision
            <select
              disabled={disabled}
              value={entry.rule.decision ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                update(
                  assignment.exceptions.map((item, at) => {
                    if (at !== index) return item;
                    const rule = { ...item.rule };
                    if (value === '') delete rule.decision;
                    else if (value === 'allow' || value === 'ask' || value === 'deny')
                      rule.decision = value;
                    return { ...item, rule };
                  }),
                );
              }}
            >
              <option value="">Use role</option>
              {entry.rule.decision && !decisionsFor(entry.tool).includes(entry.rule.decision) && (
                <option value={entry.rule.decision} disabled>
                  {entry.rule.decision} (existing)
                </option>
              )}
              {decisionsFor(entry.tool).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {(['when', 'reach', 'move'] as const)
            .filter((field) => TOOL_SPECS[entry.tool].fields.includes(field))
            .map((field) => {
              const options =
                field === 'when'
                  ? WHEN_VALUES
                  : field === 'reach'
                    ? (TOOL_SPECS[entry.tool].reach ?? REACH_VALUES)
                    : MOVE_VALUES;
              return (
                <label key={field} className="permissions-field">
                  {field}
                  <select
                    value={entry.rule[field] ?? ''}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = event.target.value;
                      update(
                        assignment.exceptions.map((item, at) => {
                          if (at !== index) return item;
                          const rule = { ...item.rule };
                          if (!value) delete rule[field];
                          else if (field === 'when' && (value === 'viewing' || value === 'always'))
                            rule.when = value;
                          else if (
                            field === 'reach' &&
                            (value === 'self' ||
                              value === 'opened' ||
                              value === 'window' ||
                              value === 'any') &&
                            (TOOL_SPECS[entry.tool].reach ?? REACH_VALUES).includes(value)
                          )
                            rule.reach = value;
                          else if (field === 'move' && (value === 'yes' || value === 'no'))
                            rule.move = value;
                          return { ...item, rule };
                        }),
                      );
                    }}
                  >
                    <option value="">Use role</option>
                    {options.map((value) => (
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
            aria-label={`Remove exception ${index + 1}: ${entry.tool}`}
            onClick={() => update(assignment.exceptions.filter((_, at) => at !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <fieldset className="session-permissions__fieldset" disabled={disabled}>
        <legend className="session-permissions__heading">Add exception</legend>
        <label className="permissions-field">
          Action
          <select
            value={tool}
            onChange={(event) => {
              const found = TOOL_NAMES.find((name) => name === event.target.value);
              if (found) {
                setTool(found);
                if (!decisionsFor(found).includes(decision)) setDecision(decisionsFor(found)[0]);
              }
            }}
          >
            {TOOL_NAMES.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label className="permissions-field">
          Decision
          <select
            value={decision}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'allow' || value === 'ask' || value === 'deny') setDecision(value);
            }}
          >
            {decisionsFor(tool).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() =>
            update([
              ...assignment.exceptions,
              { tool, scope: { kind: 'anywhere' }, rule: { decision } },
            ])
          }
        >
          Add exception
        </button>
      </fieldset>
    </section>
  );
}

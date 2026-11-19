import { type ReactNode, useId, useState } from 'react';
import type {
  Decision,
  PolicyEditResult,
  Profile,
  ToolRule,
} from '../../src/conduit-mcp/policy-types';
import {
  MOVE_VALUES,
  REACH_VALUES,
  TOOL_GROUPS,
  TOOL_NAMES,
  TOOL_SPECS,
  type ToolName,
  WHEN_VALUES,
  type When,
} from '../../src/conduit-mcp/tool-policy';
import type { NativeModes } from '../../src/contracts/native-launch';
import { MCP_STR } from '../conduit-mcp-strings';
import { groupCounts, groupState, groupText } from './permissions-role-summary';
import { SegmentedRadios } from './segmented-radios';

export interface PermissionsProfileEditorProps {
  draft: Profile;
  readOnly: boolean;
  onCancel(): void;
  onReviewAndSave(candidate: Profile): Promise<PolicyEditResult | null>;
}

const decisions: readonly { id: Decision; label: string }[] = [
  { id: 'allow', label: 'Allow' },
  { id: 'ask', label: 'Ask' },
  { id: 'deny', label: 'Deny' },
];
const STR = MCP_STR.sections.roles;
const unsetModes: NativeModes = { claude: 'unset', codex: 'unset' };

/** A disclosure whose body is not rendered while closed, so closed groups add no controls. */
function Disclosure({
  summary,
  defaultOpen = false,
  className,
  children,
}: {
  summary: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className={className} open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        {summary}
      </summary>
      {open && children}
    </details>
  );
}

export function PermissionsProfileEditor({
  draft,
  readOnly,
  onCancel,
  onReviewAndSave,
}: PermissionsProfileEditorProps) {
  const [profile, setProfile] = useState<Profile>(() => ({ ...draft, rules: { ...draft.rules } }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const disabled = readOnly || pending;
  const applicable = TOOL_NAMES.filter((tool) => TOOL_SPECS[tool].fields.includes('when'));
  const whenValues = new Set(applicable.map((tool) => profile.rules[tool].when));
  const screenValue = whenValues.size === 1 ? [...whenValues][0] : null;

  function updateRule(tool: ToolName, patch: Partial<ToolRule>) {
    setProfile((current) => ({
      ...current,
      rules: { ...current.rules, [tool]: { ...current.rules[tool], ...patch } },
    }));
  }
  function applyWhen(value: When) {
    setProfile((current) => {
      const rules = { ...current.rules };
      for (const tool of applicable) rules[tool] = { ...rules[tool], when: value };
      return { ...current, rules };
    });
  }
  async function save() {
    if (!profile.name.trim()) {
      setError('Enter a role name.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await onReviewAndSave({ ...profile, name: profile.name.trim() });
      if (!result) setError('The review did not respond. Reload permissions before retrying.');
      else if (!result.ok)
        setError(
          result.error === 'conflict'
            ? 'Permissions changed while you were editing. Reopen this role and try again.'
            : `Couldn’t save this role (${result.error}).`,
        );
    } catch {
      setError('Couldn’t save this role. Try again.');
    } finally {
      setPending(false);
    }
  }
  const modes = profile.nativeModes ?? unsetModes;
  return (
    <div className="permissions-profile-editor">
      <header>
        <h2>{STR.editor.title(draft.name)}</h2>
        <p>{STR.editor.appliesEverywhere}</p>
      </header>
      <label htmlFor={`${id}-name`}>Name</label>{' '}
      <input
        id={`${id}-name`}
        className="permissions-profile-editor__name"
        value={profile.name}
        disabled={disabled}
        onChange={(e) => setProfile((current) => ({ ...current, name: e.target.value }))}
      />
      <h3>{STR.editor.decisions}</h3>
      {TOOL_GROUPS.map(({ group, tools }) => {
        const counts = groupCounts(profile, tools);
        const state = groupState(counts);
        return (
          <Disclosure
            key={group}
            defaultOpen={group === 'sessions'}
            summary={
              <>
                {MCP_STR.tools.group[group]}{' '}
                <span className="permissions-pill" data-state={state}>
                  {STR.pill[state]}
                </span>{' '}
                <span className="permissions-editor__counts">{groupText(counts)}</span>
              </>
            }
          >
            {tools.map((tool) => {
              const rule = profile.rules[tool];
              const spec = TOOL_SPECS[tool];
              const hasReach = spec.fields.includes('reach') && rule.reach !== null;
              const hasMove = spec.fields.includes('move') && rule.move !== null;
              const hasWhen = spec.fields.includes('when') && rule.when !== null;
              return (
                <section className="policyrow" key={tool}>
                  <div className="policyrow__main">
                    <div className="policyrow__label">
                      <code className="policyrow__name">{tool}</code>
                      <span className="policyrow__desc">{MCP_STR.tools.description[tool]}</span>
                    </div>
                    <SegmentedRadios
                      label={`${tool} decision`}
                      value={rule.decision}
                      options={decisions}
                      disabled={disabled}
                      onChange={(decision) => updateRule(tool, { decision })}
                    />
                  </div>
                  {(hasReach || hasMove || hasWhen) && (
                    <Disclosure summary={STR.moreOptions}>
                      {hasWhen && (
                        <label>
                          {STR.screenCondition}{' '}
                          <select
                            aria-label={MCP_STR.tools.fieldAria(tool, STR.screenCondition)}
                            className="selectfield"
                            value={rule.when ?? ''}
                            disabled={disabled}
                            onChange={(e) =>
                              updateRule(tool, {
                                when: WHEN_VALUES.find((v) => v === e.target.value) ?? rule.when,
                              })
                            }
                          >
                            {WHEN_VALUES.map((value) => (
                              <option key={value} value={value}>
                                {MCP_STR.tools.when[value]}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {hasReach && rule.reach !== null && (
                        <label>
                          Reach{' '}
                          <select
                            aria-label={MCP_STR.tools.fieldAria(
                              tool,
                              MCP_STR.tools.fieldLabel.reach,
                            )}
                            className="selectfield"
                            value={rule.reach}
                            disabled={disabled}
                            onChange={(e) =>
                              updateRule(tool, {
                                reach: REACH_VALUES.find((v) => v === e.target.value) ?? rule.reach,
                              })
                            }
                          >
                            {(spec.reach ?? []).map((value) => (
                              <option key={value} value={value}>
                                {MCP_STR.tools.reach[value]}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {hasMove && rule.move !== null && (
                        <label>
                          Move{' '}
                          <select
                            aria-label={MCP_STR.tools.fieldAria(
                              tool,
                              MCP_STR.tools.fieldLabel.move,
                            )}
                            className="selectfield"
                            value={rule.move}
                            disabled={disabled}
                            onChange={(e) =>
                              updateRule(tool, {
                                move: MOVE_VALUES.find((v) => v === e.target.value) ?? rule.move,
                              })
                            }
                          >
                            {MOVE_VALUES.map((value) => (
                              <option key={value} value={value}>
                                {MCP_STR.tools.move[value]}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </Disclosure>
                  )}
                </section>
              );
            })}
          </Disclosure>
        );
      })}
      <fieldset disabled={disabled}>
        <legend>Screen condition</legend>
        <p>
          Apply to all tools that support a screen condition. Existing conditions stay unchanged
          until you choose an option.
        </p>
        {screenValue === null && <p>Mixed conditions</p>}
        <label>
          <input
            type="radio"
            name={`${id}-when`}
            checked={screenValue === 'viewing'}
            onChange={() => applyWhen('viewing')}
          />{' '}
          Only while its session is on screen
        </label>
        <br />
        <label>
          <input
            type="radio"
            name={`${id}-when`}
            checked={screenValue === 'always'}
            onChange={() => applyWhen('always')}
          />{' '}
          Always
        </label>
        <p>Other restrictions, including remote access rules, still apply.</p>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>Agent’s own mode at launch</legend>
        <p>Used at the next launch when native mode application is enabled.</p>
        <label htmlFor={`${id}-claude-mode`}>Claude</label>{' '}
        <select
          id={`${id}-claude-mode`}
          className="selectfield"
          value={modes.claude}
          onChange={(e) => {
            const claude = (['unset', 'plan', 'acceptEdits'] as const).find(
              (v) => v === e.target.value,
            );
            if (claude)
              setProfile((current) => ({
                ...current,
                nativeModes: { ...(current.nativeModes ?? unsetModes), claude },
              }));
          }}
        >
          <option value="unset">Use CLI default</option>
          <option value="plan">Plan</option>
          <option value="acceptEdits">Accept edits</option>
        </select>{' '}
        <label htmlFor={`${id}-codex-mode`}>Codex</label>{' '}
        <select
          id={`${id}-codex-mode`}
          className="selectfield"
          value={modes.codex}
          onChange={(e) => {
            const codex = (['unset', 'read-only', 'workspace-write'] as const).find(
              (v) => v === e.target.value,
            );
            if (codex)
              setProfile((current) => ({
                ...current,
                nativeModes: { ...(current.nativeModes ?? unsetModes), codex },
              }));
          }}
        >
          <option value="unset">Use CLI default</option>
          <option value="read-only">Read only</option>
          <option value="workspace-write">Workspace write</option>
        </select>
      </fieldset>
      {readOnly && <p>Permissions are read-only.</p>}
      {error && <p role="alert">{error}</p>}
      <footer>
        <button className="btn" type="button" disabled={pending} onClick={onCancel}>
          Cancel
        </button>{' '}
        <button className="btn btn--primary" type="button" disabled={disabled} onClick={save}>
          {pending ? 'Reviewing…' : 'Review and save'}
        </button>
      </footer>
    </div>
  );
}

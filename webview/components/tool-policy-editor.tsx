/**
 * One layer of the MCP tool policy, shared by Settings (global and per-CLI) and the session
 * dialog (spec 2026-10-30-conduit-mcp-tool-policy §8–§10).
 */
import { useId, useState } from 'react';
import {
  ACCESS_VALUES,
  isValidField,
  MOVE_VALUES,
  type PolicyField,
  type PolicyLayers,
  type PolicySource,
  type PolicyValue,
  REACH_VALUES,
  resolvePolicy,
  TOOL_GROUPS,
  TOOL_SPECS,
  type ToolName,
  WHEN_VALUES,
} from '../../src/conduit-mcp/tool-policy';
import { MCP_STR } from '../conduit-mcp-strings';
import { IconChevronDown } from '../icons';
import { SegmentedRadios } from './segmented-radios';
import { SelectField } from './select-field';

export interface ToolPolicyEditorProps {
  /** The layer these controls write; 'global' offers no Inherit. */
  layer: PolicySource;
  /** The stack up to and including `layer` ('global': only global). */
  layers: PolicyLayers;
  /** Display name of a layer, for "Inherit (On · from All CLIs)". */
  sourceName(source: PolicySource): string;
  disabled: boolean;
  /** Tools whose last change failed to save. */
  failed?: ReadonlySet<ToolName>;
  onChange(tool: ToolName, field: PolicyField, value: PolicyValue | 'inherit'): void;
}

type Choice = PolicyValue | 'inherit';
type ConditionField = Exclude<PolicyField, 'access'>;

const S = MCP_STR.tools;
const FIELD_VALUES: Record<PolicyField, readonly PolicyValue[]> = {
  access: ACCESS_VALUES,
  when: WHEN_VALUES,
  reach: REACH_VALUES,
  move: MOVE_VALUES,
};
const FIELD_LABELS: Record<PolicyField, Readonly<Record<string, string>>> = {
  access: S.access,
  when: S.when,
  reach: S.reach,
  move: S.move,
};

/** The catalog decides what a tool offers; the value lists only fix the order. */
const offeredValues = (tool: ToolName, field: PolicyField): PolicyValue[] =>
  FIELD_VALUES[field].filter((v) => isValidField(tool, field, v));

/** The layers below `layer`: what Inherit resolves to. */
function below(layer: PolicySource, layers: PolicyLayers): PolicyLayers | null {
  if (layer === 'global') return null;
  return layer === 'session'
    ? { cli: layers.cli, global: layers.global }
    : { global: layers.global };
}

export function ToolPolicyEditor(p: ToolPolicyEditorProps) {
  const idBase = useId();
  return (
    <>
      {TOOL_GROUPS.map((g) => (
        <div
          key={g.group}
          className="policygroup"
          role="group"
          aria-labelledby={`${idBase}-${g.group}`}
        >
          <h4 className="policygroup__title" id={`${idBase}-${g.group}`}>
            {S.group[g.group]}
          </h4>
          {g.tools.map((tool) => (
            <PolicyRow key={tool} tool={tool} {...p} />
          ))}
        </div>
      ))}
    </>
  );
}

function PolicyRow({
  tool,
  layer,
  layers,
  sourceName,
  disabled,
  failed,
  onChange,
}: ToolPolicyEditorProps & { tool: ToolName }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const inheritFrom = below(layer, layers);
  const inherited = inheritFrom && resolvePolicy(tool, inheritFrom);
  const conditions = TOOL_SPECS[tool].fields.filter((f): f is ConditionField => f !== 'access');

  const shown = (f: PolicyField): Choice | undefined =>
    layer === 'global' ? layers.global[tool][f] : (layers[layer]?.[tool]?.[f] ?? 'inherit');

  const options = (f: PolicyField): { id: Choice; label: string }[] => {
    const own = offeredValues(tool, f).map((v) => ({ id: v, label: FIELD_LABELS[f][v] }));
    const v = inherited?.policy[f];
    const src = inherited?.source[f];
    if (v === undefined || src === undefined) return own;
    return [{ id: 'inherit', label: S.inherited(FIELD_LABELS[f][v], sourceName(src)) }, ...own];
  };

  const warning = S.onWarning[tool];
  // Warns about what will actually run, whichever layer turned it on.
  const warn = warning !== undefined && resolvePolicy(tool, layers).policy.access === 'on';

  return (
    <section className="policyrow" data-tool={tool}>
      <div className="policyrow__main">
        <div className="policyrow__label">
          <code className="policyrow__name">{tool}</code>
          <span className="policyrow__desc">{S.description[tool]}</span>
        </div>
        <SegmentedRadios<Choice>
          label={S.accessLabel(tool)}
          value={shown('access') ?? 'inherit'}
          disabled={disabled}
          // Walking the arrows would persist every value passed, briefly opening open_terminal.
          selectOnArrow={false}
          options={options('access')}
          onChange={(next) => onChange(tool, 'access', next)}
        />
      </div>
      {warn && <p className="policyrow__warn">{warning}</p>}
      {conditions.length > 0 && (
        <>
          <button
            type="button"
            className="btn btn--sm policyrow__cond"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((o) => !o)}
          >
            {S.conditions}
            <IconChevronDown size={12} className="policyrow__chev" />
          </button>
          <div id={panelId} className="policyrow__fields" hidden={!open}>
            {open &&
              conditions.map((f) => {
                const opts = options(f);
                return (
                  <div key={f} className="policyrow__field" data-field={f}>
                    <span className="policyrow__fieldlabel">{S.fieldLabel[f]}</span>
                    <SelectField
                      ariaLabel={S.fieldAria(tool, f)}
                      value={shown(f) ?? 'inherit'}
                      disabled={disabled}
                      options={opts.map((o) => ({ value: o.id, label: o.label }))}
                      onChange={(next) => {
                        const choice = opts.find((o) => o.id === next);
                        if (choice) onChange(tool, f, choice.id);
                      }}
                    />
                  </div>
                );
              })}
          </div>
        </>
      )}
      {failed?.has(tool) && (
        <p className="policyrow__error" role="status">
          {S.saveFailed}
        </p>
      )}
    </section>
  );
}

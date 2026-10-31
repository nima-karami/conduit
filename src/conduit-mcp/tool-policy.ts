// Node-free: the renderer imports the catalog and resolution for Settings and the session dialog.
// Model: docs/specs/2026-10-30-conduit-mcp-tool-policy.md §3.
import type { ClientKind } from './client-info';
import { type ToolError, toolError } from './types';

export const MESSAGING_TOOL_NAMES = [
  'list_sessions',
  'send_message',
  'read_inbox',
  'read_attachment',
] as const;
const SESSION_TOOL_NAMES = [
  'open_session',
  'open_terminal',
  'close_session',
  'focus_session',
  'attach_folder',
] as const;
const EDITOR_TOOL_NAMES = [
  'open_file',
  'close_files',
  'open_review',
  'open_git_history',
  'open_url',
] as const;
export const TOOL_NAMES = [
  ...MESSAGING_TOOL_NAMES,
  ...SESSION_TOOL_NAMES,
  ...EDITOR_TOOL_NAMES,
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolGroup = 'messaging' | 'sessions' | 'editor';
export const TOOL_GROUPS: readonly { group: ToolGroup; tools: readonly ToolName[] }[] = [
  { group: 'messaging', tools: MESSAGING_TOOL_NAMES },
  { group: 'sessions', tools: SESSION_TOOL_NAMES },
  { group: 'editor', tools: EDITOR_TOOL_NAMES },
];

export const ACCESS_VALUES = ['off', 'ask', 'on'] as const;
export const WHEN_VALUES = ['viewing', 'always'] as const;
export const REACH_VALUES = ['self', 'opened', 'window', 'any'] as const;
export const MOVE_VALUES = ['yes', 'no'] as const;
export type Access = (typeof ACCESS_VALUES)[number];
export type When = (typeof WHEN_VALUES)[number];
export type Reach = (typeof REACH_VALUES)[number];
export type Move = (typeof MOVE_VALUES)[number];
export type PolicyField = 'access' | 'when' | 'reach' | 'move';
export type PolicyValue = Access | When | Reach | Move;

/** Only the tool's applicable fields are present (spec §3.2). */
export interface ToolPolicy {
  access: Access;
  when?: When;
  reach?: Reach;
  move?: Move;
}
export type PolicyLayer = Partial<Record<ToolName, Partial<ToolPolicy>>>;
export type GlobalPolicy = Record<ToolName, ToolPolicy>;
export type CliKind = Exclude<ClientKind, 'fake'>;
export const CLI_KINDS: readonly CliKind[] = ['claude', 'codex', 'cursor', 'opencode', 'agent'];
export type CliPolicyLayers = Partial<Record<CliKind, PolicyLayer>>;
export type PolicySource = 'session' | 'cli' | 'global';
export interface PolicyLayers {
  session?: PolicyLayer;
  cli?: PolicyLayer;
  global: GlobalPolicy;
}
export interface ResolvedPolicy {
  policy: ToolPolicy;
  /** One entry per applicable field; access always applies. */
  source: Partial<Record<PolicyField, PolicySource>> & { access: PolicySource };
}
/** Per field; 'inherit' deletes that field from the layer. */
export interface ToolPolicyPatch {
  access?: Access | 'inherit';
  when?: When | 'inherit';
  reach?: Reach | 'inherit';
  move?: Move | 'inherit';
}

type RateBudget = 'act' | 'show';
type MessagingToolName = (typeof MESSAGING_TOOL_NAMES)[number];
export interface ToolSpec<B extends RateBudget | null = RateBudget | null> {
  /** Applicable fields, 'access' first. */
  fields: readonly PolicyField[];
  /** Offered access values: messaging tools have no 'ask'. */
  access: readonly Access[];
  /** Offered reach values when 'reach' applies (Part B rows). */
  reach?: readonly Reach[];
  /** null: messaging, not budgeted. */
  budget: B;
  defaults: ToolPolicy;
}

// Messaging has no 'ask': a card per read_inbox is noise (spec §3.2).
const MESSAGING_SPEC: ToolSpec<null> = {
  fields: ['access'],
  access: ['off', 'on'],
  budget: null,
  defaults: { access: 'on' },
};
const SESSION_FIELDS: readonly PolicyField[] = ['access', 'when', 'move'];
// Every reach row lists its values: offered() would otherwise fall back to all of REACH_VALUES.
// reach:any only for focus_session and close_session (spec §3.2).
const REACH_TO_ANY: readonly Reach[] = ['self', 'opened', 'window', 'any'];
const REACH_TO_WINDOW: readonly Reach[] = ['self', 'opened', 'window'];
const VIEW_SPEC: ToolSpec<RateBudget> = {
  fields: ['access', 'when'],
  access: ACCESS_VALUES,
  budget: 'show',
  defaults: { access: 'on', when: 'viewing' },
};

/** Typed per tool so a control tool's budget is never null. */
export const TOOL_SPECS: Readonly<{
  [K in ToolName]: ToolSpec<K extends MessagingToolName ? null : RateBudget>;
}> = {
  list_sessions: MESSAGING_SPEC,
  send_message: MESSAGING_SPEC,
  read_inbox: MESSAGING_SPEC,
  read_attachment: MESSAGING_SPEC,
  open_session: {
    fields: SESSION_FIELDS,
    access: ACCESS_VALUES,
    budget: 'act',
    defaults: { access: 'ask', when: 'viewing', move: 'yes' },
  },
  open_terminal: {
    fields: SESSION_FIELDS,
    access: ACCESS_VALUES,
    budget: 'act',
    defaults: { access: 'off', when: 'viewing', move: 'yes' },
  },
  open_file: VIEW_SPEC,
  close_session: {
    fields: ['access', 'when', 'reach'],
    access: ACCESS_VALUES,
    reach: REACH_TO_ANY,
    budget: 'act',
    defaults: { access: 'ask', when: 'viewing', reach: 'window' },
  },
  focus_session: {
    fields: ['access', 'when', 'reach', 'move'],
    access: ACCESS_VALUES,
    reach: REACH_TO_ANY,
    budget: 'show',
    defaults: { access: 'on', when: 'viewing', reach: 'window', move: 'yes' },
  },
  attach_folder: {
    fields: ['access', 'when', 'reach'],
    access: ACCESS_VALUES,
    reach: REACH_TO_WINDOW,
    budget: 'act',
    defaults: { access: 'ask', when: 'viewing', reach: 'self' },
  },
  close_files: VIEW_SPEC,
  open_review: VIEW_SPEC,
  open_git_history: VIEW_SPEC,
  open_url: VIEW_SPEC,
};

const defaultsCopy = (): GlobalPolicy => {
  const out = {} as GlobalPolicy;
  for (const t of TOOL_NAMES) out[t] = { ...TOOL_SPECS[t].defaults };
  return out;
};

export const DEFAULT_TOOL_POLICY: Readonly<GlobalPolicy> = Object.freeze(defaultsCopy());

const NAMES: ReadonlySet<string> = new Set(TOOL_NAMES);
const MESSAGING: ReadonlySet<ToolName> = new Set(MESSAGING_TOOL_NAMES);

export function isToolName(v: unknown): v is ToolName {
  return typeof v === 'string' && NAMES.has(v);
}

export function isMessagingTool(t: ToolName): boolean {
  return MESSAGING.has(t);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const offered = (tool: ToolName, field: PolicyField): readonly PolicyValue[] => {
  const spec = TOOL_SPECS[tool];
  switch (field) {
    case 'access':
      return spec.access;
    case 'when':
      return WHEN_VALUES;
    case 'reach':
      return spec.reach ?? REACH_VALUES;
    case 'move':
      return MOVE_VALUES;
  }
};

/** v is offered for that tool's field. */
export function isValidField<F extends PolicyField>(
  tool: ToolName,
  field: F,
  v: unknown,
): v is NonNullable<ToolPolicy[F]> {
  return TOOL_SPECS[tool].fields.includes(field) && offered(tool, field).some((x) => x === v);
}

function setField<F extends PolicyField>(
  target: Partial<ToolPolicy>,
  f: F,
  v: ToolPolicy[F] | 'inherit',
): void {
  if (v === 'inherit') delete target[f];
  else target[f] = v;
}

/** The valid applicable fields of one raw tool entry; undefined when none survive. */
function coerceEntry(tool: ToolName, v: unknown): Partial<ToolPolicy> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Partial<ToolPolicy> = {};
  for (const f of TOOL_SPECS[tool].fields) {
    const x = v[f];
    if (isValidField(tool, f, x)) setField(out, f, x);
  }
  return Object.keys(out).length ? out : undefined;
}

/** A v0.50 `true` switch: on, and unconditional because v0.50 had no on-screen condition. */
const legacyOn = (tool: ToolName): Partial<ToolPolicy> =>
  TOOL_SPECS[tool].fields.includes('when') ? { access: 'on', when: 'always' } : { access: 'on' };

/**
 * Complete global layer. When `v` is a record it wins and `legacy` is ignored; per tool, valid
 * applicable fields overlay the defaults. Otherwise a v0.50 `mcpTools` record migrates per tool:
 * true → {access:'on', when:'always'} (when only if applicable) over the defaults; false on a tool
 * whose v0.50 default was true (MESSAGING_TOOL_NAMES) → {access:'off'}; anything else → defaults.
 * Never throws.
 */
export function coerceGlobalPolicy(v: unknown, legacy?: unknown): GlobalPolicy {
  const out = defaultsCopy();
  if (isRecord(v)) {
    for (const t of TOOL_NAMES) Object.assign(out[t], coerceEntry(t, v[t]));
    return out;
  }
  if (!isRecord(legacy)) return out;
  for (const t of TOOL_NAMES) {
    // A v0.50 false only says something on a tool that defaulted to true (spec §3.1).
    if (legacy[t] === true) Object.assign(out[t], legacyOn(t));
    else if (legacy[t] === false && isMessagingTool(t)) out[t].access = 'off';
  }
  return out;
}

/** Known tools, applicable fields, valid values only; empty entries dropped; undefined when empty. */
export function coercePolicyLayer(v: unknown): PolicyLayer | undefined {
  if (!isRecord(v)) return undefined;
  const out: PolicyLayer = {};
  for (const t of TOOL_NAMES) {
    const entry = coerceEntry(t, v[t]);
    if (entry) out[t] = entry;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Known CLI kinds only, each through coercePolicyLayer; undefined when empty. */
export function coerceCliLayers(v: unknown): CliPolicyLayers | undefined {
  if (!isRecord(v)) return undefined;
  const out: CliPolicyLayers = {};
  for (const k of CLI_KINDS) {
    const layer = coercePolicyLayer(v[k]);
    if (layer) out[k] = layer;
  }
  return Object.keys(out).length ? out : undefined;
}

/** v0.50 Session.mcpToolOverrides: true → {access:'on', when:'always'}; false → {access:'off'}. */
export function migrateToolOverrides(v: unknown): PolicyLayer | undefined {
  if (!isRecord(v)) return undefined;
  const out: PolicyLayer = {};
  for (const t of TOOL_NAMES) {
    if (v[t] === true) out[t] = legacyOn(t);
    else if (v[t] === false) out[t] = { access: 'off' };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Per applicable field: first valid value in session, cli, global. Total; never throws. */
export function resolvePolicy(tool: ToolName, layers: PolicyLayers): ResolvedPolicy {
  const order: readonly [PolicySource, Partial<ToolPolicy> | undefined][] = [
    ['session', layers.session?.[tool]],
    ['cli', layers.cli?.[tool]],
    ['global', layers.global[tool]],
  ];
  const fields = TOOL_SPECS[tool].fields;
  const pick = <F extends PolicyField>(f: F): [ToolPolicy[F], PolicySource] => {
    for (const [src, entry] of order) {
      const v = isRecord(entry) ? entry[f] : undefined;
      if (isValidField(tool, f, v)) return [v, src];
    }
    // The global layer is complete once coerced; a corrupt one still resolves to the default.
    return [TOOL_SPECS[tool].defaults[f], 'global'];
  };
  const [access, accessSource] = pick('access');
  const policy: ToolPolicy = { access };
  const source: ResolvedPolicy['source'] = { access: accessSource };
  const field = <F extends PolicyField>(f: F): ToolPolicy[F] => {
    const [v, src] = pick(f);
    source[f] = src;
    return v;
  };
  if (fields.includes('when')) policy.when = field('when');
  if (fields.includes('reach')) policy.reach = field('reach');
  if (fields.includes('move')) policy.move = field('move');
  return { policy, source };
}

/** Immutable. A field 'inherit' deletes it; an emptied tool entry is dropped; undefined when empty. */
export function withPolicyPatch(
  layer: PolicyLayer | undefined,
  tool: ToolName,
  patch: ToolPolicyPatch,
): PolicyLayer | undefined {
  const entry: Partial<ToolPolicy> = { ...layer?.[tool] };
  if (patch.access !== undefined) setField(entry, 'access', patch.access);
  if (patch.when !== undefined) setField(entry, 'when', patch.when);
  if (patch.reach !== undefined) setField(entry, 'reach', patch.reach);
  if (patch.move !== undefined) setField(entry, 'move', patch.move);
  const next: PolicyLayer = { ...layer };
  if (Object.keys(entry).length) next[tool] = entry;
  else delete next[tool];
  return Object.keys(next).length ? next : undefined;
}

/** IPC boundary: null when any key isn't an applicable field, any value is invalid, or it is empty. */
export function coercePolicyPatch(tool: ToolName, v: unknown): ToolPolicyPatch | null {
  if (!isRecord(v)) return null;
  const fields = TOOL_SPECS[tool].fields;
  const keys = Object.keys(v);
  if (!keys.length || keys.some((k) => !fields.some((f) => f === k))) return null;
  let invalid = false;
  const pick = <F extends PolicyField>(
    f: F,
  ): NonNullable<ToolPolicy[F]> | 'inherit' | undefined => {
    if (!Object.hasOwn(v, f)) return undefined;
    const x = v[f];
    if (x === 'inherit' || isValidField(tool, f, x)) return x;
    invalid = true;
    return undefined;
  };
  const out: ToolPolicyPatch = {};
  const access = pick('access');
  if (access !== undefined) out.access = access;
  const when = pick('when');
  if (when !== undefined) out.when = when;
  const reach = pick('reach');
  if (reach !== undefined) out.reach = reach;
  const move = pick('move');
  if (move !== undefined) out.move = move;
  return invalid ? null : out;
}

/** Also the call flow's fail-closed answer for a policy that reached it as 'off'. */
export const toolDisabled = (tool: ToolName): ToolError =>
  toolError('tool_disabled', `${tool} is not enabled for this session`);

/** Also the call flow's refusal when an ask finds no owner window. */
export const windowNotReady = (): ToolError =>
  toolError('window_not_ready', "this session's Conduit window isn't ready; try again shortly");

/** Spec §3.3 steps 1–5; null ⇒ proceed. Steps 4–5 only for non-messaging tools; thunks run lazily. */
export function gateToolCall(i: {
  sessionId: string | null;
  messagingOn: boolean;
  tool: ToolName;
  policy: ToolPolicy;
  ownerReady: () => boolean;
  onScreen: () => boolean;
}): ToolError | null {
  if (i.sessionId === null)
    return toolError('not_in_session', 'this MCP connection is not a Conduit session');
  if (!i.messagingOn) return toolError('messaging_off', 'Conduit messaging is turned off');
  // Deliberately silent on how to enable it (spec 2026-10-27-conduit-mcp-control-tools §3.2).
  if (i.policy.access === 'off') return toolDisabled(i.tool);
  if (isMessagingTool(i.tool)) return null;
  // Fail closed: without a ready window there is no card to ask on and no visibility to trust.
  if (!i.ownerReady()) return windowNotReady();
  if (i.policy.when === 'viewing' && !i.onScreen())
    return toolError('caller_not_visible', `${i.tool} only runs while your session is on screen`);
  return null;
}

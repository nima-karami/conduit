# Plan: Conduit MCP tool policies (Part A)

Spec: [2026-10-30-conduit-mcp-tool-policy.md](../specs/2026-10-30-conduit-mcp-tool-policy.md)
(FULL, reviewed twice). Sibling, built after this one:
[2026-10-30-conduit-mcp-app-control.md](../specs/2026-10-30-conduit-mcp-app-control.md) (Part B).

**Tier: FULL.** The feature replaces the v0.50 boolean switches with a three-layer policy model,
adds a per-window presence store, an ask broker with an in-app approval card, threads the JSON-RPC
request id and `notifications/cancelled` through to the host, and rewrites the Settings and session
policy editors. It crosses `src/`, `electron/` and `webview/`, and executors pick tasks up cold.
Planned against `feat/mcp-policy` at `9c03366f` (main `1b4d90f2` = v0.50.0 + the two specs). Every
line number below was grepped at that HEAD; re-grep before editing, since earlier tasks shift them.

## Goal

Every Conduit MCP tool call is allowed, asked or refused by one policy resolved field by field
(session > CLI kind > global), with `viewing` enforced against a fail-closed per-window presence
store, `ask` answered on a non-focus-stealing card in the caller's window, and the three existing
control tools moved onto it. Part B then adds seven tools on the same seams.

## Architecture

- **Pure cores (node-free, renderer-importable unless noted):**
  - `src/conduit-mcp/tool-policy.ts` replaces `src/conduit-mcp/tool-switches.ts`. It owns the tool
    catalog (names, groups, per-tool applicable fields, allowed values, defaults, rate budget),
    the policy types, coercion, v0.50 migration, `resolvePolicy`, patching, and the gate's steps
    1–5.
  - `src/conduit-mcp/handles.ts` gains `cliKindOfHandle`, the only handle → CLI kind parser.
  - `src/conduit-mcp/ask-broker.ts` is the pending-ask store: per-CLI timeout table, at most 3 per
    caller, one end per ask, cancel by predicate. Timers are deps.
  - `src/window-presence.ts` holds per-window readiness and the last visible report,
    fail-closed. It is separate from `session-activity` / `session-resource-demand`, whose
    fail-open semantics stay untouched.
- **Tool logic:** `src/conduit-mcp/control-tools.ts` splits each tool into **prepare** (parse →
  rate reservation → path/agent/command checks → an `AskSummary`) and **run** (the IO). The host
  asks between the two. Two budgets: act (`open_session`, `open_terminal`) and show (`open_file`).
- **Host:** `electron/conduit-mcp-host.ts` resolves the policy per call, runs the gate, prepares,
  asks when `access:'ask'`, then runs. It owns the broker, routes `mcp:ask` / `mcp:askClosed` to
  the caller's owner window through `sendToOwner`, broadcasts `awaitingApproval` in `mcp:state`,
  and takes `notifications/cancelled` and window resets.
- **Main:** `electron/main.ts` feeds the presence store (main-frame navigation start, `ready`,
  `visible`, window closed), supplies the four new host deps, routes `mcp:askAnswer` /
  `mcp:setToolPolicy`, and makes `open_file` open in the caller's session.
- **Renderer:**
  - one shared policy editor, `webview/components/tool-policy-editor.tsx`, used by the Settings
    MCP tab (global layer + a CLI-layer tablist) and the session MCP tools dialog;
  - an ask store, `webview/mcp-ask-store.ts`, and the card, `webview/components/approval-card.tsx`;
  - the attention chip counts asks; the caller's session card shows a "Waiting for your approval"
    button.
- **Seams Part B extends (and nothing else):** `TOOL_NAMES` / `TOOL_SPECS` rows (with `reach`
  options), the `AskSummary` union, `PreparedCall<T>`, the host's `runTool`/prepare switch,
  `ToolErrorCode`, `MCP_STR.tools.description` / `MCP_STR.ask.summary`, and `onWindowReset`
  (Part B's pending `mcp:ui` map fails there with `window_not_ready`).
- **No sketches.** Every seam copies a sibling: the broker copies the host's per-session runtime
  maps; the editor copies `SegmentedRadios` usage in the current dialog; the ask store copies the
  module-singleton subscription in `webview/use-conduit-mcp.ts:36-49`; the card portals to body
  like `webview/components/toasts.tsx`.

## Data flow

```
POLICY WRITES
 Settings editor (global | CLI tab) ─updateSettings{mcpToolPolicy | mcpToolPolicyByCli}─►
     main.ts updateSettings → coerceSettings (migrates v0.50 mcpTools) → persist → mcpHost.refresh()
       refresh(): syncToolLists() + cancel waiting asks whose access is now off + broadcast
 Session dialog ─mcp:setToolPolicy{requestId,sessionId,tool,patch}─► host.handleRenderer
     coercePolicyPatch → mgr.setMcpToolPolicy → persist → reply mcp:toolPolicyResult → refresh()

PRESENCE (main)            createWindow: webContents 'did-start-navigation' (main frame, not
                           same-document) ─► presence.startLoading(wid) + mcpHost.onWindowReset(wid)
 renderer 'ready'      ─► presence.markReady(senderId)
 renderer 'visible'    ─► presence.setVisible(senderId, ids)   (activity/gitDemand unchanged)
 window 'closed'       ─► presence.drop(wid) + mcpHost.onWindowReset(wid)

CALL  CLI ─tools/call{id}─► json-rpc core ─call(name,args,{requestId})─► host.callTool(sid,name,args,{requestId,connId})
   resolve: layers = { session: Session.mcpToolPolicy, cli: byCli[cliKindOfHandle(handle)], global }
   gateToolCall: not_in_session → messaging_off → tool_disabled → window_not_ready (ownerReady)
                 → caller_not_visible (when:viewing && !isOnScreen)            [steps 1–5]
   messaging tool: store_unavailable → tools.* (unchanged)
   control tool:  control.prepareX(caller,args,{move})                        [parse, rate(6), checks(7)]
     access 'on'  ─► prepared.run()                                           [exec(9): refund on failure]
     access 'ask' ─► broker.waitingFor(caller) ≥ 3 ⇒ release + rate_limited
                     early-cancelled request ⇒ release + no reply
                     wid = sendToOwner(caller, mcp:ask{askId,…}); wid null ⇒ release + window_not_ready
                     broker.open({askId,…,windowId:wid}, ASK_TIMEOUT_MS[kind]); flashOwner; broadcast
                     ── await end ──
                     answered approve ⇒ run   | always ⇒ mgr.setMcpToolPolicy(caller,tool,{access:'on'}) + refresh + run
                     answered deny ⇒ denied   | expired ⇒ approval_timeout   (token kept, askClosed sent)
                     cancelled reply:true ⇒ cancelled | reply:false ⇒ null ⇒ core sends nothing
 CLI ─notifications/cancelled{requestId}─► core.cancelled(requestId) ─► host: broker.cancel(key, reply:false)
                                            (no pending ask but call in flight ⇒ remember as early-cancelled)
 conn close ─► broker.cancel(connId, reply:false)   session deleted / window reset ─► reply:true

ASK UI (owner window only)
 mcp:ask ─► mcp-ask-store (oldest first) ─► ApprovalCard (pager, never auto-focused) + chip entries
 card button ─► answerAsk ─► mcp:askAnswer ─► main ─► host.handleRenderer ─► broker.answer
 mcp:askClosed{expired|cancelled} ─► store removes + info toast
 mcp:state.awaitingApproval (all windows) ─► sidebar ─► session card "Waiting for your approval"
```

## Settled decisions — do not re-litigate

From the spec, the conductor's Level-1 lock and research outcomes (`.autoloop/evidence/plan-inputs.md`):
- Policy fields `access` off/ask/on, `when` viewing/always, `reach` self/opened/window/any, `move`
  yes/no; applicability and defaults per spec §3.2. Resolution is per field, most specific set
  value wins: session > CLI layer > global. The global layer is complete, so "unset everywhere"
  can't happen. No restrict-only ceilings or locks.
- The CLI kind is the persisted handle's prefix; `fake` and unknown prefixes map to `agent`. A
  convenience, not a security boundary.
- `tool-policy.ts` replaces `tool-switches.ts` (whole file superseded). `window-presence.ts` is new
  and pure; existing activity/gitDemand sets are untouched.
- Host deps gain `sendToOwner(sessionId, msg)`, `ownerReady(sessionId)`, `isOnScreen(sessionId)`,
  `flashOwner(sessionId)`. Ask details go to the owner window only; the broadcast `McpUiState`
  gains `awaitingApproval: string[]` (caller session ids).
- JSON-RPC core: `call(name, args, ctx)` with the request id; `notifications/cancelled` is no
  longer dropped; other notifications still are.
- Ask timeout per caller CLI kind (documented limits, not measured): claude 120 s, codex 50 s,
  cursor 50 s, opencode 25 s, agent 25 s. A constant table in `ask-broker.ts`.
- On `notifications/cancelled`: remove the card and send **no** reply for that request. Session
  closed, window closed/reloaded: reply `cancelled`. Connection closed: nothing to reply to. Late
  answers after any end are ignored.
- At most 3 waiting asks per caller; a 4th returns `rate_limited`.
- "Always for this session" writes a **persistent** session override `access:'on'` (spec D2).
- Rate: act 10/min per caller + 20/min global; show 30/min per caller. A refusal at step 7 or 9
  refunds the token; a denied, expired or cancelled ask keeps it.
- Approval card: `webview/components/approval-card.tsx` + `webview/mcp-ask-store.ts`; a new CSS
  layer token `--layer-ask` between toast (80) and popover (200).
- Claude's `--allowedTools` stays messaging-only, so Claude may prompt before Conduit's own ask
  (double prompt, accepted). Codex `default_tools_approval_mode="auto"` is unchanged on purpose.
- Out: progress notifications, elicitation, tool annotations, restrict-only locks.
- Two refinements this plan owns (not re-litigations):
  - `sendToOwner` **returns** the window id it sent to (`number | null`), so the broker can cancel
    a window's asks without a second owner lookup;
  - the core is per connection, so the host closure binds `connId` around the core's
    `call(name, args, { requestId })` and `cancelled(requestId)`.

## Spec staleness

Measured at `9c03366f`; each row says how the plan proceeds.

| Spec claim | Measured | Plan proceeds |
|---|---|---|
| Ask timeout is a flat 50 s; every cancel returns `cancelled` (§2.4, §5, §13 D3) | Conductor lock + research: per-CLI table; no reply after `notifications/cancelled` | Spec lines §2.4, §5 and §13 D3 updated in this branch to match. §2.6 row 3 still says "ASSUMED; measured at S0": it is now documented (research), not measured; left as is |
| Per-window readiness keys on `did-start-loading` (§2.3, §3.4) | No navigation listener exists anywhere in `electron/` (grep). `did-start-loading` is the spinner event and also fires for subframe loads. The renderer has no `<iframe>` today (grep `webview/`: only comments in `md-sanitize.ts`), and web tabs are `<webview>` guests with their own webContents | T1.10 listens to `did-start-navigation` filtered to `isMainFrame && !isSameDocument`, which is exactly "this window's document is being replaced" and stays true if an iframe is ever added |
| The card is reached "via the chip or F6 pane cycling" (§9) | No F6 handler exists in `webview/` (grep `F6`: one unrelated comment) | The card is reached by the chip and by the session card's "Waiting for your approval" button. No F6 cycling is added (Out of scope) |
| MVP Part A e2e includes "reach refusal" (§6) | No Part A tool has a `reach` field (§3.2: `reach` applies only to `focus_session`, `attach_folder`, `close_session`, all Part B) | `Reach` is in the types, coercion and editor (data-driven), but its enforcement (`out_of_reach`) and its e2e land with Part B's first session-targeting tool. Decisions Needed N1 |
| `mcp:setToolPolicy.patch` is `Partial<ToolPolicy> \| 'inherit'` (§3.4) | §8 needs Inherit **per field** in the dialog; a `Partial<ToolPolicy>` can't say "inherit this field", and whole-tool `'inherit'` would have no UI producer | `ToolPolicyPatch` carries `'inherit'` per field; there is no whole-tool `'inherit'` |
| `settings.mcpToolPolicyByCli?` is optional (§3.1) | Every `AppSettings` field is required with a default (`src/settings.ts:183-195`) | Required, default `{}` |
| The CLI kind is the handle prefix (§2.1) | No handle → kind parser exists (`src/conduit-mcp/handles.ts`); the e2e fake agent's prefix is `fake` (adapter id), its `clientInfo` name `fake-mcp-agent` maps to `agent` | T1.2 adds `cliKindOfHandle`; the e2e fake resolves to the `agent` ("Other") layer |
| S0: "whether `list_sessions` exposes handle-less sessions" (A7) | Source: `listedSessions` (`electron/conduit-mcp-host.ts:347-358`) skips any session without `mcpHandle`, and `directory()` (`:422`) feeds `list_sessions` from it | S0 pins it with a host unit test, so Part B can rely on "handle-less sessions are not listed, hence not targetable by id" |
| S0: "whether every CLI accepts the new schemas" | Part A adds no tool and no input schema (descriptions change only) | Moved to Part B's S0 |
| `open_file` opens in the caller's session (app-control §2.1, Part A MVP) | `openMcpFile` resolves the path's owning session (`electron/main.ts:2568-2575`) | T1.10 sends to the caller. `planFileOpen`'s `activate` for a focused MCP open is unchanged here; the split-partner rule is Part B's session-explicit entry (Out of scope) |

## Global constraints

- **Gates and cadence:**
  - Per task: the named vitest file(s), red then green: `npx vitest run <file>`.
  - Per slice: the slice's Check, which ends in `npm run verify:quick` (Biome on changed files,
    both tsconfigs, `vitest --changed`).
  - **Once, after S3:** `npm run verify` (full gate), then `npm run e2e:remote -- conduit-mcp-policy
    conduit-mcp-policy-migrate conduit-mcp-control conduit-mcp-control-terminal`, then
    `npm run e2e:remote` (`--affected`). E2e scenario code is written during the slices and run
    only then.
  - Locally, run at most one e2e by exact name (`npm run e2e -- conduit-mcp-policy`), never a fan-out.
  - Never narrow, skip or disable a check. Never pipe verify output through `tail`. Capture exit
    codes directly.
- **Fallow:** `npm run fallow:check` (in `verify`) fails on unused exports. Every export in Contracts names its caller; tests are fallow entries. Remove an export rather than keep one with no caller.
- **CI is ubuntu.** Unit tests never depend on win32 paths, `\`, drive letters or
  `process.platform`; control-tools tests keep their POSIX fakes.
- **Comments explain WHY only.** Where the why is in a spec, a one-line pointer
  (`// spec 2026-10-30-conduit-mcp-tool-policy §2.4`). No `as any`, `@ts-ignore`, `!important`,
  swallowed errors, magic offsets, or specificity escalation.
- **Naming:**
  - Files kebab-case, named for their role; tests at `test/unit/<module>.test.ts[x]`.
  - React component tests start with `// @vitest-environment jsdom` and follow
    `test/unit/mcp-tools-dialog.test.tsx` (act + createRoot + `vi.mock('../../webview/bridge')`).
  - Exported constants `SCREAMING_SNAKE`, types `PascalCase`, functions `camelCase`. MCP wire
    fields `snake_case`; host↔renderer message fields `camelCase` (existing).
- **Node-free modules** (`src/conduit-mcp/tool-policy.ts`, `handles.ts`, `ask-broker.ts`,
  `types.ts`, `ui-types.ts`, `src/window-presence.ts`) import no `node:*` module.
- **Trust boundaries:** the renderer is never load-bearing. Every `mcp:setToolPolicy` and
  `mcp:askAnswer` field is re-validated host-side; settings and sessions are coerced on load.
- **Renderer rules (CLAUDE.md):** the card never takes DOM focus on arrival; it sits below the top
  bar, not over it; Monaco cascade rule: new class names are namespaced (`askcard`, `policyrow`,
  `policycli`), never bare generic names (`test/unit/monaco-class-collision.test.ts` guards).
- **E2E:** launch only via `launchElectron`/`runScenario`, exit only via `finishScenario`; hidden,
  serial; terminal writes through the harness `typeLine`/`writeToTerminal`.
- **Strings:** all UI copy in `MCP_STR` (`webview/conduit-mcp-strings.ts`); per-tool summary
  templates, never concatenated fragments; tool names and handles literal.
- **User-facing changes:** a `CHANGELOG.md` entry (T3.5), naming the `open_file` widening, the new
  asks, and the downgrade loss.

## Out of scope

- Part B: the seven new tools, `mcp:ui`, `reach` enforcement (`out_of_reach`) and its e2e,
  `move_not_allowed`, the session-explicit renderer entries (split-partner rule, `planFileOpen`
  never activating), ref classification, `normalizeUrl` move.
- F6 pane cycling; an ask countdown; an approvals history list; a per-project layer (spec v1).
- The global `rendererReady` latch for cold OS opens (`electron/main.ts:1195`): it stays as is.
- Progress notifications, elicitation, tool annotations, restrict-only locks, URL/path allowlists.
- Writing larger per-CLI MCP timeouts into installed configs.

## Contracts

### `src/conduit-mcp/types.ts` — T1.1

`ToolErrorCode` gains `'window_not_ready' | 'caller_not_visible' | 'denied' | 'approval_timeout' |
'cancelled'`. `RETRYABLE` gains `'window_not_ready'` only.

### `src/conduit-mcp/tool-policy.ts` (new, node-free; replaces `tool-switches.ts`) — T1.1

```ts
import { type ToolError, toolError } from './types';

export const MESSAGING_TOOL_NAMES = ['list_sessions', 'send_message', 'read_inbox', 'read_attachment'] as const;
export const SESSION_TOOL_NAMES = ['open_session', 'open_terminal'] as const;
export const EDITOR_TOOL_NAMES = ['open_file'] as const;
export const TOOL_NAMES = [...MESSAGING_TOOL_NAMES, ...SESSION_TOOL_NAMES, ...EDITOR_TOOL_NAMES] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolGroup = 'messaging' | 'sessions' | 'editor';
/** Settings and dialog order (spec §8). */
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
export interface ToolPolicy { access: Access; when?: When; reach?: Reach; move?: Move }
export type PolicyLayer = Partial<Record<ToolName, Partial<ToolPolicy>>>;
export type GlobalPolicy = Record<ToolName, ToolPolicy>;
export const CLI_KINDS = ['claude', 'codex', 'cursor', 'opencode', 'agent'] as const;
export type CliKind = (typeof CLI_KINDS)[number];
export type CliPolicyLayers = Partial<Record<CliKind, PolicyLayer>>;
export type PolicySource = 'session' | 'cli' | 'global';
export interface PolicyLayers { session?: PolicyLayer; cli?: PolicyLayer; global: GlobalPolicy }
export interface ResolvedPolicy {
  policy: ToolPolicy;
  /** One entry per applicable field. */
  source: Partial<Record<PolicyField, PolicySource>>;
}
/** Per field; 'inherit' deletes that field from the layer. */
export interface ToolPolicyPatch {
  access?: Access | 'inherit';
  when?: When | 'inherit';
  reach?: Reach | 'inherit';
  move?: Move | 'inherit';
}

export type RateBudget = 'act' | 'show';
export interface ToolSpec {
  /** Applicable fields, 'access' first. */
  fields: readonly PolicyField[];
  /** Offered access values: messaging tools have no 'ask' (spec §3.2). */
  access: readonly Access[];
  /** Offered reach values when 'reach' applies (Part B rows). */
  reach?: readonly Reach[];
  /** null: messaging, not rate-budgeted here. */
  budget: RateBudget | null;
  defaults: ToolPolicy;
}
/**
 * list_sessions/send_message/read_inbox/read_attachment: fields ['access'], access ['off','on'],
 *   budget null, defaults {access:'on'}.
 * open_session:  fields ['access','when','move'], access all three, budget 'act',
 *   defaults {access:'ask', when:'viewing', move:'yes'}.
 * open_terminal: same fields/budget, defaults {access:'off', when:'viewing', move:'yes'}.
 * open_file:     fields ['access','when'], budget 'show', defaults {access:'on', when:'viewing'}.
 */
export const TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>>;
export const DEFAULT_TOOL_POLICY: Readonly<GlobalPolicy>; // TOOL_SPECS[t].defaults per tool

export function isToolName(v: unknown): v is ToolName;
export function isMessagingTool(t: ToolName): boolean;
/** v is offered for that tool's field (TOOL_SPECS.access / reach / the field's value list). */
export function isValidField(tool: ToolName, field: PolicyField, v: unknown): boolean;

/**
 * Complete global layer. When `v` is a record it wins and `legacy` is ignored; per tool, valid
 * applicable fields overlay the defaults. Otherwise, a v0.50 `mcpTools` record migrates:
 * `true` → {access:'on', when:'always'} (when only if applicable) over the defaults; anything
 * else → the defaults. Never throws.
 */
export function coerceGlobalPolicy(v: unknown, legacy?: unknown): GlobalPolicy;
/** Known tools, applicable fields, valid values only; empty tool entries dropped; undefined when empty. */
export function coercePolicyLayer(v: unknown): PolicyLayer | undefined;
/** Known CLI kinds only, each through coercePolicyLayer; undefined when empty. */
export function coerceCliLayers(v: unknown): CliPolicyLayers | undefined;
/** v0.50 `Session.mcpToolOverrides`: true → {access:'on', when:'always'}; false → {access:'off'}. */
export function migrateToolOverrides(v: unknown): PolicyLayer | undefined;
/** Per applicable field: first valid value in session, cli, global. Total; never throws. */
export function resolvePolicy(tool: ToolName, layers: PolicyLayers): ResolvedPolicy;
/** Immutable. A field 'inherit' deletes it; an emptied tool entry is dropped; undefined when empty. */
export function withPolicyPatch(layer: PolicyLayer | undefined, tool: ToolName, patch: ToolPolicyPatch): PolicyLayer | undefined;
/** IPC trust boundary: null when any key is not an applicable field, any value is invalid, or it is empty. */
export function coercePolicyPatch(tool: ToolName, v: unknown): ToolPolicyPatch | null;

/** Spec §3.3 steps 1–5; null ⇒ proceed. Steps 4–5 only for non-messaging tools; the thunks run lazily. */
export function gateToolCall(i: {
  sessionId: string | null;
  messagingOn: boolean;
  tool: ToolName;
  policy: ToolPolicy;
  ownerReady: () => boolean;
  onScreen: () => boolean;
}): ToolError | null;
```

Gate messages (reveal nothing about targets):
- `not_in_session`: `'this MCP connection is not a Conduit session'`;
- `messaging_off`: `'Conduit messaging is turned off'`;
- `tool_disabled`: `` `${tool} is not enabled for this session` `` (unchanged, no "how to enable");
- `window_not_ready`: `"this session's Conduit window isn't ready; try again shortly"`;
- `caller_not_visible`: `` `${tool} only runs while your session is on screen` ``.

### `src/conduit-mcp/handles.ts` — T1.2

```ts
import type { CliKind } from './tool-policy';
/** The prefix before the last '-'; claude|codex|cursor|opencode map to themselves, anything else (fake, agent, malformed) to 'agent'. */
export function cliKindOfHandle(handle: Handle): CliKind;
```

### `src/conduit-mcp/ui-types.ts` — T1.7

```ts
export type AskAnswer = 'approve' | 'deny' | 'always';
export type AskClosedOutcome = 'expired' | 'cancelled';
/** Placeholder values for the card's per-tool summary template (MCP_STR.ask.summary). */
export type AskSummary =
  | { tool: 'open_session'; path: string; agent: string; focus: boolean }
  | { tool: 'open_terminal'; path: string; command: string; focus: boolean }
  | { tool: 'open_file'; path: string; line: number | null };
// McpUiState gains:
  /** Caller session ids with at least one waiting ask (spec §2.4 caller side). */
  awaitingApproval: string[];
```

### `src/conduit-mcp/ask-broker.ts` (new, node-free) — T1.3

```ts
import type { JsonRpcId } from './json-rpc';
import type { CliKind, ToolName } from './tool-policy';
import type { AskAnswer } from './ui-types';

/** Below each CLI's documented MCP call timeout (spec §5, research 2026-10-30). */
export const ASK_TIMEOUT_MS: Readonly<Record<CliKind, number>> =
  { claude: 120_000, codex: 50_000, cursor: 50_000, opencode: 25_000, agent: 25_000 };
export const MAX_ASKS_PER_CALLER = 3;

export interface AskKey { connId: number; requestId: JsonRpcId }
export interface PendingAsk {
  askId: string;
  callerSessionId: string;
  tool: ToolName;
  key: AskKey;
  /** The window the card was sent to. */
  windowId: number;
  openedAt: number;
}
export type AskEnd =
  | { kind: 'answered'; answer: AskAnswer }
  | { kind: 'expired' }
  /** reply false: the CLI cancelled or its connection closed, so nothing is sent back. */
  | { kind: 'cancelled'; reply: boolean };
export interface AskBrokerDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Once per ask that ends without an answer; the host tells the window to drop the card. */
  onUnanswered(ask: PendingAsk, end: Exclude<AskEnd, { kind: 'answered' }>): void;
}
export interface AskBroker {
  waitingFor(callerSessionId: string): number;
  /** Precondition: waitingFor(caller) < MAX_ASKS_PER_CALLER (the host checks in the same turn). */
  open(ask: Omit<PendingAsk, 'openedAt'>, timeoutMs: number): Promise<AskEnd>;
  /** false when the ask is unknown or already ended (late answers are ignored). */
  answer(askId: string, answer: AskAnswer): boolean;
  /** Ends every matching ask as cancelled; returns how many. */
  cancel(match: (a: PendingAsk) => boolean, reply: boolean): number;
  pending(): readonly PendingAsk[];
  /** Cancels everything with reply false (host stop). */
  dispose(): void;
}
export function createAskBroker(deps: AskBrokerDeps): AskBroker;
```

`JsonRpcId` is already exported from `src/conduit-mcp/json-rpc.ts:10` (node-free).

### `src/window-presence.ts` (new, node-free) — T1.4

```ts
export interface WindowPresence {
  /** Main-frame navigation began: not ready, no visible report. */
  startLoading(windowId: number): void;
  markReady(windowId: number): void;
  setVisible(windowId: number, ids: readonly string[]): void;
  drop(windowId: number): void;
  isReady(windowId: number): boolean;
  /** Fail-closed: ready AND reported since the last startLoading AND id in that report. */
  isOnScreen(windowId: number, sessionId: string): boolean;
}
export function createWindowPresence(): WindowPresence;
```

A window never seen is not ready. A `visible` report that arrives before `ready` counts once
`ready` lands (the renderer's effects can post in either order).

### `src/settings.ts` — T1.5

```ts
// AppSettings: mcpTools removed; added
  mcpToolPolicy: GlobalPolicy;          // default { ...DEFAULT_TOOL_POLICY } (deep copy)
  mcpToolPolicyByCli: CliPolicyLayers;  // default {}
// coerceSettings:
  mcpToolPolicy: coerceGlobalPolicy(payload.mcpToolPolicy, payload.mcpTools),
  mcpToolPolicyByCli: coerceCliLayers(payload.mcpToolPolicyByCli) ?? {},
```

Old keys disappear on the next write because the serialized object is the coerced `AppSettings`.

### `src/types.ts`, `src/session-manager.ts`, `src/persistence.ts` — T1.5

```ts
// Session: mcpToolOverrides removed; added
  /** Session layer, per field; never copied by create/duplicate (spec §3.1). Persisted. */
  mcpToolPolicy?: PolicyLayer;
// SessionManager: setMcpToolOverride removed; added
  /** false for an unknown id; no emit when the tool's entry is unchanged. */
  setMcpToolPolicy(id: string, tool: ToolName, patch: ToolPolicyPatch): boolean;
// parseSessions: mcpToolPolicy = s.mcpToolPolicy !== undefined
//   ? coercePolicyLayer(s.mcpToolPolicy) : migrateToolOverrides(s.mcpToolOverrides);
//   both raw keys deleted before the spread.
```

### `src/conduit-mcp/json-rpc.ts` — T1.6

```ts
export interface ToolCallContext { requestId: JsonRpcId }
export interface McpServerCoreDeps {
  serverInfo: { name: 'conduit'; version: string };
  instructions: string;
  tools(): readonly ToolSchema[];
  /** null: the client cancelled this request; no reply is sent (MCP cancellation). */
  call(name: string, args: unknown, ctx: ToolCallContext): Promise<ToolCallResult | null>;
  /** notifications/cancelled with a string or number requestId; anything else is ignored. */
  cancelled(requestId: JsonRpcId): void;
}
```

`KNOWN_TOOLS` and the import come from `./tool-policy`. A `tools/call` whose id is `null`
(`replyId` null) still dispatches as today.

### `src/conduit-mcp/control-tools.ts` — T1.8

```ts
export const ACT_RATE_PER_CALLER = 10;   // was OPEN_RATE_PER_CALLER
export const ACT_RATE_GLOBAL = 20;       // was OPEN_RATE_GLOBAL
export const SHOW_RATE_PER_CALLER = 30;
export interface PreparedCall<T> {
  summary: AskSummary;
  /** Executes; refunds the rate token itself when the open fails (step 9). */
  run(): Promise<Result<T>>;
  /** Refunds the token for a refusal between prepare and run that isn't an ask outcome. Idempotent. */
  release(): void;
}
export interface ControlCallContext { move: Move | undefined }
export interface ControlHandlers {
  prepareOpenSession(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenSessionOutput>>>;
  prepareOpenTerminal(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenSessionOutput>>>;
  prepareOpenFile(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenFileOutput>>>;
}
```

- `prepare*`: parse (`invalid_args`) → reserve the tool's budget (`TOOL_SPECS[tool].budget`;
  `rate_limited`) → home (`not_in_session`) → resolve path → kind check → agent/command check.
  Any refusal after the reservation releases it. The returned `summary` carries the resolved
  absolute path.
- `move === 'no'` forces `focus: false` in the `McpOpenRequest` and in the summary.
- `ControlDeps`, `McpOpenRequest`, `McpOpenOutcome`, `McpFileRequest` are unchanged.

### `src/conduit-mcp/tool-schemas.ts` — T1.8

The `open_session` and `open_terminal` descriptions gain one sentence, verbatim:
`" focus:true (default) moves the human's view to it, which can end your on-screen access; when opening several, pass focus:false for all but the last."`

### `src/protocol.ts` — T1.7

```ts
// HostToWebview: mcp:toolOverrideResult removed; added
  | { type: 'mcp:ask'; askId: string; callerSessionId: string; callerHandle: Handle; tool: ToolName;
      summary: AskSummary; args: unknown; source: PolicySource }
  | { type: 'mcp:askClosed'; askId: string; outcome: AskClosedOutcome }
  | { type: 'mcp:toolPolicyResult'; requestId: number; ok: true }
  | { type: 'mcp:toolPolicyResult'; requestId: number; ok: false;
      error: 'unknown-session' | 'unknown-tool' | 'invalid-value' }
// WebviewToHost: mcp:setToolOverride removed; added (host re-validates every field)
  | { type: 'mcp:askAnswer'; askId: string; answer: AskAnswer }
  | { type: 'mcp:setToolPolicy'; requestId: number; sessionId: string; tool: string; patch: ToolPolicyPatch }
```

### `electron/conduit-mcp-host.ts` — T1.9

```ts
// ConduitMcpHostDeps: mcpTools() removed; mgr Pick swaps setMcpToolOverride → setMcpToolPolicy; added
  /** settings.mcpToolPolicy and settings.mcpToolPolicyByCli, read per call. */
  toolPolicy(): { global: GlobalPolicy; byCli: CliPolicyLayers };
  /** Sends to the session's owner window; the window id it went to, null when it has none. */
  sendToOwner(sessionId: string, msg: HostToWebview): number | null;
  /** The owner window posted `ready` since its last main-frame navigation. */
  ownerReady(sessionId: string): boolean;
  /** Fail-closed on-screen check (src/window-presence.ts). */
  isOnScreen(sessionId: string): boolean;
  /** Taskbar flash unless the owner window is focused (main gates it on settings.osAttention). */
  flashOwner(sessionId: string): void;
  // tests only
  newAskId?: () => string;                       // default randomBytes(12).toString('hex')
  setTimer?: (fn: () => void, ms: number) => unknown;   // default setTimeout
  clearTimer?: (h: unknown) => void;             // default clearTimeout
// ConduitMcpHost gains
  /** A window began a main-frame navigation or closed: its asks end `cancelled` (reply). Part B
   *  also fails its pending mcp:ui requests here. */
  onWindowReset(windowId: number): void;
// handleRenderer handles 'mcp:setToolPolicy' (replaces mcp:setToolOverride, same reply shape
// under mcp:toolPolicyResult) and 'mcp:askAnswer' (no reply).
```

Host-internal (not exported): `layersOf(sessionId, handle): PolicyLayers`;
`callTool(sessionId, name, args, ctx: ToolCallContext & { connId: number }):
Promise<ToolCallResult | null>`; `recheckAsks()` (cancels, reply true, every waiting ask whose
re-resolved `access` is `'off'`, and all of them when the master is off); `inflight` /
`cancelledEarly` sets keyed `` `${connId}:${typeof requestId}:${requestId}` ``.

### `electron/main.ts` — T1.10

```ts
// module scope
function sendToOwner(sessionId: string, msg: HostToWebview): number | null; // returns the window id, null when none
// createWindow opts gain
  onNavigationStart: (windowId: number) => void;
```

### Renderer — T1.11–T1.13, T2.1–T2.5

```ts
// webview/components/tool-policy-editor.tsx (T1.11)
export interface ToolPolicyEditorProps {
  /** The layer these controls write; 'global' offers no Inherit. */
  layer: PolicySource;
  /** The stack up to and including `layer` ('global': only global). */
  layers: PolicyLayers;
  /** Display name of a layer, for "On · from All CLIs". */
  sourceName(source: PolicySource): string;
  disabled: boolean;
  /** Tools whose last change failed to save; shows MCP_STR.tools.saveFailed under the row. */
  failed?: ReadonlySet<ToolName>;
  onChange(tool: ToolName, field: PolicyField, value: PolicyValue | 'inherit'): void;
}
export function ToolPolicyEditor(p: ToolPolicyEditorProps): JSX.Element;

// webview/components/mcp-tools-dialog.tsx (T1.12)
export interface McpToolsDialogProps {
  session: Session;
  global: GlobalPolicy;
  byCli: CliPolicyLayers;
  masterOn: boolean;
  connected: boolean;
  /** Resolves false when the host didn't persist it; the row then reverts. */
  onChange(tool: ToolName, patch: ToolPolicyPatch): Promise<boolean>;
  onRelaunch(): void;
  announce(text: string): void;
  onClose(): void;
}

// webview/use-conduit-mcp.ts (T1.12): setToolOverride removed; ConduitMcpApi gains
  setToolPolicy(sessionId: string, tool: ToolName, patch: ToolPolicyPatch): Promise<boolean>;

// webview/mcp-ask-store.ts (T2.1)
export interface PendingAskView {
  askId: string; callerSessionId: string; callerHandle: Handle; tool: ToolName;
  summary: AskSummary; args: unknown; source: PolicySource;
}
export function getAsksSnapshot(): readonly PendingAskView[];        // oldest first
export function subscribeAsks(cb: () => void): () => void;
export function useAsks(): readonly PendingAskView[];
/** Posts mcp:askAnswer and drops the ask locally. */
export function answerAsk(askId: string, answer: AskAnswer): void;
export function requestAskFocus(): void;
export function subscribeAskFocus(cb: () => void): () => void;

// webview/components/approval-card.tsx (T2.2)
export interface ApprovalCardProps { announce(text: string): void }
export function ApprovalCard(p: ApprovalCardProps): JSX.Element | null;

// src/attention.ts (T2.3)
export interface AttentionAsk { askId: string; callerSessionId: string; callerHandle: Handle }
// AttentionEntry.kind: 'session' | 'message' | 'ask'
export function attentionEntries<T extends SessionStateFields & { id: string }>(
  sessions: readonly T[], items: readonly McpAttentionItem[], snoozed: SnoozeMap, now: number,
  asks?: readonly AttentionAsk[],   // default []; entries first, key `ask:${askId}`
): AttentionEntry[];

// webview/components/top-bar.tsx (T2.3): props gain
  asks?: readonly AttentionAsk[];
  onFocusAsk?: () => void;
// webview/components/sidebar.tsx + session-card.tsx (T2.4): props gain (optional)
  awaitingApproval?: ReadonlySet<string>;   // sidebar
  awaitingApproval?: boolean;               // session card
  onFocusAsk?: () => void;                  // both
```

`MCP_STR` keys (exact copy):

```ts
// T1.1 — errors (satisfies Record<ToolErrorCode, string>)
window_not_ready: 'Conduit’s window isn’t ready yet',
caller_not_visible: 'that tool only works while the session is on screen',
denied: 'you declined the request',
approval_timeout: 'the request timed out waiting for you',
cancelled: 'the request was cancelled',

// T1.11 — MCP_STR.tools (groupMessaging, groupControl, inherit(on), on, off removed; their only
// readers are the dialog, the settings rows and settings-mcp-tools.test.tsx, all rewritten in S1)
group: { messaging: 'Messaging', sessions: 'Sessions', editor: 'Editor & views' } satisfies Record<ToolGroup, string>,
// description: the six other entries keep their current text; only open_terminal changes:
description: { /* list_sessions … open_file unchanged */ open_terminal: 'Lets an agent run any program as you, outside its own sandbox.' } satisfies Record<ToolName, string>,
accessLabel: (tool: string) => `${tool} access`,
fieldAria: (tool: string, field: string) => `${tool} ${field}`,
access: { off: 'Off', ask: 'Ask', on: 'On' } satisfies Record<Access, string>,
when: { viewing: 'While on screen', always: 'Always' } satisfies Record<When, string>,
reach: { self: 'Itself', opened: 'Sessions it opened', window: 'Its window', any: 'Any session' } satisfies Record<Reach, string>,
move: { yes: 'May switch your view', no: 'Never switch your view' } satisfies Record<Move, string>,
fieldLabel: { when: 'When', reach: 'Reach', move: 'Move' } satisfies Record<Exclude<PolicyField, 'access'>, string>,
conditions: 'Conditions',
inherited: (value: string, from: string) => `Inherit (${value} · from ${from})`,
layerName: { global: 'All CLIs', session: 'this session' },
cliName: { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', agent: 'Other' } satisfies Record<CliKind, string>,
defaultsFor: 'Defaults for',
cliLayerNote: 'A session follows the CLI that connected first in it. A convenience, not a security boundary.',
onWarning: { open_terminal: 'Runs without asking. Codex never asks on its own.' } as Partial<Record<ToolName, string>>,
// kept: overrideNote, masterOffHint, menuItem, dialogTitle, relaunchHint, relaunch, saveFailed, announce, openedBy

// T2.1 — MCP_STR.ask
region: 'Agent request',
title: (handle: string, tool: string) => `${handle} requests ${tool}`,
summary: {
  open_session: (s) => `Open a ${s.agent} session in ${s.path}${s.focus ? '' : ', in the background'}`,
  open_terminal: (s) => `Run ${s.command} in ${s.path}${s.focus ? '' : ', in the background'}`,
  open_file: (s) => `Open ${s.path}${s.line === null ? '' : ` at line ${s.line}`}`,
} satisfies { [K in AskSummary['tool']]: (s: Extract<AskSummary, { tool: K }>) => string },
reason: { session: 'Ask: set for this session', global: 'Ask: the default for all CLIs', cli: (cli: string) => `Ask: set for ${cli}` },
rawArgs: 'Arguments', approve: 'Approve', deny: 'Deny', always: 'Always for this session',
pager: (i: number, n: number) => `${i} of ${n}`, prev: 'Previous request', next: 'Next request',
expired: (handle: string) => `Request from ${handle} expired`,
cancelled: (handle: string) => `Request from ${handle} was cancelled`,
waiting: 'Waiting for your approval',
chipReason: (handle: string) => `${handle} is waiting for your approval`,
```

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| `settings.mcpToolPolicy` / `mcpToolPolicyByCli` | Settings editor (T1.13) → `updateSettings` → `coerceSettings` (T1.5) | host resolve + list + `recheckAsks` (T1.9) via main's `toolPolicy` dep (T1.10); dialog inherited labels (T1.12); renderer settings hydrate (`webview/settings.tsx`, whole object, unchanged) | Both |
| v0.50 `settings.mcpTools` | v0.50 files only (no producer remains) | `coerceGlobalPolicy(…, payload.mcpTools)` (T1.5) | Consumer only: the producer is a released version |
| `Session.mcpToolPolicy` | dialog → `mcp:setToolPolicy` → host → `mgr.setMcpToolPolicy` (T1.12, T1.9, T1.5); "Always" answer (T1.9); `parseSessions` migration (T1.5) | host resolve (T1.9), dialog (T1.12), persistence (T1.5), e2e helpers (T3.1) | Both. Never produced by `create`/`duplicate` (T1.5 test) |
| v0.50 `Session.mcpToolOverrides` | v0.50 `sessions.json` only | `migrateToolOverrides` in `parseSessions` (T1.5) | Consumer only (released producer) |
| CLI kind | handle prefix from `claimHandle` (unchanged, `electron/conduit-mcp-host.ts:610-651, :770`) | `cliKindOfHandle` (T1.2) → host layers + ask timeout (T1.9), dialog layer (T1.12), card reason (T2.2) | Consumer side; the producer is unchanged on purpose (spec §2.1) |
| Window readiness + visible set | main: navigation start, `ready`, `visible`, closed (T1.10) → presence (T1.4) | `ownerReady` / `isOnScreen` (T1.9 gate) | Both. `activity.setVisible`, `gitDemand.setVisible`, `repoTrackerHost.windowShown` keep their own semantics (unchanged lines in the same `case`) |
| Window reset | main navigation start / closed (T1.10) | `host.onWindowReset` → broker cancel (T1.9); renderer store resets with the reload (T2.1) | Both |
| `tools/call` request id; `null` = no reply | core (T1.6) ↔ host `callTool` (T1.9) | — | Both |
| `notifications/cancelled` | the CLI | core `cancelled` (T1.6) → host → broker / early-cancel set (T1.9) | Consumer; the CLI is outside our control |
| `tools/list` = resolved `access ≠ off`; `list_changed` | host (T1.9) | each CLI | Producer only, as in v0.50; the call-time gate is the guard |
| `mcp:ask` / `mcp:askClosed` | host (T1.9) | ask store (T2.1) → card (T2.2), chip (T2.3, via app T2.5) | Both. Between S1 and S2 the renderer has no subscriber: `subscribe` callbacks switch on `type`, so the message is ignored (measured: `webview/use-conduit-mcp.ts:39`) |
| `mcp:askAnswer` | card → `answerAsk` (T2.2, T2.1) | main case (T1.10) → host → broker (T1.9) | Both |
| `McpUiState.awaitingApproval` | host `uiState()` (T1.9) | sidebar → session card badge (T2.4, wired T2.5) | Both |
| `mcp:setToolPolicy` / `mcp:toolPolicyResult` | `useConduitMcp().setToolPolicy` (T1.12) | main case (T1.10) → host (T1.9) | Both. Mocks of `ConduitMcpApi` in `test/unit/message-compose.test.tsx:51`, `test/unit/messages-pane.test.tsx:125`, `test/unit/right-pane-review-kebab.test.ts:105` rename to `setToolPolicy` (T1.12) |
| `open_file` target session | `openMcpFile` → caller (T1.10) | renderer `openFileInEditor` handler + `planFileOpen` (unchanged) | Producer only: the handler already takes any `sessionId` it owns |
| `focus` under `move:'no'` | `control-tools` prepare (T1.8) | `createMcpSession` → `openRepo` `mcp.focus` (unchanged) | Producer only: the consumer already honours `focus:false` |
| Rate budgets | `control-tools` (T1.8) | `control-tools` | Both (one module) |
| `ToolErrorCode` additions | `types.ts` (T1.1) | `MCP_STR.errors` `satisfies` map (T1.1); host results (T1.9) | Both |
| Attention chip entries | `attentionEntries` (T2.3) | top-bar chip (T2.3) | Both. The only other caller, `test/unit/attention.test.ts`, keeps working via the defaulted parameter |
| Taskbar flash | host `flashOwner` (T1.9) | main → `BrowserWindow.flashFrame` (T1.10); cleared by the existing `focus` handler (`electron/main.ts:1098-1101`) | Both |
| Claude allowlist | `src/mcp-launch.ts:36` from `MESSAGING_TOOL_NAMES` | Claude CLI | Import path only (T1.6); behaviour unchanged |
| `tool-switches.ts` removal | T1.14 | every importer: `json-rpc.ts`, `mcp-launch.ts`, `persistence.ts`, `session-manager.ts`, `settings.ts`, `types.ts`, `conduit-mcp-host.ts`, `settings-modal.tsx`, `mcp-tools-dialog.tsx`, `conduit-mcp-strings.ts`, `use-conduit-mcp.ts`, and tests `conduit-mcp-host`, `conduit-mcp-json-rpc`, `coerce-settings`, `mcp-tools-dialog`, `settings-mcp-tools`, `conduit-mcp-tool-switches` | All moved in S1 before T1.14 deletes it (T1.14 greps to prove zero importers) |

Messaging-only e2e scenarios (`conduit-mcp-gate`, `conduit-mcp-refusals`, `-compose`, `-notify`,
`-restart`) call only messaging tools (grep: no control tool names), whose defaults stay `on` with
no `when`: unaffected.

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/conduit-mcp/tool-policy.ts` | create | Catalog, policy types, coercion, migration, resolution, patching, gate steps 1–5 |
| `src/conduit-mcp/ask-broker.ts` | create | Pending asks: timeouts, per-caller cap, answer/cancel, one end per ask |
| `src/window-presence.ts` | create | Per-window readiness and visible set, fail-closed |
| `webview/components/tool-policy-editor.tsx` | create | Shared per-tool policy rows for any layer |
| `webview/mcp-ask-store.ts` | create | Renderer store of this window's waiting asks; answer; focus requests |
| `webview/components/approval-card.tsx` | create | The non-modal approval card with pager |
| `test/e2e/conduit-mcp-policy.e2e.mjs` | create | off/ask/on, Always, viewing refusal, move:no, cancel by CLI, cancel on reload |
| `test/e2e/conduit-mcp-policy-migrate.e2e.mjs` | create | v0.50 settings migrate and old keys vanish on write |
| `test/unit/conduit-mcp-tool-policy.test.ts`, `test/unit/conduit-mcp-ask-broker.test.ts`, `test/unit/window-presence.test.ts`, `test/unit/tool-policy-editor.test.tsx`, `test/unit/mcp-ask-store.test.ts`, `test/unit/approval-card.test.tsx`, `test/unit/session-card-ask.test.tsx` | create | Unit tests |
| `src/conduit-mcp/tool-switches.ts`, `test/unit/conduit-mcp-tool-switches.test.ts` | delete | Superseded by `tool-policy.ts` |
| `src/conduit-mcp/types.ts` | modify | Five `ToolErrorCode`s; `RETRYABLE` |
| `src/conduit-mcp/handles.ts` | modify | `cliKindOfHandle` |
| `src/conduit-mcp/ui-types.ts` | modify | `AskAnswer`, `AskClosedOutcome`, `AskSummary`, `awaitingApproval` |
| `src/conduit-mcp/json-rpc.ts` | modify | Request-id context, `cancelled`, null = no reply, catalog import |
| `src/conduit-mcp/control-tools.ts` | modify | prepare/run split, two budgets, `move` |
| `src/conduit-mcp/tool-schemas.ts` | modify | focus sentence in two descriptions |
| `src/mcp-launch.ts` | modify | Import from `tool-policy` |
| `src/settings.ts` | modify | `mcpToolPolicy`, `mcpToolPolicyByCli`, migration |
| `src/types.ts` | modify | `Session.mcpToolPolicy` |
| `src/session-manager.ts` | modify | `setMcpToolPolicy` |
| `src/persistence.ts` | modify | Coerce/migrate the session layer |
| `src/protocol.ts` | modify | Ask and policy messages |
| `src/attention.ts` | modify | Ask entries in the chip |
| `electron/conduit-mcp-host.ts` | modify | Policy gate, ask flow, cancels, `onWindowReset`, policy IPC, `awaitingApproval` |
| `electron/main.ts` | modify | Presence wiring, new deps, message cases, `open_file` to caller, `sendToOwner` return |
| `webview/conduit-mcp-strings.ts` | modify | Error strings (T1.1); tools block (T1.11); ask block (T2.1) |
| `webview/components/mcp-tools-dialog.tsx` | modify | Session layer through the shared editor |
| `webview/components/settings-modal.tsx` | modify | Global + CLI-layer editor replaces the switch rows |
| `webview/use-conduit-mcp.ts` | modify | `setToolPolicy` |
| `webview/components/top-bar.tsx` | modify | Chip counts and focuses asks |
| `webview/components/sidebar.tsx`, `webview/components/session-card.tsx` | modify | "Waiting for your approval" button |
| `webview/app.tsx` | modify | Dialog props (T1.12); card mount, chip/sidebar wiring (T2.5) |
| `webview/styles.css` | modify | Editor rows (T1.11); `--layer-ask`, card, badge (T2.2) |
| `test/e2e/fixtures/fake-mcp-agent.mjs` | modify | `cancel` command; `CALL` record with the request id |
| `test/e2e/conduit-mcp-helpers.mjs` | modify | Policy helpers, dialog selector, non-blocking call |
| `test/e2e/conduit-mcp-control.e2e.mjs`, `test/e2e/conduit-mcp-control-terminal.e2e.mjs` | modify | New defaults and visibility |
| Existing tests: `test/unit/conduit-mcp-host.test.ts`, `conduit-mcp-json-rpc.test.ts`, `conduit-mcp-control-tools.test.ts`, `conduit-mcp-handles.test.ts`, `coerce-settings.test.ts`, `persistence.test.ts`, `session-manager.test.ts`, `mcp-tools-dialog.test.tsx`, `settings-mcp-tools.test.tsx`, `attention.test.ts`, `message-compose.test.tsx`, `messages-pane.test.tsx`, `right-pane-review-kebab.test.ts` | modify | Follow the changed contracts + new cases |
| `docs/specs/2026-10-30-conduit-mcp-tool-policy.md` | modify (done in planning) | §2.4, §5, §13 D3 match the locked timeout/cancel decisions |
| `CHANGELOG.md` | modify | Unreleased entry |

## Scripts

None. The only repeated edit is the `setToolOverride` → `setToolPolicy` rename in three test
mocks (T1.12), below the threshold for a script. No fixtures are generated.

## Slices

Order: **S0 → S1 → S2 → S3**. S1 is one slice because removing `mcpTools` /
`mcpToolOverrides` / `tool-switches.ts` breaks every consumer at once, and `verify:quick` type-checks
both tsconfigs: the smallest type-clean state after the cutover includes the host, main and the
two editors. Its tasks are still ~10 minutes each and file-disjoint inside each group.

**Shared-file serialization (exclusive claims):**
- `src/conduit-mcp/types.ts`: T1.1.
- `webview/conduit-mcp-strings.ts`: T1.1 (errors) → T1.11 (tools) → T2.1 (ask). Sequential.
- `src/settings.ts`, `src/types.ts`: T1.5.
- `src/protocol.ts`, `src/conduit-mcp/ui-types.ts`: T1.7.
- `electron/conduit-mcp-host.ts`, `test/unit/conduit-mcp-host.test.ts`: T0.1 (test only) → T1.9.
- `electron/main.ts`: T1.10.
- `webview/app.tsx`: T1.12 → T2.5.
- `webview/styles.css`: T1.11 → T2.2.
- `test/e2e/conduit-mcp-helpers.mjs`, `test/e2e/fixtures/fake-mcp-agent.mjs`: T3.1.
- `CHANGELOG.md`: T3.5.

---

### Slice 0: Pin A7 (list_sessions omits handle-less sessions)

**Check:** `npx vitest run test/unit/conduit-mcp-host.test.ts -t "list_sessions omits a session that has no handle"` is green, then `npm run verify:quick`.

**Parallel groups:** G1: T0.1
**Claims:** `test/unit/conduit-mcp-host.test.ts`

#### Task 0.1: A7 host test

**Files:** Test `test/unit/conduit-mcp-host.test.ts` (new `it` beside the listing tests near `:1388`).

**Interfaces:** Consumes the existing harness (`harness(opts)` at `:146`), `callTool` over a
connection, and `Session.mcpHandle`.

**Steps:**
- [ ] Test 'list_sessions omits a session that has no handle': two sessions with adapters, one
  with `mcpHandle: 'fake-1'` and live, one with no `mcpHandle`; the first calls `list_sessions`.
  Key assertion: the returned `sessions` has no entry whose `session_id` is the handle-less id,
  and `sessions.length === 1` (itself).
- [ ] Measurement carve-out: this pins current behaviour, so it is expected to pass first run.
  If it fails, stop and report: A7 is then false and Part B's spec changes.
- [ ] Record the result in the Part B hand-off line of the run report (one line: "A7: handle-less
  sessions are not listed").

---

### Slice 1: Policy cutover — model, presence, broker, host, main, editors

**Check:**
- `npx vitest run test/unit/conduit-mcp-tool-policy.test.ts test/unit/conduit-mcp-handles.test.ts test/unit/conduit-mcp-ask-broker.test.ts test/unit/window-presence.test.ts test/unit/coerce-settings.test.ts test/unit/persistence.test.ts test/unit/session-manager.test.ts test/unit/conduit-mcp-json-rpc.test.ts test/unit/mcp-launch.test.ts test/unit/conduit-mcp-control-tools.test.ts test/unit/conduit-mcp-host.test.ts test/unit/tool-policy-editor.test.tsx test/unit/mcp-tools-dialog.test.tsx test/unit/settings-mcp-tools.test.tsx test/unit/message-compose.test.tsx test/unit/messages-pane.test.tsx test/unit/right-pane-review-kebab.test.ts test/unit/monaco-class-collision.test.ts` is green;
- `git grep -n "tool-switches\|mcpToolOverrides\|setToolOverride\|mcpTools\b" -- src electron webview test` prints nothing except the migration reads in `src/settings.ts`, `src/persistence.ts` and their tests;
- `npm run verify:quick` is green.

**Parallel groups:** Serial first: T1.1 · then G1: T1.2 · G2: T1.3 · G3: T1.4 · G4: T1.5 · G5: T1.6 · G6: T1.7 · then G7: T1.8 · G8: T1.11 · then G9: T1.9 → T1.10 · G10: T1.12 · G11: T1.13 · Serial last: T1.14
**Claims (serial lane):** `src/conduit-mcp/types.ts`, `webview/conduit-mcp-strings.ts` (T1.1, T1.11); `src/settings.ts`, `src/types.ts` (T1.5); `src/protocol.ts`, `src/conduit-mcp/ui-types.ts` (T1.7); `electron/conduit-mcp-host.ts`, `test/unit/conduit-mcp-host.test.ts` (T1.9); `electron/main.ts` (T1.10); `webview/app.tsx` (T1.12); `webview/styles.css` (T1.11)

Typecheck is expected red between T1.1 and T1.14 (consumers of removed fields); every task's own
vitest file is green on its own (vitest strips types). The slice is only judged at its Check.

#### Task 1.1: `tool-policy.ts` + error codes

**Files:**
- Create `src/conduit-mcp/tool-policy.ts`.
- Modify `src/conduit-mcp/types.ts` (`ToolErrorCode` `:10-34`, `RETRYABLE` `:42`).
- Modify `webview/conduit-mcp-strings.ts` (the `satisfies Record<ToolErrorCode, string>` map, `~:190`).
- Test: create `test/unit/conduit-mcp-tool-policy.test.ts`.

**Interfaces:**
- Produces the whole `tool-policy.ts` block, the five `ToolErrorCode`s and their strings (Contracts).
- Consumes `toolError(code: ToolErrorCode, message: string): ToolError` (`src/conduit-mcp/types.ts`).

**Steps:**
- [ ] Failing tests:
  - 'defaults match spec §3.2' — `DEFAULT_TOOL_POLICY.open_session` equals `{access:'ask', when:'viewing', move:'yes'}`, `.open_terminal.access === 'off'`, `.open_file` equals `{access:'on', when:'viewing'}`, `.send_message` equals `{access:'on'}`;
  - 'messaging tools are never ask' — `isValidField('read_inbox', 'access', 'ask') === false`, and `coercePolicyLayer({read_inbox: {access: 'ask'}})` is `undefined`;
  - 'resolve per field, most specific wins, with sources' — global `open_session` default, cli `{open_session: {when: 'always'}}`, session `{open_session: {access: 'on'}}` → `policy` equals `{access:'on', when:'always', move:'yes'}` and `source` equals `{access:'session', when:'cli', move:'global'}`;
  - 'an invalid value falls through to the next layer' — session `{open_file: {access: 'maybe'}}` (bypassing coercion) resolves `access` from global with source `'global'`;
  - 'a non-applicable field is dropped and never resolved' — `coercePolicyLayer({open_file: {move: 'no'}})` is `undefined`; `resolvePolicy('open_file', …).policy` has no `move` key;
  - 'coerceGlobalPolicy migrates v0.50 mcpTools' — `coerceGlobalPolicy(undefined, {...allFalse, open_session: true, send_message: true})`: `open_session` equals `{access:'on', when:'always', move:'yes'}`, `send_message` equals `{access:'on'}`, `open_file` equals the default `{access:'on', when:'viewing'}`, `open_terminal.access === 'off'`;
  - 'coerceGlobalPolicy ignores legacy when the new key is a record' — `coerceGlobalPolicy({open_file: {access: 'off'}}, {open_session: true}).open_session.access === 'ask'` and `.open_file.access === 'off'`;
  - 'migrateToolOverrides' — `{open_session: true, send_message: false, bogus: true}` → `{open_session: {access:'on', when:'always'}, send_message: {access:'off'}}`; `{}` and `'x'` → `undefined`;
  - 'withPolicyPatch' — sets a field; `{when:'inherit'}` deletes it; emptied tool dropped; all empty → `undefined`; input object unchanged (`Object.isFrozen` deep-frozen input does not throw);
  - 'coercePolicyPatch rejects at the boundary' — `('open_file', {move:'no'})`, `('open_file', {access:'yes'})`, `('open_file', {})`, `('open_file', 'inherit')` → `null`; `('open_session', {when:'inherit', access:'on'})` → that object;
  - 'gate order' — table: `sessionId:null` → `not_in_session`; `messagingOn:false` → `messaging_off`; `access:'off'` → `tool_disabled` (message contains the tool, not "Settings"); `ownerReady:()=>false` → `window_not_ready`; `when:'viewing'` + `onScreen:()=>false` → `caller_not_visible`; `when:'always'` + offscreen → `null`; messaging tool with both thunks throwing → `null` (thunks not called);
  - 'coercion never throws' — each coerce function on `null`, `[]`, `1`, `'x'`, `{open_file: null}`, `{open_file: []}` returns without throwing.
- [ ] Run `npx vitest run test/unit/conduit-mcp-tool-policy.test.ts` — FAIL (module missing).
- [ ] Implement; add the five codes and copy (Contracts). `tool-switches.ts` stays until T1.14.

#### Task 1.2: `cliKindOfHandle`

**Files:** Modify `src/conduit-mcp/handles.ts`. Test `test/unit/conduit-mcp-handles.test.ts`.

**Interfaces:**
- Produces `cliKindOfHandle(handle: Handle): CliKind`.
- Consumes `type CliKind` from `src/conduit-mcp/tool-policy.ts` (T1.1).

**Steps:**
- [ ] Failing test 'cliKindOfHandle maps the prefix' — `claude-1`→`claude`, `codex-12`→`codex`, `cursor-3`→`cursor`, `opencode-2`→`opencode`, `fake-1`→`agent`, `agent-4`→`agent`, `nodash`→`agent`, `''`→`agent`, `claude-x-1`→`agent`.
- [ ] Run — FAIL (export missing). Implement with `lastIndexOf('-')` and a lookup.

#### Task 1.3: `ask-broker.ts`

**Files:** Create `src/conduit-mcp/ask-broker.ts`. Test `test/unit/conduit-mcp-ask-broker.test.ts`.

**Interfaces:**
- Produces the `ask-broker.ts` block in Contracts.
- Consumes `JsonRpcId` (`src/conduit-mcp/json-rpc.ts:10`), `CliKind`, `ToolName` (T1.1), and
  `AskAnswer` from `src/conduit-mcp/ui-types.ts` (T1.7; a type import, erased for vitest).

**Steps:**
- [ ] Failing tests (fake timers via injected `setTimer`/`clearTimer`):
  - 'ASK_TIMEOUT_MS table' — exact values per kind;
  - 'answer ends once' — `open` then `answer(id,'approve') === true` resolves `{kind:'answered', answer:'approve'}`; a second `answer` returns `false`;
  - 'timeout expires and calls onUnanswered' — fire the timer: resolves `{kind:'expired'}`, `onUnanswered` called once, a later `answer` returns `false`;
  - 'cancel by predicate carries reply' — two asks on conn 1, one on conn 2; `cancel(a => a.key.connId === 1, false) === 2`; both resolve `{kind:'cancelled', reply:false}`; their timers cleared; the conn-2 ask still pending;
  - 'waitingFor counts per caller' and drops after an end;
  - 'dispose ends all with reply false'.
- [ ] Run — FAIL. Implement.

#### Task 1.4: `window-presence.ts`

**Files:** Create `src/window-presence.ts`. Test `test/unit/window-presence.test.ts`.

**Interfaces:** Produces the `window-presence.ts` block in Contracts. Consumes nothing.

**Steps:**
- [ ] Failing tests:
  - 'an unknown window is neither ready nor showing anything';
  - 'ready + visible → on screen; an unreported id → false';
  - 'visible before ready counts once ready lands';
  - 'startLoading clears both' — after `startLoading(1)`, `isReady(1) === false` and `isOnScreen(1,'a') === false` even though `a` was reported before;
  - 'windows are independent' — window 2's report never makes a session on screen in window 1;
  - 'drop forgets the window'.
- [ ] Run — FAIL. Implement.

#### Task 1.5: Settings, session field, manager, persistence

**Files:**
- Modify `src/settings.ts` (imports `:2-6`, `AppSettings` `:189-190`, `DEFAULT_SETTINGS` `:255`, `coerceSettings` `:540`).
- Modify `src/types.ts` (import `:1`, `Session.mcpToolOverrides` `:119-120`).
- Modify `src/session-manager.ts` (import `:3`, `setMcpToolOverride` `:330-340`).
- Modify `src/persistence.ts` (import `:1`, `parseSessions` `:98-107`).
- Tests: `test/unit/coerce-settings.test.ts` (replace the `mcpTools` block `:472-497`), `test/unit/persistence.test.ts` (`:386-443`), `test/unit/session-manager.test.ts` (`:614-646`).

**Interfaces:**
- Produces `AppSettings.mcpToolPolicy: GlobalPolicy`, `AppSettings.mcpToolPolicyByCli: CliPolicyLayers`, `Session.mcpToolPolicy?: PolicyLayer`, `SessionManager.setMcpToolPolicy(id: string, tool: ToolName, patch: ToolPolicyPatch): boolean`.
- Consumes from T1.1: `GlobalPolicy`, `CliPolicyLayers`, `PolicyLayer`, `ToolName`, `ToolPolicyPatch`, `DEFAULT_TOOL_POLICY`, `coerceGlobalPolicy(v: unknown, legacy?: unknown): GlobalPolicy`, `coerceCliLayers(v: unknown): CliPolicyLayers | undefined`, `coercePolicyLayer(v: unknown): PolicyLayer | undefined`, `migrateToolOverrides(v: unknown): PolicyLayer | undefined`, `withPolicyPatch(layer, tool, patch): PolicyLayer | undefined`.

**Call sites:** `setMcpToolOverride` is called only by the host (`electron/conduit-mcp-host.ts:1343-1356`, moved in T1.9) and the host test harness (`test/unit/conduit-mcp-host.test.ts:229-231`, T1.9). `settings.mcpTools` readers: `electron/main.ts:1954` (T1.10), `webview/components/settings-modal.tsx:891-895` (T1.13), `webview/app.tsx:4804` (T1.12).

**Steps:**
- [ ] Failing tests:
  - coerce-settings: 'mcpToolPolicy absent → defaults; byCli absent → {}'; 'v0.50 mcpTools with open_session true → {access:on, when:always, move:yes}'; 'serialize after coerce has no mcpTools key' (`JSON.parse(serializeSettings(coerceSettings({mcpTools:{open_session:true}}))).settings` has no `mcpTools` and has `mcpToolPolicy`); 'byCli keeps known kinds only' (`{codex: {open_file: {access:'off'}}, bogus: {...}}` → `{codex: {open_file: {access:'off'}}}`); 'round-trip keeps a CLI layer'.
  - persistence: 'parseSessions keeps a valid mcpToolPolicy'; 'migrates v0.50 mcpToolOverrides' (`{open_session: true, send_message: false}` → `{open_session:{access:'on', when:'always'}, send_message:{access:'off'}}`, and `'mcpToolOverrides' in s === false`); 'malformed policy dropped without dropping the session'.
  - session-manager: 'create and duplicate never carry mcpToolPolicy'; 'setMcpToolPolicy sets, inherit deletes, unknown id → false, no emit when unchanged'.
- [ ] Run the three files — FAIL. Implement.

#### Task 1.6: JSON-RPC context, cancel, no-reply; launch import

**Files:** Modify `src/conduit-mcp/json-rpc.ts` (`:1`, deps `:24-30`, dispatch `:80-106`), `src/mcp-launch.ts` (`:4`). Tests `test/unit/conduit-mcp-json-rpc.test.ts` (`:13`, deps `:18-33`), `test/unit/mcp-launch.test.ts` (unchanged expectations).

**Interfaces:**
- Produces `ToolCallContext`, the new `McpServerCoreDeps.call` and `cancelled` (Contracts).
- Consumes `TOOL_NAMES`, `MESSAGING_TOOL_NAMES` from `src/conduit-mcp/tool-policy.ts` (T1.1).

**Call sites:** `createMcpServerCore` is called only at `electron/conduit-mcp-host.ts:798` (T1.9) and in `test/unit/conduit-mcp-json-rpc.test.ts`.

**Steps:**
- [ ] Failing tests:
  - 'tools/call passes the request id' — `call` spy receives `{requestId: 7}` for `id: 7` and `{requestId: 'a'}` for `id: 'a'`;
  - 'a null call result sends no reply' — `handleLine(tools/call)` resolves `undefined`;
  - 'notifications/cancelled reaches cancelled()' — `{method:'notifications/cancelled', params:{requestId: 7}}` → `cancelled(7)`, `handleLine` resolves `undefined`; with `requestId: {}` or no params → not called;
  - 'other notifications are still dropped' — `notifications/initialized` calls neither dep.
- [ ] Run — FAIL. Implement.

#### Task 1.7: Wire types

**Files:** Modify `src/conduit-mcp/ui-types.ts` (`McpUiState` `:44-59`), `src/protocol.ts` (`mcp:toolOverrideResult` `:566-572`, `mcp:setToolOverride` `:1074-1080`).

**Interfaces:**
- Produces `AskAnswer`, `AskClosedOutcome`, `AskSummary`, `McpUiState.awaitingApproval`, and the
  four protocol variants (Contracts).
- Consumes `ToolName`, `PolicySource`, `ToolPolicyPatch` (T1.1); `Handle` (`src/conduit-mcp/types.ts`).

**Steps:**
- [ ] Type-only carve-out: no runtime behaviour. The red step is
  `npx tsc -p tsconfig.json --noEmit` reporting the now-missing `mcp:setToolOverride` /
  `mcp:toolOverrideResult` at their consumers (host, main, use-conduit-mcp) — those are fixed by
  T1.9, T1.10, T1.12. Record the error list in the task report.
- [ ] Edit the types exactly as Contracts.

#### Task 1.8: Control tools — prepare/run, budgets, move; descriptions

**Files:** Modify `src/conduit-mcp/control-tools.ts` (whole public surface `:8-63`, `reserve` `:169-188`, `open` `:216-275`, handlers `:277-318`), `src/conduit-mcp/tool-schemas.ts` (`open_session` `:99-100`, `open_terminal` `:114-115` descriptions). Test `test/unit/conduit-mcp-control-tools.test.ts` (rewrite call shapes; `:8-9` imports).

**Interfaces:**
- Produces the `control-tools.ts` block in Contracts.
- Consumes `TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>>` and `type Move` (T1.1);
  `type AskSummary` (T1.7); existing `Caller`, `Result`, `toolError`.

**Call sites:** `createControlHandlers(...)` at `electron/conduit-mcp-host.ts:645`; its handlers are
called only from `runTool` (`:760-764`). Both move in T1.9.

**Steps:**
- [ ] Failing tests (existing ones re-expressed as `prepare` then `run`):
  - 'prepare resolves and summarises' — `prepareOpenSession(caller, {path:'w', agent:'a'}, {move:'yes'})` → `summary` equals `{tool:'open_session', path:'/home/c/w', agent:'a', focus:true}`;
  - 'move no forces focus false' — for `open_session` and `open_terminal`, `deps.openSession` receives `focus:false` with `focus:true` in args, and the summary has `focus:false`;
  - 'act budget' — 10 successful runs by one caller then the 11th prepare → `rate_limited`; 20 across callers → global limit;
  - 'show budget' — 30 `open_file` runs by one caller, 31st → `rate_limited`; act budget untouched;
  - 'a refusal after the reservation refunds' — `path_missing` 15 times does not exhaust the budget;
  - 'run failure refunds; success keeps' — `brief_unavailable` refunds;
  - 'release is idempotent and only after prepare' — calling `release()` twice frees one slot.
- [ ] Run — FAIL. Implement; add the description sentence (Contracts) verbatim.

#### Task 1.9: Host cutover

**Files:** Modify `electron/conduit-mcp-host.ts` (imports `:48-57`; deps `:100,116-117` + new deps; interface `:148-172`; `listedTools` `:698-702`; `callTool` `:704-746`; `runTool` `:747-765`; `onConnection` core `:798-807`; `conn.onClose` `:842-859`; `uiState` `:904-938`; `refresh` `~:1263`; `onSessionDeleted`; `stop`; renderer handler `:1343-1356`). Test `test/unit/conduit-mcp-host.test.ts` (harness `:146-235`; listing/override tests `:1381-1548`; open_session test `:1551`).

**Interfaces:**
- Produces the `electron/conduit-mcp-host.ts` block in Contracts.
- Consumes:
  - T1.1: `TOOL_NAMES`, `isToolName`, `isMessagingTool`, `resolvePolicy(tool, layers): ResolvedPolicy`, `gateToolCall(i): ToolError | null`, `coercePolicyPatch(tool, v): ToolPolicyPatch | null`, types `GlobalPolicy`, `CliPolicyLayers`, `PolicyLayers`, `ToolName`;
  - T1.2: `cliKindOfHandle(handle): CliKind`;
  - T1.3: `createAskBroker(deps): AskBroker`, `ASK_TIMEOUT_MS`, `MAX_ASKS_PER_CALLER`, `PendingAsk`, `AskEnd`;
  - T1.5: `SessionManager.setMcpToolPolicy(id, tool, patch): boolean`, `Session.mcpToolPolicy`;
  - T1.6: `McpServerCoreDeps.call(name, args, ctx: {requestId}): Promise<ToolCallResult | null>`, `cancelled(requestId)`;
  - T1.7: protocol variants, `AskSummary`, `McpUiState.awaitingApproval`;
  - T1.8: `ControlHandlers.prepareOpenSession/prepareOpenTerminal/prepareOpenFile(caller, args, {move}): Promise<Result<PreparedCall<…>>>`.

**Call sites:** `createConduitMcpHost` at `electron/main.ts:1937` (T1.10). `ConduitMcpHost.onWindowReset` is new (first caller T1.10).

**Steps:**
- [ ] Harness: replace `mcpTools` with `toolPolicy?: () => {global, byCli}` (default
  `{global: DEFAULT_TOOL_POLICY, byCli: {}}`); `setMcpToolOverride` fake → `setMcpToolPolicy`
  via `withPolicyPatch`; add `sendToOwner` (records `[sessionId, msg]`, returns `1`),
  `ownerReady`/`isOnScreen` (default `() => true`, overridable), `flashOwner` (records),
  `newAskId` (counter), `setTimer`/`clearTimer` (manual queue). Existing control tests set the
  session policy `{access:'on'}` where they set an override `true` before.
- [ ] Failing tests:
  - 'gate precedence' — with access off and the window not ready → `tool_disabled`; access on, `ownerReady:false` → `window_not_ready`; `isOnScreen:false` + `when:viewing` → `caller_not_visible` and **no** `sendToOwner` call and no `control` dep call;
  - 'tools/list is resolved access ≠ off; master off lists all' — defaults list `open_session` (ask) and `open_file`, not `open_terminal`;
  - 'session layer beats the CLI layer' (spec Gherkin 2 on `open_file`) — byCli `{agent: {open_file: {access:'off'}}}` hides it for `fake-1`; session `{open_file: {access:'on'}}` lists it again;
  - 'ask: card to the owner, approve runs once' — `open_session` default: one `mcp:ask` with `tool`, `callerHandle`, `summary.path`, `source:'global'`; `flashOwner` called; before answering `control.openSession` not called and `uiState().awaitingApproval` contains the caller; `handleRenderer({type:'mcp:askAnswer', askId, answer:'approve'})` → result ok, `openSession` called once, `awaitingApproval` empty;
  - 'ask: deny → denied; token kept' — 10 denied asks then the 11th call → `rate_limited`;
  - 'ask: always writes the session layer and runs' — `sessions.get(id).mcpToolPolicy.open_session.access === 'on'`, result ok, next call sends no `mcp:ask`;
  - 'ask: expiry' — fire the timer: result `approval_timeout`; one `mcp:askClosed{outcome:'expired'}`; a later answer changes nothing;
  - 'ask: notifications/cancelled → no reply' — the connection receives no line for that id; `mcp:askClosed{outcome:'cancelled'}` sent; control not called;
  - 'ask: a cancel before the ask opens is remembered' — `kindOf` held on a promise; send the cancel; release it: no `mcp:ask`, no reply, budget refunded;
  - 'ask: connection close cancels without reply'; 'onWindowReset(1) → cancelled reply'; 'onSessionDeleted(caller) → cancelled reply';
  - 'ask: a 4th waiting ask → rate_limited, no card';
  - 'ask: refresh() after access becomes off cancels the waiting ask (cancelled reply)'; 'master off cancels all';
  - 'ask: a waiting ask does not block another call on the same connection' — `list_sessions` answers while the ask waits;
  - 'mcp:setToolPolicy replies unknown-session / unknown-tool / invalid-value / ok' — `patch:{move:'no'}` for `open_file` → `invalid-value`; ok → `mcpToolPolicy` updated and `list_changed` sent when the list changed.
- [ ] Run `npx vitest run test/unit/conduit-mcp-host.test.ts` — FAIL.
- [ ] Implement per the Data flow. `runTool` keeps messaging unchanged; control tools go
  prepare → (ask) → run. Log line per call adds `access` and, for asks, `askEnd`.

#### Task 1.10: Main wiring

**Files:** Modify `electron/main.ts`:
- `sendToOwner` `:994-996` returns `number | null`;
- `createWindow` opts `:1026-1031` + listener near `:1150`: `w.webContents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) opts.onNavigationStart(w.id); })`;
- a module-or-closure `presence = createWindowPresence()` reachable from `spawnWindow` (`:5099-5125`) and `handle()`;
- `spawnWindow` passes `onNavigationStart: (id) => { presence.startLoading(id); mcpHost.onWindowReset(id); }`; `onClosed` adds `presence.drop(windowId); mcpHost.onWindowReset(windowId);`;
- `case 'ready'` `:2872` adds `presence.markReady(senderId)`; `case 'visible'` `:3827` adds `presence.setVisible(senderId, m.ids)`;
- host deps `:1937-1984`: `toolPolicy: () => ({ global: settings.mcpToolPolicy, byCli: settings.mcpToolPolicyByCli })` replaces `mcpTools`; `sendToOwner`; `ownerReady: (id) => { const w = sessionOwner.get(id); return w !== undefined && windows.has(w) && presence.isReady(w); }`; `isOnScreen: (id) => { const w = sessionOwner.get(id); return w !== undefined && presence.isOnScreen(w, id); }`; `flashOwner: (id) => { const w = windowFor(id); if (w && settings.osAttention && !w.isFocused()) w.flashFrame(true); }`;
- `openMcpFile` `:2568-2575`: `const sessionId = req.callerSessionId;` (drop `resolveOwningSession` here; remove the import if now unused);
- the `mcp:*` case list `:4519-4525`: `mcp:setToolOverride` → `mcp:setToolPolicy`, add `mcp:askAnswer`.

**Interfaces:**
- Consumes `createWindowPresence(): WindowPresence` (T1.4); `ConduitMcpHost.onWindowReset(windowId: number): void` and the new deps (T1.9); `AppSettings.mcpToolPolicy` / `mcpToolPolicyByCli` (T1.5).

**Call sites:** `sendToOwner` existing callers (`:1198`, `:1203`, and others found by `git grep -n "sendToOwner(" electron/main.ts`) ignore the return value; unchanged. `createWindow` is called only by `spawnWindow`.

**Steps:**
- [ ] Wiring carve-out: main has no unit harness; the proof is `npx tsc -p tsconfig.json --noEmit`
  clean for `electron/main.ts` plus the S3 e2e (`conduit-mcp-policy` phases "viewing refusal" and
  "reload cancels"). The red step: tsc errors at `:1954` (`mcpTools`) and the host deps before
  the edit.
- [ ] Implement exactly the bullets above; no other behaviour changes in main.

#### Task 1.11: Strings + shared editor

**Files:** Create `webview/components/tool-policy-editor.tsx`. Modify `webview/conduit-mcp-strings.ts` (tools block `:205-226`; import `:10`), `webview/styles.css` (append `.policyrow*`, `.policycli*` after the `.settools` rules). Test create `test/unit/tool-policy-editor.test.tsx`.

**Interfaces:**
- Produces `ToolPolicyEditor` / `ToolPolicyEditorProps` (Contracts) and the `MCP_STR.tools` keys (Contracts).
- Consumes from T1.1: `TOOL_GROUPS`, `TOOL_SPECS`, `resolvePolicy`, and types `PolicyLayers`, `PolicySource`, `PolicyField`, `PolicyValue`, `ToolName`, `Access`, `When`, `Reach`, `Move`, `CliKind`, `ToolGroup`. Consumes `SegmentedRadios` (`webview/components/segmented-radios.tsx`, props `label`, `value`, `options`, `onChange`, `disabled`, `selectOnArrow`).

**Rendering rules:**
- Per `TOOL_GROUPS` group: `<div role="group" aria-labelledby>` with an `h4` from `MCP_STR.tools.group[group]`.
- Per tool row (`<section className="policyrow" data-tool={tool}>`): the name (`code`), description, an Access `SegmentedRadios` with `label={MCP_STR.tools.accessLabel(tool)}`, `selectOnArrow={false}`, options `TOOL_SPECS[tool].access` (plus `inherit` first, labelled `MCP_STR.tools.inherited(<value>, sourceName(<source>))`, unless `layer === 'global'`).
- The shown value is the layer's own field (`layers.global[tool][f]` for global; `layers[layer]?.[tool]?.[f] ?? 'inherit'` otherwise). The Inherit label's value/source come from `resolvePolicy(tool, <layers without the current layer>)`.
- Tools with fields beyond access get a `button.policyrow__cond` (`aria-expanded`, text `MCP_STR.tools.conditions`) toggling a panel of native `select`s, one per applicable non-access field, `aria-label={MCP_STR.tools.fieldAria(tool, field)}`, `data-field={field}`, options as for access (Inherit first unless global). A field not in `TOOL_SPECS[tool].fields` renders nothing.
- A `p.policyrow__warn` with `MCP_STR.tools.onWarning[tool]` when that string exists and the fully resolved access is `'on'`.
- `failed?.has(tool)` → `p.policyrow__error` with `MCP_STR.tools.saveFailed`.

**Steps:**
- [ ] Failing tests (jsdom):
  - 'global layer has no Inherit' — `[aria-label="open_session access"] [data-seg="inherit"]` absent;
  - 'session layer shows the inherited value and source' — layers `{cli: {open_file: {access:'off'}}, global: DEFAULT}`, `sourceName` mapping cli→'Codex': the inherit segment text is `Inherit (Off · from Codex)`;
  - 'conditions render only applicable fields' — expand `open_file`: one `select[data-field="when"]`, no `move`; messaging rows have no `.policyrow__cond`;
  - 'onChange reports tool, field, value' — clicking `[data-seg="ask"]` on `open_terminal` → `('open_terminal','access','ask')`; selecting Inherit in the `when` select → `('open_session','when','inherit')`;
  - 'open_terminal warning only when resolved on'.
- [ ] Run — FAIL. Implement; styles use existing tokens only (`.settools` spacing, `.seg` skin).

#### Task 1.12: Session dialog, hook, app mount, mocks

**Files:** Modify `webview/components/mcp-tools-dialog.tsx` (whole: props `:21-31`, state `:57-93`, render), `webview/use-conduit-mcp.ts` (`:2`, `:31`, `:93-100`), `webview/app.tsx` (dialog mount `:4797-4815` only), `test/unit/message-compose.test.tsx:51`, `test/unit/messages-pane.test.tsx:125`, `test/unit/right-pane-review-kebab.test.ts:105`. Test `test/unit/mcp-tools-dialog.test.tsx` (rewrite `:6-117`).

**Interfaces:**
- Produces `McpToolsDialogProps` and `ConduitMcpApi.setToolPolicy(sessionId: string, tool: ToolName, patch: ToolPolicyPatch): Promise<boolean>` (Contracts).
- Consumes `ToolPolicyEditor` (T1.11: `onChange(tool, field, value: PolicyValue | 'inherit')`); `coercePolicyPatch(tool, v): ToolPolicyPatch | null`, `withPolicyPatch(layer, tool, patch)`, `GlobalPolicy`, `CliPolicyLayers` (T1.1); `cliKindOfHandle(handle): CliKind` (T1.2); protocol `mcp:setToolPolicy` / `mcp:toolPolicyResult` (T1.7); `Session.mcpToolPolicy` (T1.5); `MCP_STR.tools.layerName`, `cliName` (T1.11).

**Steps:**
- [ ] Failing tests:
  - 'picking Ask posts setToolPolicy with a one-field patch' — `onChange` spy gets `('open_session', {access:'ask'})`;
  - 'a refused change reverts that tool only and shows saveFailed';
  - 'a late older pick cannot undo a newer one' (existing sequencing test, re-expressed);
  - 'inherit labels name the CLI from the handle' — session `mcpHandle: 'codex-2'`, byCli codex sets `open_file` off → inherit text contains `from Codex`; with no handle → `from All CLIs`.
- [ ] Run — FAIL. Implement: `layers = { session: shown, cli: kind ? byCli[kind] : undefined, global }`; `sourceName` session→`layerName.session`, cli→`cliName[kind]`, global→`layerName.global`; `onChange(tool, field, value)` builds `coercePolicyPatch(tool, { [field]: value })`, applies `withPolicyPatch` optimistically, reverts on `false`. App mount passes `global={settings.mcpToolPolicy}`, `byCli={settings.mcpToolPolicyByCli}`, `onChange={(tool, patch) => mcp.setToolPolicy(target.id, tool, patch)}`. Rename the three mocks.

#### Task 1.13: Settings MCP tab rows

**Files:** Modify `webview/components/settings-modal.tsx` (import `:3`; `TOOL_GROUPS` + `McpToolSwitchRows` `:855-905` → `McpToolPolicyRows`; McpTab use `:959-961`). Test `test/unit/settings-mcp-tools.test.tsx` (`:6-9`, `:90-118`).

**Interfaces:**
- Consumes `ToolPolicyEditor` (T1.11); `coerceGlobalPolicy`, `coercePolicyPatch`, `withPolicyPatch`, `CLI_KINDS`, `CliKind` (T1.1); `AppSettings.mcpToolPolicy` / `mcpToolPolicyByCli` (T1.5); `MCP_STR.tools.defaultsFor`, `cliName`, `layerName`, `cliLayerNote` (T1.11).

**Rendering rules:** a `div.policycli[role="tablist"][aria-label=MCP_STR.tools.defaultsFor]` of
buttons `role="tab"`, `data-cli="all"` then `CLI_KINDS` (labels `layerName.global`, `cliName[k]`),
ArrowLeft/Right move and select, local state default `'all'`. `'all'` → `layer:'global'`, writes
`update({ mcpToolPolicy: coerceGlobalPolicy({ ...g, [tool]: { ...g[tool], [field]: value } }) })`
(ignoring `'inherit'`). A CLI tab → `layer:'cli'`, writes
`update({ mcpToolPolicyByCli: <byCli with [kind] = withPolicyPatch(byCli[kind], tool, patch), key removed when undefined> })`
where `patch = coercePolicyPatch(tool, { [field]: value })` (skip when null). `cliLayerNote` shows
under the tablist on a CLI tab; `masterOffHint` and `disabled` when the master is off;
`overrideNote` stays.

**Steps:**
- [ ] Failing tests:
  - 'All CLIs: picking On for open_terminal posts updateSettings with mcpToolPolicy.open_terminal.access on' and other tools unchanged;
  - 'Codex tab: picking Off for open_file posts mcpToolPolicyByCli.codex.open_file.access off';
  - 'Codex tab: Inherit removes the field and drops an empty kind' — `mcpToolPolicyByCli` has no `codex` key;
  - 'master off disables every control'.
- [ ] Run — FAIL. Implement.

#### Task 1.14: Delete `tool-switches.ts`

**Files:** Delete `src/conduit-mcp/tool-switches.ts`, `test/unit/conduit-mcp-tool-switches.test.ts`.

**Steps:**
- [ ] `git grep -n "tool-switches" -- src electron webview test` prints nothing (every importer moved
  in T1.5–T1.13). If anything prints, stop: that importer's task is incomplete.
- [ ] Delete both files; run the slice Check.

---

### Slice 2: Ask UI — store, card, chip, badge

**Check:**
- `npx vitest run test/unit/mcp-ask-store.test.ts test/unit/approval-card.test.tsx test/unit/attention.test.ts test/unit/session-card-ask.test.tsx test/unit/toasts.test.ts test/unit/drag-region.test.ts test/unit/monaco-class-collision.test.ts` is green;
- `npm run verify:quick` is green.

**Parallel groups:** Serial first: T2.1 · then G1: T2.2 · G2: T2.3 · G3: T2.4 · Serial last: T2.5
**Claims (serial lane):** `webview/conduit-mcp-strings.ts` (T2.1); `webview/styles.css` (T2.2); `webview/app.tsx` (T2.5)

#### Task 2.1: Ask store + ask strings

**Files:** Create `webview/mcp-ask-store.ts`. Modify `webview/conduit-mcp-strings.ts` (add `ask` block, Contracts). Test create `test/unit/mcp-ask-store.test.ts`.

**Interfaces:**
- Produces the `mcp-ask-store.ts` block (Contracts) and `MCP_STR.ask`.
- Consumes `subscribe`, `post` (`webview/bridge.ts`); `pushToast({message, variant:'info'})` (`webview/toast-store.ts`); protocol `mcp:ask`, `mcp:askClosed`, `mcp:askAnswer` (T1.7).

**Steps:**
- [ ] Failing tests (mock `../../webview/bridge` capturing the subscriber and `post`):
  - 'mcp:ask appends oldest first';
  - 'answerAsk posts mcp:askAnswer and removes it';
  - 'askClosed expired removes and toasts "Request from fake-1 expired"'; 'cancelled toasts the cancelled copy';
  - 'askClosed for an unknown id is ignored' (no toast);
  - 'requestAskFocus notifies focus subscribers'.
- [ ] Run — FAIL. Implement as a module singleton (subscribe at load, `useSyncExternalStore` hook).

#### Task 2.2: Approval card + CSS

**Files:** Create `webview/components/approval-card.tsx`. Modify `webview/styles.css`: add `--layer-ask: 90;` to the `:root` layer tokens (`:277-280`, with the band comment updated: "asks above toasts, below popovers"), `.askcard*` rules, and `.session__ask` badge rule. Test create `test/unit/approval-card.test.tsx`.

**Interfaces:**
- Produces `ApprovalCard` / `ApprovalCardProps` (Contracts).
- Consumes `useAsks(): readonly PendingAskView[]`, `answerAsk(askId, answer)`, `subscribeAskFocus(cb)` (T2.1); `MCP_STR.ask` (T2.1); `cliKindOfHandle` (T1.2); `MCP_STR.tools.cliName` (T1.11).

**Rendering rules:**
- `createPortal` to `document.body`; null when there are no asks.
- `<section className="askcard" role="region" aria-label={MCP_STR.ask.region} tabIndex={-1}>`: title `MCP_STR.ask.title(handle, tool)`; summary `MCP_STR.ask.summary[tool](summary)`; reason line from `source` (`cli` → `reason.cli(cliName[cliKindOfHandle(handle)])`); `<details>` with `<summary>{rawArgs}</summary>` and `<pre className="askcard__args">{JSON.stringify(args, null, 2)}</pre>`; buttons `button[data-answer="deny"|"approve"|"always"]` in that order; a pager (`pager(i, n)`, prev/next buttons) only when n > 1. Shows the oldest ask by default; the shown index clamps when asks leave.
- Never focuses itself on arrival. On a focus request: remember `document.activeElement`, focus the region. Esc inside the card returns focus to the remembered element (or does nothing if none) without answering.
- New askIds (diffed against the previous render) call `announce(MCP_STR.ask.title(handle, tool))`.
- CSS: `position: fixed; top: calc(var(--density-topbar-h) + 8px); right: 16px; width: min(360px, calc(100vw - 32px)); z-index: var(--layer-ask);` raised surface + border tokens as `.toast`; `.askcard__args` monospace, `max-height` with `overflow: auto`, `overflow-wrap: anywhere` for paths; forced-colors uses system colours like `.toast`. `.session__ask` uses the accent `.attnchip__dot` uses, text label always present.

**Steps:**
- [ ] Failing tests (jsdom, store mocked):
  - 'renders title, summary and reason for a cli-sourced ask' — `fake-1 requests open_session`, `Ask: set for Other`;
  - 'does not take focus on arrival' — `document.activeElement` stays `document.body`;
  - 'Approve calls answerAsk(id, approve)'; same for Deny and Always;
  - 'pager shows 1 of 2 and next shows the second';
  - 'Esc returns focus without answering' — after a focus request and Esc, `answerAsk` not called and focus is back on the remembered element;
  - 'announces each new ask once'.
- [ ] Run — FAIL. Implement.

#### Task 2.3: Attention chip counts asks

**Files:** Modify `src/attention.ts` (`AttentionEntry` `:86-93`, `attentionEntries` `:100-130`), `webview/components/top-bar.tsx` (props near `:60-66`, `:77-90`). Test `test/unit/attention.test.ts`.

**Interfaces:**
- Produces `AttentionAsk`, the `'ask'` entry kind, the defaulted `asks` parameter, and top-bar props `asks?`, `onFocusAsk?` (Contracts).
- Consumes `MCP_STR.ask.chipReason(handle)` (T2.1).

**Call sites:** `attentionEntries` — `webview/components/top-bar.tsx:77` and `test/unit/attention.test.ts:148-170`.

**Steps:**
- [ ] Failing tests:
  - 'asks come first and are not snoozable' — one ask for a snoozed session + one session entry → keys `['ask:a1', 'session:s2']`;
  - 'chip label counts asks' — `attentionChipLabel(attentionEntries([], [], new Map(), NOW, [ask]).length) === '1 needs you'`.
- [ ] Run — FAIL. Implement; in top-bar the chip title for a first `ask` entry is `chipReason(handle)` and clicking it calls `onFocusAsk`.

#### Task 2.4: Session card "Waiting for your approval"

**Files:** Modify `webview/components/session-card.tsx` (props `~:84`; render beside the mcp badge `~:216-226`), `webview/components/sidebar.tsx` (props `:68,106`; pass-through `:415`). Test create `test/unit/session-card-ask.test.tsx`.

**Interfaces:**
- Produces the optional props (Contracts).
- Consumes `MCP_STR.ask.waiting` (T2.1).

**Rendering rule:** when `awaitingApproval && !editing`: `<button type="button" className="session__ask" onClick={(e) => { e.stopPropagation(); onFocusAsk?.(); }}>{MCP_STR.ask.waiting}</button>` (nested buttons are already the card's pattern, `:244-290`).

**Steps:**
- [ ] Failing tests: 'badge shows only while awaiting'; 'click calls onFocusAsk and does not select the session' (the row's `onSelect` spy not called).
- [ ] Run — FAIL. Implement; sidebar passes `awaitingApproval?.has(s.id)` and `onFocusAsk`.

#### Task 2.5: App wiring

**Files:** Modify `webview/app.tsx`: mount `<ApprovalCard announce={(t) => { if (navLiveRef.current) navLiveRef.current.textContent = t; }} />` just before `<Toasts />` (`:4821`); `TopBar` (`:4663-4675`) gets `asks={asks}` and `onFocusAsk={requestAskFocus}` with `const asks = useAsks();`; `Sidebar` (`:4518`) gets `awaitingApproval={awaiting}` with `const awaiting = useMemo(() => new Set(mcp.state?.awaitingApproval ?? []), [mcp.state])` and `onFocusAsk={requestAskFocus}`.

**Interfaces:** Consumes `ApprovalCard` (T2.2), `useAsks`, `requestAskFocus` (T2.1), the T2.3/T2.4 props, `McpUiState.awaitingApproval` (T1.7).

**Steps:**
- [ ] Wiring carve-out: proof is the slice Check (tsc + the component tests) and the S3 e2e
  phases "ask approve" and "card never steals focus".
- [ ] Implement exactly the three edits.

---

### Slice 3: E2E + changelog

**Check (end of feature, once):**
- `npm run verify` green;
- `npm run e2e:remote -- conduit-mcp-policy conduit-mcp-policy-migrate conduit-mcp-control conduit-mcp-control-terminal` green;
- `npm run e2e:remote` (`--affected`) green.
- During the slice, per task: `node --check <file>` for each `.mjs` touched, and `npm run verify:quick`.

**Parallel groups:** Serial first: T3.1 · then G1: T3.2 · G2: T3.3 · G3: T3.4 · G4: T3.5
**Claims (serial lane):** `test/e2e/conduit-mcp-helpers.mjs`, `test/e2e/fixtures/fake-mcp-agent.mjs` (T3.1); `CHANGELOG.md` (T3.5)

#### Task 3.1: Fake agent + helpers

**Files:** Modify `test/e2e/fixtures/fake-mcp-agent.mjs` (header comment `:12-19`; `rpc` `:66-73`; `submit` `:162-205`), `test/e2e/conduit-mcp-helpers.mjs` (`enableToolViaDialog` `:274-302`, new helpers).

**Interfaces (produced, used by T3.2–T3.4):**
```js
// fake: `call` records CALL {"seq","tool","id"} before awaiting; `cancel` sends
// notifications/cancelled {requestId: <last call id>, reason:'e2e'} and records CANCEL {"seq","id"}.
/** @param {'On'|'Off'|'Ask'|'Inherit'} value — clicks `[role="radiogroup"][aria-label="${tool} access"] [data-seg]` and waits for window.__sessions[].mcpToolPolicy?.[tool]?.access (null for Inherit). */
export async function enableToolViaDialog(page, sessionId, tool, value)
/** Posts mcp:setToolPolicy through the bridge and waits for the session to reflect `patch`. */
export async function setSessionPolicy(page, sessionId, tool, patch)
/** updateSettings with settings.mcpToolPolicy[tool] = policy (merged over the current), waits for the broadcast. */
export async function setGlobalPolicy(page, tool, policy)
/** Types `call …` without waiting; resolves the RESULT count before it. */
export async function startCall(page, sessionId, tool, args)
/** The first RESULT after `before`, or null after `ms`. */
export async function resultAfter(sessionId, before, ms)
/** Clicks `.askcard button[data-answer="<answer>"]`. */
export async function clickAskAnswer(page, answer)
```

**Steps:**
- [ ] Implement; `node --check` both files.

#### Task 3.2: Existing control scenarios on the new defaults

**Files:** Modify `test/e2e/conduit-mcp-control.e2e.mjs`, `test/e2e/conduit-mcp-control-terminal.e2e.mjs` (`:49`).

**Changes:**
- `conduit-mcp-control`: `enableToolViaDialog(page, main.sessionId, 'open_session', 'On')` stays
  (now access On). Before "focused open", click main's card and wait until it is active (callers
  must be on screen under the default `when:viewing`). Phase "disabled worker" (`:99-103`):
  first `enableToolViaDialog(page, worker.sessionId, 'open_session', 'Off')`, then expect
  `tool_disabled` (step 3 precedes the viewing check). Phase "open_file": drop the
  `enableToolViaDialog(…'open_file','On')` (default on) and keep main active; assert
  `f.session_id === main.sessionId`.
- `conduit-mcp-control-terminal`: after `enableToolViaDialog(…'open_terminal','On')`, add
  `setSessionPolicy(page, <caller>, 'open_terminal', { when: 'always' })` so Relaunch/Duplicate
  phases that move the view don't turn into visibility tests.

**Steps:** [ ] Edit; `node --check`.

#### Task 3.3: `conduit-mcp-policy` scenario

**Files:** Create `test/e2e/conduit-mcp-policy.e2e.mjs` (`runScenario('conduit-mcp-policy', …, { userDataDir: fakeAgentProfile('policy') })`; shape of `conduit-mcp-control.e2e.mjs`).

**Phases and key assertions (two fakes A and B; A active unless stated):**
1. **off** — `setGlobalPolicy(page, 'open_session', {access:'off'})`: A's `toolsSeen` drops `open_session` after `LIST_CHANGED`; `callTool(A,'open_session',…)` → `tool_disabled`.
2. **ask deny** — `setGlobalPolicy(…, {access:'ask', when:'viewing', move:'yes'})`; `startCall(A,'open_session',…)`; `.askcard` appears containing A's handle and `open_session`; `document.activeElement` is not inside `.askcard`; the attention chip text counts 1; `clickAskAnswer(page,'deny')` → RESULT `denied`; session count unchanged.
3. **ask approve** — same call, `clickAskAnswer(page,'approve')` → `session_id`; the new session exists.
4. **always** — re-click A active; call; `clickAskAnswer(page,'always')` → ok and A's `mcpToolPolicy.open_session.access === 'on'`; the next call shows no `.askcard` within 1 s and succeeds.
5. **viewing refusal** — click B active; `callTool(A,'open_file',{path:'fixture.txt'})` → `caller_not_visible`; after 1 s no `.tabbar [role="tab"]` with text `fixture.txt`, and active is still B.
6. **move:no** — click A active; `setSessionPolicy(page, A, 'open_session', {move:'no'})`; `callTool(A,'open_session',{…, focus:true})` → ok; after 1.5 s active is still A.
7. **CLI cancel** — `setSessionPolicy(page, A, 'open_session', {access:'ask'})`; `startCall`; wait for `.askcard`; type `cancel` into A; `.askcard` detaches within 5 s; `resultAfter(A, before, 2_000) === null`; no new session.
8. **reload cancels** — `startCall` again; wait for `.askcard`; `page.reload()`; re-run `tapMcp(page)` after `.session` cards return; RESULT `cancelled` within 10 s; no `.askcard` after reload.
9. **cleanup** — kill sessions, remove dirs (as `conduit-mcp-control`).

**Steps:** [ ] Write; `node --check`. Run happens at the end (Slice Check).

#### Task 3.4: `conduit-mcp-policy-migrate` scenario

**Files:** Create `test/e2e/conduit-mcp-policy-migrate.e2e.mjs`.

**Shape:** prepare `fakeAgentProfile('policy-migrate')`, then write `<userDataDir>/settings.json` =
`{"version":1,"settings":{"conduitMcp":true,"mcpTools":{"list_sessions":true,"send_message":true,"read_inbox":true,"read_attachment":true,"open_session":true,"open_terminal":false,"open_file":false}}}`
before `runScenario`.

**Phases and key assertions:**
1. Two fakes A and B; B active. `callTool(A,'open_session',…)` → ok (migrated `when:'always'`, A off screen) with no `.askcard`.
2. `callTool(A,'open_file',…)` → `caller_not_visible` (migrated `false` → default on/viewing).
3. `setMessaging(page, true)` (forces a settings write); read `settings.json`: `settings.mcpTools === undefined` and `settings.mcpToolPolicy.open_session` deep-equals `{access:'on', when:'always', move:'yes'}`.

**Steps:** [ ] Write; `node --check`.

#### Task 3.5: CHANGELOG

**Files:** Modify `CHANGELOG.md` (`## [Unreleased]`).

**Steps:** One entry under `### Changed` covering:
- tool switches became policies: Off · Ask · On per tool, plus when / move, for all CLIs, per CLI, and per session;
- **Ask** shows a card in the agent's window; Approve, Deny, or Always for this session; Codex can no longer run a tool Conduit asks about without you;
- new defaults: `open_file` is now **On** (was off), `open_session` is **Ask** (was off), and control tools act only while the agent's session is on screen unless set to Always;
- v0.50 settings migrate (enabled tools become On · Always); downgrading to v0.50 loses policies and returns to its defaults.

## Verification

- **Per task:** the named vitest file(s), red then green (`npx vitest run <file>`).
- **Per slice:** the slice's Check, ending in `npm run verify:quick`.
- **Once, after S3:** `npm run verify`; then `npm run e2e:remote -- conduit-mcp-policy
  conduit-mcp-policy-migrate conduit-mcp-control conduit-mcp-control-terminal`; then
  `npm run e2e:remote` (`--affected`). A local failure is confirmed remotely before bisecting.
- Locally at most one e2e by exact name. Never fan e2e out. Exit codes captured directly, never
  through a pipe or pager.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a
shim, second copy, special case, widened type, fallback, or an override patched in place of its
semantic source. The report leads with the fix that keeps the locked decision.

## Decisions Needed

- [normal] **N1:** `reach` has no Part A tool, so `out_of_reach` and the spec's "reach refusal" e2e
  can't be built here. Default taken: types, coercion and editor carry `reach`; enforcement and
  its e2e ship with Part B's first session-targeting tool.
- [normal] **N2:** A v0.50 **session** override `false` was always user-set (absent = inherit), so
  the spec's "false → the new default" reasoning (made for the settings file) doesn't apply to it.
  Default taken: it migrates to `{access:'off'}` (keeps the user's explicit off).
- [normal] **N3:** Card placement. "Stacked above toasts" taken as z-order (`--layer-ask: 90`). The
  card sits top-right below the top bar, not in the bottom-right toast corner, so it never covers
  toasts or the terminal's input row. Default taken: top-right.
- [normal] **N4:** `flashOwner` follows the user's existing **OS attention** setting
  (`settings.osAttention`), like every other taskbar flash. Default taken: gated on it.
- [normal] **N5:** Turning the master switch off cancels every waiting ask (`cancelled`), since
  every such call would be refused anyway. Spec names only `access → off`. Default taken: cancel.
- [normal] **N6:** A 4th waiting ask is refused `rate_limited` before any card, and its rate token
  is refunded (nothing was shown). Default taken: refund.
- [normal] **N7:** Readiness keys on main-frame cross-document `did-start-navigation`, not the
  literal `did-start-loading` (Spec staleness). Default taken: navigation.
- [normal] **N8:** No F6 pane cycling exists; the card is reachable from the chip and the session
  card button only. Default taken: no F6 in this feature.
- [normal] **N9:** For Part B (from S0): handle-less sessions are not in `list_sessions`, so
  app-control A7 resolves to "not targetable by id". Default taken: Part B's resolver accepts only
  listed sessions.

# Plan: Conduit MCP tool policies (Part A)

Spec: [2026-10-30-conduit-mcp-tool-policy.md](../specs/2026-10-30-conduit-mcp-tool-policy.md)
(FULL, reviewed twice). Sibling, built after this one:
[2026-10-30-conduit-mcp-app-control.md](../specs/2026-10-30-conduit-mcp-app-control.md) (Part B).

**Tier: FULL.** The feature replaces the v0.50 boolean switches with a three-layer policy model,
adds a per-window presence store, a node-free call pipeline with an ask step and an in-app
approval card, threads the JSON-RPC request id and `notifications/cancelled` through to the host,
and rewrites the Settings and session policy editors. It crosses `src/`, `electron/` and
`webview/`, and executors pick tasks up cold. Planned against `feat/mcp-policy` at `9c03366f`
(main `1b4d90f2` = v0.50.0 + the two specs). Every line number below was grepped at that HEAD;
re-grep before editing, since earlier tasks shift them.

Revised after the independent architecture review (r1); every r1 item was accepted by the
conductor and is folded into the tasks below, not appended.

## Goal

Every Conduit MCP tool call is allowed, asked or refused by one policy resolved field by field
(session > CLI kind > global), with `viewing` enforced against a fail-closed per-window presence
store, `ask` answered on a non-focus-stealing card in the caller's window, cancellations honoured
with no reply on every path, and the three existing control tools moved onto it. Part B then adds
seven tools on the same seams.

## Architecture

- **Pure cores (node-free, renderer-importable unless noted):**
  - `src/conduit-mcp/tool-policy.ts` replaces `src/conduit-mcp/tool-switches.ts`. It owns the tool
    catalog (names, groups, applicable fields, allowed values, defaults, rate budget), the policy
    types, coercion, v0.50 migration, `resolvePolicy`, patching, and the gate's steps 1–5.
  - `src/conduit-mcp/handles.ts` gains `cliKindOfHandle`, the only handle → CLI kind parser.
  - `src/conduit-mcp/window-waits.ts` is the generic lifecycle of "a call waiting on one window":
    per-wait timeout, answer bound to the window it was sent to, cancel by predicate with a reply
    flag, one end per wait. Asks are its first user; Part B's pending `mcp:ui` requests are a
    second instance of the same store, not a second ad-hoc map.
  - `src/conduit-mcp/call-flow.ts` is the call pipeline after the gate: in-flight registry keyed
    by `(connId, requestId)`, prepare → (ask) → run, the per-CLI ask timeouts, the 3-per-caller
    cap, cancellation on every path (no reply after `notifications/cancelled`), Always, and
    recheck after policy changes. The host only wires it.
  - `src/window-presence.ts` holds per-window readiness and the last visible report,
    fail-closed. It is separate from `session-activity` / `session-resource-demand`, whose
    fail-open semantics stay untouched.
- **Tool logic:** `src/conduit-mcp/control-tools.ts` splits each tool into **prepare** (parse →
  rate reservation → path/agent/command checks → an `AskSummary`) and **run** (the IO). Two
  budgets: act (`open_session`, `open_terminal`) and show (`open_file`).
- **Host:** `electron/conduit-mcp-host.ts` resolves the policy, runs the gate, starts in-flight
  tracking for every call, hands control tools to the call flow, and routes renderer messages
  with the **sender's window id** (`mcp:askAnswer` must come from the window that holds the card).
- **Main:** `electron/main.ts` owns the presence instance and feeds it (main-frame navigation
  start, `ready`, `visible`, renderer gone, window closed), supplies `ownerWindowOf`, passes the
  sender id to `handleRenderer`, tells the host when a session moves windows, and makes
  `open_file` open in the caller's session.
- **Renderer:** one shared policy editor (`webview/components/tool-policy-editor.tsx`) for the
  Settings MCP tab (global + CLI tablist) and the session dialog; an ask store
  (`webview/mcp-ask-store.ts`) and card (`webview/components/approval-card.tsx`); the chip counts
  asks; the caller's session card shows "Waiting for your approval".
- **Cutover is additive inside S1.** New fields, messages and methods land **beside** the old
  ones; consumers switch task by task with `tsc` green after each; T1.14 removes every old field,
  message, method and `tool-switches.ts` together.
- **Seams Part B extends (and nothing else):** `TOOL_NAMES` / `TOOL_SPECS` rows (with `reach`
  options); the `AskSummary` union; `PreparedCall<T>`; the host's prepare switch; `ToolErrorCode`;
  `MCP_STR.tools.description` / `MCP_STR.ask.summary`; a second `createWindowWaits` instance for
  `mcp:ui` (answered by `mcp:uiResult` through the same sender-id check, failed with
  `window_not_ready` from the call flow's `windowReset`); `ownerWindowOf` for reach `window`.
- **No sketches.** Every seam copies a sibling: the waits store copies the host's per-session
  runtime maps; the editor copies `SegmentedRadios` usage in the current dialog; the ask store
  copies the module-singleton subscription in `webview/use-conduit-mcp.ts:36-49`; the card
  portals to body like `webview/components/toasts.tsx`; the sender check copies
  `electron/main.ts:2948-2952` ("Only the window showing the session may act on it").

## Data flow

```
POLICY WRITES
 Settings editor (global | CLI tab) ─updateSettings{mcpToolPolicy | mcpToolPolicyByCli}─►
     main.ts updateSettings → coerceSettings (migrates v0.50 mcpTools) → persist → mcpHost.refresh()
       refresh(): syncToolLists() + flow.recheck() + broadcast
 Session dialog ─mcp:setToolPolicy{requestId,sessionId,tool,patch}─► host.handleRenderer(m, reply, senderId)
     coercePolicyPatch → mgr.setMcpToolPolicy → persist → reply mcp:toolPolicyResult → refresh()

PRESENCE (main owns `presence`)
 webContents 'did-start-navigation' (main frame, cross-document) ─► presence.startLoading(wid) + mcpHost.onWindowReset(wid)
 'render-process-gone'                                           ─► presence.startLoading(wid) + mcpHost.onWindowReset(wid)
 renderer 'ready'      ─► presence.markReady(senderId)
 renderer 'visible'    ─► presence.setVisible(senderId, ids)        (activity/gitDemand unchanged)
 window 'closed'       ─► presence.drop(wid) + mcpHost.onWindowReset(wid)
 moveSessionToWindow   ─► mcpHost.onSessionMoved(sessionId)

CALL  CLI ─tools/call{id}─► json-rpc core ─call(name,args,{requestId})─► host.callTool
   f = flow.begin({connId, requestId})              ← synchronous, before the first await
   layers = { session: Session.mcpToolPolicy, cli: byCli[cliKindOfHandle(handle)], global }
   gateToolCall: not_in_session → messaging_off → tool_disabled
                 → window_not_ready  (w = ownerWindowOf(sid); w !== null && presence.isReady(w))
                 → caller_not_visible (when:viewing && !presence.isOnScreen(w, sid))   [steps 1–5]
   messaging: store_unavailable → tools.*  → f.cancelled ? null : result
   control:   flow.runControl({ f, caller, tool, policy, source, args, prepare })
      prepare (parse, rate(6), checks(7)) → f.cancelled ? release, null
      'on'  → f.cancelled ? release, null : run() → f.cancelled ? null : result
      'ask' → [no await from here to open]
              waits.countFor(caller) ≥ 3 ⇒ release, rate_limited
              w = ownerWindowOf(caller); null ⇒ release, window_not_ready
              sendToOwner(caller, mcp:ask{askId,…}); waits.open({id:askId,…,windowId:w}, ASK_TIMEOUT_MS[kind])
              flashOwner(caller); onAwaitingChanged()
              ── await end ──
              approve ⇒ f.cancelled ? null (token kept) : run()
              always  ⇒ setSessionPolicy(caller,tool,{access:'on'}) false ⇒ cancelled (no run)
                        else onPolicyWritten(); f.cancelled ? null (token kept) : run()
              deny ⇒ denied | expired ⇒ approval_timeout   (token kept; askClosed sent)
              cancelled reply:true ⇒ cancelled | reply:false ⇒ null
      finally f.end()
   host: null ⇒ core sends nothing; else toToolCallResult
 CLI ─notifications/cancelled{requestId}─► core.cancelled ─► flow.cancelled(connId, requestId)
        marks the in-flight entry; ends its ask with reply:false
 conn close ─► flow.connectionClosed(connId)                 (reply:false)
 session deleted / moved, window reset ─► flow.sessionGone / sessionMoved / windowReset (reply:true)

ASK UI (owner window only)
 mcp:ask ─► mcp-ask-store (oldest first) ─► ApprovalCard (pager, never auto-focused) + chip entries
 card button ─► answerAsk ─► mcp:askAnswer ─► main (senderId) ─► host ─► flow.answer(askId, senderId, answer)
 mcp:askClosed{expired|cancelled} ─► store removes + info toast
 mcp:state.awaitingApproval (all windows) ─► sidebar ─► session card "Waiting for your approval"
```

## Settled decisions — do not re-litigate

From the spec, the conductor's Level-1 lock, research outcomes (`.autoloop/evidence/plan-inputs.md`)
and the accepted r1 critique:
- Policy fields `access` off/ask/on, `when` viewing/always, `reach` self/opened/window/any, `move`
  yes/no; applicability and defaults per spec §3.2. Resolution per field, most specific set value
  wins: session > CLI layer > global. The global layer is complete. No restrict-only locks.
- The CLI kind is the persisted handle's prefix; `fake` and unknown prefixes map to `agent`. A
  convenience, not a security boundary. `CliKind = Exclude<ClientKind, 'fake'>`.
- `tool-policy.ts` replaces `tool-switches.ts`. `window-presence.ts` is new and pure; existing
  activity/gitDemand sets are untouched.
- **r1 #5 (supersedes the Level-1 `ask-broker.ts`):** the pending lifecycle is the generic
  `window-waits.ts`; the pipeline is `call-flow.ts`; the host is wiring.
- **r1 #6 (supersedes the "sendToOwner returns the window id" refinement):** host deps are
  `ownerWindowOf(sessionId): number | null`, `presence: Pick<WindowPresence, 'isReady' |
  'isOnScreen'>`, `sendToOwner(sessionId, msg): void`, `flashOwner(sessionId): void`. "Owner
  ready" and "on screen" are derived from `ownerWindowOf` + `presence`.
- Ask details go to the owner window only; `McpUiState.awaitingApproval: string[]` is broadcast.
- JSON-RPC core: `call(name, args, { requestId })` with `requestId: JsonRpcId | null`;
  `notifications/cancelled` → `cancelled(requestId)`; other notifications still dropped. The host
  closure binds `connId` (the core is per connection).
- **r1 #2: no reply after `notifications/cancelled` on any path** — during prepare, during run,
  during a messaging call, while an ask waits, and in the approve-then-cancel race. Session
  closed/moved and window closed/reloaded/gone reply `cancelled`. Connection closed: nothing to
  reply to. Late answers after any end are ignored.
- **r1 #3:** `mcp:askAnswer` counts only when it comes from the window the card was sent to.
- Ask timeout per caller CLI kind (documented limits): claude 120 s, codex 50 s, cursor 50 s,
  opencode 25 s, agent 25 s. At most 3 waiting asks per caller; a 4th returns `rate_limited`.
- "Always for this session" writes a **persistent** session override `access:'on'` (spec D2). If
  the caller session is gone by then (`setMcpToolPolicy` returns `false`), the call returns
  `cancelled` and nothing runs.
- Rate: act 10/min per caller + 20/min global; show 30/min per caller. A refusal at step 7 or 9
  refunds; a denied, expired or cancelled ask keeps the token.
- **r1 #1 migration:** v0.50 `mcpTools[t] === true` → `{access:'on', when:'always'}`;
  `false` for a messaging tool (v0.50 default **on**, `tool-switches.ts:18-26`) → `{access:'off'}`;
  `false` for a control tool (v0.50 default off) → the new default. A session override `false` →
  `{access:'off'}`. **r1 #7:** a session holding both `mcpToolPolicy` and `mcpToolOverrides`
  overlays the migrated old key onto the coerced new layer (only v0.50 writes the old key).
- Approval card: `webview/components/approval-card.tsx` + `webview/mcp-ask-store.ts`; CSS layer
  token `--layer-ask` between toast (80) and popover (200).
- Claude `--allowedTools` stays messaging-only (double prompt accepted). Codex
  `default_tools_approval_mode="auto"` unchanged on purpose.
- Out: progress notifications, elicitation, tool annotations, restrict-only locks.

## Spec staleness

Measured at `9c03366f`; each row says how the plan proceeds.

| Spec claim | Measured | Plan proceeds |
|---|---|---|
| Ask timeout flat 50 s; every cancel returns `cancelled` (§2.4, §5, §13 D3) | Conductor lock + research: per-CLI table; no reply after `notifications/cancelled` | Spec §2.4, §5, §13 D3 updated in this branch. §2.6 row 3 still says "ASSUMED; measured at S0" (now documented, not measured); left as is |
| `false` → the new default for every tool (§3.1 migration, §2.6 row 1) | v0.50 defaults messaging tools to `true` (`src/conduit-mcp/tool-switches.ts:18-26`), so a `false` there was user-set | Spec §3.1 and §2.6 row 1 updated (r1 #1); also the both-keys overlay (r1 #7) |
| Asks are cancelled when "the caller session closes" (§2.4) | A session can move to another window (`electron/main.ts:2250`), which leaves its card in the old window | Spec §2.4 updated: a move also cancels (reply `cancelled`) (r1 #3) |
| Readiness keys on `did-start-loading` (§2.3, §3.4) | No navigation listener exists in `electron/`. `did-start-loading` is the spinner event and also fires for subframe loads; no `<iframe>` in `webview/` today; web tabs are `<webview>` guests with their own webContents. A crashed renderer that is not reloaded fires no navigation | T1.10 uses `did-start-navigation` filtered to `isMainFrame && !isSameDocument`, and the `render-process-gone` handler resets the window too (r1 #8) |
| Card reached "via the chip or F6 pane cycling" (§9) | No F6 handler in `webview/` | Chip + session card button only (Out of scope) |
| MVP Part A e2e includes "reach refusal" (§6) | No Part A tool has `reach` (§3.2) | Types, coercion and editor carry `reach`; enforcement and e2e land with Part B (N1) |
| `mcp:setToolPolicy.patch` is `Partial<ToolPolicy> \| 'inherit'` (§3.4) | §8 needs Inherit per field | `ToolPolicyPatch` has `'inherit'` per field; no whole-tool `'inherit'` |
| `settings.mcpToolPolicyByCli?` optional (§3.1) | Every `AppSettings` field is required with a default | Required, default `{}` |
| CLI kind = handle prefix (§2.1) | No parser exists; the e2e fake's prefix is `fake` | T1.2 `cliKindOfHandle`; the fake resolves to `agent` ("Other") |
| S0: whether `list_sessions` exposes handle-less sessions (A7) | `listedSessions` (`electron/conduit-mcp-host.ts:347-358`) skips sessions without `mcpHandle`; `directory()` (`:422`) feeds `list_sessions` | S0 pins it with a host unit test |
| S0: whether every CLI accepts the new schemas | Part A adds no tool or input schema | Moved to Part B's S0 |
| `open_file` opens in the caller's session (app-control §2.1, Part A MVP) | `openMcpFile` resolves the path's owning session (`electron/main.ts:2568-2575`) | T1.10 sends to the caller. `planFileOpen` activation is unchanged here (Part B's session-explicit entries) |

## Global constraints

- **Gates and cadence:**
  - Per task: the named vitest file(s), red then green (`npx vitest run <file>`); in S1 also
    `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.webview.json --noEmit` green
    after every task (additive cutover).
  - Per slice: the slice's Check, which ends in `npm run verify:quick`.
  - **Once, after S3:** `npm run verify`, then `npm run e2e:remote -- conduit-mcp-policy
    conduit-mcp-policy-migrate conduit-mcp-control conduit-mcp-control-terminal`, then
    `npm run e2e:remote` (`--affected`). E2e code is written during S3 and run only then.
  - Locally at most one e2e by exact name; never a fan-out. Never narrow, skip or disable a check.
    Never pipe verify output through `tail`. Capture exit codes directly.
- **Fallow:** `npm run fallow:check` (in `verify`) fails on unused exports. Every export in
  Contracts names its caller; tests are fallow entries. A type used only by a sibling in the same
  file stays unexported. No export without a caller.
- **CI is ubuntu.** Unit tests never depend on win32 paths, `\`, drive letters or
  `process.platform`.
- **Comments explain WHY only**; spec pointers like `// spec 2026-10-30-conduit-mcp-tool-policy §2.4`.
  No `as any`, `@ts-ignore`, `!important`, swallowed errors, magic offsets, specificity escalation.
- **Naming:** files kebab-case by role; tests `test/unit/<module>.test.ts[x]`; React tests start
  with `// @vitest-environment jsdom` and follow `test/unit/mcp-tools-dialog.test.tsx`. Constants
  `SCREAMING_SNAKE`, types `PascalCase`, functions `camelCase`. MCP wire fields `snake_case`;
  host↔renderer fields `camelCase`.
- **Node-free modules** (`tool-policy.ts`, `handles.ts`, `window-waits.ts`, `call-flow.ts`,
  `types.ts`, `ui-types.ts`, `src/window-presence.ts`) import no `node:*` module and nothing from
  `electron/`. `call-flow.ts` may import types from `src/protocol.ts` (node-free).
- **No await inside a critical section:** in `call-flow.ts`, from the `countFor` check through
  `ownerWindowOf`, `sendToOwner` and `waits.open`, the code is one synchronous block (a test pins
  it). `flow.begin` runs before the host's first `await` in `callTool`.
- **Trust boundaries:** every `mcp:setToolPolicy` and `mcp:askAnswer` field is re-validated
  host-side, and `mcp:askAnswer` must come from the ask's window; settings and sessions are
  coerced on load.
- **Renderer rules (CLAUDE.md):** the card never takes DOM focus on arrival and sits below the top
  bar, not over it; new class names are namespaced (`askcard`, `policyrow`, `policycli`)
  (`test/unit/monaco-class-collision.test.ts`).
- **E2E:** launch only via `launchElectron`/`runScenario`, exit only via `finishScenario`; hidden,
  serial; terminal writes through `typeLine`/`writeToTerminal`.
- **Strings:** all UI copy in `MCP_STR`; per-tool summary templates; tool names and handles literal.
- **User-facing changes:** `CHANGELOG.md` (T3.5).

## Out of scope

- Part B: the seven tools, `mcp:ui` / `mcp:uiResult` and their waits instance, `reach`
  enforcement and its e2e, `move_not_allowed`, session-explicit renderer entries (`planFileOpen`
  never activating), ref classification, `normalizeUrl`.
- F6 pane cycling, an ask countdown, an approvals history, a per-project layer.
- The global `rendererReady` latch for cold OS opens (`electron/main.ts:1195`).
- Progress notifications, elicitation, annotations, locks, URL/path allowlists, writing larger
  per-CLI timeouts into installed configs.

## Contracts

### `src/conduit-mcp/types.ts` — T1.1

`ToolErrorCode` gains `'window_not_ready' | 'caller_not_visible' | 'denied' | 'approval_timeout' |
'cancelled'`. `RETRYABLE` gains `'window_not_ready'` only.

### `src/conduit-mcp/tool-policy.ts` (new, node-free) — T1.1

```ts
import type { ClientKind } from './client-info';
import { type ToolError, toolError } from './types';

export const MESSAGING_TOOL_NAMES = ['list_sessions', 'send_message', 'read_inbox', 'read_attachment'] as const;
export const SESSION_TOOL_NAMES = ['open_session', 'open_terminal'] as const;
export const EDITOR_TOOL_NAMES = ['open_file'] as const;
export const TOOL_NAMES = [...MESSAGING_TOOL_NAMES, ...SESSION_TOOL_NAMES, ...EDITOR_TOOL_NAMES] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolGroup = 'messaging' | 'sessions' | 'editor';
export const TOOL_GROUPS: readonly { group: ToolGroup; tools: readonly ToolName[] }[];
// = messaging: MESSAGING_TOOL_NAMES, sessions: SESSION_TOOL_NAMES, editor: EDITOR_TOOL_NAMES

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
export type CliKind = Exclude<ClientKind, 'fake'>;
export const CLI_KINDS: readonly CliKind[] = ['claude', 'codex', 'cursor', 'opencode', 'agent'];
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

type RateBudget = 'act' | 'show';   // not exported: only ToolSpec uses it
export interface ToolSpec {
  /** Applicable fields, 'access' first. */
  fields: readonly PolicyField[];
  /** Offered access values: messaging tools have no 'ask'. */
  access: readonly Access[];
  /** Offered reach values when 'reach' applies (Part B rows). */
  reach?: readonly Reach[];
  /** null: messaging, not budgeted. */
  budget: RateBudget | null;
  defaults: ToolPolicy;
}
/**
 * messaging (4): fields ['access'], access ['off','on'], budget null, defaults {access:'on'}.
 * open_session:  fields ['access','when','move'], all access, 'act', {access:'ask', when:'viewing', move:'yes'}.
 * open_terminal: same fields/budget, {access:'off', when:'viewing', move:'yes'}.
 * open_file:     fields ['access','when'], 'show', {access:'on', when:'viewing'}.
 */
export const TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>>;
export const DEFAULT_TOOL_POLICY: Readonly<GlobalPolicy>;

export function isToolName(v: unknown): v is ToolName;
export function isMessagingTool(t: ToolName): boolean;
/** v is offered for that tool's field. */
export function isValidField(tool: ToolName, field: PolicyField, v: unknown): boolean;

/**
 * Complete global layer. When `v` is a record it wins and `legacy` is ignored; per tool, valid
 * applicable fields overlay the defaults. Otherwise a v0.50 `mcpTools` record migrates per tool:
 * true → {access:'on', when:'always'} (when only if applicable) over the defaults; false on a tool
 * whose v0.50 default was true (MESSAGING_TOOL_NAMES) → {access:'off'}; anything else → defaults.
 * Never throws.
 */
export function coerceGlobalPolicy(v: unknown, legacy?: unknown): GlobalPolicy;
/** Known tools, applicable fields, valid values only; empty entries dropped; undefined when empty. */
export function coercePolicyLayer(v: unknown): PolicyLayer | undefined;
/** Known CLI kinds only, each through coercePolicyLayer; undefined when empty. */
export function coerceCliLayers(v: unknown): CliPolicyLayers | undefined;
/** v0.50 Session.mcpToolOverrides: true → {access:'on', when:'always'}; false → {access:'off'}. */
export function migrateToolOverrides(v: unknown): PolicyLayer | undefined;
/** Per applicable field: first valid value in session, cli, global. Total; never throws. */
export function resolvePolicy(tool: ToolName, layers: PolicyLayers): ResolvedPolicy;
/** Immutable. A field 'inherit' deletes it; an emptied tool entry is dropped; undefined when empty. */
export function withPolicyPatch(layer: PolicyLayer | undefined, tool: ToolName, patch: ToolPolicyPatch): PolicyLayer | undefined;
/** IPC boundary: null when any key isn't an applicable field, any value is invalid, or it is empty. */
export function coercePolicyPatch(tool: ToolName, v: unknown): ToolPolicyPatch | null;

/** Spec §3.3 steps 1–5; null ⇒ proceed. Steps 4–5 only for non-messaging tools; thunks run lazily. */
export function gateToolCall(i: {
  sessionId: string | null;
  messagingOn: boolean;
  tool: ToolName;
  policy: ToolPolicy;
  ownerReady: () => boolean;
  onScreen: () => boolean;
}): ToolError | null;
```

Gate messages (reveal nothing about targets): `not_in_session` `'this MCP connection is not a
Conduit session'`; `messaging_off` `'Conduit messaging is turned off'`; `tool_disabled`
`` `${tool} is not enabled for this session` ``; `window_not_ready` `"this session's Conduit
window isn't ready; try again shortly"`; `caller_not_visible`
`` `${tool} only runs while your session is on screen` ``.

### `src/conduit-mcp/handles.ts` — T1.2

```ts
import type { CliKind } from './tool-policy';
/** The prefix before the last '-'; claude|codex|cursor|opencode map to themselves, anything else to 'agent'. */
export function cliKindOfHandle(handle: Handle): CliKind;
```

### `src/conduit-mcp/window-waits.ts` (new, node-free) — T1.3

```ts
import type { JsonRpcId } from './json-rpc';

export interface CallKey { connId: number; requestId: JsonRpcId }
export interface Wait<M> {
  id: string;
  callerSessionId: string;
  key: CallKey;
  /** The window the request was sent to; only it may answer. */
  windowId: number;
  openedAt: number;
  meta: M;
}
export type WaitEnd<A> =
  | { kind: 'answered'; answer: A }
  | { kind: 'expired' }
  /** reply false: the CLI cancelled or its connection closed, so nothing is sent back. */
  | { kind: 'cancelled'; reply: boolean };
export type UnansweredEnd = { kind: 'expired' } | { kind: 'cancelled'; reply: boolean };
export interface WindowWaitsDeps<M> {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Once per wait that ends without an answer. */
  onUnanswered(wait: Wait<M>, end: UnansweredEnd): void;
}
export interface WindowWaits<A, M> {
  countFor(callerSessionId: string): number;
  open(wait: Omit<Wait<M>, 'openedAt'>, timeoutMs: number): Promise<WaitEnd<A>>;
  /** false when unknown, already ended, or `fromWindowId` isn't the wait's window. */
  answer(id: string, fromWindowId: number, answer: A): boolean;
  /** Ends every matching wait as cancelled; returns how many. */
  cancel(match: (w: Wait<M>) => boolean, reply: boolean): number;
  pending(): readonly Wait<M>[];
  /** Cancels everything with reply false (host stop). */
  dispose(): void;
}
export function createWindowWaits<A, M>(deps: WindowWaitsDeps<M>): WindowWaits<A, M>;
```

### `src/conduit-mcp/call-flow.ts` (new, node-free) — T1.8

```ts
import type { HostToWebview } from '../protocol';
import type { PreparedCall } from './control-tools';
import type { JsonRpcId } from './json-rpc';
import type { CliKind, PolicySource, ToolName, ToolPolicy, ToolPolicyPatch } from './tool-policy';
import type { Handle, Result } from './types';
import type { AskAnswer } from './ui-types';

/** Below each CLI's documented MCP call timeout (spec §5, research 2026-10-30). */
export const ASK_TIMEOUT_MS: Readonly<Record<CliKind, number>> =
  { claude: 120_000, codex: 50_000, cursor: 50_000, opencode: 25_000, agent: 25_000 };
export const MAX_ASKS_PER_CALLER = 3;

export interface InFlight {
  /** True once notifications/cancelled named this request. Never true for a null requestId. */
  readonly cancelled: boolean;
  /** Drops the in-flight entry; called in the host's finally. Idempotent. */
  end(): void;
}
export interface ControlCall<T> {
  inflight: InFlight;
  caller: { sessionId: string; handle: Handle };
  kind: CliKind;
  tool: ToolName;
  policy: ToolPolicy;
  /** The layer that set `access` (for the card's reason line). */
  source: PolicySource;
  args: unknown;
  prepare(): Promise<Result<PreparedCall<T>>>;
}
export interface CallFlowDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  newAskId(): string;
  ownerWindowOf(sessionId: string): number | null;
  sendToOwner(sessionId: string, msg: HostToWebview): void;
  flashOwner(sessionId: string): void;
  /** Current resolved policy for a waiting ask's caller and tool; null when the session is gone. */
  resolve(sessionId: string, tool: ToolName): ToolPolicy | null;
  messagingOn(): boolean;
  /** false when the session no longer exists. */
  setSessionPolicy(sessionId: string, tool: ToolName, patch: ToolPolicyPatch): boolean;
  /** After Always wrote the session layer: the host re-syncs tool lists. */
  onPolicyWritten(): void;
  /** The waiting set changed: the host re-broadcasts mcp:state. */
  onAwaitingChanged(): void;
}
export interface CallFlow {
  /** Synchronous; must run before the caller's first await. A null requestId is not tracked. */
  begin(key: { connId: number; requestId: JsonRpcId | null }): InFlight;
  /** After the gate. null ⇒ no reply (the CLI cancelled). */
  runControl<T>(c: ControlCall<T>): Promise<Result<T> | null>;
  /** notifications/cancelled: marks the in-flight entry and ends its ask (reply false). */
  cancelled(connId: number, requestId: JsonRpcId): void;
  connectionClosed(connId: number): void;       // asks end, reply false
  sessionGone(sessionId: string): void;          // the caller's asks end, reply true
  sessionMoved(sessionId: string): void;         // the caller's asks end, reply true
  windowReset(windowId: number): void;           // asks in that window end, reply true
  /** Ends (reply true) every ask whose re-resolved access is 'off', or all when messaging is off. */
  recheck(): void;
  /** false unless the ask exists, is waiting, and `fromWindowId` is its window. */
  answer(askId: string, fromWindowId: number, answer: AskAnswer): boolean;
  awaitingApproval(): string[];
  dispose(): void;
}
export function createCallFlow(deps: CallFlowDeps): CallFlow;
```

`runControl` semantics (exact):
1. `prepared = await c.prepare()`; refusal → returned as is. Then `if (c.inflight.cancelled)` →
   `prepared.release()`, `null`.
2. `access === 'on'` → `cancelled` check (release, `null`) → `r = await run()` →
   `c.inflight.cancelled ? null : r`.
3. `access === 'ask'`, **one synchronous block**: `countFor(caller) >= MAX_ASKS_PER_CALLER` →
   release, `rate_limited` (`'more than 3 requests are waiting for the human'`);
   `w = ownerWindowOf(caller)` (the host answers `null` unless that window is ready now: the gate's
   check is stale after the async prepare); `null` → release, `window_not_ready`;
   `sendToOwner(caller, {type:'mcp:ask', askId, callerSessionId, callerHandle, tool,
   summary: prepared.summary, args, source})`; `end = waits.open({id: askId, callerSessionId,
   key, windowId: w, meta: {tool, handle}}, ASK_TIMEOUT_MS[kind])`; `flashOwner`;
   `onAwaitingChanged`. Then `await end`, `onAwaitingChanged`, and:
   - `approve` → cancelled check (`null`, token kept: a cancelled ask keeps its token, spec §3.3) →
     run, then the step-2 tail;
   - `always` → `setSessionPolicy(caller, tool, {access:'on'})`; `false` → `cancelled` tool error
     (`'the session closed before the request ran'`), token kept, nothing runs; else
     `onPolicyWritten()`, then as `approve`;
   - `deny` → `denied`; `expired` → `approval_timeout`; `cancelled` reply true → `cancelled`;
     reply false → `null`. Token kept in all four.
4. `onUnanswered` sends `{type:'mcp:askClosed', askId, outcome: end.kind}` to the caller's owner.
5. `answer()` rejects a wrong window (returns `false`, the card stays).

### `src/window-presence.ts` (new, node-free) — T1.4

```ts
export interface WindowPresence {
  /** Main-frame navigation began or the renderer died: not ready, no visible report. */
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
`ready` lands.

### `src/conduit-mcp/ui-types.ts` — T1.6

```ts
export type AskAnswer = 'approve' | 'deny' | 'always';
export type AskClosedOutcome = 'expired' | 'cancelled';
/** Placeholder values for the card's per-tool summary template (MCP_STR.ask.summary). */
export type AskSummary =
  | { tool: 'open_session'; path: string; agent: string; focus: boolean }
  | { tool: 'open_terminal'; path: string; command: string; focus: boolean }
  | { tool: 'open_file'; path: string; line: number | null };
// McpUiState gains
  /** Caller session ids with at least one waiting ask (spec §2.4 caller side). */
  awaitingApproval: string[];
```

### `src/protocol.ts` — T1.6 (add), T1.14 (remove old)

```ts
// HostToWebview, added in T1.6
  | { type: 'mcp:ask'; askId: string; callerSessionId: string; callerHandle: Handle; tool: ToolName;
      summary: AskSummary; args: unknown; source: PolicySource }
  | { type: 'mcp:askClosed'; askId: string; outcome: AskClosedOutcome }
  | { type: 'mcp:toolPolicyResult'; requestId: number; ok: true }
  | { type: 'mcp:toolPolicyResult'; requestId: number; ok: false;
      error: 'unknown-session' | 'unknown-tool' | 'invalid-value' }
// WebviewToHost, added in T1.6 (host re-validates every field)
  | { type: 'mcp:askAnswer'; askId: string; answer: AskAnswer }
  | { type: 'mcp:setToolPolicy'; requestId: number; sessionId: string; tool: string; patch: ToolPolicyPatch }
// removed in T1.14: mcp:toolOverrideResult (:566-572), mcp:setToolOverride (:1074-1080)
```

### `src/settings.ts`, `src/types.ts`, `src/session-manager.ts`, `src/persistence.ts` — T1.5 (add), T1.14 (remove old)

```ts
// AppSettings, added beside mcpTools in T1.5 (mcpTools removed in T1.14)
  mcpToolPolicy: GlobalPolicy;          // default deep copy of DEFAULT_TOOL_POLICY
  mcpToolPolicyByCli: CliPolicyLayers;  // default {}
// coerceSettings
  mcpToolPolicy: coerceGlobalPolicy(payload.mcpToolPolicy, payload.mcpTools),
  mcpToolPolicyByCli: coerceCliLayers(payload.mcpToolPolicyByCli) ?? {},
// Session, added beside mcpToolOverrides in T1.5 (old removed in T1.14)
  /** Session layer, per field; never copied by create/duplicate (spec §3.1). Persisted. */
  mcpToolPolicy?: PolicyLayer;
// SessionManager, added beside setMcpToolOverride in T1.5 (old removed in T1.14)
  /** false for an unknown id; no emit when the tool's entry is unchanged. */
  setMcpToolPolicy(id: string, tool: ToolName, patch: ToolPolicyPatch): boolean;
// parseSessions (T1.5; final form after T1.14):
//   let layer = coercePolicyLayer(s.mcpToolPolicy);
//   const old = migrateToolOverrides(s.mcpToolOverrides);
//   for each [tool, fields] of old: layer = withPolicyPatch(layer, tool, fields);   // r1 #7 overlay
//   in T1.5 the raw mcpToolOverrides is still kept as its own coerced field; T1.14 deletes it.
```

### `src/conduit-mcp/json-rpc.ts` — T1.9

```ts
export interface ToolCallContext { requestId: JsonRpcId | null }
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

### `src/conduit-mcp/control-tools.ts` — T1.7 (add), T1.14 (remove old)

```ts
export const ACT_RATE_PER_CALLER = 10;   // replaces OPEN_RATE_PER_CALLER (T1.14 removes the old names)
export const ACT_RATE_GLOBAL = 20;       // replaces OPEN_RATE_GLOBAL
export const SHOW_RATE_PER_CALLER = 30;
export interface PreparedCall<T> {
  summary: AskSummary;
  /** Executes; refunds the rate token itself when the open fails (step 9). */
  run(): Promise<Result<T>>;
  /** Refunds the token for a refusal between prepare and run that isn't an ask outcome. Idempotent. */
  release(): void;
}
interface ControlCallContext { move: Move | undefined }   // not exported: only ControlHandlers uses it
// ControlHandlers gains (T1.7); openSession/openTerminal/openFile become prepare+run wrappers
// until the host stops calling them (T1.9) and are removed in T1.14.
  prepareOpenSession(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenSessionOutput>>>;
  prepareOpenTerminal(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenSessionOutput>>>;
  prepareOpenFile(caller: Caller, args: unknown, ctx: ControlCallContext): Promise<Result<PreparedCall<OpenFileOutput>>>;
```

`prepare*`: parse (`invalid_args`) → reserve the tool's budget (`rate_limited`) → home → resolve
path → kind check → agent/command check; any refusal after the reservation releases it; the
summary carries the resolved absolute path. `move === 'no'` forces `focus: false` in the request
and the summary.

### `src/conduit-mcp/tool-schemas.ts` — T1.7

`open_session` and `open_terminal` descriptions gain, verbatim:
`" focus:true (default) moves the human's view to it, which can end your on-screen access; when opening several, pass focus:false for all but the last."`

### `electron/conduit-mcp-host.ts` — T1.9 (cutover), T1.14 (remove old)

```ts
// ConduitMcpHostDeps: mcpTools() removed in T1.14; mgr Pick gains 'setMcpToolPolicy' (T1.9) and
// loses 'setMcpToolOverride' (T1.14); added in T1.9
  /** settings.mcpToolPolicy and settings.mcpToolPolicyByCli, read per call. */
  toolPolicy(): { global: GlobalPolicy; byCli: CliPolicyLayers };
  /** The session's owner window id; null when it has none. */
  ownerWindowOf(sessionId: string): number | null;
  presence: Pick<WindowPresence, 'isReady' | 'isOnScreen'>;
  sendToOwner(sessionId: string, msg: HostToWebview): void;
  /** Taskbar flash unless the owner window is focused (main gates it on settings.osAttention). */
  flashOwner(sessionId: string): void;
  // tests only
  newAskId?: () => string;                              // default randomBytes(12).toString('hex')
  setTimer?: (fn: () => void, ms: number) => unknown;   // default setTimeout
  clearTimer?: (h: unknown) => void;                    // default clearTimeout
// ConduitMcpHost
  handleRenderer(m: McpRendererMessage, reply: (msg: HostToWebview) => void, senderId: number): Promise<void>;
  /** Navigation start, renderer gone, or closed: that window's asks end `cancelled`. */
  onWindowReset(windowId: number): void;
  /** The session now belongs to another window: its asks end `cancelled`. */
  onSessionMoved(sessionId: string): void;
```

Host internals: `callTool(sessionId, name, args, ctx: ToolCallContext & { connId: number }):
Promise<ToolCallResult | null>` calls `flow.begin` first (synchronously), wraps the rest in
`try/finally { inflight.end() }`, returns `null` when `inflight.cancelled` after a messaging call.
`onSessionDeleted` calls `flow.sessionGone(sessionId)` as its **first** statement (before
`closeConnectionsOf` and the store awaits, `:1245-1261`). `refresh()` adds `flow.recheck()`.
`stop()` adds `flow.dispose()`. `conn.onClose` adds `flow.connectionClosed(conn.id)`.

### `electron/main.ts` — T1.9 (host construction + call site), T1.10 (events)

```ts
const presence = createWindowPresence();   // app-ready closure, before spawnWindow's first call
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
  /** Display name of a layer, for "Inherit (On · from All CLIs)". */
  sourceName(source: PolicySource): string;
  disabled: boolean;
  /** Tools whose last change failed to save. */
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

// webview/use-conduit-mcp.ts (T1.12): setToolOverride replaced by
  setToolPolicy(sessionId: string, tool: ToolName, patch: ToolPolicyPatch): Promise<boolean>;

// webview/mcp-ask-store.ts (T2.1)
export interface PendingAskView {
  askId: string; callerSessionId: string; callerHandle: Handle; tool: ToolName;
  summary: AskSummary; args: unknown; source: PolicySource;
}
export function getAsksSnapshot(): readonly PendingAskView[];   // oldest first
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
  asks?: readonly AttentionAsk[],   // default []; ask entries first, key `ask:${askId}`
): AttentionEntry[];

// webview/components/top-bar.tsx (T2.3): props gain
  asks?: readonly AttentionAsk[];
  onFocusAsk?: () => void;
// sidebar.tsx / session-card.tsx (T2.4): optional props
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

// T1.11 — MCP_STR.tools, added beside the old keys; T1.14 removes groupMessaging, groupControl,
// inherit(on), on, off (their readers are the dialog, settings rows and settings-mcp-tools.test.tsx)
group: { messaging: 'Messaging', sessions: 'Sessions', editor: 'Editor & views' } satisfies Record<ToolGroup, string>,
// description: the six other entries keep their current text; open_terminal changes to
//   'Lets an agent run any program as you, outside its own sandbox.'
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
| `settings.mcpToolPolicy` / `mcpToolPolicyByCli` | Settings editor (T1.13) → `updateSettings` → `coerceSettings` (T1.5) | host resolve, list, `flow.recheck` (T1.9) via main's `toolPolicy` dep (T1.9); dialog labels (T1.12); renderer settings hydrate (`webview/settings.tsx`, whole object, unchanged) | Both |
| v0.50 `settings.mcpTools` | v0.50 files (and this build's own field until T1.14) | `coerceGlobalPolicy(…, payload.mcpTools)` (T1.5) | Consumer; the producer is a released version |
| `Session.mcpToolPolicy` | dialog → `mcp:setToolPolicy` → host → `mgr.setMcpToolPolicy` (T1.12, T1.9, T1.5); Always (T1.8 via host dep); `parseSessions` (T1.5) | host resolve (T1.9), dialog (T1.12), persistence (T1.5), e2e helpers (T3.1) | Both; never produced by `create`/`duplicate` (T1.5 test) |
| v0.50 `Session.mcpToolOverrides` | v0.50 `sessions.json` (it round-trips unknown keys, so a downgraded v0.50 keeps `mcpToolPolicy` beside it) | `migrateToolOverrides` + overlay in `parseSessions` (T1.5) | Consumer only (released producer) |
| CLI kind | handle prefix from `claimHandle` (unchanged, `electron/conduit-mcp-host.ts:610-651, :770`) | `cliKindOfHandle` (T1.2) → host layers, `ControlCall.kind` (T1.9), dialog (T1.12), card reason (T2.2) | Consumer; producer unchanged on purpose |
| Window readiness + visible set | main: navigation start, `render-process-gone`, `ready`, `visible`, closed (T1.10) → presence (T1.4) | host gate via `ownerWindowOf` + `presence` (T1.9) | Both; `activity.setVisible`, `gitDemand.setVisible`, `repoTrackerHost.windowShown` keep their semantics |
| Window reset | main (T1.10) | `host.onWindowReset` → `flow.windowReset` (T1.9, T1.8); renderer store resets with the reload (T2.1) | Both |
| Session moved to another window | `moveSessionToWindow` (`electron/main.ts:2250`, T1.10) | `host.onSessionMoved` → `flow.sessionMoved` (T1.9, T1.8) | Both |
| Sender window of a renderer message | main `handle()` `senderId` (`:2862-2866`) → `handleRenderer(m, reply, senderId)` (T1.9) | `flow.answer(askId, senderId, …)` (T1.8) | Both. Every other `mcp:*` case ignores `senderId` |
| `tools/call` request id; `null` = no reply | core (T1.9) ↔ host `callTool` (T1.9) | — | Both |
| `notifications/cancelled` | the CLI | core `cancelled` (T1.9) → `flow.cancelled` (T1.8) | Consumer; the CLI is outside our control |
| `tools/list` = resolved `access ≠ off`; `list_changed` | host (T1.9) | each CLI | Producer only, as in v0.50 |
| `mcp:ask` / `mcp:askClosed` | call flow via host's `sendToOwner` (T1.8, T1.9) | ask store (T2.1) → card (T2.2), chip (T2.3/T2.5) | Both. Between S1 and S2 nothing subscribes: renderer `subscribe` callbacks switch on `type` (measured `webview/use-conduit-mcp.ts:39`) |
| `mcp:askAnswer` | card → `answerAsk` (T2.2, T2.1) | main case (T1.10) → host → `flow.answer` (T1.9, T1.8) | Both |
| `McpUiState.awaitingApproval` | host `uiState()` from `flow.awaitingApproval()` (T1.9) | sidebar → session card (T2.4, wired T2.5); the fake shell's `McpUiState` literal (`webview/bridge.ts`, T1.6); `test/unit/conduit-mcp-view-model.test.ts` fixture (T1.6) | Both |
| `mcp:setToolPolicy` / `mcp:toolPolicyResult` | `useConduitMcp().setToolPolicy` (T1.12) | main case (T1.10) → host (T1.9) | Both. `ConduitMcpApi` mocks in `test/unit/message-compose.test.tsx:51`, `messages-pane.test.tsx:125`, `right-pane-review-kebab.test.ts:105` rename (T1.12) |
| `open_file` target session | `openMcpFile` → caller (T1.10) | renderer `openFileInEditor` handler + `planFileOpen` (unchanged) | Producer only: the handler takes any `sessionId` its window owns |
| `focus` under `move:'no'` | control-tools prepare (T1.7) | `createMcpSession` → `openRepo` `mcp.focus` (unchanged) | Producer only |
| Rate budgets | control-tools (T1.7) | control-tools | Both (one module) |
| `ToolErrorCode` additions | `types.ts` (T1.1) | `MCP_STR.errors` map (T1.1); call flow / host results | Both |
| Chip entries | `attentionEntries` (T2.3) | top-bar (T2.3) | Both; `test/unit/attention.test.ts` keeps working via the default |
| Taskbar flash | call flow `flashOwner` (T1.8) | main → `flashFrame` (T1.9 deps); cleared by the existing focus handler (`electron/main.ts:1098-1101`) | Both |
| Claude allowlist | `src/mcp-launch.ts:36` from `MESSAGING_TOOL_NAMES` | Claude CLI | Import path only (T1.14) |
| Old switches API removal | T1.14 | every importer of `tool-switches.ts`, `AppSettings.mcpTools`, `Session.mcpToolOverrides`, `setMcpToolOverride`, `mcp:setToolOverride`/`mcp:toolOverrideResult`, `ControlHandlers.openSession/openTerminal/openFile`, `OPEN_RATE_*` | All switched in T1.5–T1.13 first; T1.14's grep proves zero readers |

Messaging-only e2e scenarios (`conduit-mcp-gate`, `-refusals`, `-compose`, `-notify`, `-restart`)
call only messaging tools (grep), whose defaults stay `on` with no `when`: unaffected.

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/conduit-mcp/tool-policy.ts` | create | Catalog, policy types, coercion, migration, resolution, patching, gate steps 1–5 |
| `src/conduit-mcp/window-waits.ts` | create | Generic "call waiting on a window" lifecycle: timeout, window-bound answer, cancel, one end |
| `src/conduit-mcp/call-flow.ts` | create | Call pipeline after the gate: in-flight/cancel keys, prepare → ask → run, timeouts, cap, Always, recheck |
| `src/window-presence.ts` | create | Per-window readiness and visible set, fail-closed |
| `webview/components/tool-policy-editor.tsx` | create | Shared per-tool policy rows for any layer |
| `webview/mcp-ask-store.ts` | create | Renderer store of this window's waiting asks; answer; focus requests |
| `webview/components/approval-card.tsx` | create | Non-modal approval card with pager |
| `test/e2e/conduit-mcp-policy.e2e.mjs` | create | off/ask/on, Always, viewing refusal, move:no, CLI cancel, reload cancel |
| `test/e2e/conduit-mcp-policy-migrate.e2e.mjs` | create | v0.50 settings migrate; old keys vanish on write |
| `test/unit/conduit-mcp-tool-policy.test.ts`, `test/unit/conduit-mcp-window-waits.test.ts`, `test/unit/conduit-mcp-call-flow.test.ts`, `test/unit/window-presence.test.ts`, `test/unit/tool-policy-editor.test.tsx`, `test/unit/mcp-ask-store.test.ts`, `test/unit/approval-card.test.tsx`, `test/unit/session-card-ask.test.tsx` | create | Unit tests |
| `src/conduit-mcp/tool-switches.ts`, `test/unit/conduit-mcp-tool-switches.test.ts` | delete (T1.14) | Superseded |
| `src/conduit-mcp/types.ts` | modify | Five `ToolErrorCode`s; `RETRYABLE` |
| `src/conduit-mcp/handles.ts` | modify | `cliKindOfHandle` |
| `src/conduit-mcp/ui-types.ts` | modify | `AskAnswer`, `AskClosedOutcome`, `AskSummary`, `awaitingApproval` |
| `src/conduit-mcp/json-rpc.ts` | modify | Request-id context, `cancelled`, null = no reply; catalog import (T1.14) |
| `src/conduit-mcp/control-tools.ts` | modify | prepare/run, two budgets, `move` |
| `src/conduit-mcp/tool-schemas.ts` | modify | focus sentence in two descriptions |
| `src/mcp-launch.ts` | modify (T1.14) | Import from `tool-policy` |
| `src/settings.ts`, `src/types.ts`, `src/session-manager.ts`, `src/persistence.ts` | modify | New fields/method + migration (T1.5); old ones removed (T1.14) |
| `src/protocol.ts` | modify | Ask and policy messages (T1.6); old override messages removed (T1.14) |
| `src/attention.ts` | modify | Ask entries |
| `electron/conduit-mcp-host.ts` | modify | Policy gate, call-flow wiring, cancels, sender-bound IPC, `onWindowReset`, `onSessionMoved`, `awaitingApproval` |
| `electron/main.ts` | modify | Presence + deps + sender id (T1.9); events, cases, move hook, `open_file` to caller (T1.10) |
| `webview/conduit-mcp-strings.ts` | modify | Errors (T1.1); tools block (T1.11); old tools keys removed (T1.14); ask block (T2.1) |
| `webview/components/mcp-tools-dialog.tsx`, `webview/use-conduit-mcp.ts` | modify | Session layer via the shared editor; `setToolPolicy` |
| `webview/components/settings-modal.tsx` | modify | Global + CLI-layer editor replaces the switch rows |
| `webview/components/top-bar.tsx`, `webview/components/sidebar.tsx`, `webview/components/session-card.tsx` | modify | Chip asks; "Waiting for your approval" button |
| `webview/app.tsx` | modify | Dialog props (T1.12); card mount and wiring (T2.5) |
| `webview/bridge.ts` | modify (T1.6) | Fake-shell `McpUiState` gains `awaitingApproval` |
| `electron/conduit-mcp-endpoint.ts` | modify (review r1 F1) | `close()` flushes queued replies before destroying the socket, so a drained session's cancelled replies all arrive |
| `webview/styles.css` | modify | Editor rows (T1.11); `--layer-ask`, card, badge (T2.2) |
| `test/e2e/fixtures/fake-mcp-agent.mjs`, `test/e2e/conduit-mcp-helpers.mjs` | modify | `cancel` command, `CALL` record; policy helpers, dialog selector, non-blocking call |
| `test/e2e/conduit-mcp-control.e2e.mjs`, `test/e2e/conduit-mcp-control-terminal.e2e.mjs` | modify | New defaults and visibility |
| Existing tests: `test/unit/conduit-mcp-host.test.ts`, `conduit-mcp-json-rpc.test.ts`, `conduit-mcp-control-tools.test.ts`, `conduit-mcp-handles.test.ts`, `conduit-mcp-view-model.test.ts`, `conduit-mcp-endpoint.test.ts`, `coerce-settings.test.ts`, `persistence.test.ts`, `session-manager.test.ts`, `mcp-tools-dialog.test.tsx`, `settings-mcp-tools.test.tsx`, `attention.test.ts`, `message-compose.test.tsx`, `messages-pane.test.tsx`, `right-pane-review-kebab.test.ts` | modify | Follow the changed contracts + new cases |
| `docs/specs/2026-10-30-conduit-mcp-tool-policy.md` | modify (done in planning) | §2.4, §2.6 row 1, §3.1 migration, §5, §13 D3 |
| `CHANGELOG.md` | modify | Unreleased entry |

## Scripts

None. The only repeated edit is the `setToolOverride` → `setToolPolicy` rename in three test
mocks (T1.12). No fixtures are generated.

## Slices

Order: **S0 → S1 → S2 → S3**. S1 is one slice because the old switches have consumers in every
layer; the cutover inside it is additive (new beside old, `tsc` green after each task) and T1.14
removes the old API in one place.

**Shared-file serialization (exclusive claims):**
- `src/conduit-mcp/types.ts`: T1.1.
- `webview/conduit-mcp-strings.ts`: T1.1 → T1.11 → T1.14 → T2.1. Sequential.
- `src/settings.ts`, `src/types.ts`: T1.5 → T1.14.
- `src/protocol.ts`, `src/conduit-mcp/ui-types.ts`: T1.6 → T1.14.
- `src/conduit-mcp/control-tools.ts`: T1.7 → T1.14.
- `electron/conduit-mcp-host.ts`: T1.6 (the `awaitingApproval: []` line only) → T1.9 → T1.14.
- `test/unit/conduit-mcp-host.test.ts`: T0.1 → T1.9 → T1.14.
- `electron/main.ts`: T1.9 → T1.10 → T1.14.
- `webview/app.tsx`: T1.12 → T2.5.
- `webview/styles.css`: T1.11 → T2.2.
- `test/e2e/conduit-mcp-helpers.mjs`, `test/e2e/fixtures/fake-mcp-agent.mjs`: T3.1.
- `CHANGELOG.md`: T3.5.

---

### Slice 0: Pin A7 (list_sessions omits handle-less sessions)

**Check:** `npx vitest run test/unit/conduit-mcp-host.test.ts -t "list_sessions omits a session that has no handle"` green, then `npm run verify:quick`.

**Parallel groups:** G1: T0.1
**Claims:** `test/unit/conduit-mcp-host.test.ts`

#### Task 0.1: A7 host test

**Files:** Test `test/unit/conduit-mcp-host.test.ts` (new `it` beside the listing tests near `:1388`).

**Interfaces:** Consumes the existing harness (`harness(opts)`, `:146`) and `Session.mcpHandle`.

**Steps:**
- [ ] Test 'list_sessions omits a session that has no handle': two adapter sessions, one live with
  `mcpHandle: 'fake-1'`, one without a handle; the first calls `list_sessions`. Key assertion:
  `sessions.length === 1` and no entry has the handle-less session's id.
- [ ] Measurement carve-out: expected green on first run. If red, stop and report: A7 is false
  and Part B's spec changes.
- [ ] Record one line for Part B in the run report: "A7: handle-less sessions are not listed".

---

### Slice 1: Policy cutover — model, presence, call flow, host, main, editors

**Check:**
- `npx vitest run test/unit/conduit-mcp-tool-policy.test.ts test/unit/conduit-mcp-handles.test.ts test/unit/conduit-mcp-window-waits.test.ts test/unit/conduit-mcp-call-flow.test.ts test/unit/window-presence.test.ts test/unit/coerce-settings.test.ts test/unit/persistence.test.ts test/unit/session-manager.test.ts test/unit/conduit-mcp-json-rpc.test.ts test/unit/mcp-launch.test.ts test/unit/conduit-mcp-control-tools.test.ts test/unit/conduit-mcp-host.test.ts test/unit/tool-policy-editor.test.tsx test/unit/mcp-tools-dialog.test.tsx test/unit/settings-mcp-tools.test.tsx test/unit/message-compose.test.tsx test/unit/messages-pane.test.tsx test/unit/right-pane-review-kebab.test.ts test/unit/monaco-class-collision.test.ts` green;
- `git grep -n -e "tool-switches" -e "mcpToolOverrides" -e "setToolOverride" -e "setMcpToolOverride" -e "OPEN_RATE_" -e "mcpTools\b" -- src electron webview test` prints only the migration reads in `src/settings.ts`, `src/conduit-mcp/tool-policy.ts`, `src/persistence.ts` and their tests;
- `npm run verify:quick` green.

**Parallel groups:** Serial first: T1.1 · then G1: T1.2 · G2: T1.3 · G3: T1.4 · G4: T1.5 · G5: T1.6 · then G6: T1.7 · G7: T1.11 · then G8: T1.8 · then G9: T1.9 → T1.10 · G10: T1.12 · G11: T1.13 · Serial last: T1.14
**Claims (serial lane):** `src/conduit-mcp/types.ts`, `webview/conduit-mcp-strings.ts` (T1.1, T1.11, T1.14); `src/settings.ts`, `src/types.ts` (T1.5, T1.14); `src/protocol.ts`, `src/conduit-mcp/ui-types.ts` (T1.6, T1.14); `electron/conduit-mcp-host.ts` (T1.6, T1.9, T1.14), `test/unit/conduit-mcp-host.test.ts` (T1.9, T1.14); `electron/main.ts` (T1.9, T1.10, T1.14); `webview/app.tsx` (T1.12); `webview/styles.css` (T1.11)

Every task ends with both `tsc` projects green (additive cutover) plus its own vitest file(s).

#### Task 1.1: `tool-policy.ts` + error codes

**Files:**
- Create `src/conduit-mcp/tool-policy.ts`.
- Modify `src/conduit-mcp/tool-switches.ts`: import `MESSAGING_TOOL_NAMES`, `TOOL_NAMES`, `ToolName`, `isToolName`, `isMessagingTool` from `./tool-policy` and re-export them, so there is one catalog; `CONTROL_TOOL_NAMES` becomes `[...SESSION_TOOL_NAMES, ...EDITOR_TOOL_NAMES] as const`. Its boolean API stays until T1.14.
- Modify `src/conduit-mcp/types.ts` (`ToolErrorCode` `:10-34`, `RETRYABLE` `:42`), `webview/conduit-mcp-strings.ts` (errors map `~:190`).
- Test: create `test/unit/conduit-mcp-tool-policy.test.ts`.

**Interfaces:**
- Produces the whole `tool-policy.ts` block, the five codes and their strings (Contracts).
- Consumes `toolError(code, message): ToolError` (`src/conduit-mcp/types.ts`), `type ClientKind` (`src/conduit-mcp/client-info.ts:4`).

**Steps:**
- [ ] Failing tests:
  - 'defaults match spec §3.2' — `open_session` `{access:'ask', when:'viewing', move:'yes'}`, `open_terminal.access === 'off'`, `open_file` `{access:'on', when:'viewing'}`, `send_message` `{access:'on'}`;
  - 'messaging tools are never ask' — `isValidField('read_inbox','access','ask') === false`; `coercePolicyLayer({read_inbox:{access:'ask'}})` is `undefined`;
  - 'resolve per field with sources' — cli `{open_session:{when:'always'}}`, session `{open_session:{access:'on'}}` → `{access:'on', when:'always', move:'yes'}`, sources `{access:'session', when:'cli', move:'global'}`;
  - 'an invalid value falls through' — session `{open_file:{access:'maybe'}}` (bypassing coercion) → `access` from global, source `'global'`;
  - 'a non-applicable field is dropped' — `coercePolicyLayer({open_file:{move:'no'}})` is `undefined`; resolved `open_file` has no `move`;
  - 'v0.50 migration: true → on/always' — `coerceGlobalPolicy(undefined, {...v050Defaults, open_session: true}).open_session` equals `{access:'on', when:'always', move:'yes'}`;
  - **'v0.50 migration: a messaging false was user-set'** — `coerceGlobalPolicy(undefined, {...v050Defaults, send_message: false}).send_message` equals `{access:'off'}`;
  - 'v0.50 migration: a control false is the new default' — `open_file: false` → `{access:'on', when:'viewing'}`, `open_session: false` → `access 'ask'`;
  - 'the new key wins over legacy' — `coerceGlobalPolicy({open_file:{access:'off'}}, {open_session:true})`: `open_session.access === 'ask'`, `open_file.access === 'off'`;
  - 'migrateToolOverrides' — `{open_session:true, send_message:false, bogus:true}` → `{open_session:{access:'on', when:'always'}, send_message:{access:'off'}}`; `{}`/`'x'` → `undefined`;
  - 'withPolicyPatch' — set, `{when:'inherit'}` deletes, emptied tool dropped, all empty → `undefined`, a deep-frozen input does not throw;
  - 'coercePolicyPatch rejects at the boundary' — `('open_file',{move:'no'})`, `('open_file',{access:'yes'})`, `('open_file',{})`, `('open_file','inherit')` → `null`; `('open_session',{when:'inherit', access:'on'})` → that object;
  - 'gate order' — `sessionId:null` → `not_in_session`; `messagingOn:false` → `messaging_off`; `access:'off'` → `tool_disabled` (message has the tool name, not "Settings"); `ownerReady:()=>false` → `window_not_ready`; viewing + `onScreen:()=>false` → `caller_not_visible`; `when:'always'` offscreen → `null`; a messaging tool with throwing thunks → `null`;
  - 'coercion never throws' — every coerce on `null`, `[]`, `1`, `'x'`, `{open_file:null}`, `{open_file:[]}`.
- [ ] Run `npx vitest run test/unit/conduit-mcp-tool-policy.test.ts test/unit/conduit-mcp-tool-switches.test.ts` — the first FAILS (module missing), the second stays green.
- [ ] Implement; both `tsc` projects green.

#### Task 1.2: `cliKindOfHandle`

**Files:** Modify `src/conduit-mcp/handles.ts`. Test `test/unit/conduit-mcp-handles.test.ts`.

**Interfaces:** Produces `cliKindOfHandle(handle: Handle): CliKind`. Consumes `type CliKind` (T1.1).

**Steps:**
- [ ] Failing test 'cliKindOfHandle maps the prefix' — `claude-1`→`claude`, `codex-12`→`codex`, `cursor-3`→`cursor`, `opencode-2`→`opencode`, `fake-1`→`agent`, `agent-4`→`agent`, `nodash`→`agent`, `''`→`agent`, `claude-x-1`→`agent`.
- [ ] Run — FAIL. Implement.

#### Task 1.3: `window-waits.ts`

**Files:** Create `src/conduit-mcp/window-waits.ts`. Test `test/unit/conduit-mcp-window-waits.test.ts`.

**Interfaces:** Produces the `window-waits.ts` block (Contracts). Consumes `JsonRpcId` (`src/conduit-mcp/json-rpc.ts:10`).

**Steps:**
- [ ] Failing tests (manual timer queue via deps):
  - 'answer ends once, from its window only' — `answer(id, 2, x) === false` when opened with `windowId: 1` (still pending); `answer(id, 1, x) === true` resolves `{kind:'answered', answer:x}`; again → `false`;
  - 'timeout expires and calls onUnanswered once'; a later answer → `false`;
  - 'cancel by predicate carries reply and clears timers' — two waits on conn 1, one on conn 2; `cancel(w => w.key.connId === 1, false) === 2`; both `{kind:'cancelled', reply:false}`; the third still pending; firing the cleared timers does nothing;
  - 'countFor counts per caller and drops after an end'; 'dispose ends all with reply false'.
- [ ] Run — FAIL. Implement.

#### Task 1.4: `window-presence.ts`

**Files:** Create `src/window-presence.ts`. Test `test/unit/window-presence.test.ts`.

**Interfaces:** Produces the `window-presence.ts` block (Contracts).

**Steps:**
- [ ] Failing tests: 'an unknown window is neither ready nor showing'; 'ready + visible → on screen; unreported id → false'; 'visible before ready counts once ready'; 'startLoading clears both'; 'windows are independent'; 'drop forgets'.
- [ ] Run — FAIL. Implement.

#### Task 1.5: New fields beside the old (settings, session, manager, persistence)

**Files:** Modify `src/settings.ts` (`AppSettings` `:189-190`, `DEFAULT_SETTINGS` `:255`, `coerceSettings` `:540`), `src/types.ts` (`Session` near `:120`), `src/session-manager.ts` (beside `setMcpToolOverride` `:330-340`), `src/persistence.ts` (`parseSessions` `:98-107`). Tests: `test/unit/coerce-settings.test.ts`, `test/unit/persistence.test.ts`, `test/unit/session-manager.test.ts` (add cases; old cases stay until T1.14).

**Interfaces:**
- Produces `AppSettings.mcpToolPolicy`, `AppSettings.mcpToolPolicyByCli`, `Session.mcpToolPolicy`, `setMcpToolPolicy(id: string, tool: ToolName, patch: ToolPolicyPatch): boolean` (Contracts). Old fields untouched.
- Consumes from T1.1: `GlobalPolicy`, `CliPolicyLayers`, `PolicyLayer`, `ToolName`, `ToolPolicyPatch`, `DEFAULT_TOOL_POLICY`, `coerceGlobalPolicy(v, legacy?)`, `coerceCliLayers(v)`, `coercePolicyLayer(v)`, `migrateToolOverrides(v)`, `withPolicyPatch(layer, tool, patch)`.

**Steps:**
- [ ] Failing tests:
  - coerce-settings: 'mcpToolPolicy absent → defaults; byCli absent → {}'; 'v0.50 mcpTools open_session true → {access:on, when:always, move:yes}'; 'v0.50 send_message false → {access:off}'; 'byCli keeps known kinds only'; 'round-trip keeps a CLI layer';
  - persistence: 'keeps a valid mcpToolPolicy'; 'migrates v0.50 mcpToolOverrides' (`{open_session:true, send_message:false}` → `mcpToolPolicy` `{open_session:{access:'on', when:'always'}, send_message:{access:'off'}}`); **'both keys: the old key overlays the new'** — `mcpToolPolicy: {open_file:{access:'off'}, open_session:{when:'viewing'}}` + `mcpToolOverrides: {open_session:true}` → `{open_file:{access:'off'}, open_session:{access:'on', when:'always'}}`; 'malformed policy dropped without dropping the session';
  - session-manager: 'create and duplicate never carry mcpToolPolicy'; 'setMcpToolPolicy sets, inherit deletes, unknown id → false, no emit when unchanged'.
- [ ] Run — FAIL. Implement; `tsc` green (old readers untouched).

#### Task 1.6: Wire types (additive)

**Files:** Modify `src/conduit-mcp/ui-types.ts` (`McpUiState` `:44-59`), `src/protocol.ts` (add beside `:566` and `:1074`), `electron/conduit-mcp-host.ts` (`uiState()` `:917`, one line), and every other `McpUiState` literal `tsc` names (e.g. the `webview/bridge.ts` preview mock, renderer test fixtures).

**Interfaces:** Produces `AskAnswer`, `AskClosedOutcome`, `AskSummary`, `McpUiState.awaitingApproval`, the six added protocol variants (Contracts). Consumes `ToolName`, `PolicySource`, `ToolPolicyPatch` (T1.1), `Handle`.

**Steps:**
- [ ] Type-only carve-out: the red step is `tsc` reporting `awaitingApproval` missing in the host's
  `uiState()` (`electron/conduit-mcp-host.ts:917`) and in renderer test fixtures/mocks that build
  an `McpUiState`. Fix each by adding `awaitingApproval: []` (host returns `[]` until T1.9).
  `tsc` green.

#### Task 1.7: Control tools — prepare/run, budgets, move; descriptions

**Files:** Modify `src/conduit-mcp/control-tools.ts` (`:8-63`, `reserve` `:169-188`, `open` `:216-275`, handlers `:277-318`), `src/conduit-mcp/tool-schemas.ts` (`:99-100`, `:114-115`). Test `test/unit/conduit-mcp-control-tools.test.ts`.

**Interfaces:**
- Produces the `control-tools.ts` block (Contracts). `openSession/openTerminal/openFile(caller, args)` stay as `prepare(…, {move: undefined})` then `run()` wrappers for the host until T1.9; T1.14 deletes them and `OPEN_RATE_*`.
- Consumes `TOOL_SPECS`, `type Move` (T1.1); `type AskSummary` (T1.6).

**Call sites:** `createControlHandlers` at `electron/conduit-mcp-host.ts:645`; handlers called from `runTool` (`:760-764`), unchanged in this task.

**Steps:**
- [ ] Failing tests:
  - 'prepare resolves and summarises' — summary `{tool:'open_session', path:'/home/c/w', agent:'a', focus:true}`;
  - 'move no forces focus false' (both session tools; summary too);
  - 'act budget' — 11th by one caller → `rate_limited`; 21st across callers → global;
  - 'show budget' — 31st `open_file` by one caller → `rate_limited`; act untouched;
  - 'a refusal after the reservation refunds' — 15 `path_missing` don't exhaust;
  - 'run failure refunds; success keeps' — `brief_unavailable` refunds;
  - 'release is idempotent'.
- [ ] Run — FAIL. Implement; description sentence verbatim.

#### Task 1.8: `call-flow.ts`

**Files:** Create `src/conduit-mcp/call-flow.ts`. Test `test/unit/conduit-mcp-call-flow.test.ts`.

**Interfaces:**
- Produces the `call-flow.ts` block (Contracts).
- Consumes `createWindowWaits<A, M>(deps): WindowWaits<A, M>` and `CallKey`, `Wait`, `WaitEnd`, `UnansweredEnd` (T1.3); `PreparedCall<T>` (T1.7); `CliKind`, `PolicySource`, `ToolName`, `ToolPolicy`, `ToolPolicyPatch` (T1.1); `AskAnswer`, `AskSummary` (T1.6); `HostToWebview` `mcp:ask` / `mcp:askClosed` (T1.6); `toolError`, `Result` (`src/conduit-mcp/types.ts`).

**Steps:**
- [ ] Failing tests (fake `prepare` returning a `PreparedCall` with spies on `run`/`release`; manual timers):
  - 'on runs once and returns the result';
  - 'ask sends mcp:ask to the owner and approve runs once' — one `sendToOwner` with `summary`, `source`; `flashOwner` once; `awaitingApproval()` contains the caller while waiting, empty after;
  - 'deny → denied, token kept' (`release` not called); 'expired → approval_timeout + askClosed expired'; 'reply-true cancel → cancelled'; 'reply-false cancel → null';
  - **'cancel during prepare → no run, released, null'**;
  - **'cancel during run (on) → null'** (run resolves after the cancel);
  - **'approve then cancel before run → run not called, token kept, null'**;
  - 'always writes the session policy, calls onPolicyWritten, runs'; **'always after the session is gone → cancelled, run not called'**;
  - 'a 4th waiting ask → rate_limited, released, no mcp:ask';
  - 'no owner window → window_not_ready, released';
  - **'no await between the cap check and open'** — two `runControl` calls started in the same tick for a caller with 2 waiting: exactly one `mcp:ask` sent, the other `rate_limited`;
  - **'answer from the wrong window is ignored'** — `answer(id, 9, 'approve') === false`, still waiting;
  - 'windowReset / sessionGone / sessionMoved end matching asks with cancelled'; 'connectionClosed → null';
  - 'recheck cancels asks whose access became off; all when messaging is off';
  - 'begin with a null requestId is never cancelled'; 'end() drops the entry; a later cancel for that id does nothing'.
- [ ] Run — FAIL. Implement.

#### Task 1.9: JSON-RPC + host cutover (+ host construction in main)

**Files:**
- Modify `src/conduit-mcp/json-rpc.ts` (deps `:24-30`, dispatch `:80-106`). Test `test/unit/conduit-mcp-json-rpc.test.ts` (deps `:18-33`).
- Modify `electron/conduit-mcp-host.ts` (imports; deps `:100-117` + new; interface `:148-172`; `listedTools` `:698-702`; `callTool` `:704-746`; `runTool` `:747-765`; core construction `:798-807`; `conn.onClose` `:842-859`; `uiState` `:904-938`; `onSessionDeleted` `:1245`; `refresh` `~:1263`; `handleRenderer` `:1270` + `:1343-1356`; `stop`). Test `test/unit/conduit-mcp-host.test.ts`.
- Modify `electron/main.ts`: `createConduitMcpHost({...})` `:1937-1984` (new deps; `mcpTools` stays until T1.14) and the `handleRenderer` call `:4525` (`senderId`); `const presence = createWindowPresence()` in the app-ready closure before the host.

**Interfaces:**
- Produces the json-rpc and host blocks (Contracts).
- Consumes `createCallFlow(deps): CallFlow`, `ASK_TIMEOUT_MS` (T1.8); `resolvePolicy`, `gateToolCall`, `coercePolicyPatch`, `TOOL_NAMES`, `isToolName`, `isMessagingTool` (T1.1); `cliKindOfHandle` (T1.2); `createWindowPresence`, `WindowPresence` (T1.4); `setMcpToolPolicy`, `Session.mcpToolPolicy`, `AppSettings.mcpToolPolicy/ByCli` (T1.5); protocol variants (T1.6); `prepareOpenSession/Terminal/File` (T1.7).

**Main deps in this task:** `toolPolicy: () => ({ global: settings.mcpToolPolicy, byCli: settings.mcpToolPolicyByCli })`; `ownerWindowOf: (id) => { const w = sessionOwner.get(id); return w !== undefined && windows.has(w) ? w : null; }`; `presence`; `sendToOwner`; `flashOwner: (id) => { const w = windowFor(id); if (w && settings.osAttention && !w.isFocused()) w.flashFrame(true); }`.

**Call sites:** `createMcpServerCore` — host `:798` and the json-rpc test. `handleRenderer` — `electron/main.ts:4525` and every `handleRenderer(` in `test/unit/conduit-mcp-host.test.ts` (add a `senderId`, `1` by default).

**Steps:**
- [ ] Failing json-rpc tests: 'tools/call passes the request id' (`{requestId: 7}`, `{requestId: 'a'}`, and `{requestId: null}` for `id: null`); 'a null call result sends no reply'; 'notifications/cancelled reaches cancelled()' (only string/number ids); 'other notifications still dropped'.
- [ ] Host harness: `toolPolicy` opt (default `{global: DEFAULT_TOOL_POLICY, byCli: {}}`); `setMcpToolPolicy` fake via `withPolicyPatch`; `ownerWindowOf` (default `() => 1`), `presence` (default ready + on screen), `sendToOwner` (records), `flashOwner` (records), `newAskId`, `setTimer`/`clearTimer` (manual). Existing control tests set the session policy `{access:'on'}` where they set an override `true`.
- [ ] Failing host tests:
  - 'gate precedence' — access off + window not ready → `tool_disabled`; `presence.isReady` false → `window_not_ready`; `isOnScreen` false + viewing → `caller_not_visible`, no `sendToOwner`, no control dep call;
  - 'tools/list is resolved access ≠ off; master off lists all';
  - 'session layer beats the CLI layer' (spec Gherkin 2 on `open_file`, `fake-1` → `agent` layer);
  - 'ask end to end' — `mcp:ask` sent; `handleRenderer({type:'mcp:askAnswer', askId, answer:'approve'}, reply, 1)` → result ok, `openSession` once;
  - **'askAnswer from another window is ignored'** — `senderId 2` → still waiting; then `1` approves;
  - **'notifications/cancelled → no reply line on any path'** — for a waiting ask, for an `on` call whose `kindOf` is held, and for a `list_sessions` call cancelled before its store read resolves: the connection never receives a line with that id;
  - 'connection close / onWindowReset(1) / onSessionMoved / onSessionDeleted cancel' — the latter three reply `cancelled`; `onSessionDeleted` cancels before `closeConnectionsOf` (the reply line is written);
  - 'refresh after access → off cancels the waiting ask';
  - 'a waiting ask doesn't block another call on the same connection';
  - 'uiState.awaitingApproval lists the waiting caller';
  - 'mcp:setToolPolicy replies unknown-session / unknown-tool / invalid-value / ok' and sends `list_changed` when the list changed.
- [ ] Run both files — FAIL. Implement; the host keeps handling the old `mcp:setToolOverride` until T1.14. `tsc` green.

#### Task 1.10: Main events

**Files:** Modify `electron/main.ts`:
- `createWindow` opts `:1026-1031` + listener near `:1150`: `w.webContents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) opts.onNavigationStart(w.id); })`;
- `spawnWindow` `:5099-5125`: `onNavigationStart: (id) => { presence.startLoading(id); mcpHost.onWindowReset(id); }`; `onGone` adds `presence.startLoading(windowId); mcpHost.onWindowReset(windowId);` (r1 #8); `onClosed` adds `presence.drop(windowId); mcpHost.onWindowReset(windowId);`;
- `moveSessionToWindow` `:2250`: `mcpHost.onSessionMoved(sessionId)` after `assignOwner`;
- `case 'ready'` `:2872`: `presence.markReady(senderId)`; `case 'visible'` `:3827`: `presence.setVisible(senderId, m.ids)`;
- `openMcpFile` `:2568-2575`: `const sessionId = req.callerSessionId;` (drop `resolveOwningSession` here; remove its import if unused);
- `mcp:*` case list `:4519-4525`: add `mcp:setToolPolicy`, `mcp:askAnswer` (old `mcp:setToolOverride` stays until T1.14).

**Interfaces:** Consumes `presence` (T1.9), `ConduitMcpHost.onWindowReset(windowId: number)`, `onSessionMoved(sessionId: string)` (T1.9).

**Steps:**
- [ ] Wiring carve-out: no main unit harness. Red step: `tsc` errors for `onNavigationStart` missing in `spawnWindow` after adding it to the opts type. Proof: `tsc` green + S3 e2e phases "viewing refusal" and "reload cancels".
- [ ] Implement exactly these bullets.

#### Task 1.11: Strings + shared editor

**Files:** Create `webview/components/tool-policy-editor.tsx`. Modify `webview/conduit-mcp-strings.ts` (tools block `:205-226`, adding the T1.11 keys beside the old ones), `webview/styles.css` (append `.policyrow*`, `.policycli*` after the `.settools` rules). Test create `test/unit/tool-policy-editor.test.tsx`.

**Interfaces:**
- Produces `ToolPolicyEditor` / `ToolPolicyEditorProps` and the T1.11 `MCP_STR.tools` keys (Contracts).
- Consumes `TOOL_GROUPS`, `TOOL_SPECS`, `resolvePolicy` and the policy types (T1.1); `SegmentedRadios` (`label`, `value`, `options`, `onChange`, `disabled`, `selectOnArrow`).

**Rendering rules:**
- Per group: `<div role="group" aria-labelledby>` with an `h4` from `MCP_STR.tools.group[group]`.
- Per tool (`<section className="policyrow" data-tool={tool}>`): name (`code`), description, Access `SegmentedRadios` (`label={accessLabel(tool)}`, `selectOnArrow={false}`, options `TOOL_SPECS[tool].access`, plus `inherit` first labelled `inherited(<value>, sourceName(<source>))` unless `layer === 'global'`).
- Shown value: the layer's own field (global: `layers.global[tool][f]`; else `layers[layer]?.[tool]?.[f] ?? 'inherit'`). The Inherit label comes from `resolvePolicy(tool, <layers without the current layer>)`.
- Tools with more fields: `button.policyrow__cond` (`aria-expanded`, `MCP_STR.tools.conditions`) toggling native `select`s per applicable non-access field (`aria-label={fieldAria(tool, field)}`, `data-field`), Inherit first unless global. A non-applicable field renders nothing.
- `p.policyrow__warn` with `onWarning[tool]` when defined and the full-stack resolved access is `'on'`; `failed?.has(tool)` → `p.policyrow__error` with `saveFailed`.

**Steps:**
- [ ] Failing tests: 'global layer has no Inherit'; 'session layer shows inherited value and source' (`Inherit (Off · from Codex)`); 'conditions render only applicable fields'; 'onChange reports tool, field, value' (`('open_terminal','access','ask')`, `('open_session','when','inherit')`); 'open_terminal warning only when resolved on'.
- [ ] Run — FAIL. Implement with existing tokens only.

#### Task 1.12: Session dialog, hook, app mount, mocks

**Files:** Modify `webview/components/mcp-tools-dialog.tsx` (whole), `webview/use-conduit-mcp.ts` (`:2`, `:31`, `:93-100`), `webview/app.tsx` (dialog mount `:4797-4815` only), `test/unit/message-compose.test.tsx:51`, `test/unit/messages-pane.test.tsx:125`, `test/unit/right-pane-review-kebab.test.ts:105`. Test `test/unit/mcp-tools-dialog.test.tsx`.

**Interfaces:**
- Produces `McpToolsDialogProps`, `ConduitMcpApi.setToolPolicy` (Contracts); removes `setToolOverride` from `ConduitMcpApi`.
- Consumes `ToolPolicyEditor` (T1.11); `coercePolicyPatch`, `withPolicyPatch`, `GlobalPolicy`, `CliPolicyLayers` (T1.1); `cliKindOfHandle` (T1.2); protocol `mcp:setToolPolicy` / `mcp:toolPolicyResult` (T1.6); `Session.mcpToolPolicy`, `AppSettings.mcpToolPolicy/ByCli` (T1.5).

**Steps:**
- [ ] Failing tests: 'picking Ask posts a one-field patch' (`('open_session', {access:'ask'})`); 'a refused change reverts that tool only and shows saveFailed'; 'a late older pick cannot undo a newer one'; 'inherit labels name the CLI from the handle' (`codex-2` → `from Codex`; no handle → `from All CLIs`).
- [ ] Run — FAIL. Implement: `layers = { session: shown, cli: kind ? byCli[kind] : undefined, global }`; editor `onChange(tool, field, value)` → `coercePolicyPatch(tool, { [field]: value })` → optimistic `withPolicyPatch` → revert on `false`. App passes `global={settings.mcpToolPolicy}`, `byCli={settings.mcpToolPolicyByCli}`, `onChange={(tool, patch) => mcp.setToolPolicy(target.id, tool, patch)}`. Rename the three mocks.

#### Task 1.13: Settings MCP tab rows

**Files:** Modify `webview/components/settings-modal.tsx` (`TOOL_GROUPS` + `McpToolSwitchRows` `:855-905` → `McpToolPolicyRows`; use `:959-961`). Test `test/unit/settings-mcp-tools.test.tsx`.

**Interfaces:** Consumes `ToolPolicyEditor` (T1.11); `coerceGlobalPolicy`, `coercePolicyPatch`, `withPolicyPatch`, `CLI_KINDS`, `CliKind` (T1.1); `AppSettings.mcpToolPolicy/ByCli` (T1.5); `MCP_STR.tools.defaultsFor`, `cliName`, `layerName`, `cliLayerNote` (T1.11).

**Rendering rules:** `div.policycli[role="tablist"][aria-label=defaultsFor]` of `role="tab"` buttons, `data-cli="all"` then `CLI_KINDS`, ArrowLeft/Right move and select, default `'all'`. `'all'` → `layer:'global'`, writes `update({ mcpToolPolicy: coerceGlobalPolicy({ ...g, [tool]: { ...g[tool], [field]: value } }) })` (ignores `'inherit'`). A CLI tab → `layer:'cli'`, writes `mcpToolPolicyByCli` with `[kind] = withPolicyPatch(byCli[kind], tool, patch)` (key removed when `undefined`), `patch = coercePolicyPatch(tool, { [field]: value })` (skip when null). `cliLayerNote` on CLI tabs; `masterOffHint` + `disabled` when the master is off; `overrideNote` stays.

**Steps:**
- [ ] Failing tests: 'All CLIs: On for open_terminal posts mcpToolPolicy.open_terminal.access on'; 'Codex tab: Off for open_file posts mcpToolPolicyByCli.codex.open_file.access off'; 'Codex tab: Inherit drops an empty kind'; 'master off disables every control'.
- [ ] Run — FAIL. Implement.

#### Task 1.14: Remove the old API together

**Files:** Delete `src/conduit-mcp/tool-switches.ts`, `test/unit/conduit-mcp-tool-switches.test.ts`. Modify:
- `src/settings.ts` (drop `mcpTools` field/default/coerce; keep reading `payload.mcpTools` for migration), `src/types.ts` (drop `mcpToolOverrides`), `src/session-manager.ts` (drop `setMcpToolOverride`), `src/persistence.ts` (drop the old field; the overlay and deletion of the raw key stay);
- `src/protocol.ts` (drop `mcp:setToolOverride`, `mcp:toolOverrideResult`);
- `src/conduit-mcp/control-tools.ts` (drop `openSession/openTerminal/openFile`, `OPEN_RATE_*`);
- `src/conduit-mcp/json-rpc.ts`, `src/mcp-launch.ts` (import from `./tool-policy` / `./conduit-mcp/tool-policy`);
- `electron/conduit-mcp-host.ts` (drop `mcpTools` dep, `setMcpToolOverride` Pick, the `mcp:setToolOverride` case), `electron/main.ts` (drop `mcpTools:` dep `:1954` and the `mcp:setToolOverride` case);
- `webview/conduit-mcp-strings.ts` (drop `groupMessaging`, `groupControl`, `inherit`, `on`, `off`);
- tests: `coerce-settings` (old `mcpTools` block `:472-497` → the T1.5 cases), `persistence` (`:386-443`), `session-manager` (`:614-646`), host test override cases.

**Steps:**
- [ ] Run the slice Check's `git grep`; every hit outside the allowed migration reads is in this task's list. Remove; `tsc` green; run the slice Check.

---

### Slice 2: Ask UI — store, card, chip, badge

**Check:**
- `npx vitest run test/unit/mcp-ask-store.test.ts test/unit/approval-card.test.tsx test/unit/attention.test.ts test/unit/session-card-ask.test.tsx test/unit/toasts.test.ts test/unit/drag-region.test.ts test/unit/monaco-class-collision.test.ts` green;
- `npm run verify:quick` green.

**Parallel groups:** Serial first: T2.1 · then G1: T2.2 · G2: T2.3 · G3: T2.4 · Serial last: T2.5
**Claims (serial lane):** `webview/conduit-mcp-strings.ts` (T2.1); `webview/styles.css` (T2.2); `webview/app.tsx` (T2.5)

#### Task 2.1: Ask store + ask strings

**Files:** Create `webview/mcp-ask-store.ts`. Modify `webview/conduit-mcp-strings.ts` (`ask` block). Test create `test/unit/mcp-ask-store.test.ts`.

**Interfaces:** Produces the store block and `MCP_STR.ask` (Contracts). Consumes `subscribe`, `post` (`webview/bridge.ts`); `pushToast({message, variant:'info'})` (`webview/toast-store.ts`); protocol `mcp:ask`, `mcp:askClosed`, `mcp:askAnswer` (T1.6).

**Steps:**
- [ ] Failing tests (bridge mocked): 'mcp:ask appends oldest first'; 'answerAsk posts mcp:askAnswer and removes it'; 'askClosed expired removes and toasts "Request from fake-1 expired"'; 'cancelled toasts the cancelled copy'; 'askClosed for an unknown id is ignored'; 'requestAskFocus notifies focus subscribers'.
- [ ] Run — FAIL. Implement as a module singleton (`useSyncExternalStore`).

#### Task 2.2: Approval card + CSS

**Files:** Create `webview/components/approval-card.tsx`. Modify `webview/styles.css`: `--layer-ask: 90;` in the `:root` layer tokens (`:277-280`; band comment: "asks above toasts, below popovers"), `.askcard*`, `.session__ask`. Test create `test/unit/approval-card.test.tsx`.

**Interfaces:** Produces `ApprovalCard` (Contracts). Consumes `useAsks`, `answerAsk`, `subscribeAskFocus`, `MCP_STR.ask` (T2.1); `cliKindOfHandle` (T1.2); `MCP_STR.tools.cliName` (T1.11).

**Rendering rules:**
- `createPortal` to `document.body`; null with no asks.
- `<section className="askcard" role="region" aria-label={region} tabIndex={-1}>`: title, summary (`summary[tool](summary)`), reason (`cli` → `reason.cli(cliName[cliKindOfHandle(handle)])`), a `button.askcard__rawtoggle` (`aria-expanded`, `aria-controls`) labelled `rawArgs` that discloses `<pre className="askcard__args">{JSON.stringify(args, null, 2)}</pre>`, collapsed for every ask including after paging, buttons `button[data-answer="deny"|"approve"|"always"]` in that order, pager only when n > 1; shows the oldest by default; index clamps when asks leave.
- Never focuses itself on arrival. On a focus request: remember `document.activeElement`, focus the region. Esc in the card returns focus there without answering.
- Each new askId → `announce(title(handle, tool))`.
- CSS: `position: fixed; top: calc(var(--density-topbar-h) + 8px); right: 16px; width: min(360px, calc(100vw - 32px)); z-index: var(--layer-ask);` surface and border tokens as `.toast`; `.askcard__args` monospace, bounded height, `overflow: auto`, `overflow-wrap: anywhere`; forced-colors like `.toast`. `.session__ask` uses the accent `.attnchip__dot` uses, always with its text.

**Steps:**
- [ ] Failing tests: 'renders title, summary and reason' (`fake-1 requests open_session`, `Ask: set for Other`); 'does not take focus on arrival'; 'Approve/Deny/Always call answerAsk with that answer'; 'pager 1 of 2 → next'; 'Esc returns focus without answering'; 'announces each new ask once'.
- [ ] Run — FAIL. Implement.

#### Task 2.3: Chip counts asks

**Files:** Modify `src/attention.ts` (`:86-130`), `webview/components/top-bar.tsx` (props `~:60-66`, `:77-90`). Test `test/unit/attention.test.ts`.

**Interfaces:** Produces `AttentionAsk`, the `'ask'` kind, the defaulted parameter, top-bar `asks?`, `onFocusAsk?` (Contracts). Consumes `MCP_STR.ask.chipReason` (T2.1).

**Call sites:** `attentionEntries` — `webview/components/top-bar.tsx:77`, `test/unit/attention.test.ts:148-170`.

**Steps:**
- [ ] Failing tests: 'asks come first and are not snoozable' (keys `['ask:a1','session:s2']` with the ask's session snoozed); 'chip label counts asks'.
- [ ] Run — FAIL. Implement; first `ask` entry → title `chipReason(handle)`, click → `onFocusAsk`.

#### Task 2.4: Session card button

**Files:** Modify `webview/components/session-card.tsx` (props `~:84`; beside the mcp badge `~:216-226`), `webview/components/sidebar.tsx` (props `:68,106`; `:415`). Test create `test/unit/session-card-ask.test.tsx`.

**Interfaces:** Produces the optional props (Contracts). Consumes `MCP_STR.ask.waiting` (T2.1).

**Rendering rule:** when `awaitingApproval && !editing`: `<button type="button" className="session__ask" onClick={(e) => { e.stopPropagation(); onFocusAsk?.(); }}>{waiting}</button>` (nested buttons are the card's existing pattern, `:244-290`).

**Steps:**
- [ ] Failing tests: 'shows only while awaiting'; 'click calls onFocusAsk and does not select the session'.
- [ ] Run — FAIL. Implement; sidebar passes `awaitingApproval?.has(s.id)` and `onFocusAsk`.

#### Task 2.5: App wiring

**Files:** Modify `webview/app.tsx`: `<ApprovalCard announce={(t) => { if (navLiveRef.current) navLiveRef.current.textContent = t; }} />` before `<Toasts />` (`:4821`); `TopBar` (`:4663-4675`) gets `asks={asks}`, `onFocusAsk={requestAskFocus}` with `const asks = useAsks();`; `Sidebar` (`:4518`) gets `awaitingApproval={awaiting}` (`useMemo(() => new Set(mcp.state?.awaitingApproval ?? []), [mcp.state])`) and `onFocusAsk={requestAskFocus}`.

**Interfaces:** Consumes T2.1–T2.4 and `McpUiState.awaitingApproval` (T1.6).

**Steps:**
- [ ] Wiring carve-out: proof is the slice Check and the S3 phases "ask deny" (card never steals focus, chip counts 1).
- [ ] Implement exactly these edits.

---

### Slice 3: E2E + changelog

**Check (end of feature, once):** `npm run verify` green; `npm run e2e:remote -- conduit-mcp-policy conduit-mcp-policy-migrate conduit-mcp-control conduit-mcp-control-terminal` green; `npm run e2e:remote` (`--affected`) green. During the slice: `node --check <file>` for each touched `.mjs`, and `npm run verify:quick`.

**Parallel groups:** Serial first: T3.1 · then G1: T3.2 · G2: T3.3 · G3: T3.4 · G4: T3.5
**Claims (serial lane):** `test/e2e/conduit-mcp-helpers.mjs`, `test/e2e/fixtures/fake-mcp-agent.mjs` (T3.1); `CHANGELOG.md` (T3.5)

#### Task 3.1: Fake agent + helpers

**Files:** Modify `test/e2e/fixtures/fake-mcp-agent.mjs` (header `:12-19`; `rpc` `:66-73`; `submit` `:162-205`), `test/e2e/conduit-mcp-helpers.mjs` (`enableToolViaDialog` `:274-302`; new helpers).

**Interfaces (used by T3.2–T3.4):**
```js
// fake: `call` records CALL {"seq","tool","id"} before awaiting; `cancel` sends
// notifications/cancelled {requestId: <last call id>, reason:'e2e'} and records CANCEL {"seq","id"}.
/** @param {'On'|'Off'|'Ask'|'Inherit'} value — clicks `[role="radiogroup"][aria-label="${tool} access"] [data-seg]` and waits for window.__sessions[].mcpToolPolicy?.[tool]?.access (null for Inherit). */
export async function enableToolViaDialog(page, sessionId, tool, value)
/** Posts mcp:setToolPolicy through the bridge and waits for the session to reflect `patch`. */
export async function setSessionPolicy(page, sessionId, tool, patch)
/** updateSettings with settings.mcpToolPolicy[tool] = policy (merged over the current); waits for the broadcast. */
export async function setGlobalPolicy(page, tool, policy)
/** Types `call …` without waiting; resolves the RESULT count before it. */
export async function startCall(page, sessionId, tool, args)
/** The first RESULT after `before`, or null after `ms`. */
export async function resultAfter(sessionId, before, ms)
/** Clicks `.askcard button[data-answer="<answer>"]`. */
export async function clickAskAnswer(page, answer)
```

**Steps:** [ ] Implement; `node --check` both files.

#### Task 3.2: Existing control scenarios on the new defaults

**Files:** Modify `test/e2e/conduit-mcp-control.e2e.mjs`, `test/e2e/conduit-mcp-control-terminal.e2e.mjs` (`:49`).

**Changes:**
- `conduit-mcp-control`: `enableToolViaDialog(…'open_session','On')` stays. Before "focused open", click main's card and wait until active. "disabled worker" (`:99-103`): first `enableToolViaDialog(page, worker.sessionId, 'open_session', 'Off')`, then expect `tool_disabled`. "open_file": drop the `enableToolViaDialog(…'open_file','On')`; keep main active; assert `f.session_id === main.sessionId`.
- `conduit-mcp-control-terminal`: after `enableToolViaDialog(…'open_terminal','On')`, `setSessionPolicy(page, <caller>, 'open_terminal', { when: 'always' })` so view-moving phases don't become visibility tests.

**Steps:** [ ] Edit; `node --check`.

#### Task 3.3: `conduit-mcp-policy` scenario

**Files:** Create `test/e2e/conduit-mcp-policy.e2e.mjs` (`runScenario('conduit-mcp-policy', …, { userDataDir: fakeAgentProfile('policy') })`, shaped like `conduit-mcp-control.e2e.mjs`).

**Phases (fakes A and B; A active unless stated):**
1. **off** — `setGlobalPolicy(page,'open_session',{access:'off'})`: A's `toolsSeen` drops `open_session` after `LIST_CHANGED`; call → `tool_disabled`.
2. **ask deny** — `setGlobalPolicy(…,{access:'ask', when:'viewing', move:'yes'})`; `startCall(A,'open_session',…)`; `.askcard` shows A's handle and `open_session`; `document.activeElement` not inside `.askcard`; chip counts 1; `clickAskAnswer(page,'deny')` → RESULT `denied`; session count unchanged.
3. **ask approve** — same, `clickAskAnswer(page,'approve')` → `session_id`; it exists.
4. **always** — click A active; call; `clickAskAnswer(page,'always')` → ok; A's `mcpToolPolicy.open_session.access === 'on'`; the next call shows no `.askcard` within 1 s and succeeds.
5. **viewing refusal** — click B active; `callTool(A,'open_file',{path:'fixture.txt'})` → `caller_not_visible`; after 1 s no `.tabbar [role="tab"]` with text `fixture.txt`; active still B.
6. **move:no** — click A active; `setSessionPolicy(page, A, 'open_session', {move:'no'})`; `focus:true` open → ok; after 1.5 s active still A.
7. **CLI cancel** — `setSessionPolicy(page, A, 'open_session', {access:'ask'})`; `startCall`; `.askcard` appears; type `cancel` into A; `.askcard` detaches within 5 s; `resultAfter(A, before, 2_000) === null`; no new session.
8. **reload cancels** — `startCall`; `.askcard` appears; `page.reload()`; after `.session` cards return, re-run `tapMcp(page)`; RESULT `cancelled` within 10 s; no `.askcard` and **no `.toast` containing "Request from"** in the reloaded window within 2 s.
9. **cleanup** — kill sessions, remove dirs.

**Steps:** [ ] Write; `node --check`.

#### Task 3.4: `conduit-mcp-policy-migrate` scenario

**Files:** Create `test/e2e/conduit-mcp-policy-migrate.e2e.mjs`.

**Shape:** `fakeAgentProfile('policy-migrate')`, then write `<userDataDir>/settings.json` =
`{"version":1,"settings":{"conduitMcp":true,"mcpTools":{"list_sessions":true,"send_message":false,"read_inbox":true,"read_attachment":true,"open_session":true,"open_terminal":false,"open_file":false}}}` before `runScenario`.

**Phases:**
1. Fakes A and B; B active. `callTool(A,'open_session',…)` → ok, no `.askcard` (migrated `when:'always'`).
2. `callTool(A,'open_file',…)` → `caller_not_visible` (control `false` → default on/viewing).
3. `callTool(A,'send_message',{to:[B handle], body:'x'})` → `tool_disabled` (messaging `false` → off).
4. `setMessaging(page, true)` (forces a write); read `settings.json`: no `settings.mcpTools`; `settings.mcpToolPolicy.open_session` deep-equals `{access:'on', when:'always', move:'yes'}`; `settings.mcpToolPolicy.send_message` deep-equals `{access:'off'}`.

**Steps:** [ ] Write; `node --check`.

#### Task 3.5: CHANGELOG

**Files:** Modify `CHANGELOG.md` (`## [Unreleased]`).

**Steps:** One `### Changed` entry:
- tool switches became policies: Off · Ask · On per tool, plus when / move, for all CLIs, per CLI, and per session;
- **Ask** shows a card in the agent's window — Approve, Deny, Always for this session; Codex can no longer run a tool Conduit asks about without you;
- new defaults: `open_file` **On** (was off), `open_session` **Ask** (was off); control tools act only while the agent's session is on screen unless set to Always;
- v0.50 settings migrate (enabled tools → On · Always; a messaging tool you turned off stays off); downgrading to v0.50 loses policies and returns to its defaults.

## Verification

- **Per task:** named vitest file(s) red then green; in S1 also both `tsc` projects.
- **Per slice:** the slice's Check, ending in `npm run verify:quick`.
- **Once, after S3:** `npm run verify`; `npm run e2e:remote -- conduit-mcp-policy
  conduit-mcp-policy-migrate conduit-mcp-control conduit-mcp-control-terminal`; `npm run
  e2e:remote` (`--affected`). A local e2e failure is confirmed remotely before bisecting.
- At most one local e2e by exact name. Exit codes captured directly, never through a pipe.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a
shim, second copy, special case, widened type, fallback, or an override patched in place of its
semantic source. The report leads with the fix that keeps the locked decision. (The old API kept
beside the new inside S1 is the planned additive cutover, removed by T1.14 — not a shim.)

## Decisions Needed

- [normal] **N1:** `reach` has no Part A tool, so `out_of_reach` and the spec's "reach refusal" e2e
  can't be built here. Default taken: types, coercion and editor carry `reach`; enforcement and
  e2e ship with Part B.
- [normal] **N3:** Card placement: "stacked above toasts" taken as z-order (`--layer-ask: 90`); the
  card sits top-right below the top bar so it never covers toasts or the terminal input row.
- [normal] **N4:** `flashOwner` follows the existing OS attention setting (`settings.osAttention`).
- [normal] **N5:** Turning the master switch off cancels every waiting ask (`cancelled`).
- [normal] **N6:** A 4th waiting ask is refused `rate_limited` before any card, and its token is
  refunded.
- [normal] **N7:** Readiness keys on main-frame cross-document `did-start-navigation` plus
  `render-process-gone`, not the literal `did-start-loading`.
- [normal] **N8:** No F6 pane cycling exists; the card is reached from the chip and the session
  card button only.
- [normal] **N9:** For Part B (from S0): handle-less sessions are not in `list_sessions`; Part B's
  resolver accepts only listed sessions.
- [normal] **N10:** The Level-1 file `ask-broker.ts` is replaced by the generic `window-waits.ts`
  + `call-flow.ts` (r1 #5, conductor-accepted). Default taken: the r1 shape.

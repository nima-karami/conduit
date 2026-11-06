# Spaces and agent tree: implementation plan

**Status:** active, Revisions 1–2 (2026-11-02).
**Spec:** `docs/specs/archive/2026-11-02-sidebar-agent-tree.md`.
**Tier:** FULL. Six slices, four lanes; lead contracts/foundation first, G4 after G1/G2 merge. Revision 1 supersedes earlier completion, CSS, font and ownership decisions.

## Goal
Implement Spaces/agent hierarchy, header toggles, center footer and local fonts, with server-produced completion facts and a single App authority for view state.

## Architecture
ServerAttention owns reason/completion facts. Pure src modules consume these facts, renderer seen/stateSince and window UI state to build the forest/footer. App owns strict Done viewing, window UI hydration and right-pane effective view. Existing legacy needsAttention/OS behavior remains. App passes callbacks into a pure extracted menu builder. G1 owns that builder after extraction. G1/G2 replace their CSS sections in place; lead owns tokens/other sections. Font assets enter through webview/fonts.ts; app boot loads selected faces once before first terminal mount, with log-and-continue failure.

## Data flow
```
runtime status/output -> SessionActivity qualifying evidence + ServerAttention
 -> statusOf(reason, completions, legacy flags) -> services.withStatus
 -> SessionView snapshot/sessions.changed -> App
 -> seen/stateSince + strict viewed terminal -> tree/footer -> components
loose active+split ui.presence -> server Needs-you arming (unchanged)
window create/restore -> one window:sidebarInit -> App (never recurring state)
UI sidebar update -> sender-scoped window:sidebar -> windows.json
App panel open -> mount -> imperative search/reveal/thread
entry fonts side effect -> one boot load -> synchronous terminal mounts
loadingdone -> every registered Terminal.clearTextureAtlas/refresh/fit/facts
```
No session/project migration, persisted completion/seen state, renderer run-end inference, duplicate paneTab/local tab, or per-pane asynchronous terminal constructor.

## Settled decisions
Revision .autoloop/revision-1.md B1/B2/B3/S1–S8 is authoritative. Distinct Needs you vs Done; strict personal viewing vs loose server visibility intentional. Keep powershell/terminal literals; add codex/opencode/cursor/gemini only. Lead pre-adds all agent SessionGlyph variants at S0; G1/G2 may directly import lucide-react for monitor/grid/toggle icons. No shared icons.tsx lane edits. No rail threshold invented, no manual row reorder, keep existing Space drops. Keep right-panel move grip. All approved A–E ships together.

Revision 2: G1 removes the sidebar UpdateCard mount; G2 owns UpdateCard and its shared floating toast outlet. Every existing visible update state uses the same fixed window-bottom-right anchor above the status bar, overlays content and never shifts layout. Download percent and existing Dismiss/Relaunch actions only; What's new link is out of scope. Reuse Toasts, not a second overlapping stack.

## Source grounding / contradictions
- `server/attention/index.ts:169` marks any departure from Working completed, including Blocked, and :176 emits legacy run-end for waiting. New counter counts Working→Done/Idle; Blocked is reason-only. Preserve old needsAttention/edge behavior separately.
- `src/session-activity.ts:135` discards visible evidence, :209 acknowledges before evaluation, :222 skips armed episodes. Counting current edges cannot implement all qualifying completions. Add independent completion evidence with same duration/byte/quiet/grace thresholds, irrespective of visibility/legacy latch.
- `server/services.ts:110`, :144, :218 already decorate/broadcast status; counter-only/reason-only changes must invalidate sessions too. Coalesced snapshots preserve counters.
- `src/contracts/server-protocol.ts:104` SessionView inherits Session; `src/contracts/server-ports.ts:141` inherits statusOf from SessionActivity. Explicitly extend both seams; src/persistence.ts:30 strips runtime fields by name, so new fields must be stripped too.
- `server/domain/index.ts:465` constructs typed SessionView values before attention decoration. Add neutral null/0 facts there; services.ts:118/:294 always decorates outgoing events/snapshots with authoritative ServerAttention facts. The domain never increments counters or persists reasons.
- Selector is data-sessionid (`session-card.tsx:140`); preserve it. WindowLayout has bounds/IDs only (`src/window-registry.ts:143`), reconciliation :210 reconstructs entries. Dropped empty-window UI loss accepted.
- `right-pane.tsx:131` has local tab; `webview/app.tsx:1748` has paneTab duplication. App opens hidden pane at :941/:948 before imperative routes; unify all routes, do not rely on missing child ref. Existing transient preference semantics (:139/:188) remain.
- `webview/app.tsx:3073` onward contains session-menu logic; extract whole builder, including all actions through close-all, not only the approximate review anchor.
- `webview/index.tsx:1` currently imports setup/styles then renders directly; settings boot from initialSettings (`webview/settings.tsx:96`). Font boot must use actual selected boot settings, not defaults.
- `terminal-pane.tsx:1086` currently fits/facts on font event; no atlas invalidation. Same-value family assignment at :1190 is insufficient. Installed xterm typings unavailable here; Revision 1 mandates public Terminal.clearTextureAtlas, to typecheck on implementation environment.
- `webview/components/sidebar.tsx:632` mounts UpdateCard in .sidebar__update; styles.css:7452 makes the card sticky. `webview/components/toasts.tsx:13` already portals one fixed outlet to body; styles.css:6931 anchors it at 16px. Reuse that outlet, replacing its anchor with shared footer geometry. UpdateCard currently has available/downloading/ready branches (:17/:42), no What's new action; numeric download percent exists in Settings About (:1366) but the card only shows bar width (:34). App dismissal resets on ready (:775); preserve it.
- Board/Canvas/Open editor palette routes already exist (`webview/app.tsx:4031/:4050/:4059`); command default Mod+Shift+P (`webview/shortcuts.ts:35`). No duplicate command IDs/default chords.

## Global constraints
Per lane: `npm run verify:quick`, `node esbuild.mjs`, named unit command. Integration: `npm run verify` then `npm run e2e:remote -- --full`; no weakened checks. Node package.json:9 range ^22.22.2 || ^24.15.0 || >=26.0.0; npm/Vitest. Files kebab-case; tests test/unit/<module>.test.ts, e2e test/e2e/<scenario>.e2e.mjs. Ubuntu units use portable paths. CLAUDE.md: why-comments, no specificity/source-order patches/!important/swallowed errors/as any; git runGitBin, watch watchDir. Scratch only absolute OS temp paths, cleaned. No lane changes another owner's paths/sections.

## Out of scope
Remote machines, MCP API renames, vendor logos, manual reorder, new rail mode, changed TERM, session caps and notification redesign.

## Contracts (lead implements and commits in S0)

```ts
// src/types.ts — optional on legacy Session, required facts at server boundary
export type AttentionReason = 'blocked' | 'bell' | null;
export interface SessionAttentionFacts {
  attentionReason: AttentionReason;
  completions: number;
}
// Add to Session, runtime only:
attentionReason?: AttentionReason;
completions?: number;
// SessionIconKind keeps existing literals, no alias layer:
export type SessionIconKind = 'claude' | 'powershell' | 'terminal'
  | 'codex' | 'opencode' | 'cursor' | 'gemini';

// src/contracts/server-protocol.ts — existing alias becomes
export type SessionView = Omit<Session, AppSessionField> & SessionAttentionFacts & {
  runtime: SessionRuntime;
  exitCode?: number | null;
};
// src/contracts/server-ports.ts — replace inherited statusOf with explicit richer result
export type ServerAttentionSnapshot = ActivitySnapshot & SessionAttentionFacts;
// AttentionPort still inherits lastOutputAt/setVisible/dropWindow, plus existing methods:
statusOf(sessionId: string): ServerAttentionSnapshot;
// src/session-activity.ts — add to existing SweepResult:
completedIds: string[];
```
ActivitySnapshot remains legacy flags. SessionActivity returns one completedIds occurrence per qualifying heuristic run, independent of loose visibility/legacy armed status; bells alone do not complete. ServerAttention increments one final per-session counter on eligible completedIds only when no reported status is authoritative, and on reported Working→Done/Idle. Do not double count reported output. Counter survives spawn/exit/reset, removed on forget, reset with server instance. New reason uses reported Blocked or genuine bell under existing loose visibility; clear on acknowledgment/Working/exit as applicable, no bell synthesized from terminal control strings. Legacy needsAttention/attention.edge fixtures remain byte-for-byte behavior-compatible. onChange includes every reason/counter mutation. Absent/malformed old facts normalize to null/0 at the app compatibility boundary; counters are finite nonnegative integers. Strip both on serialization AND restore parsing; no disk version change.

Legacy consumers preserved: `src/session-icon.ts:52`, `src/attention.ts:10/:108`, `src/session-groups.ts:79`, `electron/server-events.ts:160` OS edge/flash, `electron/main.ts:2302` notification copy. New sidebar/footer explicitly use the new model; notifications still use old edges, not completion counter changes.

```ts
// src/sidebar-state.ts — imports Session, AttentionReason from ./types
export type AgentState = 'blocked' | 'done' | 'working' | 'idle' | 'stopped';
export type AgentGroup = 'pinned' | AgentState;
export type SpaceSelection = { kind: 'all' } | { kind: 'none' } | { kind: 'space'; projectId: string };
export interface SidebarUiState {
  selection: SpaceSelection; foldedGroups: AgentGroup[];
  foldedSessions: string[]; pinnedIds: string[];
}
export interface AgentRuntime {
  seen: Readonly<Record<string, number>>;
  stateSince: Readonly<Record<string, number>>;
}
export function defaultSidebarUi(): SidebarUiState;
export function parseSidebarUi(value: unknown): SidebarUiState;
export function agentOwnState(session: Session, seen: number, hasAsk: boolean): AgentState;
export function advanceAgentRuntime(input: {
  previous: AgentRuntime | null;
  before: readonly Session[]; sessions: readonly Session[];
  previousAskSessionIds: ReadonlySet<string>; askSessionIds: ReadonlySet<string>;
  viewedTerminalIds: ReadonlySet<string>; now: number;
}): AgentRuntime;
export function formatStateAge(stateSince: number, now: number): string;
export function defaultNewAgentProject(
  selection: SpaceSelection, sessions: readonly Session[], lastFocusedId: string | undefined,
): string | null;

// src/agent-tree.ts — imports Session/Project and sidebar-state types
export interface AgentTreeRow {
  sessionId: string; parentId: string | null; depth: number;
  state: AgentState; effectiveState: AgentState; stateSince: number;
  childIds: string[]; descendantCount: number; childState: AgentState | null; folded: boolean;
}
export interface AgentTreeGroup { key: AgentGroup; rootIds: string[]; folded: boolean }
export interface AgentTreeModel {
  rows: Readonly<Record<string, AgentTreeRow>>; groups: AgentTreeGroup[]; visibleIds: string[];
}
export function agentStateRank(state: AgentState): 0 | 1 | 2 | 3 | 4;
export function buildAgentTree(input: {
  sessions: readonly Session[]; runtime: AgentRuntime; ui: SidebarUiState;
  matchingIds: ReadonlySet<string>; askSessionIds: ReadonlySet<string>;
}): AgentTreeModel;
export type SpaceHue = 'green' | 'violet' | 'blue' | 'accent' | 'neutral';
export interface SpaceRowModel {
  key: string; projectId: string | null; name: string; letter: string;
  hue: SpaceHue; branch: string | null; state: AgentState | null; count: number;
}
export function buildSpaceRows(input: {
  projects: readonly Project[]; sessions: readonly Session[]; runtime: AgentRuntime;
  askSessionIds: ReadonlySet<string>; lastFocusedId: string | undefined;
}): SpaceRowModel[];

// src/agent-icon.ts — imports Session/AgentDefinition/SessionIconKind, ResolvedSessionIcon as type only
export function agentIconKindFromText(...parts: string[]): SessionIconKind | null;
export function resolveAgentIcon(input: {
  session: Session; agents: readonly AgentDefinition[]; boundCli?: string; handle?: string;
}): ResolvedSessionIcon;

// src/attention.ts — new projection; existing attentionEntries unchanged
export function needYouEntries<T extends SessionStateFields & {
  id: string; attentionReason?: AttentionReason;
}>(sessions: readonly T[], items: readonly McpAttentionItem[], snoozed: SnoozeMap,
  now: number, asks?: readonly AttentionAsk[]): AttentionEntry[];

// src/status-bar-model.ts — imports Session, AttentionEntry
export interface StatusBarModel {
  branch: string | null; worktree: string | null; liveCount: number;
  attentionCount: number; firstAttention: AttentionEntry | null; showCommandHint: boolean;
}
export function buildStatusBarModel(input: {
  sessions: readonly Session[]; activeId: string | undefined; entries: readonly AttentionEntry[];
}): StatusBarModel;
```
Invariants: renderer runtime contains only seen and stateSince. First authoritative snapshot/new ID baselines seen=current completions. Server counter decreases clamp seen, reload baselines anew, strict focused-visible terminal advances seen. Compare before/after derived states with prior/current ask sets to update stateSince; do not infer run ends from snapshots or retain a second busy/completion/generation tracker. Unrelated updates/ancestor regrouping do not reset ages. Defaults All/Stopped folded; parser validates/deduplicates/caps arrays at 10,000, unknown fields ignored, malformed input defaults. Removed selected Space→All; prune vanished IDs.

Tree: window-owned sessions only, filter Space and matchingIds before edges; missing/filtered/foreign parent roots child. Pinned child roots once without changing openedBy. Break cycles at lexically smallest ID, iterative traversal. Descendant Done counts Idle for every ancestor and nested mark; roots use own Done. Visible IDs exclude folds. Ranks/time/creation/ID ordering and stable project-ID hue hash per spec. New icon detector is single implementation; iconKindFromText delegates. Keep powershell/terminal return literals; effectiveDef(session,{get:id=>agents.find(a=>a.id===id)}) handles custom commands. No MCP CliKind expansion for glyphs.

needYouEntries maps clones with needsAttention=attentionReason!=null and busy=false for reason-bearing sessions, then calls existing attentionEntries with unchanged asks/items/snooze/time. Legacy flags/aggregator untouched. Preserves asks→reason sessions→time-sorted messages ordering, keys and click targets, excludes finished-unseen sessions. Ask marks row Blocked but does not synthesize duplicate session entry. Footer model receives ONLY this projection. App also suppresses attentionReason on presentation-only clones while that session is snoozed, using the existing snooze expiry timer; it never changes raw server facts, completions or pending asks. Sidebar then retains current Snooze behavior under the new reason model. Active repo/worktree fields unchanged; no-active clears branch/worktree/hint.

### S0 DOM/ARIA selector contract (G1/G2 implement exactly)
| Surface | Required contract |
|---|---|
| Agent tree | `[data-agent-tree]`, role=tree, aria-label="Agents" |
| Row | `.session[data-sessionid="<id>"]`, role=treeitem, aria-level=depth+1, aria-selected=true/false; aria-expanded only if children; aria-label="<name>, <status>" plus ", <space>" under All; statuses Working/Needs you/Done/Idle/Stopped |
| Row content/actions | `.session__name`, `.session__edit`; select button data-agent-action=select aria-label="Go to <name>"; pin/close/relaunch/fold use data-agent-action and labels Pin to top/Unpin/Close <name>/Relaunch <name>/Show sub-agents/Hide sub-agents; fold aria-expanded |
| Space | button[data-space-id="all|no-space|<projectId>"] aria-pressed, aria-label="All"/"No space"/exact Space name; branch/count via description, not modified accessible name |
| Group | button.proj__label[data-agent-group="pinned|blocked|done|working|idle|stopped"], aria-expanded, aria-label="<label> (<root count>)"; group content role=group |
| Header toggles | button[data-right-view="files|changes|messages"] aria-label="Files|Changes|Messages", aria-pressed=true/false, aria-controls="right-pane"; badges described separately |
| Right panel | aside#right-pane[data-right-view="files|changes|messages"] aria-label="Files|Changes|Messages"; absent or hidden when closed |
| Footer | footer[data-status-bar] aria-label="Session status"; data-status-item="machine|branch|worktree|live|attention|commands"; attention is button with existing attentionChipLabel text as accessible name |
| Update outlet/item | existing .toasts role=region aria-label="Notifications", add data-toast-stack; persistent .update-card[data-update-toast] data-update-state="available|downloading|ready"; lifecycle text role=status, Dismiss aria-label="Dismiss update", downloading progressbar aria-label="Update download" aria-valuemin=0/max=100/now=clamped percent; Relaunch to update button unchanged |
| Announcements/filter | separate polite live region for outcomes, no minute-age announcement; input.sessbar__filter aria-label="Filter sessions", Search agents button aria-expanded/aria-controls |

Window seam (lead): WindowLayout gains `sidebarUi?: SidebarUiState`; WebviewToHost gains `{type:'window:sidebar';sidebarUi:SidebarUiState}`; HostToWebview gains dedicated `{type:'window:sidebarInit';sidebarUi:SidebarUiState}`. Host validates sender-scoped updates, persists matching layout entry. Send initialization once after renderer ready on create/restore (reload reinitializes that document), not every state snapshot. App waits for it before persisting UI edits; never echo hydrate as edit. Preserve v1 layouts. If planLayoutRestore drops an empty window, losing its Space selection is accepted; no migration or global selected-Space setting.

Renderer context signatures (lead, import React types/Sidebar types/StatusBarModel/AttentionEntry/RightPaneTab):
```ts
// webview/sidebar-tree-state.tsx
export interface SidebarTreeContextValue {
  ui: SidebarUiState; runtime: AgentRuntime; askSessionIds: ReadonlySet<string>;
  bindings: Readonly<Record<string, { cli?: string; handle?: string }>>;
  lastFocusedId: string | undefined; filterRequest: number;
  requestFilter(): void; updateUi(next: SidebarUiState): void;
  reportVisibleIds(ids: readonly string[]): void;
}
export const SidebarTreeProvider: React.Provider<SidebarTreeContextValue | null>;
export function useSidebarTreeState(): SidebarTreeContextValue;
// webview/workbench-chrome-state.tsx
export interface WorkbenchChromeContextValue {
  rightOpen: boolean; rightTab: RightPaneTab;
  togglePanel(tab: RightPaneTab): void; openPanel(tab: RightPaneTab, remember: boolean): void;
  status: StatusBarModel; commandHint: string; focusAttention(entry: AttentionEntry): void;
  update: { status: UpdateStatus | null; dismissed: boolean; dismiss(): void };
}
export const WorkbenchChromeProvider: React.Provider<WorkbenchChromeContextValue | null>;
export function useWorkbenchChromeState(): WorkbenchChromeContextValue;
```
Hooks throw if missing provider; fake shell also gets providers. requestFilter increments counter for G1 to reveal/focus. reportVisibleIds compares before updating and never sets App state during render. App deletes paneTab and RightPane deletes local tab. App opens panel then queues imperative ref action after actual mount (layout effect/ref-ready handshake, not a timing sleep); RightPaneHandle signatures unchanged. Explicit click persists preference, transient imperative view does not overwrite remembered tab.

UpdateStatus is the existing exported type from webview/components/update-card.tsx. Lead exposes current App updateStatus/updateDismissed/setUpdateDismissed through the chrome context in S1 and keeps the existing ready-event reset. App's existing <Toasts /> stays inside the provider; G2 reads context there, preserving generic toast-store behavior. UpdateCard's status/dismissed/onDismiss prop signature and updateRelaunch message stay unchanged. G1 removes only sidebar mount/imported component; optional legacy Sidebar update prop declarations may remain source-compatible until lead removes obsolete call arguments. There is one mounted update item, no new update store/auto-dismiss timer. Settings About keeps its current actions/status handling.

Session menu seam (lead extracts S1; G1 sole writer afterward):
```ts
// webview/session-menu.ts — import MenuItem/MenuActivation/ReactNode as type only
export type SessionMenuAction = 'select' | 'split' | 'relaunch' | 'snooze' | 'approval'
  | 'timed' | 'messages' | 'pauseMcp' | 'mcpTools' | 'setupMcp' | 'pin' | 'rename'
  | 'setIcon' | 'duplicate' | 'moveSpace' | 'copyHome' | 'copyName' | 'reveal'
  | 'close' | 'closeOthers' | 'closeAll';
export interface SessionMenuInput {
  name: string; maySplit: boolean; canRelaunch: boolean; pinned: boolean;
  hasApproval: boolean; waitingTimers: number; hasMcp: boolean;
  mcpPaused: boolean; mcpSwitchable: boolean; mcpSetupNeeded: boolean;
  otherCount: number; allCount: number;
  windowMoves: readonly MenuItem[];
  icons: Readonly<Record<SessionMenuAction, ReactNode>>;
  actions: Readonly<Record<SessionMenuAction, (activation?: MenuActivation) => void>>;
}
export function buildSessionMenu(input: SessionMenuInput): MenuItem[];
```
Pure builder only returns declarative entries with callbacks supplied by App. S1 preserves all original entries/order/separators, guards and coordinate anchoring; G1 adds relocated Go to/Snooze/Pin/View approval/timer counts/MCP explanation. No App state/import/DOM access inside builder. App prebinds every callback to the selected session, including moveSpace activation rect fallback. Existing close confirmations and MCP gates remain in App callbacks.

Font seams (G3, not lead): `webview/fonts.ts` side-effect imports `./fonts.css`; webview entry imports `./fonts` directly. `webview/terminal-fonts.ts` exports:
```ts
export function loadBootFonts(settings: Pick<AppSettings, 'fontUi' | 'fontMono' | 'terminalFontSize'>): Promise<void>;
export function applyTerminalFontChange(fontId: string, sizePx: number): Promise<void>;
```
loadBootFonts runs once with bridge.initialSettings before first root render/terminal mount, loads selected UI+mono 400/700 with symbol sample and fallback stacks. Empty result/rejection logs and resolves; never prevents root/session mounting. applyTerminalFontChange loads first then sets changed option on all registered terminals; deduplicate identical in-flight requests, latest request wins, failure logs and proceeds. `terminalGpu.refreshFonts(): void` calls public Terminal.clearTextureAtlas on every registered live terminal then refresh/fit/facts via existing pane callbacks; does not reset fontFamily or GPU-loss policy. No addon clear API or per-pane construction await. G3 extends coordinator registration to retain refresh/fit callback; terminal unregister removes it before disposal. Typecheck public API with installed pinned xterm typings.

G3 extends existing generic coordinator interfaces exactly (other methods unchanged):
```ts
// additions to GpuCoordinatorDeps<T>
clearFontAtlas(term: T): void;
refreshTerminal(term: T): void;
applyFontFamily(term: T, family: string): void;
// GpuCoordinator<T>: replace register signature, add methods
register(term: T, onFontRefresh?: () => void): () => void;
refreshFonts(): void;
applyFontFamily(family: string): void;
```
Real dependencies call term.clearTextureAtlas(), term.refresh(0,term.rows-1), and changed-only term.options.fontFamily. refreshFonts clears all live terminals first, then refreshes all and invokes their fit/facts callbacks. A single document loadingdone listener installed by the boot service calls it; per-pane listeners are removed. applyFontFamily changes registered terminals after the shared loader settles, refreshes/fits them, and does not use same-value assignment as an atlas-clear substitute. Old register callers remain valid; G3 updates its coordinator test dependencies.

## CSS section ownership at base 5c6d9e66
Measured with `git show 5c6d9e66:webview/styles.css`; line ranges below are inclusive base anchors, not current post-edit offsets. Match original selectors before editing; do not trust shifted numbers. Each owner deletes replaced blocks and writes replacements in place. No sidebar-tree.css/workbench-chrome.css, no higher-specificity overrides. Lead inserts tokens; G2 inserts new footer rules adjacent to its topbar block. Shared-selector entries are explicitly token-owned, declarations remain lead-owned. Integrator applies/merges CSS patches serially and checks no hunk escapes grants.

| Owner | Exact base ranges / entry ownership |
|---|---|
| G1 sidebar | 790–792; 1343–1350; 1369–1401; 2198–2596 (includes @container 2498–2510); 4257–4259; 4602–4613; 4617–4629; 4637–4644; 4751–4798; 4800–4910 (sidebar search/row extras); 7416–7427 (remove obsolete update-placement comment/.sidebar__update, preserve Settings footer); 8339–8409 (projpicker/row path); 8857–8859; 8900–8904; 8920–8928; 14654–14693 (includes nested media rule 14676–14683) |
| G1 shared-selector entries only | .session token at 518, 525, 535 (Neon lists); .sidebar token at 884; .session-stale token at 4232 (rest of 4232–4253 remains lead); .sidebar at 8493; .sidebar__foot at 8507; .sessbar__clear/.session/.session__kill/.session__relaunch at 15063–15066; .session modifiers at 15146–15148; .session at 15190 |
| G2 chrome | 586–591 (Neon viewswitch); 787–789; 1113–1130; 1140–1152; 1171–1198; 1233–1340; 5140–5199 (right tabs/badges); 6928–7011 (toast outlet/component); 7451–7513 (update card/comment); 8455–8458; 14694–14710 (urgent badge/chip reason); new status-bar rules inserted after old chrome block |
| G2 shared-selector entries only | .topbar at 8496; .winctl__btn at 15052/15182; .rtab at 15058/15188; .update-card__dismiss at 15061; .viewswitch__btn at 15082/15206; .viewswitch__btn--on at 15162 |
| Lead | All remaining lines, including :root/aero/neon tokens, shared focus/material declarations and shell inset. Remove Google @import at line1 in S1. Define --status-bar-h:32px once for G2 footer and toast anchor (same geometry, no magic offset). .panel > .rightpane at 885 and shared declarations 886–887 remain unchanged/lead. Revision 2 transfers update/toast rules to G2; G1 owns only old sidebar placement removal. Shared global hover/active declarations 15049–15175/15179–15240 remain lead except enumerated entries. |

The `.session-stale*` center-state prefix also falls under G1 grants; preserve its behavior, do not unintentionally delete it with cards. Nonmatching comments inside broad granted ranges may be updated with their owning rules. G1/G2 are file-disjoint except this expressly approved section-owned styles.css; do not describe that file as single-owner. Theme token sections are never lane-owned.

## Producer/consumer map
| Behavior | Producer → consumer | Owner |
|---|---|---|
| completions/reason | independent qualifying evidence + reports → ServerAttention → services → SessionView → App/tree | Lead S0 both ends, persistence strip included |
| legacy notifications | existing needsAttention/edge → OS flash/notifications/legacy models | Lead preserves tests; new facts never emit substitute legacy edges |
| personal seen/age | server facts + strict focus → seen/stateSince → tree | Lead App/pure modules, G1 rendering |
| loose visibility | active+split presence → existing server acknowledgment | Unchanged producer semantics, explicitly separate from Done |
| footer count | reason projection + asks/messages/snooze → attentionEntries → footer click | Lead projection; G2 rendering |
| ancestry/moves | existing openedBy/project assignment → forest/Space filter | Lead pure/G1 UI; unchanged host IDs and APIs |
| window UI | one create/restore init + sender-scoped edits → layout reconciliation | Lead all hops; dropped-window selection loss accepted |
| panel navigation | App open/mount/ref-ready queue → RightPaneHandle | Lead App, G2 controlled child; no duplicate tab stores |
| update notification | existing App update status/dismissal/reset → chrome context → existing Toasts portal/UpdateCard | Lead exposes state, G1 removes sidebar mount, G2 outlet/card/CSS; host updater and toast-store unchanged |
| session menu | App callbacks/snapshot → pure builder → context-menu | Lead extracts S1, G1 owns after freeze |
| fonts | upstream/sliced assets + boot load/events → terminal options/public atlas refresh | G3 all hops including entry/manifests/notices |

## File map / ownership
No unnamed durable files. Newly discovered path must be assigned before edit; never opportunistically touch another lane. Test files named with modules share ownership. Two deliberate handoffs only: session-menu.ts lead S1→G1; CSS split by table.

| Owner | Paths | Responsibility |
|---|---|---|
| Lead S0 server facts | `src/types.ts`, `src/contracts/server-protocol.ts`, `src/contracts/server-ports.ts`, `src/session-activity.ts`, `server/attention/index.ts`, `server/services.ts`, `server/domain/index.ts`, `src/persistence.ts`, `server/domain/testing/fakes.ts` | Facts/producer/events/persistence strip and neutral pre-decoration domain defaults |
| Lead S0 pure | create `src/sidebar-state.ts`, `src/agent-tree.ts`, `src/agent-icon.ts`, `src/status-bar-model.ts`; modify `src/attention.ts`, `src/session-icon.ts`, `webview/icons.tsx` | Exact pure seams, needs-you projection, distinct glyphs |
| Lead S0 tests | create `test/unit/sidebar-state.test.ts`, `test/unit/agent-tree.test.ts`, `test/unit/agent-icon.test.ts`, `test/unit/status-bar-model.test.ts`, `test/unit/sidebar-tree-compat.test.ts`; modify `test/unit/session-activity.test.ts`, `test/unit/server-attention.test.ts`, `test/unit/server-compose-services.test.ts`, `test/unit/server-domain-events.test.ts`, `test/unit/server-domain-persist.test.ts`, `test/unit/contracts.test.ts`, `test/unit/persistence.test.ts`, `test/unit/session-icon.test.ts`, `test/unit/attention.test.ts`, `test/unit/os-attention.test.ts` | Counter/reason/transport/legacy/serialization/domain/model compatibility |
| Lead S1 | `webview/app.tsx`, `electron/main.ts`, `src/protocol.ts`, `src/window-registry.ts`, `src/settings.ts`; create `webview/sidebar-tree-state.tsx`, `webview/workbench-chrome-state.tsx`, `test/unit/sidebar-window-state.test.ts`; modify `test/unit/window-registry.test.ts`, `test/unit/settings.test.ts`, `test/unit/coerce-settings.test.ts` | Single authority, init/update IPC, providers, strict focus/default launch |
| Lead S1→G1 | create `webview/session-menu.ts`, `test/unit/session-menu.test.ts` in S1; G1 sole modifier after S1 | Pure original menu extraction then relocated actions |
| Lead integration/copy | `CHANGELOG.md`, `src/session-groups.ts`, `webview/project-announcer.ts`, `webview/conduit-mcp-strings.ts`, `src/conduit-mcp/tool-schemas.ts`, `src/conduit-mcp/control-tools.ts`, `src/conduit-mcp/tools.ts`, `src/conduit-mcp/app-control-tools.ts`, `test/unit/session-groups.test.ts`, `test/unit/project-announcer.test.ts`, `test/unit/project-picker.test.ts` | Shared copy only, preserve API names/fields |
| G1 | `webview/components/sidebar.tsx`, `webview/components/session-card.tsx`, `webview/components/project-group-header.tsx`, `webview/components/settings-modal.tsx`, `webview/components/project-picker.tsx`, `webview/components/new-session-modal.tsx`, `webview/components/new-session-project-chip.tsx`, `webview/sort-filter-menu.ts`, `webview/card-fields.ts`; create `webview/sidebar-strings.ts`; owns transferred menu files and CSS sections | Tree/Spaces/row/settings/menu/strings |
| G1 tests | create `test/unit/sidebar-tree-ui.test.ts`, `test/unit/sidebar-strings.test.ts`; modify `test/unit/sort-filter-menu.test.ts`, `test/unit/card-fields.test.ts`, `test/unit/sidebar-project-menus.test.ts`, `test/unit/project-group-header.test.ts` | Selector contract, focus/actions and existing expectations |
| G2 | `webview/components/top-bar.tsx`, `webview/components/right-pane.tsx`, `webview/components/update-card.tsx`, `webview/components/toasts.tsx`; create `webview/components/status-bar.tsx`, `webview/chrome-strings.ts`, `test/unit/workbench-chrome.test.ts`, `test/unit/chrome-strings.test.ts`, `test/unit/update-toast.test.tsx`; owns CSS sections | Controlled header/pane/footer/grip and single floating update outlet/card |
| G3 | `webview/index.tsx`, `webview/themes.ts`, `webview/xterm-theme.ts`, `webview/components/terminal-pane.tsx`, `webview/terminal-gpu.ts`, `esbuild.mjs`, `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.txt`; create `webview/fonts.ts`, `webview/fonts.css`, `webview/terminal-fonts.ts` | Sole manifests/notices/entry/font lifecycle owner |
| G3 assets | create `assets/fonts/jetbrains-mono-variable.ttf`, `assets/fonts/fira-code-variable.ttf`, `assets/fonts/ibm-plex-mono-regular.ttf`, `assets/fonts/ibm-plex-mono-bold.ttf`, `assets/fonts/cascadia-mono-variable.ttf` | Upstream full font releases, normalized local filenames, measured cmap; UI slices from locked Fontsource packages |
| G3 tests | create `test/unit/terminal-fonts.test.ts`, `test/unit/font-bundle.test.ts`; modify `test/unit/terminal-gpu.test.ts`, `test/unit/xterm-theme.test.ts` | Boot load/nonblocking errors/option order/public atlas/assets/notices |
| G4 | `test/e2e/**` only, starts after G1/G2 merge | Idempotent helper, all selector migrations, seven scenarios including update-toast |
| CSS | `webview/styles.css` section-only grants above | G1/G2/lead patch ownership; lead serial merge/verification |

Call sites: SessionIconKind expansion and webview/icons.tsx:520 exhaustive map land together; src/session-manager.ts:337 uses unchanged detector API. App palette :3952/:4478, center-pane.tsx:556, sidebar.tsx:407 and session-card.tsx:346 accept unchanged descriptor API. Server facts flow services.ts:110→snapshot/events→app-session-store.ts:68→renderer; merged overlay must retain them. Legacy Session fixtures normalize missing fields; typed SessionView fakes acquire required facts. New exports first consumed by contract tests as explicitly required, App runtime/footer production calls S1, tree/icon production calls S2; full dead-export gate on integrated tree.

## Scripts
One candidate: reviewed G4 selector migration script under absolute OS temp, arguments -Root test/e2e -Pattern <old selector> -Replacement <showRightView/palette helper>. Explicit replacements only, no blanket project/API rename or deleted assertions; delete afterward.

## Slices

### S0: Server facts, pure contracts, selector contract (lead serial)
**Check:** `npm run test:unit -- test/unit/session-activity.test.ts test/unit/server-attention.test.ts test/unit/server-compose-services.test.ts test/unit/contracts.test.ts test/unit/persistence.test.ts test/unit/sidebar-state.test.ts test/unit/agent-tree.test.ts test/unit/agent-icon.test.ts test/unit/status-bar-model.test.ts test/unit/sidebar-tree-compat.test.ts test/unit/session-icon.test.ts test/unit/attention.test.ts test/unit/os-attention.test.ts`.
**Parallel groups:** none. **Claims:** lead S0 file-map paths.
- T0.1 Test visibility-independent heuristic completion with same min-duration/byte/quiet/grace thresholds: visible/unseen, already-armed legacy episode, repeated qualifying runs, startup/noise/bell-only exclusions. Add completedIds without changing legacy flags/edge tests. Test reported Working→Done/Idle increments once, Blocked/repeated report does not; reported output not counted heuristically; counters survive spawn/exit but reset on server recreation. Reason blocked/bell arms/clears under old loose visibility. Guard run-end notifications against counter-only changes.
- T0.2 Add exact SessionAttentionFacts/SessionView/AttentionPort contracts, neutral facts in domain views(), authoritative service decoration and onChange. Test counter-only/reason-only changes survive snapshot/coalesced event and app overlay; raw domain defaults never leak in place of producer facts. Persistence read/write strips facts; no migration. Run `npm run test:unit -- test/unit/server-domain-events.test.ts test/unit/server-domain-persist.test.ts` as well as S0 command. Fakes normalized/updated; old Session fixture defaults null/0, legacy needsAttention/OS consumers remain unchanged.
- T0.3 Runtime tests baseline reload/new IDs to current counter, jump >1, strict focused terminal vs active editor/background split/unfocused window, restart counter decrease clamp, stateSince changes on ask/reason/seen and age boundaries. Implement AgentRuntime containing only seen/stateSince, no renderer completion inference. Footer projection tests exclude legacy finished-unseen, retain blocked/bell while busy, asks first/messages time order/snooze and exact first target.
- T0.4 Forest tests three levels, cross-Space filter/orphan/foreign window, cycle/self-cycle, child Done discount, pinned child once, folds and rank/time/creation ties. Implement tree/Space hash/defaults and icon precedence. Keep powershell/terminal, add four kinds and lead glyphs atomically; legacy descriptor callers compile. Assert exact DOM/ARIA names/data contracts in compatibility expectations, for G1/G2 to implement.
**Produces:** all S0 Contracts above, including selector table. **Consumes:** real server facts/Session/Project/AttentionEntry, no guessed producer. S0 contract test callers are required before fan-out; production callers arrive in S1/S2.

### S1: App/window state and menu extraction (lead serial)
**Check:** `npm run test:unit -- test/unit/window-registry.test.ts test/unit/sidebar-window-state.test.ts test/unit/session-menu.test.ts test/unit/settings.test.ts test/unit/coerce-settings.test.ts`, plus quick/build.
**Parallel groups:** none. **Claims:** lead S1 map, session-menu handoff, lead CSS line1/tokens only.
- T1.1 Extend layout parser/serializer/reconciliation, add dedicated window:sidebarInit and sender-scoped update message. Send init once after create/restore document ready, never recurring state. Tests: two restored windows isolated, old v1 defaults, hydration no echo, empty window dropped loses selection acceptably. No global selectedSpace or seen persistence.
- T1.2 App providers hold runtime seen/stateSince and strict terminal focus; preserve existing loose active+split presence for server. Baseline authoritative facts on initial snapshot; derive pending-ask session set. Wire default launch only for implicit sidebar new-agent, retaining explicit board/MCP/folder contexts. Prune stale IDs/selection and expose stable visible-order/filter request callbacks.
- T1.3 Make App sole effective right view/open authority: delete paneTab duplication, G2 deletes child tab. App opens panel before search/reveal/thread and waits for mounted ref before action. Preserve preference on transient switches; explicit toggle persists. Route only needYouEntries to footer status model; expose existing updateStatus/updateDismissed/dismiss through chrome context, retaining ready reset and existing Toasts mount inside provider. Stop passing redundant sidebar update arguments when G1 removes mount; legacy notifications remain unchanged.
- T1.4 Extract entire current session-menu construction to pure buildSessionMenu with exact callback/snapshot input. Test original ordering, separators, window moves, close guards, MCP/timer/icon/rename/move anchoring. App calls it; freeze input API, transfer session-menu.ts/test to G1. No later lead menu-file edits. App already passes relocated-action callbacks so G1 can add entries without App edits.
- T1.5 Lead removes Google @import at base styles.css line1 and defines shared --status-bar-h:32px for G2 footer/toast anchor, recording other token changes for integration. Local faces arrive with G3; no production release until all slices. No dependency/lock/notices changes by lead.
**Interfaces:** produces both context values, one-shot window seam and menu builder in Contracts; consumes server facts and pure runtime/footer modules. Existing component prop interfaces stay source-compatible during fan-out.

### S2: Spaces/tree/rows/menu/CSS (G1 after S1)
**Check:** `npm run test:unit -- test/unit/sidebar-tree-ui.test.ts test/unit/sidebar-strings.test.ts test/unit/session-menu.test.ts test/unit/sort-filter-menu.test.ts test/unit/card-fields.test.ts test/unit/sidebar-project-menus.test.ts test/unit/project-group-header.test.ts`, plus quick/build.
**Parallel groups:** G1 alongside G2/G3. **Claims:** G1 paths/transferred menu and exact CSS sections.
- T2.1 Consume exact sidebar context/tree/Space/icon seams and selector table. Existing matcher feeds matchingIds; Search/filter request reveals/focuses input. Space drop calls existing project assignment; All rejects, No space=null, descendants keep own membership. Remove row reorder/sort/group controls and the Sidebar UpdateCard mount/component import; preserve bulk close and Settings footer. G2 renders update states in Toasts; no second/sidebar notification mount.
- T2.2 Fixed-name 30/26px root and26px child rows, keyed direct nested children/connectors, own mark vs effective attention, age/pin/close/relaunch, folds/pinning/rename. Exact role/data/ARIA table implemented; focus/arrows visibleIds, no nested buttons/double activation. Preview becomes row; old roles accepted harmlessly, no alias kind layer. Lead glyphs/lucide imports avoid icons.tsx edits.
- T2.3 In transferred menu builder add Go to/Snooze/Pin/View approval and all relocated timer/MCP pathways with supplied callbacks. Tests prove every action in spec relocation table remains reachable, including dirty/running close guards delegated to App, MCP policy/setup/pause and window moves. UI copy/strings/plurals updated in owned dialogs/settings/pickers.
- T2.4 Delete replaced CSS in owned base ranges; no separate sidebar-tree.css or overrides. Narrow only .session entries of Neon selector lists, preserve other surfaces. Keep .session-stale center behavior and Settings footer; delete obsolete .sidebar__update placement/comment, leave G2 update-card rules to G2. Capture baseline/reference in absolute temp before changes, compare nested/attention/selected/folded/long names across themes/densities after integration.
**Interfaces:** exact sidebar context/tree/icon/menu/selector contracts. reportVisibleIds only on order changes. No app.tsx/shared token/manifest edits.

### S3: Header/pane/footer/CSS (G2 after S1)
**Check:** `npm run test:unit -- test/unit/workbench-chrome.test.ts test/unit/chrome-strings.test.ts test/unit/update-toast.test.tsx`, plus quick/build.
**Parallel groups:** G2 alongside G1/G3. **Claims:** G2 paths/CSS sections.
- T3.1 Logo/Conduit/back-forward/search, Files/Changes/Messages then controls; Mac traffic lights retained, no-drag all controls. Exact button data-right-view/aria-pressed/labels; described badges/urgent styling. Remove view switcher/header chip rendering. Consume App effective view, no duplicate preference state; retain existing public props for source compatibility.
- T3.2 Delete RightPane local tab; consume App context, retain caches. RightPaneHandle performs mounted search/reveal/thread work; App owns prior open/mount sequence. Remove .rightpane__tabs, add dedicated Move side panel grip with existing moveGrip/menu alternative. Do not let settings hydration snap transient view back.
- T3.3 Add StatusBar():React.JSX.Element consuming reason-filtered model; exact data-status-item contract, no-active machine/counts only, actual rebound/unbound commands hint. First attention target uses same ask/message/session callbacks. Delete replaced owned CSS blocks in place, new footer rules in G2 chrome section; preserve shared declarations/lead tokens. Tests: toggle transitions, effective/persisted state split, imperative hidden-panel route and selector contract.
- T3.4 Reuse existing Toasts portal for a single persistent UpdateCard, last item nearest the fixed bottom anchor, existing transient notifications above it. Render outlet when either generic toasts or a visible undismissed update exists; do not return early merely because toast-store is empty. Replace sticky .update-card positioning in place. Same right=var(--win-pad), bottom=calc(var(--win-pad) + var(--status-bar-h) + var(--gutter)) for available/downloading/ready; footer height uses that same 32px token. No content-space reservation or state-specific anchor; existing width safety, --layer-toast, token material, outer pointer-events none/cards auto. Download body adds locale rounded/clamped percent and accessible progressbar. Keep existing Dismiss/Relaunch, ready resets dismissal through App, no new timer/store/What's new link. Unit tests cover all branches, empty generic store, same keyed item across progress/ready, dismiss/reset, generic notification coexistence and absence of new actions. Lifecycle live announcements only; progress changes do not repeatedly announce the entire stack.
**Interfaces:** exact chrome context, selector table, unchanged RightPaneHandle; StatusBar mounted by lead in S5. No global file-owner claim to styles.css.

### S4: Upstream/local fonts and synchronous terminals (G3 after S1)
**Check:** `npm run test:unit -- test/unit/terminal-fonts.test.ts test/unit/terminal-gpu.test.ts test/unit/xterm-theme.test.ts test/unit/font-bundle.test.ts`, plus quick/build.
**Parallel groups:** G3 alongside G1/G2. **Claims:** G3 only, including package.json/package-lock.json/THIRD_PARTY_NOTICES.txt/webview entry/esbuild.
- T4.1 Acquire upstream mono/Cascadia release files and measure cmap/weights/license; prefer variable where available, normalize local filenames from file map. If format differs from planned TTF slot, stop and amend exact asset path with lead before editing, not a guessed renamed binary. UI may use full chosen Fontsource slices. G3 alone installs/locks packages and updates notices; build emits fonts and THIRD_PARTY_NOTICES.txt under packaged out. Source versions/hashes/coverage belong in notices or final lane evidence, no claimed measurement in docs lane.
- T4.2 webview/index.tsx imports ./fonts side effect; fonts.ts imports fonts.css. Before root render await loadBootFonts(initialSettings), selected UI/mono regular+bold, fallback stack in font string and symbol sample. Mock rejected/empty results: logged, promise settles, app/terminal still mounts. One boot load, not per-pane promises/error gates. Terminal constructors stay synchronous.
- T4.3 applyTerminalFontChange loads first then applies actual changed family; deduplicate same request and latest request wins. Existing terminal-pane font effect calls service without remounting/awaiting constructor. Coordinator registration includes refresh/fit/facts callback; loadingdone clears every live term through public Terminal.clearTextureAtlas, refreshes/fits. Test two sharing terminals, same-family late event, disposed unregister, no loss-budget increment; remove old per-pane loadingdone handlers to avoid duplicate work. Never rely on identical fontFamily assignment or addon/private API.
- T4.4 Keep TERM and rescaleOverlappingGlyphs=true, replay/geometry/host facts. CSP removes Google origins. Assert boot once/empty failure, font option after load, upstream glyph tables + local emitted regular/bold/assets/licenses; runtime symbol/atlas proof in G4 after integration. No document.fonts.check-only coverage claim.
**Interfaces:** exact font APIs/coordinator refresh; settings initial boot source is bridge.initialSettings. Lead does not edit G3 entry/manifests, G3 does not edit CSS line1/tokens.

### S5: Merge lanes, migrate e2e and integrate (lead + G4 after G1/G2)
**Check:** `npm run verify`, then `npm run e2e:remote -- --full`. Local diagnosis only one named scenario through launchElectron/finishScenario.
**Parallel groups:** G4 begins only after G1 and G2 merge/selector contract verified; execution after G3/integration ready. Lead shared-file integration serializes against test execution.
- T5.1 Lead mounts StatusBar in center, finishes token/shell uniform inset/copy/default launch/palette routes, merges section-owned CSS patches without rewriting lane rules. No CSS import stubs. G3 owns entry/deps; menus already G1-owned. Preserve Board/Canvas/Open editor; unbound next/previous/filter actions use visible order/filterRequest, no invented default chord.
- T5.2 G4 adds exported `showRightView(page, view): Promise<void>` to test/e2e/harness.mjs, view exactly `'files' | 'changes' | 'messages'` (JSDoc union in .mjs). Helper checks button[data-right-view] aria-pressed AND #right-pane visibility/content before clicking; if already correct, no click. If button is pressed but panel is still mounting, wait for the matching panel instead of closing it. Otherwise click inactive target and assert active/matching panel. Every ordinary scenario uses helper; raw toggle clicks ONLY right-panel-toggles scenario. Replace .rtab--active with button[data-right-view][aria-pressed="true"], never blindly click a toggle that would close it. Update imported helpers' callers, no silent lost assertions.
- T5.3 Migrate manifest below and add seven scenarios; adapt font holds to local assets, preserve existing grid/PTY/GPU coverage. Runtime checks counter increment while visible, Done strict viewing/reload baseline/server reset clamp, reason-only footer count/ask order, one-shot UI init and dropped-window behavior. New menu tests belong G1; e2e drives every relocated action. update-toast proves fixed common anchor and no workbench layout shift across states, dismissal/reset and existing actions.
- T5.4 Lead finishes Project→Space visible copy/MCP descriptions and CHANGELOG, keeping API fields/params. Full verify + remote full suite once integrated. Inspect mockup comparisons all themes/densities, narrow, Mac/forced-colors/reduced-motion/200% zoom. Assert row30/26/child26/footer32/even inset and center expansion. Font evidence combines upstream cmap, local loaded faces, public atlas calls and rendered sample; empty/rejected fonts never prevent sessions.
**Interfaces:** no new seams. Shared global edits remain lead-token/integration only; G4 sole e2e writer.

## E2e migration manifest (G4 starts after G1/G2 merge)
All ordinary panel navigation uses showRightView. Data/ARIA contract is S0 authority; preserve .session/data-sessionid/name/edit and terminal selectors. .proj__label now means status group; Space rows use data-space-id. Removed .rtab/.viewswitch/.attnchip/card-field assertions become header helper/palette/footer/row assertions, not invisible alias DOM.

Existing removed-surface scan returned these 79 test/e2e/<name>.e2e.mjs basenames for mandatory assertion review:
- `auto-save-basics`, `band-alignment`, `board-sessions`, `change-map-geometry`, `changes-active-highlight`, `changes-line-demand`
- `changes-multi-repo`, `conduit-mcp-app-git`, `conduit-mcp-app-web`, `conduit-mcp-compose`, `conduit-mcp-gate`, `conduit-mcp-install`
- `conduit-mcp-install-banner`, `conduit-mcp-policy`, `conduit-mcp-restart`, `context-menu-order`, `cwd`, `editor-change-markers`
- `editor-first-paint`, `editor-nav-history-lifecycle`, `editor-preview-tabs`, `editor-tabs-persist`, `explorer`, `explorer-dnd-polish`
- `explorer-gitignore`, `explorer-icons`, `explorer-keyboard-multiselect`, `explorer-multiselect`, `explorer-multiselect-delete`, `explorer-open-as-session`
- `files-follow-tab`, `find-widget`, `git-band-persistence`, `git-blame`, `go-files`, `goto-index`
- `hover-obstruction`, `html-viewer`, `hunk-staging`, `image-diff`, `live-watch`, `markdown-raw-html`
- `markdown-search`, `markdown-toc-collapse`, `markdown-viewer`, `md-file-links`, `md-images`, `md-toc-scrollspy`
- `mermaid-export`, `mf-files`, `mf-live-edits`, `middle-click-explorer`, `middle-click-surfaces-search`, `middle-click-surfaces-sessions`
- `mouse-nav`, `multi-repo`, `new-session-folders-card`, `os-drag-out`, `os-import`, `overlay-modals`
- `pdf-viewer`, `quickopen-corpus`, `review-mode-pane`, `review-navigator`, `review-notes-handoff`, `review-tab-state`
- `rich-content`, `search-scope`, `search-selection`, `sidebar-dnd`, `sidebar-projects`, `split-diff-map`
- `split-editor-drag`, `split-editor-focus-keep`, `tabbar-overflow`, `tab-scroll-state`, `terminal-drop`, `terminal-osc8-link`
- `viewer-robustness`

Also review copy/setup in `multi-folder-model.e2e.mjs` and `multi-window.e2e.mjs`; internal project:* fixtures remain unchanged. `terminal-late-font.e2e.mjs` now delays local faces but keeps grid/PTY parity; `terminal-gpu-reset.e2e.mjs` retains reset policy proof. Helpers needing removed-panel migration: `harness.mjs`, `conduit-mcp-helpers.mjs`, `new-session-folders-helpers.mjs`, `auto-save-helpers.mjs`, `dirty-quit-helpers.mjs`, `middle-click-surfaces-helpers.mjs`, `nav-history-fixture.mjs`, `split-editor-helpers.mjs`, `tree-chevrons-helpers.mjs`, `goto-matrix.mjs`, `visual/shoot.mjs`, `visual/text-fit-sweep.mjs`, `stress/markdown-heavy.stress.mjs`, `stress/monaco-2mb.stress.mjs`, `stress/explorer-10k.stress.mjs`. All paths under test/e2e, G4 sole writer. Ordinary helper/scenario navigation always uses idempotent showRightView; raw clicks reserved for toggle behavior scenario. Comment-only standalone launch matches are not product copy changes.

New exact scenario files:
- `test/e2e/sidebar-agent-tree.e2e.mjs`: real MCP openedBy parent/child/grandchild, blocked descendant promotion, child Done discount, folds/visible navigation, parent close leaves child, orphan/foreign-window root.
- `test/e2e/sidebar-space-filter.e2e.mjs`: All/Space/No space, cross-Space parent visibility, default new agent, drag/picker only moves one agent, two-window restore UI init once, folds/pins, dropped empty-window selection loss, search reveal.
- `test/e2e/sidebar-done-seen.e2e.mjs`: server counts qualifying visible and unseen runs; reported and heuristic producers; strict focus vs active editor/background split/unfocused window; repeated counters coalesced; renderer reload baselines all counters; server restart clamps seen; Blocked/bell/ask Needs you, bell-only not completion.
- `test/e2e/status-bar.e2e.mjs`: active branch/worktree, no-active machine/counts, filter-independent live counts, exclude finished-unseen from attention count, asks→blocked/bell→messages order/click, snooze, rebound/unbound hint.
- `test/e2e/right-panel-toggles.e2e.mjs`: ONLY scenario with raw toggle clicks; active closes/inactive opens, badges/center width, helper idempotence proof, imperative hidden-panel post-mount opens, persisted vs transient view/header state, grip/menu movement and palette Board/Canvas/Workspace.
- `test/e2e/terminal-local-font.e2e.mjs`: offline local assets, app boot load once selected UI+mono regular/bold before first terminal, empty/rejected load logs then session opens, load-before-changed-option, late same-family event invokes public clearTextureAtlas on all registered terminals, glyph cmap/render proof and TERM/PTY geometry.
- `test/e2e/update-toast.e2e.mjs`: deliver existing updateStatus events via harness, available→downloading(percent)→ready updates one item in the existing portal; same viewport right/bottom anchor above footer with sidebar/panel toggles and center views; compare sidebar/center/status-bar rectangles before/after to prove no shift. Assert no sidebar UpdateCard, numeric percent/progress ARIA, coexistence with a generic toast, dismiss/ready-reset, existing Relaunch message captured without installing/restarting, no What's new link. Checking/up-to-date/error keep current non-card visibility/Settings behavior.

Use existing runner discovery; explicit registry under test/e2e, if any, G4-owned. E2e tests use actual server facts rather than renderer busy-edge simulations. Host/PTY behavior is not accepted on human smoke alone.

## Verification and acceptance mapping
Per lane quick/build plus slice's named units; merged full verify then remote full suite. No source-order or test-selector aliases. Capture direct exit codes. Source inspections are not runtime measurements. Docs-lane npm gate remains unavailable; implementation lanes must run real gates.

| Acceptance | Proof |
|---|---|
| AC1 copy/compat | S0 persistence/kind/legacy tests; S2 UI copy; S5 shared copy/full gate |
| AC2 Space/default/persistence | S1 layout/init tests; S2 controls; sidebar-space-filter |
| AC3 status/seen/time | S0 server evidence/counters/reason/renderer tests; sidebar-done-seen |
| AC4 ancestry/move/close | S0 forest; sidebar-agent-tree/space-filter |
| AC5 row/actions/settings | S1 extraction/G1 menu tests; S2 row/preview and visual comparison |
| AC6 keyboard/search/a11y | S0 selector contract; S2 focus/filter/strings; S5 runtime a11y |
| AC7 pane/header/grip | S1 single App authority; S3 controls; right-panel-toggles/showRightView |
| AC8 footer | S0 needs-you projection/model; S3 footer; status-bar |
| AC9 fonts | S4 boot/empty failure/change/public atlas/assets; terminal-local-font + late-font/GPU reset |
| AC10 selectors/gates | G4 after G1/G2 merge; S5 full verify/remote full suite |
| AC11 floating updates | G1 sidebar mount removal; G2 update-toast units/CSS; G4 update-toast runtime position/no-shift/actions proof |

## Deviation rule
If an assumption is false, stop that task and fix the misaligned producer/contract with lead; no shim, second store, widened type, silent fallback or CSS override. Font log-and-continue is the explicit approved product behavior, not a gate bypass. Report a code contradiction without bending the lead decision.

## Decisions Needed
Spec D1–D5/D7 remain flagged source/runtime measurements or conservative UI defaults. D6 is removed: the server counter resolves the former renderer missed-edge problem. Upstream exact mono/Cascadia releases, binary format and cmap coverage require G3 measurement before installing/vendoring; UI slices may use Fontsource. Public xterm API typecheck awaits dependency-equipped environment. No further design permission is needed for these fixed decisions.

## Self-review
#1 Coverage: ok — AC1–11, Revision1 B1/B2/B3/S1–S8 and Revision2 floating update ownership/behavior mapped.
#2 Placeholder scan: ok — paths/signatures/error behavior/checks fixed; unmeasured upstream coverage explicitly flagged.
#3 Signature consistency: ok — server facts required on SessionView, renderer only seen/stateSince, projection input/order preserved.
#4 Placement: ok — CSS measured base section/entry grants, G3 sole manifests/notices/entry owner, menu handoff explicit.
#5 Caller scan: ok — required contract test callers first; production App/runtime/footer S1, sidebar tree/icon S2, StatusBar mount S5.
#6 Producer/consumer: ok — independent all-visibility server evidence, legacy consumers, service transport, persistence strip and one-shot UI init covered.
#7 Handoff arithmetic: ok — S0–S5 six slices, G1–G4 four lanes; G4 waits for G1/G2. CSS section ownership is explicit shared-file exception.

SLICES: 6 — S0 contracts/server facts/selectors; S1 App/window/menu foundation; S2 sidebar/menu/CSS and old update removal; S3 chrome/floating updates/CSS; S4 fonts; S5 integration/e2e.
GROUPS: 4 — G1 sidebar (after S1), G2 chrome (after S1), G3 fonts (after S1), G4 e2e (after G1/G2 merge). Files disjoint except explicitly section-owned styles.css; CSS patches merged serially by integrator.
CLAIMS: lead owns webview/app.tsx, electron/main.ts, src/settings.ts, src/types.ts, src/protocol.ts, src/contracts/server-protocol.ts, src/contracts/server-ports.ts, src/window-registry.ts, server/attention/index.ts, server/services.ts, server/domain/index.ts, src/sidebar-state.ts, src/agent-tree.ts, src/agent-icon.ts, src/status-bar-model.ts, webview/icons.tsx, webview/sidebar-tree-state.tsx, webview/workbench-chrome-state.tsx and CHANGELOG.md; webview/session-menu.ts + test/unit/session-menu.test.ts transfer lead S1→G1; webview/styles.css G1/G2/lead exact base ranges above, including G2 toast/update rules; G2 alone owns webview/components/update-card.tsx + webview/components/toasts.tsx + test/unit/update-toast.test.tsx; G3 alone owns package.json, package-lock.json, THIRD_PARTY_NOTICES.txt, webview/index.tsx, webview/fonts.ts and esbuild.mjs; G4 alone owns test/e2e/** including update-toast.e2e.mjs.

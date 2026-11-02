---
status: active
date: 2026-11-02
---

# Feature Spec: Spaces and agent tree

**Tier:** FULL. **Feature type:** UI + server attention facts + renderer runtime + font packaging.
**Design authority:** `.autoloop/mockup-Main.dc.html` and `mockup-AgentIcon.dc.html`, fully inspected, plus the lead's settled A–E decisions as amended by `.autoloop/revision-1.md` and the Revision 2 canvas decision delivered by the lead. Revision 1 owns Done/Needs you, font lifecycle and ownership corrections; Revision 2 moves update notifications to the floating toast outlet. Mockup arrays/ages/shortcut/hover examples remain illustrative.
**Plan:** `docs/plans/2026-11-02-sidebar-agent-tree.plan.md`.

## 1. Problem and scope

Help a human supervise agents across Spaces, see which agent or descendant needs help, and open Files/Changes/Messages without a second tab strip. Stabilize terminal typography without a network dependency. This is a view change over existing sessions, projects, messages and repositories, with runtime-only completion/seen tracking. It does not introduce orchestration or remote machines.

Project(s) becomes Space(s) in visible product copy, menus, settings and MCP descriptions. Internal names, `projectId`, tool names/parameters, settings keys and `.conduit/board.json` remain unchanged. No session/project data migration. The existing no-project bucket becomes **No space**, shown only with sessions. All is a filter, never a stored project.

## 2. Grounding (source inspection, not runtime measurements)

| Inspected evidence | Consequence |
|---|---|
| `src/session-icon.ts:47` derives cantStart/stale/busy/attention/review/idle; review requires dirty repo at :53 | Add a sidebar status model; Done must not depend on repo dirtiness. Preserve non-sidebar consumers until explicitly adapted. |
| `src/types.ts:93` has sticky runtime `completedRun`; :125 has persisted `openedBy` | Add server completion counters/reasons; renderer tracks only seen/stateSince. Build ancestry from opener ID. |
| `src/types.ts:48`, `src/session-icon.ts:112`, :172 support three kinds and override > title > profile | Expand CLI kinds and put MCP binding before title. Accept legacy powershell/terminal values. |
| `src/session-groups.ts:176`, `webview/components/sidebar.tsx:377` implement cross-project drops | Retain drag-to-Space; remove manual session reorder. |
| `webview/components/session-card.tsx:140` uses `data-sessionid` | Preserve this exact attribute and `.session`, not a guessed `data-session-id`. |
| `webview/components/sidebar.tsx:315`, :327, :332 filter/sort/project-group sessions | Replace project grouping with filter + forest + status groups. |
| `webview/components/top-bar.tsx:121`, :154 render view switcher and attention chip | Remove those header surfaces; transfer attention behavior. |
| `webview/app.tsx:4050`, :4059 and `webview/shortcuts.ts:35`, :41, :47 | Board and Canvas already have palette entries; defaults Mod+Shift+B/A, commands Mod+Shift+P. |
| `webview/components/right-pane.tsx:131`, :188, :228 maintain tab state, imperative switches and tab-strip move grip | Drive one effective view from App; retain imperative operations and relocate grip. |
| `src/window-registry.ts:143`, :173 persist bounds/session IDs only | Extend window layout with validated optional sidebar UI state. Do not put selected Space in global settings. |
| `webview/styles.css:1`, `esbuild.mjs:55`, :88, `package.json:50` | Google import/CSP exist; local font loaders and packaged out directory already provide a route. |
| `webview/components/terminal-pane.tsx:522`, :1086, :1190; `webview/terminal-gpu.ts:26` | Creation precedes font readiness; late-font callback fits, but does not refresh family/atlas; coordinator needs atlas invalidation. |
| `webview/themes.ts:53`, :62 | Five offered UI families plus System UI; three offered mono families. |
| `webview/components/sidebar.tsx:632`, `webview/components/update-card.tsx:17`, :42; `webview/components/toasts.tsx:13`, `webview/styles.css:6931`, :7452 | UpdateCard currently mounts in sidebar and uses sticky positioning; reuse the existing body-portal toast outlet for every existing card state. |

## 3. Spaces

Spaces header has Add space. Rows are 30px: All has a grid tile and total **N agents**; each saved Space has a colored letter tile, name, branch and most-urgent status mark. Stable palette assignment hashes immutable project ID into existing theme hue slots (green, violet, blue, accent); renaming/reordering does not change hue. No space uses a neutral tile. All counts every session once, including descendants and stopped records; live counts exclude stopped.

Selecting a Space filters Agents without changing or killing the focused session. All shows this window's sessions. Remember selection per window with its layout. Send sidebarUi once on create/restore, never recurring state; selection loss when planLayoutRestore drops an empty window is acceptable. New-agent and Mod+N default to selected Space; under All use the last focused agent's Space, else No space. Explicit launch contexts (board card, MCP caller, folder menu) retain their explicit project assignment.

Branch means the Space's last-focused session's `repoGit[activeRepoRoot].branch`; missing/deleted session falls back to most recently active member, ties creation then ID. Unknown, non-repo, bare or detached-without-branch omit branch rather than inventing main. Status aggregates members once; Done contributes to a Space's dot even if that member is displayed as a child. Empty saved Spaces remain selectable; No space does not.

Space menu keeps New agent in Space, Open board, Rename, Delete. No space menu offers New agent without a Space. Existing delete confirmation keeps sessions/folders and changes copy to No space. Move-to-Space picker remains the keyboard alternative to drag.

## 4. Status, completion and time

The server attention module owns runtime-only `attentionReason: 'blocked' | 'bell' | null` and `completions: number` (per-session monotonic during one server lifetime). `server/attention/index.ts:52` supplies status; `server/services.ts:110` merges it into snapshots/events; `src/contracts/server-protocol.ts:104` defines SessionView. Lead changes these producer contracts in S0; no persistence or migration.

Own row status: non-running/cannot-start → Stopped; otherwise non-null attentionReason or pending MCP ask for this session → Needs you; otherwise busy → Working; otherwise completions > seen[id] → Done; otherwise Idle. An ask cannot hide behind Working. Dirty repos and legacy completedRun/needsAttention do not determine the new Done/Needs you split.

Increment completions once at each qualifying run end, regardless of visibility: reported Working→Done/Idle, or heuristic run-end with existing min-duration/byte/quiet/spawn-grace evidence thresholds. A bell alone and entry into Blocked are Needs-you reasons, not completion events. Count each run even if legacy attention is already armed. ServerAttention owns the final counter and avoids double-counting heuristics while reported status is authoritative. Keep counter across terminal relaunch/exit, clear on session removal, reset on server restart. Broadcast reason/counter changes even if busy/needsAttention do not change.

Verified producer differences: `server/attention/index.ts:169` currently marks completedRun on any departure from Working, including Blocked, and :176 emits legacy run-end for waiting. `src/session-activity.ts:135` discards visible-session run evidence; :209 acknowledges visible sessions before evidence evaluation, :222 gates legacy episodes. New completions need separate visibility-independent qualifying evidence; do not simply count existing unseen edges or alter legacy notifications.

Renderer keeps only `seen: Record<id, number>` and `stateSince`; no busy-edge/generation inference. On renderer reload/app relaunch initialize seen to current completions for every session, preventing spurious historical Done. Baseline newly admitted IDs on first observation. On server-counter decrease clamp seen to at most completions. Coalesced snapshots may skip counter values without losing the final unseen result. Never persist seen/stateSince.

The sole strict viewed definition: clear Done only when the session is the focused, visible terminal in a focused window. Active behind editor/Board/Canvas, background split or hidden/minimized/unfocused window does not count. Needs-you arming deliberately retains looser server active-plus-split visibility (`src/attention.ts:31`, `src/session-activity.ts:183`): Done is a personal have-I-looked marker; Needs you must not fire for something already on screen. Do not change ui.presence to the strict rule.

Preserve legacy needsAttention/attention.edge consumers: notifications/OS flash (`electron/server-events.ts:160`, `electron/main.ts:2302`), generic sessionIconState (`src/session-icon.ts:52`), attentionSessions/attentionEntries (`src/attention.ts:10`, :108), legacy grouping (`src/session-groups.ts:79`). New sidebar ignores needsAttention. Footer calls a dedicated needs-you projection: feed attentionEntries cloned sessions with needsAttention = attentionReason != null and busy=false for those reason-bearing sessions, plus unchanged asks/messages/snooze. Finished-unseen legacy sessions are excluded; asks remain first, blocked/bell sessions retain input order, messages retain existing time order and click routing. An ask marks its row Needs you but does not synthesize an extra session entry absent a reason. Snooze also suppresses attentionReason on sidebar presentation clones until existing expiry, never raw server facts/counters or pending asks. Original session objects and legacy aggregator behavior stay unchanged.

stateSince changes only when own derived status changes (including seen/ask/reason/counter), not ancestor regrouping or unrelated broadcasts. Initialize from finite lastActiveAt clamped to now. Age: <1m below 60s, floor(minutes)m below 1h, floor(hours)h below 1d, floor(days)d thereafter; clamp negatives. Refresh minute boundaries without terminal remount. Parent age remains its own state age.

Groups: Pinned (if any), Needs you, Done, Working, Idle, Stopped. Hide empty groups; Stopped initially folded; persist folds. Headers follow .proj__label mono10px/chevron/count; Needs you uses attention ink. Count roots, not descendants. Unpinned roots sort effective rank descending, stateSince descending, createdAt ascending, ID tie-break; pinned roots use pin order.
## 5. Hierarchy

Parent is `openedBy.sessionId`, not handle, name or project. Resolve only within this window and after Space/text filtering: a missing/closed/other-window/filtered-out parent makes the child a root. Cross-Space children appear beneath a parent under All, but become roots under their own Space filter. Closing a parent leaves children running and visible as roots.

Build a multi-level forest. Reject self-parenting; break every cycle deterministically at the lexically smallest session ID in that cycle, then retain all nodes once. No recursive traversal may loop or overflow on malformed ancestry. Indent through logical CSS properties with `--border-2` connectors and rounded elbows; last child ends the vertical stroke.

Ranks: Needs you 4 > Done 3 > Working 2 > Idle 1 > Stopped 0. Effective parent rank is max(own rank, all descendants' ranks with every descendant Done treated as Idle). A blocked grandchild promotes every ancestor. Child Done appears Idle in its nested row and never promotes an ancestor to Done; its completion/seen state remains tracked so it can become a Done root when detached. Parent's status mark shows own status; effective Needs you adds attention row chrome and accessible text saying a descendant needs attention.

Fold chevron exists only with children; folded child count includes all descendants and is colored by their highest rank, with Done treated Idle. Folding never changes rank. Children are 26px, 13px icon, dim text; selection restores normal ink. Flatten the expanded forest once for pointer/keyboard navigation. Hidden descendants and folded groups are absent from next/previous traversal.

## 6. Agent rows and actions

Roots: 30px comfortable, 26px compact; 15px icon, session name, dim ` · Space` only under All, child fold control, mono 10px age, status mark. Flat at rest. Selected fill `--state-sel-bg` and 1px accent border wins over attention fill; effective Needs you uses today's attention card tint/border. Neon chamfer applies only selected/attention rows using existing machinery. Hover/focus-within replaces age with Pin and Close; stale relaunchable rows also show ↻. Keep status mark visible. Buttons never trigger row activation.

Working: accent spinner; Needs you: attention dot, Neon glow; Done: blue dot; Idle: hollow ring; Stopped: dashed ring. Labels/tooltips and accessible state text make all states distinguishable without color or motion. Double-click name enters rename; Enter/blur commit nonempty trimmed change; Escape cancels. Single click focuses terminal (the former Go to action).

| Existing action/indicator | New destination |
|---|---|
| Go to | Row click/Enter; explicit Go to in context menu |
| Snooze, including current duration | Context menu; retain existing snooze map and attention semantics |
| Relaunch / cannot-start reason | Context menu and ↻ hover when `canRelaunch`; reason in accessible tooltip |
| Awaiting approval | Context-menu View approval, plus status-bar first attention target |
| Timed messages / waiting count | Context-menu Timed message with count; existing dialog remains |
| MCP unread/urgent/connected/paused badges | Header Messages badge; per-agent menu Messages, pause/resume notices and connection explanation |
| MCP per-tool policy / setup | Existing session menu entries remain |
| Rename, Set icon, Duplicate, Open in split pane | Existing session menu entries remain |
| Move project/window/new window | Move to Space picker and existing window menu entries |
| Copy home/name, Reveal, Close/others/all | Existing session menu entries and existing close guard |
| Subtitle, detail, word pill | Removed; full name/Space/status remain in accessible row label/tooltip |

Pin/Unpin also exists in the context menu. Closing uses current running/dirty-session confirmations. No manual drag reorder or sort selector. Drag a row onto a concrete Space/No space to move only that session through existing project assignment; All is not a target. Descendants retain their own project assignment. Move failure keeps source membership and shows existing error feedback. Window-moving menu actions remain.

Remove card Title/Subtitle/Detail and group-by-project controls; harmlessly read old settings without using them for rows. No cardLayoutRev bump is required unless settings normalization otherwise overwrites legacy data. `SessionCardPreview` becomes a preview of this row. Agents header has New agent, live count, and Search agents button; Search reveals the existing Filter sessions… input with existing matching logic. Escape clears/hides and returns focus to Search; a nonempty query remains visible. Preserve global search and any existing sidebar filter shortcut; do not steal Mod+P.

Automatic glyph precedence: user iconOverride > current MCP CLI binding/handle prefix > detected terminal title appIcon > configured effective command (including custom command sessions) > terminal. Built-in kinds: claude, codex, opencode, cursor, gemini, powershell, terminal. Keep powershell/terminal literals unchanged, with no alias layer. Use own simple SVG marks following AgentIcon: Claude radial strokes, Codex terminal tile, OpenCode brackets, Cursor wire cube, PowerShell prompt tile, terminal outline. Gemini needs its own simple sparkle (ASSUMED; D3). No vendor logo assets or raw brand hex. Lead supplies agent glyph variants in S0; lanes may import lucide-react directly for other UI marks.

There is no new rail-mode feature. If implementation finds a real existing rail mode, preserve its threshold: icons + status only, children hidden, accessible names/tooltips intact. Existing narrow-card CSS is not authority to invent a rail threshold (ASSUMED; D4).

## 7. Header, right panel and status bar

Left: logo, Conduit wordmark, Back/Forward. Center search pill unchanged. Remove header Workspace/Board/Canvas switcher; preserve existing palette commands and shortcuts, including a palette route back to Workspace. Right: Files, Changes, Messages icon-only toggle buttons, then window controls. Accessible names/tooltips, `aria-pressed`, panel relationship; badge counts included in names. Changes uses existing Changes model/review count; Messages uses existing unread/urgent model. Mac preserves traffic-light reserve; same left identity/navigation and right toggles fit around it.

No `.rightpane__tabs`. Clicking inactive toggle opens that view, clicking active closes panel and returns width to center. Persist open state via explorerCollapsed and view via rightPaneTab. One effective view drives content and header, including temporary imperative views; imperative search/reveal/messages always opens the panel even if the remembered tab has not changed. Preserve remembered explicit view when an imperative view is temporary, matching existing semantics. App is sole view authority: delete RightPane local tab and App paneTab duplication; App opens the panel before imperative calls and runs them after mount. Keep panel movable through a dedicated small **Move side panel** grip at its top edge, with panel context-menu move actions as keyboard alternative. No replacement tab strip.

Status bar lives inside center column beneath terminal/editor, not across side panels. Aero: 32px panel card, `--panel`, `--r-panel`, existing panel shadow; Neon flush hairline, no shadow. Uniform `--win-pad` inset on all four window edges, including bottom. Show under editor/terminal; Board/Canvas use same center footer (ASSUMED; D5).

Left→right: monitor + This computer; active session repo branch from `repoGit[activeRepoRoot]`; worktree label only for `Session.worktree` or linked git worktree; N agents (live); clickable N need you; right actual bound commands shortcut hint. No active session: machine + counts only (no branch/worktree/hint). Omit unavailable branch/worktree. Machine label is informational, not a fake remote selector. Counts span this window, independent of Space/search/folds. Need-you count uses the section 4 projection into attentionEntries, excluding finished-unseen sessions while preserving asks, blocked/bell sessions, messages, snooze and first-target order. With zero entries omit the need-you action. Hint uses effective rebindable openCommands combo, default Ctrl+Shift+P / ⌘⇧P; unbound shows Commands without fabricated keys.

### Floating update notifications (Revision 2)

UpdateCard leaves the sidebar footer. G1 removes its sidebar mount; G2 owns UpdateCard and the existing Toasts outlet (`webview/components/toasts.tsx:13`). Render all existing card states—available, downloading and ready—as one persistent update item in that single body-portal stack, fixed with equal `--toast-inset` of 24px from the window bottom and right, overlaying the status bar's right end. It overlays content, reserves no sidebar/center/footer space and never changes layout. Keep the same bottom/right anchor for every state, progress update, sidebar collapse, panel toggle and center view; a taller ready card grows upward. Update the single item in place, never accumulate a card per status. Other existing transient notifications share the stack above the update item, so there are no overlapping independent outlets.

Downloading shows numeric percent plus the existing progress bar; finite percent is clamped to 0–100 and displayed as a locale-formatted rounded integer, absent percent follows today's zero fallback. Available keeps today's Updating to v… label. Ready shows v… ready and **Relaunch to update**. Keep today's Dismiss and relaunch behavior only; **What's new/release-notes link is out of scope**. Checking/up-to-date/error retain today's UpdateCard visibility rule (no card) and existing Settings → About handling; do not invent extra notification actions. App owns updateStatus/updateDismissed and its existing ready-event dismissal reset (`webview/app.tsx:510`, :775); no new toast timer or duplicate update store. Dismissed updates stay hidden until the existing reset, even if unrelated notifications remain.

The shared anchor uses `right: var(--win-pad)` and `bottom: calc(var(--win-pad) + var(--status-bar-h) + var(--gutter))`; `--status-bar-h` is the same 32px geometry used by the footer, not a guessed offset. Retain existing --layer-toast and token surfaces/borders/elevation, pointer-events none on the outlet and auto on cards. Keep viewport-safe existing toast width/wrapping and reduced-motion behavior. Lifecycle transitions announce politely without stealing focus; percentage uses an accessible progressbar rather than a live announcement on every tick. G2 owns update/toast rules; G1 deletes obsolete .sidebar__update placement and preserves the Settings footer.

## 8. Font fix

Lead-provided diagnosis: hc exposes TERM=xterm-256color; subset gaps and late loading leave fallback glyphs in the atlas. Source paths inspected, screenshot not reproduced here (D1). Keep TERM=xterm-256color.

Bundle mono JetBrains Mono, Fira Code, IBM Plex Mono plus Cascadia Mono from upstream release files, variable where available, chosen by measured cmap coverage of ✔❯⚠⏺⎿● and terminal symbols. UI Figtree/Hanken Grotesk/Inter/IBM Plex Sans/Chakra Petch may use Fontsource/Google slices with offered 400/500/600/700 weights; System UI remains platform-provided. Ship THIRD_PARTY_NOTICES.txt, no runtime Google dependency. `webview/fonts.ts` side-effect imports CSS/assets from `webview/index.tsx`, never through terminal-fonts. Stack includes Cascadia Mono and Segoe UI Symbol before generic; bundle measured fallback rather than assuming OS coverage (D2). G3 owns manifests, lockfile, notices and font entry wiring.

Once at app boot, before the first terminal mounts, await document.fonts.load for selected UI and mono regular+bold, sample including ✔❯⚠⏺⎿●, fallback family included in the font string. Rejection or resolved empty array means failure: log and continue, never block a session or show a per-terminal error/Retry gate. This is one app boot gate; after settlement terminals construct synchronously. Boot chrome may appear while loading.

On terminal-font change load first then set the changed option; failures log and continue. On document.fonts loadingdone call public `term.clearTextureAtlas()` for every registered terminal, refresh and fit, preserving host size/facts/replay guards. Re-setting identical fontFamily is an xterm no-op, not invalidation. Coordinator batches all-terminal refresh; no addon/private API or GPU-loss budget use. Set rescaleOverlappingGlyphs: true. No per-pane asynchronous Terminal creation or cancellation machinery.

Existing esbuild font loaders emit packaged out assets/notices; remove Google @import and CSP origins. Verify dev/package, offline cold boot, empty/rejected-load continuation, regular/bold/symbol coverage, load-before-option change and multi-terminal loadingdone.
## 9. States, accessibility and internationalization

| State | Visible response and action |
|---|---|
| Populated | Spaces + status forest; selected row and active terminal are distinguishable from Space filter. |
| First run / zero sessions | All 0 agents; Start an agent primary action; Add space available. |
| Empty selected Space | No agents in this Space; New agent defaults to it. |
| No text matches | No sessions match “query”; Clear filter. |
| Hydrating | Chrome immediately; loading placeholder only in unresolved list region; no empty-state flash. |
| Partial repo/MCP data | Rows usable; omit unknown branch/badge, update when known. |
| Disconnected/runtime unavailable | Retain last state, existing connection/retry UI; do not fabricate Working or queue commands. |
| Server restart | Counters reset (§4) and `seen` clamps down on the first lower counter it observes. Known edge (accepted): snapshots carry no server-instance id, so a restart the renderer never sees as a decrease — the new counter has already reached or passed the old `seen` — can briefly show a spurious Done until the terminal is viewed. |
| Missing folder/start refusal | Stopped mark + reason; existing reconnect/relaunch remediation. |
| Deleted Space/session | Fall back to All for removed selected Space; re-root children; no stale selection crash. |
| Save/move/rename pending or failed | Existing host feedback; rollback rejected membership/name; keep focus on actionable item. |
| Font load pending/error | One boot wait before terminal mount; empty/rejected loads log and continue, no per-pane error gate. |
| Update available/downloading/ready/dismissed | Same floating bottom-right update item/anchor; downloading percent, ready Relaunch, existing dismiss/reset; no layout shift or What's new action. |
| Long/deep list / limits | Scroll list, ellipsis + full accessible names; deep trees remain navigable; no new session cap. |

Use real buttons for Spaces/groups/folds/toggles/actions. Agent tree uses roving focus, `treeitem`/`group`, aria-level/expanded/selected, with action buttons outside its activation button (no nested buttons). Up/Down/Home/End follow flattened visible order; Right expands then enters first child, Left folds then goes to parent; Enter activates terminal; Shift+F10/Menu opens same context menu. Next/previous session commands consume that same visible order. Never intercept terminal arrows outside sidebar. After removal focus nearest visible row or New agent; collapsing a focused descendant moves focus to parent. Pin/regroup preserves focused ID; row movement does not unexpectedly focus a terminal.

All icon-only controls have labels and tooltips; hover actions appear on focus-within and remain available through menus/touch. Focus uses existing focus-ring/inset/forced-colors treatment. Selection has border/aria state; marks have shape + accessible text. Reduced motion replaces spinning/glow animation with a static Working mark. Polite announcements for move/pin/rename failures and completion group changes; no once-per-minute age announcements. Validate text contrast and visible focus in all three themes, forced colors, 200% zoom, 30% text expansion, narrow window and Mac traffic-light layout.

Centralize new strings in `webview/sidebar-strings.ts` and `webview/chrome-strings.ts`, following MCP_STR's function style. Plural-aware counts (0/1/many), locale-aware numbers; epoch-ms runtime timestamps. Preserve user names verbatim, no translating code/internal project keys. Logical indentation/connectors mirror in RTL; source paths/branch names remain bidi-isolated. Severity/order is numeric, never locale sorting. Truncate branch/name visually with full tooltip and accessible value; do not truncate the action's meaning.

## 10. Token contract

Do not copy mockup raw hex/rgba values. Existing :root/aero/neon tokens are authority (`webview/styles.css:7`, :292, :372). Mockup faint/border/alpha values differ; use repo tokens. UI/mono fonts use --font-ui/--font-mono; text tiers --text/--text-dim/--text-faint; selected --state-sel-bg/--accent; status --amber/--blue/--accent; surfaces --panel/--raise; connectors --border-2; shape --r-md/--r-panel/--r-badge; motion/glow --glow-attention/--glow-accent; window --win-pad/--gutter; panel material reuse `.panel` treatment (`--elev-1`).

Attention wash/border reuse color-mix formulas at `webview/styles.css:2366`; text ink uses existing attention-chip mix at :1299. Stable Space tiles mix palette hue with transparent. Row geometry belongs to density, never theme blocks. Existing chamfer selector applies to all .session at :518; narrow it to selected/attention in the owning stylesheet, not via higher specificity or source-order overrides. G1 replaces sidebar/session/proj/dot rules in styles.css in place; G2 replaces topbar/view-switch/chip/right-tab/window-control/toast/update rules and adds footer rules there; lead owns tokens and other shared material. Exact base ranges are in the plan; no separate sidebar-tree.css. New shape tokens only for absent roles: --r-space-tile (5px Aero/0 Neon), --r-tree-elbow (6px/0). Shared --status-bar-h (32px) supplies footer geometry; --toast-inset (24px) supplies equal window bottom/right insets; dimensions 30/26/32 are not duplicated across theme rules. Glyph fills use token ink/hues; mockup raw Claude/PowerShell brand colors are not copied.

## 11. Acceptance criteria

AC1 Visible Project copy becomes Space; existing data and MCP names/params remain compatible.
AC2 Space filtering/default launch/persistence works independently in two restored windows; No space hides when empty.
AC3 Server reasons/counters, strict viewing, reload baseline, restart clamp and visibility-independent repeated completions work; ranks/folds/pins/ages follow sections 4–5.
AC4 Multi-level tree, filtered/orphan/cross-window children, malformed cycles, close-parent survival and move-only-one-session work.
AC5 Rows match design in three themes/two densities; all former actions remain reachable; settings preview is a row.
AC6 Visible-order keyboard navigation, search reveal, rename, drag alternative, focus and accessible states work.
AC7 Header toggles replace right tabs, preserve badges/grip/imperative opens/persistence; Board/Canvas/Workspace palette routes work.
AC8 Status bar uses active repo/worktree/window counts and routes first attention item; real rebound shortcut and empty-active state work.
AC9 Local fonts, one boot wait, empty/rejected-load continuation, public all-terminal atlas refresh, load-before-option change and symbol coverage work; TERM unchanged.
AC10 Existing e2e selectors retained where meaningful; full verify and remote integration e2e pass without weakening checks.
AC11 UpdateCard is absent from sidebar, appears once in the shared fixed toast stack with equal 24px window bottom/right insets over the status bar's right end for all existing visible states, shows download percent and existing actions only, preserves dismissal/reset, and changes no workbench bounds.

### Required flows (EARS / Gherkin)

When a descendant needs attention, the system shall place its root in Needs you even when that descendant is folded. While a session is merely active behind an editor, the system shall retain its unseen completion. When the active right-panel toggle is pressed, the system shall close the panel and return its width to the center.

```gherkin
Scenario: Cross-Space ancestry respects the selected filter
  Given parent P is in Space A and its child C is in Space B
  When All is selected
  Then C appears once beneath P
  When Space B is selected
  Then C appears once as a root and P is absent

Scenario: A new completion can need viewing again
  Given a completed agent has been viewed as the focused visible terminal
  When the server counts another qualifying run while an editor is focused
  Then it appears Done
  When its terminal becomes focused and visible
  Then it appears Idle

Scenario: Font failure never blocks an agent
  Given boot font loading returns an empty array or rejects
  When loading settles
  Then failure is logged and terminals mount
  When a later loadingdone event fires
  Then every registered terminal clears its atlas, refreshes and fits
```

### Changed producers and consumers

Server attention produces counters/reasons through SessionView; strict terminal focus produces only seen/stateSince consumed by the tree; renderer selection produces window UI consumed by the host layout writer and restore parser; MCP `openedBy` produces ancestry consumed by the forest; binding/title/effective command produce glyph identity consumed by row rendering. Header/imperative navigation produce effective panel state consumed by both header and RightPane. Reason-filtered attention entries produce footer counts/actions. App callbacks feed the pure session-menu builder extracted in S1, then G1 owns the builder and relocated actions. Bundled font files produce one boot readiness result; later FontFaceSet events drive public all-terminal atlas refresh. The plan assigns both sides of every new seam; unchanged host assignment and opener APIs remain the producers of Space membership and ancestry.

All approved A–E behavior is the first release scope; remote machines and new rail behavior remain outside it. No requested behavior is deferred to a later visual polish phase.

## Decisions Needed

- **[high] D1 ASSUMED:** screenshot diagnosis and exact loaded-glyph coverage are lead-provided, not reproduced here. Default: implement prescribed load/atlas fix; font lane measures font tables and running symbols before claiming success.
- **[normal] D2 ASSUMED:** upstream mono/Cascadia release versions, cmap coverage, variable/static formats and license files are not measured in this docs lane. Default: G3 selects upstream files by actual symbol coverage, bundles OFL notices and optional sliced UI families; never claim coverage from document.fonts.check or OS fallback alone.
- **[normal] D3 ASSUMED:** mockup has no Gemini mark or pin-child behavior. Default: simple token-colored four-point sparkle; pinning a child promotes it to a Pinned display root (one occurrence), its descendants stay attached; underlying openedBy unchanged.
- **[normal] D4 ASSUMED:** no separate collapsed rail found in inspected sidebar; preserve full collapse only. Confirm by targeted layout scan before adding any rail logic; do not invent threshold.
- **[normal] D5 ASSUMED:** status footer remains on Board/Canvas; empty-active footer contains only machine/counts. Branch of a Space follows last-focused member as §3; user-approved active-session status bar source is unchanged.
- **[normal] D7 ASSUMED:** the brief's sidebar-filter/next-previous-session commands exist under another name; the targeted source scan found no named equivalents. Default: preserve tab-navigation bindings and provide unbound palette Filter agents / Next agent / Previous agent actions plus sidebar arrows; retain any existing equivalent found during the full keyboard audit without stealing its chord.

Self-audit: state catalog, interaction inventory, accessibility, i18n, tokens, producer/consumer ownership, acceptance and assumptions addressed. Revision 1 independent architecture review incorporated; reviewer agent in this lane omitted under the explicit no-spawn lane instruction; source and contract consistency reviewed in this lane.

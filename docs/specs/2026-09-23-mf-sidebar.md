---
status: draft
date: 2026-09-23
---

# Feature Spec: mf-sidebar — sessions rail grouped by project, simplified card, project management

**Tier:** FULL   **Feature type:** UI
**Item (conductor, verbatim scope):** sidebar grouped by project (10a); simplified session card
with a hover × (9b); group-header hover + and project-aware Ctrl+N / header + (11a); group-header
right-click menu (New session in project, Open board, Rename…, Delete project… + the delete
dialog); session card menu = today's flat menu + `Move to project…` picker, `Copy path` →
`Copy home path` (12e); drag a card onto another group's header to move it; filter over session,
project, folder and agent names; sessions empty-state copy (12i).

Written in autonomous mode against `.autoloop/locked.md` (L1–L10). **mf-model** delivers
`Project`, `state.projects`, `Session.home/roots/projectId` and the `project:*` /
`session:setProject` messages before this item; this spec only consumes them. Design source:
`.autoloop/handoff/README.md` §9b, §10a, §11a, §12e, §12i and the two `.dc.html` prototypes
(copy and sizes below were grepped from them). Would-be questions are in §13.

## 1. Problem frame

- **Job:** once a session can span several folders, the rail can no longer group by folder. The
  user wants the sessions grouped by the named project they belong to, wants to file a session
  into a project (or out of one) without restarting it, and wants to create, rename and delete
  projects from the rail.
- **Actors:** a developer running several agent sessions in one or more windows. The host owns
  every project and session (the renderer holds no source of truth; CLAUDE.md).
- **Success outcomes:**
  - With "Group by project" on, the rail shows one group per project (in `Project.order`), then
    a **Standalone** group last. Every session sits under its `projectId`.
  - A session moves between projects via the card menu picker or by dropping it on a group
    header. It keeps running and keeps its terminal.
  - Header +, the rail header +, Ctrl+N and the pane menu's New session all open New session with
    the right project pre-selected.
  - Rename and delete of a project take effect in every window. Delete never touches a session's
    process, its folders or `.conduit/`.
  - The card is the 9b card: glyph, name, agent, status pill and a hover ×. The session features
    people act on (Needs you actions, relaunch, timed-message chip) survive (§13 D1–D4).
- **Non-goals:** the New session dialog itself (mf-new-session; this item only passes the
  project it opens with); the data model, persistence, migration and host validation (mf-model);
  the "Can't start" state for a missing home (mf-live-edits, §3); board ↔ session linkage
  (mf-board); explorer "Open as new session" pre-fill (mf-files, which calls this item's helper);
  a project ticket-key pill (§13 D8); multi-select of cards; cross-window drag changes.

## 2. Behavior & states

### 2.1 Grouping

- **Grouped** (`settings.sessionGroupByProject`, default on). Groups are built by a pure
  function `groupSessions(sessions, projects, sort)`:
  - One group per project in `state.projects`, **including projects with zero sessions in this
    window** (§13 D10), then the Standalone group.
  - A session whose `projectId` is absent **or names a project not in `state.projects`** goes to
    Standalone (L2).
  - Group order: manual sort → `Project.order`; any other sort → project name,
    `localeCompare` with `{ sensitivity: 'base' }`. **Standalone is always last** (L10) and is
    omitted when it has no sessions.
  - Sessions inside a group follow the active sort. Needs-you sessions float to the top of
    their group in non-manual sorts, as today.
- **Ungrouped:** one flat list, as today. Header +, Ctrl+N and the card menu work the same.
  Header-drop targets don't exist in this mode.
- **Sort "Project"** (`sessionSort: 'project'`) orders by project name, then session name, with
  standalone sessions last. It replaces today's folder-basename ordering.
- **Collapse:** the chevron toggles the group's key in `settings.collapsedProjects`. The key is
  the project id, or `'standalone'` (L10). A collapsed group with a hidden busy or needs-you
  session keeps today's `proj__count--attn` signal.

### 2.2 Group header

Layout, left to right: chevron, `proj__name` (mono 10px, the project name; `Standalone` for the
standalone group), then the count. `title` = the project name (today's full-path tooltip goes,
since a project has no path). Each group is `role="group"` with `aria-labelledby` pointing at
its `proj__name`. On hover or focus-within, a
**+ button** (accent solid circle, 20×20, as in 11a) takes the count's slot. The count is
hidden while the + shows, so the row doesn't reflow. At rest the + is `opacity:0;
pointer-events:none`, per the hover-obstruction rule. The + and the rename input stop
`dragstart` propagation, as the chevron does. The header's `onContextMenu` calls
`preventDefault()` so the pane menu (`onPaneContextMenu` bails on `defaultPrevented`) doesn't
open too.

- **+** → `openNewSession({ projectId: <this group's id | null for Standalone> })`.
- **Drag the header** (project groups only) reorders projects. On drop it posts
  `project:reorder { ids }` with the new full order. The Standalone header is not draggable and
  is not a reorder target. This replaces today's `reorderByGroup` session-id rewrite for grouped
  mode. If the sort isn't manual, the drop also switches it to manual, as today. As a visible side
effect, in-group order then follows the global manual order. Project order is global, and each
drop is computed from this window's view: projects this window doesn't render keep their
relative positions (§13 D11).
- **Right-click, or Shift+F10 / the Menu key while the chevron or + has focus** → the header
  menu:

| Item | Project group | Standalone group |
|---|---|---|
| New session in project | `openNewSession({projectId})` | shown as **New standalone session** → `{projectId: null}` |
| Open board | §2.5; **disabled** when the project has no session in this window | — |
| Rename… | starts inline rename (§2.4) | — |
| Delete project… (danger, separator before) | opens the delete dialog (§2.6) | — |

### 2.3 Session card (9b)

One row: `SessionGlyph` (kept, not replaced by a dot; §13 D5), a text column, the status pill,
the timer chip (only while one is waiting), the relaunch ↻ (stale only) and the ×.

- **Name line:** `fieldValue(cardTitle)`, default the session name, Figtree 600 12.5px,
  ellipsised. Double-click renames it inline, as today.
- **Second line:** `fieldValue(cardSubtitle)`, **default `agent`** (the agent label, e.g.
  `claude`), mono 10px, muted. The `live` activity line is no longer the default (§13 D4).
- **Third line:** `fieldValue(cardDetail)` only if the user set one (default `none`), mono 10px.
- **Status pill:** a restyle of today's `.session__state` word, which already renders
  `SESSION_STATE_WORD[state]`: Busy / Idle / Review / Needs you / Stale. Font
  700 9.5px, padding 3px 8px, pill radius. Busy is accent-tinted and Review / Needs you are
  warn-tinted. Idle and Stale have no fill, as in 10a. Neon keeps `--label-case`. The pill renders
  whatever word the shared derivation returns, and its CSS keys on `.session--<state>`.
  **mf-live-edits owns "Can't start" end to end**: the `cantStart` state, its word, and its
  `.session--cantStart` class and pill tint (`--bad` family). This item adds nothing for it (§3).
- **Hover ×:** 20×20, radius 8px, neutral fill. On `:hover` or `:focus-visible` it turns
  `color: var(--bad)` on `color-mix(in srgb, var(--bad) 12%, transparent)`. It reuses
  `.session__kill` semantics: it holds its slot at all times, is invisible and
  `pointer-events:none` at rest, and is revealed on card hover or focus-within. `title` and
  `aria-label` are "Close session". It calls today's `requestKill`, so the close-running
  confirm is unchanged.
- **Removed from the card:** the age label, the busy meter and the Review diffstat button
  (§13 D2, D3). **Kept:** the Needs-you row `Go to` / `Snooze` (shown only in that state; §13
  D1), the timer chip and relaunch ↻.
- `.session--<state>` card tints and the selection cue are unchanged.

### 2.4 Inline project rename

Rename… (or double-clicking the header name) turns `proj__name` into an input prefilled with the
name, fully selected and focused. **Enter** or blur commits the trimmed value via
`project:rename {id, name}` when it's non-empty and changed. **Escape** cancels. An empty value
reverts. While the input is up the header isn't draggable and its clicks don't toggle collapse.
The rail shows the name from `state.projects`. Nothing is optimistic: the name changes when the
host's next `state` arrives. Duplicate names are allowed (§13 D9).

### 2.5 Open board

The board resolves against the **active session's home** (L7). Open board picks a target
session: the active session if it's in the project, else the project's session in this window
with the highest `lastActiveAt`. It selects that session and switches the center view to
`board`. With no session in this window the item is disabled, because there is no home to read
a board from (§13 D6).

### 2.6 Delete project dialog (12e)

This is the existing `ConfirmDialog` (a `ModalLayer`), not a new component.

- **Title:** `Delete “<name>”?`
- **Message** (pluralised). N counts the project's sessions in `state.sessions`, which holds
  **only this window's sessions** (measured, §2.12). While more than one window is open
  (`win:list` length > 1), the count-free form is used (§13 D13):
  - N ≥ 2: `Its N sessions become standalone and keep running. Folders and their .conduit/ data
    aren't touched.`
  - N = 1: `Its 1 session becomes standalone and keeps running. Folders and their .conduit/ data
    aren't touched.`
  - N = 0, one window: `It has no sessions. Folders and their .conduit/ data aren't touched.`
  - Several windows: `Its sessions become standalone and keep running. Folders and their
    .conduit/ data aren't touched.`
- **Buttons:** `Cancel`, then `Delete project` (danger). Uses `focusCancel: true`, so Enter
  does not delete (house rule for destructive confirms).
- **Confirm** posts `project:delete {id}` and removes the id from `settings.collapsedProjects`.
  Sessions reappear under Standalone on the host's next `state`.

### 2.7 Card context menu

Today's `onSessionContextMenu` items, in today's order, with two edits:

1. **`Move to project…`** goes right after `Duplicate session`, before the Move-to-window items,
   in the same group, as in the 12e screenshot. Icon: `IconFolder`.
2. **`Copy path` → `Copy home path`**, which copies `s.home`. `Reveal in Explorer` reveals
   `s.home`. (The `projectPath` → `home` rename is mf-model's. This item changes the label.)

**Move-to-project picker:** choosing the item closes the context menu and opens a `Popover`
anchored beside the spot where the menu row was (`at` = the menu's right edge, level with that
row). That is where 12e draws it. It is a popover, not a modal like `IconPickerModal`: "like Set
icon…" means "opened by a flat item, not a submenu" (§13 D14). It is about 200px wide and styled
as a menu surface. It uses Popover's own `.popover` class, which `drag-region.test.ts` already
covers for `no-drag`, so no new selector is needed.

- `Filter projects…` input, focused on open. It filters by case-insensitive substring of the
  project name. When nothing matches, one disabled row reads `No projects match`;
  Standalone and `+ New project…` stay visible.
- Projects in `Project.order`, then `Standalone`. The row matching the session's current project
  (or Standalone) carries a trailing accent `IconCheck`.
- Separator, then `+ New project…` (accent). It turns the footer into a name input prefilled with
  the filter text. On Enter the picker trims the name and collapses its whitespace. An empty
  name, or one over 80 characters, is rejected in place with nothing sent: the input stays and
  its hint reads `1–80 characters`. This mirrors mf-model's rule. Otherwise Enter posts
  `project:create {name, requestId}` and disables the input. On `project:created {requestId,
  id}` (mf-model §messages) the picker posts `session:setProject {sessionId, projectId: id}`
  and closes. On `project:opResult {requestId, ok:false, reason:'invalid-name'}` it re-enables
  the input with the same hint. Escape returns to the list.
- **Lifecycle:** the picker closes without posting if its session leaves `state.sessions`
  (closed or moved to another window). A `project:created` reply that arrives after the picker
  closed is ignored, so the project exists but nothing is filed. With no reply within 5s the
  input re-enables.
- Picking a row posts `session:setProject {sessionId, projectId | null}` and closes. Picking the
  current row just closes.
- Keyboard: ArrowUp/Down move the highlight across rows (the input keeps focus), Enter picks, and
  Escape closes through the overlay stack. `role="listbox"` with `aria-activedescendant`, and the
  rows are `role="option"` with `aria-selected` on the current one.

### 2.8 Drag a card onto a header (grouped mode only)

- A card drag keeps today's in-group reorder (card over card in the **same** group).
- While a card drags over **another** group's header, that header shows a drop-into cue
  (`proj__label--dropinto`: accent outline plus accent 9% fill; not the `--dropbefore` bar a
  header drag uses) and accepts the drop. On drop it posts `session:setProject {sessionId,
  projectId: <target id | null for Standalone>}`. The session's global order is untouched.
- A drop on the session's own group header, or on any card in another group, is a no-op with no
  cue.
- `onDragEnd` still reports screen coordinates for the cross-window hit-test. The host no-ops a
  drop inside this window, so a header drop never also moves windows.
- Card drags and header drags stay on separate markers (`dragIdRef` vs `dragGroupRef`). A card
  over a header acts only when `dragIdRef` is set, and a header drag over a header only when
  `dragGroupRef` is set.
- The resolution is a pure function `cardDropIntent(session, targetGroupKey)` →
  `{projectId: string | null} | null`, so it can be unit-tested. The e2e proof is in §7.4.
- With a text filter active, drag is disabled, as today. The picker (§2.7) is the non-drag path.
- When every session is in a project, the Standalone group is omitted, so there is no Standalone
  header to drop on. The picker's `Standalone` row is the only way out. This is deliberate
  (§4).

### 2.9 New session's project (11a)

One pure helper, `projectForNewSession(active: Session | undefined, projects): string | null`,
returns `active.projectId` when it names a live project, else `null`. Callers:

| Entry point | Project passed |
|---|---|
| Rail header +, Ctrl+N (`shortcuts.ts` newSession), command palette "New session", center empty-state New session, pane-menu New session | `projectForNewSession(active)` |
| Group header + / "New session in project" | that group's id (`null` for Standalone) |
| Explorer "Open as new session" (mf-files), board Start session (mf-board) | those items call the same helper |

`newSession` state (app.tsx) gains `projectId?: string | null`, which mf-new-session reads as its
chip's initial value.

### 2.10 Filter

`sessionMatchesFilter(s, q, ctx)`: a trimmed, lowercased substring match against the session
name, the **project name** (none for standalone), the basename of `s.home`, the basename of
every entry in `s.roots`, and the agent label. A group shows when at least one of its sessions
matches. **Empty projects are hidden while a filter is active.** "No sessions match “q”." is
unchanged.

### 2.11 Empty state (12i)

- **First run** (`sessions.length === 0` **and** `projects.length === 0`): title `No sessions
  yet`, hint `A session is one terminal working across one or more folders. Run four at once.`
  There is no filter row.
- **Empty after action** (no sessions in this window, but projects exist): no prose. The rail
  shows the project headers (count 0) in grouped mode, so projects stay reachable to rename,
  delete, reorder and header-+. The filter row stays hidden. In ungrouped mode the first-run
  copy shows (§13 D10).

### 2.12 Current behavior this changes

| Claim about today | How measured | Measured / ASSUMED |
|---|---|---|
| Groups key on `projectPath`; the header shows `baseName(path)`; `collapsedProjects` holds paths | read `sidebar.tsx:331-342, 450-487`; the collapse-persist check in `sidebar-dnd.e2e.mjs` | inspected (source) |
| A card drag reorders only within its group; a header drag rewrites session order via `reorderByGroup` | `sidebar.tsx:242-297` | inspected (source) |
| Card extras: age, state word (`.session__state`), timer chip, ↻, ✕, subtitle/detail fields, busy meter, Go to/Snooze, review diffstat | `session-card.tsx:138-250` | inspected (source) |
| `cardSubtitle` default `live`, and persisted settings carry the full object | `settings.ts:188`, `serializeSettings:357` | inspected (source) |
| Card menu order: lifecycle, Rename, Set icon…, Timed message…, Duplicate, Move-to-window, Copy path, Copy name, Reveal, Close ×3 | `app.tsx:2017-2130`; `context-menu-order.e2e.mjs` asserts it | inspected; the e2e exists |
| `state.sessions` is per-window: each window gets only the sessions it owns | `electron/main.ts` postState ~1665-1687 (`sessionsOwnedBy(sessionOwner, windowId, all)`) | inspected (source) |
| HTML5 DnD in this app: Playwright's mouse `dragTo` never fills a real `dataTransfer`, but explicit `new DragEvent(…, {dataTransfer})` dispatches with one shared `DataTransfer` do reach React | `test/e2e/terminal-drop.e2e.mjs` header note plus its passing drop assertions. This contradicts the older `sidebar-dnd.e2e.mjs` note (which tried events without a shared DataTransfer). | inspected (existing green e2e); re-proved by §7.4 |

## 3. Data / interface contract

- **Consumed from mf-model** (L1–L3, L10): `state.projects: Project[]`, `Session.projectId?`,
  `Session.home`, `Session.roots`, and the messages in the mf-model spec:
  `session:setProject {sessionId, projectId, requestId?}` → `session:opResult {requestId, ok}`;
  `project:create {name, requestId}` → `project:created {requestId, id}` or
  `project:opResult {requestId, ok:false, reason:'invalid-name'}`; `project:rename`,
  `project:delete`, `project:reorder {ids}`. The host validates every one, so the renderer doesn't pre-validate ids
  beyond excluding its own no-ops.
- **Settings:** `collapsedProjects: string[]` of project ids or `'standalone'` (mf-model's
  coerce drops old paths). `cardSubtitle`: default changes to `'agent'`, plus a one-shot upgrade
  (§5, §13 D4).
- **Renderer state added:** `newSession.projectId?: string | null`; sidebar-local
  `renamingProjectId`, `overHeaderKey`, and the picker state `{sessionId, at, filter, creating?,
  pendingRequestId?}`.
- **Group key:** `string` = the project id, or the literal `'standalone'`. mf-model must not mint
  a project id equal to `'standalone'` (a UUID never is). This is recorded, not flagged.
- **Pure helpers** (new file `webview/session-groups.ts`, or extend `src/reorder.ts`; the planner
  picks): `groupSessions`, `sessionMatchesFilter`, `cardDropIntent`, `projectForNewSession`,
  `deleteProjectMessage(name, count)`, and `openBoardTarget(projectId, sessions, activeId)`.

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `Session.projectId` change | host on `session:setProject` (mf-model) | rail grouping, delete count, Open board | producer mf-model (locked); consumer here. Yes via the lock. |
| `state.projects` (names, order) | host `project:*` handlers (mf-model) | group headers, picker, filter, sort | same as above |
| `project:created {requestId, id}` | host (mf-model spec, messages table) | picker's chained `setProject` | Yes: the shape is pinned in the mf-model spec (§13 D7) |
| `session:opResult` for a move | host (mf-model) | the aria-live move announcement (§10) | Yes |
| `newSession.projectId` | this item (every New session caller) | the New session dialog chip (mf-new-session) | Yes: this item produces it; mf-new-session consumes it by name |
| Card status word | `sessionIconState` / `SESSION_STATE_WORD` (`src/session-icon.ts`) | card pill, topbar chip | The "Can't start" state is **produced by mf-live-edits**. This card renders any word generically, and neither item hard-codes the other's state. |
| `collapsedProjects` | this item (toggle, delete prune) | this item; coerce (mf-model) | Yes |
| `cardSubtitle` upgrade | settings coerce (this item) | card, settings preview | Yes |

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| A session's `projectId` names a deleted or unknown project | It renders under Standalone. The picker ✓ is on Standalone. |
| A project is deleted in window B while window A has its rename input or picker open | The next `state` drops the project. The rename input closes without posting. The picker re-renders without the row, and a pending pick of it is a host-rejected no-op. |
| Delete count with several windows open | `state.sessions` is per-window, so the count-free copy is used whenever more than one window is open (§2.6, §13 D13). |
| Double Enter in the picker's New project | `pendingRequestId` is set on the first Enter and the input is disabled until the reply, so there's no second create. With no reply in 5s, the input re-enables and nothing is chained (the project may exist; it shows in the list). |
| `session:setProject` is rejected by the host | Nothing changes, because the rail renders only host state. No toast. |
| Zero projects | The grouped rail shows only Standalone. The picker shows Standalone + New project…. |
| One session, many projects | Empty project headers show (count 0). Hover + still works. |
| Very long project name | The header name and picker row ellipsise, with the full name in `title`. The rename input scrolls. |
| Dropping on a collapsed header | Accepted. The card disappears into the collapsed group, and the count and attn signal update. |
| Moving the active session | It stays active and the center pane is unchanged, so the PTY is not remounted (see the PowerShell remount gotcha in memory; the card's React key stays `s.id`). |
| A header drag while a card drag is in flight | Impossible (one native drag at a time). The markers keep them apart anyway. |
| A text filter is active | No drag at all. The picker still works. Empty projects are hidden. |
| Ungrouped mode | No headers, so no header menu, header +, or header drop. The picker and Ctrl+N still work. |
| An old `collapsedProjects` path entry | Dropped by mf-model's coerce, so the groups start expanded. |
| Every session is in a project | Standalone is omitted, so there's no drop target for "out of project". The picker's Standalone row covers it. |
| The picker's session closes or moves windows while the picker is open | The picker closes without posting. A late `project:created` is ignored. |
| No sessions in this window, but projects exist | Headers show with count 0 (§2.11). The first-run copy doesn't show. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Group by project | on (unchanged) | yes, `···` menu | existing setting (L10) |
| Card subtitle | `agent` | yes, Settings → Session card | the 9b design; a durable preference already exists |
| Upgrade `cardSubtitle: 'live'` → `'agent'` once | on | the user can pick Live again | `live` was the default, so nearly everyone has it persisted without having chosen it (§13 D4) |
| Card detail | `none` (unchanged) | yes | — |
| Empty projects visible | yes, unless filtering | no | a new or emptied project would otherwise be unreachable (§13 D10) |
| Delete confirm default focus | Cancel | no | house rule for destructive confirms |

**Upgrade mechanism (D4):** a new persisted setting `cardLayoutRev: number`, with
`DEFAULT_SETTINGS` = 2. In `coerceSettings`, a payload without it (or below 2) with
`cardSubtitle === 'live'` becomes `'agent'`, and every coerced result carries
`cardLayoutRev: 2`. An explicit Live afterwards persists alongside rev 2 and isn't rewritten.
`VERSION` stays 1, because a bump makes `parse` drop every setting.

The Settings "Session card" preview renders the new card (glyph, name, agent line, pill) so it
can't drift from the rail (AC 13).

## 6. Scope slicing

- **MVP (must):** §2.1 grouping by project + collapse by id; §2.3 card; §2.9 the project handed
  to New session from every entry point; §2.7 menu + picker (without New project…); §2.6 delete;
  §2.4 rename; §2.10 filter; §2.11 copy.
- **v1 (should):** §2.8 drag onto a header; §2.2 hover + and the header-drag
  `project:reorder`; the picker's `+ New project…`; §2.5 Open board; the §5 subtitle upgrade.
- **Vision:** a project ticket-key pill (needs a model field); multi-select move; keyboard
  focusable cards with Shift+F10.
- **Out of scope:** the dialog UI, the model and persistence, "Can't start", board linkage,
  explorer pre-fill implementation, the Neon mock (it follows from tokens).

## 7. Acceptance criteria

### 7.1 EARS

1. While grouped, the rail shall render one header per project in `Project.order` (manual sort)
   or by name (other sorts), followed by Standalone last. Standalone is omitted when it's empty.
2. If a session's `projectId` is absent or unknown, then the rail shall render it under
   Standalone.
3. When the header + or "New session in project" is activated, the app shall open New session
   with `projectId` = that group's id (`null` for Standalone).
4. When Ctrl+N, the rail header +, the palette's New session or the center empty-state New
   session is activated, the app shall open New session with
   `projectForNewSession(active)`.
5. When a project is picked in Move to project…, the app shall post `session:setProject` with
   that id (`null` for Standalone), and the session shall keep its PTY (same terminal, no
   restart).
6. When a card is dropped on another group's header, the app shall post `session:setProject`
   with that group's id. When it's dropped on its own group's header, the app shall post
   nothing.
7. When Delete project is confirmed, the app shall post `project:delete {id}` and prune the id
   from `collapsedProjects`. The dialog shall show the pluralised §2.6 copy, and Enter with the
   default focus shall cancel.
8. When a rename commits a non-empty changed name, the app shall post `project:rename`. On
   Escape or an empty value it shall post nothing.
9. The filter shall match session name, project name, home and root basenames, and agent label.
10. While a card is not hovered or focused, its × and the header + shall be
    `pointer-events:none`.
11. While a session needs attention, its card shall show Go to and Snooze. While it's stale, it
    shall show ↻.
12. While there are no sessions and no projects, the rail shall read `No sessions yet` / `A
    session is one terminal working across one or more folders. Run four at once.` While there
    are no sessions but projects exist (grouped mode), it shall show the project headers with
    count 0 and no first-run copy.
13. The Settings "Session card" preview shall render the same structure as a rail card: pill,
    agent line, no busy meter.
14. When a move is confirmed (`session:opResult ok`) or a deleted project leaves
    `state.projects`, a polite live region shall announce `Moved <session> to <project |
    Standalone>` / `Deleted <project>`. On `ok:false` it shall announce `Couldn't move
    <session>`.
15. While more than one window is open, the delete dialog shall use the count-free copy.
16. When Shift+F10 is pressed with a header's chevron focused, the header menu shall open with
    its first item highlighted.

### 7.2 Gherkin (key flows)

```gherkin
Scenario: File a running session into a new project from the card menu
  Given a running standalone session "api fix"
  When I right-click its card and choose "Move to project…"
  And I choose "+ New project…", type "RMB pipeline" and press Enter
  Then a group "RMB pipeline" appears above "Standalone" containing "api fix"
  And the session's terminal still shows its earlier output

Scenario: Delete a project with two sessions
  Given project "RMB pipeline" with 2 sessions
  When I right-click its header and choose "Delete project…"
  Then the dialog reads "Its 2 sessions become standalone and keep running. Folders and their .conduit/ data aren't touched."
  When I click "Delete project"
  Then both sessions are listed under "Standalone" and are still running
```

### 7.3 Unit tests (`test/unit/`)

- `session-groups.test.ts`: order (manual vs name), Standalone last and omitted when empty, a
  dangling id goes to Standalone, empty projects included unfiltered and excluded filtered,
  in-group sort, and the needs-you float.
- The filter over all five fields, including a root basename and a project name.
- `cardDropIntent`: another group → id; Standalone → `null`; own group → `null` intent (no-op).
- `projectForNewSession`: active with a live project → id; active standalone, active with a
  dangling id, or no active → `null`.
- `deleteProjectMessage(name, count, windowCount)` for 0, 1 and 2 sessions in one window, and
  the count-free form when `windowCount > 1`. `openBoardTarget` (active in project /
  most-recent / none).
- Settings: a payload without `cardLayoutRev` and with `live` → `agent` + rev 2; a rev-2 payload
  with `live` stays `live`; the default is `agent`; `VERSION` is unchanged.
- The picker's name rule: trim, collapse whitespace, 1–80 characters.
- Update `sidebar-grouping`, `reorder`, `sort-filter-menu`, `card-fields`, `hover-overlays`,
  `state-vocabulary` and `overlay-sites` where they encode the old shape. The picker uses
  `.popover` and the header menu uses `.ctxmenu`, both already in `drag-region.test.ts`. A new
  overlay class outside those would need adding there.

### 7.4 E2E on the real app (`npm run test:smoke`, hidden window)

- **New `test/e2e/sidebar-projects.e2e.mjs`:** seed two projects plus a standalone session
  through the harness (`openRepo` with `projectId`), then assert:
  - header order and names;
  - header right-click → Rename… → type → Enter → the name survives a relaunch on the same
    userData;
  - header +: a **real mouse hover** (`page.mouse.move` over the header's rect) reveals the +,
    and clicking it opens New session with the chip naming that project;
  - Ctrl+N with a project session active → the same chip;
  - card menu → Move to project… → pick → the card changes group, and the terminal's earlier
    output is still in its buffer (the same PTY);
  - picker `+ New project…` → the new group appears;
  - Copy home path → the clipboard equals `home`;
  - Delete project… → the exact dialog copy → **press Enter first** → the dialog closes and the
    project still exists → reopen → click Delete project → the sessions sit under Standalone
    with `status:'running'`;
  - Open board on a project → that project's session becomes active and the center view is
    Board;
  - focus a header chevron → Shift+F10 → the header menu opens;
  - filter by a root folder name and by an agent label;
  - hover × → click → the session closes.
- **Update `context-menu-order.e2e.mjs`** for `Move to project…` and `Copy home path`.
  **Update `hover-obstruction.e2e.mjs`** so the × and the header + are untouchable at rest.
  **`sidebar-dnd.e2e.mjs`** collapse persistence now keys on the project id.
- **Drag onto a header (same scenario):** use terminal-drop's technique. Dispatch `dragstart`
  on the card, `dragover` and `drop` on the other group's header, then `dragend`, all sharing
  one `DataTransfer`. Assert the drop-into class during dragover, the regroup after `state`, and
  that no window move happened. Repeat onto the card's own header and assert no change.
  Synthesized events bypass real pointer hit-testing, so one real-mouse drag stays on the human
  smoke list.
- **Real-mouse-only risks (CLAUDE.md):** Playwright input bypasses Electron's app-region mask,
  so only `drag-region.test.ts` guards the picker and menus (both existing classes). The header
  + and card × must win the hit-test over the header and card. The e2e checks
  `document.elementFromPoint` at each button's centre after a real `page.mouse.move` hover; a
  human does one real click. `npm run shots` covers the card and grouped rail in all three
  themes.

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Rail | first-run (no sessions, no projects) | 12i copy, no filter row | header + |
| Rail | empty after action (no sessions, projects exist) | project headers, count 0 | header + , group + , header menu |
| Rail | filtered, no match | `No sessions match “q”.` | clear filter ✕ |
| Rail | populated grouped / flat | groups or one list | — |
| Group header | rest / hover or focus / collapsed / collapsed+attn / renaming / drop-into / drop-before | count / + in place of the count / › chevron / attn count / input / accent outline+fill / top bar | + , menu, drag |
| Group header | empty project | count `0` | + , menu |
| Card | busy / idle / review / needs-you / stale / (Can't start from mf-live-edits) | pill word + tint; needs-you adds Go to/Snooze; stale adds ↻ | click, ×, menu |
| Card | renaming | name input | Enter/Esc |
| Picker | list / filtered-empty (`No projects match` row, New project… still shown) / creating / awaiting reply (input disabled) | as described | pick, create, Esc |
| Delete dialog | open | title + copy + Cancel/Delete project | confirm/cancel |
| Loading / offline | n/a | The rail renders host state synchronously and there's no fetch. Errors are host rejections that leave state unchanged. | — |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Group header | collapse, new, rename, delete, open board, reorder, drop target | chevron click, + click, dbl-click name, drag | Tab to chevron/+; Enter/Space; Shift+F10/Menu opens the header menu | §2.2 | chevron `aria-expanded`; + `aria-label="New session in <name>"` |
| Card | select, close, rename, menu, drag, Go to/Snooze, relaunch | click, × , dbl-click, drag | × and row buttons focusable (focus-within reveals) | §2.7 | × `aria-label="Close session"`; the pill word is text |
| Picker | filter, pick, create | click row | type, ↑/↓, Enter, Esc | — | `listbox`/`option`, `aria-selected`, `aria-activedescendant` |
| Delete dialog | cancel, delete | buttons | Enter = Cancel by default; Esc cancels | — | ModalLayer dialog semantics |

Every drag has a non-drag path: header reorder has none today, so this adds none (§13 D11); card
to project uses the picker.

## 10. Accessibility & i18n

- Keyboard reaches everything except the card itself. Cards are non-focusable divs today, so the
  card menu, and with it Move to project…, has no keyboard path. That gap is existing and is not
  widened here (§13 D15). The picker and header menu are fully keyboard
  operable, and focus returns to the invoking chevron/+ (or the body for card menus) on close.
- No colour-only signal: every state has its pill word, the ✓ carries `aria-selected`, and the
  drop-into cue is an outline plus fill (shape as well as colour).
- A move or delete shows its result by the card relocating. One `aria-live="polite"` region in
  the sidebar announces it. Moves are posted with a `requestId`, and the announcement fires on the
  matching `session:opResult`. A delete is announced when the id leaves `state.projects` after
  a local `project:delete` post (AC 14).
- Reduced motion: no new animation beyond the existing opacity fades.
- i18n: all copy lives with the component the way the repo already does it (no i18n framework
  exists). Plurals go through `deleteProjectMessage`. The name sort uses `localeCompare`, and the
  filter is case-insensitive. Names tolerate 30%+ expansion via ellipsis + `title`. RTL is not
  supported by the app today and isn't added.

## 11. Design tokens

`--accent` (Busy pill, + button, ✓, New project…, drop-into), `--warn` (Review / Needs you
pills; existing card tints), `--bad` (× hover at 12%, Delete project, the menu's danger item),
`--text-faint` / `--muted` (agent line, Idle/Stale), `--r-badge`/`--r-ctl` radii, and
`--density-*` for card spacing. No hex. `color-mix()` for the tints, matching existing usage.
Neon follows from tokens; `--label-case` still applies to the pill.

## 12. Assumptions

- mf-model has landed `state.projects`, the renamed `home`, `roots`, and the L3 messages before
  this is built.
- The New session dialog accepts `projectId: string | null` as its initial chip value.
- `requestKill`'s confirm logic, the timer store and snooze are reused unchanged.
- The sidebar is not virtualized, so the keyed-direct-children rule is satisfied trivially.
  Group children stay keyed by `s.id`.

## 13. Decisions Needed

- **D1 [normal]** Keep the Needs-you `Go to` / `Snooze` row, although 9b's stripped card
  doesn't show it. Snooze is the only per-session silence, and the topbar chip only aggregates.
  *Pick: keep, needs-you state only.*
- **D2 [normal]** Drop the Review diffstat button. With multi-repo sessions, "N files changed"
  counts only the active repo, and Changes → Review (L8) is one click away after selecting the
  card. *Pick: remove; the Review pill stays.*
- **D3 [normal]** Drop the age label and the busy meter; the pill carries the state. Keep the
  timer chip and ↻, since they're session-owned actions or signals with no other surface on the
  rail. *Pick: as stated.*
- **D4 [normal]** Card-fields settings stay (Title/Subtitle/Detail) and aren't deleted. The
  subtitle default becomes `agent`, with a one-shot upgrade of a persisted `live` to `agent`
  (the "no activity line" intent). A user who chose Live deliberately has to re-pick it once.
  The mechanism is the `cardLayoutRev` marker (§5). `VERSION` is never bumped, because a bump
  would discard every setting (`parse` returns `{}` on a mismatch). *Pick: upgrade once.*
- **D5 [normal]** The handoff shows a status dot. Today's card deliberately shows the session
  glyph instead (`session-dot.ts` note), and `Set icon…` stays in the menu. *Pick: keep the
  glyph; no second state dot.*
- **D6 [normal]** Open board = select the project's active or most-recent session in this window
  and switch to Board; disabled with no session here. Two sessions with different homes in one
  project read different boards (handoff open question). *Pick: as stated.*
- **D7 [normal]** The picker chains create → setProject on `project:created {requestId, id}`.
  The mf-model spec already pins this shape, so a name match is never used (names can repeat,
  D9). *Pick: consume mf-model's reply; no fallback.*
- **D8 [normal]** No ticket-key pill on the header; `Project` has no such field (L2). *Pick:
  omit.*
- **D9 [normal]** Duplicate project names are allowed, since everything keys on id. *Pick:
  allow.*
- **D10 [normal]** Empty projects show as headers (count 0) when grouped and unfiltered, in every
  window (projects are global), including a window with no sessions. The 12i first-run copy
  shows only when there are no sessions **and** no projects, or when ungrouped. Otherwise a
  project would be unreachable for rename or delete. *Pick: as stated.*
- **D11 [normal]** Header drag now posts `project:reorder` (`Project.order`) instead of
  rewriting session order. Projects have no keyboard reorder, the same as today's groups.
  *Pick: as stated; keyboard reorder deferred.*
- **D12 [normal]** The card→header drop is e2e-proved with synthesized DragEvents sharing one
  `DataTransfer` (`terminal-drop.e2e.mjs` shows this works, and mouse `dragTo` doesn't). A real
  mouse drag stays a human-smoke item because synthesis skips hit-testing. *Pick: as stated.*
- **D13 [normal]** `state.sessions` is per-window, so a delete dialog in window A can't count
  window B's sessions. *Pick: the exact pluralised count with one window open, and the count-free
  copy with several. A host-supplied global count would be a nice-to-have from mf-model, not a
  requirement.* This is a visible deviation from the 12e copy in multi-window use, and it's
  cheap to reverse once a global count exists.
- **D14 [normal]** Picker placement: a Popover anchored beside the menu row (12e), not a modal
  like `IconPickerModal`. *Pick: popover.*
- **D15 [normal]** Cards stay non-focusable, so Move to project… has no keyboard path (the card
  menu never had one). The non-drag path WCAG 2.5.7 asks for is the picker. *Pick: don't make
  cards focusable in this item; it's a rail-wide a11y change for its own item.*

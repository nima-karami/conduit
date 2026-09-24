# mf-sidebar — implementation plan

**Spec:** `docs/specs/2026-09-23-mf-sidebar.md`  **Tier:** FULL

Tier reason: four renderer modules plus two new components, a new pure module shared with the
host tsconfig, a settings migration, two shared-primitive extensions (`ContextMenu`, `Popover`),
and four e2e scenarios; parallel executors intended.

## Goal

The sessions rail groups by `Session.projectId` (Standalone last), the card becomes the 9b card,
and projects are created, renamed, reordered, deleted and assigned from the rail — every change
posted to the host and rendered only from the host's next `state`.

## Architecture

Every decision the rail makes is a pure function in one new renderer-safe module,
`src/session-groups.ts` (grouping, sort, filter, drop intent, delete copy, Open-board target,
picker rows), so the React code only renders and posts. The group header becomes its own
component (`project-group-header.tsx`) and the Move-to-project picker another
(`project-picker.tsx`, mounted by `app.tsx`, which owns the card menu). Announcements for AC 14 go
through one small renderer module (`webview/project-announcer.ts`) that both the sidebar and the
picker post through. Two shared primitives gain one optional member each: a `MenuItem.onClick`
activation carrying the row's rect (picker anchoring) and `Popover.onEscape` (the picker's
Escape-returns-to-list, which the capture-phase overlay stack otherwise swallows).

## Data flow

```
host state {sessions (this window), projects}                         host replies
      │                                                              ▲   │ session:opResult
      ▼                                                              │   │ project:created / opResult
app.tsx ── sessions, projects, windowCount ──► Sidebar               │   ▼
                                                 │ groupSessions / sessionMatchesFilter (pure)
                                                 ├─► ProjectGroupHeader ×N ── + ──► onNewInProject(id|null) ─► app setNewSession({projectId})
                                                 │      │ menu/rename/delete/open board/reorder
                                                 │      └─► post project:rename | project:reorder | project:delete
                                                 │          (delete via app ConfirmDialog; announcer.noteDelete)
                                                 ├─► SessionCard ×N (drag) ── drop on other header ─► cardDropIntent ─► announcer.moveSession
                                                 └─► live region ◄── announcer snapshot
app.tsx card menu ── "Move to project…" (row rect) ─► ProjectPicker (Popover)
                                                        ├ pick ──────────────► announcer.moveSession ─► post session:setProject{requestId}
                                                        └ + New project… ───► post project:create{requestId} ─► on project:created ─► moveSession
announcer ◄── bridge subscribe(session:opResult) ; observeProjects(state.projects) for deletes
```

## Settled decisions — do not re-litigate

- `.autoloop/locked.md` L1–L12 are the frame; spec §13 D1–D15 picks stand.
- L10 + L12 S11: grouping key = `projectId` (dangling → Standalone); `collapsedProjects` holds ids
  or `'standalone'`; **the paths → ids coerce is this item's** (not mf-model's).
- Tokens are `--accent`, `--amber`, `--danger`, `--success`, `--on-accent`, `--accent-soft`
  (L12 process rules; the spec's `--warn`/`--bad` don't exist).
- Every project/session mutation is host-owned and non-optimistic: the rail renders `state`.
- The New session dialog is mf-new-session's. This item only decides the `projectId` the dialog
  opens with, and only for the group header + and the header menu's "New session in project".
  Every other entry point keeps passing no `projectId`, because mf-new-session's `seedNewSession`
  derives `projectForNewSession(active, projects)` when it is `undefined` (mf-new-session spec
  §3.1, D18).
- `VERSION` in `src/settings.ts` is never bumped (a bump discards every setting).
- Header drag posts `project:reorder`; `reorderByGroup` is retired. The card keeps
  `SessionGlyph` (D5), Go to/Snooze (D1), the timer chip and ↻; loses the age, meter and diffstat
  (D2, D3).

## Spec staleness

- §11 names `--warn` / `--bad`: absent from `webview/styles.css`; the plan uses `--amber` /
  `--danger` (as `.session--attention .session__state` already does, `webview/styles.css:1921`).
- §3 / §4 "mf-model's coerce drops old paths": superseded by L12 S11 and mf-model plan
  "S11 … owned by mf-sidebar"; built here (T1.2).
- §2.9 table and §3 "`newSession` state gains `projectId?`": mf-new-session owns the
  `NewSessionPrefill` shape and derives the project when it is `undefined` (mf-new-session spec
  §3.1). So the rail header +, Ctrl+N (`webview/shortcuts.ts:71` → `app.tsx` `newSession:
  () => openNewSession()`), the palette (`cmd:new`), the center empty state (`onNewSession`) and
  the pane menu stay as they are; the e2e proves the chip anyway (T3.6).
- §3 helper signatures: `cardDropIntent(session, targetGroupKey)` needs the project list to know
  a dangling id's group, so it becomes `cardDropIntent(sourceKey, targetKey)` over group keys;
  `deleteProjectMessage(name, count)` becomes `deleteProjectDialog(name, count, windowCount)`
  returning title and message. `projectForNewSession` is not built here (above).
- §7.4 "seed through the harness (`openRepo` with `projectId`)": the harness helper is
  `openSession(page, {path, agentId})` (`test/e2e/harness.mjs:202`), with `roots` added by
  mf-changes; `projectId` and a `createProject` helper are added here (T1.3).
- §2.3 "Busy accent-tinted, Review / Needs you warn-tinted": already true
  (`webview/styles.css:1917-1925`); only size, padding, radius and the Idle/Stale fill change.
- §2.7 "Escape returns to the list": the overlay stack binds `keydown` on `window` in the capture
  phase (`webview/overlay-store.ts:44`), so no input handler can intercept Escape first. The plan
  adds `Popover.onEscape` (T4.1).
- §2.7 "`at` = the menu's right edge, level with that row": `MenuItem.onClick` is `() => void`
  (`webview/components/context-menu.tsx:13`), with no row geometry. The plan adds an optional
  activation argument (T4.1).
- §7.3 "update `sort-filter-menu`, `card-fields`": measured, neither encodes the folder grouping
  (`webview/sort-filter-menu.ts:12-19` labels only; `card-fields.ts` is mf-model's rename). No
  change from this item.
- mf-model plan "Sidebar keeps grouping by `home` (D1)": at build time the rail groups by
  `s.home`, not `projectPath`. This item replaces that.
- §12 "the sidebar is not virtualized": true (`webview/components/sidebar.tsx`, plain `.map`).

## Global constraints

- Gate: `npm run verify`. Never disable, narrow or skip a check.
- **Load on this machine:** e2e runs one scenario at a time after `npm run build`
  (`node test/e2e/run-smoke.mjs <name>`). Re-run any PTY-echo failure alone on a quiet machine
  before believing it. Never kill processes by name.
- `npm run typecheck` runs both tsconfigs. `src/session-groups.ts` and `src/project-name.ts` are
  renderer-safe AND host-safe: no `node:*`, no DOM, no `webview/` import.
- Unit tests never depend on `process.platform` or platform `path`; paths are strings with
  explicit separators, and base names are computed by splitting on both `/` and `\`.
- Every new export is used by the end of the slice that creates it (fallow treats
  `test/unit/*.test.ts` as entries, so a tested pure helper counts). Never export something
  whose only use is a later slice.
- Naming: kebab-case files; components PascalCase; tests `test/unit/<module>.test.ts`; jsdom
  component tests start with `// @vitest-environment jsdom` and use `createRoot` + `act` as
  `test/unit/middle-click-menus.test.ts` does; static markup tests use `renderToStaticMarkup`
  (as `test/unit/icons.test.ts`). e2e files are `test/e2e/<name>.e2e.mjs` on
  `test/e2e/harness.mjs`, hidden, Windows-only skip.
- Comments: WHY only; point at the spec section (`// see mf-sidebar spec §2.8`) instead of
  restating it.
- Overlays: `ContextMenu` / `Popover` / `ModalLayer` (via `ConfirmDialog`) only. No new overlay
  class outside `.popover` / `.ctxmenu` (both already `no-drag` in `drag-region.test.ts`).
- Hover-revealed controls: `opacity: 0; pointer-events: none` at rest, `pointer-events: auto`
  on reveal (`test/unit/hover-overlays.test.ts` pairs them automatically).
- Group children keyed `s.id`; group wrappers keyed by group key; never `[row, extra]` arrays.
- No hex in CSS; `color-mix()` over tokens.
- Line numbers below are for the current tree (pre-mf-model). mf-model, mf-changes and
  mf-new-session land first and shift them. Locate by symbol, never by number.

## Out of scope

The New session dialog and `seedNewSession` (mf-new-session); the model, persistence and host
validation (mf-model); "Can't start" (mf-live-edits); board linkage (mf-board); explorer pre-fill
(mf-files); ticket-key pill (D8); multi-select; keyboard-focusable cards (D15); host-supplied
global session count (D13); fake-shell (`webview/bridge.ts`) handling of `project:*` messages
(preview shows `webview/mock.ts` state only).

## Contracts

### Consumed from mf-model (by name; built before this item)

- `src/types.ts`: `interface Project { id: string; name: string; order: number }`;
  `Session.home: string`, `Session.roots: string[]`, `Session.projectId?: string`.
- `src/protocol.ts`, `state`: `projects: Project[]` (already sorted by `order`, from
  `ProjectStore.list()`).
- Renderer → host: `{ type: 'session:setProject'; sessionId: string; projectId: string | null;
  requestId?: number }`, `{ type: 'project:create'; name: string; requestId: number }`,
  `{ type: 'project:rename'; id: string; name: string }`, `{ type: 'project:delete'; id: string }`,
  `{ type: 'project:reorder'; ids: string[] }`.
- Host → renderer: `{ type: 'session:opResult'; requestId: number; ok: boolean; reason?:
  SessionOpReason }`, `{ type: 'project:created'; requestId: number; id: string }`,
  `{ type: 'project:opResult'; requestId: number; ok: false; reason: 'invalid-name' |
  'store-unavailable' }`.
- `src/project-store.ts`: module-private `normalizeProjectName(raw)` (trim, collapse whitespace
  runs, 1..80 chars else null). T3.1 moves it to `src/project-name.ts` and imports it back.
- Harness: `openSession(page, { path, agentId = 'shell:cmd', roots })` (mf-changes).

### Consumed from mf-new-session (built before this item)

- `webview/app.tsx` `setNewSession(prefill: NewSessionPrefill | null)` (`NewSessionPrefill` from
  `src/new-session-seed.ts`), so `setNewSession({ projectId })` opens the dialog on that project;
  `seedNewSession` derives `projectForNewSession(active, projects)` when `projectId` is undefined.
- The dialog chip `button.ns-chip__body[aria-label="Project: <name>"]` (its plan, modal markup).
- `webview/host-request.ts` `requestHost` (below).

### `src/session-groups.ts` (new; renderer- and host-safe)

```ts
import type { SessionSort } from './settings';
import type { Project, Session } from './types';

/** Group key of the standalone group; project ids are never this string (mf-model mints `p-…`). */
export const STANDALONE_KEY = 'standalone';

export interface SessionGroup {
  key: string;                 // project id or STANDALONE_KEY
  project: Project | null;     // null for Standalone
  sessions: Session[];         // in display order
}

/** The group a session renders in: its projectId when that names a project in `projects`, else STANDALONE_KEY. */
export function groupKeyOf(s: Pick<Session, 'projectId'>, projects: readonly Project[]): string;

/** Sort only. manual → input order; name/recent/active/status as today (sidebar.tsx:32-61);
 *  project → project name (localeCompare, sensitivity 'base'), standalone after every project, then session name. */
export function sortSessions(list: readonly Session[], sort: SessionSort, projects: readonly Project[]): Session[];

/** sortSessions + needs-you float to the top (non-manual sorts only, stable). */
export function orderSessions(list: readonly Session[], sort: SessionSort, projects: readonly Project[]): Session[];

/** Grouped rail. One group per project (manual → Project.order; else name, localeCompare base),
 *  including empty projects unless `filterActive`; then Standalone, omitted when empty.
 *  Each group's sessions = orderSessions of its members. */
export function groupSessions(
  sessions: readonly Session[],
  projects: readonly Project[],
  opts: { sort: SessionSort; filterActive: boolean },
): SessionGroup[];

/** q is the raw filter text; trimmed + lower-cased here. '' matches everything.
 *  Fields: name, projectName, basename(home), basename(each root), agentLabel. */
export function sessionMatchesFilter(
  s: Pick<Session, 'name' | 'home' | 'roots'>,
  q: string,
  ctx: { projectName: string | undefined; agentLabel: string },
): boolean;

/** Full project id order after dropping header `dragId` before `targetId` in the rendered order.
 *  null when either id is absent from `renderedIds`, drag === target, or the result equals `currentIds`. */
export function projectOrderAfterDrop(
  renderedIds: readonly string[],
  dragId: string,
  targetId: string,
  currentIds: readonly string[],
): string[] | null;

// Slice 3
export function deleteProjectDialog(name: string, count: number, windowCount: number): { title: string; message: string };
/** The session Open board selects: activeId if it is in the project, else the project's session
 *  with the highest lastActiveAt (ties: first in `sessions`); undefined when none. */
export function openBoardTarget(projectId: string, sessions: readonly Session[], activeId: string | undefined): string | undefined;

// Slice 4
/** null = no-op (same group). Standalone target → projectId null. */
export function cardDropIntent(sourceKey: string, targetKey: string): { projectId: string | null } | null;
export interface PickerRow { key: string; label: string; current: boolean }   // key = project id | STANDALONE_KEY
/** Projects in `projects` order whose name contains the trimmed filter (case-insensitive), then
 *  the Standalone row (always). noMatch = a non-empty filter matched no project. */
export function projectPickerRows(projects: readonly Project[], filter: string, currentKey: string): { rows: PickerRow[]; noMatch: boolean };
```

`deleteProjectDialog` exact copy: title `Delete “<name>”?`; message, with the suffix
`Folders and their .conduit/ data aren't touched.`:
- `windowCount > 1` → `Its sessions become standalone and keep running. ` + suffix
- `count >= 2` → `Its <count> sessions become standalone and keep running. ` + suffix
- `count === 1` → `Its 1 session becomes standalone and keeps running. ` + suffix
- `count === 0` → `It has no sessions. ` + suffix

### `src/project-name.ts` (new; renderer- and host-safe)

```ts
/** Trim, collapse whitespace runs to one space; 1..80 chars → the name, else null. The one naming rule (mf-model §project names). */
export function normalizeProjectName(raw: unknown): string | null;
/** Rename commit: normalizeProjectName(draft) when non-null and !== current, else null (no post). */
export function renamedProjectName(draft: string, current: string): string | null;
```

### `src/settings.ts`

```ts
interface AppSettings { /* … */ cardLayoutRev: number; }
DEFAULT_SETTINGS.cardSubtitle = 'agent';
DEFAULT_SETTINGS.cardLayoutRev = 2;
```
`coerceSettings`: `collapsedProjects = strArr(payload.collapsedProjects).filter((k) => !/[\\/]/.test(k))`
(project ids and `'standalone'` never contain a separator; every old entry is an absolute path);
`cardSubtitle` = the coerced value, except `'agent'` when `payload.cardLayoutRev` is not a number
≥ 2 **and** the coerced value is `'live'`; `cardLayoutRev: 2` always.

### `src/reorder.ts`

```ts
export function sortedCanonical(ids: string[], sort: SessionSort, sessionsById: Map<string, Session>, projects: readonly Project[]): string[];
  // = sortSessions(resolved sessions, sort, projects).map(id) — the duplicated comparator is deleted
export function reorderPersists(candidate: string[], current: string[], sort: SessionSort, sessionsById: Map<string, Session>, projects: readonly Project[]): boolean;
// deleted: reorderByGroup
```
Unchanged: `toggleCollapsed`, `dropResolvesToManual`, `moveBefore`.

### `webview/components/context-menu.tsx`

```ts
import type { Rect } from '../../src/menu-position';
export interface MenuActivation { rect: Rect }       // the activated row's getBoundingClientRect()
export interface MenuItem { /* … */ onClick: (activation?: MenuActivation) => void; }
```
Both call sites pass it: click → `e.currentTarget.getBoundingClientRect()`; keyboard Enter →
`document.getElementById(\`${baseId}-item-${i}\`)?.getBoundingClientRect()` (omitted if absent).
Optional because programmatic callers (tests: `arch-node-menu`, `explorer-menu`) invoke
`onClick()` bare.

### `webview/components/popover.tsx`

```ts
export interface PopoverProps { /* … */ onEscape?: () => void; }  // Escape from the overlay stack; default onClose
```
`useOverlayEntry('popover', onEscape ?? onClose)`. Outside-mousedown / scroll / blur / resize still
call `onClose`.

### Consumed from mf-new-session: `webview/host-request.ts`

```ts
/** Posts send(id) with a fresh id and resolves the first reply of one of `types` carrying that
 *  requestId, or null after timeoutMs. Unsubscribes either way. */
export function requestHost<T extends HostToWebview['type']>(
  send: (requestId: number) => WebviewToHost,
  types: readonly T[],
  timeoutMs: number,
): Promise<Extract<HostToWebview, { type: T }> | null>;
```
The one renderer-wide request/reply seam (mf-new-session plan §Contracts). This item adds no
allocator of its own.

### `webview/project-announcer.ts` (new)

```ts
export const projectAnnouncer: {
  // Slice 3
  noteDelete(projectId: string, name: string): void;          // pending until the id leaves state.projects
  observeProjects(projects: readonly Project[]): void;        // announces `Deleted <name>` for pending ids now absent
  subscribe(cb: () => void): () => void;                       // useSyncExternalStore pair
  getSnapshot(): string;                                       // the current announcement ('' initially)
  // Slice 4
  moveSession(sessionId: string, projectId: string | null, text: { session: string; target: string }): void;
    // requestHost((requestId) => ({type:'session:setProject', sessionId, projectId, requestId}),
    //   ['session:opResult'], 10_000): ok → `Moved <session> to <target>`; !ok → `Couldn't move
    //   <session>`; null (timeout) → no announcement
};
```
Each new announcement replaces the snapshot (same text twice: append a zero-width
space so the live region re-announces).

### `webview/components/project-group-header.tsx` (new)

```ts
export type HeaderDropCue = 'before' | 'into' | null;
export interface HeaderDragHandlers {
  onDragStart?: (e: React.DragEvent) => void;   // absent → header not draggable (Standalone, filter active, ungrouped)
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}
export function ProjectGroupHeader(props: {
  groupKey: string;
  name: string;                 // project name, or 'Standalone'
  labelId: string;              // id put on .proj__name (the group's aria-labelledby)
  count: number;
  collapsed: boolean;
  attn: boolean;                // hidden busy/needs-you → .proj__count--attn
  renaming: boolean;
  dropCue: HeaderDropCue;
  drag: HeaderDragHandlers | undefined;
  onToggle: () => void;
  onNew: () => void;
  /** Right-click → {x,y}; Shift+F10 / ContextMenu key on the chevron or + → {anchor: header rect, keyboard: true} */
  onMenu: (at: { x: number; y: number } | { anchor: Rect; keyboard: true }, returnFocus: HTMLElement | null) => void;
  onStartRename: () => void;    // dbl-click on the name; project groups only (caller passes a no-op for Standalone)
  onRenameEnd: (draft: string | null) => void;   // Enter/blur → the input's value; Escape → null
}): JSX.Element;
```
DOM: `.proj__label` (+ `--dropbefore` / `--dropinto`, `draggable` iff `drag?.onDragStart`, `title`
= name, `onContextMenu` → `preventDefault()` + `onMenu({x, y}, null)`), `button.proj__chevron`
(`aria-expanded`, `aria-label` `Expand|Collapse <name>`), `span.proj__name#labelId` or, while
renaming, `input.proj__rename` (autoFocus, value selected on mount, `onDragStart`
stopPropagation, clicks stopPropagation), `span.proj__slot` holding `span.proj__count` and
`button.proj__add` (`aria-label` `New session in <name>` or `New standalone session`, same
`title`, `onDragStart` stopPropagation, `onClick` stopPropagation + `onNew()`).

### `webview/components/project-picker.tsx` (new, Slice 4)

```ts
export function ProjectPicker(props: {
  session: Session | undefined;    // undefined (closed / moved windows) → calls onClose on the next effect, posts nothing
  projects: Project[];
  at: { x: number; y: number };
  onClose: () => void;
}): JSX.Element | null;
```
`Popover` with `at`, `className="ctxmenu projpicker"`, `style={{ width: 200 }}`, `role="listbox"`,
`aria-activedescendant`, `onEscape` = creating ? back-to-list : `onClose`. Rows from
`projectPickerRows`; current row `aria-selected` + trailing `IconCheck`; highlight index moves
with ArrowUp/Down over [rows…, New project], Enter picks. Pick current → `onClose()`; pick other →
`projectAnnouncer.moveSession(session.id, key === STANDALONE_KEY ? null : key, {session:
session.name, target: label})` then `onClose()`. Creating: input `.projpicker__name` prefilled
with the filter; Enter → `normalizeProjectName(value)`; null → hint `1–80 characters`, nothing
sent; else disable the input and await `requestHost((requestId) => ({type:'project:create', name,
requestId}), ['project:created', 'project:opResult'], 5000)`. A resolution after the picker
unmounted is ignored (a cancelled flag set in the effect cleanup). `project:created` →
`moveSession(session.id, reply.id, {session: session.name, target: name})`, `onClose()`;
`project:opResult` → re-enable, hint `1–80 characters` for `invalid-name`, `Couldn't create
project` for `store-unavailable`; `null` (5 s, no reply) → re-enable, nothing chained.

### Sidebar props (`webview/components/sidebar.tsx`)

Added: `projects: Project[]`, `windowCount: number`, `onNewInProject: (projectId: string | null)
=> void`, `onOpenBoard: (sessionId: string) => void`, `onConfirm: (c: ConfirmState) => void`.
Removed: `onOpenReview`. `SessionCard` loses `onOpenReview`.

### `webview/components/session-card.tsx`

```ts
/** The Settings "Session card" preview: a real SessionCard over a fixed sample session (AC 13). */
export function SessionCardPreview({ roles }: { roles: CardRoles }): JSX.Element;
```
Sample: `{ id: 'preview', name: 'Portfolio Redesign', agentId: 'preview', home:
'G:/awby/projects/nextjs-portfolio', roots: [], status: 'running', createdAt: now − 4 min,
lastActiveAt: now − 2 min, lastLine: 'Edit webview/styles.css', worktree: 'feature/auth' }`,
`agentLabel` `'PowerShell 7'`, `resolvedIcon` from `resolveSessionIcon(sample, [])`, `active`,
no-op callbacks, no `drag`; wrapped in `<div className="cardcfg__card" inert>`.

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Rail grouping key (`home` → `projectId`) | `groupSessions` | sidebar render, collapse, header drop | both |
| `collapsedProjects` values (paths → ids) | sidebar toggle + delete prune; `coerceSettings` | sidebar only (`grep collapsedProjects webview src`: `sidebar.tsx`, `settings.ts`) | both |
| `cardSubtitle` default + one-shot upgrade | `coerceSettings` | `SessionCard`, `SessionCardPreview`, Settings selects | both |
| `cardLayoutRev` | `coerceSettings` | nothing reads it but the coerce | both (self-contained) |
| `session:setProject` posts | announcer (picker, header drop) | host `SessionOps.setProject` (mf-model) | producer; host locked by mf-model |
| `project:create/rename/delete/reorder` posts | picker, sidebar | host `ProjectStore` handlers (mf-model) | producer; host locked |
| `session:opResult`, `project:created`, `project:opResult` | host (mf-model) | announcer, picker | consumer; mf-new-session's dialog also creates projects — both go through its `requestHost`, so request ids never collide |
| `newSession.projectId` | group +, header menu | mf-new-session `seedNewSession` | producer; consumer pinned in its spec §3.1 |
| `MenuItem.onClick(activation?)` | `ContextMenu` | every `MenuItem` (existing ones ignore the arg) | both; existing handlers unaffected (extra arg ignored, measured all `onClick:` sites are `() => …`) |
| `Popover.onEscape` | picker | `useOverlayEntry` | both; every other Popover omits it → `onClose`, today's behaviour |
| `sortedCanonical` / `reorderPersists` gain `projects` | `src/reorder.ts` | `sidebar.tsx` `commitReorder`; `test/unit/sidebar-grouping.test.ts` | both |
| `reorderByGroup` deleted | — | `sidebar.tsx:292` (replaced), `test/unit/reorder.test.ts`, `test/unit/sidebar-grouping.test.ts` | both |
| Card: age / meter / diffstat removed; `onOpenReview` gone | `session-card.tsx` | `sidebar.tsx` prop, `app.tsx` `openReviewForSession` (only caller `app.tsx:3378`), `relative-time.ts` `shortAge` (only caller `session-card.tsx:93`), CSS `.session__age/.session__meter*/.session__diffstat` (no test or e2e references — grepped `test/`) | all deleted together (T2.1) |
| Card × restyle | `.session__kill` CSS | `hover-overlays.test.ts` (keeps `.session__kill` in its vacuity list), `hover-obstruction.e2e.mjs` (selector unchanged), `state-vocabulary.test.ts` (new hover fill → allowlist entry) | both |
| Header + reveal | `.proj__add` CSS | `hover-overlays.test.ts` (auto-paired; vacuity list gains `.proj__add`), `hover-obstruction.e2e.mjs` | both |
| Card menu labels (`Copy path` → `Copy home path`, + `Move to project…`) | `app.tsx` `onSessionContextMenu` | `context-menu-order.e2e.mjs` | both |
| Settings preview markup | `SessionCardPreview` | `settings-modal.tsx` `SessionCardSection` (the `SAMPLE` map's only readers are `settings-modal.tsx:613-615`) | both; `SAMPLE` deleted |

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/session-groups.ts` | create | rail arrangement: keys, sort, grouping, filter, reorder/drop intent, delete copy, Open-board target, picker rows |
| `src/project-name.ts` | create | the one project-name rule + rename commit |
| `src/project-store.ts` | modify | import `normalizeProjectName` (private copy deleted) |
| `src/reorder.ts` | modify | canonical order reuses `sortSessions`; `reorderByGroup` deleted |
| `src/settings.ts` | modify | `collapsedProjects` coerce, `cardSubtitle` default + upgrade, `cardLayoutRev` |
| `webview/components/sidebar.tsx` | modify | grouped render, header wiring, menus, rename, delete, open board, drops, live region |
| `webview/components/project-group-header.tsx` | create | one group header |
| `webview/components/project-picker.tsx` | create | Move-to-project picker |
| `webview/components/session-card.tsx` | modify | 9b card, `SessionCardPreview` |
| `webview/components/settings-modal.tsx` | modify | preview → `SessionCardPreview`; `SAMPLE` deleted |
| `webview/components/context-menu.tsx` | modify | `MenuActivation` |
| `webview/components/popover.tsx` | modify | `onEscape` |
| `webview/project-announcer.ts` | create | AC 14 announcements |
| `webview/relative-time.ts` | modify | delete `shortAge` |
| `webview/app.tsx` | modify | Sidebar props, card menu, picker mount, `openReviewForSession` deleted |
| `webview/styles.css` | modify | header slot/+/rename/drop-into, pill, ×, picker; removed card rules |
| `webview/mock.ts` | modify | two mock projects; mock sessions get `projectId` |
| `test/unit/session-groups.test.ts` | create | pure helpers |
| `test/unit/project-name.test.ts` | create | name rule, rename commit |
| `test/unit/project-group-header.test.ts` | create | jsdom: +, menu keys, rename |
| `test/unit/project-picker.test.ts` | create | jsdom: rows, keys, create flow, lifecycle |
| `test/unit/project-announcer.test.ts` | create | announcements (bridge mocked) |
| `test/unit/session-card.test.ts` | create | card markup, preview |
| `test/unit/context-menu-activation.test.ts` | create | jsdom: rect passed on click and Enter; Popover onEscape |
| `test/unit/coerce-settings.test.ts` | modify | coerce + upgrade cases |
| `test/unit/sidebar-grouping.test.ts`, `test/unit/reorder.test.ts` | modify | new signatures; `reorderByGroup` tests deleted with it |
| `test/unit/state-vocabulary.test.ts` | modify | allowlist `.session__kill:hover, .session__kill:focus-visible` |
| `test/unit/hover-overlays.test.ts` | modify | vacuity list gains `.proj__add` |
| `test/unit/overlay-sites.test.ts` | modify | `ALL_FILES` gains `'project-picker'` |
| `test/e2e/harness.mjs` | modify | `__projects` tap, `openSession({projectId})`, `createProject` |
| `test/e2e/sidebar-projects.e2e.mjs` | create | the §7.4 scenario |
| `test/e2e/sidebar-dnd.e2e.mjs` | modify | collapse keyed on the group key; header note corrected |
| `test/e2e/hover-obstruction.e2e.mjs` | modify | header + at rest / revealed |
| `test/e2e/context-menu-order.e2e.mjs` | modify | card menu labels; header menu exact order |
| `test/e2e/visual/shoot.mjs` | modify | one project + a filed session so shots show the grouped rail |
| `CHANGELOG.md` | modify | Unreleased entry |

## Scripts

None. No edit repeats across files; the e2e drag dispatch is one local function in
`sidebar-projects.e2e.mjs`. `SCRIPT_CANDIDATES: 0` is deliberate.

## Slices

### Slice 1: Rail grouped by project

**Check:** `npx vitest run test/unit/session-groups.test.ts test/unit/coerce-settings.test.ts test/unit/reorder.test.ts test/unit/sidebar-grouping.test.ts`; `npm run typecheck`; after `npm run build`, `node test/e2e/run-smoke.mjs sidebar-dnd`.

**Parallel groups:** G1: T1.1 · G2: T1.2 · G3: T1.3 · Serial: T1.4
**Claims (serial lane):** `webview/components/sidebar.tsx`, `webview/app.tsx`, `webview/mock.ts`, `src/reorder.ts`

#### Task 1.1: Grouping helpers

**Files:**
- Create: `src/session-groups.ts` (`STANDALONE_KEY`, `SessionGroup`, `groupKeyOf`, `sortSessions`, `orderSessions`, `groupSessions`, `sessionMatchesFilter`, `projectOrderAfterDrop`)
- Test: `test/unit/session-groups.test.ts`

**Interfaces:**
- Produces: the Slice-1 signatures in Contracts §`src/session-groups.ts`.
- Consumes: `Project`, `Session` (`src/types.ts`), `SessionSort` (`src/settings.ts`).

**Steps:**
- [ ] Failing tests: `'manual sort orders projects by Project.order'`; `'name sort orders projects by name, case-insensitive'` (`['beta','Alpha']` → `Alpha, beta`); `'Standalone is last and omitted when empty'`; `'a dangling projectId renders under Standalone'`; `'empty projects included unfiltered, excluded when filterActive'`; `'in-group sessions follow the sort; needs-you floats in non-manual sorts only'`; `'project sort: by project name, standalone last, then session name'`; `'filter matches name, project name, home basename, a root basename (C:\\x\\ref and /y/ref), agent label; trims and lower-cases; empty q matches'`; `'filter: a standalone session never matches on project name'`; `'projectOrderAfterDrop moves before target; null for same id, unknown id, or unchanged order'`.
- [ ] Run `npx vitest run test/unit/session-groups.test.ts` — expect FAIL (module missing).
- [ ] Implement. Base names split on `/[\\/]/` and drop empties, as `sidebar.tsx:27` does.

#### Task 1.2: Settings coerce

**Files:**
- Modify: `src/settings.ts` (`AppSettings`, `DEFAULT_SETTINGS`, `coerceSettings`)
- Test: `test/unit/coerce-settings.test.ts`

**Interfaces:**
- Produces: `AppSettings.cardLayoutRev: number`; the coerce rules in Contracts §`src/settings.ts`.

**Steps:**
- [ ] Failing tests: `'collapsedProjects drops path entries, keeps ids and standalone'` (`['G:/a','C:\\b','p-1a2b','standalone']` → `['p-1a2b','standalone']`); `'no cardLayoutRev + live → agent, rev 2'`; `'rev 2 + live stays live'`; `'rev 1 + status stays status'`; `'default cardSubtitle is agent, cardLayoutRev 2'`; `'serializeSettings keeps version 1'`.
- [ ] Run `npx vitest run test/unit/coerce-settings.test.ts` — expect FAIL.
- [ ] Implement; replace the `cardSubtitle` default's comment (`settings.ts:186-187`) with a pointer to spec §5 D4.

#### Task 1.3: Harness + sidebar-dnd

**Files:**
- Modify: `test/e2e/harness.mjs` (`tapBridge`: also `window.__projects = m.projects || []` on `state`; `openSession(page, { path, agentId, roots, projectId })` posts `projectId` when it is not `undefined`; new `export async function createProject(page, name)`: snapshot `__projects` ids, post `{type:'project:create', name, requestId: Date.now()}`, wait ≤ 10 s for a new entry with that name, return its id)
- Modify: `test/e2e/sidebar-dnd.e2e.mjs`

**Steps:**
- [ ] sidebar-dnd: after the session opens, `createProject(page, 'dnd-proj')` and `session:setProject` it into that project; wait for `.proj__name` `dnd-proj`. Collapse via that header's chevron. Before shutdown, read `<userDataDir>/settings.json` and assert `settings.collapsedProjects` deep-equals `[<projectId>]`. After relaunch, keep today's assertions (cards hidden, count shown) against that header. Replace the header note's DragEvent claim with a pointer to `sidebar-projects.e2e.mjs`, which proves card→header drops with a shared `DataTransfer`; Scenarios 1–2 stay NEEDS-HUMAN-SMOKE only for a real mouse drag.
- [ ] Carve-out (e2e authoring): proof is the slice check.

#### Task 1.4: Sidebar renders groups by project

**Files:**
- Modify: `src/reorder.ts` (Contracts §`src/reorder.ts`; delete `reorderByGroup` and the local `baseName`/`STATUS_RANK` it no longer needs)
- Modify: `test/unit/reorder.test.ts` (delete the `reorderByGroup` describe), `test/unit/sidebar-grouping.test.ts` (pass `projects`; the `'project'` cases use project names; delete the `reorderByGroup` group-commit describe)
- Modify: `webview/components/sidebar.tsx`: delete local `baseName`, `STATUS_RANK`, `sortSessions`; add `projects` prop; `filtered` = `sessionMatchesFilter(s, filter, {projectName, agentLabel})`; grouped → `groupSessions(filtered, projects, {sort, filterActive})`, flat → `orderSessions`; group wrapper `<div className="proj" role="group" aria-labelledby={labelId} key={g.key}>`; header name/title = project name or `Standalone`; collapse keyed `g.key`; `sessionDrag` group marker = `g.key`; header drag (project groups only) → `projectOrderAfterDrop(renderedProjectIds, drag, target, projects.map(p => p.id))` → non-null: `post({type:'project:reorder', ids})` and switch to manual when sort ≠ manual; `commitReorder` passes `projects`; empty state: first-run copy (`No sessions yet` / `A session is one terminal working across one or more folders. Run four at once.`) iff `sessions.length === 0 && (projects.length === 0 || !grouped)`, `sidebar__scroll--empty` only then; zero sessions + projects + grouped → headers with count 0.
- Modify: `webview/app.tsx` (Sidebar `projects={state?.projects ?? []}`)
- Modify: `webview/mock.ts` (mock `projects`: `[{id:'p-mock-a', name:'nextjs-portfolio', order:0},{id:'p-mock-b', name:'conduit', order:1}]`; give two mock sessions those `projectId`s, leave one standalone)

**Interfaces:**
- Consumes: `STANDALONE_KEY`, `type SessionGroup` (the sidebar's group-render helper takes one), `sortSessions` (reorder.ts), `orderSessions`, `groupSessions`, `sessionMatchesFilter`, `projectOrderAfterDrop` (T1.1, exact signatures in Contracts). `groupKeyOf` is used inside `groupSessions` and by tests in this slice; its first production importer outside the module is T4.4.
- Produces: `sortedCanonical(ids, sort, sessionsById, projects)`, `reorderPersists(candidate, current, sort, sessionsById, projects)`.

**Call sites:** `sortedCanonical` — `src/reorder.ts` (`reorderPersists`), `test/unit/sidebar-grouping.test.ts`; `reorderPersists` — `webview/components/sidebar.tsx` `commitReorder`, `test/unit/sidebar-grouping.test.ts`; `reorderByGroup` — `sidebar.tsx` `groupDrag`, both tests.

**Steps:**
- [ ] Failing test in `sidebar-grouping.test.ts`: `'sortedCanonical project sort uses project names, standalone last'` — key assertion: `sortedCanonical(['s1','s2','s3'], 'project', map, [{id:'pb',name:'b',order:0},{id:'pa',name:'a',order:1}])` with s1 standalone, s2 in pb, s3 in pa → `['s3','s2','s1']`.
- [ ] Run `npx vitest run test/unit/sidebar-grouping.test.ts` — expect FAIL (arity / comparator).
- [ ] Implement the reorder change, then the sidebar and app edits; `npm run typecheck`.

### Slice 2: The 9b card

**Check:** `npx vitest run test/unit/session-card.test.ts test/unit/hover-overlays.test.ts test/unit/state-vocabulary.test.ts`; `npm run typecheck`; `npm run fallow:check`; after build, `node test/e2e/run-smoke.mjs hover-obstruction` (unchanged file, must stay green) and `npm run shots` looked at for the card in all three themes.

**Parallel groups:** Serial: T2.1 → T2.2
**Claims (serial lane):** `webview/components/session-card.tsx`, `webview/styles.css`, `webview/components/sidebar.tsx`, `webview/app.tsx`

#### Task 2.1: Card structure and style

**Files:**
- Modify: `webview/components/session-card.tsx` (drop `age`, the meter block, the review diffstat block, the `onOpenReview` prop, the `shortAge` import; × becomes `<IconClose size={12} />` with `aria-label="Close session"` and `title="Close session"`; add `SessionCardPreview`; update the doc comment to describe what the card now shows and point at spec §2.3)
- Modify: `webview/relative-time.ts` (delete `shortAge`)
- Modify: `webview/components/sidebar.tsx` (drop `onOpenReview` prop and its pass-through)
- Modify: `webview/app.tsx` (drop `onOpenReview={openReviewForSession}`; delete `openReviewForSession`)
- Modify: `webview/styles.css`: delete `.session__age`, `.session__meter`, `.session__meterfill` (and their Neon / reduced-motion variants), `.session__diffstat*`; `.session__state` → `font-weight: 700; font-size: calc(9.5px * var(--font-scale)); padding: 3px 8px; border-radius: var(--r-round)`; `.session--idle .session__state, .session--stale .session__state { background: transparent; }`; `.session__kill` → `width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-md); background: rgba(var(--overlay), 0.07); padding: 0`, keeping its `opacity: 0; pointer-events: none` and the existing reveal; `.session__kill:hover, .session__kill:focus-visible { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }`; the name line `font-family: var(--font-ui); font-weight: 600; font-size: calc(12.5px * var(--font-scale))`; `.session__meta` mono 10px `var(--text-faint)`
- Modify: `test/unit/state-vocabulary.test.ts` (`HOVER_FILL_ALLOW` gains `['.session__kill:hover, .session__kill:focus-visible', 'destructive close — red is the meaning']`)
- Test: `test/unit/session-card.test.ts`

**Interfaces:**
- Produces: `SessionCardPreview({ roles }: { roles: CardRoles }): JSX.Element`.

**Call sites:** `shortAge` — `session-card.tsx:93` only; `openReviewForSession` — `app.tsx:3378` only; `SessionCard.onOpenReview` — `sidebar.tsx:362` only.

**Steps:**
- [ ] Failing tests (`renderToStaticMarkup`): `'idle card: glyph, name, agent subtitle by default, pill "Idle", no age/meter/diffstat'` — markup contains `session__state">Idle` and not `session__age`, `session__meter`, `session__diffstat`; `'busy card has no meter'`; `'× is labelled Close session'`; `'attention card shows Go to and Snooze'`; `'stale card shows ↻'`; `'review card shows the Review pill and no diffstat button'`; `'SessionCardPreview renders a session__state pill and the agent line for roles {name, agent, none}'`.
- [ ] Run `npx vitest run test/unit/session-card.test.ts` — expect FAIL.
- [ ] Implement; run the slice's unit files.

#### Task 2.2: Settings preview uses the real card

**Files:**
- Modify: `webview/components/settings-modal.tsx` (`SessionCardSection` renders `<SessionCardPreview roles={{title: settings.cardTitle, subtitle: settings.cardSubtitle, detail: settings.cardDetail}} />` in `.cardcfg__preview`; delete `SAMPLE` and the hand-built card markup)

**Interfaces:**
- Consumes: `SessionCardPreview({ roles }: { roles: CardRoles })`, `CardRoles` (`webview/components/session-card.tsx`).

**Steps:**
- [ ] Carve-out (visual-fidelity): capture Settings → Session card in all three themes with `npm run shots` (or the running app) **before** the edit, into `%TEMP%\claude-scratch\`; after the edit, compare side by side: the preview now shows glyph, name, agent line and pill, matching a rail card. Delete the captures.

### Slice 3: Group header — +, menu, rename, delete, Open board

**Check:** `npx vitest run test/unit/project-name.test.ts test/unit/project-store.test.ts test/unit/session-groups.test.ts test/unit/project-announcer.test.ts test/unit/project-group-header.test.ts test/unit/hover-overlays.test.ts`; `npm run typecheck`; after build, `node test/e2e/run-smoke.mjs hover-obstruction`, then `node test/e2e/run-smoke.mjs sidebar-projects` (phase A).

**Parallel groups:** G1: T3.1 · G2: T3.2 · G3: T3.3 · G4: T3.4 · Serial: T3.5 → T3.6
**Claims (serial lane):** `webview/components/sidebar.tsx`, `webview/app.tsx`, `webview/styles.css`, `test/e2e/sidebar-projects.e2e.mjs`

#### Task 3.1: Project-name rule

**Files:**
- Create: `src/project-name.ts`
- Modify: `src/project-store.ts` (import `normalizeProjectName`; delete the private copy)
- Test: `test/unit/project-name.test.ts`

**Interfaces:**
- Produces: `normalizeProjectName(raw: unknown): string | null`, `renamedProjectName(draft: string, current: string): string | null`.

**Steps:**
- [ ] Failing tests: `'trims and collapses whitespace'` (`'  RMB   pipeline '` → `'RMB pipeline'`); `'empty, whitespace-only, 81 chars, non-string → null; 80 chars ok'`; `'renamedProjectName: unchanged → null, empty → null, changed → normalized'`.
- [ ] Run `npx vitest run test/unit/project-name.test.ts` — expect FAIL; implement; `test/unit/project-store.test.ts` stays green unmodified.

#### Task 3.2: Delete copy and Open-board target

**Files:**
- Modify: `src/session-groups.ts` (add `deleteProjectDialog`, `openBoardTarget`)
- Test: `test/unit/session-groups.test.ts`

**Interfaces:**
- Produces: `deleteProjectDialog(name, count, windowCount)`, `openBoardTarget(projectId, sessions, activeId)` (Contracts).

**Steps:**
- [ ] Failing tests: `'delete copy for 0, 1, 2 sessions in one window'` (exact strings from Contracts); `'count-free copy when windowCount > 1, even with count 0'`; `'title uses curly quotes'`; `'openBoardTarget: active in project → active; else highest lastActiveAt; none → undefined; ignores other projects'`.
- [ ] Run — FAIL; implement.

#### Task 3.3: Announcer (deletes)

**Files:**
- Create: `webview/project-announcer.ts` (`noteDelete`, `observeProjects`, `subscribe`, `getSnapshot`)
- Test: `test/unit/project-announcer.test.ts`

**Interfaces:**
- Produces: `projectAnnouncer.noteDelete/observeProjects/subscribe/getSnapshot` (Contracts).

**Steps:**
- [ ] Failing tests: `'noteDelete then observeProjects without the id → "Deleted <name>", subscribers notified'`; `'still present → nothing'`; `'announced once'`; `'same text twice re-announces (differs by a zero-width space)'`.
- [ ] Run — FAIL; implement.

#### Task 3.4: Group header component

**Files:**
- Create: `webview/components/project-group-header.tsx`
- Test: `test/unit/project-group-header.test.ts` (jsdom)

**Interfaces:**
- Produces: `ProjectGroupHeader`, `HeaderDropCue`, `HeaderDragHandlers` (Contracts).
- Consumes: `Rect` (`src/menu-position.ts`), `IconChevron`, `IconChevronDown`, `IconPlus` (`webview/icons`).

**Steps:**
- [ ] Failing tests: `'+ has aria-label "New session in RMB" and calls onNew, not onToggle'`; `'Standalone + is labelled "New standalone session"'`; `'right-click calls onMenu with the point and preventDefaults'`; `'Shift+F10 on the chevron calls onMenu with the header rect and keyboard:true'`; `'ContextMenu key on + does the same'`; `'renaming: input focused with the name selected; Enter → onRenameEnd(value); Escape → onRenameEnd(null); blur → onRenameEnd(value)'`; `'no drag.onDragStart → not draggable'`; `'dropCue into → proj__label--dropinto'`; `'name span carries labelId'`.
- [ ] Run `npx vitest run test/unit/project-group-header.test.ts` — expect FAIL; implement.

#### Task 3.5: Sidebar + app wiring, header CSS

**Files:**
- Modify: `webview/components/sidebar.tsx`: render `ProjectGroupHeader` per group (`labelId` from `useId()` + key); new props (Contracts §Sidebar props); `renamingProjectId` state, cleared when its id leaves `projects`; `onRenameEnd(draft)` → `renamedProjectName(draft, name)` non-null → `post({type:'project:rename', id, name})`; header menu via the existing `menu` state: project group → `New session in project` (IconPlus, `onNewInProject(id)`), `Open board` (IconBoard, disabled when `openBoardTarget` is undefined, → `onOpenBoard(target)`), `Rename…` (IconPencil), `Delete project…` (IconTrash, danger, separatorBefore) → `onConfirm({ ...deleteProjectDialog(name, count, windowCount), confirmLabel: 'Delete project', danger: true, focusCancel: true, onConfirm: () => { post({type:'project:delete', id}); projectAnnouncer.noteDelete(id, name); update({collapsedProjects: collapsedProjects.filter((k) => k !== id)}); } })` where `count` = sessions with that `projectId` in `sessions`; Standalone → `New standalone session` only. Keyboard-opened menus set `keyboard: true`, `anchor` = header rect, and focus returns to the invoking element on close. `useEffect(() => projectAnnouncer.observeProjects(projects), [projects])`; `<div className="sr-only" aria-live="polite">{useSyncExternalStore(projectAnnouncer.subscribe, projectAnnouncer.getSnapshot)}</div>`.
- Modify: `webview/app.tsx` (Sidebar: `windowCount={Math.max(1, winList.length)}`, `onNewInProject={(projectId) => setNewSession({ projectId })}`, `onOpenBoard={(id) => { setActiveId(id); setCenterView('board'); }}`, `onConfirm={setConfirm}`)
- Modify: `webview/styles.css`: `.proj__slot { flex: 0 0 auto; display: grid; place-items: center; }` with `.proj__slot > * { grid-area: 1 / 1; }`; `.proj__add` 20×20, `border-radius: var(--r-round)`, `background: var(--accent)`, `color: var(--on-accent)`, `border: 0`, `opacity: 0; pointer-events: none`; `.proj__label:hover .proj__add, .proj__label:focus-within .proj__add { opacity: 1; pointer-events: auto; }`; `.proj__label:hover .proj__count, .proj__label:focus-within .proj__count { visibility: hidden; }`; `.proj__name` mono 10px (`calc(10px * var(--font-scale))`); `.proj__rename` inherits the header font, fills the name's flex slot; `.proj__label--dropinto { outline: 1px solid var(--accent); outline-offset: -1px; background: color-mix(in srgb, var(--accent) 9%, transparent); }`.
- Modify: `test/unit/hover-overlays.test.ts` (vacuity list `['.change__row-actions', '.session__kill', '.proj__add']`)

**Interfaces:**
- Consumes: `ProjectGroupHeader`, `type HeaderDropCue`, `type HeaderDragHandlers` (T3.4; the sidebar builds the handlers object and the cue), `renamedProjectName` (T3.1), `deleteProjectDialog`, `openBoardTarget` (T3.2), `projectAnnouncer.noteDelete/observeProjects/subscribe/getSnapshot` (T3.3), `ConfirmState` (`webview/components/confirm-dialog.tsx`), `setNewSession({ projectId })` (mf-new-session).

**Steps:**
- [ ] Failing test first: the `hover-overlays` vacuity-list addition — `npx vitest run test/unit/hover-overlays.test.ts` FAILS until `.proj__add` has its fade + reveal rules.
- [ ] Implement; `npm run typecheck`; the slice's unit files green.

#### Task 3.6: e2e — header phase

**Files:**
- Modify: `test/e2e/hover-obstruction.e2e.mjs` (after the card checks: rest the pointer; `invisibleHitAlongRightEdge` over the Standalone `.proj__label` box → none; `page.mouse.move` to the header's centre, wait 400 ms; `.proj__add` computed `pointer-events: auto`, opacity > 0, and `document.elementFromPoint` at its centre is inside `.proj__add`)
- Create: `test/e2e/sidebar-projects.e2e.mjs` (phase A; `launchApp({ userDataDir })` / `closeApp`, Windows-only skip, exit codes as `context-menu-order`)

**Steps:**
- [ ] Empty states (AC 12), on a fresh `userDataDir`: `launchApp` passes `REPO` on argv, which opens a session, so first post `kill` for every id in `__sessions` and wait for it to empty. Then `.sidebar .emptystate__title` reads `No sessions yet`, `.sidebar .emptystate__hint` reads `A session is one terminal working across one or more folders. Run four at once.`, and `.sessbar` is absent. Then `createProject` `Alpha`, `Beta`: two `.proj__label`s with `.proj__count` `0`, and no `.sidebar .emptystate__title`.
- [ ] Setup: temp dirs `A`, `B`, `R` (R a plain folder named `rootfolder-zz`); `openSession` into Alpha (home A), into Beta (home B, `roots: [R]`), and one standalone (home A).
- [ ] Assert header order `Alpha, Beta, Standalone` (`.proj__name` texts), each count 1.
- [ ] Rename: right-click Alpha's `.proj__label` → click `Rename…` → type `Alpha2` → Enter → `.proj__name` reads `Alpha2`; `closeApp` → relaunch on the same `userDataDir` → still `Alpha2`.
- [ ] Header +: `page.mouse.move` over Beta's header; `elementFromPoint` at `.proj__add` centre is inside it; `page.mouse.click` there → `[aria-label="Project: Beta"]` visible; Escape closes the dialog.
- [ ] Ctrl+N: click the Alpha2 card (active) → `Control+N` → `[aria-label="Project: Alpha2"]`; Escape.
- [ ] Open board: header menu `Open board` on Beta → the `.session--active` card's `data-sessionid` is Beta's session and `.board` is visible; close the board.
- [ ] Shift+F10: focus Beta's `.proj__chevron` → `Shift+F10` → `.ctxmenu` open with `.ctxmenu__item--active` on `New session in project`; Escape.
- [ ] Filter: type `rootfolder-zz` → only Beta's card visible; replace with the lower-cased `.session__meta` text of the standalone card (its agent label) → that card is visible; clear.
- [ ] Delete: header menu `Delete project…` on Alpha2 → `.confirm__msg` equals `Its 1 session becomes standalone and keeps running. Folders and their .conduit/ data aren't touched.`; press Enter → `.confirm` detached and `__projects` still has Alpha2; reopen → click `.btn--danger` → `__projects` lacks it; its session has no `projectId`, `status === 'running'`, and renders under `Standalone`; the sr-only live region reads `Deleted Alpha2`.

### Slice 4: Moving sessions — picker, card menu, drop on a header

**Check:** `npx vitest run test/unit/context-menu-activation.test.ts test/unit/middle-click-menus.test.ts test/unit/project-announcer.test.ts test/unit/session-groups.test.ts test/unit/project-picker.test.ts test/unit/overlay-sites.test.ts test/unit/drag-region.test.ts`; `npm run typecheck`; after build, serially: `sidebar-projects`, `context-menu-order`, `sidebar-dnd`, `hover-obstruction`, `multi-window`; then `npm run shots` looked at for the grouped rail in all three themes; end of item `npm run verify`.

**Parallel groups:** G1: T4.1 · G2: T4.2 · G3: T4.3 · Serial: T4.4 → T4.5 → T4.6
**Claims (serial lane):** `webview/app.tsx`, `webview/components/sidebar.tsx`, `webview/styles.css`, `test/e2e/sidebar-projects.e2e.mjs`, `CHANGELOG.md`

#### Task 4.1: `MenuActivation` and `Popover.onEscape`

**Files:**
- Modify: `webview/components/context-menu.tsx`, `webview/components/popover.tsx`
- Test: `test/unit/context-menu-activation.test.ts` (jsdom)

**Interfaces:**
- Produces: `MenuActivation { rect: Rect }`, `MenuItem.onClick: (activation?: MenuActivation) => void`, `PopoverProps.onEscape?: () => void`.

**Call sites:** `it.onClick()` — `context-menu.tsx:116` (Enter) and `:147` (click); every `MenuItem` literal keeps compiling (`() => …` is assignable).

**Steps:**
- [ ] Failing tests: `'click passes the row rect'` (stub `getBoundingClientRect` on the row → `onClick` receives `{rect}` with that `right`); `'Enter on a keyboard-highlighted row passes its rect'`; `'Popover: Escape calls onEscape, not onClose; outside mousedown still calls onClose'`; `'Popover without onEscape: Escape calls onClose'`.
- [ ] Run — FAIL; implement; `test/unit/middle-click-menus.test.ts` stays green.

#### Task 4.2: Announcer moves

**Files:**
- Modify: `webview/project-announcer.ts` (`moveSession`)
- Test: `test/unit/project-announcer.test.ts` (`vi.mock('../../webview/host-request')`, capturing `send` and resolving the promise by hand)

**Interfaces:**
- Consumes: `requestHost(send, types, timeoutMs)` (`webview/host-request.ts`, mf-new-session).
- Produces: `projectAnnouncer.moveSession(sessionId, projectId, text)`.

**Steps:**
- [ ] Failing tests: `'moveSession sends session:setProject {sessionId, projectId, requestId} awaiting session:opResult'`; `'ok reply → "Moved api fix to RMB pipeline"'`; `'!ok → "Couldn't move api fix"'`; `'null (timeout) → no announcement'`.
- [ ] Run — FAIL; implement.

#### Task 4.3: Drop intent and picker rows

**Files:**
- Modify: `src/session-groups.ts` (`cardDropIntent`, `PickerRow`, `projectPickerRows`)
- Test: `test/unit/session-groups.test.ts`

**Interfaces:**
- Produces: `cardDropIntent(sourceKey, targetKey)`, `PickerRow`, `projectPickerRows(projects, filter, currentKey)` (Contracts).

**Steps:**
- [ ] Failing tests: `'another project → {projectId}'`; `'Standalone target → {projectId: null}'`; `'own group → null'`; `'picker rows: projects in order then Standalone; current flagged (dangling id → Standalone current)'`; `'filter is case-insensitive substring; no match → noMatch, Standalone still present'`.
- [ ] Run — FAIL; implement.

#### Task 4.4: Project picker

**Files:**
- Create: `webview/components/project-picker.tsx`
- Test: `test/unit/project-picker.test.ts` (jsdom; mock `webview/host-request` and `webview/project-announcer`)

**Interfaces:**
- Consumes: `projectPickerRows`, `PickerRow`, `STANDALONE_KEY` (T4.3); `groupKeyOf(session, projects)` for `currentKey` (T1.1); `normalizeProjectName` (T3.1); `projectAnnouncer.moveSession` (T4.2); `requestHost` (`webview/host-request.ts`); `Popover` with `onEscape` (T4.1).
- Produces: `ProjectPicker` (Contracts).

**Steps:**
- [ ] Failing tests: `'filter input focused on open; rows = projects then Standalone; current row aria-selected with a check'`; `'no match → a disabled "No projects match" row, Standalone and + New project… still shown'`; `'ArrowDown moves aria-activedescendant; Enter on another row → moveSession(id, …) and onClose'`; `'Enter on the current row → onClose only'`; `'New project: prefilled with the filter; empty name → hint "1–80 characters", nothing posted'`; `'Enter → requestHost sends project:create, input disabled; a project:created reply → moveSession(sessionId, newId, …) and onClose'`; `'project:opResult invalid-name → re-enabled with the hint'`; `'null reply (timeout) → re-enabled, nothing chained'`; `'Escape while creating returns to the list (onEscape), Escape in the list closes'`; `'session undefined → onClose, nothing posted'`; `'a reply resolving after unmount is ignored'`.
- [ ] Run `npx vitest run test/unit/project-picker.test.ts` — expect FAIL; implement.

#### Task 4.5: Card menu, picker mount, drop on a header

**Files:**
- Modify: `webview/app.tsx`: `onSessionContextMenu` — insert `{ label: 'Move to project…', icon: <IconFolder size={14} />, onClick: (a) => setMovePicker({ sessionId: s.id, at: a ? { x: a.rect.right, y: a.rect.top } : { x: e.clientX, y: e.clientY } }) }` right after `Duplicate session`, before `...moveMenuItems(s.id)`; `Copy path` → `Copy home path` copying `s.home`; `Reveal in Explorer` reveals `s.home`; state `const [movePicker, setMovePicker] = useState<{ sessionId: string; at: { x: number; y: number } } | null>(null)`; render `{movePicker && <ProjectPicker session={sessions.find((x) => x.id === movePicker.sessionId)} projects={state?.projects ?? []} at={movePicker.at} onClose={() => setMovePicker(null)} />}` beside the IconPicker mount.
- Modify: `webview/components/sidebar.tsx`: header `drag` handlers dispatch on the marker. `dragIdRef` set (a card) → `cardDropIntent(dragGroup.current, key)` non-null: `preventDefault`, `overHeaderKey = key` (cue `into`); drop → `projectAnnouncer.moveSession(dragIdRef.current, intent.projectId, {session, target: name})`; `dragGroupRef` set (a header) → today's `before` cue and `project:reorder` (Slice 1); `onDragLeave` clears `overHeaderKey` when `relatedTarget` is outside the header; `reset()` clears it. Header drop handlers exist only when `grouped && canDrag`.
- Modify: `webview/styles.css` (`.projpicker` inside `.ctxmenu`: `.projpicker__filter` input, `.projpicker__row` with `--active` and trailing check, `.projpicker__none` disabled row, `.projpicker__new` in `var(--accent)`, `.projpicker__hint` in `var(--text-faint)`; rows ellipsise with `title`)
- Modify: `test/unit/overlay-sites.test.ts` (`ALL_FILES` gains `'project-picker'`)

**Interfaces:**
- Consumes: `ProjectPicker` (T4.4), `MenuActivation` (T4.1), `cardDropIntent` (T4.3), `projectAnnouncer.moveSession` (T4.2).

**Steps:**
- [ ] Failing test first: `npx vitest run test/unit/overlay-sites.test.ts` with `'project-picker'` added — FAILS until the file exists (T4.4 makes it exist, so confirm it passes and that the picker has no `e.key === 'Escape'` dismiss).
- [ ] Implement; `npm run typecheck`.

#### Task 4.6: e2e — moves, menus; shots; changelog

**Files:**
- Modify: `test/e2e/sidebar-projects.e2e.mjs` (phase B)
- Modify: `test/e2e/context-menu-order.e2e.mjs`
- Modify: `test/e2e/visual/shoot.mjs` (after its sessions open: `project:create` `conduit` via the bridge, wait for it in state, `session:setProject` the first session into it)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added` / `### Changed` entries: rail grouped by project with header +, menu, rename, delete and Move to project…; card simplified; subtitle default Agent with the one-time upgrade)

**Steps:**
- [ ] sidebar-projects phase B, standalone session `S` running `shell:cmd`: `term:input` `echo MARKER_MF_ZZ\r`, wait for it in `__cap`. Card right-click → `Move to project…` → `.projpicker` open with the filter focused → click row `Beta` → S renders under Beta, `status === 'running'`, and the visible `.xterm-rows` text still contains `MARKER_MF_ZZ`; the live region reads `Moved <S name> to Beta`.
- [ ] Picker `+ New project…` → type `RMB pipeline` → Enter → a `RMB pipeline` group appears above `Standalone` containing S.
- [ ] `Copy home path` → `app.evaluate(({ clipboard }) => clipboard.readText())` equals S's `home`.
- [ ] Drag onto a header (terminal-drop technique): in one `page.evaluate`, one `new DataTransfer()`; dispatch `dragstart` on `.session[data-sessionid="<S>"]`, `dragover` on Beta's `.proj__label`; assert Beta's header has `proj__label--dropinto`; dispatch `drop` there and `dragend` on the card. S's `projectId` becomes Beta's id; `__sessions` still holds S (no window move). Repeat onto S's own header: no `--dropinto`, `projectId` unchanged after 1 s.
- [ ] Hover ×: `page.mouse.move` over a card; `elementFromPoint` at `.session__kill` centre is the ×; `page.mouse.click` it; if `.confirm` appears click `.btn--danger`; the session leaves `__sessions`.
- [ ] context-menu-order: session menu — `Move to project…` index = `Duplicate session` index + 1 and < `Move to new window` index; `Copy home path` present, `Copy path` absent; `Reveal in Explorer` after `Copy home path`. Header menus: `createProject` + `session:setProject` the session in; its `.proj__label` menu is exactly `['New session in project', 'Open board', 'Rename…', 'Delete project…']` and passes `assertCanonical`; a second standalone session's `Standalone` header menu is exactly `['New standalone session']`.
- [ ] Carve-out (e2e/visual): proof is the slice check.

## Verification

- Per task: that task's `npx vitest run <file>`, red observed before green.
- Per slice: `npm run typecheck`, `npm run test:unit`, `npm run fallow:check`; then `npm run build` and the slice's e2e list, **one scenario at a time** (`node test/e2e/run-smoke.mjs <name>`). A PTY-echo failure is re-run alone on a quiet machine before it counts.
- End of item: `npm run verify` green, exit code read directly (never piped through `tail`); then serially `sidebar-projects`, `sidebar-dnd`, `context-menu-order`, `hover-obstruction`, `multi-window`, `attention`, `overlay-popovers`, `overlay-modals`; `npm run shots` reviewed in all three themes (card, grouped rail, header hover +, picker).
- Human smoke (cannot be automated; CLAUDE.md): one real-mouse card→header drag; one real click on the header + and on the card × (Playwright bypasses hit-testing / the app-region mask).
- `git status` shows only the files in the file map.

## Deviation rule

If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality (an mf-model or mf-new-session export named here is absent or shaped
differently) — that task **stops** and fixing the misaligned piece becomes the work. Never a shim,
second copy, special case, widened type, alias, fallback, or an override patched in place of its
semantic source. The report leads with the fix that keeps the locked decision.

## Decisions Needed

1. [normal] **No `projectForNewSession` here.** It lives in mf-new-session's
   `src/new-session-seed.ts`, and `seedNewSession` applies it when `prefill.projectId` is
   `undefined` (its plan). Only the group + and "New session in project" pass `projectId`. If the
   built seed does not derive, T3.6's Ctrl+N assertion fails and the fix belongs in mf-new-session's
   seed — not a second derivation here.
2. [normal] **Request/reply via mf-new-session's `requestHost`** (`webview/host-request.ts`), so
   the picker's `project:create`, the dialog's Start-time `project:create` and the announcer's
   `session:setProject` share one id space. If it is absent at build time, stop (deviation rule).
3. [normal] **`MenuItem.onClick(activation?)`** is optional, not required, because programmatic
   callers (unit tests) invoke items bare; `ContextMenu` always passes it. The picker falls back
   to the right-click point without it.
4. [normal] **`Popover.onEscape`** added so the picker's creating mode can treat Escape as "back"
   while outside clicks still close; the capture-phase overlay stack leaves no other clean hook.
5. [normal] **`collapsedProjects` path detection** = "contains `/` or `\`". Project ids are
   `p-<hex>` and `'standalone'`; ids of projects deleted in another window linger harmlessly
   until this window deletes or toggles them.
6. [normal] **`store-unavailable`** (mf-model B2) in the picker shows `Couldn't create project`;
   the spec only named `invalid-name`.
7. [normal] **Settings preview is the real `SessionCard`** (inert, sample session), so AC 13 can't
   drift; the `SAMPLE` string map goes.
8. [normal] **Header reorder uses the rendered project order.** Drag is on only when grouped and
   unfiltered, where every project renders (empty ones included), so the rendered order is the
   full order.
9. [normal] **`deleteProjectDialog` counts `state.sessions`** (this window only) and switches to
   the count-free copy whenever `winList.length > 1` (D13).

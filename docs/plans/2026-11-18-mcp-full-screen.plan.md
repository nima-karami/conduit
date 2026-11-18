# MCP as one full-screen Settings section — implementation plan

**Spec:** docs/specs/2026-11-18-mcp-full-screen.md  **Tier:** FULL

## Goal
Settings becomes a full-screen page under the title bar with a Back button, and MCP + Permissions become one MCP section with five tabs, with Roles and Agents redrawn from the approved canvas (D1–D7).

## Architecture
Renderer-only (plus one banner string in `src/contracts/native-launch.ts`). `SettingsModal` is renamed `SettingsPage` and stops being a `ModalLayer`: it is a `position: fixed` page over the still-mounted workbench (terminals keep their size and scrollback), registered as ONE overlay entry so Esc, `isAnyModalOpen` and nested dialogs behave as today. Esc steps back one level through a nested-back handler that the Roles and Agents panels register with the page (editor/review/delete/drawer first, then release notes, then close). Focus returns to the opener from `app.tsx` after `inert` clears. A new `McpSection` hosts the five tabs and mounts the existing Permissions components; Roles and Agents get a list + drawer layout. Activity leaves the center pane and mounts in the tab. Nothing under `src/conduit-mcp/` changes.

## Data flow
```
app.tsx  openSettingsAt(tab, cli?, {releaseNotes?, mcpTab?})   openActivity(scope)
   │ settingsOpen · settingsTab · settingsMcpTab · settingsSeq · activityScope · exception seed
   ▼
<SettingsPage navSeq={settingsSeq}> ── nav (General MCP Links Appearance Shortcuts Skills About) ── Back ──► onClose
   │ tab === 'mcp'
   ▼
<McpSection tab onTabChange settings={<McpTab/>}>
   ├─ settings → McpTab (moved, unchanged)
   ├─ roles    → PermissionsRoles ──► role list + role drawer + editor (+ review/delete pages, unchanged)
   ├─ agents   → PermissionsAssignments ──► agents list + agent drawer (+ edit/review, existing logic)
   ├─ grants   → PermissionsGrants (unchanged)
   └─ activity → PermissionsActivity (scope from app.tsx) ──onAddException──► app.tsx ──► seed + openSettingsAt(…'agents')
policy data: useConduitMcp() inside each panel (unchanged store, unchanged protocol)
```

## Settled decisions — do not re-litigate
- Owner approved the canvas page "MCP · full-screen settings" (D1–D7). Run scope = D1–D7; E1/E2/E4 later; E3 blocked on the owner.
- UI only; no change under `src/conduit-mcp/`; identifiers keep the word "profile" (copy says "role").
- Side drawer (not pop-up) for role/agent detail; the drawer overlays the list below 1100 px.
- Settings is ONE overlay entry. Esc ladder (one rule): Roles/Agents sub-view (delete page → review → editor → drawer) → About release notes → close Settings. A shortcut recording keeps its own Esc. Drawers register nothing on the overlay stack: a `'modal'` push dismisses every popover and shifts real dialogs' z-index (`src/overlay-stack.ts:24-37`).
- Rejected: rendering Settings as a `.workbench` sibling that replaces it (unmounts terminals; the PTY size must equal the xterm size, CLAUDE.md). Rejected: remounting the page on every open call (loses staged edits); the page re-applies its target when `navSeq` changes.
- Single-consumer splits are kept only where the piece has its own state or test surface (role summary, role list, role drawer, agents list). The agent drawer is a local function in `permissions-assignments.tsx`. No `mcp-tabs.ts`, no second strings module: tab ids and copy live in `webview/conduit-mcp-strings.ts`.
- The banners above the workbench (`.server-banner`, `NativeImpactNotice`, `PermissionStoreNotice`, `app.tsx:5866-5880`) are covered while Settings is open, by design: the MCP tabs show their own disconnected/read-only copy. Title bar and command palette stay usable; the workbench is `inert`.
- Activity moves into MCP › Activity; the `permissions-activity` doc kind is deleted (never persisted: `webview/docs.ts:973`, `src/persistence.ts:171-175`).
- Existing class names `.settings__nav`, `.settings__navitem(--active)`, `.settings__pane` stay, so selectors in ~20 e2e files only change at the container (`.modal.settings` → `.settings-page`) and the close button.

## Spec staleness
- Spec §3 names only `webview/docs.ts` and `center-pane.tsx` for the doc kind. Measured: also `webview/doc-groups.ts:27` and `test/unit/permissions-activity-doc.test.ts`. Both are in this plan.
- Spec §9 said "14 entry points". Measured: 16 call sites of `openSettingsAt`/`setSettingsOpen(true)` plus the Mod+, shortcut; the retarget table below is the authority.
- Spec §10 said the workspace is `inert`. Measured: the title bar must stay usable (window controls, search), so `inert` goes on `.workbench` only, not `.shell` (`.shell` already uses `inert` for the migration dialog, `webview/app.tsx:5816`).

## Global constraints
- Gate: `flock /tmp/claude-1000/conduit-gate.lock npm run verify`; inner loop `flock … npm run verify:quick`; named `npx vitest run <file>`, `npx biome check <files>`, `npx tsc -p tsconfig.webview.json --noEmit` take no lock. Capture exit codes directly (`…; echo "exit=$?"`), never through a pipe.
- E2E only via `npm run e2e:remote` (`--affected` during work, `--full` on the final SHA: 0 failures, 0 retry-passes). Local e2e only one scenario by exact name, headless only. Never launch a visible window.
- Files kebab-case (`biome useFilenamingConvention`); components PascalCase; no `any`, no `!important`, no specificity escalation, no swallowed errors; comments explain WHY only, citing the spec section; single quotes, line width 100.
- Every new export has an importer (fallow `fallow:check` flags unused exports; test imports count).
- Strings: new copy lives in `MCP_STR.sections` (`webview/conduit-mcp-strings.ts`) or `CHROME_STR`; counts use `plural` from `src/plural.ts`. No new inline copy literals in new JSX.
- Colour: reuse `--success`, `--yellow`, `--danger`, `--accent`, `--text-dim`, `--border-2`, `--raise`, `--panel`, `--ground`. No new colour tokens. Pills always carry text.
- Do not touch CON-60 files: `electron/updater.ts`, `electron/deb-install-failure.ts`, update toast/card, whats-new.
- Existing focus/scroll constraints survive the move unchanged (commits `3a381233`, `297b45ca`, `63a1a0e9`): release-notes handoff focus, X/Back from release notes, rail and notes scroll independently.
- Commit per task on `CON-57-mcp-full-screen` with `git -c user.name=… -c user.email=…` (identity from `git log main`); no merge to main, no push.

## Out of scope
Row-menu Permissions submenu (E1), workspace Customize drawer (E2), refusal fix flow (E4), approval-card Allow ▾ (E3), per-change Reset buttons and the inline "Add a change" form (the existing exceptions editor is reused), "Reset to <built-in>", renaming identifiers, any `src/conduit-mcp/` change.

## Contracts
```ts
// webview/conduit-mcp-strings.ts (modify) — the one string home
export const MCP_TAB_ORDER = ['settings', 'roles', 'agents', 'grants', 'activity'] as const;
export type McpTabId = (typeof MCP_TAB_ORDER)[number];
// MCP_STR.sections = { tablistLabel: 'MCP sections',
//   tabs: { settings: 'Settings', roles: 'Roles', agents: 'Agents', grants: 'Grants', activity: 'Activity' } satisfies Record<McpTabId, string>,
//   …roles/agents copy, added by the task that renders it }

// webview/components/settings-page.tsx (git mv of settings-modal.tsx)
export type SettingsTab = 'general' | 'mcp' | 'appearance' | 'shortcuts' | 'skills' | 'links' | 'about';
// SettingsPageProps = SettingsModal's props type, with:
//   + initialMcpTab?: McpTabId (default 'settings'); initialAgentKey?: string  (an AssignmentPoint `pointKey`)
//   + navSeq?: number — when it changes after mount the page re-applies initialTab/initialMcpTab/initialAgentKey/initialCli;
//     the page is never remounted, so staged edits survive a repeated openSettingsAt
//   + activityScope?: ActivityScope (default {}); activityMachines?: readonly { id: string; name: string }[] (default [])
//   + onAddActivityException?(source: ActivityExceptionSource): void; onOpenActivity?(scope: ActivityScope): void
//   - onOpenPermissionActivity (the Links tab's Activity link calls onOpenActivity({ machineId }); app passes openActivity)
export function SettingsPage(props: SettingsPageProps): JSX.Element;
// Root <div className="settings-page" role="region" aria-label="Settings">. ONE overlay entry:
//   useOverlayEntry('modal', onEscape), onEscape = () => { if (nestedBack.current?.()) return;
//     if (aboutReleaseNotes) leaveReleaseNotes(); else onClose(); }
// On mount it focuses the Back button. It does NOT restore focus: app.tsx does that after `inert` clears.

// webview/components/permissions-activity.tsx — added export; root <main> becomes <section aria-label="Permissions Activity">
export interface ActivityScope { sessionId?: string; machineId?: string; item?: Pick<ActivityEntry, 'id' | 'at'> }

// webview/components/mcp-section.tsx (new)
export type BackHandler = () => boolean; // steps back one level inside a panel; true when it consumed the step
export interface McpSectionProps {
  tab: McpTabId; onTabChange(tab: McpTabId): void;
  settings: ReactNode;
  serverConnected: boolean; sessions: Session[];
  exceptionSeed?: AssignmentExceptionSeed | null; onExceptionSeedConsumed?(): void;
  focusedAgentKey?: string;
  activityScope: ActivityScope; activityMachines: readonly { id: string; name: string }[];
  onAddActivityException(source: ActivityExceptionSource): void;
  registerBack(handler: BackHandler | null): void; // SettingsPage stores it in `nestedBack`
}
export function McpSection(props: McpSectionProps): JSX.Element;
// McpSection calls useConduitMcp() itself, as PermissionsSettings does today: Roles/Agents get `mcp`, Grants gets `mcp.policy` +
// `mcp.grantLifecycle` (read-only copy of the policy when !serverConnected, as permissions-settings.tsx:550-573), Activity gets
// mcp.getActivity, mcp.getActivityRow, mcp.allowOnce (the bindings app.tsx:5444-5458 passes to center-pane today), sessions mapped
// to { id, name }, and machines from `activityMachines` (app.tsx derives it ONCE from `remoteRows`, app.tsx:2298; the derivation in
// center-pane.tsx:435-441 is deleted). Activity is keyed by JSON.stringify([scope.sessionId, scope.machineId, scope.item]).
// tablist = role="tablist" aria-label=MCP_STR.sections.tablistLabel; same roving keys as today (Arrow/Home/End); panels role="tabpanel".

// webview/components/permissions-role-summary.ts (new, pure; importers: role list, role drawer, profile editor)
export interface GroupCounts { allow: number; ask: number; deny: number }
export type GroupState = 'allowed' | 'mixed' | 'denied';
export function groupCounts(profile: Profile, tools: readonly ToolName[]): GroupCounts;
export function groupText(counts: GroupCounts): string;      // "3 allow · 4 ask · 1 deny"; zero counts omitted
export function groupState(counts: GroupCounts): GroupState; // all allow → allowed; all deny → denied; anything else (incl. all ask) → mixed

// webview/components/permissions-role-list.tsx (new)
export interface PermissionsRoleListProps {
  profiles: readonly Profile[]; selectedId: ProfileId | null; usage: ReadonlyMap<ProfileId, number>;
  newAgentRole: ProfileId; readOnly: boolean;
  onSelect(profile: Profile): void; onNew(): void;
}
// webview/components/permissions-role-drawer.tsx (new) — presentational, registers nothing on the overlay stack
export interface PermissionsRoleDrawerProps {
  profile: Profile; used: number; readOnly: boolean;
  onClose(): void; onDuplicate(profile: Profile): void; onEdit(profile: Profile): void; onDelete(profile: Profile): void;
}
// webview/components/permissions-roles.tsx (git mv: `Profiles` out of permissions-settings.tsx)
export function PermissionsRoles(props: { serverConnected: boolean; mcp: ConduitMcpApi; sessions: Session[]; registerBack(handler: BackHandler | null): void }): JSX.Element;
// Back step order inside Roles: deletion page → previous step; review page → editor; editor → drawer; open drawer → closed; otherwise false.

// webview/components/permissions-agents-list.tsx (new)
export interface AgentRow { point: AssignmentPoint; key: string; title: string; subtitle: string; profile: Profile | undefined; changes: number }
export interface PermissionsAgentsListProps {
  rows: readonly AgentRow[]; profiles: readonly Profile[]; selectedKey: string | null; readOnly: boolean;
  newAgentRole: ProfileId; onNewAgentRole(id: ProfileId): void;
  onSelect(row: AgentRow): void; onRoleChange(row: AgentRow, id: ProfileId): void;
}
// webview/components/permissions-assignments.tsx gains props `focusAgentKey?: string` (opens that agent's drawer on mount, using
// the same mount-effect pattern as the exceptionSeed effect at permissions-assignments.tsx:249-301) and
// `registerBack(handler: BackHandler | null): void` (editing/review → drawer view → closed). The agent drawer is a local,
// non-exported function in this file: { title; subtitle; profile; changes: { tool: ToolName; text: string }[]; readOnly; onClose;
// onEditChanges; onResetAll; children }.
```
`app.tsx` — `openSettingsAt(tab, cli?, opts?: { releaseNotes?: boolean; mcpTab?: McpTabId; agentKey?: string })`; it also does `setSettingsSeq((n) => n + 1)`, `setSettingsMcpTab`, `setSettingsAgentKey`, and, when Settings is not yet open, `settingsOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null`. The page receives `navSeq={settingsSeq}`; there is NO `key`. Focus restore: `useEffect(() => { if (settingsOpen) return; const el = settingsOpenerRef.current; settingsOpenerRef.current = null; if (el?.isConnected) el.focus(); else if (activeId) requestDocFocus(terminalFocusKey(activeId)); }, [settingsOpen])` (`requestDocFocus`, `terminalFocusKey`: `webview/focus-targets.ts:14,40`); the effect runs after React has removed `inert`.

Entry-point retarget (every `webview/app.tsx` site):
| Site (line today) | Today | After |
|---|---|---|
| 1771 shortcut `openSettings`; 5223-5247 palette `set:general|appearance|shortcuts|skills`; 5594 footer | tab general / named | unchanged |
| 3874 `setupMcp`; 5255 `set:mcp`; 5463 `onOpenMcpSettings`; 5731 | `'mcp'` | unchanged (MCP › Settings) |
| 5455 Activity add-exception | seed + `'permissions'` | seed + `openSettingsAt('mcp', undefined, { mcpTab: 'agents', agentKey: pointKey({ kind: 'session', sessionId: seed.sessionId }) })` |
| 6079 session dialog `onOpenSettings` | `'permissions'` | `openSettingsAt('mcp', undefined, { mcpTab: 'agents', agentKey: pointKey({ kind: 'session', sessionId: target.id }) })` |
| 5788 upgrade `onReview`; 5878 native-impact notice | `'permissions'` | `openSettingsAt('mcp', undefined, { mcpTab: 'agents' })` (no single agent) |
| `openActivity(scope)` 1080-1091 | opens center doc | `setActivityScope(scope); openSettingsAt('mcp', undefined, { mcpTab: 'activity' })` |
| 5921 `onOpenPermissionActivity` | closes Settings, openActivity | replaced by `onOpenActivity={openActivity}` (no longer closes Settings) |
Invariants: `git diff --stat main -- src/conduit-mcp` is empty; policy tests are not edited; `isAnyModalOpen` keeps `settingsOpen`; the Settings page is mounted only while `settingsOpen`.

## Producer/consumer map
| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Settings target (tab, MCP tab, cli, seed) | `openSettingsAt` callers in `app.tsx` | `SettingsPage` | both |
| Activity scope | `openActivity`, `openRefusal`, session dialog, Links tab | Activity tab | both |
| Exception seed | Activity Why → `onAddActivityException` (app.tsx) | `PermissionsAssignments` seed effect | both |
| `permissions-activity` doc kind | `openActivity` (removed) | `center-pane.tsx`, `docs.ts`, `doc-groups.ts`, `permissions-activity-doc.test.ts` | both (all removed) |
| Missing-home banner copy | `src/contracts/native-launch.ts:44` | `test/unit/missing-home-state.test.ts:172`, banner UI | both |
| Policy store / protocol | `src/conduit-mcp/*` | `useConduitMcp()` | none: unaffected (git diff gate above) |
| `settingsOpen` gates | `app.tsx:609` | `isAnyModalOpen` (4627), upgrade-dialog gate (5758) | unchanged |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `webview/components/settings-modal.tsx` → `settings-page.tsx` | rename + modify | Full-screen container, nav, Back, one overlay entry, routes `mcp` to `McpSection` |
| `webview/conduit-mcp-strings.ts` | modify (claim) | `MCP_TAB_ORDER`, `McpTabId`, `MCP_STR.sections`, copy changes |
| `webview/chrome-strings.ts` | modify | `CHROME_STR.settingsBack = 'Back to Conduit'` |
| `webview/components/mcp-section.tsx` | create | MCP tabs + panels + `BackHandler` |
| `webview/components/permissions-settings.tsx` | delete | its tablist moves to `McpSection`, its `Profiles` to `permissions-roles.tsx` |
| `webview/components/permissions-roles.tsx` | create (move) | Roles tab state machine: list/drawer/editor/review/delete + back handler |
| `webview/components/permissions-profiles.tsx` | delete | replaced by role list + drawer |
| `webview/components/permissions-role-summary.ts` | create | group counts/text/state (pure) |
| `webview/components/permissions-role-list.tsx`, `permissions-role-drawer.tsx` | create | Roles list and drawer |
| `webview/components/permissions-profile-editor.tsx` | modify | Groups collapsed (Sessions open), summary pills, Reach/Move/Screen under "More options" |
| `webview/components/permissions-assignments.tsx` | modify | List + local agent drawer layout; role-dropdown staging; `focusAgentKey`; back handler |
| `webview/components/permissions-agents-list.tsx` | create | Agents list |
| `webview/components/permissions-activity.tsx` | modify | `ActivityScope` export; `<main>` → `<section>` |
| `webview/components/center-pane.tsx`, `webview/docs.ts`, `webview/doc-groups.ts` | modify | Remove the Activity doc kind and its props |
| `webview/app.tsx` | modify (claim) | State, retarget table, focus restore, `activityMachines`, `.workbench` `inert`, `SettingsPage` mount |
| `webview/styles.css` | modify (claim) | `--layer-page`, `.settings-page`, `.mcp-section*`, `.permissions-role*`, `.permissions-agent*`, `.permissions-pill`; remove `.settings` size rules and `.permissions-profiles*` |
| `src/contracts/native-launch.ts` | modify | Banner copy "Open Settings → MCP for recovery." |
| `CHANGELOG.md` | modify (claim) | `[Unreleased]` › `### Changed` bullets |
| tests | see Slices | |

## Scripts
`$TMPDIR/con57-retarget-e2e.mjs` (one-off, not committed): `node con57-retarget-e2e.mjs [--write] <glob…>` applies the exact replacements `.modal.settings` → `.settings-page`, `getByRole('button', { name: 'Close settings' })` → `getByRole('button', { name: 'Back to Conduit' })`, `.settings .iconbtn[aria-label="Close settings"]` → `.settings-page` + the same role query, and prints every remaining `.settings`, `Profiles`, `Assignments`, `'Permissions'` match for manual editing. Replaces ~20 hand edits.

## Slices

### Slice 1: Full-screen container (sections unchanged)
**Check:** `npx vitest run test/unit/settings-mcp-tab.test.tsx test/unit/settings-release-notes-focus.test.tsx test/unit/settings-section-scroll.test.tsx test/unit/overlay-sites.test.ts test/unit/files-drop-claim.test.ts test/unit/settings-page-shell.test.tsx` passes; `verify:quick` exit 0; `npm run e2e:remote -- nav-keybindings-settings settings-release-notes overlay-modals` green.
**Parallel groups:** Serial: T1.1, T1.2, T1.3, T1.4
**Claims (serial lane):** `webview/app.tsx`, `webview/styles.css`, `webview/components/settings-page.tsx`

#### Task 1.1: Rename and de-modal the component
**Files:** Modify (git mv): `webview/components/settings-modal.tsx` → `webview/components/settings-page.tsx`. Modify: `webview/chrome-strings.ts`. Test: `test/unit/settings-page-shell.test.tsx`.
**Interfaces:** Produces `SettingsPage`, `SettingsPageProps` (Contracts; `SettingsTab` still includes `'permissions'` in this slice; `nestedBack` is a `useRef<BackHandler | null>(null)` that stays null until Slice 2). Consumes `useOverlayEntry(kind: OverlayKind, onDismiss?: () => void): { depth: number }`, `CHROME_STR`.
**Call sites:** `webview/app.tsx` (import + JSX), `test/unit/files-drop-claim.test.ts:8`, `test/unit/overlay-sites.test.ts:34`.
**Steps:**
- [ ] Failing test: 'renders a labelled region with a Back button and no modal backdrop' — `document.querySelector('.modal__backdrop') === null`, `getByRole('region', { name: 'Settings' })` present, `getByRole('button', { name: 'Back to Conduit' })` present; 'Back calls onClose once'; 'Esc calls onClose once when nothing nested is open'; 'focus is on Back after open'.
- [ ] Run `npx vitest run test/unit/settings-page-shell.test.tsx` — expect FAIL (module missing).
- [ ] Rename, drop `ModalLayer`, move the close button into the nav top as "Back to Conduit", keep `.settings__navitem`/`.settings__pane`, keep the release-notes Esc-steps-back logic and the focus effects of commits `3a381233`, `297b45ca`, `63a1a0e9` unchanged, add the single overlay entry and Back focus-on-mount. No focus restore in this component.

#### Task 1.2: Mount page, inert workbench, layer, focus restore
**Files:** Modify: `webview/app.tsx` (import; JSX at the old `{settingsOpen && <SettingsModal …>}`; `<div className="workbench" inert={settingsOpen}>`; `settingsSeq`, `settingsOpenerRef`, the focus-restore effect in Contracts), `webview/styles.css` (`--layer-page: 50` beside the layer vars near line 302; `.settings-page`).
**Interfaces:** Consumes `SettingsPage` (T1.1), `requestDocFocus`, `terminalFocusKey`. `.settings-page`: `position: fixed; top: calc(var(--win-pad) + var(--density-topbar-h) + var(--gutter))` (the expression at `styles.css:9845`, same geometry as `.board` at 9837); `left/right/bottom: var(--win-pad); z-index: var(--layer-page); display: flex; background: var(--panel); border-radius: var(--r-card)`. Replace `.settings { width: 830px; height: 1060px; … }` (`styles.css:8099-8104`) and `.settings__head`.
**Steps:**
- [ ] Failing test in `settings-page-shell.test.tsx`: 'workbench is inert while Settings is open' with a harness `<div className="workbench" inert={open}>` containing a button: `container.querySelector('.workbench')?.hasAttribute('inert') === true`. (jsdom does not enforce `inert`; focus restore is proved by the e2e assertion in T1.4.)
- [ ] Implement; run the named tests.

#### Task 1.3: Update the two source-text guards
**Files:** Test: `test/unit/overlay-sites.test.ts` (move `settings-modal` out of `DIALOG_FILES` into an assertion that `settings-page.tsx` contains `useOverlayEntry('modal'`, no `useEscapeKey(`, no `modal__backdrop`; same strength), `test/unit/files-drop-claim.test.ts` (import path and allowlist key → `settings-page`).
- [ ] Run both; commit.

#### Task 1.4: Update unit tests and e2e for the container
**Files:** Test: `test/unit/settings-mcp-tab.test.tsx`, `settings-release-notes-focus.test.tsx` (`.modal.settings` → `.settings-page`; `button('Close settings')` → `'Back to Conduit'`), `settings-section-scroll.test.tsx`; e2e via the script on `nav-keybindings-settings`, `settings-release-notes`, `conduit-mcp-install-banner`, `conduit-mcp-install`, `auto-save-basics`, `net-policy`, `status-bar`, `skill-install`, `settings-quit-flush`, `overlay-modals`, `changes-multi-repo`, `permissions-activity`, plus `test/e2e/visual/shoot.mjs`, `text-fit-sweep.mjs`. New e2e assertion in `nav-keybindings-settings`: after Esc closes Settings opened from the footer button, `document.activeElement` is that footer button (not `body`).
- [ ] Run the script with `--write`; fix the printed leftovers; assertions keep their strength; named unit tests; `verify:quick`; commit.

### Slice 2: One MCP section (existing UIs re-homed, Activity in the tab)
**Check:** `npx vitest run test/unit/mcp-section.test.tsx test/unit/permissions-settings-profiles.test.tsx test/unit/permissions-profile-delete.test.tsx test/unit/permissions-activity.test.tsx test/unit/missing-home-state.test.ts test/unit/session-permissions-native.test.tsx test/unit/settings-mcp-tab.test.tsx` pass; `verify:quick` exit 0; `npm run e2e:remote -- permissions-session permissions-activity permissions-activity-empty permissions-upgrade conduit-mcp-install-banner` green. Every task leaves `tsc` green (order matters).
**Parallel groups:** Serial: T2.1, T2.2, T2.3, T2.4, T2.5, T2.6
**Claims (serial lane):** `webview/app.tsx`, `webview/styles.css`, `webview/components/settings-page.tsx`, `webview/conduit-mcp-strings.ts`

#### Task 2.1: Move the Roles logic
**Files:** Create (git mv content): `webview/components/permissions-roles.tsx` from `permissions-settings.tsx` lines 17-481 (`Editing`, `Review`, `Deletion`, `Profiles`). Test: `test/unit/permissions-settings-profiles.test.tsx`, `permissions-profile-delete.test.tsx` mount `<PermissionsRoles serverConnected mcp sessions registerBack={() => {}} />` (same assertions). `permissions-settings.tsx` stays for now, rendering `<PermissionsRoles …/>` in its Profiles panel, so the tree builds.
**Interfaces:** Produces `PermissionsRoles` (Contracts); `BackHandler` is declared in T2.2, so here `registerBack` is typed `(handler: (() => boolean) | null) => void` and re-typed in T2.2.
- [ ] Existing tests pointed at the new component FAIL (module missing); move; PASS.

#### Task 2.2: McpSection and Activity wrapper changes
**Files:** Create: `webview/components/mcp-section.tsx`. Modify: `webview/conduit-mcp-strings.ts` (`MCP_TAB_ORDER`, `McpTabId`, `MCP_STR.sections`), `webview/components/permissions-activity.tsx` (`ActivityScope`; `<section aria-label="Permissions Activity">`; keep the `h1`). Test: `test/unit/mcp-section.test.tsx`, `test/unit/permissions-activity.test.tsx` (`getByRole('region', { name: 'Permissions Activity' })`).
**Interfaces:** Produces `BackHandler`, `McpSection`, `McpSectionProps` (Contracts). Consumes `PermissionsRoles` (T2.1), existing `PermissionsAssignments`, `PermissionsGrants`, `PermissionsActivity`, `useConduitMcp()`.
**Steps:**
- [ ] Failing tests: 'renders five tabs in order and selects the given one' — `getAllByRole('tab').map(t => t.textContent)` equals `['Settings','Roles','Agents','Grants','Activity']`; 'ArrowRight/End/Home move the selected tab'; 'Activity panel passes the scope and remounts when it changes'; 'Grants gets a read-only policy when the server is disconnected'; 'registerBack is called with null on unmount'.
- [ ] Implement by moving the tablist code from `permissions-settings.tsx:481-548`; delete `permissions-settings.tsx` once nothing imports it.

#### Task 2.3: SettingsPage routes MCP to McpSection
**Files:** Modify: `webview/components/settings-page.tsx`: `SettingsTab` drops `'permissions'`; `TAB_LABELS` drops Permissions; `McpTab` loses "Open Permissions" (1044-1046) and `onOpenPermissions`; add props `initialMcpTab`, `initialAgentKey`, `navSeq`, `activityScope`, `activityMachines`, `onAddActivityException`, `onOpenActivity`; `tab === 'mcp'` renders `<McpSection settings={<McpTab …/>} registerBack={(h) => { nestedBack.current = h; }} …/>`; the `navSeq` effect re-applies the target; `.settings__pane` gets a `--mcp` modifier so panels scroll themselves.
**Steps:** failing `settings-mcp-tab.test.tsx`: 'nav labels are General, MCP, Links, Appearance, Shortcuts, Skills, About'; 'opening with initialMcpTab roles selects Roles'; 'changing navSeq re-applies the target without remounting' (a child's state survives); 'Esc steps back through a registered handler before closing' (handler returns true → `onClose` not called).

#### Task 2.4: app.tsx state, retarget, openActivity
**Files:** Modify: `webview/app.tsx` per the Contracts (state, `openSettingsAt`, the retarget table, `openActivity`, `activityMachines`, remove the center-pane Activity props and the `ACTIVITY_DOC_PATH` import/docs dispatch); `src/contracts/native-launch.ts:44`; `test/unit/missing-home-state.test.ts:172`.
**Call sites:** `ACTIVITY_DOC_PATH` import `app.tsx:195`; `center-pane` props at `app.tsx:5440-5458`.
**Steps:** failing `missing-home-state.test.ts` asserts the new copy; implement; `rg "'permissions'" webview/app.tsx` returns nothing.

#### Task 2.5: Delete the Activity doc kind
**Files:** Modify: `webview/components/center-pane.tsx` (delete 56-57, 101-103, 177-179, 427-441), `webview/docs.ts` (52, 123, 248, 308, 973), `webview/doc-groups.ts` (27). Delete: `test/unit/permissions-activity-doc.test.ts` (asserts the removed kind).
- [ ] Failing: `rg "permissions-activity'|ACTIVITY_DOC_PATH" webview src` returns nothing after the change; `tsc` green.

#### Task 2.6: e2e for tab names
**Files:** Test: `test/e2e/permissions-session.e2e.mjs` (137 `Profiles` tab → `Roles`; 165 heading `Profiles` → `Roles`; 176 `Assignments` → `Agents`; 186 button `Activity` → tab `Activity`, then `getByRole('region', { name: 'Permissions Activity' })`; drop the `settings.waitFor({ state: 'hidden' })`), `permissions-activity.e2e.mjs` (89-136), `permissions-activity-empty.e2e.mjs` (20-22: nav `MCP` then tab `Activity`), `permissions-upgrade.e2e.mjs`.
- [ ] Update, keep each assertion's strength, `verify:quick`, commit.

### Slice 3: Roles redraw (canvas D2–D4)
**Check:** `npx vitest run test/unit/permissions-role-summary.test.ts test/unit/permissions-role-list.test.tsx test/unit/permissions-role-drawer.test.tsx test/unit/permissions-settings-profiles.test.tsx test/unit/permissions-profile-delete.test.tsx` pass; `verify:quick` exit 0.
**Parallel groups:** Serial first: T3.0 · G1: T3.1, T3.2 · G2: T3.4 · Serial after: T3.3, T3.5
**Claims (serial lane):** `webview/styles.css`, `webview/conduit-mcp-strings.ts`

#### Task 3.0: Summary logic
**Files:** Create: `webview/components/permissions-role-summary.ts`. Test: `test/unit/permissions-role-summary.test.ts`.
**Interfaces:** Produces `GroupCounts`, `GroupState`, `groupCounts`, `groupText`, `groupState` (Contracts). Replaces `groupSummary` (`permissions-profiles.tsx:52`, its only consumer is that file). Consumes `Profile`, `ToolName`.
- [ ] Failing: `groupText({allow:3,ask:4,deny:1}) === '3 allow · 4 ask · 1 deny'`; `groupText({allow:5,ask:0,deny:0}) === '5 allow'`; `groupState({allow:0,ask:2,deny:0}) === 'mixed'`; `groupState({allow:5,ask:0,deny:0}) === 'allowed'`; `groupState({allow:0,ask:0,deny:6}) === 'denied'`; `groupCounts(observer, <Sessions tools>)` equals `{allow:1,ask:0,deny:7}`.

#### Task 3.1: Role list
**Files:** Create: `webview/components/permissions-role-list.tsx`. Test: `test/unit/permissions-role-list.test.tsx`.
**Interfaces:** Produces `PermissionsRoleListProps`, `PermissionsRoleList`. Consumes T3.0's functions, `TOOL_GROUPS` (`src/conduit-mcp/tool-policy.ts:49`), `MCP_STR.tools.group[group]`, `BUILT_IN_PROFILES`, `plural` (`src/plural.ts`).
- [ ] Failing: one row per profile; Worker row shows "New agents start here" when `newAgentRole === 'worker'`; 5 group pills each with text Allowed/Mixed/Denied; `Used by ${plural(n, 'agent')}`; `aria-selected` on the selected row; "Built-in" and "Custom" badges; clicking a row calls `onSelect`.

#### Task 3.2: Role drawer
**Files:** Create: `webview/components/permissions-role-drawer.tsx`; Test: `permissions-role-drawer.test.tsx`.
- [ ] Failing: built-in shows "Built-in roles can't be edited. Duplicate it to make your own." and only a "Duplicate role" button; custom shows Edit, Duplicate, Delete; each group is a disclosure whose tool rows show Allow/Ask/Deny as words; the heading takes focus on mount; the drawer never calls `useOverlayEntry` (`rg useOverlayEntry permissions-role-drawer.tsx` is empty).

#### Task 3.3: Compose Roles
**Files:** Modify: `permissions-roles.tsx` (list branch → `PermissionsRoleList` + `PermissionsRoleDrawer`; the editor renders inside the drawer container; review and deletion pages keep replacing the panel; registers the back handler with the order in Contracts). Delete: `permissions-profiles.tsx`. Test: update the two profile tests (`Copy Worker` → open the Worker drawer → "Duplicate role"; `Edit Custom` → drawer Edit); add 'the registered back handler steps review → editor → drawer → closed and then returns false'.
**Call sites:** `permissions-profiles.tsx` importers: `rg "permissions-profiles'" webview test`. `usage` = for each profile id, the count of `policy.assignments` entries whose `assignment.profileId` equals it (`policy.assignments: Array<{ point; assignment }>`, `src/conduit-mcp/policy-types.ts:49-62`); `newAgentRole` = `policy.assignments.find((e) => e.point.kind === 'default')?.assignment.profileId ?? 'worker'`.

#### Task 3.4: Editor redraw
**Files:** Modify: `permissions-profile-editor.tsx` (groups as `<details>` with the group label, `groupText`, pill; Sessions open by default; per-tool "More options" disclosure holding Reach/Move/Screen condition). Test: `test/unit/permissions-settings-profiles.test.tsx` (no editor-specific test file exists).
- [ ] Failing: `[aria-label="open_session decision"]` still present (Sessions open); Messaging rows absent until the group opens; More options reveals the Reach select.

#### Task 3.5: Styles and copy
**Files:** Modify: `styles.css` (`.permissions-role*`, `.permissions-pill[data-state]`, `.permissions-drawer`; delete `.permissions-profiles*` 17328-17427 and the dead `.permissions-settings__tabs` 17516-17529), `conduit-mcp-strings.ts` (`MCP_STR.sections` Roles copy).
- [ ] Below a 1100 px viewport the drawer is `position: absolute; right: 0; top: 0; bottom: 0` over the list; no slide animation; `verify:quick`; commit.

### Slice 4: Agents redraw (canvas D5)
**Check:** `npx vitest run test/unit/permissions-agents-list.test.tsx test/unit/permissions-assignments.test.tsx test/unit/permissions-assignments-preview.test.tsx` pass; `verify:quick` exit 0; `npm run e2e:remote -- permissions-session permissions-activity` green.
**Parallel groups:** Serial: T4.1, T4.2, T4.3, T4.4
**Claims (serial lane):** `webview/styles.css`, `webview/conduit-mcp-strings.ts`

#### Task 4.1: Agents list
**Files:** Create: `permissions-agents-list.tsx`. Test: `permissions-agents-list.test.tsx`.
- [ ] Failing: empty `rows` shows "No agents yet. New agents start with <role>." (copy in `MCP_STR.sections`); one row per `AgentRow` with a `select` labelled `Role for <title>` and options from `profiles`; `changes > 0` shows `plural(changes, 'change')`, 0 shows "Follows role"; changing the select calls `onRoleChange(row, id)` and applies nothing; "New agents start with" select calls `onNewAgentRole`; a collapsed "Defaults by agent type" region.

#### Task 4.2: Restructure PermissionsAssignments
**Files:** Modify: `permissions-assignments.tsx`: build `AgentRow[]` from the existing `points: AssignmentPoint[]` (`:234-245`); render `PermissionsAgentsList` always; the existing `editing` and `review` views render inside the local agent drawer instead of replacing the whole component; delete the "Assignment point" select and the second table; keep `PermissionsCheckRequest` and `ReplayPreview` inside the drawer; heading "Who gets which profile" → "Agents"; props `focusAgentKey`, `registerBack` (Contracts).
**Interfaces:** Rows: `key = pointKey(point)` (from `src/conduit-mcp/policy-profiles`), `title` = the session's `name` for `kind: 'session'` and `label(point)` otherwise, `subtitle` = `point.sessionId` for sessions and `label(point)` otherwise, `profile = profileFor(policy, assignmentAt(policy, point) ?? inheritedAt(policy, point))`, `changes = assignmentAt(policy, point)?.exceptions.length ?? 0`. Delete the now-unused `exceptionCount` (84-87).
**Call sites:** `start(point)` at 396-399 gains `start(point, profileId?)`.
- [ ] Failing (adapted existing tests plus): selecting a row opens the drawer; edit → review → apply path unchanged (`mcp.setAssignment` called with the same arguments); mounting with `focusAgentKey` opens that agent's drawer; the registered back handler steps review → edit → drawer view → closed → false.

#### Task 4.3: Role dropdown staging
**Files:** Modify: `permissions-assignments.tsx`.
- [ ] Failing: 'changing a row's role opens the drawer in edit with that role staged and applies nothing until Review → Apply' — `setAssignment` not called after `onRoleChange`; called once after Apply.

#### Task 4.4: Changes in the drawer
**Files:** Modify: `permissions-assignments.tsx` (local drawer), `styles.css` (`.permissions-agents*`).
- [ ] Failing: view mode lists each exception as `<tool>: role says <Decision> → this agent: <Decision>` (role decision from `profile.rules[tool].decision`); "Edit changes" enters the existing exceptions editor; "Reset all to role" stages an edit with no exceptions and goes to Review.

### Slice 5: Copy sweep, CHANGELOG, guards
**Check:** `rg -n -i "profile" webview/components/permissions-*.tsx webview/components/mcp-section.tsx webview/conduit-mcp-strings.ts` (the `MCP_STR.sections` block) shows only identifiers/types, never user-visible text; `verify:quick` exit 0.
**Parallel groups:** Serial: T5.1, T5.2
**Claims (serial lane):** `CHANGELOG.md`, `webview/conduit-mcp-strings.ts`

#### Task 5.1: Copy
**Files:** Modify: user-visible strings only ("Review profile changes" → "Review role changes", "Could not save profile" → "Could not save role", "Delete profile" → "Delete role", "No profile" → "No role") in `permissions-roles.tsx`, `permissions-profile-editor.tsx`, `permissions-assignments.tsx`, `permissions-session-dialog.tsx`, `session-permission-exceptions.tsx`, `conduit-mcp-strings.ts`; update the unit tests that assert them.
#### Task 5.2: CHANGELOG
**Files:** Modify: `CHANGELOG.md` `[Unreleased]` › `### Changed`: "Settings is now a full-screen page with a Back button." · "MCP and Permissions are one section, MCP, with Settings, Roles, Agents, Grants and Activity tabs." · "Roles show what each allows at a glance and open in a side panel; built-in roles can be duplicated." · "Agents list shows each agent's role and how many changes it has." · "Permissions Activity now lives in MCP › Activity instead of an editor tab."

### Slice 6: Verify and report
**Check:** full gate exit 0; remote `--full` clean; `report.md` written.
**Parallel groups:** Serial: T6.1, T6.2, T6.3
**Claims (serial lane):** none beyond the above

#### Task 6.1: Full gate
`flock /tmp/claude-1000/conduit-gate.lock npm run verify; echo "exit=$?"` (once, after the last code commit); `git diff --stat main -- src/conduit-mcp` empty; `git diff --name-only main` contains none of the CON-60 files.
#### Task 6.2: Remote e2e
`npm run e2e:remote -- --full` on the final SHA; any failure or retry-pass is fixed, never quarantined; rerun until clean.
#### Task 6.3: Visual comparison and report
Headless only: render each screen (D1–D7) with the renderer in a headless Chromium using a stubbed `window.agentDeck` with the policy fixtures from the unit tests, and compare with the canvas boards; record what could not be reproduced as NOT_COVERED. Write `docs/runs/2026-11-18-CON-57/report.md` and send `REPORT CON-57 <path>` to claude-3; queue the owner decisions.

## Verification
Per task: the named vitest files, `npx biome check <touched files>`, `npx tsc -p tsconfig.webview.json --noEmit` (no lock). Per slice: `flock … npm run verify:quick` and the slice's e2e (`npm run e2e:remote -- <names>` in the background, never under the lock). Final: one full `verify` under the lock, `e2e:remote --full`, the two `git diff` checks. Exit codes captured directly.

## Deviation rule
If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a shim, second copy, special case, widened type, fallback, or an override patched in place of its semantic source. Report leads with the fix that keeps the locked decision.

## Decisions Needed
- [high] Existing `.settings__*` class names are kept so ~20 e2e files only change at the container and close button. Default taken: as stated.
- [normal] The page covers the in-flow banners above the workbench while open (§ Settled decisions). Default: by design.
- [high] Visual comparison uses a stubbed bridge in headless Chromium; policy-heavy screens may not reproduce. Default: record NOT_COVERED, do not launch Electron unless it can be guaranteed hidden.
- [normal] Per-change Reset and the inline "Add a change" form (canvas D5) are deferred; the drawer shows changes read-only with "Edit changes" and "Reset all to role".
- [normal] Review and delete pages stay full-panel (not in the drawer).
- [normal] `permissions-activity-doc.test.ts` is deleted with the doc kind it tested.
- [normal] A repeated `openSettingsAt` while open re-applies the target (`navSeq`) without remounting; if it changes the MCP tab, the previous tab's staged edits are dropped, as a manual tab switch does today.

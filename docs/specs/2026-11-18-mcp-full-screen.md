---
status: building (CON-57) — decisions queued in §13
date: 2026-11-18
ticket: CON-57 (permissions UX redesign)
---

# Feature Spec: MCP as one full-screen Settings section

**Tier:** FULL   **Feature type:** UI (re-homing and redrawing existing screens; no policy-model change)
**One-line request:** "I like the full-screen settings… implement the full screen page iteration." — owner,
2026-11-18, after approving the canvas page "MCP · full-screen settings"
(https://claude.ai/artifact/Uxi8ZiJTXqXt6GEcttbz6J, boards D1–D7, E1–E4). Run ledger:
`docs/runs/2026-11-18-CON-57/goal.md`.

## 1. Problem frame
- **Job:** change what agents may do (roles, per-agent changes, grants) and see what happened (Activity)
  without a cramped modal, and without MCP and Permissions being two places for one topic.
- **Actors:** the owner (one human, local). Agents are the subject, not users of this UI.
- **Success outcomes:**
  - Settings fills the window below the title bar and has a Back button; every existing Settings entry
    point still lands on the right screen.
  - One section, **MCP**, holds Settings | Roles | Agents | Grants | Activity.
  - Roles and Agents are readable without horizontal scrolling at 1440×900 and at 1024 wide.
  - No permission behaviour changes: nothing under `src/conduit-mcp/` changes and the existing persistence unit tests pass unmodified.
- **Non-goals:** any change under `src/conduit-mcp/` (policy model, persistence, native modes); renaming
  code identifiers (`Profile`, `ProfileId`, `PermissionsProfiles`, CSS `.permissions-profiles*`) — copy only;
  the update card, toasts and What's new (CON-60's lane); other Settings sections' content (General, Links,
  Appearance, Shortcuts, Skills, About) beyond the new container.

## 2. Behavior & states
**Primary flow.** Footer Settings button (or Mod+,) → full-screen Settings on General. Nav: General, MCP,
Links, Appearance, Shortcuts, Skills, About. MCP shows five tabs. Back (or Esc) returns to exactly the
view the user left; terminals and scrollback are untouched.

**Tabs (what each is).**
| Tab | Content | Source today |
|---|---|---|
| Settings | Messaging switch, Agent CLI install rows, Tools group | `McpTab` (the "Open Permissions" button is removed) |
| Roles | Role list with per-group summary pills; row opens a drawer (built-in: read-only + Duplicate role; custom: Edit, Duplicate, Delete); role editor with groups collapsed, Allow/Ask/Deny per tool, Reach/Move/Screen condition under "More options" | `PermissionsProfiles`, `PermissionsProfileEditor`, review + delete flows in `permissions-settings.tsx` |
| Agents | "New agents start with [role]", "Defaults by agent type", one row per agent (role dropdown, "N changes" chip), drawer with role, changes (each Reset), Add a change, active grants; "Check a request" and seven-day replay stay reachable | `PermissionsAssignments` + exceptions + check-request |
| Grants | grant list, Extend/Renew/Revoke/Undo | `PermissionsGrants` |
| Activity | filters, table, Why panel | `PermissionsActivity` (today a center-pane document) |

**State transitions.** `closed → open(section, tab, ?agent)`; Esc steps back one level in this order:
open drawer/editor → About release notes (existing) → close Settings. A shortcut recording keeps its own Esc.
Role/Agent edits keep today's staged flow: edit → Review (before/after) → Apply; nothing applies on a
dropdown change alone.

**Current behavior (measured by grep of the worktree and by test names; behaviour claims not run).**
| Claim | How measured | Measured / ASSUMED |
|---|---|---|
| Settings renders inside `ModalLayer`; `.settings` is 830px wide, 1060px high | `rg ModalLayer webview/components/settings-modal.tsx` (51, 166, 256); `rg "^\.settings \{" webview/styles.css` (8099-8104) | measured (grep); Esc/backdrop behavior ASSUMED |
| Nav order today: General, MCP, Permissions, Links, Appearance, Shortcuts, Skills, About (`TAB_LABELS`, inside the component) | `settings-modal.tsx:143-152`. The new nav drops Permissions | measured (grep) |
| `permissions-activity` docs are never persisted or restored | `webview/docs.ts:973` (excluded when persisting); `src/persistence.ts:171-175` (`isRestorableDoc` accepts only `file` and `diff`) | measured (grep) |
| Activity is not in Settings; it is a center-pane doc `permissions-activity` opened by `openActivity` | `rg "permissions-activity" webview` | measured (grep); behavior ASSUMED |
| ~30 unit/e2e files reference `.settings`, `.modal.settings`, `.settings__navitem`, tab names | Explore map 2026-11-18 (file:line list in the build plan) | measured (grep) |
| Baseline `npm run typecheck` is clean on ce1d7e87 | run in worktree 2026-11-18 | measured |

## 3. Data / interface contract
- **No new persisted data, no new IPC, no change to `useConduitMcp()` shapes.** The Settings target (section, MCP tab, focused agent, exception seed, activity scope) is in-memory renderer state only.
- Producers/consumers (all UI-side; the policy store itself is untouched):
| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `settingsOpen`, `settingsTab` (+ new MCP sub-tab, focused agent, activity scope, exception seed) | every `openSettingsAt` caller in `app.tsx` (palette, row menu, upgrade dialog, native notice, activity add-exception, release notes, footer, messages) | the new full-screen Settings | yes — all callers retargeted |
| Activity scope (`sessionId`, `machineId`, a row) / "Why" row | RefusalChip (`openRefusal`), session dialog and its recent-activity link, Links tab, palette `cmd:activity`, `onOpenPermissionActivity(machineId)` | Activity tab | yes — `onOpenPermissionActivity` no longer closes Settings; it switches to MCP › Activity with the machine scope |
| `settingsOpen` gates | `app.tsx:609` | `isAnyModalOpen` (4627, swallows nav keys), upgrade-dialog gate (5758) | yes — Settings keeps counting as an open overlay |
| Agent role + changes | policy store (unchanged) via `PermissionsAssignments` logic | Agents tab list + drawer | store: no (unchanged, read/write API stays identical); UI: yes |
| `permissions-activity` center-pane doc kind | `openActivity` | `center-pane.tsx` | yes — removed together (see §13-4) |
- **Invariant:** the workspace (terminals, editors) stays mounted while Settings is open.

## 4. Edge cases & failure modes
| Condition | Expected |
|---|---|
| Open Settings while a terminal has focus; close | Focus returns to the control that opened it, or the terminal if that is gone |
| Policy not loaded / server disconnected | Roles/Agents/Grants/Activity show today's disconnected/"could not load" copy; Settings tab and other sections still work |
| Zero agents | Agents tab shows the empty state (first-run copy + "New agents start with" control) |
| Role in use is deleted | Today's replacement-picker flow, unchanged |
| Deep link to a tab that does not exist | Falls back to MCP › Settings |
| Narrow window (≤1024) | Drawer overlays the list instead of splitting; list columns drop in order Summary pills → Type; "Used by N" stays |
| Release-notes page open, then Back | Steps back to About first (existing), then closes |
| Settings open and a request or toast arrives | It still shows above Settings (ASSUMED layering; checked in the screenshot pass); CON-60's toast code is not touched |
| Keyboard focus while Settings is open | The workspace behind is `inert`: not tabbable, not clickable; terminals keep running |
| Double-click Apply | Existing disabled-while-saving behavior |

## 5. Defaults vs. settings
| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Section opened by Mod+, | General | no | unchanged |
| MCP tab opened from the session dialog's "Open Settings Permissions" | Agents with that agent open | no | the agent's settings are the intent |
| Upgrade dialog "Review in Settings" | MCP › Agents | no | converted settings are assignments |
| Layout split vs overlay for drawer | split ≥1100 px, overlay below | no | list must stay readable |
| Roles list "Agents" count | assignments (default, per-CLI, per-session) using the role | no | cheap to derive; labelled "Used by N" |

## 6. Scope slicing
- **MVP (this run):** full-screen container + Back; nav without Permissions; MCP with the five tabs; Settings,
  Grants, Activity re-homed; Roles and Agents redrawn per D2–D5 (list, drawer, editor, changes) using
  existing handlers; every entry point retargeted; copy "profile" → "role"; unit + e2e updated.
- **v1 (next, separate decision):** sidebar row-menu Permissions submenu (E1), Customize drawer from the
  workspace (E2), refusal chip fix flow (E4).
- **Blocked on owner:** approval-card Allow ▾ menu (E3) — §13-2.
- **Out of scope:** "Reset to <built-in>"; model changes; own-machine/peer permission UI redesign (it moves
  with its parent component unchanged); renaming identifiers.

## 7. Acceptance criteria
**Declarative.**
- Settings opens full-screen, below the title bar, with a Back button; the workspace is still there on return.
- MCP › Roles/Agents/Grants/Activity show the same data and the same actions as Profiles/Assignments/Grants and
  the Activity page, plus the redrawn list/drawer layout.
- Each of the 14 entry points in §9 lands on the screen it did before (or its mapped new tab).
- `npm run verify` and `npm run e2e:remote -- --full` pass with 0 failures, 0 retry-passes; every pre-existing
  assertion keeps its strength.

**EARS.**
- When the user activates Back or presses Esc with nothing nested open, Settings shall close and focus shall
  return to the opener.
- While a drawer or editor is open, Esc shall close it before Settings.
- When a caller opens Settings with a target (section, tab, agent, seed), Settings shall show that target
  without an intermediate screen.
- Where the window is ≤1024 px wide, the drawer shall overlay the list.
- When the user changes an agent's role, Settings shall stage the change and require Review before it applies.

**Gherkin.**
```gherkin
Feature: MCP full-screen Settings
  Scenario: Refusal opens Activity at the right row
    Given an agent request was refused
    When the user clicks the "refused" chip
    Then Settings opens on MCP › Activity with that row's Why panel showing
  Scenario: Change an agent's role
    Given Settings is on MCP › Agents
    When the user picks "Lead" for an agent and chooses Review then Apply
    Then the agent's role is Lead and Activity can explain a later decision with that role
  Scenario: Back keeps the workspace
    Given a terminal has scrollback and Settings is open
    When the user presses Back
    Then the same terminal with the same scrollback is visible
```

## 8. State catalog (UI)
| Component | State | What the user sees | Action |
|---|---|---|---|
| Settings page | ideal | nav + section | Back |
| MCP tabs | policy loading | tab list renders; panel shows a skeleton row | none |
| Roles | empty custom list | the 3 built-ins only; "New role" | New role |
| Roles drawer | built-in | read-only groups + note "Built-in roles can't be edited" | Duplicate role |
| Roles drawer | custom | groups; Edit, Duplicate, Delete | as labelled |
| Role editor | saving / failed | disabled Save + inline error "Could not save role" + Retry | Retry |
| Agents | zero agents | explanatory text + "New agents start with" | none |
| Agents drawer | no changes | "Follows role" | Add a change |
| Agents drawer | N changes | N rows, each with Reset; "Reset all to role" | Reset |
| Grants | empty | "No grants yet." (existing) | none |
| Activity | empty / filtered empty | existing empty copies | Refresh |
| Any tab | server disconnected | existing banner/copy | none |
| Any tab | permission-denied (remote policy) | existing remote-policy notice | none |

## 9. Interaction inventory (UI)
| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Back | leave Settings | click | Enter/Space, Esc | – | button "Back to Conduit" |
| Section nav | choose section | click | Up/Down, Tab | – | `nav` + `aria-current="page"` |
| MCP tabs | choose tab | click | Left/Right/Home/End (existing) | – | `tablist`/`tab`/`tabpanel` (existing pattern) |
| Roles row | open drawer | click | Enter | row ⋯ menu: Edit/Duplicate/Delete | `row`, `aria-selected` |
| Drawer | close | ✕ | Esc | – | `complementary`, labelled by role/agent name |
| Role dropdown (Agents) | stage role | click | Arrow keys | – | native `select`, labelled "Role for <agent>" |
| Add a change | tool/decision/where | click | Tab | – | form controls with labels |
**Settings entry points (measured by `rg "openSettingsAt\(|setSettingsOpen\(" webview`: 16 call sites).** All keep working:
shortcut `openSettings` (Mod+,); palette `set:general|appearance|shortcuts|skills|mcp`; `setupMcp` (session menu);
`onOpenMcpSettings`; footer/messages `onOpenSettings('general'|'mcp')`; Activity add-exception (sets the exception seed);
upgrade dialog `onReview`; release notes; native-impact notice; session dialog `onOpenSettings`. Entries that go the
other way and no longer close Settings: Add machine and open-request (they close Settings and act, as today);
`onOpenPermissionActivity(machineId)` (now a tab switch, see §3). RefusalChip, the Links tab Activity link, the
session dialog's recent-activity link and palette `cmd:activity` call `openActivity` today (never Settings); they
now open MCP › Activity. The row menu "Permissions…" opens the session dialog and is unchanged until v1.

**Old tab id → new target.**
| Old | New |
|---|---|
| `general`, `appearance`, `shortcuts`, `skills`, `links`, `about` | same |
| `mcp` | MCP › Settings |
| `permissions` (plain) | MCP › Roles |
| `permissions` with exception seed, or from the session dialog / native-impact notice | MCP › Agents (agent focused when known) |
| `permissions` from the upgrade dialog | MCP › Agents (§5) |
| Activity (any scope) | MCP › Activity with that scope |

## 10. Accessibility & i18n (UI)
- Everything reachable by keyboard; focus visible (existing tokens); on open focus goes to the Back button,
  on close to the opener; drawer open moves focus to its heading, close returns it to the row.
- Icon-only controls (✕, row ⋯) carry `aria-label`. Pills carry text (Allowed/Mixed/Denied), never colour only.
- Apply/Reset/Delete outcomes announce through the existing polite live region.
- Settings is a labelled landmark (`role="region"`, `aria-label="Settings"`); not `aria-modal` (it is a page). It sits below the title bar, so it never overlaps `.topbar` or its drag region.
- Reduced motion: no drawer slide animation under `prefers-reduced-motion`.
- Strings stay in `MCP_STR`/`CHROME_STR`-style constants, not inline literals in new JSX; counts use the
  existing plural helper ("N agents", "N changes"). Layout tolerates +30% text. RTL: app is LTR-only today (no change).
- Contrast ≥ 4.5:1 for pill text in all three themes (checked in the screenshot pass).

## 11. Design tokens (UI)
- Reuse existing semantic tokens for surface, border, accent, dim text, and decision colours; add none unless a
  pill needs a role missing today (then add `--pill-allow/--pill-mixed/--pill-deny` aliases, per theme).
- Verify light, dark and Neon variants; the canvas shows dark only (ASSUMED equivalent mapping).

## 12. Assumptions
- Canvas D1–D7 are the visual contract; sample names/counts/Why wording are placeholders.
- Roles = copy of "profile"; identifiers unchanged.
- The Agents tab keeps Default / per-CLI / per-session / machine assignments, shown as above, under one list.
- Own-machine permission UI keeps rendering inside whichever parent it has today, moved with it.
- The session "Permissions…" dialog stays until v1; its "Open Settings Permissions" button targets MCP › Agents.

## 13. Decisions Needed
1. [normal] Scope split: this run = D1–D7; E1/E2/E4 next. Default taken: as §6.
2. [normal] Approval card "For this agent, always": default: not built until the owner decides (E3 blocked).
3. [normal] "Reset to <built-in>" needs the app to remember a custom role's source. Default: omitted from the UI.
4. [high] Activity leaves the center pane for the MCP › Activity tab; the `permissions-activity` doc kind is removed
   (it is never persisted, so no migration). User-visible: Activity no longer opens as an editor tab. Default: remove.
5. [normal] Upgrade "Review in Settings" → MCP › Agents (default).
6. [high] ~30 test files change selectors; e2e runs only via `e2e:remote --full`. Default: update selectors, keep every
   assertion, rebase if main moves; on any retry-pass fix it, never quarantine.
7. [normal] Narrow-window behavior and the ≥1100 px split threshold (§4, §5) are design assumptions.
8. [normal] Pills' colour tokens in light/Neon themes are assumed from the dark canvas (§11).

## 14. Open questions
(none — autonomous mode; see §13)

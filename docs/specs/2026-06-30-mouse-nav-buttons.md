---
status: active
date: 2026-06-30
---

# Feature Spec: VS Code-style mouse buttons (middle-click close, back/forward navigation)

**Tier:** FULL   **Feature type:** UI
**One-line request:** "Mouse middle click, back, and forward click functionalities should be wired to act exactly like VS Code across the app."

> Triage reason: multi-surface (editor tabs, explorer, a brand-new app-wide
> navigation-history model, keyboard parity bindings, and a global mouse-input layer),
> user-facing, and introduces net-new state. Not LITE — the back/forward model is novel
> in this codebase (no navigation history exists today). UI feature → sections 8–11 apply
> even though the change adds almost no new visible chrome.

---

## 1. Problem frame

- **Job:** When a Conduit user reaches for the mouse habits they have from VS Code —
  middle-click a tab to close it, press the thumb buttons to jump back/forward through
  where they were — those gestures should "just work" so navigation stays in the mouse
  and out of menus/shortcuts.
- **Actors / roles:** Single local user driving the desktop app with a multi-button
  mouse (standard 3-button + the two side/thumb buttons, X1 = back, X2 = forward). Also
  trackpad users (no thumb buttons) who rely on the keyboard equivalents.
- **Success outcomes (observable):**
  - Middle-clicking an editor tab closes it (honoring the unsaved-changes prompt), exactly
    like the close button.
  - Pressing the mouse Back button returns the workbench to the previously-active
    location (tab or Terminal, in whatever session it lived in); Forward re-advances. The
    behavior matches VS Code's Go Back / Go Forward closely enough that muscle memory
    transfers.
  - Keyboard parity (Alt+Left / Alt+Right) drives the same navigation for trackpad users.
- **Non-goals (explicitly out of scope):**
  - Cursor-/selection-location history *within* a file (VS Code's true Go-Back granularity
    — landing on the exact line you left). v1 is tab/Terminal-activation granularity; see
    Decision D1.
  - Middle-click "open link in new tab" semantics inside the Monaco editor or terminal
    output links.
  - Forward/back gestures inside the in-app `<webview>` browser tab — the guest already
    owns its own history and its own Back/Forward chrome; thumb buttons over the guest
    drive the guest, not the workbench (see §4 / Decision D8).
  - Mouse horizontal-swipe / `app-command` OS gestures (trackpad two-finger swipe nav) —
    Decision D4 keeps handling in the renderer; OS swipe is a flagged later option.
  - Rebindable mouse buttons / a mouse-button settings UI. The mouse bindings are fixed;
    only their keyboard equivalents are rebindable (they ride the existing shortcut
    registry).

---

## 2. Behavior & states

### 2.1 Middle-click (mouse button 1 / `auxclick` `button === 1`)

| Target | Behavior |
|---|---|
| An editor/doc tab (file, diff, review, git-history, commit-diff, web) | Close that tab — same path as the close (×) button: routes through `closeDoc`, so a dirty file raises the unsaved-changes confirm dialog before closing. |
| The Terminal tab | No-op in v1 (the Terminal tab represents the live session, is not closeable via the × button or Mod+W, and middle-click must not become a hidden "kill session"). See Decision D7. |
| Explorer file row | Open the file as a **permanent** (non-preview) tab — identical to double-click / Enter (`onOpenFile(path, 'permanent')`). See Decision D3. |
| Explorer folder row | No-op (VS Code has no middle-click folder action). |
| Anything else (terminal links, change rows, sidebar, buttons) | No-op in v1 (Decision D3 keeps scope to tabs + explorer files). |

Primary flow (close a tab): user middle-clicks anywhere on the tab body → if clean, the
tab closes and the active tab repoints to a sibling (existing `close` reducer behavior);
if dirty, the confirm dialog appears and closing waits on the user's choice.

### 2.2 Back / Forward (mouse X1 = `button === 3`, X2 = `button === 4`; keyboard Alt+Left / Alt+Right)

A **navigation location** is an entry `{ sessionId, docId: string | null }` (docId `null`
= that session's Terminal). The app keeps a single **global navigation history**: a bounded
ordered list of locations plus a `cursor` index pointing at the current one.

States / transitions:

- **Recording (normal navigation):** whenever the user lands on a location through any
  means *other than* a back/forward traversal — activating a tab, switching sessions,
  opening a file, Ctrl+Tab, clicking the Terminal tab — the new location is committed:
  everything after `cursor` is discarded, the new location is pushed, and `cursor` moves to
  the end. Consecutive duplicates are coalesced (re-activating the already-current location
  does not grow the stack).
- **Back:** if `cursor > 0`, move `cursor` to the previous *still-valid* entry and apply it
  (switch active session if the entry's session differs, then activate its doc/Terminal).
  No-op at the start of the stack.
- **Forward:** symmetric; move toward the end. No-op at the tip.
- **Applying a location** is itself a traversal, so it must NOT record a new entry (else
  back/forward would corrupt the stack).
- **Invalidation (single authoritative model = eager prune).** Closing a doc dispatches
  `pruneDoc(docId)`; closing a session dispatches `pruneSession(sessionId)`. Each removes
  **all** matching entries (a doc can appear non-consecutively, e.g. A,B,A) and reconciles
  `cursor` by the rules in §3.1. After pruning, every remaining entry resolves, so
  traversal needs no "skip dead" path — a resolve-guard during apply is kept only as
  defensive belt-and-suspenders, not as a second mechanism. (This supersedes any earlier
  "skip" phrasing: prune is the model; skip is a safety net.)
- **Closing the active tab** combines both: `pruneDoc` removes its entries, and the
  sibling/Terminal that auto-activates is a real new location, so it is **recorded**
  normally (a `record` after the prune). So Back after closing-and-repointing behaves
  like any other navigation.

Happy path: user opens A, then B, then C (stack `[A,B,C]`, cursor=2) → Back → C→B (cursor=1)
→ Back → B→A (cursor=0) → Forward → A→B (cursor=1) → opens D → stack becomes `[A,B,D]`,
cursor=2 (the forward C branch is discarded, matching browser/VS Code semantics).

---

## 3. Data / interface contract

The navigation model lives entirely in the renderer alongside the existing `docsReducer`,
because all tab state is renderer-side and the host has no concept of tabs. The only host
touchpoint is a thin **`app-command` forward** (Windows thumb-button fallback, D4): the main
process emits a `nav:back`/`nav:forward` IPC signal to the focused window on the BrowserWindow
`app-command` event; the renderer treats it identically to a DOM X1/X2 press (de-duped).

New module (proposed) `webview/nav-history.ts`, a reducer mirroring `webview/docs.ts`:

```ts
interface NavLocation { sessionId: string; docId: string | null }
interface NavState { stack: NavLocation[]; cursor: number } // cursor = index of current
type NavAction =
  | { type: 'record'; loc: NavLocation }                 // normal navigation
  | { type: 'back' }                                      // returns the resolved loc (or none)
  | { type: 'forward' }
  | { type: 'pruneDoc'; docId: string }                  // a tab closed
  | { type: 'pruneSession'; sessionId: string }          // a session closed
```

- **Inputs (trust boundary):** mouse `button` codes (3/4 back/forward, 1 middle) from DOM
  events; all local, untrusted only in the sense of needing target classification.
- **Outputs:** the resolved `NavLocation` to apply (drives `setActiveId` +
  `dispatchDocs({type:'activate'})`), or nothing when a traversal is a no-op.
- **Invariants:**
  - `0 <= cursor < stack.length` whenever `stack.length > 0`; `cursor === -1`/empty when no
    history yet.
  - Applying a traversal never mutates the stack except moving `cursor`.
  - The current location (`stack[cursor]`) always equals the live active (sessionId,
    activeId) after any committed navigation.
  - Stack is bounded (cap, default 50 — Decision D6); overflow drops oldest, adjusting
    `cursor` down by the number dropped.
  - Pruned entries never leave `cursor` dangling.
- **Scope = per renderer window.** Each Conduit window owns its own `NavState`; history is
  NOT shared across windows (matches each window having its own tab set / active session).
  "Global" in this spec means "across sessions *within a window*," not across windows.

### 3.1 Cursor reconciliation on prune

When `pruneDoc`/`pruneSession` removes a set of entries, recompute `cursor` so it still
points at the user's current location:

- **Entries removed *before* `cursor`:** `cursor -= (count removed strictly before it)`.
- **Entries removed *after* `cursor`:** no change.
- **The current entry (`stack[cursor]`) is itself removed** (the open doc/session the user
  was sitting on got closed): this only happens via the "closing the active tab" path,
  which immediately `record`s the auto-activated sibling/Terminal. Order is **prune then
  record**: after prune, clamp `cursor` to `[0, stack.length-1]` (or `-1` if empty), then
  the `record` pushes the new live location at the tip and sets `cursor` there. A
  background-tab close never removes `stack[cursor]`, so no re-activation occurs.
- Consecutive duplicates created by removing an entry between two identical neighbors
  (…A,B,A… → remove B → …A,A…) are coalesced during prune to keep the no-adjacent-dupes
  invariant.

Integration points (existing code):
- Record on every place that today does `dispatchDocs({type:'activate'})` /
  `{type:'switchSession'}` / `setActiveId` for a *user* navigation (`app.tsx` `onSelectDoc`,
  Ctrl+Tab / Ctrl+\` / Ctrl+1-9 block ~591-617, `openFile`, session selection in
  `sidebar`). Centralize via a single `navigateTo(sessionId, docId)` helper so recording
  isn't sprinkled/missed.
- Middle-click close reuses `closeDoc` (`app.tsx:910`) unchanged.
- Explorer permanent-open reuses `onOpenFile(path, 'permanent')` (already wired for
  double-click in `right-pane.tsx:1372`).

---

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Back pressed with empty / at-start stack | No-op (no error, no focus change). |
| Forward at tip of stack | No-op. |
| Back target's doc was closed since it was recorded | Skip dead entries; land on the nearest valid older location, or Terminal/no-op if none. |
| Back target's session was closed | Entry pruned on `pruneSession`; traversal skips it. |
| Middle-click a dirty file tab | Routes through `closeDoc` → unsaved-changes confirm; tab stays open until resolved (same as × button). |
| Rapid repeated Back/Forward (key-repeat or button mash) | Each event moves one step; idempotent at the ends. No async race (state is synchronous reducer). |
| X1/X2 pressed while focus is inside the in-app `<webview>` guest | Event is consumed by the guest (drives the guest's own history); the workbench stack is untouched. Acceptable & VS-Code-consistent (Decision D8). |
| X1/X2 / middle-click while a modal/palette/confirm dialog is open | Suppressed (do not navigate behind a modal); mouse handler bails when a modal is open, mirroring the keydown form-field guard. |
| Middle-click that is actually an autoscroll-anchor gesture | Fire *close* on `auxclick` (button 1), not `mousedown`, so a click (down+up on the same target) is the trigger. NOTE: whether `auxclick` self-cancels after a drag is an assumption to verify (§12 A6) — Chromium may still fire it after movement. If verification fails, gate on "no significant pointer movement between down and up." |
| Background (non-active) tab middle-clicked | The tab closes and its entries are pruned, but the active tab does NOT change (no `record`); only `pruneDoc` runs. |
| Thumb buttons arrive as OS app-commands, not DOM buttons (common on Windows) | Host (`electron/main.ts`) listens for the BrowserWindow `app-command` event (`browser-backward`/`browser-forward`) and forwards an IPC nav signal to the focused renderer as a fallback to DOM `button===3/4`. The renderer de-dups so a single physical press never double-navigates. See Decision D4. |
| Multiple windows open | Each window navigates its own history; a thumb press routes to the focused window only. |
| Browser-preview fallback (no `window.agentDeck`) | The middle-click and DOM-button paths are pure-renderer and still work; only the `app-command` host fallback is absent (no host), which the preview never needs. |
| Switching sessions via Back changes the active repo/terminal focus | Apply the same focus side-effects a manual switch does (e.g. terminal focus request), so a back-jump to a Terminal location focuses that terminal. |
| Coalescing: activating the already-active tab | No new entry; no duplicate. |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Middle-click closes tabs | On | No | Core VS Code parity; no reason to disable. |
| Middle-click explorer file → permanent open | On | No | Matches double-click; low-risk (D3). |
| Mouse Back/Forward → workbench nav history | On | No | The feature itself; fixed mouse bindings. |
| Keyboard parity combos | Alt+Left / Alt+Right (Win/Linux); macOS may default to Ctrl+- / Ctrl+Shift+- per VS Code (D5) | Yes (rebindable, ride `SHORTCUT_ACTIONS`) | Consistent with every other Conduit shortcut; trackpad users need them. Platform-default split is the open part of D5. |
| Navigation model granularity | Tab/Terminal-activation | No (v1) | Cursor-location history is the vision, not v1 (D1). |
| History scope | Single global stack across sessions | No | Most faithful to VS Code (Go Back crosses editor groups) (D2). |
| History depth cap | 50 entries | No (constant) | Bounded memory; matches VS Code's order of magnitude. |
| Visible Back/Forward buttons in chrome | None in v1 | — | Input-only; a visible affordance is a flagged v1 option (D8). |

---

## 6. Scope slicing

- **MVP (must):**
  - Middle-click an editor/doc tab → close (via `closeDoc`, dirty-prompt honored).
  - Mouse X1/X2 → global tab/Terminal-activation Back/Forward with a bounded history stack
    (new `nav-history.ts`), recorded at all user-navigation sites, pruned on close.
  - Alt+Left / Alt+Right keyboard parity (rebindable actions).
  - Handlers live in the renderer; suppressed over `<webview>` and behind modals.
- **v1 (should):**
  - Middle-click an explorer file → permanent open (D3).
  - Skip-dead-entry traversal robustness + session-switch focus side-effects.
- **Vision (could):**
  - Cursor-/selection-location history within editors (true VS Code Go-Back granularity),
    integrating Monaco's cursor stack (D1).
  - Optional visible Back/Forward buttons in the workbench chrome (D8).
  - OS-level horizontal-swipe / `app-command` navigation gestures (D4).
  - Middle-click terminal/Monaco links to open in a background tab.
- **Out of scope:** rebindable mouse buttons; per-file "navigate within group" submodes;
  any host-side IPC.

---

## 7. Acceptance criteria

**Declarative**
1. Middle-clicking a file tab with no unsaved changes closes it and activates a sibling tab
   (or the Terminal if none remain).
2. Middle-clicking a tab whose file has unsaved changes shows the unsaved-changes dialog and
   does not close until the user chooses Save or Discard.
3. Middle-clicking the Terminal tab does nothing.
4. With history A→B→C, pressing the mouse Back button activates B, then A; Forward
   re-activates B, then C.
5. After Back to A then opening D, Forward is a no-op (C branch discarded).
6. Back/Forward across two sessions switches the active session to the recorded one and
   restores its location.
7. Alt+Left / Alt+Right perform the same Back/Forward as the mouse buttons.
8. Closing tab B then pressing Back from C lands on A (B's entry skipped), never on a blank
   editor.
9. Closing a session removes its locations from the history; Back never resurrects a closed
   session.
10. Mouse Back/Forward and middle-click do nothing while a modal/confirm/palette is open.
11. Middle-clicking an explorer file opens a permanent (non-italic) tab (v1).
12. Activating the already-active location adds no history entry (no adjacent duplicate).
13. After 50 recorded locations, the 51st evicts the oldest and Back still reaches exactly
    the 50 most-recent (cursor stays consistent).
14. Thumb buttons / Alt+Left/Right pressed while focus is inside the in-app `<webview>`
    drive the guest's own history, not the workbench (no workbench tab change).
15. Closing a background tab via middle-click prunes its history entries but does not change
    the active tab.

> Note: AC6 and the "Back crosses sessions" scenario are contingent on Decision D2 (global
> cross-session stack). If D2 is flipped to per-session, AC6/that scenario must be revised.

**EARS**
- *Ubiquitous:* The system shall treat mouse button 1 (`auxclick`) on a doc tab as a tab
  close request equivalent to the close button.
- *Event-driven:* When the user presses mouse button 3 (X1) or Alt+Left, the system shall
  move the navigation cursor to the previous valid location and apply it.
- *Event-driven:* When the user presses mouse button 4 (X2) or Alt+Right, the system shall
  move the navigation cursor to the next valid location and apply it.
- *Event-driven:* When the user activates a location by any means other than a back/forward
  traversal, the system shall record it as the new history tip and discard any forward
  entries.
- *State-driven:* While a modal dialog or command palette is open, the system shall ignore
  navigation mouse buttons and the close middle-click.
- *Unwanted-behavior:* If a recorded location's doc or session no longer exists, then the
  system shall skip it during traversal and shall not display a blank or errored editor.
- *Optional-feature:* Where the pointer target is an explorer file row, the system shall
  treat middle-click as a permanent open.

**Gherkin (key scenarios)**
```gherkin
Scenario: Middle-click closes a clean tab
  Given a file tab "a.ts" is open with no unsaved changes
  When the user middle-clicks the "a.ts" tab
  Then "a.ts" closes and an adjacent tab (or the Terminal) becomes active

Scenario: Middle-click on a dirty tab prompts before closing
  Given a file tab "b.ts" has unsaved changes
  When the user middle-clicks the "b.ts" tab
  Then the unsaved-changes dialog appears
  And "b.ts" remains open until the user chooses Save or Discard

Scenario: Back/Forward traverse activation history
  Given the user opened "a.ts", then "b.ts", then "c.ts"
  When the user presses the mouse Back button twice
  Then "a.ts" is active
  When the user presses the mouse Forward button once
  Then "b.ts" is active

Scenario: Back skips a closed tab
  Given history is "a.ts" -> "b.ts" -> "c.ts" with "c.ts" active
  And "b.ts" has been closed
  When the user presses Back
  Then "a.ts" is active

Scenario: Back crosses sessions
  Given session S1 has "a.ts" active and the user switched to session S2's Terminal
  When the user presses Back
  Then session S1 becomes active with "a.ts" shown
```

### 7.1 Verification strategy

- **Nav-history reducer (`nav-history.ts`):** pure unit tests cover the load-bearing logic —
  record/coalesce, back/forward at start/mid/tip, prune (before/after/at cursor,
  multi-occurrence), overflow eviction, cursor reconciliation. This is the bulk of the risk
  and is fully unit-testable with no DOM.
- **Middle-click close / explorer permanent-open:** component/integration test dispatching a
  synthetic `auxclick` (button 1) — these are ordinary DOM events React handles.
- **Physical X1/X2 thumb buttons:** per project memory, synthetic events don't reliably
  simulate thumb buttons and e2e isn't in CI. Verify the *binding wiring* by dispatching a
  `mouseup` with `button: 3/4` in a test, and treat the real-hardware press (and the Windows
  `app-command` fallback) as `needs-human-smoke`. Do not claim done on the physical-button
  path from automated tests alone.

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Doc tab | Normal | Tab as today | Middle-click → close |
| Doc tab | Dirty | Unsaved dot | Middle-click → confirm dialog, then close/keep |
| Terminal tab | Always | Session tab | Middle-click → no-op |
| Explorer file row | Normal | File row | Middle-click → permanent open (v1) |
| Navigation history | At start | — (no visible chrome) | Back = no-op; Forward enabled if entries ahead |
| Navigation history | Mid-stack | — | Both Back and Forward act |
| Navigation history | At tip | — | Forward = no-op |
| Modal / palette open | — | Dialog | All nav mouse buttons + close middle-click suppressed |
| Nav announcement | After a traversal | (visually nothing) | Polite `aria-live` announces "Editor: <name>" / "Terminal: <session>" |

(No persistent visible navigation chrome ships in v1; history state is reflected only by
what becomes active. A visible affordance is flagged D8.)

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard / shortcuts | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Doc tab | Select / close / pin | Left=select, dbl=pin, **middle (auxclick)=close**, right=context | Enter/Space=select; Mod+W=close active | n/a (desktop) | Existing tab menu (close/others/right) — unchanged | `role="tab"`, `aria-selected` (existing) |
| Explorer file row | Open | Left=preview, dbl=permanent, **middle=permanent**, right=context | Enter=permanent open | n/a | Existing | `role="treeitem"` (existing) |
| Workbench (global) | Navigate history | **X1 (button 3)=back, X2 (button 4)=forward** via window `mouseup`/`auxclick` capture | **Alt+Left=back, Alt+Right=forward** (rebindable) | n/a | n/a | No new ARIA node; navigation announces via the activated tab's existing `aria-selected` |

Notes:
- Use `auxclick` for middle-click close and `mouseup` (button 3/4) for nav, registered as a
  window-level capture listener mirroring the existing keydown handler (`app.tsx:625`), so
  xterm/Monaco `stopPropagation` can't blackhole it. Call `preventDefault()` on the
  triggering `mousedown`/`auxclick` for buttons 3/4 to suppress any Chromium default nav.
- The keyboard combos register as new `SHORTCUT_ACTIONS` (`navBack`, `navForward`) so they
  appear in Settings and are rebindable, and are guarded by the existing form-field check.

## 10. Accessibility & i18n (UI)

- **Keyboard equivalence (WCAG 2.1.1):** every mouse gesture has a keyboard path.
  Back/Forward ≙ Alt+Left/Alt+Right. For close: middle-click closes *any* tab including
  background ones, so Mod+W (active tab only) is NOT a sufficient equivalent on its own —
  the equivalence rests on the tab's existing keyboard-reachable close affordances, which
  the current code already provides: each tab is `tabIndex=0` and its close `<button>` is
  focusable (Tab to it, Enter), and the tab context menu (`onTabContextMenu`, keyboard-
  openable) has a Close item. Middle-click therefore only adds a pointer shortcut to an
  already-keyboard-closeable target — no new mouse-only function. (Requirement: if a future
  change makes a tab's close button non-focusable, this equivalence breaks — keep it.)
- **Pointer cancellation (WCAG 2.5.2):** fire close on `auxclick` (the click event, i.e.
  down+up on the same element), not `mousedown`, giving an up-event/abort semantic.
- **Focus management:** after Back/Forward, move focus consistently with a manual switch —
  a Terminal location requests terminal focus; an editor location lets the doc view take
  focus as it does on normal activation. Don't leave focus stranded on a now-hidden tab.
- **Screen-reader feedback (committed, MVP):** because a Back/Forward jump between two
  same-type editors may not be announced by focus alone, add a polite `aria-live` region
  that announces the landed location on each traversal ("Editor: <name>" / "Terminal:
  <session>"). Reuse the existing polite live-region pattern (e.g. the explorer's `announce`
  in `right-pane.tsx`). This is committed, not deferred.
- **No color-only signaling / no new visible affordance** in v1, so contrast/theming
  obligations are inherited from the unchanged tab + explorer chrome.
- **i18n:** the only new user-facing strings are the rebindable-shortcut labels in Settings
  ("Go back", "Go forward"). Route them through the same string source as existing
  `SHORTCUT_ACTIONS.description`; no hardcoded UI copy elsewhere. Mouse-button numbers are
  not localized (they're physical). No RTL concern (no directional chrome ships; Alt+Left
  stays "back" regardless of layout direction — matches VS Code).

## 11. Design tokens (UI)

- No new visual surface in v1 → no new tokens. If the optional visible Back/Forward
  affordance (D8) is later approved, it must reuse existing icon-button semantic roles
  (`iconbtn`/`iconbtn--sm`) and the existing disabled state, not introduce new hex or a
  bespoke control. Theme variants (light/dark/high-contrast) then inherited from those
  classes.

---

## 12. Assumptions

- Chromium in Electron delivers the thumb buttons to the renderer as DOM mouse events with
  `event.button === 3` (X1/back) and `4` (X2/forward), and middle as `1`; this is standard
  Chromium behavior on Windows/macOS/Linux and is the basis for renderer-side handling.
- The existing `close` reducer's sibling-repointing is the desired "what becomes active
  after a middle-click close" behavior (identical to the × button) — no separate rule.
- "Across the app" means the workbench (tabs, explorer, terminal, editor regions), not
  inside the isolated `<webview>` guest, which keeps its own nav.
- Recording navigation at the existing activation call-sites (centralized via one helper) is
  sufficient coverage; no global observer of `activeId` is needed.
- The history is in-memory and window-lifetime only — it is NOT persisted across app
  restarts and NOT shared across windows (VS Code persists per-workspace; v1 does not — see
  D6). Not flagged high because it's a reversible enhancement.
- **A6 (verify-first):** `auxclick` is assumed to be the right "click" event for close. The
  earlier claim that it self-cancels after a drag is NOT relied upon — to be verified during
  build; if false, gate close on "no significant pointer movement between down and up." Low
  risk (middle-press-drag autoscroll is rare in this UI).
- **A7 (verify-first):** thumb buttons are assumed to reach the renderer as DOM
  `button===3/4`. On Windows they often arrive as `app-command` instead; the host
  `app-command` forward (D4) is the committed fallback, so the feature does not depend on
  the DOM-only assumption holding everywhere.

## 13. Decisions Needed (autonomous mode)

- **[high] D1 — Navigation granularity.** Default taken: **tab/Terminal-activation history**
  (not within-file cursor locations). VS Code's real Go Back/Forward steps through cursor
  positions; replicating that needs Monaco cursor-stack integration and a richer location
  type. v1 ships activation granularity (tractable, matches the prompt's stated v1). Confirm
  whether activation-granularity is acceptable for "exactly like VS Code," or whether cursor
  history must be in scope.
- **[high] D2 — History scope.** Default taken: **single global stack across all sessions**;
  Back can switch the active session. This is the faithful VS Code model (history crosses
  editor groups) but means a Back press can change which terminal/repo is active. The
  tractable alternative is per-session stacks (never switches session). Confirm global vs
  per-session — it shapes the data model and the most surprising behavior.
- **[normal] D3 — Middle-click scope beyond tabs.** Default taken: tabs (close) **plus**
  explorer files (permanent open); everything else no-op. Strict VS Code only firmly defines
  middle-click-closes-tabs; explorer middle-click is a reasonable, low-risk extension.
  Confirm whether to include explorer (and whether to exclude it for strict parity).
- **[normal] D4 — Handling layer.** Default taken: **renderer DOM as primary** (window-level
  capture listener for `auxclick`/`mouseup` buttons 1/3/4, where all tab/nav state lives)
  **plus a host `app-command` forward as the Windows fallback** (thumb buttons frequently
  arrive as `browser-backward`/`browser-forward` OS app-commands, not DOM buttons; the host
  forwards them by IPC to the focused window, de-duped against the DOM path). Confirm this
  hybrid (vs. renderer-only, which risks dead thumb buttons on Windows; vs. host-only, which
  can't see middle-click targets).
- **[normal] D5 — Keyboard parity bindings.** Default taken: add **Alt+Left / Alt+Right** as
  rebindable `navBack`/`navForward` actions. Confirm the default combos (VS Code uses
  Alt+Left/Right on Win/Linux; on macOS it's Ctrl+- / Ctrl+Shift+- — should mac differ?).
- **[normal] D6 — Stack bound & persistence.** Default taken: cap **50**, **not persisted**
  across restarts. Confirm the cap and whether history should survive relaunch (VS Code
  persists per-workspace).
- **[normal] D7 — Terminal-tab middle-click.** Default taken: **no-op** (Terminal tab isn't
  closeable). Confirm it shouldn't instead close/kill the session (rejected as too
  destructive for a stray middle-click).
- **[normal] D8 — Visible affordance & webview behavior.** Default taken: **no visible
  Back/Forward buttons** in v1, and thumb buttons over the `<webview>` guest drive the guest
  (not the workbench). Confirm both (whether a visible nav affordance is wanted, and whether
  workbench nav should somehow override the guest).

## 14. Open questions

(Interactive-only section — not applicable in this autonomous run; all materially-build-
changing ambiguities are captured as severity-tagged entries in §13.)

---

## Self-audit

- Core spine (1–7): all filled — problem frame, behavior/states (both gestures), the
  renderer-side interface contract (new `nav-history.ts` reducer), edge cases, defaults
  table, scope slices, and acceptance criteria (declarative + EARS + Gherkin). ✔
- UI module (8–11): state catalog, interaction inventory (pointer + keyboard + buttons),
  accessibility (keyboard equivalence, pointer cancellation, focus, SR feedback) and i18n
  (rebindable-shortcut labels), and design tokens (none new + the conditional rule for D8).
  Filled rather than skipped despite the feature adding little visible chrome. ✔
- Assumptions (12) and severity-tagged Decisions Needed (13) present; §14 marked N/A for
  autonomous mode with a pointer to §13. ✔
- No section left empty without justification. The two genuinely architecture-shaping calls
  (granularity D1, global-vs-per-session D2) are tagged `high` so the conductor surfaces
  them to a human before build.

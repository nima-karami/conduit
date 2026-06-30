---
status: active
date: 2026-06-30
---

# Feature Spec: VS Code-style mouse buttons (middle-click close, thumb-button Back/Forward)

**Tier:** FULL   **Feature type:** UI (+ one host/IPC slice for the Windows thumb-button fallback)
**One-line request (verbatim):** "Mouse middle click, back, and forward click functionalities should be wired to act exactly like VS Code across the app."

> **This spec was rebased onto repo reality.** The prior draft's premise — "no navigation
> history exists today," "no visible Back/Forward affordance" — is **factually wrong**. A
> complete, unit-tested, app-wired navigation-history subsystem already ships (`src/nav-history.ts`
> + `webview/use-nav-history.ts`), the top-bar already renders **and wires** Back/Forward chrome
> to it, and command-palette Go-back/Go-forward entries exist. Cross-session Back and
> adjacent-duplicate coalescing already work. The skill's job here is the same as the
> review-compare-dialog spec's: **state precisely what exists vs. what we add, then spec only the
> genuine deltas** — the *input surfaces* (mouse buttons, keyboard parity, host fallback) plus
> three robustness fixes to the existing reducer.

---

## 0. Triage

**Tier = FULL, feature type = UI + a host slice.** Multi-surface (doc tabs, explorer rows, a
window-level mouse layer, keyboard parity, a host `app-command` forward), user-facing, touches the
shared nav reducer. The UI module (§8–11) is mandatory; the host slice gets a data contract (§3) +
edge cases (§4).

| Sub-item | Surface | Tier | Why |
|---|---|---|---|
| **A — Middle-click close on doc tabs** | `webview/components/doc-tabs.tsx:186-233` (tab `<div>`) | FULL | Net-new input on an element; routes through the existing close path. |
| **B — Middle-click explorer file → permanent open** | `webview/components/right-pane.tsx` (file row) | LITE | Reuses `onOpenFile(path,'permanent')` (already wired for dbl-click/Enter). |
| **C — X1/X2 thumb buttons → existing goBack/goForward** | new window-level capture listener in `webview/app.tsx` | FULL | Net-new global input layer mirroring the keydown handler. |
| **D — Host `app-command` fallback (Windows thumb buttons)** | `electron/main.ts` (`createWindow:470`), `src/protocol.ts` (`HostToWebview`), `webview/app.tsx` (subscribe) | FULL | Windows delivers thumb buttons as `browser-backward/forward` OS app-commands, not DOM buttons. |
| **E — Alt+Left / Alt+Right rebindable actions** | `webview/shortcuts.ts` (`SHORTCUT_ACTIONS`), `webview/app.tsx` (`actionMap`) | LITE | Keyboard parity for trackpad users; palette entries exist but have **no key binding**. |
| **F — Reducer robustness: skip-dead + stack cap** | `src/nav-history.ts`, `webview/use-nav-history.ts`, `webview/app.tsx:1729-1740` | FULL | Fixes a real AC8 bug (dead docId resolves to Terminal) and the unbounded stack. |
| **G — aria-live traversal announcement** | `webview/app.tsx` (new polite region) | LITE | A same-type Back jump isn't announced by focus alone. |

---

## What already exists (do NOT rebuild) — audited against the code

- **The nav reducer is shipped & unit-tested.** `src/nav-history.ts`: `NavLoc { sessionId?; docId: string | null }` (docId `null` = that session's Terminal), `NavState { stack; index }`, `EMPTY_NAV`, `current`, `record` (truncates forward history + **coalesces adjacent dups** via `sameLoc`), `canBack`/`canForward`, `back`/`forward`. Covered by `test/unit/nav-history.test.ts`.
- **The React glue is shipped.** `webview/use-nav-history.ts` records via **a single observer** on the `{sessionId, docId}` location, using a `navigating` ref to distinguish traversal-applies from real navigations — so it **auto-covers every navigation site** (Ctrl+Tab, Ctrl+1-9, Ctrl+\`, `onSelectDoc`, session select, `openFile`) with no per-site dispatch. It already ignores the transient pre-session location (`loc.sessionId === undefined`) so Back doesn't light up at launch.
- **It's wired into the app.** `webview/app.tsx:1729-1740` (`applyNav` + `useNavHistory`); recording is driven implicitly by the location passed in (`{ sessionId: activeId, docId: docState.activeId }`). Navigation sites that feed it: keydown/Ctrl+Tab/Ctrl+1-9 (`app.tsx:561-619`), switchSession effect (`app.tsx:673-675`), `onSelectDoc` (`app.tsx:2146`), session select (`app.tsx:2201`), `onSelectDoc` → `docs.ts` `activate`/`switchSession` (`docs.ts:288-294`).
- **Visible Back/Forward chrome already ships AND is wired.** `webview/components/top-bar.tsx:74-79` renders the two `iconbtn` chevrons; `app.tsx:2274-2282` passes `onBack={goBack}`, `onForward={goForward}`, `canBack`, `canForward`. The enabled/disabled state is **already** bound to `canBack`/`canForward`. (The prior draft's "no visible affordance" is stale.)
- **Command-palette entries exist.** `cmd:back` ("Go back") and `cmd:forward` ("Go forward") at `app.tsx:1878-1891`, both running `goBack`/`goForward`. They have **no keyboard binding** (not in `SHORTCUT_ACTIONS`).
- **The close path exists.** `closeDoc` (`app.tsx:910`) honours the unsaved-changes 3-way confirm; `doc-tabs.tsx` already calls `onClose(d.id)` from the × button (`doc-tabs.tsx:263`), wired to `closeDoc` via `onCloseDoc` (`app.tsx:2149`).
- **Permanent open exists.** `onOpenFile(path, 'permanent')` is wired for dbl-click/Enter on file rows (`right-pane.tsx:1142, 1377`).
- **The polite live-region pattern exists.** `right-pane.tsx:624` `announce()` writing into the `aria-live="polite" role="status" sr-only` div (`right-pane.tsx:1419`).
- **The host→renderer channel exists.** `to-webview`/`subscribe` (`electron/preload.ts:14-18`), `HostToWebview` union (`src/protocol.ts:189`), per-window send via `w.webContents.send('to-webview', …)` (`main.ts`). **No `app-command` listener exists today** (net-new).

So the model and traversal **work**. This feature is the **input edges + three reducer hardenings**.

---

## 1. Problem frame

- **Job:** A Conduit user with VS Code mouse habits — middle-click a tab to close it, press the
  thumb buttons to jump back/forward through where they were — expects those gestures to "just
  work," keeping navigation in the mouse and out of menus. The *destination model* is already
  correct; today there is simply **no mouse/keyboard input bound to it**.
- **Actors:** Single local user with a multi-button mouse (3-button + X1=back, X2=forward); also
  trackpad users (no thumb buttons) who need the keyboard equivalents.
- **Success outcomes (observable):**
  - Middle-clicking a doc tab closes it via the same path as the × button (dirty-prompt honoured).
  - Pressing the mouse Back/Forward button drives the existing `goBack`/`goForward` (cross-session,
    coalesced) and *never* double-fires on Windows where the press also arrives as an app-command.
  - Alt+Left / Alt+Right drive the same `goBack`/`goForward` for trackpad users and are rebindable.
  - A Back jump that lands between two same-type editors is announced to screen readers.
- **Non-goals:**
  - Re-implementing the nav model, the reducer, the hook, the top-bar chrome, or the palette
    entries — **they exist; extend, don't duplicate** (Decision D-EXTEND).
  - Cursor-/selection-location history *within* a file (true VS Code Go-Back granularity). v1 stays
    tab/Terminal-activation granularity — confirmed shipped behavior (D1).
  - Per-session history. The shipped model is a single GLOBAL cross-session stack per window;
    confirmed (D2).
  - Middle-click "open link in new tab" inside Monaco / terminal output.
  - Thumb buttons inside the in-app `<webview>` guest — the guest owns its own history.
  - Rebindable *mouse* buttons / a mouse-button settings UI (mouse bindings are fixed; only the
    keyboard equivalents ride the rebindable registry).
  - Persisting history across restarts or across windows.

---

## 2. Behavior & states

### 2.1 Middle-click (`auxclick`, `button === 1`)

| Target | Behavior |
|---|---|
| A doc tab `<div>` (file, diff, review, git-history, commit-diff, web) — `doc-tabs.tsx:186` | Close it via the existing `onClose(d.id)` → `closeDoc`, so a dirty file raises the unsaved-changes confirm. Element-local `onAuxClick`, **not** a window-capture listener. |
| The Terminal tab `<button>` (`doc-tabs.tsx:177`) | No-op (no `onAuxClick` attached). The Terminal tab represents the live session and isn't closeable via × or Mod+W; middle-click must not become a hidden "kill session." (D7) |
| An explorer **file** row (`right-pane.tsx`) | Open as a **permanent** (non-preview) tab via `onOpenFile(node.path, 'permanent')` — identical to dbl-click/Enter. Element-local `onAuxClick`. (D3) |
| An explorer **folder** row | No-op (VS Code has no middle-click folder action). |
| Anything else | No-op in v1. |

Background-tab middle-click closes that tab without changing the active tab (the existing `close`
reducer only repoints when the closed tab was active). No nav recording happens for a non-active
close — the single observer only fires when the *active* location changes.

### 2.2 Back / Forward — driving the EXISTING `goBack`/`goForward`

Inputs that must all funnel into the already-shipped `goBack`/`goForward` from `useNavHistory`:

1. **Mouse X1 (`button === 3`) = back, X2 (`button === 4`) = forward** — a **window-level capture**
   listener (mirroring the keydown handler at `app.tsx:551-627`, which listens in the capture phase
   precisely so xterm/Monaco `stopPropagation` can't blackhole it). `preventDefault()` the
   triggering `mousedown`/`auxclick` for buttons 3/4 to suppress any Chromium default nav.
2. **Host `app-command` fallback (Windows)** — see §3.2 / D4. Arrives as a `HostToWebview` message
   and calls the same `goBack`/`goForward`.
3. **Alt+Left / Alt+Right** — new rebindable `navBack`/`navForward` `SHORTCUT_ACTIONS` whose
   `actionMap` entries call `goBack`/`goForward` (§3.3, D5).

All three are **suppressed** when (a) a modal/palette/menu/confirm/settings surface is open
(`isAnyModalOpen`, §4), and (b) — for the mouse/keyboard DOM paths — focus is inside the
`<webview>` guest (the guest owns its history). Recording/coalescing/cross-session apply are
unchanged: they already work through the single observer.

The traversal semantics (truncate-forward on a new navigation, coalesce adjacent dups, no-op at
the ends) are **inherited unchanged** from `src/nav-history.ts`. The only reducer changes are
skip-dead and a stack cap (§3.1).

---

## 3. Data / interface contract

### 3.1 Extended `src/nav-history.ts` (EXTEND in place — no new module)

> D-EXTEND (ratified): extend `src/nav-history.ts`; do **not** add `webview/nav-history.ts` (that
> duplicates the reducer → two sources of truth). Keep the **single observer** in
> `use-nav-history.ts`; do **not** add a `navigateTo()` helper at N call-sites (regression risk:
> missed/double records).

Two additions; everything else (`NavLoc`, `NavState`, `record`, `current`, `sameLoc`, `canBack`,
`canForward`) stays as shipped.

**(a) `isAlive` skip predicate injected into `back`/`forward`.** Today `back`/`forward` move the
index by exactly one and `applyNav` (`app.tsx:1732-1733`) papers over a dead docId by resolving it
to `null` (Terminal) — that is the AC8 bug (Back onto a closed tab lands on the *Terminal*, not the
nearest valid editor). Fix: make traversal skip dead entries.

```ts
// New signature — back/forward take an optional liveness predicate.
type IsAlive = (loc: NavLoc) => boolean;

// Step from the current index in `dir` (-1 back / +1 forward), skipping entries
// for which isAlive returns false; land on the nearest live entry. If none is
// live in that direction, return the state unchanged (no-op — index does NOT move).
export function back(s: NavState, isAlive?: IsAlive): NavState;
export function forward(s: NavState, isAlive?: IsAlive): NavState;
```

- When `isAlive` is omitted (or every candidate is alive), behavior is identical to today — the
  existing unit tests stay green.
- Dead entries are **left in the stack** (no prune, no cursor reconciliation): they're simply
  skipped on traversal. This is the ratified replacement for the prior draft's self-contradictory
  "eager prune + defensive skip" model. One mechanism, no new dispatch sites.
- `canBack`/`canForward` keep their cheap `index`-only checks for **chrome enabled/disabled state**
  (acceptable: a Back button that's enabled but, after skipping all-dead older entries, no-ops is a
  rare edge and strictly better than the old wrong-landing). The *authoritative* no-op decision is
  made inside `back`/`forward` against `isAlive`.

**(b) Stack cap with drop-oldest, inside `record()`.** Today `record` is unbounded. Add a cap
(default 50, exported constant):

```ts
export const NAV_STACK_CAP = 50;
// In record(), after truncate-forward + push:
//   if (stack.length > NAV_STACK_CAP) {
//     const drop = stack.length - NAV_STACK_CAP;
//     return { stack: stack.slice(drop), index: stack.length - drop - 1 };
//   }
```

Dropping `drop` oldest entries decrements the index by the same amount so it keeps pointing at the
just-recorded tip. (record only ever pushes at the tip, so overflow only ever drops from the front.)

**Wiring change in `webview/app.tsx`:** `useNavHistory` gains an `isAlive` argument built from the
live `docState.docs` (+ sessions). `applyNav` **drops** its `exists ? l.docId : null` fallback
(`app.tsx:1732-1733`) — the landed loc is now guaranteed alive, so it applies the docId directly.
`use-nav-history.ts` threads `isAlive` into `back`/`forward`.

### 3.2 Host `app-command` fallback (new IPC message, existing channel) — D4

Windows delivers thumb buttons as the BrowserWindow `app-command` event (`browser-backward` /
`browser-forward`), **not** as DOM `button===3/4`. `app-command` is **per-window** (it fires on the
window that received it — not "the focused window"). Add, in `createWindow` (`main.ts:470`):

```ts
w.on('app-command', (e, command) => {
  if (command === 'browser-backward' || command === 'browser-forward') {
    e.preventDefault();
    w.webContents.send('to-webview', {
      type: 'appCommand',
      command: command === 'browser-backward' ? 'back' : 'forward',
    }); // forwards to THIS window's own renderer
  }
});
```

Add to `src/protocol.ts` `HostToWebview`:

```ts
  | { type: 'appCommand'; command: 'back' | 'forward' }
```

**No new IPC channel** — it rides the existing `to-webview`/`subscribe` pattern
(`preload.ts:14-18`). The renderer handles it in its existing `subscribe` switch, calling
`goBack`/`goForward` (subject to the same `isAnyModalOpen` guard).

### 3.3 De-dup: one authoritative source per platform

A single physical thumb press on Windows can surface as **both** a DOM `mousedown` (button 3/4)
**and** an `app-command`. To guarantee one press → one navigation, route deterministically by
platform rather than racing both and de-bouncing:

- **Windows:** the host `appCommand` message is the authoritative source. The renderer's window-level
  X1/X2 DOM handler is **gated off on Windows** (it returns early for buttons 3/4). DOM thumb buttons
  on Windows are unreliable anyway; the app-command path is the reliable one.
- **macOS / Linux:** the DOM `button===3/4` path is authoritative; `app-command` does not fire for
  these buttons, so no host message arrives.

Platform detection must be **reliable** (Electron's renderer `navigator.userAgent` reports the host
OS faithfully; the existing `isMac` in `shortcuts.ts` already relies on `navigator.platform`). Add a
sibling `isWindows` check from the same source, OR have the host stamp the platform once at startup;
either is acceptable, but the gate must be a **single deterministic branch**, not a time-window
heuristic. Document the chosen source in the implementation. (The middle-click and Alt+Left/Right
paths are platform-agnostic and unaffected by this gate.)

### 3.4 Alt+Left / Alt+Right (rebindable) — `SHORTCUT_ACTIONS`

Add two entries to `webview/shortcuts.ts` (the combo grammar supports a bare `Alt` modifier;
`matchCombo` already handles `Mod` absent):

```ts
{ id: 'navBack',    description: 'Go back',    group: 'Navigation', defaultCombo: 'Alt+ArrowLeft'  },
{ id: 'navForward', description: 'Go forward', group: 'Navigation', defaultCombo: 'Alt+ArrowRight' },
```

Add `actionMap.navBack = goBack` / `actionMap.navForward = goForward` in `app.tsx`. They flow
through the existing `SHORTCUT_ACTIONS` loop (`app.tsx:558-574`), so they're **already** guarded by
`inFormField` and rebindable in Settings; they also surface in the Settings shortcuts list
(`settings-modal.tsx:862`). The existing `cmd:back`/`cmd:forward` palette entries stay; this only
adds the missing key bindings. (Keep platform default Alt+Left/Right on all platforms for v1; the
mac-specific Ctrl+- combo VS Code uses can be a later tweak — D5.)

### 3.5 Invariants

- Reducer stays pure; `back`/`forward` mutate only `index`; `record` is the only writer of `stack`.
- `0 <= index < stack.length` when non-empty; `index === -1` / empty when no history.
- Skip-dead never mutates `stack`; it only advances `index` past dead entries or no-ops.
- Cap holds: `stack.length <= NAV_STACK_CAP` after any `record`.
- Scope = **per renderer window** (each window owns its `NavState`; "global" means across sessions
  *within* a window). Confirmed shipped (D2).

---

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Back at start / Forward at tip | No-op (inherited from `canBack`/`canForward` + reducer). |
| **Back target's doc was closed** (AC8) | `isAlive` skips the dead entry; land on the **nearest valid older editor**, never the Terminal-as-fallback. If no older entry is alive, no-op. |
| Back target's **session** was closed | Same skip path (`isAlive` checks the session too). |
| All older/newer entries dead | Traversal no-ops; focus unchanged. |
| Middle-click a **dirty** tab | Routes through `closeDoc` → unsaved-changes confirm; stays open until resolved (identical to ×). |
| Background (non-active) tab middle-clicked | Tab closes; active tab unchanged; no nav record (observer didn't fire). |
| Middle-click that began as an autoscroll/drag | Fire close on `auxclick` (down+up on the same element), not `mousedown` — gives WCAG-2.5.2 up-event/abort semantics. (A6: if Chromium still fires `auxclick` after movement, gate on "no significant pointer movement"; low risk in this UI.) |
| Single Windows thumb press surfaces as DOM **and** app-command | De-dup §3.3: DOM 3/4 handler is gated off on Windows; only the host `appCommand` navigates. Exactly one navigation. |
| X1/X2 or Alt+Left/Right while a **modal/palette/menu/confirm/settings** is open | Suppressed via `isAnyModalOpen` — an explicit predicate over the renderer signals `palette` (`app.tsx:146`), `settingsOpen` (`:141`), `menu` (`:155`), `confirm` (`:160`) — **not** just the keydown `inFormField` guard, which wouldn't catch a non-input modal. |
| Thumb / Alt+Left/Right while focus is **inside the `<webview>` guest** | Suppressed for the DOM/keyboard paths (the guest drives its own history). Detect via focus/active-element being within the guest. |
| Rapid mash / key-repeat | Each event = one step; idempotent at the ends; reducer is synchronous so no race. |
| Multiple windows | Each window's `app-command` forwards to **its own** webContents (not the focused window); each has its own `NavState`. |
| Browser-preview (no `window.agentDeck`) | Middle-click + DOM-button + Alt paths are pure-renderer and work; only the host `appCommand` fallback is absent (no host) — preview never needs it. |
| Cross-session Back apply ordering | Switching session via Back fires `setActiveId` then `dispatchDocs activate`. The `activeId` change *also* triggers the `switchSession` effect (`app.tsx:673-675`) which sets `activeId` to that session's **remembered** doc (`docs.ts:288-294`), which could clobber the explicit `activate`. This ordering must be tested (§7.1, AC16). |
| 51st recorded location | `record` drops the oldest, decrements index; Back still reaches exactly the 50 most-recent. |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Middle-click closes doc tabs | On | No | Core VS Code parity. |
| Middle-click explorer file → permanent open | On | No | Matches dbl-click; low-risk (D3). |
| Mouse X1/X2 → existing goBack/goForward | On | No | The feature; fixed mouse bindings. |
| Windows thumb-button source | Host `app-command` | No | DOM thumb buttons unreliable on Windows (D4 / §3.3). |
| Keyboard parity combos | Alt+Left / Alt+Right (all platforms, v1) | Yes (ride `SHORTCUT_ACTIONS`) | Trackpad users; rebindable like every other shortcut (D5). |
| Navigation granularity | Tab/Terminal activation | No (v1) | Cursor history is vision, not v1 (D1) — matches shipped. |
| History scope | Single global stack across sessions, per window | No | Faithful to VS Code; **already shipped** (D2). |
| History depth cap | 50 (`NAV_STACK_CAP`) | No (constant) | Bounded memory; today unbounded. |
| Visible Back/Forward chrome | **Already ships** (top-bar) | — | Wired to `canBack`/`canForward` already. |
| Dead-entry handling | Skip on traversal (no prune) | No | One mechanism, no cursor reconciliation. |

---

## 6. Scope slicing

- **MVP (must):**
  - Middle-click doc tab → `closeDoc` (dirty-prompt honoured); Terminal tab no-op.
  - Window-level X1/X2 capture listener → existing `goBack`/`goForward`; suppressed behind
    `isAnyModalOpen` and inside `<webview>`.
  - Host `app-command` forward (new `HostToWebview` `appCommand`) + platform de-dup (§3.3).
  - Reducer: `isAlive` skip in `back`/`forward` (fixes AC8) + `NAV_STACK_CAP` in `record`; drop the
    `applyNav` dead-docId fallback.
  - Alt+Left / Alt+Right rebindable `navBack`/`navForward`.
- **v1 (should):**
  - Middle-click explorer file → permanent open (D3).
  - aria-live traversal announcement (§10).
  - Test for the cross-session apply-ordering dependency (§4 / AC16).
- **Vision (could):**
  - Cursor-/selection-location history within editors (Monaco cursor stack) (D1).
  - mac-specific default combo (Ctrl+- / Ctrl+Shift+-) (D5).
  - OS horizontal-swipe gestures.
- **Out of scope:** rebindable mouse buttons; per-session stacks; persisting history; a *new* nav
  module/hook/chrome (all exist).

---

## 7. Acceptance criteria

**Declarative**
1. Middle-clicking a clean file tab closes it and activates a sibling (or Terminal if none remain).
2. Middle-clicking a dirty tab shows the unsaved-changes dialog; it stays open until Save/Discard.
3. Middle-clicking the Terminal tab does nothing.
4. With history A→B→C, mouse Back activates B then A; Forward re-activates B then C (existing
   reducer; this AC verifies the **mouse input** reaches it).
5. After Back to A then opening D, Forward is a no-op (forward branch discarded — existing reducer).
6. Back/Forward across two sessions switches to the recorded session and restores its location.
7. Alt+Left / Alt+Right perform the same Back/Forward as the mouse buttons, and are reachable +
   rebindable in Settings.
8. **(corrected)** With history A→B→C (C active) and **B closed**, pressing Back activates **A** —
   the nearest valid older editor — and **never the Terminal** and never a blank editor. (This is
   the AC8 that the current `app.tsx:1732-1733` fallback fails.)
9. Closing a session: Back never resurrects it (its entries are skipped by `isAlive`).
10. Mouse Back/Forward, Alt+Left/Right, and middle-click do nothing while any modal/confirm/palette/
    menu/settings is open.
11. Middle-clicking an explorer file opens a permanent (non-italic) tab.
12. Activating the already-active location adds no entry (existing coalescing — regression guard).
13. **(cap)** After 50 recorded locations, the 51st evicts the oldest; Back reaches exactly the 50
    most-recent and the index stays consistent.
14. Thumb buttons / Alt+Left/Right with focus inside the `<webview>` drive the guest, not the
    workbench (no workbench tab change).
15. Closing a background tab via middle-click does not change the active tab.
16. **(de-dup)** On Windows, a single physical thumb-button press navigates **exactly once** (the
    DOM 3/4 path is gated off; only the host `appCommand` fires).
17. **(ordering)** A Back that crosses sessions lands on the recorded doc, not the session's
    last-remembered doc — i.e. the explicit `activate` is not clobbered by the `switchSession`
    effect (`app.tsx:673-675` vs `docs.ts:288-294`).

**EARS**
- *Ubiquitous:* The system shall treat `auxclick` (`button===1`) on a doc tab as a close request
  equivalent to the close button.
- *Event-driven:* When the user presses mouse X1, Alt+Left, or (on Windows) the `browser-backward`
  app-command, the system shall invoke the existing `goBack`.
- *Event-driven:* When the user presses mouse X2, Alt+Right, or `browser-forward`, the system shall
  invoke the existing `goForward`.
- *State-driven:* While any modal/palette/menu/confirm/settings surface is open, the system shall
  ignore the navigation buttons, the parity keys, and the close middle-click.
- *Unwanted-behavior:* If a traversal target's doc or session no longer exists, then the system
  shall skip it and land on the nearest valid entry (or no-op), never on the Terminal-as-fallback
  or a blank editor.
- *Unwanted-behavior:* If a single physical thumb press surfaces on Windows as both a DOM button and
  an app-command, then the system shall navigate exactly once.
- *Optional-feature:* Where the pointer target is an explorer file row, the system shall treat
  middle-click as a permanent open.

**Gherkin (key scenarios)**
```gherkin
Scenario: Middle-click closes a clean tab
  Given a file tab "a.ts" is open with no unsaved changes
  When the user middle-clicks the "a.ts" tab
  Then "a.ts" closes and an adjacent tab (or the Terminal) becomes active

Scenario: Back skips a closed tab and lands on the nearest editor
  Given history is "a.ts" -> "b.ts" -> "c.ts" with "c.ts" active
  And "b.ts" has been closed
  When the user presses the mouse Back button
  Then "a.ts" is active
  And the Terminal is not shown

Scenario: One Windows thumb press navigates once
  Given the app is running on Windows
  When the user presses the physical Back thumb button once
  Then the workbench navigates back exactly one step
  And the DOM button-3 path performs no navigation

Scenario: Back crosses sessions to the recorded doc
  Given session S1 had "a.ts" active and the user switched to S2's Terminal
  When the user presses Back
  Then session S1 becomes active with "a.ts" shown (not S1's last-remembered doc)
```

### 7.1 Verification strategy

- **Reducer (`src/nav-history.ts`):** extend `test/unit/nav-history.test.ts` — `isAlive` skip
  (single dead, run of dead, all-dead → no-op, forward-skip), cap (51st evicts oldest, index
  consistent), and **regression**: existing record/coalesce/back/forward tests stay green with the
  new optional args.
- **Middle-click close / explorer permanent-open:** component test dispatching a synthetic
  `auxclick` (button 1) on the tab `<div>` / file row — ordinary DOM events React handles.
- **Cross-session apply ordering (AC16/17):** an integration test asserting Back to a different
  session shows the **recorded** doc, guarding the `switchSession`-effect-vs-`activate` order.
- **Physical X1/X2 thumb buttons + Windows `app-command`:** per project memory, synthetic events
  don't reliably simulate thumb buttons and e2e isn't in CI. Verify the *wiring* by dispatching a
  `mouseup`/handler with `button:3/4` and by feeding a synthetic `appCommand` message through the
  subscribe switch; treat the real-hardware press as `needs-human-smoke`. Do not claim the
  physical-button path done from automated tests alone.

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Doc tab | Normal | Tab as today | Middle-click → close |
| Doc tab | Dirty | Unsaved dot | Middle-click → confirm, then close/keep |
| Terminal tab | Always | Session tab | Middle-click → no-op |
| Explorer file row | Normal | File row | Middle-click → permanent open |
| Top-bar Back/Forward | Has history behind/ahead | Chevron **enabled** | Click / X1·X2 / Alt+Arrow → traverse |
| Top-bar Back/Forward | At an end | Chevron **disabled** (existing `disabled={!canBack}` etc.) | No-op |
| Any modal/palette/menu/confirm/settings open | — | Dialog | All nav inputs + close middle-click suppressed |
| Nav announcement | After a traversal | (visually nothing) | Polite `aria-live` announces "Editor: <name>" / "Terminal: <session>" |

The visible Back/Forward chrome already ships and reflects `canBack`/`canForward`; no new persistent
chrome is added.

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Doc tab | Select / close / pin | Left=select, dbl=pin, **middle(auxclick)=close**, right=context | Enter/Space=select; Mod+W=close active; tab-menu Close | Existing (unchanged) | `role="tab"`, `aria-selected` (existing) |
| Explorer file row | Open | Left=preview, dbl=permanent, **middle=permanent**, right=context | Enter=permanent | Existing | `role="treeitem"` (existing) |
| Workbench (global) | Navigate history | **X1=back, X2=forward** via window capture (DOM gated off on Windows; host app-command instead) | **Alt+Left=back, Alt+Right=forward** (rebindable `navBack`/`navForward`) | n/a | Traversal announced via aria-live + the activated tab's existing `aria-selected` |
| Top-bar chevrons | Back/Forward | Left-click (existing) | reachable as `iconbtn` | n/a | `title="Back"/"Forward"`, `disabled` state (existing) |

Notes:
- Close uses element-local `onAuxclick` on the tab `<div>` (`doc-tabs.tsx:186`); the Terminal
  `<button>` gets none. Explorer file rows get element-local `onAuxClick` too.
- Nav X1/X2 use a **window-level capture** listener mirroring the keydown handler
  (`app.tsx:551-627`) so xterm/Monaco can't blackhole them; `preventDefault()` the mousedown/auxclick
  for buttons 3/4.
- Alt+Left/Right register as `SHORTCUT_ACTIONS`, inheriting the form-field guard and Settings UI.

## 10. Accessibility & i18n (UI)

- **Keyboard equivalence (WCAG 2.1.1):** Back/Forward ≙ Alt+Left/Alt+Right (and the existing top-bar
  chevrons + palette entries). For close: each tab is `tabIndex=0` with a focusable close `<button>`
  (`doc-tabs.tsx:263`) and a keyboard-openable context-menu Close; middle-click only adds a pointer
  shortcut to an already-keyboard-closeable target. (Requirement: keep the close button focusable.)
- **Pointer cancellation (WCAG 2.5.2):** fire close on `auxclick` (down+up on the same element),
  not `mousedown`.
- **Focus management:** after a traversal, match a manual switch — a Terminal location requests
  terminal focus; an editor lets the doc view take focus on activation. Don't strand focus on a
  hidden tab.
- **Screen-reader feedback (committed, v1):** a same-type editor→editor Back may not be announced by
  focus alone, so add a polite `aria-live` region announcing the landed location ("Editor: <name>" /
  "Terminal: <session>") on each traversal. **Reuse the existing pattern** — `announce()` writing
  into an `aria-live="polite" role="status" sr-only` div (`right-pane.tsx:624, 1419`).
- **i18n:** the only new user-facing strings are the rebindable-shortcut labels ("Go back",
  "Go forward") via `ShortcutAction.description`, and the aria-live "Editor:/Terminal:" prefixes —
  route through the same string source as existing copy; no hardcoded UI text elsewhere. Mouse-button
  numbers aren't localized. No RTL concern (Alt+Left stays "back" like VS Code).

## 11. Design tokens (UI)

No new visual surface — the Back/Forward chrome already ships and reuses `iconbtn` semantic roles
and the existing `disabled` state. No new hex/tokens. (If a future visible affordance is added it
must reuse `iconbtn`/`iconbtn--sm`, not bespoke controls.)

---

## 12. Assumptions

- **A1 — DOM button codes:** Chromium-in-Electron delivers middle as `button===1`, X1 as `3`, X2 as
  `4`. Standard; basis for the renderer paths. On Windows the thumb buttons frequently surface as
  `app-command` instead — handled by D4, so the feature doesn't depend on DOM-only holding there.
- **A2 — `app-command` is per-window:** the event fires on the window that received it; we forward to
  `w.webContents`, not "the focused window."
- **A3 — Platform detection is reliable in the renderer** (Electron `navigator.userAgent`/`platform`
  report the host OS; `isMac` already relies on this). The Windows de-dup gate hangs on it.
- **A4 — `auxclick` is the right close event;** the earlier "self-cancels after drag" claim is NOT
  relied upon — to verify in build; fall back to a movement gate if false (low risk).
- **A5 — The single observer covers all navigation sites** (it already does — it observes the
  resolved location, not call-sites), so the new inputs need only call `goBack`/`goForward`; no new
  record dispatch is added anywhere.
- **A6 — History is in-memory, per window, not persisted** across restarts or shared across windows
  (matches shipped behavior).

## 13. Decisions

All architecture-shaping calls are **ratified** (most already match shipped code); none are open.

- **D-EXTEND (ratified):** extend `src/nav-history.ts` in place; keep the single observer in
  `use-nav-history.ts`. No new module, no per-site `navigateTo()`.
- **D1 — Granularity = tab/Terminal activation (ratified, matches shipped).** Cursor-location history
  is vision, not v1.
- **D2 — Single GLOBAL cross-session stack, per window (ratified, matches shipped).** Back can switch
  the active session (AC6).
- **D3 — Middle-click scope (ratified):** doc tabs (close) + explorer files (permanent open); else
  no-op.
- **D4 — Handling layer (ratified):** renderer DOM primary (mouse/keyboard) + host `app-command`
  fallback on Windows, de-duped by deterministic platform routing (§3.3).
- **D5 — Parity bindings (ratified):** Alt+Left/Alt+Right on all platforms for v1, rebindable. A
  mac-specific default is a later tweak.
- **D6 — Cap & persistence (ratified):** cap 50 (`NAV_STACK_CAP`), drop-oldest; not persisted.
- **D7 — Terminal-tab middle-click (ratified):** no-op (not closeable; must not become a hidden
  kill-session).
- **D8 — Dead entries (ratified):** skip on traversal via `isAlive` (no prune, no cursor
  reconciliation).

## 14. Open questions

None. (Autonomous run; all materially build-changing calls are ratified in §13.)

---

## Self-audit

- **Premise corrected:** leads with an exists-vs-adds audit grounded in file:line; the false "no
  history / no affordance" premise is removed. ✔
- **Spine (1–7):** problem frame, behavior/states, EXTENDED-reducer contract (isAlive + cap, no new
  module), edge cases (skip-dead, de-dup, cross-session ordering), defaults, scope, ACs incl.
  corrected AC8, cap (AC13), de-dup (AC16), ordering (AC17). ✔
- **UI module (8–11):** state catalog, interaction inventory, a11y (keyboard equivalence, pointer
  cancellation, focus, committed aria-live), i18n, tokens (none new). ✔
- **Assumptions (12) + ratified decisions (13);** §14 = none. No section left empty. ✔
- **Conductor ratifications honored:** extend-in-place, single observer, D1/D2 noted-not-re-decided,
  isAlive skip predicate, cap-in-record, the 7-item new surface fully specced. ✔

---
status: implemented
date: 2026-08-17
tier: LITE
type: UI
---

# Feature Spec: Explorer keyboard multi-select

**Tier:** LITE (one surface — the Files tree's key handler — and one clear job)
**Feature type:** UI
**One-line request:** close the P1 gap in
`docs/runs/2026-08-16-selection-context-menus/blockers.md` — the Explorer tree has pointer
multi-select but **no keyboard multi-select at all**, so a keyboard-only user cannot build the
selection that the just-shipped selection-aware context menu acts on.

> **Lineage.** Extends the pointer-only contract in
> `docs/specs/archive/2026-06-27-explorer-multiselect.md` — this is its §6 "v1 (should): keyboard
> selection" line, and closes the a11y gap that spec named as Decision D2. It is also the deferral
> written into `docs/specs/archive/2026-08-16-selection-aware-context-menus.md` §9/§11 ("keyboard
> users cannot *build* an Explorer multi-selection"). It **changes no pointer behaviour and no menu
> behaviour** — it only lets the keyboard reach states the pointer already reaches.

> **Tier rationale:** one component's key handler plus one pure function added beside its siblings.
> The selection model, the roving tabindex, `aria-selected` and `aria-multiselectable` already
> exist. Not multi-surface, not novel → LITE. UI module still walked (§7–§9) because it is a UI
> feature; the hard rule is that a11y/i18n are not optional just because the change is small — and
> here a11y *is* the point of the feature.

## 1. Problem frame

- **Job:** "I drive this tree from the keyboard. Let me build a selection the same way I build one
  with the mouse — grab a run with Shift, cherry-pick with the toggle modifier, take the lot with
  Ctrl+A — so the actions that already work on N items are reachable without a pointer."
- **Actors:** the single local user driving the Files tab; specifically a keyboard-only or
  screen-reader user, for whom every N>1 action currently has **no** input path.
- **Success outcomes (observable):**
  - `Ctrl/Cmd+A` in the tree selects every visible row.
  - `Shift+ArrowDown`/`Up` grows and **shrinks** a contiguous run from a fixed anchor.
  - `Ctrl/Cmd+ArrowDown`/`Up`/`Home`/`End` move the roving row **without** disturbing the selection.
  - `Ctrl/Cmd+Space` toggles the focused row in or out — the keyboard equivalent of Ctrl-click.
  - Right-clicking (or otherwise acting on) a keyboard-built selection reads `Delete 3 items`, i.e.
    the selection-aware menu is finally reachable without a pointer.
- **Non-goals (explicit):**
  - No pointer-behaviour change; no context-menu change (item set, order, scoping — all frozen by
    the 2026-08-16 spec).
  - No `Shift+Space`, no type-ahead, no rubber-band/marquee, no Ctrl+Shift additive range.
  - No `Shift+F10` on the tree (still deferred; separate a11y feature — 2026-08-16 spec #8).
  - No new module, no new live region, no new ARIA attributes.

## 2. Behavior & states

The gesture table below is the whole feature. Every row not in it keeps today's behaviour
**exactly**: an unmodified arrow/Home/End still collapses to one row, `Escape` still clears,
`Ctrl+X`/`C`/`V` still act on the whole set, `Enter`/`F2`/`Delete`/`ArrowLeft`/`ArrowRight` are
untouched.

| Gesture | Selection | Anchor | Roving focus |
|---|---|---|---|
| `Ctrl/Cmd+A` | every path in the current visible order | unchanged; seated at the **first visible row only if there is no anchor** | unchanged |
| `Shift+ArrowDown` / `Shift+ArrowUp` | `selectRange` from the anchor to the newly focused row | **unchanged** | moves one row |
| `Shift+Home` / `Shift+End` | `selectRange` from the anchor to the first / last visible row | **unchanged** | moves |
| `Ctrl/Cmd+ArrowDown` / `Up` / `Ctrl+Home` / `Ctrl+End` | **untouched** | unchanged | moves |
| `Ctrl/Cmd+Space` | `toggle` the focused row | moves to the focused row (`toggle`'s existing contract) | unchanged |

**Why the anchor stays put on Shift+Arrow.** That is what makes repeated `Shift+ArrowDown` *grow*
from one fixed point and makes reversing to `Shift+ArrowUp` *shrink* the run rather than invert it
about the moving end. It is the same anchor semantics `selectRange` already gives Shift-**click**
(2026-06-27 spec §2), so pointer and keyboard produce identical states — the property that lets a
user mix the two mid-selection.

**Worked sequence** over visible order `a, b, c, d, e` (this is the e2e's script):

1. click `a` → selected `{a}`, anchor `a`, focus `a`
2. `Shift+ArrowDown` → focus `b`, selected `{a,b}`, anchor still `a`
3. `Shift+ArrowDown` → focus `c`, selected `{a,b,c}`, anchor still `a`
4. `Shift+ArrowUp` → focus `b`, selected `{a,b}` — **shrunk**, not inverted
5. `Ctrl+A` → selected `{a..e}`, anchor still `a`, focus still `b`
6. `Ctrl+ArrowDown` → focus `c`, selection **still** `{a..e}`
7. `Ctrl+Space` → selected `{a,b,d,e}`, anchor `c`, focus still `c`

## 3. Data / interface contract

Renderer-only. No host round-trip, no IPC, no persistence — selection is transient UI state, as it
has been since 2026-06-27 §3.

**One new pure function**, added to `webview/file-tree-selection.ts` beside its siblings (not a new
module — the gesture rules have one unit-tested source of truth by design):

```ts
/** Ctrl/Cmd+A: select every visible row, keeping the anchor if it is still visible. */
export function selectAll(s: SelectionState, visibleOrder: readonly string[]): SelectionState;
```

| Input | Result |
|---|---|
| `visibleOrder` empty | `clearSelection()` — nothing visible, nothing selected, no anchor |
| `s.anchor` present in `visibleOrder` | `selected = new Set(visibleOrder)`, `anchor` unchanged |
| `s.anchor` null or not visible | `selected = new Set(visibleOrder)`, `anchor = visibleOrder[0]` |

Invariants (the same ones §3 of the 2026-06-27 spec states for the family): inputs are never
mutated; a fresh `SelectionState` is returned; after `selectAll` every selected path is in
`visibleOrder`, and `anchor` is non-null whenever the order is non-empty.

**One refactor, no behaviour change:** `focusRow(p)` in `webview/components/right-pane.tsx` gains a
selection mode so the three new gestures reuse its scroll-into-window + rAF DOM-focus machinery
instead of duplicating it:

```ts
type FocusMode = 'replace' | 'extend' | 'preserve';
const focusRow = (p: string | null, mode: FocusMode = 'replace') => …
```

- `replace` — `setSelection(selectOne(p))`, today's behaviour and the default, so every existing
  call site is unchanged.
- `extend` — `setSelection((s) => selectRange(s, p, visibleOrder(rootsRef.current)))`.
- `preserve` — move focus only; the selection is not touched.

It stays **one** function: the scroll/window/focus dance (virtualized rows must be scrolled into the
window before they exist to focus) is the part worth not duplicating.

**The `if (mod || e.altKey) return;` guard stays.** It exists because letting modified keys fall
through the switch swallowed the app's own chords — Alt+Left/Right (nav back/forward) died on a
selected file row. The new chords are handled **above** it and each calls `preventDefault()`; the
app's window-level shortcut handler bails on `e.defaultPrevented` (`webview/app.tsx`
`onKeyBubble`), which is what stops a double-fire. Every chord not explicitly listed in §2 still
falls through the guard untouched.

**Platform:** the toggle/select-all modifier is `e.ctrlKey || e.metaKey` (the existing `mod` local),
matching the pointer path's Ctrl-on-Windows/Linux, Cmd-on-macOS split.

## 4. Edge cases & failure modes

| Condition | Expected behaviour |
|---|---|
| `Shift+Arrow` with **no anchor** (nothing ever clicked/focused) | `selectRange` falls back to `selectOne` on the newly focused row — the run starts there. Already the model's contract; no new branch. |
| `Shift+Arrow` at the **first/last** visible row | `nextVisiblePath` returns the current row, so the range recomputes to the same set. A no-op, not an error — matches the unmodified-arrow clamp. |
| `Shift+Arrow` with the **anchor no longer visible** (its folder collapsed) | `reconcile` already cleared the anchor; `selectRange` falls back to `selectOne`. |
| `Ctrl+A` on an **empty tree** | `clearSelection()`; the announcement is suppressed (§7 — "Selected 0 items" is noise, and there is nothing to act on). |
| `Ctrl+A` **twice** | Idempotent: same set, same anchor, no focus move. |
| `Ctrl+Space` on the **only** selected row | Selection becomes empty; anchor stays on that row (`toggle`'s existing VS Code parity). Focus does not move, so a follow-up `Shift+Arrow` re-ranges from there. |
| `Ctrl+Space` with **no roving row** (empty tree) | No-op. |
| A gesture while an inline **draft** (create/rename) is open | Unchanged: `onTreeKeyDown` returns immediately while `draft` is set, so the draft input owns every key. |
| Collapsing a folder after `Ctrl+A` | `reconcile` prunes the now-hidden descendants exactly as it does for a pointer selection; no keyboard-specific path. |
| A watcher refresh changes the visible order mid-gesture | Each gesture reads `visibleOrder(roots)` at handling time, and `reconcile` prunes afterwards; the worst case is a range over the order the user was looking at. |
| `Ctrl+A` while the **tree is not focused** | Never reaches this handler (it is bound to the tree scroller's `onKeyDown`), so the browser's own select-all elsewhere is unaffected. |
| Roving row **virtualized off-screen** | `focusRow` scrolls it into the window before focusing, for all three modes — the reason the modes share one function. |
| An unhandled chord (`Alt+ArrowLeft`, `Ctrl+Shift+P`, …) | Falls through the retained guard, reaches the window handler, behaves as today. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Select-all combo | `Ctrl/Cmd+A` | No | Universal; and it is **not** in `SHORTCUT_ACTIONS`, so nothing is shadowed. |
| Toggle-focused-row combo | `Ctrl/Cmd+Space` | No | VS Code / OS tree convention; also unbound app-wide. |
| Range combo | `Shift+Arrow/Home/End` | No | Universal convention; mirrors Shift-click. |
| Shift re-ranges from a **fixed** anchor | Yes | No | VS Code; identical to the pointer path so the two compose. |
| `Ctrl+Arrow` moves focus without selecting | Yes | No | VS Code / Windows Explorer; the only way to reach a row you want to `Ctrl+Space` without disturbing the set. |
| `Ctrl+A` announces the count | Yes | No | The one gesture whose effect is off-screen (rows below the fold). Per-row selection changes stay silent — over-announcing is worse (2026-06-27 §10). |
| Selection persistence | None | No | Unchanged; transient UI state. |

No new user-facing settings. These are interaction conventions, not preferences.

## 6. Scope slicing

- **MVP (this spec, must):** the five gesture rows in §2; `selectAll` + its unit tests; the
  `focusRow` mode split; the `Ctrl+A` announcement; the e2e in §10.
- **Out of scope (explicit):** `Shift+Space` (extend-and-toggle), `Ctrl+Shift+Arrow` additive range,
  type-ahead, marquee, `Shift+F10` on the tree, PageUp/PageDown navigation (the tree has none
  today, modified or not — adding it is a nav feature, not a selection one), any pointer or menu
  change.

## 7. Acceptance criteria (declarative — LITE)

- Pressing `Ctrl/Cmd+A` with the tree focused selects **every** visible row (`.filerow--selected`
  count and `[aria-selected="true"]` count both equal the visible row count).
- Pressing `Shift+ArrowDown` twice from a single selected row yields **3** selected rows; a
  following `Shift+ArrowUp` yields **2** — it shrinks, it does not invert or grow.
- Repeated `Shift+ArrowDown` never moves the anchor: the run always spans anchor→focus.
- `Ctrl/Cmd+ArrowDown` after `Ctrl+A` leaves the selected count unchanged and moves the roving row
  (`tabIndex=0` / `document.activeElement`) by one.
- `Ctrl/Cmd+Space` on a row inside the selection removes exactly that row (count N → N−1) and moves
  no focus; pressing it again restores it.
- With a selection built **only** from the keyboard, right-clicking one of the selected rows opens
  the menu reading `Delete <N> items` — the keyboard path reaches the selection-aware menu.
- `Alt+ArrowLeft` / `Alt+ArrowRight` with a tree row focused still perform nav back/forward (the
  retained guard); an unmodified `ArrowDown` still collapses the selection to one row; `Escape`
  still clears.
- `Ctrl+A` announces `Selected <N> items` on the tree's existing `aria-live` region, via
  `countNoun`, so `Selected 1 items` is unreachable. No second live region is added.
- `selectAll` over an empty order returns an empty selection with a null anchor; over a non-empty
  order it preserves a still-visible anchor and seats a missing one at index 0.

## 8. State catalog (UI)

Selection has no loading, error, offline, permission or saving states — it is synchronous
renderer-local state. The states this feature adds are *how a state is reached*, not new states:

| Component | State | What the user sees | Reached by |
|---|---|---|---|
| File tree | No selection | No row highlighted | `Escape`; `Ctrl+Space` toggling the last row off |
| File tree | Single selection | One row highlighted, roving focus ring on it | unmodified arrows/Home/End (unchanged) |
| File tree | Multi selection (**new via keyboard**) | Every selected row carries `filerow--selected` + the accent bar; the **focused** row additionally carries the focus ring, which is what distinguishes it from the rest | `Shift+Arrow/Home/End`, `Ctrl+A`, `Ctrl+Space` |
| File tree | Focus outside the selection (**new**) | The focused row shows the focus ring but **no** selected fill — a state the pointer path cannot produce | `Ctrl+Arrow` / `Ctrl+Home` / `Ctrl+End`; `Ctrl+Space` toggling the focused row off |
| File tree | All selected | Every visible row highlighted; live region reads `Selected N items` | `Ctrl+A` |
| File tree | Inline draft active | Unchanged — the draft input owns every key | — |

The "focus outside the selection" row is the one genuinely new visual state, and it needs no new
styling: `.filerow`'s focus ring and `.filerow--selected`'s fill are already independent, so the
combination renders correctly today (verified by reading the existing rules, not by adding one).

## 9. Interaction inventory, accessibility & i18n (UI)

| Component | Pointer | Keyboard | Touch | ARIA |
|---|---|---|---|---|
| File row | unchanged (plain / Ctrl / Shift click) | **new:** `Ctrl/Cmd+A`, `Shift+Arrow/Home/End`, `Ctrl/Cmd+Arrow/Home/End`, `Ctrl/Cmd+Space`; unchanged: arrows, `Enter`, `F2`, `Delete`, `Ctrl+X/C/V`, `Escape` | unchanged | `role="treeitem"`, `aria-selected`, roving `tabIndex` — all already present, none added |
| Tree container | unchanged | owns `onKeyDown`; keeps the tab stop when the roving row is virtualized out | — | `role="tree"`, `aria-multiselectable="true"`, `aria-label="Files"` — unchanged |

**Accessibility.** This feature *is* the a11y fix: it closes the WCAG 2.1.1 (Keyboard) gap the
2026-06-27 spec flagged as D2 and the 2026-08-16 spec re-flagged as its honest limit — every
selection-scoped action (bulk delete, cut/copy N, copy N paths) had a keyboard path to *invoke* it
but no keyboard path to *build the selection it acts on*. Specifically:

- `aria-selected` and `aria-multiselectable` already exist and stay correct: each gesture writes the
  same `SelectionState` the pointer writes, and the row's `aria-selected` is derived from it.
- The **focused** row is distinguished from merely-selected rows by the focus ring, not by fill —
  required now that focus and selection can diverge (`Ctrl+Arrow`).
- **Announcement:** `Ctrl+A` is the only gesture whose effect extends past the viewport, so it — and
  only it — announces `Selected <N> items` on the tree's existing `liveRef` region, through the
  shared `countNoun` from `src/menu-selection.ts`. Shift+Arrow and Ctrl+Space move focus, and the
  focused row's own accessible name/state is announced by the screen reader for free; adding a
  live-region message per arrow key would be the over-announcing 2026-06-27 §10 rejected.
- No new focus treatments, no colour-only signals, nothing animated — reduced-motion and
  forced-colors are unaffected.

**i18n.** The app has no i18n framework (hardcoded English), unchanged. This feature adds exactly
**one** user-visible string, `Selected <n> items`, and it goes through `countNoun` — the same seam
every other count-bearing string in the Explorer uses — so the plural is isolated in one pure
function rather than concatenated ad hoc. No RTL work (the app has no RTL support; tree indentation
is leading-edge `paddingLeft`, unchanged).

**Design tokens.** None added. No new visual affordance — the feature reuses `.filerow--selected`
and the existing focus ring across all three themes (Aero, Aero Dark, Neon).

## 10. Verification

- **Unit — `test/unit/file-tree-selection.test.ts`** (extend, don't add a file):
  - `selectAll`: empty order → cleared; anchor preserved when still visible; anchor seated at
    `visibleOrder[0]` when null or vanished; input not mutated; idempotent.
  - Range/anchor semantics of the new gestures, expressed against the pure model as the handler
    composes it (`selectRange(s, nextVisiblePath(order, focus, dir), order)`): repeated
    "Shift+ArrowDown" **grows** from a fixed anchor; a following "Shift+ArrowUp" **shrinks** the run
    rather than inverting it; `Shift+End` / `Shift+Home` range to the last / first row with the
    anchor still fixed; `Ctrl+Space` (`toggle`) removes one row from a run and moves the anchor.
- **Real-app e2e — `test/e2e/explorer-keyboard-multiselect.e2e.mjs`**, modelled on
  `explorer-multiselect.e2e.mjs` (same `mkdtempSync` flat-file project, same `.filerow` locators,
  same dual `.filerow--selected` + `[aria-selected="true"]` assertion). Click a row to seat focus,
  then drive **real keys**: `Shift+ArrowDown` ×2 → 3 selected; `Shift+ArrowUp` → 2; `Ctrl+A` → all;
  `Ctrl+ArrowDown` → still all selected, roving row moved; `Ctrl+Space` → one toggled off. Then the
  payoff: right-click a selected row and assert the menu's last item reads `Delete <N> items`,
  proving the keyboard path reaches the selection-aware menu. `Escape` closes the menu; **nothing is
  deleted**.
- `npm run typecheck` (both tsconfigs) and `npm run verify` are the gate as always.

## 11. Assumptions

- **`Ctrl+A` / `Ctrl+Space` shadow no app shortcut.** Verified by reading `webview/shortcuts.ts`:
  `SHORTCUT_ACTIONS` binds no `Mod+A` and no `Mod+Space` (the `Mod+…` letters in use are
  P/B/N/W/S/Z/,/Shift+P/Shift+B/Shift+A/Shift+R/Shift+F/Shift+G/Shift+E/Shift+N/Shift+O/Shift+T/
  Shift+Z/Shift+\`, plus the literal-`Ctrl` nav set on Tab/PageUp/PageDown/\`/1–9). `Mod+Shift+A`
  (open architecture canvas) is a **different** combo — the tree handler requires `!e.shiftKey` for
  select-all, so it cannot swallow it. Nothing elsewhere in the renderer keys on `Ctrl+A`/`Ctrl+Space`.
- The tree's visible order for keyboard ranges is `visibleOrder(roots)` — the same array the pointer
  path and `nextVisiblePath` already use.
- The window-level shortcut handler runs **after** the tree's React `onKeyDown` and bails on
  `e.defaultPrevented` (`webview/app.tsx` `onKeyBubble`), so `preventDefault()` on each handled
  chord is sufficient to prevent a double-fire. Verified by reading it.
- `Ctrl+Space` is not intercepted by an IME on the platforms in scope; if it proves to be on a
  particular Windows IME setup, `Ctrl+Space` remains additive (Shift+Arrow and Ctrl+A still work)
  and a rebind would be the fix. Not built.
- Rows are virtualized, so a keyboard target may not be mounted; `focusRow` already handles this and
  all three modes go through it.

## 12. Decisions Needed (autonomous mode — none blocking)

Every gesture in §2 was **pinned by the conductor** before this spec was written, so there is no
open design question to flag. Recorded for completeness, all `normal`, all reversible:

- **[normal] K1 — `Ctrl+A` does not move focus.** Default taken: focus stays where it is. Moving it
  to the first row would scroll the tree away from what the user was looking at, and the anchor rule
  already covers the "where does a follow-up Shift+Arrow range from" question.
- **[normal] K2 — Only `Ctrl+A` announces.** Default taken: no announcement for Shift+Arrow /
  Ctrl+Space; the focused row's own state is announced by the AT. Reversible (one call site).
- **[normal] K3 — `Ctrl+Space` does not move the roving focus.** Default taken: focus stays on the
  toggled row, matching Ctrl-click's "the row you acted on stays the active one" while keeping the
  gesture repeatable without re-navigating.

## 13. Open questions

None. Autonomous run; §12 records what would otherwise have been asked.

## Self-audit

Core spine: problem frame ✓ (job, actors, observable outcomes, explicit non-goals) · behavior &
states ✓ (the gesture table + a worked sequence that doubles as the e2e script) · data/interface
contract ✓ (`selectAll` semantics table + invariants, the `focusRow` mode split, the retained guard
and *why*, the platform modifier) · edge cases ✓ (12 rows: no anchor, clamps, stale anchor, empty
tree, idempotence, draft, collapse, concurrent refresh, unfocused tree, virtualization, unhandled
chords) · defaults vs. settings ✓ (7 rows, none configurable, each with a rationale) · scope
slicing ✓ (MVP + an explicit out-of-scope list carrying every stated non-goal) · acceptance criteria
✓ (declarative, per LITE — EARS/Gherkin deliberately **not** produced; padding a LITE spec is the
defect this skill guards against). UI module walked despite the tier: state catalog ✓ (incl. the one
genuinely new state — focus outside the selection — and the note that it needs no new styling) ·
interaction inventory ✓ · accessibility ✓ (this feature *is* the WCAG 2.1.1 fix; announcement policy
argued, not assumed) · i18n ✓ (one new string, routed through `countNoun`) · design tokens ✓ (none).
Assumptions ✓ (5, including the shortcut-collision check with the evidence). Decisions ✓ (3 normal,
0 high). Nothing left unaddressed; no section padded.

SPEC: docs/specs/2026-08-17-explorer-keyboard-multiselect.md
TIER: LITE
DECISIONS_NEEDED: 3 (highest: normal)

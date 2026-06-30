---
status: active
date: 2026-06-30
---

# Feature Spec: Per-tab scroll & view-state memory

**Tier:** FULL   **Feature type:** UI
**One-line request:** "Each tab needs to remember its scroll position and where it was before switching."

> Authoring note (per CLAUDE.md / ADR 0003): this spec is the durable *why*. Code
> comments added during the build should be one-line pointers here, not re-explanations.

## 1. Problem frame

- **Job (JTBD):** *When I switch away from a tab to do something else and come back,
  I want it exactly where I left it — same scroll position, same cursor — so I don't
  lose my place and have to re-find it.* This is table-stakes editor behaviour
  (VS Code, browsers); its absence makes the center pane feel lossy.
- **Actors / roles:** the single local desktop user driving the Conduit center pane.
  No multi-user, no remote actor.
- **Success outcomes (observable):**
  - Switching from tab A to tab B and back to A restores A's scroll offset (and,
    where cheap, its cursor/selection/zoom) to within a row of where it was.
  - The same holds when switching the *active session* (each session already
    restores its last-active doc via `activeBySession`; that doc must now also
    restore its scroll).
  - Behaviour is indistinguishable from "the tab never unmounted" for the common
    case (scroll back to where you were).
- **Non-goals (explicitly out of scope):**
  - Restoring scroll/cursor across an app **restart** for kinds other than the file
    editor (see §5/§6 — file editors get a minimal restart-persist because they
    already persist; everything else is in-session only).
  - Cross-window / multi-window doc-state sync (a known separate follow-up; see the
    editor-tab-behavior archived spec).
  - Persisting *content* edits, undo history, or find-state — out of scope; only
    view position/state.
  - Changing the mount model of terminals / web tabs (they already stay mounted and
    keep their scroll for free — see §2).
  - Remembering scroll inside transient surfaces that aren't tabs (panels, modals,
    the inline commit-detail pane inside History — except as noted for History's
    own list scroll).

## 2. Behavior & states

### Why state is lost today (root cause)

In `webview/components/center-pane.tsx`, only the **active** non-web doc is rendered:
`showDoc && activeDoc && (… ReviewView / GitHistoryView / CommitDiffView / DocView …)`.
Switching tabs therefore **unmounts** the previously active viewer and **remounts**
it on return. Every viewer holds its scroll/view state in component-local
`useState`/`useRef`/DOM, so it is destroyed on unmount and reset on remount.

Two kinds are already exempt because they are kept mounted (hidden via
`display:none`) precisely so they don't reload:
- **Terminals** (`termstack`) — xterm keeps its own scrollback.
- **Web tabs** (`webDocs.map`) — keep the page warm.

So the fix targets the **unmount/remount** kinds: `file` (code / markdown / image /
pdf sub-viewers), `diff`, `commit-diff`, `review`, `git-history`.

### Primary flow (happy path)

1. User scrolls/positions a tab (e.g. scrolls a code file to line 800).
2. User switches to another tab (the source viewer unmounts).
3. The unmounting viewer's current view position has already been captured into a
   renderer-side **view-state store** keyed by doc id (captured live/debounced on
   scroll, with a final capture on unmount).
4. User switches back (the viewer remounts).
5. On mount, the viewer reads its saved state from the store and restores it
   **before/at first paint** (no visible jump from top→saved position).

### States / transitions

| State | Trigger | Behaviour |
|---|---|---|
| **Pristine** | Doc opened for the first time | No saved state → default position (top), unless an explicit reveal target is staged (go-to-definition / jump-to-hunk) which wins over restore. |
| **Captured** | User scrolls / moves cursor / zooms | Debounced write to the store under the doc id. |
| **Restoring** | Viewer mounts and a saved state exists | Apply saved position synchronously enough to avoid a flash; then resume normal interaction. |
| **Reveal-overrides-restore** | Doc opened/activated *with* a staged reveal (e.g. clicked a hunk, go-to-def, terminal path link with line) | The explicit navigation target wins; saved scroll is ignored for that activation (and the new position becomes the captured state). |
| **Evicted** | Tab closed (`close`/`closeSession`) | Its entry is removed from the store (no unbounded growth, no stale restore if the same id reopens fresh). |
| **Stale measurements** | Content/layout differs on remount (file changed on disk, font-size changed, window resized) | Restore is best-effort to the nearest valid position; never throw, never strand the user past content end. |

## 3. Data / interface contract

This is renderer-internal (no new IPC for the in-session MVP). The contract is the
view-state store module.

- **Store shape:** a module singleton (mirrors existing seams `webview/dirty-store.ts`,
  `webview/save-registry.ts`, `webview/project-index.ts`):
  `Map<docId, ViewState>` with `get(id)`, `set(id, state)`, `delete(id)`.
- **`docId`:** the existing `OpenDoc.id` (`${kind}:${path}`). Stable across switches;
  for the preview `commit-diff:@preview` slot the id is reused as its target
  changes, so its saved state is intentionally tied to the *slot*, not the target —
  acceptable (see §4, Decisions).
- **`ViewState` (discriminated by kind).** Critically, **px `scrollTop` is only safe
  for fixed-layout scrollers**; windowed/variable-height and zoomable surfaces store
  a layout-independent **anchor** instead (a px offset means a different place once
  estimated heights resolve or the scale changes — see §4):
  - `scroll` (**fixed-layout only**): `{ kind: 'scroll'; top: number; left?: number }`
    — the container's `scrollTop`/`scrollLeft` in px. Used for **markdown**,
    **diff/commit-diff**, and **git-history** (history is fixed-height `ROW_HEIGHT`
    virtualization, so px is stable).
  - `monaco`: `{ kind: 'monaco'; state: monaco.editor.ICodeEditorViewState | null }`
    — from `editor.saveViewState()`; restores scroll **+ cursor + selection +
    folding** in one call via `editor.restoreViewState()`. Monaco tolerates a stale
    state against changed content.
  - `reviewAnchor` (**windowed list**): `{ kind: 'reviewAnchor'; topPath: string;
    offset: number }` — the path of the top-most visible review card plus the px
    offset *within* that card. Restoring computes the card's current top from the
    same height table (`measuredRef`/estimate) and adds `offset`. A raw `scrollTop`
    is wrong here because `review-view.tsx`'s `measuredRef` is per-instance and
    starts estimate-based after a remount (see §4).
  - `image`: `{ kind: 'image'; zoom: number; pan: {x,y}; rotation: number }`. For an
    image opened as a **`diff`** (`image-diff.tsx` renders *two* `ImageStage`s), the
    state holds a `{ left, right }` pair — a single stage's triple doesn't cover it.
  - `pdf` (**anchor, scale-first**): `{ kind: 'pdf'; page: number; pageFraction:
    number; scale: number; fit: FitMode }` — anchor by page index + fraction
    scrolled within that page, not px. On restore, **apply `fit`/`scale` first**,
    then scroll the anchored page into view + fraction (a px offset is meaningless at
    a different scale, and canvases window in asynchronously so `scrollHeight` isn't
    final at mount — see the ready-gate below).
- **Restore-ready gate (per kind).** Restore must run when the content needed to
  position is present, else it clamps to top:
  - Synchronous-content kinds (Monaco model reused, markdown content already in the
    files map) restore in a `useLayoutEffect` (pre-paint, no flash).
  - Async/measured kinds (review measured heights, pdf `baseDims`/canvas layout,
    image natural dims) restore in a one-shot effect **gated on "content/layout
    ready"** (e.g. pdf after `baseDims` set and the anchored page mounts; review
    after first measure pass), then mark restored so it never re-fires on later
    scroll. This is explicit per viewer, not a single global hook.
- **Reveal vs. restore — concrete mechanism.** There is no `line` field on
  `OpenDoc`; explicit navigation already flows through `webview/project-index.ts`
  (`setReveal`/`takeReveal`/`subscribeReveal`) and Monaco's pending-reveal path.
  The gate is: **on mount, a viewer checks for a pending reveal for its path FIRST;
  if one exists, it consumes the reveal and skips the saved-scroll restore** (then
  the revealed position becomes the next captured state). No new signal is invented;
  restore simply yields to the existing reveal seam.
- **Invariants:**
  - Writing a state for an id that is later closed must be cleaned up (eviction).
  - Restoring never blocks interaction and never throws on shape mismatch; fixed
    `scroll` clamps to `[0, scrollHeight - clientHeight]`, anchors fall back to top
    when their `topPath`/`page` no longer exists.
  - The store is the single source of truth for view position; no viewer keeps a
    second copy that could diverge.
  - View state is keyed by `docId`, which **survives an ownership transfer** (re-open
    under another session keeps the same id, `docs.ts` `open` reducer) — this is
    intentional: the position follows the doc, not the session.
- **Restart persistence (file editors only, v1):** extend the existing
  `PersistedDoc` (`src/protocol.ts`) with an optional `scrollTop?: number` (and
  optionally `cursor`/`viewState` — see Decisions D3). `toPersistedDocs()` in
  `webview/docs.ts` already serialises `file` docs to `docs.json`; this rides that
  path. No new IPC message. Non-file kinds are **not** persisted across restart.

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| **Concurrency / rapid tab thrash** | Capture is debounced; the final unmount capture is synchronous so the last position always wins. Restoring is idempotent. |
| **Zero saved state** | Default to top (or the staged reveal target if present). Never error. |
| **Many tabs** | Store is O(open docs); entries evicted on close, so it is bounded by the open-tab count, not history. |
| **File changed on disk while away** | Monaco `restoreViewState` is best-effort; scroll-kind clamps to new content height. Acceptable drift; never crash or scroll into the void. |
| **Reveal target also present** | Explicit reveal (go-to-def, jump-to-hunk, terminal line link) **overrides** saved scroll for that activation (§2). |
| **Review windowing — heights estimate-based on remount** | `review-view.tsx`'s `measuredRef` is **per-instance** and is destroyed on every unmount (not just on font change), so a freshly mounted list starts estimate-based and the first measure pass shifts card tops. A raw px `scrollTop` therefore lands on the *wrong card*. Mitigation: store/restore the **`reviewAnchor`** (top-visible path + intra-card offset) and apply it on the ready-gate after the first measure pass. |
| **Font-size / zoom change while away** | Restore is best-effort to the saved anchor/offset; small drift after re-measure is acceptable (matches today's scroll-anchoring tolerance). |
| **Window resize / pane resize while away** | Restore to saved `scrollTop`, clamped. No attempt to preserve "fraction scrolled". |
| **Source change inside a singleton doc** (Review source working→commit; History filter) | Treated as a **content reset**, not a switch: Review already resets scroll to 0 on `sourceKey` change (keep that). The store key is the doc id, so a source change should *also* reset/replace the saved scroll so a stale offset can't strand the user (align with the existing reset effect). |
| **Preview `commit-diff:@preview` retargets** | Saved state is per-slot; on retarget to a different commit/file, reset the slot's saved scroll (content changed). |
| **Doc reopened after close** | Evicted on close ⇒ reopens pristine (matches "fresh open"). |
| **PDF — scale-dependent, async layout** | Apply `fit`/`scale` **before** scrolling; anchor by page+fraction (not px). Restore only after `baseDims` is set and the anchored page mounts, else the px clamps to a stale short height. |
| **Image diff (two stages)** | `image-diff.tsx` mounts two `ImageStage`s; persist/restore a `{ left, right }` state pair, not one. |
| **Ownership transfer keeps the doc id** | Re-opening a file under a different session transfers ownership but keeps `docId` (`docs.ts` `open`); saved view state intentionally follows the doc. |
| **Browser-preview fallback (`window.agentDeck` absent)** | Pure renderer feature; works in preview. Restart-persist simply no-ops where host persistence is absent (guard already exists). |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Restore scope (in-session vs restart) | In-session for all kinds; restart only for `file` scroll (rides existing docs.json) | No | 80% value is "switch and come back"; restart-restore for non-file kinds adds payload/complexity for little gain. |
| Per-kind richness | Monaco: full view state (cursor+selection+folding) — it's one cheap call. Others: scroll (+ image/pdf zoom/scale, which would otherwise also reset jarringly) | No | `saveViewState`/`restoreViewState` is free and matches VS Code. Image/pdf zoom reset-on-return is as jarring as scroll, so include it. |
| Where state lives | Renderer in-memory module store keyed by doc id | No | Matches existing dirty-store/save-registry/project-index seams; host holds no per-tab view position. |
| Eviction | On tab/session close | No | Bounds memory; guarantees fresh reopen. |
| Reveal vs restore precedence | Reveal wins | No | An explicit navigation must not be overridden by a stale scroll. |
| No user-facing toggle | n/a | No | This is corrective baseline behaviour, not a preference; nothing to expose. |

## 6. Scope slicing

- **MVP (must):**
  - View-state store module + eviction on close/closeSession.
  - Restore on remount for: **code editor (Monaco full view state)**, **markdown
    scroll (px)**, **review list (anchor: top-path + offset)**, **diff scroll (px)**,
    **git-history list scroll (px — fixed-height, safe)**.
  - Capture-on-scroll (debounced) + capture-on-unmount; per-kind restore-ready gate.
  - Reveal-overrides-restore precedence via the existing project-index reveal seam.
- **v1 (should):**
  - **Image** pan/zoom/rotation (incl. the two-stage image-diff pair) and **PDF**
    page+fraction/scale/fit restore (scale-first, anchor-based).
  - **commit-diff** (preview + pinned) scroll restore with slot-reset on retarget.
  - File-editor **scrollTop** persisted across restart via `PersistedDoc.scrollTop`.
- **Vision (could):**
  - Full Monaco view state persisted across restart (cursor/folding survive a
    relaunch).
  - Cross-window restore.
- **Out of scope:** content/undo/find-state persistence; non-file restart persist;
  terminal/web changes (already correct).

## 7. Acceptance criteria

### Declarative
- Scrolling a tab, switching away, and returning restores the prior scroll position
  to within ~1 row, with no visible top→position jump.
- A code file additionally restores its cursor, selection, and folding state.
- An explicit jump (go-to-definition, jump-to-hunk, terminal line link) on
  open/activate overrides any saved scroll.
- Closing a tab discards its saved state; reopening the same path starts at the top.
- Switching the active session restores that session's last-active doc *and* that
  doc's scroll position.
- Image zoom/pan and PDF page/zoom survive a tab switch (v1).
- A file editor's scroll position survives an app restart (v1); other kinds do not.

### EARS
- **Event:** When a viewer is unmounted due to a tab/session switch, the system
  shall persist its current view position to the view-state store under its doc id.
- **Event:** When a viewer mounts and a saved view state exists for its doc id and
  no explicit reveal target is staged, the system shall restore that view state
  before the first user-perceivable paint.
- **State:** While a doc is the active tab, the system shall keep its stored view
  state updated as the user scrolls (debounced).
- **Unwanted:** If a stored scroll offset exceeds the current content height (file
  shrank, font changed), then the system shall clamp the restore to the valid range
  rather than leaving the viewport beyond content.
- **Unwanted:** If both a saved scroll and a staged reveal target exist for an
  activation, then the system shall apply the reveal target and ignore the saved
  scroll for that activation.
- **Event:** When a tab is closed (or its session closes), the system shall evict
  its view-state entry.
- **Optional:** Where the doc is a `file` editor, the system shall persist its
  scroll offset across app restart via the existing docs.json path.

### Gherkin (key flows)

```gherkin
Feature: Per-tab scroll & view-state memory
  Background:
    Given two tabs A (a long code file) and B are open

  Scenario: Restore scroll on tab switch
    Given I scroll tab A to line 800
    When I switch to tab B and back to tab A
    Then tab A is scrolled to line 800
    And my cursor and folding in A are unchanged

  Scenario: Explicit reveal overrides saved scroll
    Given tab A has a saved scroll at line 800
    When I trigger "Go to Definition" that targets line 30 in tab A
    Then tab A is revealed at line 30
    And line 30 becomes the new saved position

  Scenario: Closing a tab forgets its position
    Given tab A is scrolled to line 800
    When I close tab A and reopen the same file
    Then the file opens at the top

  Scenario: Session switch restores the doc and its scroll
    Given session S1's last-active tab was scrolled to line 500
    When I switch to session S2 and back to S1
    Then S1's last-active tab is shown scrolled to line 500
```

## 8. State catalog (UI)

The feature adds *no new visible component*; it changes the restored state of
existing viewers. The relevant per-viewer states:

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Code editor (Monaco) | Restored | Same scroll + cursor + selection + folding as before switch | none (automatic) |
| Code editor | Reveal-override | Centered on the jump target line | none |
| Markdown viewer | Restored | Same scroll offset; TOC active-heading re-syncs from position | none |
| Review list | Restored | Same list scroll; per-card fold/collapse already cached, now scroll too | none |
| Review list | Source-changed | Reset to top + SR announcement (existing behaviour preserved) | none |
| Diff / commit-diff viewer | Restored | Same scroll offset | none |
| Git-history list | Restored | Same list scroll (virtualized window re-derives from scrollTop) | none |
| Image viewer | Restored (v1) | Same zoom/pan/rotation | none |
| PDF viewer | Restored (v1) | Same page/scroll/scale/fit | none |
| Any viewer | Pristine / cleared | Top of content (fresh open or after close) | none |

No loading/error/empty states are introduced by this feature; existing viewer
loading/empty/error states are unchanged. Restore fires on the per-kind
**restore-ready gate** (§3): synchronous kinds restore pre-paint in a layout effect;
async/measured kinds (review measured heights, pdf `baseDims`+anchored page, image
natural dims) restore once that content is ready and then mark themselves restored so
later scrolls don't re-trigger it.

## 9. Interaction inventory (UI)

The feature is passive (no new affordances), so the inventory is about *not breaking*
existing interactions and about focus.

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Scroll restore (all viewers) | none (automatic on mount/unmount) | preserves wheel/drag scroll | preserves PageUp/Down/Home/End/arrows | preserves swipe scroll | unchanged | no new roles; must not steal focus on restore |
| Monaco restore | none | unchanged | cursor/selection restored but **focus not forcibly grabbed** unless it was a reveal | unchanged | unchanged | editor remains the same widget |

Rules honoured:
- Restoring scroll/cursor must **not** auto-focus the viewer on a plain tab switch
  (that would hijack keyboard from elsewhere). Focus is only moved on an explicit
  reveal/open, which already focuses today.
- No drag-only paths added; nothing to make keyboard-accessible beyond existing
  scroll keys, which continue to work.

## 10. Accessibility & i18n (UI)

**Accessibility (WCAG 2.2):**
- **Keyboard operability:** unaffected; all existing scroll/navigation keys keep
  working. Restore uses the same scroll mechanics keyboard users drive.
- **Focus management:** restore on a plain switch **must not** move focus or the
  document scroll-to-focus; only restore the viewport. On an explicit reveal, focus
  behaviour is unchanged from today (editor focuses, line centered). This avoids the
  classic a11y trap where returning to a tab yanks focus.
- **Visible focus:** unchanged; restoring a Monaco selection re-shows the existing
  selection styling.
- **Announce dynamic results:** a silent scroll restore needs **no** live-region
  announcement (it's a return to a known place, not a new event) — adding one would
  be noise. The existing Review source-change and window-jump announcements are
  preserved.
- **Reduced motion:** restore must be an **instant** jump to the saved position, not
  a smooth animated scroll — both faster and respectful of reduced-motion. (Explicit
  reveals keep their existing smooth/instant behaviour, which already honours
  `prefers-reduced-motion` in pdf-viewer.)
- **Color:** n/a (no new visuals).

**Internationalization:**
- **No new user-facing strings** are introduced. (If any debug/announce string were
  added, it would be externalised — but none is required.)
- **RTL:** if horizontal scroll is ever restored (`left`), respect the document
  direction; for the MVP only vertical `top` is restored, which is direction-neutral.
- No dates/numbers/pluralization surfaced by this feature.

## 11. Design tokens (UI)

None. This feature renders nothing new — no colours, spacing, or typography. No
token work required. (Stated explicitly so the self-audit isn't flagged.)

## 12. Assumptions

- The doc id (`${kind}:${path}`) is a stable, collision-free key for view state for
  all non-preview docs (confirmed in `webview/docs.ts`).
- A renderer-side module store (not React context) is the right home, matching
  `dirty-store.ts` / `save-registry.ts` / `project-index.ts`. Reversible.
- Capturing on scroll (debounced ~100–150ms) plus a synchronous capture in the
  viewer's unmount cleanup is sufficient to never lose the last position. Reversible.
- For Monaco, a single `saveViewState`/`restoreViewState` pair is preferred over
  hand-rolling scrollTop/cursor; the model is already reused across remounts so the
  editor instance is fresh but the model/content is stable.
- Terminals and web tabs are intentionally excluded (already preserved by staying
  mounted) — confirmed in `center-pane.tsx`.
- Review's existing per-card UI cache (folds/collapse) and its scroll-reset-on-source
  -change are kept; this feature only *adds* anchor-based list-scroll memory keyed by
  doc id.
- Image restore requires `usePanZoomStage` (currently resets on `resetKey: src` and
  tracks an internal `userZoomed` flag) to accept a seed/initial value; that small
  hook extension is in scope for the image (v1) slice, not a separate feature.
- The git-history inline commit-detail pane height is already persisted
  (`historyDetailHeight`); only the *commit-list scroll* is in scope here.

## 13. Decisions Needed (autonomous mode)

- **[high] D0 — Save/restore store vs. keep-mounted-hidden.** Default taken:
  **save/restore store** (this spec). The *alternative*, used today for web/terminal
  tabs in `center-pane.tsx` (render inactive docs under `display:none` instead of
  unmounting), would preserve **everything for free** — Monaco cursor/selection/
  folding/find/undo, review/pdf/image state, scroll — with no capture/restore code at
  all. The reason this spec does **not** default to it: keeping N Monaco editors, PDF
  canvas stacks, and image bitmaps mounted is a real memory/GPU cost the current
  design deliberately avoids (only web/terminal, which are singular and cheap to keep
  warm, stay mounted). *Conductor: confirm the save/restore approach.* A cheaper
  middle path is possible — keep only the **active + most-recently-used** doc mounted
  — but adds its own LRU complexity. This is the single most important call; tagged
  `high` because it changes the entire implementation shape (though both paths are
  reversible and ship the same observable behaviour).
- **[normal] D1 — Restart persistence scope.** Default taken: persist **file-editor
  scrollTop only** across restart (rides `PersistedDoc`/`docs.json`); all other kinds
  in-session only. Safest minimal extension. *Confirm whether non-file kinds should
  also survive restart (they currently don't even restore their last-active state
  uniformly).* If "no", nothing changes.
- **[normal] D2 — Richness for the code editor.** Default taken: restore **full
  Monaco view state** (scroll + cursor + selection + folding) in-session, since it's
  one free call. *Confirm this is desired vs. scroll-only* (scroll-only would be
  surprising given the model is reused and VS Code restores all of it).
- **[normal] D3 — What to persist across restart for files.** Default taken:
  `scrollTop` only (small, robust). *Confirm whether to also persist the full Monaco
  view state across restart* (larger docs.json payload, but cursor/folding survive a
  relaunch). Leaning scrollTop-only for MVP.
- **[normal] D4 — Image/PDF in MVP or v1.** Default taken: **v1** (image pan/zoom,
  pdf page/scale). Scroll-reset on these is arguably as jarring as a code file's;
  *confirm if they should be pulled into MVP.*
- **[normal] D5 — Capture cadence.** Default taken: debounced scroll capture +
  synchronous unmount capture. *Confirm the debounce window (~120ms) is acceptable;*
  a too-aggressive capture costs renders, too-lazy risks losing a fast switch (the
  unmount capture is the safety net).

One `high`-severity decision (**D0**, the store-vs-keep-mounted architecture call).
All others are `normal`; every default is reversible and the feature degrades
gracefully (worst case = today's behaviour for a given kind). Both D0 paths produce
the same observable behaviour, so even D0 is reversible — it is tagged `high` only
because it dictates the implementation shape and is worth a human glance before build.

## 14. Open questions

(Autonomous run — converted to §13. None blocking.)

---

## Self-audit

- Core spine (§1–§7): complete.
- UI module (§8–§11): §8 state catalog, §9 interaction inventory, §10 a11y/i18n, §11
  tokens — all filled (tokens explicitly "none, here's why"; not skipped).
- §10 covers the load-bearing a11y point for this feature: **focus must not be
  hijacked on restore**, and **restore is instant (reduced-motion-safe)**.
- Decisions (§13) are severity-tagged; one `high` (D0, architecture call).
- No empty/thin sections without justification.
- **Reviewer pass incorporated:** switched windowed/zoomable kinds (review, pdf,
  image-diff) from px to anchor-based restore; pinned the reveal-vs-restore mechanism
  to the project-index seam; defined a per-kind restore-ready gate; added the
  keep-mounted-hidden alternative as D0; noted ownership-transfer state survival.

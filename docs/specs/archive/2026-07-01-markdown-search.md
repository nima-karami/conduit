---
status: active
date: 2026-07-01
---

# Feature Spec: markdown-search (in-rendered-markdown find)

**Tier:** FULL   **Feature type:** UI
**One-line request:** in-rendered-markdown find (Ctrl+F): a find bar scoped to the
markdown viewer that highlights matches, shows a count (e.g. "3/12"), cycles
next/prev (Enter / Shift+Enter), scrolls the current match into view, and closes on
Esc — all WITHOUT switching to the source view.

> Conductor architecture/taste decisions are FIXED and specified to, not
> re-litigated: (1) Ctrl+F is SCOPED to the markdown viewer — it must not hijack the
> global find or fight other panes' Ctrl+F; (2) highlighting uses the CSS Custom
> Highlight API (no DOM mutation, so React reconciliation is untouched); (3) reuse
> the existing find-bar chrome/tokens, no new dependency.

---

## 1. Problem frame

- **Job:** "When I'm reading a long rendered spec/README, let me jump to the word or
  phrase I care about without leaving the nice rendered view." Reading long docs is a
  core north-star flow; today the only find is Monaco's, which requires toggling to
  **View source** — losing headings, tables, code styling, and scroll position.
- **Actors:** anyone reading a `.md` file in the center-pane rendered markdown view.
- **Success outcomes (observable):**
  - Ctrl/Cmd+F over a focused/active rendered markdown view opens a find bar.
  - Typing highlights every match in place and shows `current/total` (e.g. `3/12`).
  - Enter / Shift+Enter cycle forward/back (wrapping); the current match scrolls into
    view and is visually distinct from the others.
  - Esc closes the bar and clears all highlights; the rendered view is unchanged.
  - No source-view toggle is ever required.
- **Non-goals:** regex/whole-word/replace; find across multiple docs; searching the
  raw markdown source (that is Monaco's job in source view); persisting the query
  across doc switches or restarts; find inside the Outline/TOC panel.

---

## 2. Behavior & states

**Primary flow (happy path):**
1. Rendered markdown view is active (focus or selection inside it, or nothing else
   focused). User presses Ctrl/Cmd+F.
2. Find bar appears (top-right overlay), input auto-focused and selected.
3. User types `foo`. All occurrences highlight; the first is marked "current" and
   scrolled to; count reads `1/12`.
4. Enter → advances to `2/12`, scrolls it into view; at `12/12` Enter wraps to
   `1/12`. Shift+Enter goes backward and wraps the other way.
5. Esc → bar closes, highlights cleared, focus returns to the rendered container.

**States / transitions:**

| State | Trigger in | What happens | Trigger out |
|---|---|---|---|
| Closed | default | No bar, no highlights | Ctrl/Cmd+F (viewer owns) → Open/empty |
| Open, empty query | open | Bar shown, focused; no highlights; count blank | type → Matching; Esc → Closed |
| Matching (≥1) | non-empty query with hits | All matches highlighted; current distinct + scrolled; count `n/total` | edit query → recompute; Enter/Shift+Enter → cycle; Esc → Closed |
| No matches | non-empty query, 0 hits | Bar shows `0/0` (or "No results"); no highlight; nav disabled | edit query; Esc → Closed |
| Recomputing (doc.content changed while open) | live doc re-render | ranges rebuilt from new DOM; cursor reset to first | — |

State is UI-only and lives in the viewer (mirrors `term-search` /
`pdf-viewer` find). It is **reset on close** (fresh open starts clean) — consistent
with `termSearchReducer`'s `close` behavior.

---

## 3. Data / interface contract

This is renderer-only; no IPC, no host, no persistence. The contract that matters is
the **pure match module**, extracted so it is unit-testable without a DOM (mirrors
`webview/pdf-find.ts`).

**New module `webview/md-find.ts`:**

```ts
export interface MdMatch { start: number; end: number } // offsets into flattened text

/** Case-insensitive plain-substring matches over a flattened document string, in
 *  reading order, non-overlapping (resume after each hit). Empty/whitespace query → []. */
export function findTextMatches(text: string, query: string): MdMatch[];

/** Stateful cursor: search()/next()/prev() wrap; count + activeOrdinal for the count
 *  display. Parallels PdfFindController — do NOT force-share to avoid coupling the two
 *  viewers, but the shape is identical (see Decision D5). */
export class MdFindController {
  search(text: string, query: string): MdMatch[];
  get count(): number;
  get activeOrdinal(): number;   // 1-based, 0 when empty
  active(): MdMatch | null;
  next(): MdMatch | null;        // wraps; no-op/null when 0
  prev(): MdMatch | null;        // wraps
  setIndexToFirstOnPage?(): void; // not needed here; single flat stream
}
```

- **Inputs:** `text` = the flattened visible text of the rendered container
  (TreeWalker join, see §"Highlight design"); `query` = raw input string.
- **Outputs:** offset ranges `{start,end}` into `text`; the DOM layer maps each to a
  `Range`. Offsets are the *only* thing the pure module knows — no `Node` refs — so it
  stays testable in Node.
- **Invariants:** matches are non-overlapping, in document order; `activeOrdinal ∈
  [1,count]` when `count>0`, else 0; `search` resets the cursor to the first match.

---

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Empty / whitespace-only query | No highlights, count blank, nav disabled — do not treat as a match. |
| No matches | Count `0/0` (styled subtly, e.g. dimmed/warn), nav buttons disabled, no highlight painted. |
| Query changes each keystroke | Recompute from the cached flattened text + range table (debounced ~120 ms); reset current to first and scroll to it. Rebuild the flattened index only when `doc.content` changed, not on every keystroke. |
| Match spans inline elements (`**bold**`, `` `code` ``, links, split text nodes) | A single `Range` may cross text nodes; the CSS Highlight API paints it natively across nodes. Offset→Range mapping must handle start/end in different text nodes. |
| Match inside a highlighted code block | Works — highlight.js emits text nodes inside token `<span>`s; ranges cross them fine. |
| Mermaid diagrams / KaTeX math | **Skip** `svg` (mermaid) and `.katex` subtrees during the TreeWalker so SVG glyphs and duplicated MathML annotation text aren't matched/double-counted (Decision D3). Skip the code-block **Copy** button and `script`/`style`. |
| Doc switch (`doc.path` change) | Clear both highlight registrations + reset find state; a stale `Range` points into an unmounted DOM, and `CSS.highlights` is a **global** window registry that would otherwise leak/paint garbage. |
| Toggle to **View source** | Rendered container unmounts → clear highlights (ranges now dangle) and close the bar; Ctrl+F in source view is Monaco's own find (unchanged). |
| Component unmount (tab close, window teardown) | Effect cleanup deletes `CSS.highlights` entries for this viewer. |
| Live re-render (`doc.content` updates while bar open) | Rebuild flattened text + range table, re-run query, reset cursor to first. |
| Very large doc | TreeWalker + `indexOf` are O(n); fine for READMEs/specs. Debounce input; recompute ranges lazily. No hard cap in MVP; if a pathological doc stutters, a bounded-range cap is a v1 fallback (count still reported accurately). |
| Multiple markdown viewers (split / many md tabs) | Each registers its own document-capture handler and its own `CSS.highlights` keys **namespaced per viewer instance** (e.g. `md-find-<instanceId>`), so only the owning viewer paints; no cross-talk. |
| Another pane focused (terminal, Monaco, input) | Ctrl+F does nothing in the markdown handler (owns-check fails) and does **not** `preventDefault`, so the focused pane's own Ctrl+F still fires. |
| Reduced motion | Scroll-into-view honors `prefers-reduced-motion` (instant vs. smooth), matching pdf-viewer's `scrollToPage`. |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Case sensitivity | Case-**insensitive** | No (MVP) | Matches pdf-find and Monaco's default; the 80% reading flow. A case toggle is v1 (see §6). |
| Matching mode | Plain substring | No | Regex/whole-word are explicit non-goals; keeps the pure module trivial + safe. |
| Query persistence | Not persisted (reset on close) | No | Mirrors `termSearchReducer` close semantics; a stale query on a new doc is more surprising than helpful. |
| Bar placement | Top-right overlay of the viewer | No | Matches `.term-find` position; doesn't cover the Outline/View-source controls. |
| Highlight colors | Semantic tokens (all-match vs. current-match) | Theme-driven only | Consistency with the rest of the app theming. |

---

## 6. Scope slicing

- **MVP (must):** Ctrl/Cmd+F opens a scoped find bar; case-insensitive substring
  highlighting via CSS Custom Highlight API; `current/total` count; Enter/Shift+Enter
  cycle with wrap; current-match distinct style + scroll-into-view; Esc closes +
  clears; correct lifecycle cleanup (doc switch / source toggle / unmount); pure
  `md-find.ts` + unit tests; e2e.
- **v1 (should):** case-sensitivity toggle; whole-word toggle; a small "no results"
  affordance; debounce tuning; bounded-range cap for pathological docs.
- **Vision (could):** find-and-scroll minimap ticks; regex; find-in-all-open-docs.
- **Out of scope:** replace; searching raw source; find in Outline/TOC; persistence
  across docs/restart.

---

## 7. Acceptance criteria

**Declarative:**
- Pressing Ctrl/Cmd+F while the rendered markdown view is active opens the find bar
  with the input focused; it does **not** open when a terminal/editor/other input is
  focused, and does not switch to source view.
- Typing a query highlights every case-insensitive occurrence in place without
  altering the rendered DOM structure (no wrapper nodes injected).
- The count shows `current/total`; with no matches it shows `0/0` and disables nav.
- Enter advances (wrapping past the last to the first); Shift+Enter reverses
  (wrapping past the first to the last); the current match is visually distinct and
  scrolled into view.
- Esc closes the bar, removes all highlights, and returns focus to the rendered view.
- Switching docs, toggling to source, or closing the tab removes all highlights (no
  leftover paint, no console error).

**EARS:**
- *Event:* When the user presses Ctrl/Cmd+F and the rendered markdown view owns the
  interaction, the viewer shall open the find bar and focus its input.
- *Event:* When the query changes, the viewer shall recompute matches, highlight all
  of them, set the current match to the first, scroll it into view, and update the
  count.
- *Event:* When the user presses Enter (Shift+Enter), the viewer shall move the
  current match forward (backward), wrapping at the ends, and scroll it into view.
- *State:* While the query has zero matches, the viewer shall display `0/0` and
  disable the next/previous controls.
- *Unwanted:* If the active document changes, the source view is toggled, or the
  viewer unmounts, then the viewer shall delete its highlight registrations and reset
  find state.
- *Unwanted:* If a non-markdown pane is focused when Ctrl/Cmd+F is pressed, then the
  markdown viewer shall not consume the event (no `preventDefault`).

**Gherkin (key flows):**
```gherkin
Feature: Find in rendered markdown
  Background:
    Given a long markdown document is open in the rendered view

  Scenario: Highlight and count
    When I press Ctrl+F and type "the"
    Then every occurrence of "the" is highlighted in place
    And the count shows "1/<total>"
    And the first match is scrolled into view and marked current

  Scenario: Cycle with wrap
    Given the find bar shows "1/3"
    When I press Enter three times
    Then the current match cycles 2/3, 3/3, then wraps to 1/3
    And each current match is scrolled into view

  Scenario: Close clears state
    When I press Escape
    Then the find bar closes
    And no highlights remain in the document
    And focus returns to the rendered markdown

  Scenario: Scoped, does not hijack other panes
    Given the terminal is focused
    When I press Ctrl+F
    Then the markdown find bar does not open
    And the terminal's own find bar opens
```

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Find bar | Hidden | Nothing | Ctrl/Cmd+F opens |
| Find bar | Open / empty | Search icon + empty input, blank count, dimmed nav | type / Esc |
| Find bar | Matching | `n/total` count, enabled ↑/↓, active input | Enter/Shift+Enter/edit/Esc |
| Find bar | No results | `0/0` (dimmed/warn), disabled ↑/↓ | edit / Esc |
| Match highlight | All matches | Subtle highlight background over matched text | — |
| Match highlight | Current match | Stronger/accent highlight, scrolled into view | Enter/Shift+Enter moves it |

---

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard / shortcuts | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Open find | show bar | — | Ctrl/Cmd+F (viewer owns) | — | — | — |
| Find input | type query | click to focus | text entry; Enter=next, Shift+Enter=prev, Esc=close | tap | native | `aria-label="Find in document"`; container `role="search"` |
| Next / Prev buttons | cycle | click | (Enter / Shift+Enter equiv) | tap | — | `aria-label` "Next/Previous match"; `disabled` when 0 |
| Count | read `n/total` | — | — | — | — | text; consider `aria-live="polite"` so SR announces the count |
| Close button | close + clear | click | Esc | tap | — | `aria-label="Close find"` |

Mirror `term-search-bar.tsx` markup/handlers exactly (Enter/Shift+Enter/Esc on the
input; focus+select on open; `placeholder="Find in document"`). Add a count element
like pdf `FindBox` (`{ordinal}/{count}`). Tab order follows DOM order: input →
count (non-focusable) → prev → next → close; Tab/Shift+Tab cycle within the bar (it's
a small overlay, so no focus trap is required, but focus should not jump into the
rendered content while the bar is open).

---

## 10. Accessibility & i18n

- **Keyboard-complete:** the whole feature is operable from the keyboard (open, type,
  cycle, close) with no pointer required. Esc restores focus to the rendered view so
  scroll keys keep working (mirrors the terminal find's refocus).
- **Focus management:** input auto-focused + selected on open (reuse
  `TermSearchBar`'s effect); on close, focus returns to the markdown container.
- **Screen reader:** `role="search"` on the bar; labelled input and buttons; the
  count uses `aria-live="polite"` so match totals are announced as the query changes.
  Disabled nav buttons carry `disabled` (not just visual).
- **Contrast:** both highlight styles (all + current) must meet contrast against the
  rendered background in light/dark themes; verify the current-match style is
  distinguishable from the all-match style for low-vision users (don't rely on hue
  alone — differ in weight/outline too).
- **Reduced motion:** respect `prefers-reduced-motion` for scroll-into-view.
- **i18n:** all visible strings ("Find in document", aria-labels, an optional "No
  results") are literals to keep consistent with the codebase's current
  no-i18n-framework state; keep them centralized in the component for easy future
  extraction. Matching is Unicode-safe via JS `String` semantics; case-folding uses
  `toLowerCase()` (consistent with `pdf-find`), acknowledged as locale-naive — same
  limitation as the existing find, out of scope to fix here.

---

## 11. Design tokens (UI)

- **Bar chrome:** reuse the existing `.term-find*` classes / tokens (`--panel-2`,
  `--border-2`, `--accent-soft`, `--text`, `--text-dim`, `--text-faint`, `--r-sm`,
  `--font-scale`) so it visually matches the terminal find bar. Add a small count
  element (`.term-find__count`, styled like pdf's `.pdfview__findcount`). See
  Decision D4 on class naming.
- **Highlights** (`::highlight(...)` pseudo, tokens only — no raw hex):
  - `::highlight(md-find-*)` — all matches: a soft search-match background (reuse a
    selection/accent-soft-derived token).
  - `::highlight(md-find-current-*)` — current match: stronger accent background +
    (optionally) a contrasting text color / outline so it reads as "current" even in
    high-contrast. Note `::highlight()` supports a limited property set
    (`background-color`, `color`, `text-decoration`, and a few more) — outline is not
    paintable via the pseudo, so distinction must come from `background-color` /
    `color`; if a border is desired it must be a different mechanism (kept out of MVP).
  - Theme variants: light/dark come free from the tokens; verify high-contrast.

---

## 12. Highlight design (the core mechanism)

**Availability:** `package.json` pins `electron ^42` (Chromium ~140). The CSS Custom
Highlight API (`window.CSS.highlights`, `Highlight`, `::highlight()`) shipped in
Chromium 105 (2022), so it is fully available. This is the preferred approach
precisely because it highlights `Range`s **without mutating the DOM** — no wrapper
`<mark>` nodes — so React's reconciliation of the ReactMarkdown output is untouched
(the reason we can't wrap nodes: it would fight React and corrupt the tree).

**Build the flattened text + range table (DOM layer, in `markdown-viewer.tsx`):**
1. Walk `mdRef.current` with a `TreeWalker(SHOW_TEXT)` whose filter **rejects** text
   inside `svg` (mermaid), `.katex`, the code Copy button, and `script`/`style`.
2. Concatenate each accepted text node's data into one `fullText` string, recording a
   segment table `{ node, start, length }` (start = running offset). Rebuild only when
   `doc.content` changes (cache across keystrokes).
3. `findTextMatches(fullText, query)` (pure) → offset ranges.
4. Map each `{start,end}` offset range to a DOM `Range`: binary-search the segment
   table for the node+local-offset of `start` and of `end`, then
   `range.setStart(node,off)` / `range.setEnd(node,off)`. Start/end may live in
   different nodes (match spans inline elements) — that's fine.

**Register highlights (no DOM writes):**
- `CSS.highlights.set('md-find-<id>', new Highlight(...allRanges))`
- `CSS.highlights.set('md-find-current-<id>', new Highlight(currentRange))`
- CSS: `::highlight(md-find-<id>)` and `::highlight(md-find-current-<id>)`. Because
  the registry is keyed, per-instance ids avoid collisions between multiple viewers.
  (If per-instance CSS selectors are awkward, an equivalent is a single shared key set
  that only the owning viewer populates; per-instance is the safe default — Decision
  D2.)

**Current match + scroll-into-view:**
- Track the current index in `MdFindController`. On change, move it out of the
  all-matches Highlight into the current Highlight (or keep all + a separate
  single-range current highlight painted on top).
- Scroll: use `currentRange.getBoundingClientRect()` relative to the scroll container
  and set `scrollTop` to center it (reuse the container-relative math already in the
  scroll-spy effect), or fall back to
  `currentRange.startContainer.parentElement?.scrollIntoView({block:'center'})`.
  Honor `prefers-reduced-motion`.

**Lifecycle (critical — global registry):** `CSS.highlights` is window-global, so
every open path MUST have a matching clear:
- Esc / close → delete both keys, reset state, refocus container.
- `doc.path` change, source toggle, unmount → effect cleanup deletes both keys.
- `doc.content` change while open → rebuild table + ranges, re-run query.

**Scoping (Decision 1):** reuse the file's existing **document-level keydown capture**
pattern already used for Ctrl+A in `markdown-viewer.tsx`: a `document.addEventListener
('keydown', handler, true)` that acts only when this viewer **owns** the interaction —
`activeElement`/selection anchor inside `mdRef`, **or** the find bar itself is focused,
**or** nothing meaningful is focused (`activeElement === null || document.body`).
Because document-capture fires above descendant panes, the owns-check must be strict:
when it fails, do nothing and do **not** `preventDefault`, so a focused terminal's
`onKeyDownCapture` Ctrl+F (terminal-pane.tsx) still fires. This is exactly how the
existing Ctrl+A coexists with focused inputs/terminals.

---

## 13. Test plan

- **Unit (`test/unit/md-find.test.ts`, mirrors `pdf-find.test.ts`):**
  - `findTextMatches`: empty/whitespace query → `[]`; single/multiple/overlapping
    ("aaaa" for "aa" → non-overlapping); case-insensitivity; matches at string
    boundaries; multi-line text; Unicode.
  - `MdFindController`: `search` resets cursor to first; `count`/`activeOrdinal`;
    `next`/`prev` wrap correctly; no-op on empty; re-`search` replaces matches.
- **e2e / runtime (`test/e2e/markdown-search.e2e.mjs`, shared harness):** open a
  markdown doc in the rendered view; Ctrl+F; type a query; assert highlights present
  (`CSS.highlights.has(...)` / painted ranges) and count text `n/total`; Enter cycles
  the current index (assert scroll change / current key); Shift+Enter reverses; Esc
  closes and `CSS.highlights` is cleared; switching docs clears highlights; confirm
  Ctrl+F with the terminal focused opens the **terminal** find, not the markdown one.
  *(No React component-test infra — RTL/jsdom absent — so component behavior is
  covered via e2e + screenshot, and pure logic via the unit module.)*
- **Screenshot (acceptance artifact):** rendered markdown with the find bar open,
  several matches highlighted, the current match distinct, and the count showing e.g.
  `3/12`.

---

## 14. Assumptions

- The rendered markdown container is `.markdown` (`mdRef`); the find bar renders as a
  sibling inside `.viewer` (like `.term-find` inside `.termpane-wrap`), not inside
  `mdRef`, so it isn't itself walked for matches.
- `CSS.highlights` global registry is acceptable to use with per-instance keys; no
  existing feature uses it (grep found none), so no key collisions today.
- Reduced-motion + container-relative scroll math can be lifted from existing
  effects; no new scroll infra needed.
- No new npm dependency (icons `IconSearch`/`IconClose` already exist; the API is
  built into Chromium).
- Strings stay inline literals (repo has no i18n framework today).

---

## 15. Decisions Needed (autonomous mode)

- **[normal] D1 — Ctrl+F scoping mechanism.** Default: reuse the file's existing
  **document-capture + owns-check** pattern (as Ctrl+A does) rather than adding
  `tabIndex`+local `onKeyDown` (as pdf-viewer does). Rationale: the markdown container
  isn't focusable and the owns-check already handles the "nothing focused" case;
  keeps one consistent pattern in the file. Reversible.
- **[normal] D2 — Highlight registry keying.** Default: **per-viewer-instance keys**
  (`md-find-<id>`) with matching per-instance `::highlight()` selectors, to support
  split/multi-tab markdown without cross-talk. If per-instance CSS proves awkward,
  fall back to a single shared key populated only by the owning viewer. Reversible.
- **[normal] D3 — Excluded subtrees.** Default: skip `svg` (mermaid), `.katex`
  (math), the code Copy button, and `script`/`style` during the TreeWalker, so
  matches are prose/code only and math annotation text isn't double-counted.
  Reversible (can widen later).
- **[normal] D4 — Bar component + class naming.** Default: a **new `MdFindBar`
  component** (behavior differs from `TermSearchBar` — it needs a count) that reuses
  the existing `.term-find*` CSS classes for visual parity, adding one
  `.term-find__count` rule. The `term-` prefix on a markdown bar is a mild naming
  smell; a future refactor could neutralize it to a shared `.find-bar`, but
  refactoring the terminal/pdf bars is out of scope here. Reversible.
- **[normal] D5 — Share vs. duplicate the find controller.** Default: a **dedicated
  `MdFindController`** in `webview/md-find.ts` even though its shape mirrors
  `PdfFindController`, to avoid coupling two viewers through one class. If they prove
  identical after implementation, extraction to a shared `find-cursor.ts` is a safe
  cleanup. Reversible.
- **[normal] D6 — Case sensitivity.** Default: **case-insensitive, no toggle** in
  MVP (matches pdf-find/Monaco defaults); toggle deferred to v1. Reversible.

No `high`-severity decisions: the feature is renderer-only, additive, reversible, and
has a strong in-repo precedent (`pdf-find` + `term-search`).

---

## 16. Self-audit

All core-spine sections filled. UI module (§8–§11) completed — state catalog,
interaction inventory, a11y/i18n, tokens — not skipped despite the feature "seeming
small." Highlight mechanism, lifecycle, and scoping specified against the fixed
conductor decisions. Test plan covers the extractable pure module (unit) and
component behavior (e2e + screenshot) given no RTL/jsdom. No unresolved high-severity
decisions.

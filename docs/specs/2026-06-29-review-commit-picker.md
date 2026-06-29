---
status: active
date: 2026-06-29
---

# Feature Spec: Review-tab searchable commit picker + icon-only commit-detail Review action

**Tier:** FULL   **Feature type:** UI
**One-line request (verbatim):** "I asked you to put the commit inside a dropdown in the git breadcrumbs when on the review page. If you're on the review changes page you see the branch and all those things — you can also have a dropdown or a search box, very fully fleshed out, for picking a commit. Also the git commit detail pane: I don't like the way Review changes is implemented — the icon should be floated to the right side and it should just be an icon, the same way that Review changes has always been an icon. We need to be minimal, we need to be clean."

> Two independent items in one taste-feedback pass on the just-shipped commit-review UI
> (v0.14.0). **Item 1** is a trivial restyle (within this spec). **Item 2** is the full
> feature: replace the Review tab's 2-item source toggle with a real, searchable commit
> picker. Triage below sizes each.

---

## 0. Triage

| Item | Surface | Tier within this spec | Why |
|---|---|---|---|
| **1 — commit-detail "Review changes" → icon-only, floated right** | `webview/components/commit-view.tsx` `CommitView` header (`.gh__detail-sha` row) | trivial restyle | Drop the text node, reuse the established `.git-indicator__review` icon-button visual, float right. No new state, IPC, or logic. Routed via the existing `onReviewCommit(sha, subject)`. |
| **2 — searchable commit picker** | `webview/components/review-view.tsx` `ReviewSourceSelector` (the `.review__head` breadcrumb) | **FULL** | New searchable dropdown component, async commit loading over the host (`git:history`), keyboard a11y, filter/pasted-sha logic, several empty/loading states. Mirrors `branch-switcher-menu.tsx`. |

**Feature type = UI** for both → the UI module (state catalog, interaction inventory,
a11y, i18n, design tokens) is mandatory.

---

## 1. Problem frame

- **Job:** When reviewing on the Review page, let the user pick *which* changeset the page
  shows — the working tree or any recent commit — directly from the breadcrumb, by
  searching/scrolling, the same way the History view already lets them search commits.
  Today the breadcrumb selector is a dead-end 2-item toggle (Working tree ⇄ the *one*
  commit that was already opened from elsewhere); there is no way to *pick* a different
  commit from inside Review.
- **Actors:** the single local user reviewing changes in the desktop app.
- **Success outcomes (observable):**
  - On the Review page, opening the breadcrumb source control shows a search box + a
    "Working tree" row + a scrollable list of recent commits; typing filters it; picking a
    commit re-scopes the Review page to that commit's diff; picking "Working tree" returns.
  - A 7–40-char hex SHA that isn't in the list can be pasted and reviewed via an explicit
    "Review commit <sha>" row.
  - The commit-detail pane's "Review changes" action is a single right-floated icon (no
    text), visually identical to the long-standing git-band Review icon.
- **Non-goals:**
  - No new host IPC — reuse `git:history` and the existing `openReview`/`setReviewSource`
    path. (Decision D1.)
  - No multi-commit ranges / compare-two-commits; no branch/tag/working-vs-commit compare.
  - No commit *graph* in the picker (that's the History view); the picker is a flat list.
  - No change to how a commit's diffs are loaded/rendered (the existing `useCommitFiles` +
    windowed renderer is untouched).
  - The picker trigger does **not** move into the shared `GitIndicatorBar` (Decision D2).

---

## 2. Behavior & states

**Primary flow (happy path):**
1. User is on the Review page (`ReviewView`). The breadcrumb shows the current source
   label via the trigger button.
2. User clicks the trigger (or focuses + Enter/Space). The picker opens as a portaled
   dropdown, the search input is focused, and a `git:history` request fires for the
   session (lazy, on open).
3. While the result is in flight, the list area shows "Loading commits…".
4. On result, the list renders: a pinned "Working tree" row (checked iff current source is
   working), then recent commits (each: short sha + subject + relative date), the current
   commit source checked if present.
5. User types in the search box → list filters (sha-prefix OR subject OR author substring,
   case-insensitive). ↑/↓ move the active row, Enter selects, Esc closes.
6. Selecting a commit calls `onSetSource({kind:'commit', sha, subject})`; selecting Working
   tree calls `onSetSource({kind:'working'})`; the menu closes and focus returns to the
   trigger. `ReviewView`'s existing source-change effect resets scroll + announces.

**States / transitions:**
- **Trigger:** `working` (label "Working tree") ⇄ `commit` (label "<sha7> <subject>").
- **Menu:** `closed` → `open/loading` → `open/loaded` → (`filtered` | `empty-filter` |
  `pasted-sha`) ; `open/empty` (no commits at all) ; back to `closed`.
- **Selection:** `idle` → `selected(working|commit)` (synchronous from the picker's POV;
  the commit's diffs load in `ReviewView` as today, with its own loading state).

---

## 3. Data / interface contract

This is a renderer-only feature; no new protocol messages.

**Inputs:**
- `sessionId?: string` — passed from `ReviewView` (already available) into the selector so
  the picker can scope `git:history`. Absent ⇒ picker opens but loads nothing → empty.
- `source?: ReviewSource` (`webview/docs.ts`): `{kind:'working'} | {kind:'commit'; sha;
  subject?}` — the current source; drives which row is checked and the trigger label.
- Commit list: `git:history` request `{ type:'git:history'; sessionId; limit?; requestId? }`
  → `git:historyResult { sessionId; commits: CommitNode[]; hasMore; requestId? }`.
  `CommitNode` (`src/protocol.ts`): `sha`, `subject`, `author`, `email?`, `date` (unix
  **seconds**), `refs`, `parents`. Date shown via `relativeTime(date * 1000)`
  (`webview/relative-time.ts`).

**Outputs:**
- `onSetSource(next: ReviewSource)` — the only output; already wired through `ReviewView`
  → app `setReviewSource` → `openReviewTab()` / `openReviewForCommit(sha, undefined,
  subject)`.

**Invariants:**
- The picker never spawns git; the host enumerates (matches the renderer-never-spawns rule
  used by `git:refs`/`git:history`).
- Latest-wins on the async result: a monotonic `requestId` guards against a slow earlier
  response clobbering a newer one (reuse the `git-history-view.tsx` / `isStaleHistory`
  pattern).
- A bad/unknown pasted sha is validated **host-side** by the existing commit load; a sha
  that resolves to nothing lands the Review page on its already-handled empty state — the
  picker does no client-side sha validation beyond the hex/length shape test.

**New pure helpers (DOM-free, unit-tested — see §7):**
- `conciseSourceLabel(source?): string` — "Working tree" | "<sha7> <subject>" (subject
  truncated by CSS, not the string) | "<sha7>" when no subject. Distinct from the verbose
  `reviewSourceLabel` (kept for aria/announce).
- `filterCommitsForPicker(commits, query): CommitNode[]` — case-insensitive match on sha
  prefix OR subject substring OR author substring; empty query ⇒ all.
- `isPastedSha(query): string | null` — trims; returns the lowercased sha iff it matches
  `/^[0-9a-f]{7,40}$/i`, else null.

---

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| No `sessionId` / not a git repo | Picker opens; fires nothing (or fires and the host returns empty); shows "Loading commits…" only if a request was sent, then the empty state. "Working tree" row is always present and selectable. |
| Fresh repo / zero commits | After load, list shows the empty state ("No commits yet") under the pinned "Working tree" row; the picker is still usable to select working tree. |
| `git:history` request fails / never returns (host error or timeout) | The host has no error channel for history (it resolves failure to an empty result — see `git-history-view.tsx`), so a *failed* read surfaces as the empty state, not a hang. **Guard a true non-response with a load timeout** (~8s): if no `git:historyResult` arrives, drop the loading state to an inline "Couldn't load commits" row with a **Retry** affordance that re-issues the request (new `requestId`). "Working tree" stays selectable throughout. |
| Filter matches nothing | "No commits match" row (distinct from the no-commits-at-all empty state). If the trimmed query is a 7–40 hex string, instead offer the **"Review commit <sha7>"** pasted-sha row (see dedup below). |
| Pasted SHA not in the loaded window | The `isPastedSha` row appears iff the query is hex-shaped (7–40) **and** matches no *listed* commit: `isPastedSha(query) && filterCommitsForPicker(commits, query).length === 0`. Selecting it calls `onSetSource({kind:'commit', sha})` (no subject) — host validates. |
| Pasted hex prefix that DOES match a listed commit | The pasted-sha row is **suppressed**; the matching commit row(s) are shown so the user picks the real, subject-bearing row. (Same dedup predicate above.) |
| Current commit source not in the (filtered) list (came from a terminal link / deep history) | Pin the current source as a **"Current"** checked row at the top of the commit list (below "Working tree") when it isn't present, so the selection is always visible. Label = `source.subject` if present, else the sha7. |
| Current commit source IS in the loaded list | Do **not** render a separate "Current" row — mark that commit's own row `aria-checked`. (The "Current" pin appears only when the current commit is absent from the filtered list.) |
| Very long subjects | Truncate with ellipsis via CSS (`text-overflow: ellipsis`), full text in the row `title`. The string is never cut server-side. |
| Switching source while commits mid-load | Selecting any row closes the menu immediately and calls `onSetSource`; an in-flight `git:history` result that arrives after close is ignored (component unmounted) or dropped by the requestId guard. |
| Many commits | Load a generous cap (Decision D3, default **limit 150**); no paging in MVP. The list is plain-scrollable; `hasMore` from the result is ignored in MVP (flag paging as v1). |
| Duplicate/rapid open-close | Each open issues a fresh `requestId`; cache the loaded commits per session for the component's lifetime so a re-open doesn't reload (Decision D4) — but a new mount reloads. |
| Search query / active-row reset on close | The query and active-row index reset to empty/top on close (D4 caches the loaded *commits*, not the typed query) — re-opening starts fresh. |
| Active-row kept in view during keyboard nav | ↑/↓ over the (up to 150) scrollable rows must scroll the active row into view (mirror the History view's `scrollIntoView`/manual scroll-on-move); the active row must never be navigated off-screen. |
| Reduced-motion / forced-colors | No motion-dependent affordance; reuse `.ctxmenu`/`.git-branch-menu` which already survive high-contrast (verify focus ring). |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Commit load limit | 150 | No | Covers "recent" without a heavy read; matches the History page's generous-but-bounded feel. Tune later if needed. |
| Paging / "load more" | Off (MVP) | No | A flat searchable cap is enough for picking a *recent* commit; deep history is the History view's job. Paging is v1 (D3). |
| Lazy load on open | Yes | No | Don't pay the git read until the user opens the picker; cache for the component lifetime (D4). |
| Filter match fields | sha-prefix + subject + author | No | Mirrors the History search (`sha/message/author`) so behavior is consistent across the two commit surfaces. |
| Pasted-sha minimum length | 7 hex chars | No | 7 is git's conventional abbreviated-sha floor and matches the displayed `sha.slice(0,7)`. |
| Trigger label verbosity | Concise ("<sha7> <subject>") | No | The breadcrumb must stay minimal/clean (the user's explicit ask); the verbose form is reserved for aria/title/announce. |
| Item 1 icon button placement | Right of the detail header (`margin-left:auto`) | No | The user's explicit ask: float right, icon-only, minimal. |

---

## 6. Scope slicing

- **MVP (must):**
  - Item 1: commit-detail Review action → icon-only, floated right, `.git-indicator__review`
    visual, title/aria "Review changes".
  - Item 2: searchable picker replacing `ReviewSourceSelector`'s 2-item ContextMenu — search
    input, pinned "Working tree" row, loaded recent-commit list (cap 150), filter
    (sha/subject/author), pasted-sha row, current-source-pinned row when off-window, keyboard
    nav + Esc + outside-click dismiss, loading/empty/no-match states, latest-wins guard,
    per-lifetime cache.
- **v1 (should):**
  - Paging / "Load more" using `hasMore` + `before` (the History view already does this).
  - Show ref badges (branch/tag/HEAD) on commit rows like `CommitRow`.
  - Debounced re-fetch on git-fingerprint change while the picker is open.
- **Vision (could):**
  - Compare two commits / a commit range in Review.
  - Surface author avatars / grouped-by-day sections.
- **Out of scope:** new IPC; commit graph in the picker; branch/working compare; persisting
  the Review source (it's intentionally never persisted — `docs.ts` §3.4).

---

## 7. Acceptance criteria

**Declarative:**
- On the Review page, opening the source control shows a focused search box, a "Working
  tree" row, and a scrollable list of recent commits (sha7 + subject + relative date).
- Typing filters the list by sha prefix, subject substring, or author substring
  (case-insensitive); a non-matching hex query (7–40) shows a "Review commit <sha>" row.
- Picking a commit re-scopes the Review page to that commit (its diff cards render);
  picking "Working tree" returns to the working tree; focus returns to the trigger.
- The current source is always visibly checked, even when it isn't in the loaded list.
- The commit-detail "Review changes" action is a single right-floated icon with no text and
  an accessible name "Review changes".

**EARS:**
- *Event:* When the user opens the Review source control, the system shall focus the search
  input and request the session's recent commits.
- *State:* While the commit request is in flight, the system shall show a "Loading commits…"
  row and mark the menu `aria-busy`.
- *Event:* When the user selects a commit row, the system shall set the Review source to that
  commit, close the menu, and return focus to the trigger.
- *Unwanted:* If the trimmed query is a 7–40-char hex string that matches no listed commit,
  then the system shall offer a "Review commit <sha>" row that sets the source to that sha.
- *Unwanted:* If a slow `git:historyResult` arrives after a newer request was issued, then
  the system shall discard the stale result.
- *Unwanted:* If no `git:historyResult` arrives within the load timeout, then the system
  shall replace the loading row with a "Couldn't load commits" row and a Retry affordance.
- *State:* While the current source is a commit not present in the loaded list, the system
  shall render a checked "Current" row so the selection stays visible.
- *Ubiquitous:* The commit-detail Review action shall be an icon-only control with the
  accessible name "Review changes".

**Gherkin (key flows):**
```gherkin
Feature: Review-tab commit picker
  Background:
    Given the Review page is open for a session in a git repo with commits

  Scenario: Filter and pick a commit
    When I open the source control
    And I type part of a commit subject into the search box
    Then only commits whose sha, subject, or author match are listed
    When I press ArrowDown and then Enter on a match
    Then the Review page shows that commit's changes
    And focus returns to the source trigger

  Scenario: Paste an unlisted SHA
    When I open the source control
    And I paste a 40-character commit SHA that is not in the list
    Then a "Review commit <sha7>" row is offered
    When I select it
    Then the Review page is scoped to that commit (host-validated)

  Scenario: Return to the working tree
    Given the Review source is a commit
    When I open the source control and select "Working tree"
    Then the Review page shows the working-tree changes

  Scenario: Current commit is outside the loaded window
    Given the Review source is a commit not among the loaded recent commits
    When I open the source control
    Then a checked "Current" row shows that commit at the top of the list
```

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Source trigger (`.gh__reffilter review__source`) | working | "Working tree" + chevron | Open picker |
| Source trigger | commit | "<sha7> <subject>" (truncated) + chevron; `title` = verbose label | Open picker |
| Picker menu | loading | Search box (focused) + "Working tree" row + "Loading commits…" | Type / Esc |
| Picker menu | error (timeout / non-response) | Search box + "Working tree" row + inline "Couldn't load commits" + Retry | Retry / pick working / Esc |
| Picker menu | loaded / ideal | Search box + "Working tree" (checked iff working) + recent commits, current checked | Filter / pick / Esc |
| Picker menu | empty (no commits) | "Working tree" row + "No commits yet" | Pick working / Esc |
| Picker menu | filtered (matches) | Narrowed commit list; active row highlighted | Pick / arrows |
| Picker menu | empty-filter (no matches, non-hex query) | "No commits match" | Edit query / Esc |
| Picker menu | pasted-sha | "Review commit <sha7>" row (when query is hex 7–40, unlisted) | Select to review sha |
| Picker menu | current-off-window | Checked "Current" row pinned above the recent list | Re-select / pick another |
| Commit-detail Review action (item 1) | enabled | Right-floated single icon (`IconReview`), dim → accent on hover/focus | Open commit in Review |

(States not applicable here — offline, permission-denied, saving/rollback, limit-reached —
are N/A: this is a local read-only picker with no mutation and no auth.)

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Source trigger | open/close picker | click toggles | Enter/Space open; Esc (when open) close | tap | none | `button`, `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Review source"`, `title`=verbose label |
| Search input | filter | type | type; ↑/↓ move active row; Enter select active; Esc close (clear-if-text optional) | tap+type | none | `aria-label="Search commits"` (placeholder "Search commits…") |
| "Working tree" row | select working | click | Enter on active | tap | none | `role="menuitemradio"`, `aria-checked` |
| Commit row | select commit | click; hover sets active | Enter on active | tap | none | `role="menuitemradio"`, `aria-checked` (current) |
| "Review commit <sha>" row | select pasted sha | click | Enter on active | tap | none | `role="menuitemradio"`, `aria-checked=false` |
| Menu container | dismiss | outside-click / resize dismiss | Esc | tap-outside | n/a | `role="menu"`, `aria-label="Review source"`, `aria-busy` while loading |
| Commit-detail Review icon (item 1) | open commit in Review | click | Enter/Space | tap | none | `button`, `aria-label="Review changes"`, `title` |

## 10. Accessibility & i18n (UI)

**Accessibility:**
- Full keyboard operability: trigger reachable via Tab, opens on Enter/Space; input focused
  on open; ↑/↓/Enter/Esc drive the list; focus returns to the trigger on close (mirror
  `branch-switcher-menu.tsx`).
- **Active-row exposure with focus in the input:** DOM focus stays in the search box while
  ↑/↓ move an "active" row (the `branch-switcher-menu.tsx` pattern). To expose that active
  row to AT, the input carries `aria-activedescendant` pointing at the active row's id (each
  row has a stable `id`), or equivalently the search box is marked `role="combobox"` with
  the menu as its `aria-controls` listbox. The active row also keeps a visible
  `--active` style and is scrolled into view on each move (see §4).
- Visible focus on the trigger, input, and the active/selected row; must survive
  forced-colors (reuse `.ctxmenu__item--active` which already does).
- Accessible names: trigger `aria-label="Review source"` + `title` = verbose
  `reviewSourceLabel`; menu `role="menu"` + `aria-label`; rows `role="menuitemradio"` +
  `aria-checked`; item-1 icon button `aria-label="Review changes"`.
- Selection not color-only: the checked row carries `IconCheck` + `aria-checked`, not just a
  tint (matches the branch switcher).
- Announce: `ReviewView` already announces the new source via its `sr-only` live region on
  source change — no new live region needed in the picker; the loading state uses
  `aria-busy` on the menu.
- Reduced motion: no comprehension depends on animation.

**i18n:**
- Externalize all strings in a `STR` const (mirror `branch-switcher-menu.tsx` /
  `git-history-view.tsx`): placeholder "Search commits…", "Working tree", "Loading
  commits…", "Couldn't load commits", "Retry", "No commits yet", "No commits match",
  "Review commit {sha}", "Current", "Review source", "Review changes".
- Dates are locale-aware via the existing `relativeTime` helper (and `toLocaleString()` in
  the row `title` like `CommitView`); `date` is unix seconds (×1000 to ms).
- Pluralization: none required in the picker (counts live in the Review header, already
  pluralized). If a "{n} commits" count is added later, use the existing
  `n === 1 ? '' : 's'` pattern.
- Text expansion / RTL: subjects truncate via CSS with full `title`; sha is `dir="ltr"`
  monospace; commit rows tolerate ~30% longer labels (truncation handles overflow).

## 11. Design tokens (UI)

- Reuse, no new colors: `.ctxmenu` + `.git-branch-menu` (portaled dropdown, filter input,
  rows, active/checked styling) for the picker; `.git-indicator__review` (22×20, transparent,
  dim, `--accent-soft`/`--accent` on hover) for the item-1 icon button.
- Trigger continues to use `.gh__reffilter review__source` (no visual change to the trigger
  shell beyond the concise label).
- Short sha rendered in the existing monospace token (the History/CommitView sha styling);
  relative date in the existing dim token (`--text-dim` / `.gh__date` equivalent).
- Theme variants (light/dark/high-contrast) inherit from the reused classes — no new
  per-theme rules.

---

## 12. Assumptions

- The picker is a **new component** (e.g. `webview/components/review-commit-picker.tsx`)
  modeled on `branch-switcher-menu.tsx`, replacing the inner body of `ReviewSourceSelector`
  (which keeps owning the trigger button). It is **not** added to `GitIndicatorBar`.
- `ReviewView` already receives `sessionId`; it is threaded into the selector (today the
  selector ignores it). No new prop plumbing above `ReviewView`.
- Reuse `git:history` exactly as `GitHistoryView` does (request + `requestId` latest-wins +
  subscribe filtered by `sessionId`); the `layout`/`hasMore` fields of the result are
  ignored by the picker in MVP.
- The pasted-sha row passes `{kind:'commit', sha}` with **no subject**; the existing
  commit-load path + Review empty-state handle an unresolvable sha (no new error UI).
- Item 1 keeps the same `onReviewCommit(sha, subject)` wiring; only markup/CSS changes
  (drop the `{STR.review}` text node, swap `gh__copy gh__review-commit` for the
  `git-indicator__review` visual, move it out of the `.gh__detail-sha` flow to float right —
  most cleanly into the `.gh__detail-head`/`.gh__detail-sha` row with `margin-left:auto` so
  it doesn't crowd the copy-sha button).
- Existing tests referencing `.git-indicator__review` (e2e) and any `gh__review-commit`
  selector must be updated if the class changes; the item-1 control should remain reliably
  selectable (keep a stable class, e.g. keep/added `gh__review-commit` alongside the shared
  visual, or assert via `aria-label`).

## 13. Decisions Needed (autonomous mode)

- **[normal] D1 — No new IPC; reuse `git:history`.** Default taken: the picker loads commits
  via the existing `git:history` message rather than a new "list commits for picker" message.
  Reversible; lowest-risk and consistent with History.
- **[normal] D2 — Trigger stays in the Review header, not `GitIndicatorBar`.** Default taken:
  keep `ReviewSourceSelector` owning the trigger in `.review__head`. Review-source state
  belongs to the Review view; coupling the always-on git band to a Review-only concern is
  worse architecture (explicit in the request brief). Reversible.
- **[normal] D3 — Commit cap 150, paging deferred to v1.** Default taken: load a single
  generous page; ignore `hasMore` in MVP. If users routinely need older commits from the
  picker, add "Load more" (the History view already shows the pattern).
- **[normal] D4 — Lazy load on open + cache per component lifetime.** Default taken: fetch on
  first open, keep the result while the picker component is mounted; a remount reloads. No
  cross-session cache.
- **[normal] D5 — Filter matches sha-prefix OR subject OR author.** Default taken: mirror the
  History search fields for consistency. (Date is not matched.)
- **[normal] D6 — Item-1 control keeps a stable hook for tests.** Default taken: preserve a
  stable class/`aria-label` so the e2e/unit selectors don't silently break when the visual
  changes to the icon-only form.
- **[normal] D7 — Load-timeout fallback (~8s) since history has no error channel.** Default
  taken: a client timeout converts a true non-response into a Retry-able error row rather
  than an indefinite spinner. Tune the duration to taste; reversible.

No `high`-severity decisions: every choice is reversible, renderer-only, and consistent with
shipped patterns.

## 14. Open questions

None blocking (autonomous run; would-be questions captured as D1–D6 above).

---

## Verification notes

- **Pure/unit (Vitest):** `conciseSourceLabel`, `filterCommitsForPicker` (sha-prefix vs.
  subject vs. author, case-insensitivity, empty query), `isPastedSha` (length 6 → null, 7 →
  ok, 40 → ok, 41 → null, non-hex → null, trims whitespace).
- **Runtime / real-app (e2e, not the mock):** `git:history` crosses the host boundary, so add
  a `test/e2e/<name>.e2e.mjs` scenario on the shared harness: open a session on a seeded
  repo, open Review, open the source control, assert the search box + "Working tree" row +
  commit rows render; type to filter; pick a commit and assert the Review page re-scopes;
  pick "Working tree" to return; paste a SHA and assert the "Review commit <sha>" row.
  Also assert the commit-detail Review action is icon-only (no visible text) and
  right-aligned. Reuse the `.git-indicator__review` selector patterns from
  `review-entry-point.e2e.mjs` / `review-virtualize.e2e.mjs`.

## Self-audit

All template sections addressed. UI module (§8–11) filled, not skipped. Non-applicable
state-catalog rows (offline, permission, saving/rollback) explicitly marked N/A with reason.
No `high` decisions. Reviewer subagent dispatched (see final message) — if dispatch was
unavailable, a rigorous self-audit stands in its place and is noted.

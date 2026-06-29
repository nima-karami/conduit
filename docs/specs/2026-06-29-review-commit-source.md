---
status: draft
date: 2026-06-29
---

# Feature Spec: Review tab — commit source (review a commit's changes)

**Tier:** FULL   **Feature type:** UI
**One-line request (verbatim):**
> "I think it would be useful to have the ability to use the review changes tab for viewing the changes under a certain commit. When I'm reviewing a commit there should be a 'Review changes' button somewhere — maybe when I click a commit and the commit details window opens, there is a 'Review changes' button there that opens the review changes tab and the contents would be specifically that commit."
> "I'm guessing the review changes tab would probably need a commit code or commit hash selector within its git breadcrumb that it has."

This spec is built around the **ratified architecture** recorded in `.autoloop/blockers.md`
("Conductor decisions → review-commit-source architecture (T2)"). It does not redesign that
decision; it fills in states, contracts, edge cases, and acceptance.

---

## 1. Problem frame

- **Job:** When inspecting a past commit, the user wants the *same* rich, hunk-folded,
  whole-changeset Review surface they already use for the working tree — but scoped to that
  one commit's diff — instead of opening files one at a time as `commit-diff` tabs.
- **Actors:** A single local user reviewing history (no multi-user/permissions).
- **Success outcomes (observable):**
  1. From a selected commit's detail, one click opens the Review tab showing exactly that
     commit's changed files, each with its diff already rendered.
  2. The Review tab's header shows *what is being reviewed* (working tree vs. a specific
     commit) and lets the user switch back to the working tree.
  3. No second Review tab is created — the existing singleton retargets in place.
- **Non-goals:**
  - Editing/staging/committing from the commit view (Review is read-only today; commit diffs
    are immutable — stays read-only).
  - A diff between two arbitrary commits / a range (`A..B`). Single commit vs. its first
    parent only (matches `useCommitFiles`).
  - Persisting the commit source across app restart (Review is not a persisted doc; see §3.4).
  - Terminal commit-hash → Review link (that is a **separate** dependent item, T3; this spec
    only provides the `source = commit` capability it will reuse).

---

## 2. Behavior & states

### 2.1 Primary flow (happy path)
1. User opens History (git band), selects a commit → the inline `CommitView` detail appears.
2. User clicks **Review changes** in the commit detail.
3. The center switches to the editor area; the singleton Review tab opens/activates with its
   **source = that commit**.
4. ReviewView loads the commit's files via `useCommitFiles(sessionId, sha)` and renders the
   same windowed hunk cards as working-tree review, with each card's diff already present
   (no per-card fetch).
5. The header breadcrumb reads **"Reviewing commit `<short sha>`: `<subject>`"**.
6. User clicks the breadcrumb → picks **Working tree** → the same tab retargets to the
   working-tree changeset.

### 2.2 Review source model (the spine)
The Review doc carries a **source**:

```ts
type ReviewSource =
  | { kind: 'working' }                                   // default
  | { kind: 'commit'; sha: string; subject?: string };
```

Source transitions (all retarget the one singleton tab in place):

| From | Trigger | To |
|---|---|---|
| (tab closed) | git-band Review button / `cmd:review` / shortcut | `working` |
| (tab closed) | commit-detail **Review changes** button | `commit` |
| `working` | commit-detail **Review changes** | `commit` (same tab) |
| `commit` | breadcrumb → Working tree | `working` (same tab) |
| `commit A` | commit-detail **Review changes** on commit B | `commit B` (same tab) |
| any | close the Review tab | source gone (next open defaults per trigger; §3.4) |

### 2.3 Per-source content states (UI state catalog feeds from this)
- **Working tree** (unchanged from today): empty (`Nothing to review`) / cards loading
  per-card / populated / windowed.
- **Commit:**
  - *Loading commit files* — `useCommitFiles` status `loading`.
  - *Populated* — files present; cards render with preloaded diffs.
  - *Commit has no changes / unreadable sha* — status `ready`, `files: []` → empty state
    (these two are indistinguishable; see §4 + §13-D5).
  - **No distinct error state.** `useCommitFiles` exposes only `loading | ready`; the host has
    no error channel on `git:commitDiff` (a failed/timed-out `git show` resolves to
    `files: []`). So neither source has an "error" UI state — a failure surfaces as the empty
    state (the working-tree side likewise has no error state today).

---

## 3. Data / interface contract

### 3.1 Where the source lives (docState)
Carry the source on the singleton Review `OpenDoc` (keeps the id `review:@review` stable so it
stays a singleton, reactivatable, and restore-safe):

```ts
// webview/docs.ts — OpenDoc
reviewSource?: ReviewSource;   // absent ⇒ { kind: 'working' }
```

New reducer action (replaces the generic `open kind:'review'` for this surface; the id stays
`REVIEW_DOC_ID`):

```ts
| { type: 'openReview'; sessionId: string; source: ReviewSource }
```

Reducer behavior (`openReview`):
- If the review doc exists: set its `reviewSource = source`, transfer `sessionId` ownership,
  set it active, update `activeBySession`. (Same singleton, retargeted.)
- Else: create the singleton review doc with `reviewSource = source`, active + owned.
- `source.kind === 'working'` MAY store `reviewSource` as absent (canonical default) — label
  derivation treats absent === `{ kind:'working' }`.

`app.tsx` wiring:
- `openReviewTab()` → `dispatchDocs({ type:'openReview', sessionId, source:{ kind:'working' } })`
  (git band, command palette, shortcut — all keep working-tree).
- `openReviewForCommit(sha, subject)` → `dispatchDocs({ type:'openReview', sessionId,
  source:{ kind:'commit', sha, subject } })` + `setCenterView('editor')`.

### 3.2 How commit diffs feed the windowed renderer
ReviewView gains two props: `source: ReviewSource` and `sessionId: string | undefined`.
It **always** calls the hook (Rules of Hooks): `useCommitFiles(sessionId, source.kind ===
'commit' ? source.sha : '')` — an empty sha returns `LOADING` and fires no request.

- **Working source:** behaves exactly as today — uses the `changes`/`diffs`/`onRequestDiff`
  props (working-tree data fed by app.tsx).
- **Commit source:** derive the card list + diff map locally from the loader's
  `FileDiffDTO[]`, ignoring the working-tree props:
  - `diffs` map: `for (const f of files) m.set(absOf(f.path), f)` — same ABS-path keying the
    cards already consume, so the windowed renderer is byte-for-byte the same code path.
  - `changes` list: a pure derivation `commitChangesFromFiles(files): ChangeDTO[]` because
    `FileDiffDTO` carries no `added`/`removed`/`kind`/`staged`:
    - `kind`: `image.status` when present, else `head === '' ⇒ 'added'`,
      `work === '' ⇒ 'deleted'`, else `'modified'` (reuse existing ChangeKind values).
      **Renames/copies** aren't separately distinguishable from `FileDiffDTO` (no old-path /
      R/C status), so a rename reads as `modified` (or add+delete if the host emitted two
      entries) — fine for the card badge, and the same fidelity the working-tree Review shows
      (D7, normal).
    - `added`/`removed`: count `+`/`-` lines from the diff (or reuse `computeFileReview`
      hunk line kinds). Used only for the header `+N -N` badge and the slot **estimate** —
      and since commit diffs are preloaded, real measured heights replace estimates on first
      mount, so an approximate count is acceptable.
    - `staged: false` (not meaningful for a commit; the dedupe-by-path in ReviewView already
      collapses any duplicates).
- **`onRequestDiff` is a no-op in commit mode:** every card's diff is already in the map, so
  the card's on-mount `if (!diff) onRequestOnce(abs)` never fires. Pass a `() => {}` for the
  commit branch (ratified).

### 3.3 `onReviewCommit` flow (button → app)
- `webview/components/commit-view.tsx` — `CommitView` gains
  `onReviewCommit?: (sha: string, subject: string) => void`; the button calls
  `onReviewCommit(commit.sha, commit.subject)` (CommitView already holds the full `CommitNode`).
- `webview/components/git-history-view.tsx` — `GitHistoryView` gains
  `onReviewCommit?: (sha, subject) => void`, passed straight to `CommitView`.
- `webview/components/center-pane.tsx` — thread `onReviewCommit` to `GitHistoryView`
  (alongside `onOpenCommitFile`).
- `webview/app.tsx` — `openReviewForCommit` (above), passed as `onReviewCommit` to CenterPane.

### 3.4 Persistence / restore
- Review is **not** a persisted doc: `toPersistedDocs` filters `kind === 'file'` only, and
  `restore` rebuilds file docs only (confirmed in `webview/docs.ts`). So `reviewSource` never
  persists; after restart there is no Review doc at all.
- **In-session close → reopen:** closing removes the doc (and its `reviewSource`); the next
  open defaults to whatever the trigger sets — git band ⇒ `working`, commit button ⇒ that
  commit. Net effect: **source resets to working tree on close** (Decision D3).

### 3.5 Invariants
- Exactly one Review doc (`REVIEW_DOC_ID`) ever exists.
- The active repo / changesRoot used for ABS paths is the review doc's **owning session's**
  repo; the Review doc only renders while its owner is the active session (doc ownership), so
  `changesRoot = gitRootForSession(active)` is consistent with the commit's repo (§4).

---

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Bad / unknown / unreachable sha | `useCommitFiles` settles `ready` with `files: []` → "commit has no changes" empty state. Not distinguished from a genuinely empty commit (D5, normal). The MVP entry point is a real selected commit, so this is mainly a T3 (terminal-link) concern. |
| Commit with no file changes (rare) | Same empty state as above — "No changes in this commit." |
| Root commit (no parent) | `git show` of the root commit diffs against the empty tree (all files added) — `useCommitFiles` returns them normally; cards render as `added`. No special-casing. |
| Single-file commit ("one" of zero/one/many) | One card, count reads "1 file changed" (pluralization already handled). |
| Rapid re-target: click Review on commit B while commit A still loading | No cross-fill: `useCommitFiles` caches/keys by `(sessionId, sha)` and the host tags each `git:commitDiffResult` with its own sha, so A's late reply lands in A's cache entry, never B's. The hook returns the snapshot for the **current** sha (B), so the view shows B (loading→ready) and A's result is simply unreferenced. |
| Merge commit | `useCommitFiles` already returns the diff vs. the **first parent** (host-side). Surface a one-line note in the header for merges (reuse `CommitView`'s `mergeNote` string), since the shown diff is partial. |
| Switch source while diffs mid-load | New source replaces the file set entirely; reset `scrollTop → 0` and clear `focusedPath` on source change (a `useEffect` keyed on a source identity string) so the user isn't scrolled into a stale list. The per-path `measuredRef`/`uiCache`/`requestedRef` are keyed by path and harmlessly carry across (different paths). In-flight working-tree `readDiff` replies for the old source land in the shared `diffs` map but are simply not referenced by commit-mode cards. |
| Review tab already open (working) when a commit review is requested | Same singleton retargets in place to `commit` (no new tab). |
| Repeated clicks on the same commit's Review button | Idempotent — re-activates the same tab with the same source. |
| Multi-repo: commit belongs to repo X, active repo is X | Consistent: the History view + its commits are scoped to the owning session's repo; the Review doc renders only while that session is active, so `changesRoot` resolves the commit's files correctly. |
| Active session/repo changes while a commit review is open | The Review doc is owned by the session that opened it and is hidden when another session is active (existing ownership rule); on return it still shows the same commit. The sha is not re-pointed to a different repo (D6, normal). |
| Owning session closed | Existing `closeSession` reducer drops the doc (no special-casing needed). |
| Very large commit (thousands of files) | Same windowed renderer as working-tree review (spec 2026-06-27-review-virtualization) — preloaded diffs are already in the map, so it opens flat. |
| `sessionId` undefined (no active session) | Hook returns LOADING and posts nothing; header shows the commit label, body shows loading; recovers when a session is active. |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Initial source on open | Working tree | No | The git-band button and palette are general "review my changes" entries; commit scope is an explicit per-commit action. |
| Source after close/reopen | Resets to working tree | No | Review isn't persisted; commit context is ephemeral and explicitly triggered (§3.4). |
| Commit diff base | First parent (host default) | No | Matches `useCommitFiles`; range/merge-parent selection is out of scope. |
| Read-only | Yes | No | Commit diffs are immutable; mirrors today's Review. |
| Selector scope | Working tree ⇄ current commit (MVP) | n/a | Right-sized; recent-commits dropdown deferred to v1 (§6). |

No new user setting is introduced.

---

## 6. Scope slicing

- **MVP (must):**
  - `ReviewSource` model on the Review doc + `openReview` reducer action.
  - **Review changes** button in `CommitView` → `onReviewCommit` → commit-source Review.
  - ReviewView renders commit source from `useCommitFiles` through the existing windowed
    cards; `onRequestDiff` no-op in commit mode.
  - Header **breadcrumb / source selector**: shows the current source label; lets the user go
    **Working tree ⇄ the current commit** (the commit set by the button). A clear
    "back to working tree" path.
- **v1 (should):** breadcrumb dropdown lists **recent commits** (reuse the History loader)
  so the user can switch among commits without going back to History; accept a **pasted/typed
  SHA**.
- **Vision (could):** commit **range** review (`A..B`); "review staged only"; choose the
  merge parent for merge commits.
- **Out of scope:** terminal commit-hash → Review link (T3); editing/staging from Review;
  persisting source across restart.

---

## 7. Acceptance criteria

### Declarative
- Clicking **Review changes** in a commit's detail opens the singleton Review tab showing
  exactly that commit's changed files, each card's diff already rendered (no per-card spinner).
- The Review header states the source: "Reviewing working tree" or
  "Reviewing commit `<short sha>`: `<subject>`".
- The breadcrumb lets the user return to **Working tree** in the same tab; the tab then shows
  the working-tree changeset.
- No second Review tab is created when reviewing a commit; reviewing a different commit
  retargets the same tab.
- A commit with no readable changes shows the empty state, not a crash or infinite spinner.

### EARS
- **Event:** When the user activates **Review changes** on a selected commit, the system shall
  open/activate the singleton Review tab with source = that commit and render its files.
- **Event:** When the user picks **Working tree** in the Review breadcrumb, the system shall
  retarget the same Review tab to the working-tree changeset.
- **State:** While the commit's files are loading, the system shall show a non-blocking loading
  state and shall not fire per-card diff requests.
- **State:** While source = commit, the system shall label the header with the commit's short
  sha and subject and shall announce the source to assistive tech.
- **Unwanted:** If the commit's diff resolves to no files (empty or unreadable sha), then the
  system shall show the "no changes in this commit" empty state.
- **Unwanted:** If the user switches source, then the system shall reset the scroll position to
  the top so stale scroll offset cannot strand them mid-list.
- **Ubiquitous:** The system shall maintain exactly one Review tab regardless of how many
  commits are reviewed.

### Gherkin (key flows)
```gherkin
Feature: Review a commit's changes
  Background:
    Given a session in a git repo with commit history
    And the History view is open with a commit selected

  Scenario: Open commit review from the detail pane
    When I click "Review changes" in the commit detail
    Then the Review tab is shown with the commit's changed files
    And each file card shows its diff without a per-card spinner
    And the header reads "Reviewing commit <short sha>: <subject>"

  Scenario: Switch back to the working tree in place
    Given the Review tab is showing a commit's changes
    When I open the source breadcrumb and choose "Working tree"
    Then the same Review tab shows the working-tree changes
    And no additional Review tab was created

  Scenario: Empty or unreadable commit
    When I review a commit that has no readable file changes
    Then the Review tab shows the "no changes in this commit" empty state
```

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Commit detail (`CommitView`) | a commit is selected | **Review changes** button visible + enabled (always, once a commit is selected — D8) | Click → open commit review |
| Commit detail | commit loading / no files | Button still visible + enabled; clicking a no-change commit just opens the Review empty state (no need to gate the button on file load) | Click → empty Review |
| Review header — source selector | source = working | "Reviewing working tree" + caret | Open menu |
| Review header — source selector | source = commit | "Reviewing commit `abc1234`: subject" + caret | Open menu; back to working tree |
| Review header — selector menu | open | "Working tree" (✓ if active) + current commit row (✓ if active) | Pick a source |
| Review body — commit loading | `useCommitFiles` loading | Loading indicator (reuse Review loading affordance) | — |
| Review body — commit populated | files present | Windowed hunk cards, diffs preloaded | Open file / jump to hunk (existing) |
| Review body — commit empty | files: [] | "No changes in this commit" empty state | Switch source |
| Review body — working tree | (unchanged) | empty / per-card loading / populated / windowed | (existing) |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA |
|---|---|---|---|---|---|---|
| **Review changes** button (commit detail) | open commit review | click | Tab to it + Enter/Space (native `<button>`) | tap | none | `<button>`, accessible name "Review changes" (+ optional `aria-describedby` short sha) |
| Source selector trigger | open/close menu | click | Enter/Space opens; Esc closes | tap | none | `<button>` `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Review source"` |
| Source selector menu | choose source | click row | Arrow/Enter via shared `ContextMenu` | tap | n/a | reuse `ContextMenu` (portal, roving focus, dismiss) — same as `RefFilterDropdown` |
| Back-to-working affordance | source → working | (the "Working tree" menu row) | (menu keyboard) | tap | — | — |
| Review body | existing (jump to hunk, open file, fold expand, Esc to close) | unchanged | unchanged (Esc closes tab via `useEscapeKey`) | unchanged | unchanged | unchanged |

The source selector reuses the **exact** `RefFilterDropdown`/`ContextMenu` pattern already in
`git-history-view.tsx` (themed trigger + portal menu + check-mark on the active row) — no new
dropdown primitive.

## 10. Accessibility & i18n (UI)

- **Keyboard:** the selector is reachable and operable by keyboard (trigger is a real button;
  the menu is the shared `ContextMenu` with arrow/Enter/Esc). The **Review changes** button is
  a native button (Enter/Space). No keyboard trap.
- **Accessible name / announcement:** the trigger's accessible name is "Review source"; its
  visible label is the current source ("Reviewing working tree" / "Reviewing commit `<short
  sha>`: `<subject>`"). On a source change, announce via a polite live region
  (the existing `role="status" aria-live="polite"` region in ReviewView is reused) — e.g.
  "Now reviewing commit `<short sha>`: `<subject>`" / "Now reviewing the working tree". The
  existing window-jump announcer must not be clobbered (use the same region, distinct message).
  When a commit resolves to **no changes**, announce the result too (e.g. "No changes in this
  commit") so a screen-reader user isn't left on a silent empty pane.
- **Plural-aware counts:** keep the existing `N file(s) changed` pluralization for both
  sources. The empty/loading strings are added to the existing `STR`-style constants (no new
  i18n framework — this codebase uses inline English string constants; match that convention).
- **Focus management:** opening the commit review moves the center to the editor area; do not
  steal focus mid-typing — follow the existing Review/History open behavior (no autofocus
  beyond what those already do).
- **Color/contrast:** the source label and the merge note must meet the same contrast as
  existing `.review__sub` / `gh__merge-note` text (reuse those tokens; no new colors).

## 11. Design tokens (UI)

- Reuse existing semantic roles only:
  - Review header text: existing `.review__title` / `.review__sub` tokens.
  - Selector trigger + menu: reuse the History `gh__reffilter*` / `ContextMenu` tokens (themed
    trigger, caret, check-mark) so the breadcrumb matches the History ref dropdown.
  - Merge note: reuse `gh__merge-note`.
  - **Review changes** button in commit detail: reuse the existing commit-detail button styling
    (`gh__copy` / `gh__file` family) or the standard `btn` token — no new button variant.
- Theme variants: inherit light/dark/high-contrast from the reused tokens; **no new hex**.

---

## 12. Assumptions

- The host returns an **empty `files` array** (not an error channel) for a bad/unknown sha, so
  the renderer cannot distinguish "bad sha" from "empty commit" — both map to the empty state
  (consistent with `git-history-view`'s "empty == not-a-repo" limitation).
- `added`/`removed` for commit cards may be **derived approximately** from the diff text; exact
  parity with git's numstat is not required because preloaded diffs supply real measured card
  heights and the badge is informational.
- The codebase has **no i18n framework**; user-facing strings are inline English constants —
  this spec follows that, only requiring plural-correctness.
- ReviewView is the right home for the commit-source derivation (it owns the windowed renderer);
  app.tsx continues to feed only working-tree data.
- The merge-note surfacing reuses `CommitView`'s existing string; no new merge handling.

## 13. Decisions Needed (autonomous mode)

- **[normal] D1 — Selector scope for MVP.** Default taken: MVP selector switches only
  **Working tree ⇄ the commit currently set by the button** (plus a clear label). A
  recent-commits dropdown and pasted-SHA entry are **v1** (§6). Rationale: the verbatim ask is
  satisfied by the button + a back-to-working affordance; a full commit picker is a larger,
  separable surface.
- **[normal] D2 — Source carrier.** Default taken: a `reviewSource?: ReviewSource` field on the
  singleton Review `OpenDoc`, set by a new `openReview` reducer action, **keeping the doc id
  `review:@review` stable** (so it stays a singleton and restore-safe). Alternative (encode sha
  in the doc id/path) was rejected: it would break the singleton and the `REVIEW_DOC_ID` close
  path.
- **[normal] D3 — Source persistence across close/reopen.** Default taken: **resets to working
  tree** (Review isn't a persisted doc; commit context is ephemeral). Remembering the last
  commit would require persisting Review state, which §3.4 says we don't.
- **[normal] D4 — Commit `ChangeDTO` derivation lives in a pure helper** (`commitChangesFromFiles`)
  so it is unit-testable; `kind` from head/work/image presence, `added/removed` counted from
  the diff. Flagged because the count method (numstat-exact vs. line-count) is a judgment call;
  default = line-count approximation.
- **[normal] D5 — Bad-sha vs. empty-commit indistinguishable.** Default taken: both show the
  empty state. Distinguishing them needs a host error channel on `git:commitDiff`
  (out of scope; revisit with T3 terminal-link, where arbitrary user-typed SHAs make a real
  "unknown commit" message more valuable).
- **[normal] D6 — Commit source is not re-pointed when the active session/repo changes.**
  Default taken: the sha stays put (the doc is owned by + only visible under its opening
  session). See §4.
- **[normal] D7 — Renames/copies render as `modified` (or add+delete).** Default taken:
  `FileDiffDTO` carries no R/C status, so the card kind is approximated — matching working-tree
  Review fidelity. A truer rename badge would need a host DTO change (out of scope).
- **[normal] D8 — Commit-detail Review button is always visible + enabled once a commit is
  selected.** Default taken: don't gate it on file load — a no-change commit simply opens the
  Review empty state. Avoids a flicker/disabled-state race on the loader.

## 14. Open questions

None blocking — all resolved as flagged assumptions above (autonomous mode).

---

## Verification notes (for the builder)

- **Unit-testable seams:** `reviewSourceLabel(source)` (label derivation), `commitChangesFromFiles(files)`
  (kind/added/removed derivation), and `docsReducer` `openReview` transitions (sets source;
  reopening working-tree clears/overrides it; singleton id preserved; ownership transfer).
- **Runtime observation crosses into git** (commit files come from the host running `git show`),
  so it **cannot** be exercised by the mock preview/Playwright-webview harness. Add a real
  built-app e2e scenario on the shared harness (`test/e2e/harness.mjs`, `CONDUIT_E2E=1`),
  e.g. `test/e2e/review-commit-source.e2e.mjs`: open History → select a commit → click
  **Review changes** → assert the Review tab shows that commit's files → switch the breadcrumb
  to Working tree → assert the working-tree changeset. This replaces a `needs-human-smoke` tag
  (per CLAUDE.md: host/PTY/IPC-boundary work uses `test:smoke`).
- Run `npm run verify` (both tsconfigs) before claiming done.

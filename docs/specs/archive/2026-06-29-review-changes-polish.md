---
status: active
date: 2026-06-29
---

# Feature Spec: Review-changes polish — git-band source picker, line wrap, compact portion, ref-compare

**Tier:** FULL   **Feature type:** UI (+ a host/IPC slice for item 4)
**One-line request (verbatim):** "I want a very very polished review changes feature. (1) Place the commit search / commit dropdown on the **git breadcrumb** — the line that has the worktree picker, the branch/folder picker, and on the right the git-history icon and review-changes icon. (2) When a diff line flows off-screen I get a per-line horizontal scrollbar; it should **wrap** (or I should have the option to). (3) When a file has many added/removed lines, show only a **small portion** with expand/collapse, not the whole 1000 lines. (4) I also want the option to view a diff between different **commits or branches** in review changes."

> Four items in one taste-driven polish pass on the shipped Review feature (v0.15.0). They
> range from a one-line CSS change (item 2) to a host-crossing feature (item 4). Triage sizes
> each. **Naming:** the row the user calls the "git breadcrumb" is the `center-gitband` in code
> (repo/folder picker + worktree + branch switcher + History/Review icons). This spec uses
> **"git band"** for it — recommended as the shared term going forward.

---

## 0. Triage

| Item | Surface | Tier within spec | Why |
|---|---|---|---|
| **1 — move the Review source picker onto the git band** | `webview/components/center-pane.tsx` (`center-gitband`), new `ReviewSourceControl`; remove `ReviewSourceSelector` from `review-view.tsx` | **FULL** | Reverses Decision **D2** of `2026-06-29-review-commit-picker` (which kept the trigger in the Review header). Lifts source state/wiring to the band, shows it only when Review is the active doc, no duplicate control. |
| **2 — wrap long diff lines (no horizontal scrollbar)** | `webview/styles.css` `.rline*` | **LITE** | CSS-only. User chose **always wrap, no toggle** — so no setting, no persistence, no React change. |
| **3 — compact portion for large files** | `webview/components/review-view.tsx` `MAX_CARD_ROWS` | **LITE** | Retune the existing root-cause cap (`planRowCap`) from 300 → **~40**; the two-way "Show all / Show less" already exists. |
| **4 — diff between two refs (commit/branch/working)** | `src/protocol.ts`, host git module, new `src/git-range.ts`, `webview/use-range-files.ts`, the picker → a compare builder, `ReviewSource` union | **FULL** | New `range` source kind + a new host IPC (`git:rangeDiff`) that resolves and validates two endpoints and computes the diff. The renderer's existing commit-mode "preloaded diffs" plumbing generalizes to range mode. |

**Feature type = UI** for items 1–4 (item 4 also has a non-UI host/IPC slice) → the UI module
(§8–11) is mandatory; the host slice gets a data/interface contract (§3) + edge cases (§4).

---

## 1. Problem frame

- **Job:** Make Review feel finished. (1) Put the "what am I reviewing" control where the
  user already looks for git context — the git band — instead of buried in the Review header.
  (2) Let long lines be read without horizontal scrolling. (3) Keep a huge file from flooding
  the page; show a small, expandable portion. (4) Let the user review the difference between
  any two points in history (two commits, two branches, a branch vs. the working tree), not
  only the working tree or a single commit.
- **Actors:** the single local user reviewing changes in the desktop app.
- **Success outcomes (observable):**
  - When the Review tab is active, the source picker appears on the git band (same row as the
    repo/branch indicators + History/Review icons) and is gone from the Review header.
  - No diff line ever shows a horizontal scrollbar; long lines wrap.
  - A file with more than ~40 changed lines shows ~40 then a "Show all N lines" control; "Show
    less" collapses it back.
  - From the source picker the user can choose **Compare…**, pick a base and a target (each a
    commit, a branch, or the working tree), and Review shows that comparison; the trigger label
    reads the comparison (e.g. "main…feature").
- **Non-goals:**
  - No diff *editing* / staging from Review (still read-only).
  - No commit graph in the picker (that's the History view); the picker is flat + searchable.
  - No per-line wrap toggle / setting (the user chose always-wrap).
  - No three-way / N-way compare; exactly two endpoints.
  - No persistence of the Review source across restart (intentional — `docs.ts` §3.4; the
    range source is likewise ephemeral).
  - No new "compare" entry in the History view (item 4 lives in the Review source picker).

---

## 2. Behavior & states

**Item 1 — source picker on the git band**
1. User opens the Review tab. The git band shows: repo/folder picker · worktree · branch · the
   **Review source control** · History icon · Review icon.
2. The source control is the existing trigger (concise label + chevron) opening the searchable
   picker (`CommitPickerMenu`, extended for compare — item 4). It is rendered **only** while
   the active doc is the Review tab; switching to a terminal/file tab hides it (the rest of the
   band is unchanged).
3. The Review header (`review__head`) no longer renders a selector — just the title + file
   count.

**Item 2 — line wrap**
- Each diff row renders its text wrapped; the gutter + sign stay aligned to the first visual
  line; the row grows in height. No scrollbar, no toggle.

**Item 3 — compact portion**
- A file card whose total rendered rows exceed the cap (~40) shows the first ~40 (distributed
  across hunks by the existing `planRowCap`) + "Show all N lines"; expanded, it shows every row
  + "Show less". A card under the cap shows everything with no control (unchanged).

**Item 4 — compare two refs (states/transitions):**
- **Source union:** `working` ⇄ `commit` ⇄ **`range(base, head)`**.
- **Picker:** `closed` → `open/list` (working + commits, as today) → **`open/compare`** (base +
  head endpoint fields) → `closed`. A **Compare…** affordance toggles list ⇄ compare; **Back**
  returns to the list.
- **Compare build:** `compare/idle` → pick base (sub-picker: branches + commits) → pick head
  (sub-picker: branches + commits + **working tree**) → `compare/ready` → **Compare** confirms →
  sets `{kind:'range', base, head}`. The **base** sub-picker omits the working tree (D8: working
  tree is a target-only endpoint in MVP); both fields enter via the same nested push/pop view
  (the sub-picker *replaces* the builder view in-place, then **Back**/Esc pops back to the
  builder — linear focus, no stacked overlay).
- **Range load (in `ReviewView`):** `loading` → (`ready` | `empty` | `error`). **`empty`** = the
  host returned `files: []` and **no** `error` (identical/no-difference endpoints). **`error`** =
  the host could not resolve an endpoint to a valid ref (carries a `reason`). The two are
  distinguished solely by the presence of `error` (never by an empty file list). Mirrors
  commit-mode loading.

---

## 3. Data / interface contract

### Renderer types (`webview/docs.ts`)

```ts
type RefEndpoint =
  | { kind: 'working' }
  | { kind: 'commit'; sha: string; subject?: string }
  | { kind: 'branch'; ref: string };

type ReviewSource =
  | { kind: 'working' }
  | { kind: 'commit'; sha: string; subject?: string }
  | { kind: 'range'; base: RefEndpoint; head: RefEndpoint };   // NEW
```

`reviewSource` already rides the singleton review `OpenDoc` and is set via the `openReview`
action; the `range` variant is additive. Not persisted (§3.4 of `docs.ts`).

### New host IPC (item 4 only)

```ts
// WebviewToHost — requestId is REQUIRED for range (latest-wins depends on it; see below)
| { type: 'git:rangeDiff'; sessionId: string; base: RefEndpoint; head: RefEndpoint; requestId: number }
// HostToWebview
| { type: 'git:rangeDiffResult'; sessionId: string; key: string; files: FileDiffDTO[]; error?: string; requestId: number }
```

- `key` is a stable string both sides derive identically from `(base, head)` via the pure
  `rangeKey(base, head)` (`src/git-range.ts`) so the loader matches the reply to its request
  (mirrors `git:commitDiff`'s sha tag).
- **`requestId` is required** (unlike the optional commit-diff id): latest-wins is the *only*
  stale-drop mechanism (§4), so every request carries a monotonic id and every reply — **including
  a cache hit** — echoes the **live request's** id (the host stamps the cached payload with the
  incoming `requestId` before sending; it never replays a stored id). A reply whose id is older
  than the loader's latest is dropped.
- `error` (present ⇒ error state) is a short host-supplied reason for a **resolution failure**
  only — e.g. `"Unknown ref"`, `"Unknown commit"`. A successful comparison with no differences is
  **not** an error: it returns `files: []` with `error` absent (the `empty` state). "No diff" is
  never an error reason.
- `files: FileDiffDTO[]` is the **whole** comparison preloaded (head/work content per file),
  exactly the shape `useCommitFiles` returns, so the windowed renderer is reused unchanged.
  Binary/over-size files inherit commit-mode rendering (a `binary` `FileDiffDTO` → "Binary file —
  no diff preview"); range adds no new per-file handling.

### Host computation (the only new git logic)

- Resolve each endpoint to a comparable token, **validating against the host's own enumerated
  set** (never interpolating renderer strings into `execFile`): `branch` → look up in the
  enumerated **local** branches (as `git:switch` does) and use its name; `commit` → validate the
  sha via `cat-file --batch-check` over **stdin** (the established `terminal-commit-link` /
  `git:switch` pattern); `working` → the working tree. A branch/sha not in the enumerated set ⇒
  `{ error: 'Unknown ref' | 'Unknown commit' }`.
- **Working-tree endpoint semantics:** the working-tree endpoint compares a committish ref to the
  **tracked** working-tree state via `git diff <ref>` (staged + unstaged tracked changes).
  **Untracked files are not included** (git's `diff <ref>` doesn't surface them) — this is a known
  divergence from the plain `working` source (which lists untracked), recorded as a limitation
  (D8); surfacing untracked in a range is v1. The working tree is a **target (head) only** in MVP
  (see D8): the *base* endpoint is always committish, so the ref is always on the left and the
  working tree on the right — no patch inversion is ever needed.
- **Dot mode (Decision D2, user-chosen three-dot)** — see pure `dotModeFor`:
  - both endpoints committish (commit/branch) → `git diff <base>...<head>` (three-dot, merge-base).
  - head = working tree (base committish) → `git diff <base>` (ref ↔ tracked working tree; two-dot).
  - no common ancestor for a three-dot pair → fall back to `git diff <base>..<head>` (two-dot)
    and proceed (Decision D5).
  - base = working tree, or both = working tree → **not sent** (the builder forbids working-as-base
    and collapses working-vs-working to `{kind:'working'}`).
- Build `FileDiffDTO[]` from the changed paths exactly as the commit-diff path does (reuse that
  helper); cache per `(sessionId, key)` with the same TTL/eviction as commit diffs (cache hits
  re-stamp the live `requestId` per above).

### Pure helpers (DOM-free, unit-tested — §"Verification")

- `rangeKey(base, head): string` — stable, order-significant key (e.g.
  `endpointKey(base) + '...' + endpointKey(head)`; `endpointKey` = `working` | `c:<sha>` |
  `b:<ref>`).
- `dotModeFor(base, head): 'three' | 'two' | 'working'` — the table above (both committish ⇒
  `three`; head=working & base committish ⇒ `two`; working-vs-working ⇒ `working`; base=working
  is rejected upstream by the builder so it need not be a valid input).
- `conciseSourceLabel(source?)` / `reviewSourceLabel(source?)` — **extend** for `range`:
  concise = "`<baseLabel>…<headLabel>`" (each = `ref` for branch, `sha7` for commit, "working"
  for working tree); verbose = "Comparing `<base>` to `<head>`".
- `endpointLabel(ep): string` — branch ref | sha7 (+subject in title) | "Working tree".

**Invariants:** renderer never spawns git; host enumerates/validates every ref; latest-wins via
`requestId`; an unresolvable endpoint yields an `error` result (handled state), never a hang or
a host crash.

---

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Review active but git band hidden (indicator setting off) | The source control renders inside `center-gitband` **independent of `indicatorOn`** (it gates only `GitIndicatorBar`). The band already renders for review docs via `showGitBand`; ensure the control is reachable whenever Review is active (Assumption A2). |
| Review active in a **non-git** folder (working-tree mode, no repo) | Picker shows "Working tree" only; **Compare… is hidden** when there are no refs/commits to compare (no committish base is selectable) — don't show a dead builder. |
| **Empty repo / unborn HEAD** (git repo, zero commits) | Branch + commit lists are empty, so no committish base exists → **Compare… is hidden** (same as non-git). The working-tree source still works. |
| Long line with no break opportunity (minified/one long token) | `overflow-wrap: anywhere` forces a break so it still wraps; no horizontal scrollbar. Indentation preserved via `pre-wrap`. |
| Wrapped multi-line row + gutter alignment | Gutter/sign `align-self: flex-start` so they sit on the first visual line, not vertically centered against a tall wrapped row. |
| File exactly at the cap | `total > MAX_CARD_ROWS` is strict — a file at exactly the cap shows fully with no control (no off-by-one "Show all 40 lines" that reveals nothing). |
| Tiny cap vs many hunks | `planRowCap` distributes ~40 across hunks; choppy per-hunk slices are acceptable for a *preview* — "Show all" reveals everything. (Trade-off accepted per the user's "compact" choice; cap is a named constant, D4.) |
| Compare base == head | Host returns `files: []`, no `error` → "No differences between `<base>` and `<head>`" **empty** state (distinct from error; see §3). |
| Compare endpoint is a deleted/unknown branch or bad sha | Host returns `{ error: 'Unknown ref'|'Unknown commit' }`; Review shows an **error** state ("Couldn't compare: <reason>") with a **Retry** affordance (re-issues the same range with a fresh `requestId`) and the source still switchable back. |
| Working tree chosen as the **base** | Not possible — the base sub-picker omits the working tree (D8). The working tree is target-only; the common "ref vs my working tree" case is base=ref, head=working. |
| Both endpoints working tree | Cannot arise (base can't be working); were it ever constructed, it collapses to `{kind:'working'}` — never sent as a range. |
| No merge-base (unrelated histories) for a committish pair | Fall back to two-dot and show the diff (D5); no error. |
| Binary / over-size file inside a range | Inherits commit-mode rendering: a `binary` `FileDiffDTO` shows "Binary file — no diff preview"; no new handling (§3). |
| Very large comparison (hundreds/thousands of files) | The windowed renderer handles it; the diff payload is preloaded in one message (parity with commit mode). Heavy ranges are acceptable for MVP; lazy per-file range fetch is v1 (D6). |
| Source changes while a range is mid-load | Selecting any new source closes the picker and switches immediately; a late `git:rangeDiffResult` is dropped by the `requestId`/`key` guard. |
| Switching source resets Review scroll/focus | `ReviewView`'s existing source-change effect must include the range in its `sourceKey` (e.g. `range:<rangeKey>`) so a stale scroll offset can't strand the user. |
| Branch ref with `/` or unusual chars | Validated against the enumerated branch set (exact match), never shell-interpolated; rendered `dir="ltr"`, truncated via CSS. |
| Reduced-motion / forced-colors | No motion- or color-only affordance; reuse `.ctxmenu`/`.git-branch-menu` (already high-contrast safe). |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Line wrapping | **Always on, no toggle** | No | User's explicit choice; removes the horizontal scrollbar with zero new chrome/state. |
| Compact portion cap | **~40 rendered rows/card** | No (named const `MAX_CARD_ROWS`) | User chose "Compact (~40 changed lines)". Folds already collapse unchanged runs, so visible rows are dominated by changed lines. Tunable in one place (D4). |
| Compare dot-mode | **Three-dot (merge-base)** for committish pairs; two-dot when working tree is an endpoint | No | User's explicit choice; matches GitHub Compare. Working tree has no merge-base, so two-dot is the only correct fallback. |
| Compare endpoints | **commit / branch / working tree** | No | User's explicit choice — maximum flexibility. |
| Source picker placement | **On the git band**, shown only when Review is active | No | User's explicit ask (reverses prior D2). Keeps one control, contextual. |
| Range source persistence | Not persisted | No | Consistent with the existing rule that Review source is ephemeral. |
| Range diff cap / paging | Preload all files (parity w/ commit mode) | No (MVP) | Reuses the proven commit-mode path; lazy range fetch is v1 (D6). |

---

## 6. Scope slicing

- **MVP (must):**
  - Item 1: `ReviewSourceControl` on the git band (Review-active only); removed from the header.
  - Item 2: always-wrap diff lines (CSS).
  - Item 3: `MAX_CARD_ROWS` → ~40, existing Show all/less.
  - Item 4: `range` source; `git:rangeDiff`/`Result` IPC with ref validation + three-/two-dot
    selection; `useRangeFiles` loader; `ReviewView` range mode (preloaded diffs, no-op request);
    compare builder in the picker (base + head endpoint sub-pickers over branches + commits +
    working, search, keyboard a11y); trigger label + loading/empty/error states.
- **v1 (should):**
  - Two-/three-dot toggle inside the compare builder.
  - Swap-endpoints button; recent-comparisons list.
  - Lazy per-file range diff fetch for very large comparisons.
  - Compare entry-point from the History view (select two commits → Review).
- **Vision (could):**
  - Tag endpoints; remote-tracking branches; stash as an endpoint.
- **Out of scope:** editing/staging from Review; N-way compare; persisting the source; commit
  graph in the picker.

---

## 7. Acceptance criteria

**Declarative:**
- On the Review tab the source control sits on the git band (same row as repo/branch + History/
  Review icons) and is absent from the Review header; on any non-Review tab it is not shown.
- No diff line shows a horizontal scrollbar; a long line wraps and stays readable, gutter aligned
  to its first visual line.
- A file with >~40 changed lines shows ~40 rows + "Show all N lines"; "Show less" collapses it.
- The source control offers **Compare…**; choosing a base and a target (each commit/branch/
  working tree) and confirming scopes Review to `git diff base...head` (three-dot for committish
  pairs; ref↔working two-dot when an endpoint is the working tree); the trigger reads the
  comparison; "Working tree" returns.
- An unresolvable endpoint yields an error state, not a hang; identical endpoints yield a "no
  differences" empty state.

**EARS:**
- *Ubiquitous:* The Review source control shall render on the git band while, and only while, the
  Review tab is the active doc.
- *Ubiquitous:* Diff lines shall wrap; the system shall never present a per-line horizontal
  scrollbar.
- *State:* While a file's rendered rows exceed `MAX_CARD_ROWS`, the system shall show a bounded
  portion and a "Show all N lines" control.
- *Event:* When the user confirms a comparison of a base and a target, the system shall request
  `git:rangeDiff` and scope the Review page to the returned comparison.
- *Unwanted:* If an endpoint cannot be resolved to a valid ref, then the system shall show an
  error state and keep the source switchable.
- *Unwanted:* If a stale `git:rangeDiffResult` arrives after a newer request, then the system
  shall discard it.
- *State:* While a committish pair has no common ancestor, the system shall fall back to a
  two-dot diff and present it.

**Gherkin (key flows):**
```gherkin
Feature: Review-changes polish
  Background:
    Given the Review tab is open for a session in a git repo with branches "main" and "feature"

  Scenario: Source picker lives on the git band
    Then the Review source control appears on the git band
    And the Review header shows only the title and file count
    When I switch to a terminal tab
    Then the Review source control is not shown

  Scenario: Long lines wrap
    Given a changed file has a line wider than the viewport
    Then the line wraps onto multiple visual lines
    And no horizontal scrollbar appears on that line

  Scenario: Large file shows a compact portion
    Given a changed file has 1000 added lines
    Then the card shows about 40 lines and a "Show all 1000 lines" control
    When I activate it
    Then all lines are shown and a "Show less" control appears

  Scenario: Compare two branches
    When I open the source control and choose "Compare…"
    And I set the base to "main" and the target to "feature"
    And I confirm
    Then the Review page shows the diff of feature relative to main
    And the source trigger reads "main…feature"

  Scenario: Compare a branch against the working tree
    When I compare base "main" with target "Working tree"
    Then the Review page shows main compared to the working tree

  Scenario: Identical endpoints
    When I compare "main" with "main"
    Then the Review page shows a "No differences" empty state
```

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Source control (git band) | hidden | Not rendered (non-Review tab) | — |
| Source control | working | "Working tree" + chevron | Open picker |
| Source control | commit | "<sha7> <subject>" + chevron | Open picker |
| Source control | range | "<baseLabel>…<headLabel>" + chevron; verbose `title` | Open picker |
| Picker | list (default) | Search + "Working tree" + recent commits + **Compare…** row | Filter / pick / Compare… |
| Picker | compare/idle | Base field + Target field (each "Choose…") + disabled **Compare** + **Back** | Pick endpoints |
| Picker | compare/ready | Base + Target filled; enabled **Compare** | Confirm / Back |
| Base sub-picker | open | Search + branches + recent commits (no working tree) | Pick base |
| Target sub-picker | open | Search + "Working tree" + branches + recent commits | Pick target |
| Review body | range loading | "Loading comparison…" | Wait / switch source |
| Review body | range empty | "No differences between <base> and <head>" | Switch source |
| Review body | range error | "Couldn't compare: <reason>" + **Retry** | Retry / switch source |
| File card | over cap | ~40 rows + "Show all N lines" | Expand |
| File card | expanded | all rows + "Show less" | Collapse |
| Diff line | any | wrapped text, gutter on first line, no scrollbar | — |

(Offline / permission / saving / auth states are N/A — local, read-only.)

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | ARIA |
|---|---|---|---|---|
| Source control trigger | open/close | click toggles | Enter/Space open; Esc close | `button`, `aria-haspopup="menu"`, `aria-expanded`, `aria-label="Review source"`, `title`=verbose |
| Picker search | filter | type | type; ↑/↓ active; Enter select; Esc close | `combobox` + `aria-activedescendant` (existing pattern) |
| "Compare…" row | enter compare mode | click | Enter | `menuitem` |
| Back | return to list | click | Enter; Esc | `button` |
| Base field | open base sub-picker (branches + commits; **no** working tree) | click | Enter/Space | `button`, `aria-haspopup`, `aria-expanded`, labelled "Base" |
| Target field | open target sub-picker (branches + commits + working tree) | click | Enter/Space | `button`, `aria-haspopup`, `aria-expanded`, labelled "Target" |
| Endpoint sub-picker rows | pick endpoint | click; hover=active | ↑/↓/Enter; **Esc pops to builder** | `menuitemradio`, `aria-checked` |
| Compare (confirm) | apply range | click | Enter | `button`, `disabled` until both set |
| "Show all / Show less" | expand/collapse portion | click | Enter/Space | `button` |
| Diff line | — (read) | — | — | text; wrap is purely visual |

## 10. Accessibility & i18n (UI)

**Accessibility:**
- The whole compare flow is keyboard-operable. The picker is a **single push/pop view stack**
  (list → compare builder → endpoint sub-picker), never stacked overlays, so focus is linear and
  no nested focus trap is needed. Explicit focus + Esc layering:
  - **Enter compare mode** (Compare… activated): focus moves to the **Base** field.
  - **Open an endpoint sub-picker** (Base/Target activated): focus moves to the sub-picker's
    search input; ↑/↓/Enter pick; **Esc pops back to the compare builder** (not the whole menu),
    focus returning to the field that opened it.
  - **Back** in the compare builder: pops to the list view, focus on the **Compare…** row.
  - **Esc at the list (top) level:** closes the picker, focus returns to the trigger.
  - Selecting an endpoint returns to the builder with focus on the next unfilled field (or the
    **Compare** button when both are set).
- `aria-activedescendant` exposes the active row while focus stays in each search input (reuse
  `CommitPickerMenu`'s established pattern); active row scrolled into view. Each view sets
  `aria-label` ("Review source" / "Compare changes" / "Choose base"/"Choose target") so AT
  announces the current level.
- Selection/comparison conveyed by text + `aria-checked`/labels, never color alone.
- Loading uses `aria-busy`; range loading/empty/error are announced via `ReviewView`'s existing
  `sr-only` live region on source change.
- Line wrapping must not strand content off-screen for any input width (the a11y *win* of this
  change); gutter remains associated with its line.
- Item-1 move keeps the trigger's accessible name; ensure the band control has a clear
  `aria-label` distinct from the History/Review icons.

**i18n:**
- Externalize all new strings in a `STR` const: "Compare…", "Back", "Base", "Target",
  "Compare", "Working tree", "Loading comparison…", "No differences between {a} and {b}",
  "Couldn't compare: {reason}", "Show all {n} lines", "Show less", "Review source".
- Labels are locale-aware where they wrap user text (subjects/branch names truncate via CSS with
  full `title`); sha `dir="ltr"` monospace; dates via the existing `relativeTime`.
- **Pluralization:** "Show all {n} lines" is only ever rendered when `n > MAX_CARD_ROWS` (≈40), so
  the singular case is unreachable — no plural rule needed (noted so it isn't mistaken for a gap).
  No other new string is count-bearing.
- **Error reason localization:** `{reason}` in "Couldn't compare: {reason}" is host-supplied
  English (e.g. "Unknown ref"). Treat the host reasons as a small enumerated set defined in the
  same `STR`/protocol vocabulary so they're localizable in one place — don't pass free-form git
  stderr through to the UI.
- The "…" in the trigger label is a literal ellipsis between endpoints, not truncation; keep it
  distinct from CSS overflow ellipsis. Dot-mode (two- vs three-dot) is intentionally **not**
  encoded in the label (the common three-dot case stays clean; D2 governs the mode).

## 11. Design tokens (UI)

- **No new colors.** Reuse `.ctxmenu` / `.git-branch-menu` for the picker + sub-pickers and the
  compare builder rows; reuse `.gh__reffilter` for the trigger and the Base/Target fields.
- The source control on the band reuses the existing trigger shell; place it in `center-gitband`
  with the band's existing spacing (it is a flex row — the control is one more flex child).
- Line wrap: `.rline { white-space: normal; overflow-x: visible; }` is wrong for code — instead
  keep indentation with `.rline__text { white-space: pre-wrap; overflow-wrap: anywhere;
  word-break: break-word; }`, drop `overflow-x:auto` from `.rline`, and set
  `.rline__gutter` / `.rline__sign { align-self: flex-start; }`.
- Compact portion: only the `MAX_CARD_ROWS` constant changes; `.rcard__showrest` is reused.
- Theme variants inherit from the reused classes; no per-theme additions.

---

## 12. Assumptions

- **A1 — `ReviewSourceControl` is a new component** that hosts the trigger + the extended
  `CommitPickerMenu`, rendered in `center-pane.tsx`'s `center-gitband` gated on
  `activeDoc?.kind === 'review'`, fed `source` / `onSetSource` / `sessionId` (already available
  in `CenterPane`). `ReviewSourceSelector` is removed from `review-view.tsx`; `ReviewView` keeps
  `source` + `sessionId` (for the loaders) and drops `onSetSource`.
- **A2 — the git band already renders for Review docs** (`showGitBand` includes the repo-scoped
  Review/History docs). The source control renders inside it regardless of `indicatorOn` (which
  only gates `GitIndicatorBar`). If a future change hides the band for Review, the control must
  move with it — flag, don't silently drop.
- **A3 — range mode reuses commit mode's renderer plumbing.** `ReviewView` already supports a
  "preloaded diffs, no-op `onRequestDiff`" path for commits; generalize the boolean `commitMode`
  to cover range mode (`effectiveDiffs`/`effectiveChanges` fed by `useRangeFiles`), rather than
  adding a parallel branch.
- **A4 — `useRangeFiles`** mirrors `useCommitFiles` (global subscription, cache keyed by
  `${sessionId}\0${rangeKey}`, one settling message) and additionally surfaces the `error`
  channel.
- **A5 — the host range handler reuses the commit-diff file-building helper**; only endpoint
  resolution + dot-mode selection are new (in/around a host git module, with the pure parts in
  `src/git-range.ts`).
- **A6 — ref validation reuses the enumerated-branch check (`git:switch`) and the cat-file sha
  check (`terminal-commit-link`)**; no renderer string ever reaches `execFile` un-validated.
- **A7 — the compare builder lists branches via the existing `git:refs` IPC** (filtered to
  **local** branches so the offered set exactly matches what the host validates against — A6;
  remote-tracking refs are Vision/out-of-scope) and commits via `git:history` (both already used
  elsewhere); no new "list refs" message.

## 13. Decisions Needed

- **[normal] D1 — Picker moves to the git band (reverses `review-commit-picker` D2).** The user
  explicitly asked for this; the prior "keep it in the Review header" rationale is overridden.
  Reversible (it's one render-location change).
- **[normal] D2 — Three-dot for committish pairs, two-dot when an endpoint is the working tree.**
  User-chosen three-dot; two-dot is the only correct mode against an uncommitted tree.
- **[normal] D3 — Endpoints = commit / branch / working tree.** User-chosen.
- **[normal] D8 — Working tree is a TARGET-ONLY endpoint in MVP; untracked files excluded.**
  Allowing the working tree as the *base* would require inverting the patch (`git diff <ref>`
  always puts the working tree on the right), which is fiddly and not a dot-mode; and `git diff
  <ref>` doesn't surface untracked files. So the base is always committish (no inversion), and a
  ref↔working comparison shows tracked changes only. Both are reversible: v1 can add untracked
  (via the working changeset) and a base=working inversion if wanted. The common case (compare a
  ref to my working tree) is fully covered.
- **[normal] D4 — `MAX_CARD_ROWS` ≈ 40.** User chose "Compact (~40)". Exact value is a one-line
  tunable; 40 recommended. Reversible.
- **[normal] D5 — No merge-base ⇒ fall back to two-dot (don't error).** Safer/more useful than
  failing; reversible.
- **[normal] D6 — Range diff preloads all files (parity with commit mode); lazy per-file fetch
  is v1.** Lowest-risk reuse of the proven path.
- **[normal] D7 — Always-wrap, no toggle/setting.** User-chosen; no persistence surface added.

No `high`-severity decisions: every choice is reversible and consistent with shipped patterns.
The only cross-boundary new surface (item 4's IPC) follows the existing `git:commitDiff` +
ref-validation patterns exactly.

## 14. Open questions

None blocking. The four ambiguous calls (wrap behavior, dot-mode, endpoint scope, portion size)
were resolved with the user before this spec; captured as D2/D3/D4/D7.

---

## Verification notes

- **Pure/unit (Vitest):** `rangeKey` (order-significant, stable, distinct per endpoint kind);
  `dotModeFor` (commit/commit→three; commit/branch→three; committish-base + working-head→two;
  working/working→working); `conciseSourceLabel`/`reviewSourceLabel`/`endpointLabel` for the
  `range` variant; the host endpoint-resolution validator (valid sha/branch pass; unknown ref →
  `error`; never builds a shell string) and the empty-vs-error distinction (`files:[]`+no-error =
  empty; `error` set = error); cache-hit re-stamps the live `requestId`. Reuse the existing
  picker-filter tests.
- **Runtime / real-app (e2e on the shared harness, not the mock — item 4 crosses the host
  boundary):** seed a repo with two branches and a large file; open Review; assert the source
  control is on the **git band** (and absent from `review__head`), and absent on a terminal tab;
  build a compare (main↔feature) and assert the diff renders; compare a branch↔working tree;
  compare identical endpoints → "No differences"; force an unknown ref → error state. Assert a
  long line has **no horizontal scrollbar** (scrollWidth ≤ clientWidth on `.rline`); assert a
  1000-line file shows the capped portion + "Show all 1000 lines" then "Show less". Reuse the
  `review-virtualize` / `review-commit-picker` e2e scaffolding.

## Self-audit

All template sections addressed; UI module (§8–11) filled; non-applicable state-catalog states
marked N/A with reason. Host/IPC slice (item 4) given its own data contract (§3) + edge cases
(§4). One architectural reversal (D1) called out explicitly against the prior spec. No `high`
decisions. A fresh-eyes reviewer subagent ran against the FULL pipeline; its findings were folded
in: empty-vs-error contract clarified (`error` only for resolution failures; `files:[]`=empty);
working-tree made a **target-only** endpoint (D8, no patch inversion) with untracked-files
exclusion stated; `requestId` made required with cache-hits re-stamping the live id; branch list
constrained to **local** branches matching host validation (A6/A7); nested sub-picker focus/Esc
layering specified (push/pop stack); empty-repo/unborn-HEAD + binary-file edges added; error state
given a **Retry**; pluralization (unreachable singular) and host-reason localization noted.

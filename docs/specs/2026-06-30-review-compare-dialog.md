---
status: active
date: 2026-06-30
---

# Feature Spec: Review Changes — first-class Compare-refs dialog (tags, discoverable icon, any-to-any diff)

**Tier:** FULL   **Feature type:** UI (+ a host/IPC slice for tag/remote ref enumeration & validation)
**One-line request (verbatim):** "Review Changes diff viewer feature needs to be polished. It might
need an icon and a separate dialog that allows the user to select any branch, commit, or tag,
anything and compare them. The diff changes viewer shouldn't have to checkout a branch to show
changes. The idea is that I can choose certain commits on the same branch, or different branches,
and diff them. feature-spec this heavily to figure out what we lack."

> This is **polish on a feature that already shipped a lot** (Review through v0.17.0). The skill's
> first job here is to **state precisely what already exists vs. what we lack**, then spec only the
> gap. The headline finding: the *engine* the user is asking for (compare two refs without checking
> out, three-/two-dot, host-validated) **already exists and works** — what's missing is (a) **tags
> and remote branches** in the ref model/enumeration/validation/picker, (b) a **first-class,
> discoverable Compare dialog** to replace the cramped nested in-band builder, and (c) a **dedicated
> entry-point icon**. The no-checkout guarantee the user worries about is **already met**.

---

## 0. Triage

**Tier = FULL, feature type = UI.** Multi-surface (new modal + git-band icon + ref pickers), a
host/IPC slice (tag + remote enumeration and validation), and it reverses a shipped UX decision
(the in-band compare builder). The UI module (§8–11) is mandatory; the host slice gets a data
contract (§3) + edge cases (§4).

| Sub-item | Surface | Tier within spec | Why |
|---|---|---|---|
| **A — Tags + remote branches as endpoints** | `src/git-range.ts` (`RefEndpoint`), `src/git-info.ts` (`listBranches`/new ref enumeration), `electron/main.ts` (`git:refs`, `firstInvalidEndpoint`), `src/protocol.ts` (`git:refsResult`) | **FULL** | The literal ask ("any branch, commit, or **tag**, anything"). Today the entire ref pipeline is **local-branches + commits only**. New `tag` endpoint kind + enriched enumeration + host validation. |
| **B — A separate Compare dialog (modal)** | new `webview/components/compare-dialog.tsx`, wired from `center-pane.tsx` / app shell; `commit-picker-menu.tsx` loses its nested builder | **FULL** | User asked for a "separate dialog." Replaces the nested push/pop `CompareBuilder`/`pickBase`/`pickHead` inside `CommitPickerMenu` with one first-class focus-trapped modal: two ref slots shown together, each searchable across all three ref kinds, swap, live preview. |
| **C — A discoverable Compare icon / entry-point** | `git-indicator-bar.tsx` (third icon beside History + Review), `icons.tsx` (`IconCompare`) | **FULL** | User explicitly: "It might need an icon." Today the only way in is a text "Compare…" row buried inside the source picker, which only appears once the Review tab is open. |
| **D — Make the no-checkout guarantee explicit & inherited** | (no code; verification + invariant) | **LITE** | `getRangeDiff` already uses `merge-base`/`diff`/`show` — **never** `checkout`. Confirm, assert in tests, ensure the dialog path reuses the same IPC so it inherits the guarantee. |

---

## What already exists (do NOT re-spec) — audited against the code

Shipped in v0.16.0 (`docs/specs/archive/2026-06-29-review-changes-polish.md`), verified present:

- **Compare-two-refs engine (no checkout).** `git:rangeDiff` IPC (`electron/main.ts:1465`) →
  `getRangeDiff` (`src/git-history.ts:362`) computes the diff with `merge-base` + `git diff
  --name-status` + `git show <rev>:<path>` / reading the working file. **It never checks out a
  branch.** Three-dot for committish pairs, two-dot for ref↔working, two-dot fallback when no
  merge-base (D5). Pure `dotModeFor`/`rangeKey`/`endpointKey`/`endpointLabel` in `src/git-range.ts`.
- **Host validation & security.** `firstInvalidEndpoint` (`electron/main.ts:351`) validates a
  `branch` endpoint against the host-enumerated **local** branch set (`isKnownRef`) and a `commit`
  via `cat-file --batch-check` over stdin. Renderer strings never reach `execFile` un-validated.
  Latest-wins via required `requestId`; cache hits re-stamp the live id.
- **Renderer loader.** `useRangeFiles` (`webview/use-range-files.ts`) — global subscription, cache
  by `${sessionId}\0${rangeKey}`, `loading`/`ready`/`error` channel, `retryRangeDiff` for the
  Review error state's Retry. **Reusable by the new dialog unchanged.**
- **`range` review source** on the singleton Review `OpenDoc`; `conciseSourceLabel`/
  `reviewSourceLabel` render `base…head` / "Comparing base to head".
- **Source control on the git band** (`ReviewSourceControl` in `center-pane.tsx:179`), shown only
  while Review is active; quick list = working tree + recent commits + pasted SHA.
- **A nested in-picker compare builder** (`commit-picker-menu.tsx`): `list → compare →
  pickBase/pickHead` push/pop views; endpoint sub-picker offers **local branches + recent
  commits** (+ working tree for the target).

So the user's core mental model ("choose commits on the same branch or different branches and diff
them, without checking out") is **already implemented**. The request is polish + reach + discoverability.

## What we lack (the real gap)

1. **Tags — entirely missing.** `RefEndpoint` has no `tag` kind; `git:refs`→`listBranches`
   enumerates **`refs/heads` only** (`src/git-info.ts:300`); `firstInvalidEndpoint` has no tag
   validation; the endpoint sub-picker lists no tags. The user's headline word ("or **tag**") is
   unsupported today.
2. **Remote-tracking branches — missing.** "Any branch" implies `origin/*`. Enumeration is
   local-only, so you cannot diff against `origin/main`.
3. **No first-class Compare dialog.** The compare UX is a **nested push/pop builder inside a
   dropdown**: you pick the base, hit Back, pick the head — you never see both slots at once, there
   is **no swap**, **no dot-mode visibility**, **no live preview** of the resulting comparison, and
   it is only reachable after opening the Review tab and clicking the source trigger. This is the
   cramped surface the user is reacting to with "a separate dialog."
4. **No arbitrary / short-SHA endpoint entry.** The list view supports a pasted SHA
   (`isPastedSha`), but the **endpoint** sub-pickers do **not** — you can only pick a branch or one
   of the recent ~150 commits. You cannot compare against a SHA outside that window.
5. **No dedicated icon / entry-point.** The git band has History + Review icons but no Compare
   icon; "Compare…" is a text row two clicks deep.
6. **(Not a gap — confirm only.)** No-checkout is already guaranteed; nothing to fix, just assert.

---

## 1. Problem frame

- **Job:** Let the user compare *any* two points in the repo's history — a commit, a local branch,
  a remote-tracking branch, a **tag**, or the working tree — against each other, from a clear,
  discoverable place, and read the diff **without ever changing the checked-out branch**.
- **Actors:** the single local user reviewing/auditing changes in the desktop app.
- **Success outcomes (observable):**
  - A recognizable **Compare** icon sits on the git band beside History + Review; clicking it opens
    a **modal** Compare dialog (reachable even when the active tab is not Review).
  - The dialog shows **two ref slots at once** (Base, Target). Each is a searchable field that
    finds **local branches, remote branches, tags, and commits**, and accepts a **pasted/short
    SHA**. A **Swap** control flips them. A **live preview** shows the resulting label
    (`base…head`) and which diff mode it will use.
  - Confirming opens (or re-scopes) the Review tab to that comparison; the working branch is
    **never** checked out.
  - An unknown/deleted ref or bad SHA yields a clear inline error with Retry; identical endpoints
    yield a "No differences" state.
- **Non-goals:**
  - No diff *editing* / staging from Review (still read-only).
  - No commit graph in the dialog (that's History); the ref fields are flat + searchable.
  - No three-way / N-way compare; exactly two endpoints.
  - No persistence of the comparison across restart (Review source is ephemeral, `docs.ts` §3.4).
  - No new compare *behavior* — reuse the shipped `git:rangeDiff` engine as-is; this spec only adds
    **tag/remote** reach to it and a better front door.
  - No stash-as-endpoint (Vision).

---

## 2. Behavior & states

**Entry**
1. The git band shows three trailing icons: History · Review · **Compare** (new). Note
   `GitIndicatorBar` returns `null` when `git` is absent/`'none'` (line 121), so in a **non-git
   folder the whole bar — including the new icon — simply does not render** (parity with
   History/Review); there is no surface to show a "disabled in non-git" state. The
   **disabled-with-tooltip** state therefore applies only to the **empty/unborn repo** (the bar
   renders, but there is no committish ref to compare). Enabled whenever ≥1 committish ref exists.
2. Clicking Compare opens the modal **regardless of the active doc**. On confirm, the Review tab is
   opened/focused and scoped to the comparison (so Compare works as a standalone entry, not only
   from inside Review). The in-picker **"Compare…"** row (source control) opens the **same** modal.

**Compare dialog flow**
- `closed` → `open` (focus trap; focus lands on the **Base** field).
- Each ref field: `idle` → typing filters a unified result list (sectioned: Branches · Remotes ·
  Tags · Commits) → pick → field shows the chosen endpoint's label. A pasted/short hex string
  surfaces a "Use commit `<sha7>`" result even when not in the recent window.
- **Swap** flips Base/Target (and any chosen endpoints). Because the working tree is target-only
  (D8), Swap is **disabled while Target is the working tree** (swapping it into Base would force a
  D8-forbidden inverted diff; never silently collapse the committish side to `{kind:'working'}`).
- **Enumeration on open:** the dialog requests `git:refs` (branches/remotes/tags) and `git:history`
  (commits) when it opens → `enumerating` → (`ready` | `enum-error`). `git:refs` has **no
  error/timeout channel today** (fire-and-forget); add one (or a renderer-side timeout mirroring
  `CommitPickerMenu`'s `LOAD_TIMEOUT_MS`) so a non-responding host surfaces a Retry-able dialog
  error instead of permanently empty fields.
- **Prefill on reopen:** when opened while a `range` source is already active, the fields prefill
  from the current `ReviewSource` (so re-opening tweaks the live comparison rather than starting
  blank). Opened from a `working`/`commit` source, both fields start empty.
- **Preview** updates live: the resulting `base…head` label + a small mode hint ("merge-base /
  three-dot", "working tree / two-dot"). Disabled-state copy when a slot is empty.
- **Compare** (confirm) is enabled only when both slots are set **and** the pair is non-degenerate
  (not identical committish; not working-vs-working). On confirm: set `{kind:'range', base, head}`
  (or collapse to `{kind:'working'}` when `dotModeFor === 'working'`), open/focus Review, close
  the dialog.
- **Cancel / Esc / backdrop click** → `closed`, focus returns to the trigger.

**Review body (unchanged from shipped range mode):** `loading` → (`ready` | `empty` | `error`).
`empty` = host returned `files:[]` with no `error` (identical/no-difference). `error` = an
endpoint could not be resolved (carries a `reason`), with **Retry**.

**Working-tree endpoint:** target-only (Decision carried from D8) — base is always committish, no
patch inversion. Untracked files excluded in a ref↔working comparison (known limitation, D8).

---

## 3. Data / interface contract

### Renderer types (`src/git-range.ts`)

```ts
// EXTENDED — add tag (and let branch carry remote refs); working stays target-only (D8).
type RefEndpoint =
  | { kind: 'working' }
  | { kind: 'commit'; sha: string; subject?: string }
  | { kind: 'branch'; ref: string; remote?: boolean }   // remote?:true ⇒ refs/remotes/<ref>
  | { kind: 'tag'; ref: string };                         // NEW

// endpointKey: add  case 'tag': return `t:${ep.ref}`;  and  remote branches → `b:${ep.ref}` (the
// ref string already disambiguates "main" vs "origin/main"); endpointLabel: tag → ep.ref.
// dotModeFor: a tag/remote-branch is committish, so it behaves exactly like a local branch
// (three-dot vs another committish; two-dot vs working). No new mode.
```

`ReviewSource`'s `range` variant is unchanged (it already holds two `RefEndpoint`s). The additive
`tag` kind and `remote` flag flow through `rangeKey`, the loader cache key, and the labels with no
shape change to the IPC payloads below.

### Host ref enumeration (the main new host work)

Today `git:refs` → `listBranches` returns `{ branches, current }` from `for-each-ref refs/heads`.
Enrich it (or add a sibling) so the renderer can offer all three ref kinds **from the host's own
enumerated set** (so the offered set == the validated set):

```ts
// HostToWebview — EXTEND git:refsResult (back-compat: keep branches/current; add tags/remotes)
| { type: 'git:refsResult'; sessionId: string;
    branches: string[]; current: string | null;
    remotes: string[];   // e.g. "origin/main" (refs/remotes, excluding "<remote>/HEAD")
    tags: string[] }     // e.g. "v0.17.0"   (refs/tags)
```

- Enumerate via additional non-throwing `for-each-ref` calls (`refs/remotes`, `refs/tags`) mirroring
  `listBranches`' discipline (arg array, timeout, `gitAvailable` latch). Exclude the symbolic
  `origin/HEAD` from remotes. Bound the tag list defensively (e.g. cap + sort, newest first via
  `--sort=-creatordate`) so a repo with thousands of tags doesn't flood the payload.

### Host validation (`electron/main.ts` `firstInvalidEndpoint`)

```
for each endpoint:
  branch  (local)  → isKnownRef(ref, branches)            // existing
  branch  (remote) → ref ∈ enumerated remotes             // NEW
  tag              → ref ∈ enumerated tags                 // NEW
  commit           → validateCommits via cat-file          // existing
  working          → ok                                    // existing
else → 'Unknown ref' | 'Unknown commit'
```

Renderer ref strings are **never** interpolated into `execFile`: each is re-checked against the
host's freshly enumerated set (the established `git:switch` discipline). `getRangeDiff`'s `refStr`
gains a `tag` case returning `ep.ref`; remote branch refs already pass through as the rev string —
git resolves `origin/main`/`v1.2.3` as a committish for `merge-base`/`diff`/`show`. **No checkout.**

**Required handler change (easy to miss):** the `git:rangeDiff` handler today calls
`listBranches(cwd)` and passes only `branches` to `firstInvalidEndpoint` (`electron/main.ts:1470`).
To validate tag/remote endpoints it must **also enumerate tags + remotes at request time**, and the
validator signature changes `branches: readonly string[]` → `refs: { branches, remotes, tags }`.
This enumeration is separate from (and in addition to) the `git:refs` enrichment above — the diff
path re-validates against its own fresh enumeration, never against renderer-supplied lists.

### Invariants

- Renderer never spawns git; host enumerates + validates every ref kind.
- The offered ref set in the dialog is exactly the host-enumerated set (no free-typed ref reaches
  git except a hex SHA, which is `cat-file`-validated).
- No code path in the compare flow runs `git checkout`/`switch` (D — verified in `getRangeDiff`).
- Latest-wins via `requestId`; an unresolvable endpoint → handled `error`, never a hang/crash.

---

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Non-git folder | The git band (and thus the Compare icon) does not render at all (`GitIndicatorBar` returns `null`) — parity with History/Review. |
| Empty (unborn) repo | Bar renders; Compare icon **disabled** with a tooltip ("No commits to compare"). |
| Swap while Target = working tree | Swap is **disabled** (swapping would put working into Base, a D8-forbidden inverted diff). Never silently drop the committish endpoint. |
| Ref enumeration fails / times out on open | Dialog shows an `enum-error` state with Retry (today `git:refs` has no error channel — add one or a renderer timeout). |
| Repo with branches but no tags/remotes | Those sections simply don't render in the ref fields; branches + commits still work. |
| Thousands of tags/branches | Host caps + sorts the enumerated lists; the field filters client-side; a "+N more — refine search" hint when truncated. |
| Pasted full/short SHA not in the recent window | A "Use commit `<sha7>`" result appears; on pick it becomes a `commit` endpoint; host `cat-file`-validates it; unknown → error state on Compare. |
| Ambiguous short SHA (prefix matches >1 object) | Host resolution returns the object only if `cat-file` yields a unique commit; otherwise `Unknown commit` error (don't guess). |
| Identical committish endpoints (e.g. `main`↔`main`, or a tag on the same commit) | Compare button **disabled** with "Pick two different points"; if somehow submitted, host returns `files:[]`/no-error → **empty** "No differences" state. |
| Tag and branch pointing at the same commit | Same as identical endpoints (no differences) — allowed to submit; shows the empty state. |
| Working tree chosen as **base** | Not offered — base field omits the working tree (D8); working is target-only. |
| Both = working tree | Cannot arise (base can't be working); collapses to `{kind:'working'}` if ever constructed. |
| No merge-base (unrelated histories) for a committish pair | Two-dot fallback, show the diff (D5) — unchanged. |
| Deleted/renamed branch or tag between enumeration and Compare | Host re-enumerates at request time; a now-missing ref → `Unknown ref` error + Retry. |
| Remote ref `origin/HEAD` | Excluded from the remotes list (it's a symbolic alias, noise). |
| Binary / over-size file in the comparison | Inherits commit/range rendering ("Binary file — no diff preview"); no new handling. |
| Very large comparison (thousands of files) | Windowed renderer + single preloaded payload (parity with shipped range mode); lazy per-file fetch stays v1. |
| Compare opened while not on the Review tab | On confirm, open/focus the singleton Review doc, then scope it; the dialog does not require Review to be active. |
| Source changes / new compare mid-load | Late `git:rangeDiffResult` dropped by `requestId`/`key` guard (existing). |
| Branch/tag name with `/` or unusual chars | Validated by exact match against the enumerated set; rendered `dir="ltr"`, truncated via CSS; never shell-interpolated. |
| Reduced-motion / forced-colors | Modal uses the existing `.modal__backdrop`/`.confirm` shell (high-contrast safe); no motion- or color-only signal. |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Ref kinds offered | local branches · remote branches · tags · commits · working (target only) | No | The literal ask ("any branch, commit, or tag, anything"). |
| Compare dot-mode | three-dot (merge-base) for committish pairs; two-dot vs working | No (v1: in-dialog toggle) | Carries shipped D2; matches GitHub Compare. Surfacing it read-only in the preview is new; a toggle is v1. |
| Dialog vs in-band builder | **Replace** the nested builder; "Compare…" opens the modal | No | One compare surface (root-cause fix); the cramped nested builder is what the user is reacting to. See **D-A**. |
| Compare reachable when Review not active | Yes (icon opens dialog; confirm opens Review) | No | "Separate dialog" implies standalone reach. |
| Working tree as base | Not offered (target-only) | No | Carries D8 (no patch inversion; untracked excluded). |
| Comparison persistence | Not persisted | No | Consistent with ephemeral Review source. |
| Tag/remote enumeration caps | Cap + newest-first sort | No (named consts) | Bound payload for huge repos. |

---

## 6. Scope slicing

- **MVP (must):**
  - **A:** `tag` endpoint kind + `remote` branch flag; `git:refsResult` enriched with `tags` +
    `remotes`; host enumeration (`for-each-ref refs/tags` + `refs/remotes`); `firstInvalidEndpoint`
    signature → `{branches, remotes, tags}` and the `git:rangeDiff` handler enumerates all three at
    request time; `getRangeDiff`/`refStr` tag case; pure-helper updates
    (`endpointKey`/`endpointLabel`/labels) + tests.
  - **B:** `CompareDialog` modal (focus trap, Esc/backdrop) with two ref fields (sectioned
    branches/remotes/tags/commits + pasted-SHA), Swap, live `base…head` preview + mode hint,
    Compare/Cancel; confirm wires `{kind:'range'}` and opens/focuses Review. Enumeration
    loading/error (Retry) state + a `git:refs` error/timeout channel. Swap disabled when
    Target=working. Remove the nested `CompareBuilder`/`pickBase`/`pickHead` from
    `CommitPickerMenu`; its "Compare…" opens the modal.
  - **C:** `IconCompare` + git-band Compare button (beside History/Review), enabled/disabled logic,
    aria-label + tooltip.
  - **D:** no-checkout invariant asserted (test + doc).
- **v1 (should):** in-dialog two-/three-dot toggle; recent-comparisons list; remote-branch fetch
  hint when stale; Compare entry from History (select two commits → dialog prefilled).
- **Vision (could):** stash as an endpoint; annotated-tag peeling display; cross-repo compare.
- **Out of scope:** editing/staging from Review; N-way compare; persisting comparisons; commit
  graph in the dialog.

---

## 7. Acceptance criteria

**Declarative:**
- A Compare icon appears on the git band beside History + Review and opens a modal dialog from any
  tab; it is disabled (with a tooltip) in an empty/unborn repo and absent in a non-git folder (the
  whole bar is `null`).
- The dialog shows Base and Target together; each field finds local branches, remote branches,
  tags, and commits, and accepts a pasted/short SHA; Swap flips them; a live preview shows
  `base…head` and the diff mode.
- Picking a tag (or remote branch) on either side and confirming scopes Review to that comparison;
  the checked-out branch does not change.
- An unknown ref / bad SHA shows an error state with Retry; identical endpoints show "No differences".
- The nested in-band compare builder is gone; the "Compare…" row opens the same modal.

**EARS:**
- *Ubiquitous:* The git band shall present a Compare entry-point whenever the active session is a
  git repo with at least one committish ref.
- *Event:* When the user confirms a comparison, the system shall request `git:rangeDiff` and scope
  the Review tab to the result **without checking out any ref**.
- *State:* While either ref slot is empty or the two committish endpoints are identical, the system
  shall keep the Compare action disabled.
- *Unwanted:* If an endpoint cannot be resolved to a valid branch/remote/tag/commit, then the
  system shall show an error state with a Retry, and never spawn git with the raw string.
- *Unwanted:* If a stale `git:rangeDiffResult` arrives after a newer request, the system shall
  discard it.

**Gherkin (key flows):**
```gherkin
Feature: Compare-refs dialog
  Background:
    Given a git repo with branch "main", remote "origin/main", tag "v1.0.0", and several commits
    And a Conduit session open on that repo

  Scenario: Compare a tag against a branch from the icon
    When I click the Compare icon on the git band
    Then a modal opens with empty Base and Target fields
    When I set Base to tag "v1.0.0" and Target to branch "main"
    Then the preview reads "v1.0.0…main" with a merge-base hint
    When I confirm
    Then the Review tab opens showing main relative to v1.0.0
    And the checked-out branch is unchanged

  Scenario: Compare against a remote branch
    When I open Compare and set Base "origin/main" and Target "main"
    And I confirm
    Then Review shows main relative to origin/main

  Scenario: Pasted SHA endpoint
    When I open Compare and type a 9-char commit SHA into Target
    Then a "Use commit <sha7>" result appears
    When I pick it and set a Base and confirm
    Then Review shows that comparison

  Scenario: Swap endpoints
    Given Base "main" and Target "feature"
    When I activate Swap
    Then Base is "feature" and Target is "main" and the preview updates

  Scenario: Identical endpoints
    When I set Base "v1.0.0" and Target "v1.0.0"
    Then Compare is disabled
```

---

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Git-band Compare icon | enabled | Compare glyph + tooltip "Compare changes" | Open dialog |
| Git-band Compare icon | disabled (empty/unborn repo) | Dimmed glyph + tooltip "No commits to compare" | — |
| Git-band Compare icon | absent (non-git) | Not rendered (whole bar is `null`) | — |
| Compare dialog | enumerating | Fields show a loading affordance while refs/commits load | Wait |
| Compare dialog | enum-error | "Couldn't load refs" + Retry | Retry |
| Compare dialog | open/idle | Base + Target fields ("Choose a ref…"; prefilled from an active `range`), Swap, disabled Compare, Cancel | Type / pick |
| Swap | disabled | Dimmed (Target = working tree) | — |
| Ref field | typing | Sectioned results: Branches · Remotes · Tags · Commits (+ pasted-SHA result) | Filter / pick |
| Ref field | chosen | Endpoint label (branch/remote/tag ref or sha7) + clear (×) | Re-open / clear |
| Ref field | no matches | "No refs or commits match" | Refine |
| Preview | both set | "`base…head`" + mode hint (merge-base / working tree) | — |
| Preview | identical | "Pick two different points" (Compare disabled) | — |
| Compare button | ready | enabled | Confirm |
| Review body | range loading | "Loading comparison…" (`aria-busy`) | Wait |
| Review body | range empty | "No differences between `<base>` and `<head>`" | New compare |
| Review body | range error | "Couldn't compare: `<reason>`" + Retry | Retry / new compare |

(Offline / auth / saving states N/A — local, read-only.)

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | ARIA |
|---|---|---|---|---|
| Compare icon (git band) | open dialog | click | Enter/Space | `button`, `aria-haspopup="dialog"`, `aria-label="Compare changes"`, `title`; `disabled` when no refs |
| Dialog container | trap focus | — | Tab cycles within; **Esc** cancels; backdrop click cancels | `role="dialog"`, `aria-modal`, `aria-labelledby` (title) |
| Base / Target field | open results, pick, clear | click; click × to clear | type to filter; ↑/↓ active; Enter pick; Esc close list (not dialog) | `combobox` + `aria-expanded` + `aria-activedescendant`; labelled "Base"/"Target" |
| Result row | pick endpoint | click; hover=active | ↑/↓/Enter | `option`/`menuitem`; section group labels |
| Swap | flip base/head | click | Enter/Space | `button`, `aria-label="Swap base and target"` |
| Compare (confirm) | apply range | click | Enter (when enabled) | `button`, `disabled` until valid |
| Cancel | dismiss | click | Esc | `button` |
| Review Retry | re-issue compare | click | Enter/Space | `button` |

## 10. Accessibility & i18n (UI)

**Accessibility (WCAG 2.2):**
- **Focus trap** in the modal (Tab/Shift-Tab cycle within; first focus on the Base field). On close,
  focus returns to the Compare icon that opened it (or the "Compare…" row). Follow the shipped
  `conflict-dialog.tsx`/`confirm-dialog.tsx` modal shell (`.modal__backdrop`, `role`, `aria-modal`,
  Esc handler, backdrop-click dismiss) — do not hand-roll a new modal mechanism (root-cause reuse).
- **Keyboard-operable end to end:** every action (open, type, navigate results, pick, swap,
  confirm, cancel) reachable without a pointer. The ref field is a combobox: focus stays in the
  input, `aria-activedescendant` points at the active result, active row scrolled into view (reuse
  `CommitPickerMenu`'s established pattern).
- **Esc layering:** Esc with a result list open closes the **list**; Esc with no list open cancels
  the **dialog** (don't let one Esc nuke everything).
- **Accessible names:** icon-only Compare button + Swap need `aria-label`; each ref field needs a
  visible label ("Base"/"Target") tied via `aria-labelledby`. Result sections announce their kind.
- **Announce results:** loading/empty/error of the comparison announced via Review's existing
  `sr-only` live region on source change; an invalid pick announces the error.
- **Color never the only signal:** the diff mode hint, the chosen-endpoint state, and the
  identical-endpoints disabled reason are all text, not color.
- **Disabled affordances** (Compare, the icon in a non-git repo) keep a discoverable tooltip /
  `aria-disabled` reason — don't silently no-op.
- **Visible focus** preserved in forced-colors (reuse `.btn`/`.ctxmenu` focus rings).

**i18n:**
- Externalize all new strings in a `STR` const: "Compare changes", "Compare", "Cancel", "Base",
  "Target", "Choose a ref…", "Swap base and target", "Branches", "Remotes", "Tags", "Commits",
  "Use commit {sha7}", "No refs or commits match", "No commits to compare", "Couldn't load refs",
  "Retry", "Pick two different points", "merge-base", "working tree", plus the existing range labels.
- **Pluralization:** the "+{n} more — refine search" truncation hint is the only count-bearing new
  string; use plural-aware formatting (n is always ≥1 when shown).
- **Locale/format:** commit dates via the existing `relativeTime`; SHAs `dir="ltr"` monospace; ref
  names `dir="ltr"`, truncated via CSS with a full `title`.
- **Text expansion:** the two-slot layout must tolerate ~30%+ longer labels (German/long branch
  names) — fields wrap/truncate, not overflow.
- **RTL:** the modal mirrors; the `base…head` order and the Swap direction are **logical**, not
  visually reversed (the ellipsis between endpoints is a literal separator, not truncation).
- **Error-reason localization:** host reasons stay a small enumerated set (`Unknown ref`/`Unknown
  commit`) localized in one place — never pass raw git stderr to the UI.

## 11. Design tokens (UI)

- **No new colors.** Modal reuses `.modal__backdrop` + the `.confirm`/dialog shell; ref fields reuse
  `.gh__reffilter` / `.git-branch-menu__filter`; result list reuses `.ctxmenu`/`.commit-picker`
  classes; buttons reuse `.btn`/`.btn--primary`.
- **Compare icon:** add `IconCompare` to `icons.tsx`. lucide-react is available (`import * as
  LucideIcons`); recommended glyph **`GitCompareArrows`** (or `GitCompare`) — visually distinct from
  History (clock) and Review (list/diff). Size 13 to match the sibling icons; place it after the
  Review button in `git-indicator-bar.tsx` (or in `center-gitband` if it must show without the
  indicator — see D-C).
- Section group headers in the ref field reuse existing menu-section styling; no per-theme additions.
- Live-preview row reuses muted-text token; the mode hint is a small secondary-text badge.

---

## 12. Assumptions

- **A1 — Reuse the shipped range engine wholesale.** `git:rangeDiff`/`getRangeDiff`/`useRangeFiles`
  are unchanged except `refStr` gaining a `tag` case and `firstInvalidEndpoint` gaining tag/remote
  validation. The dialog produces the same `{kind:'range', base, head}` the in-band builder does, so
  the Review render path is untouched.
- **A2 — `git:refsResult` is extended additively** (`tags`, `remotes` added; `branches`/`current`
  kept) so existing consumers (`BranchSwitcherMenu`, the source picker) keep working. The branch
  switcher continues to switch **local** branches only (switching to a remote/tag is out of scope).
- **A3 — The Compare dialog is an in-app renderer modal** (not a native OS dialog) so it is
  smoke-testable (per the project's "native dialogs are invisible to the harness" gotcha) and
  consistent with `conflict-dialog`/`confirm-dialog`.
- **A4 — Dialog state is local + ephemeral**; on confirm it dispatches the existing
  `onSetReviewSource` (opening Review first if needed). No new persistence.
- **A5 — The Compare button can live on the git band even when the indicator is off / Review is not
  active**, mirroring how the band already renders for Review (`showGitBand`). Exact host of the
  button (inside `GitIndicatorBar` vs `center-gitband`) is D-C.
- **A6 — Pasted-SHA endpoint** reuses `isPastedSha` to surface a "Use commit" result in the ref
  field; the host `cat-file`-validates it exactly as the list view's pasted SHA today.
- **A7 — Tag enumeration peels lightweight vs annotated tags transparently** — `for-each-ref
  refs/tags` names are used as the rev; git resolves annotated tags to their commit for
  diff/merge-base, so no extra peeling is needed for the diff (display peeling is Vision).

## 13. Decisions Needed (autonomous mode — surfaced for the conductor)

- **[high] D-A — Replace the nested in-band compare builder with the modal (vs. keep both).**
  Recommendation: **replace.** Maintaining two compare UIs is the band-aid; the cramped nested
  push/pop builder is exactly what the user is reacting to. Removing it deletes shipped code/UI
  (`CompareBuilder`, `pickBase`/`pickHead`, their tests), hence **high**. The "Compare…" row stays
  but opens the modal. Reversible but cross-cutting.
- **[high] D-B — Add a `tag` endpoint kind + remote branches across the ref pipeline.** This is the
  literal headline ask, and it touches the host security boundary (`firstInvalidEndpoint`,
  `git:refs` enumeration) plus the shared `RefEndpoint` type. Recommendation: ship it (additive,
  follows the exact `git:switch`/`cat-file` validation patterns). Tagged **high** only because it
  crosses the host/IPC boundary and changes a shared type — the change itself is low-risk.
- **[normal] D-C — Compare button placement + standalone reach.** Recommendation: render it on the
  git band beside History/Review **and** allow opening the dialog when Review is not the active doc
  (confirm opens Review). Alternative: gate it to Review-active only (less discoverable). Reversible.
- **[normal] D-D — Surface the diff mode (two-/three-dot) in the dialog.** Recommendation: show it
  read-only in the preview now; add a toggle in v1. Carries shipped D2 (three-dot default).
- **[normal] D-E — Tag/remote enumeration caps + sort.** Recommendation: newest-first, capped with
  a "refine search" hint. Reversible (named consts).

No decision halts the build; D-A/D-B are tagged `high` because they touch shipped UI and the host
security boundary respectively, and the conductor may want to confirm the deletion of the in-band
builder before it happens.

## 14. Open questions

None blocking. The ambiguous calls (replace-vs-keep the builder, tag/remote reach, standalone
entry, dot-mode surfacing) are captured as severity-tagged decisions above with recommended,
reversible defaults.

---

## Verification notes

- **Pure/unit (Vitest):** extend `git-range` tests for the `tag` kind + remote branch in
  `endpointKey`/`rangeKey`/`endpointLabel`/`dotModeFor` (tag/remote behave as committish);
  `conciseSourceLabel`/`reviewSourceLabel` for tag/remote endpoints; the host
  `firstInvalidEndpoint` validator (valid tag/remote/sha pass; unknown → error; never builds a
  shell string); ref enumeration parsing for `refs/tags` + `refs/remotes` (excludes
  `origin/HEAD`); identical-endpoint disable predicate.
- **Runtime / real-app (e2e on the shared harness — crosses the host boundary):** seed a repo with
  a branch, a remote-tracking ref, a tag, and several commits; open the Compare dialog from the
  git-band icon (and from the "Compare…" row); compare **tag↔branch**, **remote↔local**, and a
  **pasted SHA**; assert the diff renders and **`git rev-parse --abbrev-ref HEAD` is unchanged**
  (the no-checkout guarantee, D); swap endpoints; identical endpoints → Compare disabled / "No
  differences"; unknown ref → error + Retry. Reuse the `review-commit-picker` / range e2e scaffolding.

## Self-audit

All template sections addressed; the UI module (§8–11) is filled (state catalog, interaction
inventory, a11y + i18n, design tokens). The spec leads with an explicit **exists vs. lacks**
audit grounded in file:line evidence so the downstream agent re-specs nothing already shipped. The
host slice (tags/remotes) has its own data contract (§3) + edge cases (§4) + security invariants.
Two `high` decisions are surfaced (delete the in-band builder; cross-boundary tag/remote support);
no decision halts. A fresh-eyes reviewer subagent was dispatched against the FULL pipeline and
**verified the exists-vs-lacks audit against the code (file:line) — all load-bearing claims
confirmed, no false assertions.** Its four completeness findings were folded in before finalizing:
the Swap-into-base edge (Swap disabled when Target=working), a dialog ref-enumeration
loading/error state (`git:refs` needs an error/timeout channel), explicit tag/remote enumeration +
validator-signature change on the `git:rangeDiff` path, and reconciling the "disabled icon in
non-git" claim with `GitIndicatorBar`'s `null` render (absent in non-git; disabled only in
empty/unborn).

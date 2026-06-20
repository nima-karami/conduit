---
status: implemented
date: 2026-06-18
---

> **Shipped:** Slice A (read-only indicator) in 0.3.0; Slice B (in-place **branch**
> switcher — refuse-if-busy/dirty, out-of-band `git checkout`, D-1 approved by the user
> 2026-06-20) on `git-run` (`ef7a555`). Worktree-*switch*-in-place remains the deferred
> future "open worktree in a new session" affordance (spec rejected-alt c / Vision).

# Feature Spec: Branch / worktree indicator + switcher at the top of a terminal tab

**Tier:** FULL   **Feature type:** UI
**One-line request:** "Branch / worktree indicator + switcher at the top of a terminal tab. Conduit has no way to show where the user is — current git branch, whether they're in a worktree, etc. Want a clean, elegant indicator, breadcrumb-style (like the editor-tab breadcrumbs) at the TOP of the terminal tab, surfacing branch + worktree, and ideally a dropdown to switch branch / worktree in place."

> **Build order, read this first.** Ship in two slices. **Slice A (safe v1) = the read-only
> indicator** — the entire host git-interrogation seam, the breadcrumb-style render, and all
> states. This is the primary value and carries no risk to a running shell. **Slice B
> (guarded) = the switcher dropdown.** It runs git in a directory that may have a live PTY,
> which is risky; its safe default (Decision D-1) is deliberately conservative. **If Slice B's
> safety review is unresolved, ship Slice A alone — it is a complete, useful feature.**

---

## 1. Problem frame

- **Job (JTBD):** "When I'm working in a Conduit terminal, I want to see at a glance which git
  branch and worktree this shell is in — so I don't fat-finger a commit onto the wrong branch
  or get lost across worktrees — and ideally switch without leaving the tab."
- **Actors / roles:** A single local developer driving one or more terminal sessions. No
  multi-user, no remote actor. The git data producer is the Electron **main process**; the
  consumer is the **renderer** (it holds no source of truth — per `CLAUDE.md` the bridge is
  `window.agentDeck` and all state lives in main).
- **Success outcomes (observable):**
  - When a terminal's cwd is inside a git repo, a breadcrumb-style strip at the top of the
    terminal pane shows the current branch (or detached SHA) and, when the cwd is a linked
    worktree, a worktree marker.
  - The indicator updates after the shell changes directory across the live-cwd seam (E2),
    without busy-polling.
  - Non-git directories, detached HEAD, bare repos, and mid-operation (rebase/merge) each
    render a clear, distinct state — never a crash, never a stale lie.
  - (Slice B) The user can open a dropdown and switch branch/worktree, with a safety rule that
    never silently corrupts a running process's working tree.
- **Non-goals (explicitly out of scope):**
  - Full git status (staged/unstaged counts, ahead/behind) in this indicator — that's the
    Changes panel's job (`git-actions`). We surface at most a single **dirty dot**, no counts.
  - Creating branches/worktrees, deleting them, fetch/pull/push, stash UI — switch only.
  - A repo-wide branch indicator outside terminal tabs (file/diff tabs keep the E3 path
    breadcrumb; this indicator is terminal-only).
  - Remote-tracking/upstream display, PR state, commit graph.

---

## 2. Behavior & states

**Primary flow (happy path):** A terminal session is active. The host already tracks
`session.cwd` (E2, OSC 7/9;9/1337 parsing → `src/osc-cwd.ts` → `Session.cwd`). On cwd change
(and on session start), the host interrogates git for that cwd, computes a `GitInfo`, attaches
it to the session, and rebroadcasts state. The renderer renders a `GitIndicatorBar` in the
same band the E3 `BreadcrumbBar` uses, but only while a terminal (not a file/diff doc) is the
active surface.

**States / transitions** (the feature moves through exactly one render state per session,
derived from `GitInfo`):

| `GitInfo` kind | Trigger | What the bar shows |
|---|---|---|
| `none` (no repo) | cwd is not inside any git repo | Bar **hidden** (default) — see Decision D-4 |
| `branch` | on a named branch | branch icon + branch name (+ dirty dot if dirty) |
| `branch` (unborn) | repo exists, **HEAD is unborn** (fresh `git init`, zero commits, *not* bare) | branch icon + the unborn branch name + faint "no commits" tag — see note below |
| `detached` | detached HEAD | branch icon (dimmed) + short SHA (7 chars), label "detached" |
| `worktree` (modifier) | cwd is a **linked** worktree | worktree marker prepended; branch/detached shown as usual |
| `bare` | `--is-bare-repository` is true | repo icon + "bare"; no branch segment, no dirty/op |
| `operation` (modifier) | mid-rebase / mid-merge / cherry-pick / revert / bisect | operation badge (e.g. "REBASING") prepended to the **active segment**, whether that segment is a branch name *or* a detached SHA |
| `error` | git present but interrogation failed/timed out | bar hidden, error recorded to host log only (never a user-facing scare) |

**Unborn HEAD vs. bare — distinct, don't conflate.** A fresh `git init` (or a repo with zero
commits) is **not bare**: `--is-bare-repository` is false, but `rev-parse HEAD` fails because
HEAD points at a branch ref that doesn't exist yet. Map this to `kind: 'branch'` with the
unborn branch name (read from `.git/HEAD`'s `ref: refs/heads/<name>` symref, which exists even
unborn) and `operation: undefined`, plus a `unborn: true` flag so the renderer shows the
"no commits" tag and the switcher is disabled (nothing to switch to). Only `--is-bare-repository`
true → `kind: 'bare'`.

**Operation + detached.** Rebasing can happen while detached. The `operation` badge prepends to
whichever segment is active — a branch name in the normal case, the short SHA when detached. It
is never a separate segment of its own.

Slice B adds, per segment, an **idle → open → switching → resolved/failed** dropdown lifecycle
(see §8 state catalog).

---

## 3. Data / interface contract

All git data is produced host-side and pushed to the renderer via the existing typed protocol
(`src/protocol.ts`, discriminated union on `type`). The renderer never spawns git.

**`GitInfo` (new type, host-authored, ride on `Session`):**

```ts
// src/types.ts — new
export type GitOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect';

export interface GitInfo {
  kind: 'branch' | 'detached' | 'bare' | 'none';
  branch?: string;        // present when kind === 'branch' (incl. unborn)
  unborn?: boolean;       // kind === 'branch' but HEAD has no commit yet (fresh init)
  sha?: string;           // short SHA (7), present when kind === 'detached'
  isWorktree?: boolean;   // true when cwd is a *linked* worktree (not the main tree)
  worktreeName?: string;  // display label for the worktree dir, when isWorktree
  dirty?: boolean;        // working tree has any change (porcelain non-empty)
  operation?: GitOperation; // in-progress op, if any
}
```

**Type-level invariants the renderer may rely on (enforced by the host constructor, not the
optional `?` markers):** `kind === 'branch'` ⇒ `branch` is defined; `kind === 'detached'` ⇒
`sha` is defined; `isWorktree === true` ⇒ `worktreeName` is defined; `kind === 'bare'` ⇒
`dirty`/`operation`/`branch`/`sha` are all undefined. The renderer must still guard (defensive),
but the host never emits a `GitInfo` that violates these.

**`worktreeName` collisions:** two worktrees can share a directory basename. To stay glanceable
the label is the basename, but when the host detects two known worktrees with the same basename
it disambiguates by appending the parent dir (e.g. `feat (../wt-a)` vs `feat (../wt-b)`). The
full path is always in the segment's `title`/accessible name.

**`git:switchResult.message` is pre-localized UI copy** (the host maps known failure reasons to
externalized strings, §10), **except** when it must surface git's raw stderr for an unexpected
failure — in that one case `message` is git's verbatim (untranslated) output, clearly the
fallback path, not the common one.

`Session` gains one optional field: `git?: GitInfo` (mirrors how `cwd?: string` was added in
E2 — additive, runtime-derived, never persisted to `sessions.json`).

**Inputs (host side):** `session.cwd ?? session.projectPath` (the `activeCwd(s)` selector,
`src/active-cwd.ts`). Trust boundary: cwd is a local filesystem path the host already trusts;
git is invoked with `execFile('git', [...], { cwd })` — **never** a shell string, so the cwd
can't inject. No user-supplied free text reaches git in Slice A.

**Outputs:** the `GitInfo` attached to each session, delivered by the existing `state`
broadcast (the same channel `cwd` rides). No new host→renderer message is required for the
indicator; reusing `state` keeps the renderer's single-source-of-truth model intact.

**Slice B inputs (switch request):** a new `WebviewToHost` message
`{ type: 'git:switch'; sessionId: string; target: { kind: 'branch' | 'worktree'; ref: string } }`.
`ref` is validated host-side against the enumerated branch/worktree list the host itself
produced (reject anything not in the known set) before it ever reaches `execFile` — the
renderer cannot smuggle an arbitrary ref.

**Error shapes:** interrogation failures resolve to `GitInfo { kind: 'none' }` plus a host log
line; they never throw into the broadcast. A `git:switch` that is refused or fails returns
`{ type: 'git:switchResult'; sessionId; ok: false; reason: 'busy' | 'dirty' | 'failed'; message }`;
success returns `{ ok: true }` and the normal cwd/git refresh follows.

**Invariants:**
- `GitInfo` always reflects `activeCwd(session)` at the moment of interrogation; it is allowed
  to be briefly stale between a `cd` and the next refresh, never wrong for a different cwd.
- `projectPath` is never changed by this feature (it's the stable session identity, ADR 0002 /
  E1). A worktree/branch switch updates `cwd`/`git`, not `projectPath`.
- Interrogation is **bounded**: a per-call timeout (Decision D-2, 1500 ms) caps cost; on
  timeout → `kind: 'none'`.

---

## 4. Edge cases & failure modes

| Condition | Expected behavior / recovery |
|---|---|
| Concurrency / rapid `cd`s | Coalesce: debounce interrogation per session (Decision D-2). A newer cwd supersedes an in-flight interrogation; drop the stale result (compare against current `activeCwd`). |
| Zero / one / many repos | Zero (non-git) → `none`, bar hidden. One → normal. Many sessions each interrogate their own cwd independently; no shared cache keyed wrong. |
| Submodule / nested repo | `git rev-parse --show-toplevel` from the cwd resolves the *innermost* repo — correct by definition; no special-casing. |
| `git` not on PATH | First failure flips a host-level `gitAvailable=false` flag (cached for the process); subsequent sessions skip interrogation → `none`. No repeated spawn attempts. |
| Limits exceeded (huge repo, slow FS) | The 1500 ms timeout (D-2) bounds the worst case; `dirty` check uses `git status --porcelain --untracked-files=no -z` and is the only potentially-slow call — it may be dropped first under time pressure (dirty becomes `undefined`, dot hidden) rather than blocking branch display. |
| Partial failure | Branch resolves but dirty check times out → show branch, omit dirty dot. Each sub-fact degrades independently. |
| Stale / conflicting data | A switch (Slice B) or external `git checkout` in the shell both flow back through the same cwd/refresh seam (`.git/HEAD` watch, D-2), so the indicator self-heals; max staleness = debounce window. |
| Bare repo | `--is-bare-repository` → `kind: 'bare'`; no working tree, so dirty/operation are omitted. |
| Detached HEAD | `rev-parse --abbrev-ref HEAD` returns `HEAD`; fall back to `rev-parse --short HEAD` → `kind: 'detached'`, `sha`. |
| Mid-rebase/merge | Detect via the presence of `<gitdir>/rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` (cheap `fs.access`, no spawn) → set `operation`. |
| Worktree detection | `git rev-parse --git-common-dir` ≠ `--git-dir` ⇒ linked worktree; `worktreeName` = basename of `--show-toplevel`. |
| `.git` file (worktree/submodule gitlink) | Handled transparently by `rev-parse`; we never read `.git/HEAD` by hand for the *value* (the one exception is the **unborn** symref, which `rev-parse` can't resolve). For refresh we watch the **resolved** HEAD via `--git-dir`/`--git-common-dir` (a gitlink points elsewhere — D-2). |
| `fs.watch` dies / descriptor exhaustion (many sessions, flaky on Windows) | The HEAD watch is **best-effort**: if `fs.watch` throws, errors, or can't be established, the host logs once and falls back to the always-on triggers (cwd-change + window-focus refresh). The indicator stays correct, just slightly less instant for an external `git checkout` that doesn't change cwd. Watches are per-session and torn down on `term:exit` to bound descriptor use. |
| Worktree switch re-points the git-dir | After a successful Slice B worktree switch (or any cwd change into a different worktree), the resolved HEAD path itself changes. The refresh routine **re-resolves `--git-dir` and re-establishes the HEAD watch** on every interrogation, so the watch always tracks the current cwd's HEAD, never a stale one. |
| cwd vs `--show-toplevel` normalization (symlinks, Windows case) | The stale-result drop check (newer cwd supersedes an in-flight interrogation) compares **normalized** paths (`fs.realpath` + case-fold on Windows) so a symlinked or differently-cased cwd doesn't spuriously discard a fresh result. |
| **Switch with a running PTY (Slice B)** | If the session is **busy** (host `activity`/`session.busy`), **refuse** the switch (`reason: 'busy'`) with an explainer. If idle but working tree **dirty**, refuse (`reason: 'dirty'`). Otherwise run out-of-band `git checkout`/worktree switch via `execFile` and refresh. See Decision D-1 for full rationale + rejected alternatives. |

---

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Show the indicator | On when cwd is a git repo | Yes — `showGitIndicator` in `AppSettings` (sits with `trackCwd`) | Power users may want a quieter chrome; it's a durable preference. |
| Non-git cwd | Hide the bar entirely | No (covered by the above) | A persistent "no repo" label is noise in non-repo shells; absence is the clearest signal. |
| Dirty indicator | A single dot, no counts | No | Counts duplicate the Changes panel and cost a slow `status`; a dot is glanceable and cheap. |
| Refresh strategy | cwd-change event + `.git/HEAD` watch + window-focus refresh; **no interval polling** | No | Cheap and correct; busy polling is explicitly rejected (CLAUDE.md "be concrete and cheap"). |
| Interrogation timeout | 1500 ms per session refresh | No | Bounds worst case on slow FS without flicker on normal repos. |
| Switcher (Slice B) availability | Refuse-if-busy-or-dirty, run out-of-band when safe | Possibly a future `git:switch` mode setting; **not** in this spec | Safest default that still delivers in-place switching for the common idle-clean case. |

---

## 6. Scope slicing

- **MVP (Slice A, must):**
  - Host `getGitInfo(cwd): Promise<GitInfo>` (`src/git-info.ts`, pure-ish; spawning wrapped in
    main per the `git-actions` precedent), wired to refresh on cwd change + `.git/HEAD` watch +
    focus, timeout-bounded, `gitAvailable` short-circuit.
  - `Session.git` field; delivered on the existing `state` broadcast.
  - `GitIndicatorBar` renderer component in the E3 breadcrumb band, terminal-only.
  - States: `branch`, `detached`, `bare`, `none` (hidden), `worktree` modifier, `operation`
    modifier, dirty dot.
  - `showGitIndicator` setting (default on).
  - e2e smoke scenario (§7).
- **v1 (Slice B, should):** Click a segment → dropdown listing local branches (and worktrees);
  selecting one issues `git:switch`; refuse-if-busy/dirty safety; result toast/announcement;
  the indicator reflects the new branch on success.
- **Vision (could):** worktree *create*/open-in-new-session from the dropdown; ahead/behind
  badges; sparkline of recent branches; keyboard-driven branch quick-switch in the command
  palette. All out of this spec.
- **Out of scope:** see §1 non-goals.

---

## 7. Acceptance criteria

**Declarative (baseline):**
- In a terminal whose cwd is a repo on branch `main`, the bar shows `main`.
- After the shell `cd`s into a directory on a different branch, the bar updates to that branch
  within the refresh window (no app restart, no manual action). **Observable bound for tests:**
  the new branch is reflected in `window.__sessions[sid].git.branch` within **3000 ms** of the
  prompt re-appearing (debounce 150 ms + interrogation ≤ 1500 ms + broadcast, with margin) —
  the e2e harness polls via `page.waitForFunction` against that ceiling.
- In a detached-HEAD cwd, the bar shows a 7-char short SHA and a "detached" affordance, not a
  branch name.
- In a non-git cwd, the bar is absent.
- In a linked worktree, the bar shows the worktree marker alongside the branch.
- Mid-rebase, the bar shows a "rebasing" badge.
- The renderer never spawns git; with `window.agentDeck` absent (fake-shell preview), the bar
  simply doesn't render (no crash).
- (Slice B) Selecting a branch in the dropdown while the session is busy shows a "can't switch
  while the terminal is busy" message and does **not** run git.

**EARS (FULL):**
- *Event:* When a session's `activeCwd` changes, the host shall interrogate git for the new cwd
  (debounced) and rebroadcast the session with updated `GitInfo`.
- *State:* While a terminal surface is active and its `GitInfo.kind` is `branch`, the indicator
  shall display the branch name and, where dirty, a non-color-only dirty marker.
- *State:* While `GitInfo.kind` is `none`, the indicator shall not render.
- *Unwanted:* If git interrogation exceeds the timeout or errors, then the host shall resolve
  `GitInfo` to `kind: 'none'` and log host-side, and the indicator shall not show stale data.
- *Unwanted (Slice B):* If a `git:switch` arrives while the target session is busy or its
  working tree is dirty, then the host shall refuse it, run no git command, and return a
  reason the renderer announces.
- *Event (Slice B):* When a safe `git:switch` succeeds, the host shall refresh `GitInfo` so the
  indicator reflects the new branch/worktree.
- *Optional:* Where `showGitIndicator` is off, the indicator shall not render regardless of
  repo state.

**Gherkin (key flows, runtime-observable via the e2e smoke harness — real hidden Electron app,
`test/e2e/*.e2e.mjs`, asserting on `window.__sessions[sid].git` and the `.git-indicator__*`
DOM, seeding a temp git repo as cwd):**

```gherkin
Feature: Terminal git branch/worktree indicator

  Background:
    Given a throwaway temp directory initialized as a git repo on branch "main"
    And the app is launched hidden with that directory openable as a session

  Scenario: Shows the current branch
    When a terminal session is opened in the repo
    Then within the refresh window window.__sessions[sid].git.kind equals "branch"
    And window.__sessions[sid].git.branch equals "main"
    And a ".git-indicator__branch" element shows "main"

  Scenario: Indicator updates after the shell changes branch
    Given a terminal session open in a repo on branch "main"
    And the repo also has a subdirectory checkout (or the harness checks out "feature")
    When the shell changes the working tree to branch "feature" (cd into a worktree on
      "feature", or the harness runs git checkout feature out-of-band)
    Then within 3000 ms window.__sessions[sid].git.branch equals "feature"
    And the ".git-indicator__branch" element shows "feature"
    And window.__sessions[sid].projectPath is unchanged

  Scenario: Detached HEAD renders a short SHA
    Given the repo HEAD is detached onto a commit
    When a terminal session is opened in the repo
    Then window.__sessions[sid].git.kind equals "detached"
    And the indicator shows a 7-character SHA and a detached affordance

  Scenario: Non-git directory hides the indicator
    Given a throwaway temp directory that is NOT a git repo
    When a terminal session is opened there
    Then window.__sessions[sid].git.kind equals "none"
    And no ".git-indicator" element is attached

  Scenario: Switch is refused while the terminal is busy (Slice B)
    Given a terminal session on branch "main" with a long-running process active
    When the renderer posts git:switch to branch "feature"
    Then no checkout runs and a git:switchResult with ok=false reason="busy" is received
    And window.__sessions[sid].git.branch still equals "main"
```

---

## 8. State catalog (UI)

The indicator lives in the **E3 breadcrumb band** (`.breadcrumb-bar` surface: `--term-surface`
background, 26 px tall, `border-bottom: 1px solid var(--border)`), rendered **above
`.termwrap`** in `center-pane.tsx`, shown when the active surface is a **terminal** (mirrors how
`BreadcrumbBar` is shown for `kind === 'file'`). It is a sibling band, not part of the tab
button strip — matching the "at the TOP of the terminal tab, breadcrumb-style" intent.

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| `GitIndicatorBar` | Ideal — branch | worktree marker (if any) → branch glyph → branch name → dirty dot (if dirty) | Click branch segment → branch dropdown (Slice B) |
| | Detached | dimmed branch glyph → `#a1b2c3d` → faint "detached" tag | Click → branch dropdown (offers to leave detached) |
| | Bare | repo glyph → "bare" | none (non-interactive) |
| | Unborn (`kind:'branch'`, `unborn:true`) | branch glyph → unborn branch name → faint "no commits" tag | segment is non-interactive in Slice B (nothing to switch to) |
| | Worktree | leaf/branch-fork glyph + worktree name as a leading segment, then branch/detached as above | Click worktree segment → worktree dropdown (Slice B) |
| | Mid-operation | small caps badge `REBASING` / `MERGING` (uses `--amber`) before the branch | none in v1 (don't offer switch mid-op — refuse) |
| | Non-git / error / `showGitIndicator` off | **band absent** | n/a |
| Branch dropdown (Slice B) | Idle | (closed) | — |
| | Open | menu of local branches (current marked), worktrees grouped; search/filter if many (reuse the existing context-menu/command-menu pattern) | Enter/click a ref → switch |
| | Open, no other refs | repo has only the current branch / no other worktrees: show a single disabled "No other branches" row (externalized copy), menu still opens (so the affordance is consistent) | dismiss |
| | Switching | selected row shows an inline busy state; menu stays open, disabled | — |
| | Refused (busy/dirty) | menu closes; a polite inline message / toast: e.g. "Can't switch while the terminal is busy." / "Commit or stash changes first." | dismiss |
| | Failed | toast with git's error summary in the interface's voice | retry / dismiss |

**Loading / first-run:** the band only appears once `GitInfo` resolves; there is no spinner
flash for the common fast case (interrogation is sub-100 ms on normal repos). If a refresh is
in flight after a `cd`, the *previous* valid value stays shown (no flicker to empty) until the
new one lands — except when the new cwd is non-git, where the band animates out.

---

## 9. Interaction inventory (UI)

| Component | Actions / affordances | Pointer | Keyboard | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Indicator band | static container | — | not focus-trapping | — | — | `role="group"`, `aria-label="Git branch"` |
| Branch segment (Slice B interactive; Slice A static text) | open branch dropdown | click; hover = `--panel-2` bg per `.breadcrumb-bar__seg` | Tab to focus, Enter/Space opens, Esc closes | tap opens | — | `role="button"`, `aria-haspopup="menu"`, `aria-expanded` |
| Worktree segment | open worktree dropdown | as above | as above | as above | — | as above |
| Dropdown menu | choose a ref to switch | click row | ↑/↓ move, Enter select, Esc close, type-to-filter | tap row | — | `role="menu"`, rows `role="menuitemradio"` with `aria-checked` on current |
| Dirty dot | informational only | hover → tooltip "Uncommitted changes" | reachable as `title`/`aria-label` only | — | — | `aria-hidden` not used; conveyed via accessible name on the segment |

Rules honored: every interaction has a keyboard path (no drag here); default/hover/focus/
disabled states distinct and not color-only; the **destructive/state-changing** action
(switch) is *guarded* (refuse-if-busy/dirty) rather than confirmed-with-modal, because the
refusal *is* the safety gate — and a successful switch is reversible by switching back.

---

## 10. Accessibility & i18n (UI)

**Accessibility:**
- **Keyboard:** Slice A is non-interactive (pure status); Slice B segments are full buttons —
  Tab to reach, Enter/Space to open, arrow keys within the menu, Esc to close, type-to-filter.
  Focus returns to the triggering segment on close.
- **Visible focus:** reuse the app's focus-ring token; do not strip outlines; verify under
  forced-colors (the indicator must survive high-contrast — the GPU/shader note in CLAUDE.md is
  unrelated, but forced-colors is a real check).
- **Accessible names:** branch glyph is decorative (`aria-hidden`); the segment's accessible
  name is the branch name plus state, e.g. "Branch main, uncommitted changes" / "Detached at
  a1b2c3d" / "Rebasing on main". Worktree segment names itself "Worktree <name>".
- **Announce dynamic results:** a `aria-live="polite"` region announces switch outcomes
  ("Switched to feature", "Can't switch while the terminal is busy") so non-sighted users get
  the result a sighted user reads from the toast. A branch change from an external `cd`/checkout
  is *not* announced (it would be noisy and unsolicited) — only user-initiated switches are.
- **Color is never the only signal:** dirty state is a dot **and** part of the accessible name;
  detached/operation states carry a **text** label, not just a hue; the amber operation badge
  uses caps text, not color alone.
- **Reduced motion:** the band's appear/disappear is a fade that collapses to an instant
  show/hide under `prefers-reduced-motion`.

**Internationalization:**
- All user-facing strings externalized (no hardcoded "detached", "REBASING", "Can't switch
  while the terminal is busy", "Worktree", "Uncommitted changes"). Branch names, SHAs, and
  worktree names are user data, rendered verbatim (not translated).
- **Text expansion:** the band already scrolls horizontally (`overflow-x: auto`,
  scrollbar hidden) like `.breadcrumb-bar`; longer localized labels and long branch names
  ellipsize per-segment (`max-width`, `text-overflow: ellipsis`) — meaning is preserved in the
  accessible name / `title`.
- **RTL:** the band mirrors with the app; segment order follows reading direction; the chevron
  separators flip. Branch names/SHAs stay LTR (they're identifiers) via `dir="ltr"` on those
  spans.
- **Locale/sort:** the dropdown's branch list sorts locale-aware on the display name, with the
  current branch pinned first regardless of sort.

---

## 11. Design tokens (UI)

No new palette — **consistency with the E3 breadcrumb is the whole point**; the indicator must
read as the same band, with git semantics as its only signature. Reuse existing semantic roles:

- Surface/divider: `--term-surface` background, `--border` bottom divider, 26 px height,
  `font-family: var(--font-ui)`, `font-size: calc(11.5px * var(--font-scale))` — identical to
  `.breadcrumb-bar`.
- Segment text: `--text-dim` default, `--text` on hover, `--panel-2` hover background,
  `--r-sm` radius — identical to `.breadcrumb-bar__seg`.
- Separators: `--text-faint` chevrons — identical to `.breadcrumb-bar__sep`.
- **Signature (git semantics, the one place this band differs from the path breadcrumb):**
  - branch glyph in `--text-dim` (dimmed to `--text-faint` when detached);
  - worktree marker tinted `--blue` to echo the existing kind-glyph color language;
  - dirty dot in `--amber` (the established "attention/uncommitted" hue in this codebase);
  - operation badge (`REBASING` etc.) small-caps in `--amber`.
- **Theme variants:** all tokens are CSS custom properties → light/dark/high-contrast inherit
  automatically; no hex literals in the component (the codebase uses `var(--...)` with hex
  *fallbacks* only inside `styles.css`, mirroring `.breadcrumb-bar__kind--*`).

Class naming follows the BEM-ish convention already in use: `.git-indicator`,
`.git-indicator__seg`, `.git-indicator__branch`, `.git-indicator__worktree`,
`.git-indicator__dirty`, `.git-indicator__op`, `.git-indicator__sep`.

---

## 12. Assumptions

1. **Reuse the `state` broadcast, no new push channel for the indicator.** `GitInfo` rides on
   `Session.git` exactly as `cwd` rides on `Session.cwd` (E2). Keeps the renderer's
   single-source-of-truth model and adds no protocol surface for Slice A. (Slice B adds
   `git:switch` / `git:switchResult` messages.)
2. **Mount in the E3 breadcrumb band (`center-pane.tsx`, above `.termwrap`), not the tab-button
   strip.** The wishlist says "at the TOP of the terminal tab, breadcrumb-style, like the
   editor-tab breadcrumbs" — the existing breadcrumb band is that exact slot/aesthetic. The tab
   button stays unchanged (it still shows the session name + glyph).
3. **Interrogation via `execFile('git', …)`**, following the `src/git-actions.ts` precedent
   (pure arg-building in `src/`, spawning wrapped in `electron/main.ts`), not by hand-parsing
   `.git/HEAD`. We *watch* `.git/HEAD` for refresh but read *values* via `rev-parse`, because a
   gitlink/worktree/packed-ref makes hand-parsing fragile.
4. **Refresh = cwd-change event + `.git/HEAD` (or `--git-dir/HEAD`) fs.watch + window-focus,
   debounced; no interval polling.** This is the cheap, correct seam the live-cwd work already
   established.
5. **Dirty = a single dot, computed with `git status --porcelain -uno -z`, and the first thing
   dropped under the timeout.** No counts.
6. **`gitAvailable` is cached per process** after the first "git not found" so a git-less
   machine never repeatedly spawns.
7. **`showGitIndicator` defaults on**, lives in `AppSettings` next to `trackCwd`.
8. **Slice B is gated and shippable-separately.** If its safety review (Decision D-1) is
   unresolved at build time, Slice A ships alone and fully satisfies the primary ask.

---

## 13. Decisions Needed (autonomous mode)

> **Slice A has no `high`-severity blockers — ship it.** One `high` flag (D-1) exists, but it is
> **scoped entirely to Slice B**: the switcher must not ship on the default without a human
> safety sign-off. Slice A (the read-only indicator) is unblocked and is the complete primary
> deliverable. Build gate: **do not implement Slice B until a human confirms D-1's
> refuse-if-busy-or-dirty semantics.**

- **[high — gates Slice B only] D-1 — Switch semantics with a running PTY.** *Default taken:*
  **refuse the switch
  when the session is busy OR the working tree is dirty; otherwise run `git checkout` /
  worktree switch out-of-band via `execFile` (never typed into the shell) and refresh.** A
  busy session means a child process is running against the working tree; swapping files under
  it can corrupt that process's view, so we refuse rather than gamble. Dirty-tree checkout can
  fail or carry changes across branches unexpectedly, so we refuse and tell the user to commit
  or stash. *Rejected alternatives:* (a) **type `git checkout X` into the terminal** — pollutes
  the user's shell history and races with whatever's at the prompt, and does nothing if a TUI
  has the screen; rejected. (b) **run it out-of-band regardless of busy/dirty** — the corruption
  case this whole guard exists to prevent; rejected. (c) **only allow worktree switch by opening
  a brand-new session in the target worktree** — safe but doesn't satisfy "switch in place";
  kept as a *future* affordance, not the v1 default. The chosen default is the safest option
  that still switches in place for the common idle-clean case, and every refusal is explained.
- **[normal] D-2 — Refresh trigger + debounce + timeout.** *Default taken:* refresh on
  cwd-change (existing seam) + `fs.watch` on the resolved `HEAD` + window-focus; **debounce
  150 ms** per session; **1500 ms** hard timeout per interrogation; on timeout → `kind: 'none'`
  with branch preferred over dirty if partial. *Rationale:* cheap, no busy polling, self-healing
  against external checkouts; numbers are tunable and low-risk. *Rejected:* interval polling
  (explicitly discouraged), and OSC-7-only refresh (misses an external `git checkout` that
  doesn't change cwd — the `HEAD` watch covers that).
- **[normal] D-3 — Git interrogation seam: spawn vs. file-read.** *Default taken:* **spawn
  `git` for values, watch files for refresh** (assumption 3). *Rejected:* pure file-reading of
  `.git/HEAD` + `.git/worktrees/*` — avoids a spawn but is brittle across gitlinks, packed
  refs, and detached states; the spawn is sub-100 ms on normal repos and far more robust.
- **[low] D-4 — Non-git cwd rendering.** *Default taken:* **hide the band entirely** (assumption,
  §5). *Rejected:* a persistent "no repo" chip — judged as chrome noise in the many non-repo
  shells a developer opens. Trivially reversible via the `showGitIndicator` setting plumbing.
- **[low] D-5 — Detached/bare label wording.** *Default taken:* short 7-char SHA + "detached"
  tag; "bare" / "no commits" for empty repos. Wording is i18n-externalized and easily tuned.

---

## 14. Open questions

None block **Slice A**. The one `high` flag (D-1) is scoped to **Slice B** and is the
intended human checkpoint before the switcher ships; the in-place-switch vs.
new-session-per-worktree choice is captured as D-1's rejected-alternative (c) and the Vision
scope. Everything else is a severity-tagged default in §13.

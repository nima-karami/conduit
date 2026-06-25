---
status: implemented
date: 2026-06-25
tier: FULL
---

# Feature Spec: Multi-repo awareness ("active repo" model)

**Tier:** FULL **Feature type:** UI (+ host/IPC boundary)
**One-line request:** "I open a session in a parent folder that contains several sub-folders,
each its own git repo, because I want to browse everything — but then I lose the git history
visibility we have. How can we get visibility into that?"
**Scope chosen (user):** A dedicated **repo picker** (separate from the branch picker) that
scopes all git surfaces to one **active repo** at a time; the active repo auto-follows context
(terminal `cd`, file focus, explorer click) and a manual pick **pins** it until unpinned.

## 1. Problem frame

- **Job (JTBD):** When working in a multi-repo workspace opened at the parent folder, I want to
  browse the whole tree *and* still see/use each sub-repo's git (history, changes, branch) without
  having to re-open each repo as its own session.
- **Actors:** Anyone opening a "monorepo-of-repos" / multi-repo workspace (mouse + keyboard).
- **Success outcomes:**
  - Every detected sub-repo is reachable from a dedicated picker.
  - Branch indicator, history graph, Changes tab, and branch switch all reflect the chosen
    (active) repo — not just wherever the terminal happens to be.
  - The active repo follows what I'm doing by default, but I can pin one and browse elsewhere
    without it being yanked away.
  - The Files explorer keeps showing the entire tree (the reason I opened the parent).
- **Non-goals (out of scope):** cross-repo operations (multi-repo stage/commit), a *merged*
  multi-repo history graph (the "aggregate" model was explicitly **not** chosen), and changing the
  Files explorer to filter to one repo.

### Why this design (rejected alternatives)

- **Aggregate / VS-Code-style multi-provider view** — show all repos' changes/branches at once.
  Rejected by the user in favor of one active repo at a time (less screen cost, simpler model).
- **Just fix the root case** — when the opened folder isn't a repo, point the single surface at the
  first sub-repo. Rejected: no way to reach the other repos without a terminal `cd`.

## 2. Core concept — the "active repo"

Introduce a per-session **active repo**, decoupled from `activeCwd(session)`. Today every git
surface reads `activeCwd`; they will instead read the session's **active repo root**. The Files
explorer is the deliberate exception — it keeps browsing the full tree from the opened root.

Per-session host state (state lives in the main process — see CLAUDE.md):

| Field | Meaning |
|---|---|
| `repos: RepoInfo[]` | detected sub-repos under the opened root |
| `pinnedRepoRoot?: string` | set by a manual pick; cleared by "Auto"/unpin |
| `autoRepoRoot?: string` | updated by each auto-follow trigger (last-action-wins) |

**Effective active repo** = `pinnedRepoRoot ?? autoRepoRoot ?? fallback`, where `fallback` =
opened root if it is itself a repo, else the first detected repo, else **none** (no git surface —
degrades to today's behavior).

## 3. Behavior & states

States of the picker / git surfaces:

- **No repos detected** (opened root not a repo, none nested): picker hidden; git surfaces blank,
  exactly as today.
- **Single repo** (only the opened root, or exactly one nested): picker hidden (nothing to choose);
  that repo is active.
- **Multiple repos**: picker visible. Active repo = effective active repo above.
  - **Auto (unpinned)**: active repo follows the most recent context trigger.
  - **Pinned**: active repo is the manual choice; a 📌 indicator shows; auto triggers are ignored
    until unpinned ("Auto" entry in the dropdown clears the pin).
- **Transitions**: a context trigger overwrites `autoRepoRoot` (last-action-wins). A manual pick
  sets `pinnedRepoRoot`. Selecting "Auto" clears `pinnedRepoRoot`. Detection refresh may add/remove
  repos at runtime.
- **Edge transitions**: a *pinned* repo that disappears (deleted on disk) → pin cleared, fall back
  to Auto. The active repo changing re-scopes all git surfaces (debounced like today's git refresh).

## 4. Detection — `src/repo-scan.ts` (new, host module)

`detectRepos(openedRoot, opts?) → RepoInfo[]`, where `RepoInfo = { root: string; name: string }`
(`name` = path relative to `openedRoot`, e.g. `repo-A`, `group/repo-C`; the opened root itself, if
a repo, is named `.` or the basename).

- Bounded **recursive** walk, default depth **4** (internal constant `MAX_REPO_SCAN_DEPTH`).
- Skip heavy/uninteresting dirs: `node_modules`, `.git`, `dist`, `out`, `.next`, `.vscode-test`
  (reuse the `IGNORED` set spirit from `project-info.ts`).
- A repo marker is a `.git` **dir or file** (covers submodules + linked worktrees).
- **Stop descending once a repo is found** — a repo's own subtree is not re-scanned for more repos.
- Include the opened root itself when it is a repo.
- Symlink-loop guarded (track visited real paths / don't follow dir symlinks).
- Result **capped** (e.g. 200) and **cached** per opened root; cache invalidated (debounced) on fs
  changes under the root so cloning/removing a sub-repo updates the picker.

Pure enough to unit-test against a constructed temp dir tree.

## 5. Resolution — `src/active-repo.ts` (new, pure module, no I/O)

- `repoForPath(repos, absPath) → repoRoot | undefined` — **longest-prefix** match (mirrors the
  longest-ancestor pattern already in `src/owning-session.ts`).
- `resolveActiveRepo({ repos, pinnedRoot, autoRoot, openedRoot }) → repoRoot | undefined` — the
  precedence in §2.

Both pure → covered by fast unit tests; the fs walk + IPC wiring is covered by a real-app e2e.

## 6. Data / interface contract (IPC)

New host state broadcast additions (per session, in the existing `state` push):

- `repos: RepoInfo[]`
- `activeRepoRoot?: string`
- `repoPinned: boolean`

New renderer→host messages:

- `repo:pin { sessionId, repoRoot }` — manual pick; sets `pinnedRepoRoot` (validated against the
  detected `repos` allow-list, mirroring how `switchBranch` requires a validated ref).
- `repo:unpin { sessionId }` — clears the pin (the "Auto" entry).
- `repo:context { sessionId, path }` — lightweight auto-follow trigger from the renderer (file
  open/focus, explorer selection); host maps `path` → repo via `repoForPath` → `autoRepoRoot`.

Re-keyed handlers (active repo root instead of `activeCwd(session)`): `git:history`,
`git:commitDiff`, `git:refs`, branch switch, branch indicator (`runGitRefresh`), and the **Changes**
half of the project view.

**Auto-follow from terminal `cd`** reuses the existing cwd-scanner: when `activeCwd` changes, map
it through `repoForPath` to update `autoRepoRoot` (no new renderer message needed for `cd`).

## 7. The Changes / Files split

`getProjectInfo(p)` currently returns **both** `changes` and `files` from one path. Split so:

- **changes** are computed from the **active repo root**, and
- the **file tree** is computed from the **opened root** (full tree).

MVP: explorer file-status badges (`M`/`A`/`U`) reflect the **active repo** only (files outside it
show no badge). v1 (below) makes badges correct per-repo across the whole tree.

## 8. UI — dedicated `RepoPicker`

- Sits **beside** the branch indicator, distinct from it: `[ 📁 repo-A ▾ ]  [ ⎇ main ▾ ]`.
- Dropdown lists detected repos by relative `name`, plus an **"Auto"** entry that unpins.
- **📌 pin indicator** when `repoPinned`.
- **Hidden when 0–1 repos** — single-repo projects are visually unchanged.
- Reuses the existing themed dropdown/menu patterns (as the git-ref dropdown did) — no native
  `<select>`.

### Accessibility

- Picker is a button + themed listbox: focusable, arrow-key navigable, `aria-label="Active repo"`,
  active option `aria-selected`, Escape closes (match the branch-switcher / ref-dropdown patterns).
- Pin state announced (e.g. `aria-pressed` or text "pinned"), not color-only.

### i18n

- New strings: picker label ("Active repo"), the "Auto" entry, and the pinned hint. Route through
  the same mechanism the existing pickers use (no hard-coded duplication).

### Design tokens

- Use existing `$variable` design tokens for the picker chrome / pin indicator — no raw hex
  (see project convention). Match the branch-indicator's sizing/spacing tokens.

## 9. Edge cases & failure modes

- **Huge tree**: bounded depth + skip-list + result cap + cache + debounced refresh + per-walk
  time budget; never block the UI thread (host does the scan, like other git calls).
- **Zero repos**: picker hidden; no regression.
- **One repo**: picker hidden; that repo active.
- **Pinned repo deleted**: clear pin → fall back to Auto.
- **`cd` outside any detected repo**: `autoRepoRoot` becomes undefined → fall back chain.
- **Submodule / linked worktree**: detected via `.git` file; treated as a normal repo entry.
- **Symlink cycles**: guarded; never infinite-loop the scan.
- **Concurrency**: a repo refresh mid-interrogation drops stale results (same guard pattern as
  `runGitRefresh`).

## 10. Defaults vs. settings

- Feature **on by default**, with a settings toggle (e.g. `Multi-repo picker`) under the appropriate
  appearance/behavior section. Rationale: it self-hides for single-repo projects, so the default is
  invisible until useful.
- Scan depth = **4**, an internal constant (not a user setting in MVP) — keeps the surface small;
  revisit only if real workspaces need deeper.
- Pin is **session-local** (not persisted across restart) in MVP — reversible preference, cheap to
  re-pin; persistence is a possible later nicety.

## 11. Scope slicing

- **MVP**: detection (`repo-scan`) + resolution (`active-repo`) + host state + IPC + `RepoPicker`
  + pin/auto-follow (all 3 triggers) + all git surfaces (branch indicator, history, commit diff,
  refs, branch switch, **Changes tab**) keyed to the active repo. Explorer stays full-tree. Settings
  toggle.
- **v1**: explorer file-status badges computed **per-repo** across the whole tree (run change
  detection per detected repo and merge), so badges are correct everywhere, not just the active repo.
- **Vision / out-of-scope**: cross-repo staging/commit; merged multi-repo history graph; persisted
  pin; per-repo ahead/behind in the picker.

## 12. Acceptance criteria

Declarative + EARS + Gherkin (per project notation).

**Declarative**
- Opening a folder containing ≥2 git repos shows a repo picker listing each by relative path.
- Selecting a repo re-scopes branch indicator, history, Changes, and branch switch to it.
- With no pin, `cd`-ing into a sub-repo, opening a file in it, or clicking it in the explorer makes
  it the active repo.
- A manual pick holds the active repo across subsequent `cd`/file-open/explorer-click until "Auto".
- A single-repo or no-repo project shows **no** picker and behaves exactly as before.
- The Files explorer always shows the full tree from the opened root.

**EARS**
- *While* the session has ≥2 detected repos and no pin, *when* a context trigger resolves to a
  detected repo, the system *shall* set that repo active and re-scope all git surfaces.
- *When* the user selects a repo from the picker, the system *shall* pin it and ignore context
  triggers until the pin is cleared.
- *If* the pinned repo no longer exists on disk, *then* the system *shall* clear the pin and resume
  auto-follow.

**Gherkin**
```gherkin
Scenario: Pin survives a terminal cd
  Given a session opened at "Project A" containing repos "repo-A" and "repo-B"
  And I pick "repo-A" from the repo picker
  When I run "cd repo-B" in the terminal
  Then the active repo stays "repo-A"
  And the history graph still shows repo-A's commits

Scenario: Auto-follow on file focus
  Given the repo picker is on "Auto"
  When I open a file inside "repo-B" in the editor
  Then the active repo becomes "repo-B"
  And the Changes tab shows repo-B's changes
```

## 13. Verification plan

- **Unit (vitest)**: `repo-scan` (temp-dir trees: nested, depth limit, skip-list, `.git` file,
  symlink guard, cap) and `active-repo` (`repoForPath` longest-prefix, `resolveActiveRepo`
  precedence incl. pin > auto > fallback, deleted-pin fallback).
- **Real-app e2e (`test/e2e/`)** — host/IPC boundary, so the real app (not the mock preview):
  build a temp `Project A` with two nested repos (each with a commit + a working change), open it,
  assert: picker lists both; switching re-scopes history + Changes; a pin survives a terminal `cd`;
  single-repo dir shows no picker.
- **Gate**: `npm run verify` green (format + lint + dead-code/dup + typecheck + tests + security).

## 14. Decisions / assumptions

- Scan depth 4, result cap, skip-list — assumed sensible defaults (adjustable constants).
- Pin not persisted across restart in MVP (reversible; revisit if asked).
- Explorer badges scoped to active repo in MVP, per-repo in v1.
- Feature on by default (self-hides for single-repo).

## 15. Self-audit

Template/checklist coverage: problem frame ✓, behavior/states ✓, data/interface contract ✓, edge
cases ✓, defaults vs settings ✓, scope slicing ✓, acceptance criteria (declarative+EARS+Gherkin) ✓,
UI module (states/interaction/a11y/i18n/tokens) ✓, verification ✓, decisions/assumptions ✓. No open
TODO/TBD.

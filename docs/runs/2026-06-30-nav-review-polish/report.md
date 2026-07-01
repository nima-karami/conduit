# Run report — nav & review polish (2026-06-30)

Autonomous build-loop run (conductor: Opus 4.8; delegated execution). Three FULL
features driven spec → design-review → build → verify → integrate, **all merged to
`main` and verified** (full `npm run verify` on the merged tree + a real-app e2e
each). **Not released** — release (CHANGELOG cut, spec archive, `npm version`, push)
is intentionally the user's call; this run stops at verified-on-main.

Lens: [[conduit-daily-driver-goal]].

## Shipped (all on `main`)

| Feature | Spec | Commits | Evidence |
|---|---|---|---|
| **Review compare dialog** | `2026-06-30-review-compare-dialog` | `94423fd` / merge `fdfd5c5` | verify EXIT 0; e2e `review-compare` PASS 71.6s; modal screenshot taste-checked |
| **Per-tab scroll/view memory** | `2026-06-30-tab-scroll-state-memory` | `4ee7b6f` / merge `f89cbdc` / fix `bca391e` | verify EXIT 0; e2e `tab-scroll-state` PASS 29.7s |
| **VS Code mouse buttons** | `2026-06-30-mouse-nav-buttons` | `2058aab` / merge `93f7a81` | verify EXIT 0 (1888 tests); e2e `mouse-nav` PASS 36.4s |

Final merged-tree verify: **EXIT 0, 1888 unit tests, 146 files.**

### 1. Review Changes — first-class Compare dialog
Discoverable git-band **Compare icon** + a focus-trapped **modal** (Base/Target shown
together, searchable across **local branches, remote branches, tags, commits**, pasted
SHA, Swap, live `base…head` + dot-mode preview) — **replacing** the cramped nested
in-band builder. Diffs **any two refs without checkout** (reuses the shipped
`git:rangeDiff` engine wholesale). Host validates the *picked* ref by **exact existence**
(`show-ref --verify`), decoupled from the display cap (a design-review fix — capped
validation would have made out-of-window tags unreachable + caused TOCTOU false
rejections). `git:refsResult` extended additively (tags/remotes); no error channel on the
shared broadcast (renderer-side load timeout instead).

### 2. Per-tab scroll & view-state memory
Every tab restores scroll/view on switch-back via a renderer store keyed by `OpenDoc.id`
(mirrors `dirty-store`): Monaco full view state (scroll+cursor+selection+folding),
markdown/diff/git-history px, **review list a layout-independent anchor** (top-card path +
offset — px is wrong on a remount whose heights are estimate-based). Debounced capture +
synchronous unmount capture; reveal-overrides-restore via the existing project-index seam;
instant (reduced-motion) restore, no focus-steal. **MVP** kinds shipped; image/PDF/
commit-diff/restart-persist deferred to v1 (store/ViewState shaped to slot them in).

### 3. VS Code mouse buttons
Middle-click closes doc tabs (via `closeDoc`, dirty-prompt honored) + opens explorer files
permanent; **X1/X2 thumb buttons + Alt+Left/Right** drive Back/Forward. Built on the
**already-shipped** `src/nav-history.ts` subsystem (the spec's "new module" premise was
wrong — caught in design review) — extended in place with an `isAlive` skip-dead traversal
(fixes Back-onto-closed-tab landing on the Terminal) + a drop-oldest stack cap. Host
`app-command` fallback for Windows thumb buttons rides the existing `to-webview` channel;
**per-platform de-dup** (`isWindows` gates the DOM path) → exactly one nav per press.

## What the process caught (value of the full pipeline)

- **architecture-critic caught a duplicate-subsystem rebuild (F2).** The spec asserted "no
  nav history exists"; a complete, wired, unit-tested nav subsystem already shipped. The
  spec was looped once and rebased onto it — avoiding two sources of truth for "what's active."
- **architecture-critic caught a validation-completeness bug (F3)** before code: validating
  tags against the *display-capped* list. Fixed in the spec (exact-existence validation).
- **The conductor's independent real-app e2e caught a real eviction bug (F1)** that unit
  tests (green) missed: closing a tab deleted its view-state, then the dying viewer's
  synchronous unmount capture *resurrected* it, so reopening a closed file wrongly restored
  its old scroll. Root-caused and fixed at the store (`markClosing` tombstone cleared on the
  reopen mount-read; order-independent) + unit-locked. This is exactly the "green units, broken
  app" gap the loop's runtime-observation requirement exists to close.

## needs-human-smoke

- **F2 physical X1/X2 thumb buttons + the Windows `app-command` fallback.** Not
  deterministically simulable (synthetic events don't emulate thumb buttons; e2e isn't in CI).
  They share the same renderer entry point the e2e *does* exercise (Alt+Left/Right →
  goBack/goForward), and the reducer is exhaustively unit-tested — but the physical press
  should be confirmed by hand on Windows. See [[playwright-electron-real-app-verification]].
- **F1 reveal-overrides-restore** in the real app (cross-file go-to-definition is too flaky
  to smoke in a tsconfig-less temp repo). Implemented + commented in `code-viewer.tsx`
  (`takeReveal()` wins, else `restoreViewState`) and unit-covered.

## Decisions queued during autonomy (reversible; flag for the user)

- **F2 D2 — global cross-session Back/Forward.** Already the shipped behavior and kept:
  Back can switch the active session ("exactly like VS Code across the app"). If you'd rather
  Back never switch sessions, it's a per-session-stack flip — the most likely thing to revisit.

## Follow-ups (not built)

- F1 v1 kinds: image pan/zoom + image-diff pair, PDF page/scale/fit, commit-diff scroll,
  file-editor scrollTop restart-persist.
- F3: command-palette "Compare changes" entry (literal any-tab reach); in-dialog two-/three-dot toggle.
- Add the e2e smoke suite to CI (still true from prior runs — would have surfaced F1's
  eviction bug and the written-but-unrun e2e read bugs automatically).

## Released — v0.18.0
Shipped on the user's go. Commit `8d610b7` "0.18.0", tag `v0.18.0`. CI verify
(`28483657006`) + Release (`28483657008`) both green; GitHub release published
not-draft with `Conduit-Setup-0.18.0.exe` + `.blockmap` + `latest.yml`. CHANGELOG cut
`[Unreleased]`→`[0.18.0]`; the three specs `git mv`'d to `docs/specs/archive/` + INDEX
updated. Minor bump (0.17.0 → 0.18.0) for three FULL user-facing features.

## Gotcha logged
A subagent worktree placed at a **repo-internal, non-gitignored** path (`.worktrees/`) breaks
`biome check .` with "nested root configuration" (the worktree's own `biome.json`) until
removed. `.claude/worktrees/` is gitignored so biome skips it; `.worktrees/` (only in
`.git/info/exclude`, which biome doesn't read) is not. Remove subagent worktrees before the
merged-tree verify.

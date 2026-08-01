# Ledger — Conduit revamp

The source of truth for this run. Status is only ever changed here, and only on evidence.
`verified` requires: `npm run verify` green **in the worktree**, a screenshot from `npm run shots`,
and a commit SHA. `landed` additionally requires the merge to `main` plus a green verify on the
**merged** tree.

Status: `pending` → `building` → `verified` → `landed` · or `blocked` (see `blockers.md`).

| # | Lane | Depends on | Owns (files) | Status | Evidence |
|---|---|---|---|---|---|
| F0 | **Token foundation** — 3 themes, shape + material + type axes, per-theme `--syn-*`, code-surface tokens, `--density-rtab-h`, registry edits, font pinning, settings migration, contrast test, Monaco/xterm/hljs rebinding, chamfer mechanism | — | `webview/styles.css` (`:root` + theme blocks only), `webview/themes.ts`, `webview/monaco-theme.ts`, `webview/xterm-theme.ts`, `webview/hljs-theme.css`, `webview/settings.tsx`, `src/settings.ts`, new contrast test | **landed** | lane `f56dac5`, merge `fd9967b` · merged-tree verify green, 2275 tests · shots: `aero`/`aero-dark`/`neon` workspace + editor, reviewed by conductor |
| F1 | **Shell geometry & chrome** — window pad/gutter/radius, detached panels + elevation, pill topbar with the labelled Workspace/Board/Canvas switcher, aggregate attention chip, git band merged into the tab row, right-rail tab height, Neon scanline/sweep | F0 | `webview/app.tsx`, `components/top-bar.tsx`, `components/center-pane.tsx`, `components/panel-frame.tsx`, `components/animated-bg.tsx`, `components/doc-tabs.tsx`, `components/git-indicator-bar.tsx`, shell/topbar/tabbar CSS | **landed** | lane `7e7d1e5`, merge `9a5fc5a` · merged-tree verify green, 2293 tests · shots ×3 themes reviewed |
| F2 | **Sessions & status system** — five states with glyph + word, indeterminate busy meter, needs-you prompt + Go to/Snooze, review diffstat, stale dim, group counts, host `lastLine` | F0, F1 | `components/sidebar.tsx`, `components/session-card.tsx`, `src/session-dot.ts`, `src/session-activity.ts`, `electron/main.ts` (lastLine), `src/protocol.ts`, `.session*` CSS | pending | — |
| F3 | **Right rail** — Changes groups + four status letters + summary, Files tree treatment, 40px rail tabs, search field | F0, F1 | `components/right-pane.tsx`, `components/search-pane.tsx`, `.right*`/`.change*`/`.filerow*`/`.search*` CSS | pending | — |
| F4 | **Editor & code surfaces** — ink panel in every theme, breadcrumb inside the code panel, tab pills, diff viewer | F0, F1 | `components/code-viewer.tsx`, `components/breadcrumb-bar.tsx`, `components/diff-viewer.tsx`, `.viewer*`/`.breadcrumb*` CSS | pending | — |
| F5 | **Review changes** (new features) — left file list with reviewed checkboxes, progress meter, narrative summary, Accept all / Discard footer, dual gutters, Split / Mark reviewed | F0, F1 | `components/review-view.tsx`, `webview/review-*.ts`, `.review*`/`.rcard*`/`.rline*` CSS | pending | — |
| F6 | **Overlays** — new-session modal, context menus, Settings (Appearance: window-miniature theme swatches, font pinning), scrim weights | F0, F1 | `components/new-session-modal.tsx`, `components/context-menu.tsx`, `components/settings-modal.tsx`, `webview/appearance-sections.ts`, `.modal*`/`.ctxmenu*`/`.settings*` CSS | **landed** | lane 650b79e, merge e3e9a45 · merged-tree verify green, 2331 tests · shots vs 8g/8h/8d reviewed |
| F7 | **Empty state** — per-panel empty states, three stacked routes with shortcuts | F0, F1 | `components/center-pane.tsx` (empty branch), `components/empty-state.tsx`, `.center-empty*`/`.emptystate*` CSS | **landed** | lane a8b23c4, merge 5516888 · merged-tree verify green, 2327 tests · shots vs 8a reviewed |
| F8 | **Feature board** — columns as panels, agent-proposed flag, WIP counts | F0, F1 | `components/board-view.tsx`, `.board*`/`.bcard*`/`.bcol*` CSS | pending | — |
| F9 | **Architecture canvas** — node cards on the language, node-count chip, dashed-amber proposed nodes | F0, F1 | `components/architecture-view.tsx`, `.arch*` CSS | pending | — |

## Waves

1. **F0** (serial — everything depends on the tokens)
2. **F1** (serial — every screen sits inside this shell)
3. **F2 ‖ F3 ‖ F4** (disjoint components, disjoint selector namespaces)
4. **F5 ‖ F6 ‖ F7**
5. **F8 ‖ F9**

## Log

- 2026-07-31 — Phase 0 done: baseline verify green at `ecff720`; visual harness added
  (`npm run shots`, `test/e2e/visual/`), smoke-checked at 1320×820 against the fixture repo.
- 2026-07-31 — design handoff vendored to `docs/design-handoff/revamp/` (25 frames + extracted spec).
- 2026-07-31 — `npm audit` went red **on main, independent of any lane**: tar / postcss / js-yaml
  advisories published after the morning baseline. Cleared with a lockfile-only `npm audit fix`
  (`fcc7f2e`); the 2 survivors are moderate (monaco → dompurify), below the gate.
- 2026-07-31 — **F0 landed** (`fd9967b`). Merged-tree verify green, 2275 tests. Three themes render
  correctly in the real app; colour and material match the frames, geometry still pre-F1 as expected.
- 2026-07-31 — **F3 landed** (`cfcb59d`). Changes rail matches 8c: summary row, Staged/Changes
  groups, outlined status letters on the semantic tokens. Also fixed a real pre-existing bug — the
  open file never highlighted in the tree (native vs forward-slash path mismatch in the row match;
  the expansion walk masked it).
- 2026-07-31 — **F4 landed** (`432ec22`). Breadcrumb moved inside the code panel (a fourth chrome
  band gone); Monaco diff washes repointed onto the contract tokens after F4 measured the old ones
  compositing to ~28%, over the 9–15% ceiling.
- 2026-07-31 — conductor fix: the smoke harness cleanup never answered the quit guard, so any
  scenario owning a running session passed every assertion and still exited 2. `git-history` and
  `branch-switch` now run clean. Also updated the git-history branch-fill assertion (the revamp
  gives segments a resting pill per 5a) and deleted a comment F1 left claiming the opposite.
- 2026-07-31 — **F7 landed** (5516888): per-panel empty states + three real start routes. It found
  that the frames Ctrl+Shift+T / Ctrl+Shift+R are already bound (reopenClosedTab, openReview) and
  registered two new rebindable actions instead of shadowing them — no printed keystroke is dead.
- 2026-07-31 — **F6 landed** (e3e9a45): new-session modal, 12-item menu, sixteen-control Appearance
  with window-miniature swatches. Q1 + Q4 ruled. It rewrote one settings test that encoded the
  fresh-Neon-profile defect F3 found, and flagged the rewrite rather than leaving it silent —
  conductor checked: the replacement asserts the new rule AND a pinned-wins case, so it is
  strictly stronger than what it replaced.

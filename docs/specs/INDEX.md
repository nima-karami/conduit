# Specs index

How specs work here: **active** specs (currently being designed or built) live in
`docs/specs/`. When their feature ships they move to `docs/specs/archive/` — kept
for reference but **out of the agents' default path** (so a growing history never
pollutes context; see ADR 0003). New specs are `YYYY-MM-DD-<slug>.md` with
`status:` + `date:` frontmatter, and get a row here.

## Active

| Date | Spec |
|------|------|
| 2026-07-02 | [review-changes-first-class](2026-07-02-review-changes-first-class.md) — make Review Changes a surface you can survey + navigate: **diffstat summary** (N files · +ins −del, above the cards, all three sources; pure `review-stats.ts` fold over counts already in hand, no new IPC) + **file navigator** (toggleable changed-file list; click → windowed scroll-to-card, expand; persisted open state). Search-in-diff / side-by-side / staging / comments explicitly deferred. `status: active` (FULL) |

The **agent chat UI / skill installer / interactive plans** specs were **rejected** (2026-06-23):
they relied on the Claude Agent SDK, which requires a billed API key and cannot use a Pro/Max
subscription. See [[conduit-chat-ui-run]] and `docs/plans/2026-06-23-north-star-roadmap.plan.md`.

## Archived (implemented)

| Date | Spec |
|------|------|
| 2026-07-01 | [review-diff-syntax](archive/2026-07-01-review-diff-syntax.md) — per-language **syntax highlighting** for Review Changes diff rows (the primary agent-diff surface): reuses the app's existing `highlight.js` (no new dep) via pure `webview/syntax-highlight.ts` (`highlightLine`→segments, monaco→hljs map, bounded cache, long-line guard); windowed rows only; single editor-matching `--syn-*` palette + app-owned hljs theme (replaced markdown's github-dark); add/remove tint + `+`/`-` sign preserved; unknown lang → plain. Shipped [Unreleased] (FULL) |
| 2026-07-01 | [markdown-search](archive/2026-07-01-markdown-search.md) — in-rendered-markdown find (Ctrl/Cmd+F): viewer-scoped find bar (owns-check capture, no global-find hijack) highlighting via the **CSS Custom Highlight API** (no DOM mutation), `n/total` count, Enter/Shift+Enter cycle+scroll, Esc clears; pure `md-find.ts` (mirrors `pdf-find.ts`) + TreeWalker ranges; reuses `.term-find` chrome. Shipped [Unreleased] (FULL) |
| 2026-07-01 | [mermaid-export](archive/2026-07-01-mermaid-export.md) — **Export SVG / Export PNG** from the mermaid zoom overlay; renderer-only download (`<a download>` + object URL, deferred revoke). Pure `webview/mermaid-export.ts` (`svgToBlob` w/ idempotent XML prolog+xmlns, `svgToPngBlob` viewBox→canvas 2×, `download`, `diagramFilename`). Actual OS save = human-smoke (native dialog). Shipped [Unreleased] (LITE) |
| 2026-07-01 | [theme-correctness](archive/2026-07-01-theme-correctness.md) — **DOWNSCOPED at build** to Paper light-theme legibility (md bold `#fff`→`var(--text)`; dead `--vscode-input-background` inputs→`var(--raise)`; accent btns→`var(--on-accent)`). Editor/terminal surface is dark on all themes by design, so Monaco vs-dark is correct — the "surface follows theme" (`surfaceColor:'auto'`) FULL design is DEFERRED as a product decision (see run report). Shipped [Unreleased] (LITE) |
| 2026-06-30 | [review-compare-dialog](archive/2026-06-30-review-compare-dialog.md) — first-class Compare-refs **modal** (replaces the cramped in-band builder) + discoverable git-band **Compare icon**; adds **tags + remote branches** to the ref pipeline (exact-existence host validation, decoupled from the display cap); diffs any two refs **without checkout** (reuses the shipped git:rangeDiff engine). Released 0.18.0 (FULL) |
| 2026-06-30 | [tab-scroll-state-memory](archive/2026-06-30-tab-scroll-state-memory.md) — per-tab **scroll & view-state memory**: a renderer view-state store keyed by OpenDoc.id restores scroll/cursor/fold on switch-back (Monaco full view state; review list a layout-independent anchor); reveal overrides restore; evict-on-close survives the dying viewer's unmount capture via a `markClosing` tombstone. MVP (image/pdf/restart-persist deferred). Released 0.18.0 (FULL) |
| 2026-06-30 | [mouse-nav-buttons](archive/2026-06-30-mouse-nav-buttons.md) — VS Code mouse parity: **middle-click** closes tabs / opens explorer files permanent; **back/forward (X1/X2 + Alt+Left/Right)** EXTEND the existing nav-history reducer (isAlive skip-dead + cap; renderer-DOM + host app-command fallback for Windows thumb buttons, per-platform de-dup). Released 0.18.0 (FULL) |
| 2026-06-29 | [explorer-dnd-rename-polish](archive/2026-06-29-explorer-dnd-rename-polish.md) — Explorer DnD & rename polish: **precise single-row drop highlight** (fixed the "whole directory lights up" bug — match on the row's own path, not the shared effective dir), **spring-loaded folders** (600 ms auto-expand + re-collapse on dragend), **multi-selection drag** (top-level de-dupe), **conflict dialog** (Replace / Keep both / Cancel + "apply to all"; host `fsMove`/`fsCopy`/`fsImport` gained an `onConflict` policy + `EEXIST` discriminant; per-item batch loop, stop-and-report), **F2 + full keyboard nav** (arrows/Enter/Delete/Esc + Cut/Copy/Paste as the WCAG 2.5.7 drag-alternative), **stem-only rename selection**, Windows case-only rename (two-step) + reserved-name validation, `aria-live`. Released 0.17.0 (FULL) |
| 2026-06-29 | [review-changes-polish](archive/2026-06-29-review-changes-polish.md) — Review polish v2: source picker MOVED onto the **git band** (reverses review-commit-picker D2); **always-wrap** diff lines (no toggle); **compact portion** (`MAX_CARD_ROWS` 300→40); **compare two refs** — `range` source (`{base,head}` of commit/branch/working) + `git:rangeDiff` IPC (3-dot/2-dot, host-validated; pure `src/git-range.ts`), `useRangeFiles`, push/pop Compare builder. Fixed a v0.15.0 bug: commit-detail Review button under `.gh__detail-close` ate its clicks. Released 0.16.0 (FULL) |
| 2026-06-29 | [review-card-collapse](archive/2026-06-29-review-card-collapse.md) — collapsible Review file cards (header click toggle; `collapsed` on per-path `CardUiState`, body unmounts → existing ResizeObserver re-windows) + large/added-file portioning (`MAX_CARD_ROWS` 2000→300 via `planRowCap`; two-way "Show all" ⇄ "Show less"); "Open file" stays a sibling; collapse-all is v1 (FULL) |
| 2026-06-29 | [review-commit-picker](archive/2026-06-29-review-commit-picker.md) — Review-header source control becomes a searchable commit picker (`CommitPickerMenu` mirrors `branch-switcher-menu`: `git:history` cap 150, filter sha-prefix/subject/author, pasted-SHA row, pinned "Current" row, load-timeout+Retry); concise trigger label; commit-detail "Review changes" → icon-only right-floated `.gh__review-commit` (FULL) |
| 2026-06-29 | [commit-detail-resize-persistence](archive/2026-06-29-commit-detail-resize-persistence.md) — persist the History tab's commit-detail pane height (`historyDetailHeight` on AppSettings, cloned from `leftWidth`/`rightWidth`) so a dragged size survives the tab closing/reopening and restart; clamp-on-restore at render (LITE) |
| 2026-06-29 | [review-commit-source](archive/2026-06-29-review-commit-source.md) — let the Review tab show a SPECIFIC commit's changes (not only the working tree): `reviewSource` on the singleton review doc via a new `openReview` action, a "Review changes" button on the commit detail, a header source breadcrumb (Working tree ⇄ commit); commit mode reuses `useCommitFiles` to feed the windowed renderer (diffs preloaded, `onRequestDiff` no-op); exposes `openReviewForCommit` (FULL) |
| 2026-06-29 | [terminal-commit-link](archive/2026-06-29-terminal-commit-link.md) — a commit hash printed in the terminal becomes a clickable link opening that commit in the Review tab: renderer detects word-bounded lowercase `[0-9a-f]{7,40}` (per-row cap 32), HOST validates each as a real commit (`cat-file --batch-check` via stdin, cached; never trusted into execFile), path links win precedence, click routes the full sha → `openReviewForCommit` (FULL) |
| 2026-06-27 | [review-virtualization](archive/2026-06-27-review-virtualization.md) — virtualize the Review Changes card list (always-on pure `computeWindow` windower — no new dep); per-card-on-mount diff fetch (request-once, window-bounded); per-path height + expansion cache; huge-file row cap; dev/test perf counters + e2e load fixture (FULL) |
| 2026-06-27 | [explorer-multiselect](archive/2026-06-27-explorer-multiselect.md) — VS-Code-faithful Explorer selection: Ctrl/Cmd toggles a row, Shift range-selects over the flattened visible order, plain click collapses + reseats anchor; pure selection model replacing `selectedDir`; create-target from active item; keyboard/bulk deferred to v1 (FULL) |
| 2026-06-27 | [editor-tab-behavior](archive/2026-06-27-editor-tab-behavior.md) — VS Code editor tabs: single-click = one reusable italic **preview** tab (replace-in-place, ≤1/session); dbl-click/edit/drag **promotes** to permanent; persist + restore open tabs (active + preview/pinned) across restart, gated by `restoreSessions` (FULL) |
| 2026-06-27 | [review-changes-entry-point](archive/2026-06-27-review-changes-entry-point.md) — move the Review Changes action out of the Changes tab to sit beside "View commit history" in the git band; always visible + clickable; Review page keeps its empty state (LITE) |
| 2026-06-25 | [multi-repo-awareness](archive/2026-06-25-multi-repo-awareness.md) — dedicated repo picker (separate from branch picker) scopes all git surfaces to one **active repo**; auto-follows context (cd / file focus / explorer click) with manual **pin-until-unpinned**; bounded sub-repo scan; explorer stays full-tree (FULL) |
| 2026-06-23 | [context-menu-consistency](archive/2026-06-23-context-menu-consistency.md) — one canonical ordering for every object context menu (Primary→Create→Edit→Reference→Destructive), destructive always last+separated, primary-first, sentence-case labels + dedup (FULL) |
| 2026-06-22 | [comprehensive-path-links](archive/2026-06-22-comprehensive-path-links.md) — terminal path-link matching broadened to bare project-relative paths + bare filenames; host `resolvePathToken` resolves against a project file index; 1 match opens, >1 opens a disambiguation dropdown (FULL; MVP `31af2f2` + v1 `f8a8f95`) |
| 2026-06-22 | [prune-recent-folders](archive/2026-06-22-prune-recent-folders.md) — hide deleted folders from the New Session recent-folders list by filtering missing paths in `reposForState()`; non-destructive (keeps `repos.json`) (LITE) |
| 2026-06-22 | [git-ref-dropdown](archive/2026-06-22-git-ref-dropdown.md) — replace the History-tab native `<select>` ref filter with Conduit's own themed dropdown (reuse the menu/branch-switcher patterns); same filter semantics (LITE) |
| 2026-06-22 | [history-tabs](archive/2026-06-22-history-tabs.md) — commit & file-diff open as full-width editor tabs (preview/pin; new `commit`/`commit-diff` doc kinds); History graph tab slims to graph+list; + branch-switcher button polish (caret + stuck-focus-ring fix) |
| 2026-06-18 | [branch-worktree-indicator](archive/2026-06-18-branch-worktree-indicator.md) — Slice A read-only indicator (0.3.0) + Slice B in-place branch switcher (refuse-if-busy/dirty, D-1 approved); worktree-switch deferred |
| 2026-06-19 | [multi-window](archive/2026-06-19-multi-window.md) — Slice A (many windows, per-window isolation) + Slice B (move a live session across windows, no PTY restart) + Slice C (cross-window drag/tear-out + layout persistence) |
| 2026-06-19 | [logging](archive/2026-06-19-logging.md) |
| 2026-06-19 | [git-history](archive/2026-06-19-git-history.md) |
| 2026-06-09 | [file-browser-code-viewer-design](archive/2026-06-09-file-browser-code-viewer-design.md) |
| 2026-06-10 | [architecture-canvas-design](archive/2026-06-10-architecture-canvas-design.md) |
| 2026-06-10 | [f1-settings-cleanup](archive/2026-06-10-f1-settings-cleanup.md) |
| 2026-06-10 | [f2-chrome-nav](archive/2026-06-10-f2-chrome-nav.md) |
| 2026-06-10 | [f3-session-cards](archive/2026-06-10-f3-session-cards.md) |
| 2026-06-10 | [f4-palette-depth](archive/2026-06-10-f4-palette-depth.md) |
| 2026-06-10 | [f5-context-menus](archive/2026-06-10-f5-context-menus.md) |
| 2026-06-10 | [f6-drag-drop](archive/2026-06-10-f6-drag-drop.md) |
| 2026-06-10 | [f7-dockable-layout](archive/2026-06-10-f7-dockable-layout.md) |
| 2026-06-10 | [f8-background-depth](archive/2026-06-10-f8-background-depth.md) |
| 2026-06-10 | [f9-kanban-board](archive/2026-06-10-f9-kanban-board.md) |
| 2026-06-10 | [t1-themeable-terminal](archive/2026-06-10-t1-themeable-terminal.md) |
| 2026-06-10 | [t2-shader-bg](archive/2026-06-10-t2-shader-bg.md) |
| 2026-06-10 | [t3-card-roles](archive/2026-06-10-t3-card-roles.md) |
| 2026-06-10 | [t4-rebind-shortcuts](archive/2026-06-10-t4-rebind-shortcuts.md) |
| 2026-06-10 | [t6-split-panes](archive/2026-06-10-t6-split-panes.md) |
| 2026-06-10 | [u2-crossfile-goto](archive/2026-06-10-u2-crossfile-goto.md) |
| 2026-06-10 | [u3-custom-shader](archive/2026-06-10-u3-custom-shader.md) |
| 2026-06-11 | [app-branding](archive/2026-06-11-app-branding.md) |
| 2026-06-11 | [board-copy](archive/2026-06-11-board-copy.md) |
| 2026-06-11 | [board-ctx-menu](archive/2026-06-11-board-ctx-menu.md) |
| 2026-06-11 | [board-dates](archive/2026-06-11-board-dates.md) |
| 2026-06-11 | [board-skill-transitions](archive/2026-06-11-board-skill-transitions.md) |
| 2026-06-11 | [busy-indicator](archive/2026-06-11-busy-indicator.md) |
| 2026-06-11 | [canvas-ctx-menu](archive/2026-06-11-canvas-ctx-menu.md) |
| 2026-06-11 | [canvas-kinds](archive/2026-06-11-canvas-kinds.md) |
| 2026-06-11 | [close-all-others](archive/2026-06-11-close-all-others.md) |
| 2026-06-11 | [close-all-startstate](archive/2026-06-11-close-all-startstate.md) |
| 2026-06-11 | [collapse-explorer](archive/2026-06-11-collapse-explorer.md) |
| 2026-06-11 | [conduit-board](archive/2026-06-11-conduit-board.md) |
| 2026-06-11 | [conduit-canvas](archive/2026-06-11-conduit-canvas.md) |
| 2026-06-11 | [conduit-specs](archive/2026-06-11-conduit-specs.md) |
| 2026-06-11 | [ctx-menu-overhaul](archive/2026-06-11-ctx-menu-overhaul.md) |
| 2026-06-11 | [ctx-menu-position](archive/2026-06-11-ctx-menu-position.md) |
| 2026-06-11 | [diff-controls](archive/2026-06-11-diff-controls.md) |
| 2026-06-11 | [drag-dock-bidirectional](archive/2026-06-11-drag-dock-bidirectional.md) |
| 2026-06-11 | [drag-handles](archive/2026-06-11-drag-handles.md) |
| 2026-06-11 | [edge-labels](archive/2026-06-11-edge-labels.md) |
| 2026-06-11 | [editable-code](archive/2026-06-11-editable-code.md) |
| 2026-06-11 | [editor-bg](archive/2026-06-11-editor-bg.md) |
| 2026-06-11 | [editor-depth](archive/2026-06-11-editor-depth.md) |
| 2026-06-11 | [editor-padding](archive/2026-06-11-editor-padding.md) |
| 2026-06-11 | [explorer-refresh](archive/2026-06-11-explorer-refresh.md) |
| 2026-06-11 | [file-tree-mutations](archive/2026-06-11-file-tree-mutations.md) |
| 2026-06-11 | [fresh-file-content](archive/2026-06-11-fresh-file-content.md) |
| 2026-06-11 | [git-actions](archive/2026-06-11-git-actions.md) |
| 2026-06-11 | [goto-def](archive/2026-06-11-goto-def.md) |
| 2026-06-11 | [group-reorder](archive/2026-06-11-group-reorder.md) |
| 2026-06-11 | [host-hardening](archive/2026-06-11-host-hardening.md) |
| 2026-06-11 | [link-handling](archive/2026-06-11-link-handling.md) |
| 2026-06-11 | [markdown-links](archive/2026-06-11-markdown-links.md) |
| 2026-06-11 | [markdown-niceties](archive/2026-06-11-markdown-niceties.md) |
| 2026-06-11 | [md-reflow](archive/2026-06-11-md-reflow.md) |
| 2026-06-11 | [menu-system](archive/2026-06-11-menu-system.md) |
| 2026-06-11 | [menu-toggle-on-trigger](archive/2026-06-11-menu-toggle-on-trigger.md) |
| 2026-06-11 | [minimap](archive/2026-06-11-minimap.md) |
| 2026-06-11 | [runtime-icon](archive/2026-06-11-runtime-icon.md) |
| 2026-06-11 | [save-reliability](archive/2026-06-11-save-reliability.md) |
| 2026-06-11 | [session-meta](archive/2026-06-11-session-meta.md) |
| 2026-06-11 | [settings-echo-clobber](archive/2026-06-11-settings-echo-clobber.md) |
| 2026-06-11 | [settings-live-preview](archive/2026-06-11-settings-live-preview.md) |
| 2026-06-11 | [settings-sections](archive/2026-06-11-settings-sections.md) |
| 2026-06-11 | [sort-filter-menu](archive/2026-06-11-sort-filter-menu.md) |
| 2026-06-11 | [switcher-icons-only](archive/2026-06-11-switcher-icons-only.md) |
| 2026-06-11 | [tab-containment](archive/2026-06-11-tab-containment.md) |
| 2026-06-11 | [tab-overflow](archive/2026-06-11-tab-overflow.md) |
| 2026-06-11 | [terminal-codeblock-color](archive/2026-06-11-terminal-codeblock-color.md) |
| 2026-06-11 | [terminal-ergonomics](archive/2026-06-11-terminal-ergonomics.md) |
| 2026-06-11 | [terminal-padding](archive/2026-06-11-terminal-padding.md) |
| 2026-06-11 | [transparency](archive/2026-06-11-transparency.md) |
| 2026-06-11 | [view-switcher](archive/2026-06-11-view-switcher.md) |
| 2026-06-11 | [webview-papercuts](archive/2026-06-11-webview-papercuts.md) |
| 2026-06-11 | [word-wrap](archive/2026-06-11-word-wrap.md) |
| 2026-06-16 | [smoke-harness](archive/2026-06-16-smoke-harness.md) |
| 2026-06-16 | [quit-guard](archive/2026-06-16-quit-guard.md) |
| 2026-06-16 | [sidebar-grouping](archive/2026-06-16-sidebar-grouping.md) |
| 2026-06-16 | [rich-content-viewing](archive/2026-06-16-rich-content-viewing.md) |
| 2026-06-16 | [auto-update](archive/2026-06-16-auto-update.md) |
| 2026-06-16 | [install-update-experience](archive/2026-06-16-install-update-experience.md) |
| 2026-06-17 | [terminal-path-links](archive/2026-06-17-terminal-path-links.md) |
| 2026-06-17 | [macos-test-build](archive/2026-06-17-macos-test-build.md) |
| 2026-06-17 | [image-viewer-zoom-and-diffs](archive/2026-06-17-image-viewer-zoom-and-diffs.md) |
| 2026-06-17 | [installer-branding](archive/2026-06-17-installer-branding.md) |
| 2026-06-18 | [md-alerts](archive/2026-06-18-md-alerts.md) |
| 2026-06-18 | [md-frontmatter](archive/2026-06-18-md-frontmatter.md) |
| 2026-06-18 | [md-math](archive/2026-06-18-md-math.md) |
| 2026-06-18 | [md-toc](archive/2026-06-18-md-toc.md) |
| 2026-06-18 | [mermaid-theme](archive/2026-06-18-mermaid-theme.md) |
| 2026-06-18 | [mermaid-zoom](archive/2026-06-18-mermaid-zoom.md) |
| 2026-06-19 | [open-with](archive/2026-06-19-open-with.md) |
| 2026-06-19 | [os-file-open](archive/2026-06-19-os-file-open.md) |
| 2026-06-19 | [pdf-viewer](archive/2026-06-19-pdf-viewer.md) |
| 2026-06-19 | [web-view](archive/2026-06-19-web-view.md) |

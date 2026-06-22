# Specs index

How specs work here: **active** specs (currently being designed or built) live in
`docs/specs/`. When their feature ships they move to `docs/specs/archive/` — kept
for reference but **out of the agents' default path** (so a growing history never
pollutes context; see ADR 0003). New specs are `YYYY-MM-DD-<slug>.md` with
`status:` + `date:` frontmatter, and get a row here.

## Active

| Date | Spec |
|------|------|
| 2026-06-22 | [comprehensive-path-links](2026-06-22-comprehensive-path-links.md) — broaden terminal path-link matching. **MVP shipped (2026-06-22, `31af2f2`):** bare project-relative paths with a separator (`src/core/theme/accent.ts`). **v1 pending:** project-wide bare-filename suffix search + >1-match disambiguation dropdown + file-index IPC (deferred — see `.autoloop/blockers.md`) (FULL) |
| 2026-06-17 | [agent-chat-ui](2026-06-17-agent-chat-ui.md) — agent-agnostic chat UI over CLI agents (Claude Code adapter via Agent SDK; modes incl. Auto/classifier; tool cards + inline approvals; skills picker; transcript resume; Codex + interactive planning designed) |
| 2026-06-17 | [skill-installer](2026-06-17-skill-installer.md) — install Conduit-bundled skills into project/user `.claude/skills/` with installed/outdated/modified detection (Claude Code; Codex layout designed) |
| 2026-06-17 | [interactive-plans](2026-06-17-interactive-plans.md) — agent-authored `.conduit/plan.json` rendered as a commentable, anchored, round-tripped plan view (comments persist to disk; proposal-diff revisions); ships the `conduit-plan` skill |

## Archived (implemented)

| Date | Spec |
|------|------|
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

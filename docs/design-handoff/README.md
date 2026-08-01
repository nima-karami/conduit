# Conduit — design handoff brief

> **This describes the PRE-REVAMP UI (v0.24.0, 2026-07-31 morning).** It is the brief that
> produced the revamp; the screenshots below are the *before*. The revamp itself shipped the same
> day — see `docs/runs/2026-07-31-revamp/report.md` and `docs/design-handoff/revamp/`.

**For:** a full visual/UX revamp of the app.
**App version:** 0.24.0 · Electron 42 · React 18 · Windows-only in practice.
**Captured:** 2026-07-31, from the real built app driven by Playwright at 1600×1000.
**Screenshots:** [`screenshots/`](screenshots) — 40 shots, referenced by number throughout.

---

## 1. What Conduit is, in one paragraph

Conduit is a desktop control tower for running several CLI coding agents at once. Each agent
(Claude Code, Aider, a plain shell — anything with a command line) runs in a **real embedded
terminal**, grouped by the project it belongs to, with a live git panel, a file explorer, a
Monaco editor, and a diff-review surface wrapped around it. It is not a chat client and not an
IDE with an AI sidebar: the agent's own TUI is the interface, and Conduit is the workspace that
makes running four of them at once survivable.

The project's own words:

> Most agent tooling assumes one agent in one window. Conduit is built for the opposite: running
> several CLI agents at once, each in a **real terminal**, using **your own auth**, grouped by the
> project they belong to. There's no billing middleman and no chat-pane abstraction sitting on top
> of the terminal — just the actual agent CLIs, side by side, with the git status and `.claude`
> configuration for each project visible at a glance.

There is a second, more ambitious half. Project knowledge — an architecture diagram, a feature
board, per-feature specs — lives in a committed `.conduit/` folder that **humans and agents
co-edit**. The agent never writes the canonical file; it writes a `*.proposed.json` sibling, and
the app surfaces a diff the human accepts or rejects. That review loop is the app's signature
interaction and the thing a redesign most needs to get right.

**North star (from the roadmap doc):**

> A beautiful desktop control tower for running and collaborating with multiple CLI coding agents,
> where project knowledge is a living artifact humans and agents co-edit through the
> human-owned / agent-proposes loop. Near-term lens: **make it the daily driver.**

**Who it's for:** a developer already paying for one or more CLI coding agents, on Windows,
juggling several sessions across several repos, who wants to review what the agents did without
leaving the app. Single-user desktop, not a multi-tenant web product.

---

## 2. Principles a redesign has to respect

These aren't taste preferences — they're load-bearing decisions recorded in ADRs and specs.

| Principle | What it means for design |
|---|---|
| **No chat pane over the terminal.** | The center of gravity is an xterm surface. A chat UI was actually built on a branch in June and **deliberately discarded** (it required a billed API key and couldn't use a Pro/Max subscription). Don't design one. |
| **Human owns the artifact; the agent proposes.** | Every agent-authored change needs a review → diff → accept/reject affordance. This is the interaction to make beautiful. |
| **The renderer holds no source of truth.** | All state lives in the Electron main process and arrives over typed IPC. The UI is a projection; any design that assumes local mutable state will fight the architecture. |
| **VS Code parity is the interaction grammar.** | Tabs, preview tabs, Ctrl+P, breadcrumbs, middle-click, F2 rename, spring-loaded folders. Users arrive with VS Code muscle memory and the app deliberately matches it. |
| **The hosted program wins the keyboard.** | When a terminal is focused, every key goes to the shell/TUI. Ctrl+` is the single exception. App chrome can't claim shortcuts freely. |
| **One canonical context-menu order.** | Primary → Create → Edit → Reference → Destructive; destructive always last and separated; sentence case. |
| **Bounded, cancellable, never hangs.** | Payload caps and "Showing N of M files" banners are designed-for states, not errors. Truncation needs a first-class visual treatment. |
| **Agent output must not beacon out.** | Remote images in rendered Markdown load only behind an explicit "Load image from …" click. |

**Explicit non-goals:** a chat surface; web accessibility as a global lint gate (single-user
desktop — though individual specs do real a11y work: `aria-live` regions, keyboard drag
alternatives, Shift+F10 menus); Review as a center view (it is intentionally an editor *tab*).

---

## 3. Layout shell

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ topbar   logo · sidebar toggle · back/forward │ omnibar (Ctrl+P) │ view switch │ window ctls │
├────────────────┬────────────────────────────────────────┬─────────────────────┤
│ SESSIONS       │ tab strip (terminal tab + doc tabs)     │ Changes │ Files     │
│ (panel)        ├────────────────────────────────────────┤ (panel)             │
│  filter        │ git band  (repo · branch · history ·    │  search box         │
│  project group │            review · compare)            │  file tree          │
│   session card ├────────────────────────────────────────┤                     │
│   session card │ center: terminal / editor / markdown /  │                     │
│                │         diff / review / history / web   │                     │
│  update card   │                                        │                     │
│  ⚙ Settings    │                                        │                     │
└────────────────┴────────────────────────────────────────┴─────────────────────┘
        overlays: Feature Board · Architecture Canvas · modals · palette · toasts
```

Notes that matter for layout work:

- The three regions (`sessions`, `center`, `explorer`) are a **persisted permutation** — panels
  drag-dock into a different order, and either side panel can be hidden entirely (the center
  reflows). Widths are CSS vars (`--left-w`, `--right-w`) with draggable seams.
- **There is no status bar.** The lowest persistent chrome is the Settings button in the sessions
  panel foot.
- The topbar's empty area is the OS window drag region; the app draws its own window controls.
- Board and Canvas are **full overlays** over the workbench, chosen by the three-way view switch
  in the topbar — mutually exclusive with the editor, not tabs.
- The file tree, the history graph, and the review card list are all **virtualized**; only visible
  rows exist in the DOM.

---

## 4. Screen-by-screen tour

### 4.1 Start and workspace

| | |
|---|---|
| **01 — Empty state** ([`01-empty-state.png`](screenshots/01-empty-state.png)) | Logo, wordmark, "No active session", one CTA. The sidebar shows its own empty copy ("No sessions yet. Hit +"). This is the app's first impression and currently does very little work. |
| **02 — Workspace** ([`02-workspace-terminal.png`](screenshots/02-workspace-terminal.png)) | The default view: sessions grouped by project on the left, a live PowerShell session in the center under the git band, the file tree on the right. Two sessions on the same repo show the grouping model. |
| **03 — Session context menu** ([`03-session-context-menu.png`](screenshots/03-session-context-menu.png)) | Move to window / split / relaunch / rename / set icon / duplicate / copy path / reveal / close ×3. Illustrates the canonical menu ordering used across ~13 different menus. |
| **04 — New session** ([`04-new-session-modal.png`](screenshots/04-new-session-modal.png)) | Recent folders list + a "Browse…" row + an agent select in the footer. This is the only place an agent is chosen, and it's a plain `<select>`. |

**Session cards** carry a lot: a glyph whose state encodes running/idle/busy/attention/stale, a
name, and up to three configurable fields (name, agent, folder, path, worktree, time, status…).
Attention-flagged sessions float to the top in derived sorts and get an amber treatment; a busy
session pulses. This is the app's ambient status system and it is currently very quiet visually.

### 4.2 Navigation and search

| | |
|---|---|
| **05 — Command palette** ([`05-command-palette.png`](screenshots/05-command-palette.png)) | Ctrl+Shift+P. ~35 commands, grouped, with inline `kbd` combos. |
| **06 — Quick open** ([`06-quick-open.png`](screenshots/06-quick-open.png)) | Ctrl+P over one corpus: sessions, agents, and gitignore-aware files, with fuzzy match highlighting. |
| **07 — Find in files** ([`07-find-in-files.png`](screenshots/07-find-in-files.png)) | Embedded at the top of the Files tab. Matches contents *and* file/folder names (name hits get a badge), with case/word/regex toggles and include/exclude globs. |

### 4.3 Explorer

| | |
|---|---|
| **08 — File tree** ([`08-explorer-tree.png`](screenshots/08-explorer-tree.png)) | Lazy, virtualized, gitignored entries dimmed rather than hidden, per-file git status dots, three icon packs (none / monochrome / colored). |
| **09 — Tree context menu** ([`09-explorer-context-menu.png`](screenshots/09-explorer-context-menu.png)) | New file/folder, rename, cut/copy/paste (the keyboard alternative to drag), copy path, reveal, delete. |
| **10 — Terminal context menu** ([`10-terminal-context-menu.png`](screenshots/10-terminal-context-menu.png)) | Copy / paste / find / clear. |

Not screenshot-able but worth knowing: spring-loaded folders on drag-hover, multi-selection drag,
a Replace / Keep both / Cancel conflict dialog with "apply to all", OS-file import, undo/redo for
file operations, and stem-only rename selection.

### 4.4 Editor and rich content

| | |
|---|---|
| **11 — Code editor** ([`11-editor-monaco.png`](screenshots/11-editor-monaco.png)) | Monaco, editable and savable, with a VS Code-style breadcrumb bar (clickable path segments + live symbol chain) and per-tab scroll/cursor/fold memory. |
| **12 — Markdown viewer** ([`12-markdown-viewer.png`](screenshots/12-markdown-viewer.png)) | Rendered Markdown with a View-source toggle. This is where agent-written docs land, so it matters more than it looks. |
| **13 — Rich Markdown** ([`13-markdown-rich-mermaid.png`](screenshots/13-markdown-rich-mermaid.png)) | One doc showing frontmatter card, GitHub alerts, a themed Mermaid diagram, a table, a syntax-highlighted code block, and KaTeX math. |
| **14 — Outline** ([`14-markdown-outline.png`](screenshots/14-markdown-outline.png)) | Collapsible heading outline with scroll-spy. |
| **15 — Mermaid zoom** ([`15-mermaid-zoom-overlay.png`](screenshots/15-mermaid-zoom-overlay.png)) | Fullscreen diagram viewer: wheel/button zoom, drag or arrow-key pan, reset-to-fit, export SVG/PNG. |

Also in this family, not shown: an image viewer with side-by-side / swipe / onion image diffing,
a full PDF viewer (thumbnails, outline, find, rotate), and an in-app web tab with an address bar.

### 4.5 Git and review — the app's densest area

| | |
|---|---|
| **16 — Changes** ([`16-git-changes.png`](screenshots/16-git-changes.png)) | Live status with staged/unstaged sections, per-row stage/unstage/discard on hover, a diffstat header, and a kebab for bulk operations. |
| **17 — Diff viewer** ([`17-diff-viewer.png`](screenshots/17-diff-viewer.png)) | Monaco diff for one file, inline/side-by-side toggle, prev/next change. |
| **18 — Review Changes** ([`18-review-changes.png`](screenshots/18-review-changes.png)) | The primary agent-diff surface: every changed file as a collapsible card, syntax-highlighted diff rows, word-level emphasis, collapsed context folds, a `5 files changed · +12 −79` diffstat. Opens as an editor tab. |
| **19 — File navigator** ([`19-review-file-navigator.png`](screenshots/19-review-file-navigator.png)) | Optional left column listing changed files with kind badge and per-file counts. |
| **20 — Review source picker** ([`20-review-commit-picker.png`](screenshots/20-review-commit-picker.png)) | Review the working tree, a specific commit (searchable by sha/message/author, or paste a SHA), or a range. |
| **21 — Compare refs** ([`21-compare-refs-dialog.png`](screenshots/21-compare-refs-dialog.png)) | Pick base and head from local branches, remotes, tags, or a pasted SHA; swap sides; live `base...head` preview. Diffs anything without checking out. |
| **22 — Branch switcher** ([`22-branch-switcher.png`](screenshots/22-branch-switcher.png)) | Filter-as-you-type branch list on the git band. Checkout runs out of band and refuses when the terminal is busy or the tree is dirty. |
| **23 — History graph** ([`23-git-history-graph.png`](screenshots/23-git-history-graph.png)) | Virtualized multi-branch commit graph with lanes, merges, ref/HEAD badges, search across all history, and a ref filter. |
| **24 — Commit detail** ([`24-commit-detail.png`](screenshots/24-commit-detail.png)) | Inline split below the graph with a draggable, persisted seam: message, author, refs, changed files. |
| **25 — Commit file diff** ([`25-commit-file-diff.png`](screenshots/25-commit-file-diff.png)) | One file at one commit, opened as a preview tab. |

The **git band** (the strip above the terminal) is the entry point for all of it: active repo
picker (hidden for single-repo projects), branch/worktree/dirty indicator, then history, review,
and compare buttons. It renders over the terminal, review, and history docs — and disappears over
a file editor, which is worth questioning in a redesign.

### 4.6 Project knowledge — board and canvas

| | |
|---|---|
| **26 — Feature board** ([`26-feature-board.png`](screenshots/26-feature-board.png)) | Wish list → Planning → Building → Done, cards with notes, spec links, timestamps, and a pipeline config that maps column transitions to agent skills. Backed by `.conduit/board.json`. |
| **27 — Architecture canvas** ([`27-architecture-canvas.png`](screenshots/27-architecture-canvas.png)) | A Grasshopper-style typed node graph: components with **named typed ports**, port-to-port wiring, labelled edges, minimap, and programmatic auto-layout ("Tidy"). |
| **28 — Node inspector** ([`28-canvas-node-inspector.png`](screenshots/28-canvas-node-inspector.png)) | Name, subtitle, kind, icon, port list, drill-in, delete. |
| **29 — Interfaces panel** ([`29-canvas-interfaces-panel.png`](screenshots/29-canvas-interfaces-panel.png)) | Document-scoped named interfaces with typed, nested, recursive fields (`User { friends: List<User> }`). |
| **30 — Drill-down** ([`30-canvas-drilldown.png`](screenshots/30-canvas-drilldown.png)) | A component's nested canvas; the parent's ports appear as read-only boundary nodes so the child knows its contract. Breadcrumb + Escape to step up. |

The canvas is the flagship and also the biggest performance liability (see §7). Agent proposals
open **on the canvas as an editable draft** — added components ringed green, edited ones amber,
with Apply changes / Discard. Nothing is written until Apply.

### 4.7 Settings and theming

| | |
|---|---|
| **31 — General** ([`31-settings-general.png`](screenshots/31-settings-general.png)) | Sessions, Workspace, Notifications, Accessibility, Logging, Reset — grouped into titled sections with toggles, selects and segmented controls. |
| **32 — Appearance** ([`32-settings-appearance.png`](screenshots/32-settings-appearance.png)) | Theme swatches, typography, density, background mode + intensity, surface opacity/blur, editor surface colour, explorer icon pack, and a live session-card preview. |
| **33 — Shortcuts** ([`33-settings-shortcuts.png`](screenshots/33-settings-shortcuts.png)) | Every action rebindable, with conflict marking and a record-keys mode. |
| **34 — Skills** ([`34-settings-skills.png`](screenshots/34-settings-skills.png)) | Installs Conduit's bundled agent skills into `.claude/skills/` for this project or the user profile, so an agent learns the `.conduit/` artifact formats. |
| **35 — About** ([`35-settings-about.png`](screenshots/35-settings-about.png)) | Version, update control, runtimes, and a recent-log tail. |

**Themes** (36–40): [Paper (light)](screenshots/36-theme-paper-light.png) ·
[Nord](screenshots/37-theme-nord.png) · [Forest](screenshots/38-theme-forest.png) ·
[High contrast](screenshots/39-theme-high-contrast.png) · [Slate](screenshots/40-theme-slate.png).
Midnight (the default) is what every other screenshot shows.

---

## 5. The design system as it stands

**Colour.** Six themes, all driven by CSS custom properties on `:root[data-theme=…]` in one
`styles.css`. Token families: surfaces (`--bg`, `--panel`, `--panel-2`, `--raise`, `--border`),
text (`--text`, `--text-dim`, `--text-faint`), accent (`--accent`, `--accent-2`, `--accent-soft`,
`--on-accent`), status hues (`--green`, `--red`, `--amber`, `--blue`, `--violet`), a shared syntax
palette (`--syn-*`) used by Monaco, highlight.js and the review diff alike, and translucency
tokens (`--surface-alpha`, `--surface`, `--code-bg`, `--term-bg`). Mermaid and xterm derive their
palettes from the same variables at switch time.

**Type.** UI font Hanken Grotesk (also Inter / IBM Plex Sans / System UI); display font Bricolage
Grotesque for the wordmark; mono JetBrains Mono (also Fira Code / IBM Plex Mono). Interface size
composes a density base (13px comfortable / 11.5px compact) with a scale multiplier
(0.9 / 1 / 1.12 / 1.25). Terminal and editor font sizes are separate and independently zoomable.

**Density.** Two modes implemented purely through ~28 CSS variables — no conditional markup.

**Depth and material.** An animated backdrop (`none | aurora | mesh | grid | flow | shader`,
including a user-editable GLSL fragment shader) sits behind everything, and every chrome surface
is translucent over it with a configurable blur and opacity. The editor and terminal share one
configurable surface colour so they read as the same material. This is the app's most distinctive
visual idea and also the least resolved: at default settings it reads as flat near-black.

**Icons.** Three systems: ~40 hand-rolled inline SVGs for app chrome, Lucide for file types and
session glyphs (with a searchable icon picker), and per-language tints in the "colored" pack.

**Radii/spacing.** `--r: 9px`, `--r-sm: 6px`; the rest is ad-hoc padding inside the density tokens.
There is no documented spacing scale — a real gap if the revamp wants systematic rhythm.

---

## 6. Feature inventory (condensed)

**Sessions & terminals** — real PTY per session (xterm + node-pty, WebGL renderer); always-mounted
so switching never kills; shell auto-detection (PowerShell/pwsh/Git Bash/cmd/WSL); custom agents
declared in `agents.json`; grouping by project with drag-reorder; sort/filter (manual, name,
recent, active, status, project); configurable card fields; busy/attention/stale states; OS
taskbar flash + notification when a background session finishes; 256 KiB persisted scrollback
replayed on reopen; live `cwd` tracking that re-roots the file tree; per-surface zoom; terminal
find; drag a file into a terminal to insert its path.

**Terminal link intelligence** — absolute, relative, project-relative, bare-filename and
abbreviated paths become clickable when they name a real file (with a disambiguation dropdown);
printed commit SHAs are host-validated and open in Review; URLs open in the browser; links resolve
against *that terminal's* repo and session.

**Explorer** — lazy virtualized tree, gitignore dimming, git status decorations, multi-select,
full keyboard control incl. F2 and cut/copy/paste, create/rename/delete with path guards and
Windows reserved-name validation, drag & drop with spring-loading and a conflict dialog, OS
import, undo/redo, reveal-on-open, per-project expansion memory, live fs-watch refresh, find in
files.

**Editor** — Monaco read/write/save, ~70 languages, cross-file go-to-definition (custom
worker-backed action), breadcrumbs, VS Code preview tabs, tab + view-state persistence, per-session
tab scoping, middle-click and mouse back/forward, word wrap, git blame lens, open HTML in browser.

**Git & review** — Changes panel with staging; git band with branch/worktree/dirty/in-progress
indicators; in-place branch switching; multi-repo active-repo picker with auto-follow and pin;
commit history graph with search across all history; commit detail with a persisted seam; Review
Changes over working tree / a commit / a range; compare-any-two-refs dialog; diffstat + file
navigator + collapsible cards + word-level diff + syntax highlighting; bounded payloads with
explicit truncation banners.

**Project knowledge** — feature board, per-card specs, architecture canvas with typed ports and
interfaces, arbitrary-depth drill-down, grouping / encapsulate / explode, undo/redo, and the
propose→review→accept loop for both board and canvas.

**App** — multiple windows with live session hand-off and tear-out, session and window-layout
restore, quit guard, auto-update with a pinned sidebar card, Windows shell integration
("Open in Conduit" for folders, "Open with Conduit" for files), logging + one-click diagnostics
bundle, skills installer.

---

## 7. Where it hurts — the actual brief

Ranked by how much a redesign could help.

1. **The app reads as flat near-black.** Six themes and a whole translucency/backdrop system exist,
   but at defaults the workspace is a wall of dark grey with one warm accent. Hierarchy between
   panel, center, and raised surfaces is thin; the animated background is invisible at default
   intensity. Screenshots 02, 16, 23 show this best.
2. **Light mode is half-finished.** In Paper, the chrome goes light but the editor and terminal
   surfaces stay dark by design (`surfaceColor: 'auto'` was specced and **deferred as a product
   decision**), and body text loses contrast (36). This is the single biggest open theming
   question.
3. **Status is too quiet for a multi-agent app.** The premise is "four agents working at once",
   but busy/attention/stale live in a small glyph and a thin bar (02). There is no aggregate view
   of what's running, what finished, and what wants you.
4. **The empty state does nothing** (01) — no recent projects, no agents, no explanation of what
   the app is for.
5. **The review surface is the product's point and looks like a diff dump** (18/19). Diffstat,
   navigator, collapsible cards and word-diff are all there, but there's no sense of "here is what
   the agent did, in order, and here's what you still need to look at". No search-in-diff, no
   staging from Review, no comments — all explicitly deferred.
6. **The canvas is the flagship and the perf ceiling.** Unvirtualized: ~21 s freeze opening a
   500-node graph, ~42 s dragging a node. Any design that adds weight to node cards makes this
   worse; any design that reduces per-node DOM helps.
7. **Density and information architecture drift.** The git band, tab strip, breadcrumb bar and
   panel headers are four separate horizontal bands stacked above the content (11). On a 1600px
   window that's a lot of chrome before the first line of code.
8. **The three-way view switch hides two whole surfaces.** Board and Canvas are full-screen
   overlays behind an unlabelled icon triplet in the top-right (02); most users will never find
   them.
9. **A "Plan view" is documented but not implemented.** The bundled `conduit-plan` skill tells
   agents Conduit renders `.conduit/plan.json` as a commentable step outline with per-step
   approve / request-changes. No such view exists. It's a natural companion to the canvas proposal
   flow and a strong candidate for the revamp.
10. **Two legacy names leak.** The renderer↔host bridge global is `window.agentDeck` and the
    go-to-definition command is `agentdeck.goToDefinition`. Cosmetic, but they surface in code the
    design team may read.

---

## 8. Technical constraints worth knowing before designing

- **Electron, one main process owns everything.** Sessions, PTYs, git, fs, settings, watchers all
  live in main; the renderer subscribes to typed messages (`state`, `term:data`, `project`,
  `git:*`, `board`, `architecture`, …) and posts intents back. A window is a *view* onto a subset
  of global sessions — which is how a live session moves between windows without restarting.
- **Everything expensive is bounded.** Git runs through a single runner with per-class timeouts
  (metadata 2 s, history 5 s, diff 10 s), text files cap at 2 MB, images at 25 MB, PDFs at 50 MB,
  commit/range diffs at 1000 files. Truncation states are normal, not exceptional.
- **Persistence is atomic and flushed synchronously on quit** so the auto-updater's force-kill
  can't truncate state. `.conduit/*.json` files are versioned envelopes that degrade gracefully.
- **The renderer runs without a host.** With `window.agentDeck` absent it falls back to a mock
  shell — which means **the entire UI renders in a plain browser**:
  `npm run build && node tools/render-webview.mjs && node tools/preview-server.mjs 5174`
  → `http://127.0.0.1:5174/preview.html`. This is the fastest way for a designer to poke the real
  components without Electron.
- **Styling is one 9000-line `styles.css`** plus a highlight.js theme, entirely CSS-variable driven.
  There is no CSS framework, no component library, no design tokens file outside that stylesheet.
- **Icons** come from Lucide plus hand-rolled SVGs in `webview/icons.tsx`.

---

## 9. Appendix

### Default shortcuts

`Ctrl+P` quick open · `Ctrl+Shift+P` commands · `Alt+←/→` back/forward · `Ctrl+Shift+B` board ·
`Ctrl+Shift+A` canvas · `Ctrl+Shift+R` review · `Ctrl+Shift+F` find in files · `Ctrl+Shift+G`
history · `Ctrl+B` sidebar · `Ctrl+Shift+E` explorer · `Ctrl+N` new session · `Ctrl+Shift+N` new
window · `Ctrl+W` close tab · `Ctrl+Shift+T` reopen tab · `Ctrl+,` settings · `Ctrl+S` save ·
`Ctrl+Tab` / `Ctrl+PgUp/PgDn` cycle tabs · ``Ctrl+` `` focus terminal · `Ctrl+1…9` nth tab ·
`Ctrl+F` find (terminal / markdown / editor, whichever is focused) · `Alt+Z` word wrap.
All rebindable in Settings → Shortcuts.

### Key source locations

| What | Where |
|---|---|
| App shell, all menus, all shortcuts | `webview/app.tsx` |
| All styling and theme tokens | `webview/styles.css`, `webview/themes.ts` |
| UI components (≈52) | `webview/components/` |
| Host process, IPC switch | `electron/main.ts` |
| Message protocol (source of truth) | `src/protocol.ts` |
| Settings schema | `src/settings.ts` |
| Durable decisions | `docs/adr/` (0001 tooling, 0002 `.conduit` format, 0003 docs layout, 0004 secrets) |
| Feature specs (index first!) | `docs/specs/INDEX.md` |
| Roadmap / vision | `docs/plans/2026-06-23-north-star-roadmap.plan.md` |
| Release history | `CHANGELOG.md` |

### How these screenshots were made

The real built app was launched hidden (`CONDUIT_E2E=1`) via the repo's Playwright-Electron
harness (`test/e2e/harness.mjs`), pointed at a throwaway clone of this repo seeded with a dirty
worktree and `.conduit/{board,architecture}.json`, then driven surface by surface at 1600×1000.
Two caveats: a hidden window won't paint the WebGL/canvas backdrop convincingly, so the animated
background is under-represented; and theme switches only repaint fully after a renderer reload,
which is why the theme shots show the app just after restart.

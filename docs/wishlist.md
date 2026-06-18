# Conduit — Wishlist (inbox)

Raw, un-triaged ideas land here first. This is an **inbox, not a tracker** — it
holds things that haven't been built yet. Once an item is picked up it leaves
this file:

- **Promoted** → a spec in `docs/specs/` (see `docs/specs/INDEX.md`).
- **Shipped** → recorded in `docs/runs/<date>-<name>/report.md` with evidence + SHAs.
- **In a live build** → tracked in `.autoloop/tasks.yaml` (run state, gitignored).

So don't track status here — delete an item once it moves on. History of what
shipped lives in `docs/runs/`, not here.

## Captured

Goal lens: [[conduit-daily-driver-goal]] — make Conduit usable enough to live in.

- **T2 · Terminal scrollback persistence across restart.** The highest-value remaining
  "don't lose my work" durability gap, **deliberately deferred from T1B** (which shipped
  auto-relaunch + "relaunch all stale" + a restarted marker, but *not* history). Today
  `src/persistence.ts` restores a session's metadata only — the PTY and its **scrollback are
  lost**, so a relaunched session starts blank. Persist each session's terminal scrollback
  (bounded ring buffer) and restore it into xterm on reopen/relaunch so the prior history is
  visible. Decisions to make: where the buffer lives (userData, keyed by session id) and its
  size cap; whether restored history is visually marked as pre-restart; interaction with the
  opt-in auto-relaunch. Larger sub-project than a papercut — likely its own spec. Note: W1's
  `scrollback.e2e.mjs` smoke scenario is **already authored and skipped, waiting on this
  feature** to land. See [[conduit-daily-driver-goal]].

### Papercuts & bugs (2026-06-18 intake)

- **Outline scroll-spy mis-selects at the bottom of long docs.** In the markdown viewer's
  Outline panel, clicking the **last** entry of a long document (≈10+ sections) scrolls
  there but the **wrong** (higher-up) section stays highlighted as active. Cause is the
  scroll-spy active-section logic: when the last section is **shorter than the viewport**,
  it can't reach the top of the scroll area, so the "which heading is in view" pick lands
  on an earlier section that occupies more of the screen. The active item should follow the
  clicked/target section even when it's the short final one (e.g. snap active = last when
  scrolled to the bottom, or pick by nearest-to-top rather than largest-in-view). Repro
  doc: `G:/awby/projects/agentic-development/skills/architecture-critic/SKILL.md`. Code:
  `webview/md-toc.ts` (`pickActiveIndex`), `webview/components/markdown-toc.tsx`. (bug)

- **Quit confirmation auto-dismisses and closes sessions on its own.** Closing Conduit with
  running sessions shows the "you have sessions running" confirm popup, but if the user
  does **nothing** it closes itself automatically (and proceeds to close/quit) after a
  moment — defeating the entire point of the warning. The dialog must **wait for an explicit
  choice** and never auto-confirm/auto-close (no timeout, no default-accept on blur). Verify
  the quit path doesn't continue while the dialog is open. Code: `confirm-dialog.tsx` +
  the quit-guard wiring (see `quit-guard` e2e); cross-check [[playwright-cannot-drive-native-dialogs]].
  (bug)

- **Mermaid zoom toolbar should sit top-right, like the image viewer.** The fullscreen
  Mermaid zoom controls are currently **bottom-center** (`.mermaid-zoom__controls`), while
  the image viewer's zoom tools are **top-right**. Standardize: put the zoom toolbar at the
  **top-right everywhere** for consistency. Code: `webview/components/mermaid-zoom-overlay.tsx`,
  `webview/components/image-stage.tsx`, and the `.mermaid-zoom__controls` / `.imgstage__controls`
  rules in `styles.css`. (papercut)

- **Mermaid diagrams pixelate when zoomed in (e.g. 200%).** They're SVG and should stay
  crisp at any zoom, but zooming in the fullscreen overlay shows raster pixelation. Likely
  cause: `.mermaid-zoom__content` uses `will-change: transform` + a CSS `transform: scale()`,
  so the browser rasterizes the layer at its pre-zoom CSS size and bitmap-scales it. Fix so
  the SVG scales **vectorially** (e.g. scale the SVG's intrinsic width/height / viewBox
  mapping instead of a layer transform, or drop the layer-promoting `will-change` during
  zoom). Code: `webview/components/mermaid-zoom-overlay.tsx`, `.mermaid-zoom__content` in
  `styles.css`. (bug)

- **Editor-tab horizontal scrollbar is too thick and reflows the tabs.** When the tab strip
  overflows, the scrollbar takes layout height and **squishes the tabs**; closing a tab makes
  the scrollbar disappear and the tabs grow back. Tabs must stay a **constant size**
  regardless of overflow, and the scrollbar must be **ultra-thin and overlaid on top** of the
  tabs (not occupying layout). Code: the `.tabbar` / tab-strip rules in `styles.css`
  (overlay scrollbar, `scrollbar-width: thin` / `::-webkit-scrollbar` sizing, reserve no
  layout). (papercut)

### Needs a full feature-spec (UI-heavy)

- **Branch / worktree indicator + switcher at the top of a terminal tab.** Conduit has **no
  way to show where the user is** — current git branch, whether they're in a worktree, etc.
  Want a **clean, elegant** indicator, breadcrumb-style (like the editor-tab breadcrumbs) at
  the **top of the terminal tab**, surfacing branch + worktree, and ideally a **dropdown to
  switch branch / worktree** in place. **→ run `feature-spec` on this** (full behavior:
  states, when/how it refreshes vs the live-cwd seam, switch semantics & safety with a
  running PTY, multi-root/worktree discovery, empty/detached-HEAD states), and use the
  **frontend-design** skill for the UI. Relates to the E1–E3 live-cwd/breadcrumbs work
  already shipped (`docs/runs/2026-06-16-daily-driver-2/`). See [[conduit-daily-driver-goal]].

## Spec-ready (promoted → see `docs/specs/INDEX.md`)

- **Agent-agnostic chat UI over CLI agents** → `docs/specs/2026-06-17-agent-chat-ui.md`.
  A clean, elegant **chat surface** that drives Claude Code / Codex under the hood (no raw
  terminal) and renders structured turns: assistant markdown, collapsible thinking, rich
  tool-call cards (edits-as-diffs, clickable file paths), **inline tool approvals**, a
  **running-mode selector incl. Auto** (server-side safety classifier), and a skills /
  slash-command picker. Agent-agnostic via a normalized event model behind a `ChatAdapter`
  interface. **v1 builds the Claude Code adapter** (Agent SDK streaming session — needed for
  `canUseTool` + mid-session mode change + `--resume`, and to dodge the one-shot `-p` Auto
  abort) **+ a `FakeAdapter`** for offline smoke tests; **Codex adapter and interactive
  option-buttons are designed, not built**. Transcript + CLI session id persisted →
  **resume on reopen**. Reuses the W4 markdown/mermaid viewer, the D11 path-link seam, and the
  busy/attention seams. See [[conduit-daily-driver-goal]].

- **Skill installer** → `docs/specs/2026-06-17-skill-installer.md`. Conduit ships
  **bundled skills** and installs one into the **project** (`.claude/skills/`) or **user**
  (`~/.claude/skills/`) Claude Code skills dir from the UI, with installed / outdated /
  locally-modified **detection** + update (atomic, path-guarded copy). Claude Code targets in
  v1; Codex layout designed. The general delivery mechanism whose first consumer is the
  plan-authoring skill below. Pairs with the chat-UI skills picker.

- **Interactive plans** → `docs/specs/2026-06-17-interactive-plans.md`. An agent authors a
  structured `.conduit/plan.json` (multi-step, nested substeps, per-step status, markdown
  bodies) rendered as an **interactive, commentable plan view** (center pane, sibling to the
  board/architecture canvas) instead of a wall of markdown. The user comments **anchored to a
  specific step/substep/text-span**, sets per-step Approve / Request-changes, and that feedback
  **persists to disk** (`.conduit/plan.comments.json`) so the **agent reads it next turn** and
  revises (structural rewrites via the existing `plan.proposed.json` proposal-diff flow). Reuses
  the `.conduit/` artifact + watcher + proposal infra (ADR 0002); realizes the `plan_update`
  seam reserved in the chat-UI spec; ships the `conduit-plan` skill the installer above
  delivers. See [[conduit-daily-driver-goal]].

---

_Shipped batches (history in `docs/runs/`): round-6/7 (2026-06-15); round-8; **round-9**
daily-driver `D1–D10` + Tier-1 `T1A`/`T1B` (`docs/runs/2026-06-16-daily-driver/`, 8 done + 4
committed-needs-human-smoke); **daily-driver-2** `E1–E3` live-cwd + breadcrumbs
(`docs/runs/2026-06-16-daily-driver-2/`). Open human-smoke recipes for the round-9
`needs-human-smoke` items (D2/T1A/T1B/D5) live in `.autoloop/blockers.md` — and are exactly
what W1 automates. **2026-06-17-night** (`docs/runs/2026-06-17-night/`): macOS test build +
installer branding + image-viewer zoom/diffs (shipped in **v0.1.13**); D11 was found already
shipped. Deferred from r7: "rename Conduit→Claude Code" (keystroke-injection
footgun) and the CLI-/rename ambient-title tradeoff._

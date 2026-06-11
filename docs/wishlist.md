# Conduit — Wishlist

A running intake of feature ideas, small enhancements, and bug fixes. Raw ideas
land here first; the good ones get expanded into full features and an autonomous
implementation plan, then built and verified one at a time.

## How an item moves through here

The main thread is **pure orchestration** — it captures ideas, relays results,
gets your decisions, and dispatches the next agent. Every substantive step runs
**inside a subagent** so the main context never fills with research or build churn.

1. **Captured** — your raw idea, in your words. _(main thread)_
2. **Expanded** — a subagent turns a worthy idea into a real feature: scope, UX,
   edge cases. Returns the write-up.
3. **Planned** — a subagent produces an autonomous implementation plan (files,
   steps, tests, verify). Returns the plan.
4. **In progress** — a subagent builds it on a branch; verifies with `npm run
   verify` and, where it's UI, exercises + screenshots via Playwright.
5. **Done** — merged.

Weak ideas are marked **Parked** with a one-line reason instead of built.

Items that aren't worth building get marked **Parked** with a one-line reason.

---

## Backlog

| # | Idea | Type | Status | Notes |
|---|------|------|--------|-------|
| A1 | Top-bar view switcher (replace stacked overlays) | Bug / UX | Captured | Group A — Navigation |
| A2 | Markdown viewer doesn't reflow when sidebar collapses | Bug | Captured | Group A — Navigation |
| A3 | Collapse/hide Explorer; context menu + command to toggle panels | Feature | Captured | Group A — Navigation |
| B1 | Remove explicit drag handles; drag from the bar/tabs themselves | UX | Captured | Group B — Panel drag |
| C1 | Code-editor inner padding shows through to background | Bug | Captured | Group C — Editor theming |
| C2 | Code-editor background too dark / inconsistent w/ Markdown preview | Bug / UX | Captured | Group C — Editor theming |
| C3 | Full 0–100% panel transparency + granular code-block styling | Feature | Captured | Group C — Editor theming |
| C4 | Terminal still inset within its container — make it flush too | Bug | Captured | Group C — Editor theming |
| D1 | Sort/filter via elegant three-dot dropdown menu | UX | Captured | Group D — Sessions panel |
| D2 | Reorder whole project groups (not just tabs within) | UX | Captured | Group D — Sessions panel |
| D3 | Better session naming + richer metadata (last-updated) | Feature | Captured | Group D — Sessions panel |
| D4 | Show runtime logo/icon in session tab (Claude/bash/etc.) | Feature | Captured | Group D — Sessions panel |
| D5 | Busy/attention indicator on tabs; done bubbles to top | Feature | Captured | Group D — Sessions panel |
| E1 | Go-to-definition slow on first use; prefer native | Bug / Perf | Captured | Group E — Code editor |
| E2 | Word-wrap toggle (Alt+Z) in the code editor | Feature | Captured | Group E — Code editor |
| E3 | Editor tabs overflow/overlap the explorer; must be contained | Bug | Captured | Group E — Code editor |
| E4 | In-editor link opens full-screen browser with no way back | Bug | Captured | Group E — Code editor |
| E5 | Context menu: restyle to match app + add essential actions | UX | Captured | Group E — Code editor |
| F0 | Architecture canvas as repo-persisted, LLM-readable design surface | Feature (north star) | Captured | Group F — Architecture canvas |
| F1 | Canvas context menu (node + blank), app-styled | UX | Captured | Group F — Architecture canvas |
| F2 | Minimap doesn't render nodes / current viewport | Bug | Captured | Group F — Architecture canvas |
| F3 | User-editable edge labels (add text on connecting lines) | Feature | Captured | Group F — Architecture canvas |
| F4 | Better architectural node kinds + per-kind icons | Feature | Captured | Group F — Architecture canvas |
| G0 | Agentic feature board — repo-persisted, agent-updated, Jira/Linear-grade | Feature (north star) | Captured | Group G — Feature board |
| G1 | Board context menu (app-styled) with relevant actions | UX | Captured | Group G — Feature board |
| G2 | Duplicate / copy board items | Feature | Captured | Group G — Feature board |
| G3 | Items reference/save Markdown specs under .conduit/specs | Feature | Captured | Group G — Feature board |
| G4 | Per-phase skill selection on column transitions | Feature | Captured | Group G — Feature board |
| G5 | Created + last-updated dates on items | Feature | Captured | Group G — Feature board |

---

## Captured items (cleaned up)

### Group A — Navigation & view management

**A1. Top-bar view switcher — replace stacked overlays with a single active view.**
Today the Feature Board (Kanban) and the Architecture Canvas each open as a window
that overlays the code editor — and they **stack on top of each other**. Opening the
canvas, then the board, means closing twice (two X buttons) to get back to the editor.

Desired behavior: a row of view buttons at the top — e.g. **Editor · Feature Board ·
Architecture Canvas**. Clicking one **switches** the center view to it (fully replacing
whatever was there, never stacking), and that button stays **active/highlighted**. You
return to code by clicking the **Editor** button. No per-view X/close button needed.
Effectively: mutually-exclusive tabbed views for the center pane, not pop-over windows.

**A2. Markdown viewer doesn't reflow when the sidebar collapses.**
Collapsing the sidebar (top-left button) widens the **code editor** correctly, but the
**Markdown preview/viewer** keeps its original width — it doesn't expand into the freed
space. Preferred fix: make the Markdown viewer **full width** like the editor. If it must
stay a fixed width, then at least **center** it rather than leaving it pinned left.

**A3. Collapse/hide the Explorer; toggle hidden panels via context menu + command.**
Add the ability to **collapse or hide the Explorer** panel (as the sidebar already can).
Once panels can be hidden, provide ways to bring them back:
- **Right-click** anywhere on the Explorer or the top menu opens a context menu with
  options to **show/hide** individual panels (enable/disable what's hidden).
- Equivalent entries in the **command palette** — "Hide/Show Explorer", "Collapse/Expand
  Sidebar", etc.
(Context menu shares the design system with [E5]/[F1]/[G1]; commands live in the existing
command palette. Related to the overall layout/visibility model alongside [A1]/[A2].)

### Group B — Panel drag UX

**B1. Drag panels without the explicit handle affordance.**
The Explorer/Sessions panel and the code-editor panel are rearrangeable (drag-and-drop),
which is good — but the explicit handles are ugly: the "drag to move the sessions panel"
strip and the grab-hand cursor symbol. Keep the **functionality**, drop the visible
handle. You should be able to grab the **sessions bar itself** anywhere to move it, and
likewise grab a **tab inside the code editor** (or the whole tab bar) to move that panel —
no dedicated handle widget, no permanent grab-hand icon.

### Group C — Editor & panel theming / transparency

**C1. Code-editor inner padding leaks the background.**
When a code file opens, there's a band of padding around the editor where the dark/
transparent panel background shows through inside the area that should be the editor.
The editor surface should fill its container — no gap.

**C4. Terminal is still inset within its container.**
The C1 fix made the code editor fill its tab, but it *preserved* the terminal's padding
(moved it onto the terminal-only `.termstack`). The terminal should fill its container
too — remove that inset/margin so the terminal sits flush to the edges like the editor,
not floating inside a padded band. (Verify xterm's fit/resize stays correct afterward.)

**C2. Code-editor background is too dark and inconsistent with Markdown preview.**
The Monaco code-editor background is much darker than the Markdown **preview/view mode**,
which renders lighter. The two should be **consistent**, and — better — the background
should be **user-controllable** rather than a hardcoded dark value.

**C3. Full-range transparency + granular code-block styling control.**
Panel transparency currently ranges only **40–100%**; it should span the **full 0–100%**.
On top of that, add more **granular control over code-block styling** in Settings — e.g.
set a code block's background color and its own transparency (black, or darker/lighter
with high transparency), independent of the panel.

> All of this must be done elegantly and integrated cleanly — not bolted on.

### Group D — Sessions panel

**D1. Elegant sort/filter via a three-dot menu.**
The current sort/filter controls could be more refined. Replace them with a **three-dot
(overflow) menu button** on the sessions panel that opens a clean dropdown where you pick
the filter and the sort order. One tidy affordance instead of inline controls.

**D2. Reorder whole project groups, not just session tabs.**
Drag-to-reorder currently only works on session tabs in a **flat list** — not when the
sessions are **grouped by project**. You should be able to drag an entire **project group**
up or down to reorder projects (A above/below B), and all the session tabs inside that
project move **together** as a unit. (Shares the drag system with [B1].)

**D3. Better session naming + richer metadata.**
New sessions auto-name as "terminal type + repo/folder" (e.g. the shell name + the repo),
which doesn't read well. Lead with the **repository/folder name** and produce a cleaner
default. Also expand the metadata a session carries — surfaced both on the **tab** and as
**sort keys** — notably a **last-updated / last-active** timestamp, not just created-at.
(Feeds [D1] sorting and [D5] ordering.)

**D4. Show the runtime's logo/icon in the session tab.**
A session tab should show an icon for **what's running** in it — e.g. the Claude logo when
Claude is running, vs. a bash / PowerShell / generic-terminal icon otherwise — so at a
glance you can tell "this one's Claude, that one's a plain shell." Detect the active
program in the PTY and map it to a glyph.

**D5. Busy / needs-attention indicator; finished sessions bubble up.**
When a session is **actively computing/running a task**, show that state on its tab (e.g. a
spinner/activity dot). When a long task **finishes and needs your attention**, surface it —
e.g. the session **rises to the top** / gets a highlight — so while juggling several
sessions you can see which one just became idle and wants input. (Interacts with [D1]/[D3]
sort and [D2] ordering.)

> Cross-cutting note: [B1], [D1], [D2], [D3], [D5] all touch the sessions-panel
> subsystem (drag manager, sort/filter, session model). Likely planned as a coherent
> sessions-panel overhaul rather than five disconnected patches.

### Group E — Code editor

**E1. Go-to-definition is slow on first use; prefer the editor's native path.**
Opening a fresh repo, the first go-to-definition (e.g. from a component usage in
`page.tsx` to its definition) takes **5–10s** to open the new tab and navigate; later
ones are faster. The ask: stop hand-rolling this — use **Monaco's natural
go-to-definition** instead of a custom solution.
> ⚠️ **Known constraint (CLAUDE.md):** go-to-definition is *deliberately* a custom
> worker-backed action (`agentdeck.goToDefinition` in `webview/components/code-viewer.tsx`)
> because **esbuild doesn't reliably bundle Monaco's built-in goto**; `ts.worker.js` is
> bundled separately (`webview/monaco-setup.ts`). So "just switch to native" isn't a flip
> of a flag — the real task is **making the native TS language service / worker path
> bundle and warm up reliably**, then dropping the hand-rolled action. The 5–10s is likely
> the TS worker cold-starting and indexing on first use; warming the worker (or showing a
> proper loading state) is part of the fix. Expansion must solve the bundling, not just
> re-enable the built-in and have it silently break.

**E2. Word-wrap toggle (Alt+Z).**
Long lines in the code editor produce a horizontal scrollbar; the Markdown **preview**
wraps but the editor doesn't. Add **word wrap**, toggled by the standard **Alt+Z**
shortcut (and ideally a setting/command), matching standard editors.

**E3. Editor tabs overflow and overlap the explorer.**
With many tabs open, the editor tab strip spills out of its container and overlaps the
Explorer panel (renders over/under it). Tabs must be **clipped to their container** and
handle overflow properly (scroll / overflow menu), never escaping the editor pane.

**E4. In-editor links open a full-screen browser with no escape.**
Clicking a link inside the code editor opens a browser view in **full screen** with no
back button or controls — you get stuck with no way back to where you were. It should
open in a **new tab** (or provide browser nav / a way out) so following a link is
non-destructive.

**E5. Context-menu overhaul — match app design + add essential actions.**
The code editor's right-click context menu is **styled differently** from the context
menus elsewhere in the app; restyle it to match the shared design/vibe. It's also too
**slim** — add the crucial/essential actions (the expansion will enumerate: cut/copy/
paste, go-to-definition, find references, rename, format, command palette, etc.).

> Cross-cutting note: [E1], [E2], [E5] are Monaco editor configuration/wiring;
> [E3] is the editor **tab bar**, which also relates to [B1] (drag) and [A1] (top-bar
> views). The tab-bar work (A1/B1/E3) likely shares a planning pass.

### Group F — Architecture canvas

> **The top toolbar of the canvas is fine — leave it.**

**F0. North star — a repo-persisted, LLM-readable architecture surface.**
The canvas today looks okay but isn't fully developed. Its real purpose: give a
**high-level view of the app being built**. The diagram should be **saved in the repo**
(e.g. under a **`.conduit/`** folder) in a format — JSON / Markdown / similar — that can
both **render the diagram** *and* be **understood by an LLM**.

The workflow we're aiming at:
- An LLM **reads the codebase and proposes** a high-level architecture diagram.
- The user **edits** it directly — "this part of the frontend needs these layers," "the
  backend has these components," "this is the database, and X points to it."
- Going forward, when an agent starts building something, instead of handing over a long
  Markdown doc it produces/updates **this diagram**, and the user makes decisions and
  changes from it.

So the canvas becomes the shared, editable, version-controlled **source of architectural
truth** between human and agent — not just a drawing toy. (This reframes the whole group:
the bug fixes below serve this goal.)
> Design implications to resolve during expansion: the persisted format & schema; where it
> lives (`.conduit/` committed to the repo, like `board.json`); round-tripping between the
> visual canvas and the file; how an agent reads/writes it; and how it stays in sync with
> reality. Big — almost certainly its own multi-step plan.

**F1. Canvas context menu — on nodes and on blank canvas, app-styled.**
Right-clicking a component (or anywhere on the canvas) should open a context menu, styled
to match the app's shared menus. (Shares the menu design system with [E5].)

**F2. Minimap doesn't show canvas contents or position.**
The bottom-right minimap doesn't render the items on the canvas, and when you navigate
away it doesn't show where you are — so it's not serving its purpose. Make it reflect the
real node layout + current viewport (or reconsider it).

**F3. User-editable edge labels.**
The current version puts text on some connecting lines, but the user can't **add their
own** text to an edge. Allow adding/editing a label on any connection.

**F4. Better architectural node kinds + per-kind icons.**
The existing kinds (service, logic, UI, view, data, store, external, group, layer) don't
really map onto how you'd express a software architecture. **First** design a better,
genuinely architectural set of kinds; **then** give each a distinct **icon shown on the
node** so the diagram is readable at a glance.
> Future / explicitly *not now* (parked sub-ideas): link each component to its spec docs /
> feature plans / code locations; and possibly a **deterministic tool that generates the
> diagram from the repository**. Noted for the roadmap, not this pass.

> Cross-cutting note: [F1] shares the context-menu design system with [E5]; the whole of
> Group F is a **view** reachable from the [A1] top-bar switcher.

### Group G — Feature board (Kanban)

**G0. North star — an agentic feature board.**
Today the board is backed by `board.json` at the repo root. Like the architecture canvas
[F0], it should move under **`.conduit/`** in the corresponding repo. Its purpose: **track
wishlist items and update them in real time as the agent works** (or as the user asks the
agent to work on them). The same items tracked in the Markdown wishlist flow into this
board; the agent advances them through phases — **Wishlist → Planning → Building → Done** —
and the board moves live, so the user gets a real-time view of what's being worked on and
what needs attention.

Expand this **a lot** — it should become a full-fledged feature-tracking system in the
spirit of **Jira / Linear**, adapted to an **agentic** workflow. Research existing
"agentic feature board" prior art during expansion.
> This is the operational twin of `docs/wishlist.md`: the wishlist process we just defined,
> turned into a live board the agent drives. Plan G0 **together with [F0]** — both define
> the `.conduit/` committed-artifact strategy (board + architecture + specs all live there).

Sub-features called out:

**G1. Board context menu — app-styled, with relevant actions.**
Right-click on the board / on a card opens a context menu matching the app's shared menus.
(Shares the menu design system with [E5] and [F1].)

**G2. Duplicate / copy items.**
Be able to duplicate or copy a wishlist/board item.

**G3. Items reference and store Markdown specs.**
A board item can reference Markdown documents in the repo, and those specs can be saved
under **`.conduit/specs/`** (or similar). Ties the card to its spec/plan docs. (Connects to
the `feature-spec` skill output and to [F0]'s doc-linking idea.)

**G4. Per-phase skill selection on transitions.**
Configure which **skill** runs on each column transition — e.g. *Wishlist → Planning* uses
one skill, *Planning → Building* dispatches subagents / uses another. The board encodes the
pipeline, not just the status.

**G5. Created + last-updated timestamps on items.**
Each item carries a created-at and a last-updated date. (Same metadata theme as [D3].)

> Cross-cutting note: Group G is a **view** behind the [A1] switcher; [G1] shares the
> context-menu system with [E5]/[F1]; [G0] shares the `.conduit/` persistence strategy with
> [F0]; [G3] consumes `feature-spec` output; [G5] mirrors [D3]'s timestamp work. G0 is one
> of the two most ambitious items on the list (with F0).

---

## Roadmap & sequencing (rough, pre-expansion)

Principle: **within a subsystem (same files) → sequential; across subsystems → parallel
subagents.** Sizes are rough estimates (S/M/L/XL), not from a codebase audit.

### Foundations first (3 mutually-independent → parallelizable)
- **Shared context-menu component** (extract from existing app menus) — M — unblocks E5, F1, G1.
- **A1 center-pane view model** (overlays → tabbed mutually-exclusive views) — L — unblocks
  F0/G0 UI mounting; also fixes the stacking bug.
- **F0+G0 `.conduit/` ADR** (schema, ownership, round-trip; design only) — M — unblocks F0, G0, G3.

### Wave 1 — Quick wins (parallel across subsystems, sequential within)
- Editor: C1 (S) → C2 (S) → E2 (S) → E4 (M) → E3 (S/M)
- Layout: A2 (S, Markdown reflow on sidebar collapse)
- Canvas: F2 (S) → F3 (S/M)

### Wave 2 — Two big tracks in parallel (each internally sequential)
- **Sessions (B+D):** D3 (M, first — feeds rest) → B1 (M) → D1 (M, uses menu cmp) → D2 (M)
  → D4 (L) → D5 (L). *D4/D5 last & together — PTY process/state detection, riskiest non-north-star.*
- **Editor finish + menus (C+E):** C3 (M) → E5 (M, first menu consumer) → E1 (L, isolate —
  esbuild/worker bundling is the riskiest single item; do alone, last).
- **Canvas consumers** slot in: F1 (S/M, after menu cmp) → F4 (M).
- **Layout:** A3 (M — collapse/hide Explorer + panel-toggle context menu & commands; needs
  the menu component + command palette).

### Wave 3 — North stars (after ADR + A1)
- Build shared **`.conduit/` persistence layer** first (common dependency).
- Then **F0** (canvas persistence) ∥ **G0** (board → `.conduit`, live phases) — parallel.
- Board sub-features: G1 (S/M) · G2 (S) · G3 (M) · G5 (S) — mostly parallel — then **G4** (L,
  skill-on-transition, most agentic) last, needs G0 solid.

**Critical path:** `.conduit ADR → persistence layer → G0 → G4`. A1 is the other early must-do.

**Risk to isolate:** E1 (bundling) · D4/D5 (PTY detection) · F0/G0/G4 (new persistent subsystem).

---

## Expanded features

_Detailed write-ups land here as items graduate from the backlog (one subagent per item)._

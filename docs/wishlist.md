# Conduit — Wishlist

A running intake of feature ideas, small enhancements, and bug fixes. Raw ideas
land here first; the good ones get expanded into full features and an autonomous
implementation plan, then built and verified one at a time.

> **Round 1 (groups A–G, 31 items) shipped** on 2026-06-11 — 26 merged to `main`,
> 5 north-star items on `autoloop/conduit-northstar` (held for review). See
> `docs/builds/2026-06-11-run-report.md`. This file now tracks **round 2**.

## How an item moves through here

The main thread is **pure orchestration** — it captures ideas, relays results,
gets your decisions, and dispatches the next agent. Every substantive step runs
**inside a subagent** so the main context never fills with research or build churn.

1. **Captured** — your raw idea, in your words. _(main thread)_
2. **Expanded** — a subagent turns a worthy idea into a real feature: scope, UX,
   edge cases. Returns the write-up.
3. **Planned** — a subagent produces an autonomous implementation plan (files,
   steps, tests, verify). Returns the plan. _(FULL items only)_
4. **In progress** — a subagent builds it on a branch; verifies with `npm run
   verify` and, where it's UI, exercises + screenshots via Playwright.
5. **Done** — merged.

Weak ideas are marked **Parked** with a one-line reason instead of built.

---

## Backlog (round 2)

| # | Idea | Type | Status | Notes |
|---|------|------|--------|-------|
| H1 | Group Appearance settings into sections (background / theme / …) | UX | Captured | Group H — Settings |
| H2 | Live preview "proof" boxes for background, intensity, opacity, blur | Feature | Captured | Group H — Settings |
| I1 | Terminal background color control, unified with code-block color | Feature | Captured | Group I — Surfaces |
| I2 | Editable code editor (currently read-only) | Feature | Captured | Group I — Surfaces |
| J1 | Remove text labels from top-bar view switcher (icons only) | UX | Captured | Group J — Polish & bugs |
| J2 | Context menus must open at the cursor / trigger, not offset | Bug | Captured | Group J — Polish & bugs |
| J3 | Closing all sessions → black/empty page instead of start state | Bug | Captured | Group J — Polish & bugs |
| J4 | "Close all sessions" / "Close others" actions | Feature | Captured | Group J — Polish & bugs |
| J5 | Explorer file tree doesn't refresh when new files appear on disk | Bug | Captured | Group J — Polish & bugs |

---

## Captured items (cleaned up)

### Group H — Settings & Appearance

**H1. Group the Appearance settings into logical sections.**
In Settings → Appearance, every control currently sits in its own little section,
which doesn't read well. Related controls should be **grouped under shared section
headings** — everything **background**-related together (background, intensity,
surface opacity, blur), everything **theme**-related together, and so on. Fewer,
meaningful sections instead of one-control-per-section sprawl.

**H2. Live preview "proof" boxes for the appearance controls.**
The session-card customizer has a **live preview** so you can see what you're
editing — the appearance controls should behave the same way. For each of:
- **Background**
- **Background intensity**
- **Surface opacity**
- **Background blur**

…show a small **preview/proof box** (e.g. a little box with something behind it)
that updates live as you drag the control, so you can see how much the blur softens
it, how the opacity reveals the layer behind, how the color shifts — instead of
adjusting blind. (Mirrors the session-card preview pattern; pairs with [H1]'s
sectioning.)

### Group I — Terminal & code surface

**I1. Terminal background color control, unified with the code-block color.**
The code block already has a **background color** and **opacity** control (from
round-1 [C3]). The **terminal** has nothing — you can't control its color at all.
Add that control for the terminal **and unify it**: the code-block color and the
terminal color should be **the same setting** — one color drives both surfaces so
they always match. (Lives in the same Appearance settings area as [H1]/[H2].)

**I2. Make the code editor editable.**
The Monaco code editor is currently **read-only** — but this is a code editor, so
it should let you **edit the code**. Turn on editing, and wire **save** so edits
persist back to the file on disk (e.g. Ctrl+S through the host bridge), with a
dirty/unsaved indicator. Must degrade safely when the host bridge is absent (the
browser-preview fake shell can't write files).
> Decision taken autonomously (per the build-loop's "queue & keep going"): editing
> is **real** — Ctrl+S writes through to the actual file via a host write API
> (added to preload/main if missing), guarded when `window.agentDeck` is undefined.
> This is the one FULL-tier item this round (spans renderer ↔ host ↔ FS).

### Group J — UI polish & bug fixes

**J1. Drop the text labels on the top-bar view switcher.**
Round-1 [A1] added a top-bar switcher, but the buttons now carry text — "Editor",
"Feature Board", "Architecture Canvas". Remove the text; leave just the **icons**
to click between views. (Keep the active/highlight state and tooltips; only the
inline label text goes.)

**J2. Context menus must open exactly at the cursor / their trigger.**
Right-clicking in some places opens the context menu **away from the mouse** instead
of at the pointer:
- **Code editor** right-click → menu appears offset, not under the cursor.
- The **three-dot menu** next to *Filter Sessions* → menu opens in the **middle of
  the sessions panel** instead of anchored to the three-dot button.

Menus must anchor to the **exact event position** (or the triggering button), then
clamp to stay on-screen — never appear in an unrelated spot. (Touches the shared
menu positioning from round-1 `menu-system` / `src/menu-position.ts` and the
`sort-filter-menu` anchor.)

**J3. Closing every session drops into a black/empty page.**
When you **close all sessions** you land on a weird empty/black screen instead of
returning to the app's **initial start state** (the same view you get when the app
first launches with no sessions). Closing the last session should fall back to that
initial/empty-state UI cleanly.

**J4. "Close all sessions" and "Close others" actions.**
Add the ability to close sessions in bulk:
- **Close all sessions**
- **Close others** (close every session except the one acted on)

Surface them where it's natural — the **session tab's context menu**, the sessions
panel's **three-dot menu**, and/or right-clicking the sessions panel. (Builds on the
session context menu; pairs with [J3] so bulk-closing lands on the clean start
state, not the black screen.)

**J5. Explorer file tree doesn't refresh when new files are written to disk.**
When something writes new files to the repo while the app is open — e.g. switching
to the Feature Board or Architecture Canvas and back (those views persist files), or
any external/agent write — the **Explorer file tree doesn't show the new files**. They
only appear after you **toggle between the Files and Changes tabs** and back, which
forces a re-read. The tree should pick up new/removed files on its own: refresh when
the editor view regains focus / is switched back to, and ideally watch the workspace
so external changes appear live, without the manual tab-toggle workaround.
> Note: the `.conduit/`-writing board/canvas that triggers this lives on the
> `autoloop/conduit-northstar` branch, not `main`. On `main` the bug still reproduces
> with any new file on disk (terminal output, agent edit), so the fix is the general
> **file-tree-doesn't-refresh** problem — minimum: refresh on view-return; better: a
> workspace watcher.

---

## Roadmap & sequencing (rough, pre-expansion)

Principle: **within a subsystem (same files) → sequential; across subsystems →
independent.** Same-tree parallelism stays off (Windows + node-pty + one worktree),
so the run is serial; ordering is by value/risk — quick wins first, the one FULL
item last.

1. **J1** — remove switcher label text (trivial; `top-bar.tsx`).
2. **J2** — context-menu positioning bug (high-annoyance; `menu-position.ts`,
   `context-menu.tsx`, `sort-filter-menu`).
3. **J3** — close-all → start-state fallback (bug; session manager + `app.tsx`).
4. **J4** — Close all / Close others (feature; after [J3], shares close logic + menu).
5. **J5** — Explorer file-tree refresh on new files (bug; file-tree component + view-focus).
6. **H1** — Appearance settings sectioning (settings UI).
7. **H2** — live preview boxes (settings UI; after [H1], same files).
8. **I1** — terminal color unified with code-block color (settings + terminal +
   code-block styling; after [H2], same settings area).
9. **I2** — editable code editor (**FULL**; renderer ↔ host ↔ FS; last & isolated).

**Same-file clusters (must stay sequential):** settings UI = H1 → H2 → I1;
sessions = J3 → J4.
**Risk to isolate:** I2 (writes to real files on disk; new host write API).

---

## Expanded features

_Detailed write-ups land here as items graduate from the backlog (one subagent per item)._

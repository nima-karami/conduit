---
status: active
date: 2026-06-16
---

# Sidebar grouping — collapse + universal drag-and-drop

## Problem

The sessions sidebar groups sessions by project, but two daily-driver gaps remain:

1. **No way to collapse a project group.** With several projects open, the list gets
   long and there's no disclosure control to fold a project's session tabs away.
2. **Drag-and-drop is hard-gated to manual sort.** `canDrag = sort === 'manual' &&
   filter.trim() === ''` (`webview/components/sidebar.tsx:337`), so the moment you pick
   any sort (Name, Recently active, Status, …) you lose the ability to drag session
   tabs *or* projects into the arrangement you want. You have to first switch sort to
   "Manual" by hand, then drag.

What already exists and is reused as-is:
- **Card reorder** within a group (`moveBefore`, `onReorderSessions` →
  `reorderSessions` host message; order is the flat session-id order in
  `SessionManager`).
- **Project/group reorder** by dragging a project header (`reorderByGroup`, archived
  spec `group-reorder`) — but also gated to manual+unfiltered.
- **Sort/group menu** (`sort-filter-menu`): sorts Manual, Name (A–Z), Recently created,
  Recently active, Status, Project; plus `Group by project`. Settings `sessionSort`,
  `sessionGroupByProject`.

## Goal

Two cohesive changes to the sessions sidebar:

- **(A)** A per-project **collapse/expand** disclosure, persisted across reload.
- **(B/C)** Make **drag-and-drop always available** (in every sort mode), and when a
  drop produces an order that **violates the active sort**, **auto-switch sort to
  Manual** committing the on-screen order plus the move. This covers both session-card
  drag and whole-project (header) drag through one shared path.

All in `webview/components/sidebar.tsx` + the settings store + small pure helpers
(siblings to `moveBefore` / `reorderByGroup`). One implementation plan.

## (A) Collapse / expand per project

### Behavior

- A **disclosure chevron** renders at the left of each `.proj__label` project header
  (▾ expanded / ▸ collapsed). It is a real `<button>` (Enter/Space toggle), with
  `aria-expanded` reflecting state and an accessible name (e.g. `Collapse <project>`).
- Clicking the chevron toggles the group's collapsed state. **Collapsed** hides that
  group's session `.session` cards; the header remains.
- A chevron click must **not** start a drag (the chevron is a separate hit target from
  the draggable header grab-surface).
- Collapse is only meaningful when **grouped** (`sessionGroupByProject` true). In flat
  mode there are no headers, so collapse is inert (no chevrons rendered).

### Collapsed header content

- A **session count** for the group (e.g. `3`).
- An **attention rollup**: if any *hidden* session in the group is busy / needs
  attention (per the existing busy/needs-attention machine consumed by the session
  glyph), the collapsed header carries that state (dot/pulse) so a folded group still
  signals it needs you. Reuse the existing status-state styling; no new attention logic.

### Persistence

- New settings-store field **`collapsedProjects: string[]`** (project paths), alongside
  `sessionSort` / `sessionGroupByProject` (same persistence path as those). Toggling a group
  adds/removes its path. Restored on load so collapsed state survives reload/restart.
- A project path present in `collapsedProjects` but no longer open is harmless (ignored
  on render); optional prune on session-list change is a nicety, not required.

## (B/C) Universal drag with auto-switch-to-manual

### Gate change

- `canDrag` drops the `sort === 'manual'` condition: drag is **enabled in every sort
  mode**. It remains **disabled while a text filter is active** (`filter.trim() !== ''`)
  — reordering a partial/filtered subset is ambiguous (user decision). This applies to
  **both** session-card drag (`.session`) and project-header drag (`.proj__label`).

### Commit logic (the heart of the feature)

On drop, build the candidate new flat session-id order from the **currently rendered
(sorted) order** with the move applied:

- **Card drag** → `moveBefore(renderedIds, dragged, target)` (within-group constraint in
  grouped mode unchanged).
- **Header/group drag** → `reorderByGroup(renderedIds, groupOf, dragGroup, targetGroup)`.

Then decide (pure, unit-tested):

- If the candidate order **differs** from the order the active sort would produce (the
  "sorted canonical" order) → the drop **violates the sort**: persist the candidate via
  the existing `onReorderSessions(order)` **and** `update({ sessionSort: 'manual' })` —
  one atomic "user took manual control" step. The on-screen arrangement is preserved
  exactly, plus the user's move.
- If the candidate is **identical** to the sorted canonical order (the item was dropped
  where the sort already placed it) → **no-op**: do not persist, do not switch sort.
  Avoids a needless flip on a no-op drop.

Because both card and group drags funnel through this same "differs from canonical →
commit as manual" decision, project reorder (C) now works in any sort mode with no
separate code path.

### Why "rendered order" is the snapshot

In sorted modes the flat `SessionManager` order is not what's on screen; the rendered
order is the sort applied to it. Committing the **rendered** order (not the raw flat
order) is what makes the list not "jump" after the switch to manual — the manual
baseline becomes exactly what the user was looking at.

## Data / interface contract

Pure helpers (new, React/DOM-free, unit-tested), siblings to `moveBefore`/`reorderByGroup`:

- `sortedCanonical(ids, sort, sessionsById): string[]` — the order the active sort
  yields (reuse the sidebar's existing sort comparator extracted into a pure function if
  not already; otherwise wrap it). Used only to compare against the candidate.
- `dropResolvesToManual(candidate: string[], canonical: string[]): boolean` — `true`
  iff `candidate` differs from `canonical` (order-sensitive array compare). Drives the
  switch.

No change to the host protocol: reuse `onReorderSessions(order)` →
`reorderSessions`. The only new persisted field is the settings-store
`collapsedProjects`.

## Edge cases & failure modes

- **Filter active:** drag disabled for cards and headers (chevrons still work). Matches
  today.
- **Flat (ungrouped) mode:** no headers/chevrons; card drag commits a flat manual order;
  auto-switch applies the same way.
- **Grouped card drag:** stays within its project (`dragGroup` constraint) as today;
  auto-switch still applies if the resulting flat order violates the sort.
- **Collapsed group dragged:** reorders fine — the header is the grab surface; hidden
  cards move with the block. Drag of a *card* inside a collapsed group is impossible (it
  isn't rendered) — acceptable.
- **`Project` sort + group reorder:** dropping a group out of project-sorted order is a
  violation → switches to manual, committing the visible group order. Consistent.
- **Drop onto own position / same group:** no-op (covered by `dropResolvesToManual`
  false and the existing `moveBefore`/`reorderByGroup` no-op guards).
- **Concurrent host state change mid-drag:** candidate computed from freshly rendered
  ids at drop; host `reorder()` reconciles missing/unknown ids (existing tolerance).

## Defaults & settings

- Collapse: all groups **expanded** by default (`collapsedProjects` empty).
- Universal drag is **on, no toggle** — it's the natural behavior; the only mode where
  it's off is filter-active (structural, not a preference).
- Auto-switch-to-manual is **automatic, no confirmation** — it's the documented intent
  of dragging in a sorted list (matches the file-manager / VS Code mental model).

## Testing

- **Unit (vitest):** `dropResolvesToManual` (identical vs differing orders);
  `sortedCanonical` parity with each `SessionSort`; the card-commit and group-commit
  builders across sort modes (manual no-op stays manual; sorted violating drop yields
  the rendered-order-plus-move). Collapse set add/remove/idempotence.
- **Real-app smoke (W1 harness):** new scenario `sidebar-dnd.e2e.mjs` — (1) in a sorted
  mode, drag a card to a violating position → assert `sessionSort` flips to `manual` and
  the new order persists; (2) drag a project header in a sorted mode → groups reorder +
  sort flips; (3) collapse a group → cards hidden, header shows count + (if applicable)
  attention rollup, and the collapsed state survives reload. Added to the W1 scenario
  set.

## Acceptance criteria

- Each project header (grouped mode) has a working collapse chevron; collapsing hides
  its cards and the state persists across reload via `collapsedProjects`.
- A collapsed header shows the group's session count and reflects a busy/needs-attention
  rollup when any hidden session has it.
- Dragging a session card **or** a project header works in **every** sort mode (filter
  inactive).
- A drop that changes order relative to the active sort switches `sessionSort` to
  `manual` and persists the on-screen order plus the move; a drop that lands where the
  sort already had it changes nothing.
- Drag remains disabled while a text filter is active.
- `dropResolvesToManual` and the commit builders are unit-tested; `npm run verify`
  EXIT 0 and `node esbuild.mjs` green.

## Out of scope

- Global collapse-all / expand-all control (per-project only; can be a trivial
  follow-up).
- Keyboard-driven reordering (parity with the existing DnD-only reorder; a separate
  cross-cutting item).
- New sort keys or changes to existing sort/group semantics.
- Cross-project session moves via group drag (unchanged — that's the card path).

## References

- `webview/components/sidebar.tsx` — `canDrag` (`:337`), `dragGroup` card-constraint
  (`:339`/`:362`), header drag + `reorderByGroup` (`:387`/`:402`), sort application
  (`:42`/`:435`), menu `update({ sessionSort / sessionGroupByProject })` (`:280`).
- Archived `docs/specs/archive/2026-06-11-group-reorder.md` — the `reorderByGroup`
  contract reused here.
- Archived `docs/specs/archive/2026-06-11-sort-filter-menu.md` — `SessionSort` options
  and the settings fields.
- W1 smoke harness: `docs/specs/2026-06-16-smoke-harness.md` (hosts `sidebar-dnd.e2e.mjs`).

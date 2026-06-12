# Spec — group-reorder (wishlist D2)

- **Tier:** LITE
- **Feature type:** UI
- **Triage reason:** One surface (the sessions sidebar, `webview/components/sidebar.tsx`), one clear job (drag a project group header to reorder whole groups). Reuses the existing flat-list reorder + persistence and the B1 drag-guard discipline — no new persisted data model.

## Problem frame

**Job-to-be-done:** "When my sessions are grouped by project, let me reorder the
projects themselves — drag project A above/below project B — so the project I'm
working in sits where I want it, with all its session tabs moving together."

Today drag-to-reorder works only for individual session cards. In grouped mode each
card drag is *constrained to its own project* (see `dragGroup` in `sidebar.tsx`), so
there is no way to move a whole project relative to another. The project group order
in manual+grouped mode is implicit: groups render in the order each project first
appears in the flat session list (`renderGroups` keys by first appearance).

**Actor:** the user, in the sessions panel, with "Group by project" on and sort =
manual, no active filter.

**Success outcome:** dragging a project header drops the entire group (header + its
sessions, in their existing relative order) before/after another group; the new
project order persists across re-render and reload, exactly like card reorder does.

**Non-goals:**
- No explicit, separately-persisted "project order" list. Order stays derived from
  the single source of truth (the flat session id order in the host `SessionManager`).
- No cross-project session moves via group drag (that's the card-drag path, unchanged).
- No reordering when sort ≠ manual or a filter is active (order is derived there, not
  user-owned — same rule as existing card reorder).
- No drag affordance redesign / handles (B1 already removed handles; header is the
  grab surface).

## Behavior & states

Grouped + manual + unfiltered (the only mode where group drag is enabled):

- **idle** — headers show a grab cursor; `draggable` is on.
- **dragging-group** — user started a drag on a project header. A group-drag marker is
  set (drag source = project path). Card-drag state is NOT set.
- **over-group** — pointer is over another group's header; that header shows a
  drop-before indicator (reuse the `--dropbefore` styling pattern).
- **drop** — compute the new flat session order by moving the dragged project's whole
  block of session ids to immediately before the target project's block (preserving
  each group's internal session order), then persist via the existing
  `onReorderSessions(order)` → `reorderSessions` host message.
- **end/cancel** — clear all drag markers; no state change on cancel.

Card drag (existing) and group drag must not collide:
- A **group drag** starts on the **header** (`.proj__label`).
- A **card drag** starts on the **card** (`.session`).
- The header is `draggable`; the `.session` cards are independently `draggable` and own
  their own `dragstart` (events do not bubble a second `dragstart`). The group's
  `onDragOver`/`onDrop` only act when a **group** drag is in flight (group marker set),
  and the card handlers only act when a **card** drag is in flight (card marker set).
  The two marker refs are distinct, so a card drag over a header (or vice-versa) is
  ignored rather than mishandled.

## Data / interface contract

**Project order is implicit** — there is no new field. The authority is the flat
ordered list of session ids in `SessionManager` (Map insertion order, persisted by
`list()`/`restore()`). A project's position = the position of its first session in
that flat list.

Pure function (new, unit-tested) — sibling to `moveBefore`:

```
reorderByGroup(
  ids: string[],            // flat session ids in current order
  groupOf: (id) => string,  // session id -> project key
  dragGroup: string,        // project being moved
  targetGroup: string | null // project to drop before; null = move to end
): string[]
```

Contract / invariants:
- Returns a new flat id array (same multiset of ids) with the **whole `dragGroup`
  block** relocated to immediately before the **first id of `targetGroup`**; `null`
  target moves the block to the end.
- **Within-group order is preserved** for every group (stable: relative order of ids
  sharing a group never changes).
- **No-op** when `dragGroup === targetGroup`, when `dragGroup` has no ids, or when
  `dragGroup` is not present — return the input array reference unchanged (mirrors
  `moveBefore`'s `!includes` no-op so React can skip a host round-trip).
- **Back-compat:** with no explicit order anywhere, this operates purely on the
  existing flat list, so old persisted sessions reorder correctly with zero migration.

## Edge cases & failure modes

- **One group only** — header still draggable; any drop is a no-op (single block).
- **Drag onto own header** — `dragGroup === targetGroup` → no-op.
- **Drag onto a card inside another group** — group `onDragOver` ignores it unless the
  pointer resolves to that group; dropping on a foreign card is treated as
  drop-before-that-group (or ignored) — never a cross-project card move.
- **Sort ≠ manual / filter active** — group drag disabled (headers not draggable),
  consistent with card reorder being disabled there.
- **Ungrouped (flat) mode** — no headers exist; nothing changes; card reorder as today.
- **Empty project block / unknown ids** — `reorderByGroup` ignores unknown groups and
  preserves all ids; host `reorder()` already tolerates unknown/missing ids.
- **Concurrent host state change mid-drag** — drop computes from the freshly rendered
  ids at drop time; host `reorder()` reconciles by appending anything missing.

## Defaults vs. settings

- Group drag is **on by default** whenever grouped+manual+unfiltered — no new setting.
  Rationale: it's the natural extension of card drag; gating it behind a toggle would
  be friction with no divergent-preference need.
- Drop-before semantics (insert above the target) mirror existing card reorder
  (`moveBefore` = before target) for consistency. Rationale: one mental model.

## Scope slicing

- **MVP:** header draggable; `reorderByGroup` moves the block; persists via existing
  channel; card drag unaffected; drop indicator on target header.
- **v1 (this spec = MVP+v1):** drop-before visual indicator on headers; cursor grab
  affordance; cancel restores cleanly.
- **Out of scope:** explicit project-order persistence; reordering in sorted/filtered
  modes; drag handle redesign; keyboard reordering; animation.

## Acceptance criteria

- **AC1** Given grouped+manual+unfiltered with projects [A, B, C] (first-appearance
  order), when I drag A's header onto C's header, then the flat order becomes B, then
  the C block — with A inserted before C — i.e. groups render [B, A, C]; A's internal
  session order is unchanged.
- **AC2** Given the drop in AC1, when the panel re-renders (or the app reloads), then
  the new group order persists (host received the new flat id order).
- **AC3** Given a project group with sessions [s1, s2, s3], when I reorder that group,
  then s1, s2, s3 keep their relative order inside the group.
- **AC4** Given grouped+manual+unfiltered, when I drag a single session **card** within
  its group, then it still reorders within that group (card drag unaffected).
- **AC5** Given sort = name (or a non-empty filter), then project headers are NOT
  draggable (no group reorder), matching card-reorder gating.
- **AC6** `reorderByGroup` is a pure function unit-tested for: move-before-middle,
  move-to-end (null target), within-group order preserved across all groups, no-op on
  same group / absent group, multi-session blocks moved as a unit.

## UI module (feature type = UI)

**State catalog:** idle header / dragging-group / target-over (drop-before indicator) /
drop / cancel — enumerated in Behavior & states above. No loading/empty/error states
(synchronous client-side reorder; persistence is fire-and-forget like card reorder).

**Interaction inventory:**
- Pointer: drag a `.proj__label` header → reorder group. Hover target header → indicator.
- Card drag on `.session` unchanged.
- No new click/keyboard interactions in MVP.

**Accessibility:**
- HTML5 DnD is mouse-first and not keyboard-accessible; this matches the existing
  card-reorder limitation (card reorder is also DnD-only). **Assumption (normal):** we
  accept parity with the existing card-drag a11y posture rather than adding keyboard
  reordering now — flagged below; keyboard reorder is a separate future item.
- The draggable header keeps its text label (project basename) as its accessible name;
  add `aria-grabbed`-style affordance only if cheap (cursor: grab is the affordance).

**i18n:** No new user-facing copy. Project names are file-path basenames (not
translatable). Nothing to localize.

**Design tokens:** Reuse existing tokens — drop indicator reuses the `--dropbefore`
pattern already used by `.session--dropbefore` / `.tab--dropbefore`; cursor grab via
existing cursor conventions. No new colors/hex.

## Decisions Needed

- **(normal) Keyboard accessibility of group reorder.** Defaulting to parity with the
  existing DnD-only card reorder (no keyboard path) to keep scope tight and consistent.
  Reversible — a keyboard reorder affordance can be added later across both card and
  group drag together.
- **(normal) Drop-onto-foreign-card behavior.** Defaulting to: a group drag only reacts
  to group-header drop targets; dropping a group onto a foreign session card is ignored
  (or treated as drop-before that card's group). Safest, avoids accidental cross-project
  session moves. Reversible.

## Self-audit

Core spine: problem frame ✓, behavior & states ✓, data/interface contract ✓, edge
cases ✓, defaults vs settings ✓, scope slicing ✓, acceptance criteria ✓. UI module:
state catalog ✓, interaction inventory ✓, a11y ✓, i18n ✓, design tokens ✓. No
unaddressed template items.

SPEC: docs/specs/group-reorder.md
TIER: LITE
DECISIONS_NEEDED: 2 (highest: normal)

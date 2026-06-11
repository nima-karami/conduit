# Spec: Created + last-updated dates on board cards

- **Tier:** LITE
- **Feature type:** UI (+ pure model)
- **Slug:** board-dates
- **Wishlist item:** G5 — "Created + last-updated dates on items"
- **Surface:** `src/board.ts` (pure model) + `webview/components/board-view.tsx` (UI) + a tiny shared relative-time helper

## Problem frame

**Job:** When triaging the feature board, a user (and the overnight agent) wants to
see at a glance how fresh a card is — when it was created and when it last changed —
without leaving the board or cross-referencing git history.

- **Actor:** the person editing the Kanban board in the renderer; secondarily the
  overnight agent that advances cards (its edits should bump the timestamp too, since
  it goes through the same model functions / `board.json`).
- **Success:** every card shows a compact, unobtrusive footer with a relative
  "updated …" (and created) time. New cards stamp both `createdAt` and `updatedAt` to
  now. Any mutation (notes/title edit, stage move, …) bumps `updatedAt`. Duplicating a
  card gives the copy fresh timestamps. Pre-existing cards that have no timestamp
  fields render gracefully (no crash, sensible fallback).
- **Non-goals:** absolute date pickers / manual date editing; per-field change history
  / audit log; timezone or locale formatting beyond a simple relative string; surfacing
  the dates anywhere other than the card; sorting/filtering the board by date (that is a
  later, separate item); migrating/backfilling timestamps into existing `board.json`
  cards (back-compat is read-tolerant, not a migration).

## Behavior & states

- **New card** (`addCard`) — `createdAt` and `updatedAt` both set to `now`. Footer
  reads "created just now · updated just now".
- **Edited card** (`updateCard`, and therefore `moveCard` / notes / title edits which
  all route through it) — `updatedAt` bumped to `now`; `createdAt` preserved. Footer's
  "updated …" advances; "created …" stays.
- **Duplicated card** (`duplicateCard`) — the copy gets fresh `createdAt = updatedAt =
  now` (it is a new card created now, not a clone of the source's age). Source card
  untouched.
- **Legacy card** (no `createdAt`/`updatedAt` in `board.json`) — renders without
  crashing. The footer omits any timestamp it doesn't have; if neither exists, the
  footer is not shown at all (no "—" noise). The first time such a card is edited, it
  gains an `updatedAt` (and only then shows one); `createdAt` stays absent until/unless
  set.

## Data / interface contract

`BoardCard` gains two optional fields (epoch milliseconds):

```
createdAt?: number;
updatedAt?: number;
```

Optional (not required) so existing `board.json` cards — and the seed board — remain
valid without a migration; readers must tolerate `undefined`.

Time is **injected for determinism** (the model is pure + unit-tested). Each mutating
helper takes an optional trailing `now` argument defaulting to `Date.now()`:

```
addCard(board, stage, title, now = Date.now())          // stamps createdAt = updatedAt = now
updateCard(board, id, patch, now = Date.now())          // bumps updatedAt = now, preserves createdAt
moveCard(board, id, stage, now = Date.now())            // delegates to updateCard(... now)
duplicateCard(board, id, now = Date.now())              // copy gets createdAt = updatedAt = now
```

- `removeCard` unchanged (no timestamp).
- `restoreBoard` carries `createdAt`/`updatedAt` through **only when they are finite
  numbers** (defensive parse; never invents them), so a round-trip preserves stamps and
  a legacy/garbage value is dropped rather than rendered.
- `serializeBoard` already serializes whatever is on the card; optional fields simply
  appear when present. No change needed beyond including them in the restored shape.

Invariants: timestamps are read-only to the UI (no editing control); `updatedAt >=
createdAt` holds for cards created through `addCard` (not enforced for legacy data).

Display helper (shared, pure, testable):

```
relativeTime(ts: number, now = Date.now()): string   // "just now" | "5 mins ago" | "3 hrs ago" | "2d ago"
```

Extracted so both the sessions card-field formatter (which has an equivalent inline
function today) and the board can use it; `now` injectable for tests.

## Edge cases & failure modes

- **Missing timestamps** ⇒ footer omits the missing part; if both missing, no footer.
  Never throws, never renders `NaN`/`Invalid Date`.
- **Non-number / NaN / negative in JSON** ⇒ `restoreBoard` drops it (treated as absent).
- **`updatedAt` in the (slight) future** vs. `now` ⇒ `relativeTime` clamps elapsed to a
  minimum (e.g. ≥ 0 ⇒ "just now") rather than printing a negative.
- **Rapid edits** ⇒ each mutation re-stamps `updatedAt`; the debounced board save
  coalesces; last write wins, consistent with existing behavior.
- **Overnight agent edits `board.json` directly** without timestamps ⇒ those cards read
  as legacy (graceful); only edits made through the app's model functions stamp times.
  Acceptable for LITE — we don't control the agent's writer.

## Defaults vs. settings

- **Relative time, not absolute** — no setting. Rationale: compact, glanceable, matches
  the existing sessions card-field formatter; absolute dates would crowd the small card.
- **Footer shows both created and updated when present** — no setting. Rationale: both
  are cheap and the user explicitly asked for both; collapses gracefully when one is
  missing.
- **No backfill / migration of existing cards** — no setting. Rationale: `board.json` is
  shared state with the agent; we must not rewrite it on read. Cards gain stamps
  naturally as they're touched.
- **`now` injection defaults to `Date.now()`** — internal, not a user setting; exists
  purely for deterministic tests.

## Scope slicing

- **MVP / this change:** optional `createdAt`/`updatedAt` on the model with `now`
  injection in `addCard`/`updateCard`/`moveCard`/`duplicateCard`; `restoreBoard`
  preserves valid stamps; a shared `relativeTime(ts, now)` helper; a compact card footer
  showing the relative times; unit tests for stamping, bumping, preservation,
  back-compat, and the formatter.
- **v1 / later:** sort/filter the board by created/updated (separate wishlist item);
  hover tooltip with the absolute date; agent-side writer stamps timestamps too.
- **Out of scope:** editing dates manually; full change history; locale/timezone
  formatting; backfilling existing cards.

## Acceptance criteria

- **AC1:** `addCard(b, stage, title, now)` returns a card with `createdAt === now` and
  `updatedAt === now`.
- **AC2:** `updateCard(b, id, patch, now2)` sets `updatedAt === now2` and leaves
  `createdAt` unchanged from its prior value.
- **AC3:** `moveCard(b, id, stage, now2)` bumps `updatedAt` to `now2` (stage moves count
  as updates).
- **AC4:** `duplicateCard(b, id, now2)` gives the copy `createdAt === updatedAt ===
  now2`; the source card's timestamps are unchanged.
- **AC5:** A card lacking `createdAt`/`updatedAt` (legacy) passes through `restoreBoard`
  without those fields and renders in the UI without error; a non-number timestamp in the
  blob is dropped.
- **AC6:** `relativeTime(ts, now)` returns "just now" for `ts === now`, a clamped "just
  now" for `ts` slightly in the future, and the expected `mins/hrs/d ago` buckets — pure
  and deterministic under injected `now`.
- **AC7:** All model functions remain pure (no input mutation), verified by existing +
  new unit tests; `npm run verify` and `npm run build` pass.

## State catalog (UI)

- **Card with both timestamps** — footer: "created <rel> · updated <rel>".
- **Card with only `updatedAt`** (legacy card that was edited once) — footer: "updated
  <rel>".
- **Card with neither** (untouched legacy card) — no footer rendered.
- The footer is non-interactive (no hover/focus/active states beyond inherited text
  styling); it does not interfere with the card's drag, inline-edit, duplicate, or delete
  affordances.

## Interaction inventory (UI)

- No new interactions. The footer is display-only text. Existing drag / double-click to
  edit / duplicate / delete are unchanged; the footer must not capture pointer events
  that would break drag (it is plain text within the draggable card, like the notes).

## Accessibility (UI)

- Footer is plain text, part of the card's reading order, no interactive target — no new
  focusable elements, no ARIA needed.
- The relative string is human-readable text (not an icon), so it's available to screen
  readers as-is. Optional nicety (not required for LITE): a `title` attr with the
  absolute timestamp — deferred to v1 to keep this minimal.
- Color: footer uses a muted/secondary text token (lower emphasis), but must still meet
  the app's existing secondary-text contrast (reuse an existing muted text variable,
  e.g. the same token `.bcard__notes--empty` uses), not a new low-contrast hex.

## i18n

- New static strings: the connectors "created ", " · updated ", "updated ", and the
  relative-time words ("just now", "mins ago", "hrs ago", "d ago"). The app has **no i18n
  framework**; these are English literals consistent with all surrounding board/session
  strings. No framework introduced (matches existing convention).

## Design tokens

- Footer styling reuses existing card text variables — muted/secondary text color,
  existing font-size scale, the card's existing padding rhythm. **No raw hex**; reuse the
  CSS custom properties already used by `.bcard__notes` / `.bcard__notes--empty`. A small
  `.bcard__meta` class (or equivalent) added to the board stylesheet using those tokens.

## Decisions Needed

- none — all choices use conservative, reversible defaults. (Notable assumption,
  `normal` severity: the overnight agent's direct `board.json` writes won't carry
  timestamps; we treat those cards as legacy rather than coordinating a shared writer —
  in scope only as graceful read-tolerance.)

## Self-audit

Core spine: problem frame ✓, behavior/states ✓, data/interface contract ✓, edge cases
✓, defaults vs settings ✓, scope slicing ✓, acceptance criteria ✓. UI module: state
catalog ✓, interaction inventory ✓, accessibility ✓, i18n ✓, design tokens ✓. No
unaddressed template/checklist items.

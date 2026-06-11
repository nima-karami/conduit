# Spec: Duplicate a board card (feature board)

- **Tier:** LITE
- **Feature type:** UI
- **Slug:** board-copy
- **Wishlist item:** G2 — "Duplicate / copy board items"
- **Surface:** `webview/components/board-view.tsx` (UI) + `src/board.ts` (pure model)

## Problem frame

**Job:** When refining the feature board, a user often wants a near-copy of an
existing card — same stage and notes, slightly different title — without retyping it.
Today the only way to make a similar card is `addCard` (title only, empty notes) and
re-entering everything by hand.

- **Actor:** the person editing the Kanban board in the renderer.
- **Success:** one click on a card's "Duplicate" control creates a copy of that card,
  placed immediately after the original, in the same column, with the notes/links
  carried over and a title marked as a copy. The original is untouched; the copy has a
  distinct id and can be edited/dragged/deleted independently.
- **Non-goals:** a right-click context menu (that is task G1); multi-select / bulk
  duplicate; cross-column "duplicate into stage X"; deep history/undo; copying to the
  OS clipboard; duplicating across boards/repos.

## Behavior & states

Duplication is a single, synchronous, immediate action — no intermediate editor or
confirm step.

- **Idle** — card renders normally with title, notes, and a row of card controls.
- **Duplicate clicked** — `duplicateCard(board, card.id)` produces a new board; the
  copy appears right after the original in the same column. State is applied through
  the existing debounced `apply` path (optimistic local update + debounced
  `updateBoard` post to the host), exactly like edit/delete/move.
- The copy is an ordinary card from that point: editable inline, draggable between
  columns, deletable — no special "copy" state persists on it beyond its title text.

No loading or error state: the operation is pure and local; persistence reuses the
existing fire-and-forget save path (same as `addCard`/`removeCard`).

## Data / interface contract

New pure model function in `src/board.ts`, alongside `addCard`/`updateCard`/`removeCard`:

```
duplicateCard(board: BoardData, id: string): BoardData
```

- Finds the card with `id`. If not found ⇒ returns `board` **unchanged** (no throw).
- Builds a copy with:
  - **`id`**: a fresh unique id from the existing `newId()` generator (never equal to
    the source id or any existing card id).
  - **`title`**: `` `${source.title} (copy)` `` (source title with a ` (copy)` suffix).
  - **`notes`**: copied verbatim from the source.
  - **`stage`**: same as the source (copy lands in the same column).
  - **`links`**: copied as a new array when present (`[...source.links]`), else omitted
    — so mutating one card's links can't affect the other.
- **Position:** the copy is inserted **immediately after the original** in the
  `board.cards` array. Since columns render via `cardsIn` (a stable-order filter by
  stage), inserting right after the source means the copy appears directly below the
  original within its column.
- **Immutability:** returns a new `BoardData` with a new `cards` array and a new copy
  object; does not mutate the input board, the source card, or the source's `links`
  array. Matches the existing reducers.

Persistence: routed through the component's existing `apply(next)` (debounced
`updateBoard`), so the copy round-trips to `board.json` via the host with no new
plumbing. The renderer never writes `board.json` directly.

## Edge cases & failure modes

- **Unknown id** ⇒ `duplicateCard` returns the board unchanged (defensive; the UI only
  ever calls it with a real card id).
- **Empty / whitespace title** ⇒ still suffixed: `"" → " (copy)"`. Acceptable for LITE
  (titles are normally non-empty; `addCard` already coerces blank titles to
  "Untitled", but duplicate copies the stored title verbatim then suffixes). Not worth
  special-casing.
- **Duplicating a copy** ⇒ `"X (copy)" → "X (copy) (copy)"`. Intentional and harmless;
  no de-duplication of the suffix (keeps the function trivially pure and predictable).
- **notes/links undefined** ⇒ `notes` is always a string in the model; `links` is
  optional and only copied when present, as a fresh array.
- **Rapid repeated clicks** ⇒ each click duplicates the *then-current* card; ids stay
  unique because `newId()` increments a counter. The debounced save coalesces; the
  last applied board wins, which contains all copies.
- **Drag in progress** ⇒ the duplicate button is a normal click target; it does not
  start a drag (it can `stopPropagation` so a click on it never bubbles to card drag).

## Defaults vs. settings

- **Suffix = `" (copy)"`**, no setting. Rationale: conventional, language-neutral
  enough for this single-user dev tool, and makes the copy obvious without a modal.
- **Placement = immediately after the original, same column**, no setting. Rationale:
  most predictable; the copy is visible right where the user acted.
- **No confirm dialog**, no setting. Rationale: the action is cheap and trivially
  reversible (delete the copy); a confirm would be friction.

## Scope slicing

- **MVP / this change:** `duplicateCard` reducer + a "Duplicate" control on each card
  that calls it through `apply`; copy lands after the original with a new id and
  copied fields; unit tests.
- **v1 / later:** expose Duplicate from the G1 context menu (shared menu component)
  instead of / in addition to the inline control.
- **Out of scope:** context menu (G1), bulk/multi-select duplicate, duplicate-to-stage,
  clipboard copy, undo.

## Acceptance criteria

- **AC1:** Clicking a card's Duplicate control adds exactly one new card in the same
  column, positioned immediately after the original.
- **AC2:** The new card's title is the original's title with `" (copy)"` appended; its
  notes, stage, and links match the original.
- **AC3:** The new card has an id different from the original and from every other
  existing card.
- **AC4:** The original card is unchanged (title, notes, stage, links, id, position).
- **AC5:** The copy is independently editable, draggable, and deletable, and persists
  through the existing board save path.
- **AC6:** `duplicateCard` is pure: it does not mutate the input board, the source
  card, or the source `links` array, and returns the board unchanged for an unknown
  id — covered by unit tests in `test/unit/board.test.ts`.

## Accessibility & i18n (UI checklist)

- **Control is a real `<button>`** with an `aria-label="Duplicate card"`, focusable
  and keyboard-activatable (Enter/Space) for free — mirrors the existing Delete button
  (`bcard__del` with `aria-label="Delete card"`).
- **Icon-only button:** uses the existing `IconDuplicate` glyph; the `aria-label`
  supplies the accessible name since there is no visible text (same approach as the
  Delete and Close buttons already on the board).
- **Click isolation:** the button calls `stopPropagation` so activating it never
  triggers the card's drag handlers — keyboard and pointer both reach the action.
- **i18n:** the only new static string is the `aria-label`; the `" (copy)"` suffix is
  applied to user-authored card titles (content, not chrome). No i18n framework exists
  in this app, so this matches the surrounding code (English literals); no new
  framework introduced.
- **Design tokens:** the Duplicate button reuses the existing card-control styling
  (the `bcard__del` pattern / shared icon-button CSS variables — `--text`, `--border`,
  hover/`--accent`), no raw hex, consistent with the Delete control beside it.

## Decisions Needed

- none (all choices use conservative, reversible defaults; nothing high-stakes).

## Self-audit

Core spine: problem frame ✓, behavior/states ✓, data/interface contract ✓, edge cases
✓, defaults vs settings ✓, scope slicing ✓, acceptance criteria ✓. UI module: state
catalog ✓, interaction (click + keyboard, drag isolation) ✓, a11y ✓, i18n ✓, design
tokens ✓. No unaddressed template/checklist items.

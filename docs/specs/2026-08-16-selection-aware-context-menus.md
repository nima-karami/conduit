---
status: draft
date: 2026-08-16
tier: FULL
type: UI
---

# Feature Spec: Selection-aware context menus

**Tier:** FULL (Lane 1 FULL · Lane 2 LITE)   **Feature type:** UI
**One-line request:** "There is a series of actions around this application that require selecting
multiple things and then right-clicking on them. For example if in the File Explorer I want to delete
multiple files, what I normally would do is that I would select multiple files and then right-click on
them and then delete them. Right now that doesn't work in our application. I think in general selecting
a couple of things across the application and then right-clicking on them only affects the target of
the right click. Just make sure that behavior is correct across all the features that we have in this
app"

> **Relationship to existing specs.** This supersedes nothing. It *implements* the multi-select
> right-click row already specified in `docs/specs/2026-07-06-arch-context-menus.md` §4 (the
> "Right-click with a multi-selection" edge case) and its Decisions Needed #5 — that behaviour was
> specified and never built. Menu **ordering, grouping, label casing and separator rules** come from
> `docs/specs/archive/2026-06-23-context-menu-consistency.md` and are **unchanged** here; this spec
> only changes each item's *scope*, its `disabled` state, and the destructive item's *label*.

## 1. Problem frame

- **Job:** "I picked several things on purpose. When I right-click one of them, the menu should act on
  everything I picked — the way every file manager, IDE and OS shell has worked for thirty years."
- **Actors:** anyone driving Conduit with a mouse or keyboard (the Explorer file tree and the
  architecture canvas are the two surfaces that have both a real selection and a context menu).
- **Success outcomes (observable):**
  - Selecting 3 files, right-clicking one of them and choosing Delete removes **all three** files from
    disk, with one confirmation naming the count.
  - Right-clicking a row that is **not** in the current selection collapses the selection to that row,
    so that while the menu is open exactly one row is selected and what the menu will act on is never
    ambiguous.
  - Any menu item that cannot meaningfully act on N>1 items is **visibly disabled** while N>1 —
    never silently acting on one of them.
  - The same rule holds on the architecture canvas, where today the Delete **key** deletes all selected
    nodes but the Delete **menu item** deletes only the clicked one.
- **Non-goals — written into the spec deliberately (see §9 Out of scope):** no new selection models, no
  new menu actions, no change to the canonical ordering convention, no new keyboard multi-select, no
  right-click-activates-a-tab behaviour.

### 1.1 Surfaces surveyed (why only two lanes)

Two exhaustive read-only sweeps established that only **two** surfaces have *both* a multi-selection
and a context menu:

| Surface | Selection model | Context menu | Verdict |
|---|---|---|---|
| Explorer file tree (`webview/components/right-pane.tsx`) | `SelectionState` (`webview/file-tree-selection.ts`) — a real multi-select | yes (`openMenu`) | **Lane 1** |
| Architecture canvas (`webview/components/architecture-view.tsx`) | React Flow multi-select → `selectedIds: string[]` | yes (`openNodeMenu`) | **Lane 2** |
| Editor / doc tabs | one `activeId`; close-others/left/right are *positional*, not selection-based | yes | correctly single-target |
| Sessions sidebar | one `activeId` | yes | correctly single-target |
| Feature board cards | no selection state at all | yes | correctly single-target |
| Git change list | no selection state; bulk ops are repo-wide (Stage all / Discard all) | yes | correctly single-target |
| Git history commits | one `selectedSha`, and **no** context menu | no | N/A |
| Terminal / Monaco / rendered markdown | text selection, content menus (OS text-menu idiom) | yes | out of the object-menu taxonomy |
| Panel frame / top bar / center pane | chrome menus, no object selection | yes | N/A |

The reported bug is therefore **not** app-wide breadth; it is depth on two surfaces plus a shared rule
that stops it recurring on the next surface that grows a selection.

## 2. The invariant (the heart of the spec)

**Stated once; binding on every current and future surface that has both a multi-selection and a
context menu.**

1. **Right-click on an item that IS in the selection** → the selection is **preserved**;
   selection-scoped items act on the **whole selection**.
2. **Right-click on an item that is NOT in the selection** → the selection **collapses to that item**;
   the menu then acts on that item alone. Observable form: *while the menu is open*, exactly one item
   is selected, and it is the right-clicked one.
3. **Right-click on empty space / container chrome** → the container menu opens; the selection is
   **untouched**.
4. **Keyboard invocation** (Shift+F10 / the context-menu key), on any surface that supports it, follows
   the **identical rule** against the focused item.

**"The whole selection" means the whole selection *of the kind the menu targets*.** A surface whose
selection can hold more than one object kind must say which kind its menu targets, so scope stays
unambiguous: the arch canvas's node menu targets **nodes** (`selectedIds`), and §5/§6 state what
happens to a selected edge. This is a precision clause, not an escape hatch — it does not license
acting on a subset of the targeted kind.

**Item classification — every menu item is exactly one of two kinds, and the kind is visible in the
UI:**

- **selection-scoped** — acts on all N targets.
- **single-only** — carries `disabled: true` whenever N > 1.

Rationale for disabling rather than silently narrowing: an *enabled* "Rename…" that renames 1 of 5
selected files is precisely the confusion being reported. `2026-07-06-arch-context-menus.md`
Decisions Needed #5 already chose this. Disabling makes the scope unmistakable at a glance.

**Label rule:** only the **destructive** item carries a count — `Delete 3 items` /
`Delete 3 components`. Every other selection-scoped label is unchanged; the enabled/disabled split
already communicates scope. Ordering, grouping, sentence case, `danger`, and `separatorBefore` are
untouched (context-menu-consistency spec).

## 3. Data / interface contract

### 3.1 New shared module — `src/menu-selection.ts`

Sits beside the existing `src/menu-position.ts` / `src/menu-toggle.ts`: pure, DOM-free, no React, no
`node:*` imports, unit-tested in `test/unit/menu-selection.test.ts`. It encodes the OS-standard rule
**once** so a future surface inherits it instead of re-deriving it.

```ts
export interface MenuTargets<T> {
  /** Everything the selection-scoped items act on, in the order supplied by the caller. */
  targets: T[];
  /** True when the caller must collapse its own selection state to `target` before opening. */
  collapse: boolean;
}

/**
 * The OS-standard right-click scoping rule. `selected` is any iterable of the currently
 * selected keys — an array (arch canvas) or a Set (explorer) both work unchanged.
 */
export function resolveMenuTargets<T>(selected: Iterable<T>, target: T): MenuTargets<T>;

/** `1 item` / `3 items` — the one place a count meets a noun. */
export function countNoun(n: number, one: string, many: string): string;

/**
 * A destructive menu label that grows a count. `single` is the whole existing label, so a
 * surface whose singular label already contains its noun keeps it verbatim:
 *   countLabel('Delete', n, { verb: 'Delete', noun: 'items' })
 *     → 'Delete'            (n <= 1)   → 'Delete 3 items'      (n > 1)
 *   countLabel('Delete component', n, { verb: 'Delete', noun: 'components' })
 *     → 'Delete component'  (n <= 1)   → 'Delete 3 components' (n > 1)
 */
export function countLabel(
  single: string,
  n: number,
  plural: { verb: string; noun: string },
): string;
```

`countLabel` deliberately takes the **whole** singular label rather than a verb it would re-compose:
the arch canvas's singular label is `Delete component`, whose noun is *not* the plural noun with an
`s` chopped off, and today's label must survive **verbatim** at n = 1 (§9 freezes it). A
`(verb, n, plural)` shape cannot produce both `Delete component` and `Delete 3 components`.

**`resolveMenuTargets` semantics:**

| `selected` | `target` | `targets` | `collapse` |
|---|---|---|---|
| contains `target` | in it | the full selection, **in the caller's supplied order**, `target` included | `false` |
| does not contain `target` | outside it | `[target]` | `true` |
| empty | anything | `[target]` | `true` |
| `[target]` (size 1) | in it | `[target]` | `false` |

- **Order is the caller's order, never re-sorted.** The Explorer supplies its selection ordered by
  `visibleOrder(roots)` so multi-value clipboard writes and delete order follow the tree the user is
  looking at. The arch canvas supplies `selectedIds` as React Flow gives it.
- **Error shape for the bulk loop.** The host's `MutationResult` is unchanged (`{ ok: true }` |
  `{ ok: false; error: string; code?: string }`). The renderer's per-run failure record is local and
  minimal: `failed: { path: string; error: string }[]`, populated in target order, consumed only by the
  aggregated permanent-delete confirm (§4.3) and the toasts. It crosses no boundary and is not
  persisted.
- `collapse` is a *caller obligation*, not a side effect — the module stays pure. It replaces
  `right-pane.tsx`'s current split-brain (`setSelection(...)` at `:1075` deciding one thing and
  `menuPaths` at `:1077` re-deriving it from the same value) with a single computation.

**`countLabel` shape.** Deliberately takes only the plural noun: the singular form is never rendered
(n === 1 returns the bare verb, per §2's label rule), so a `{ one, many }` pair would ship a dead
field — and this repo's `fallow:check` gate is a real dead-code check, not a formality.

### 3.2 What does **not** change

- **`MenuItem`** (`label`, `icon`, `onClick`, `danger?`, `separatorBefore?`, `disabled?`) and
  `MenuState` — unchanged. Everything below is array contents and `disabled` flags.
- **Host IPC — unchanged.** `src/fs-mutations.ts` `FsMutationRequest` and `electron/main.ts:2551`
  `fs-mutate` stay **single-path per call**. Bulk delete is a **client-side loop**, exactly like the
  existing multi-path work in `right-pane.tsx` (`runBatch` / `moveOrCopyInto`, `:907-917`). No new IPC,
  no batch host API, no protocol change.
- **`ConfirmState` (`webview/components/confirm-dialog.tsx`) — unchanged.** Every field this spec uses
  (`title`, `message`, `confirmLabel`, `danger`, `onConfirm`, `focusCancel`) already exists.
- **`webview/fs-undo.ts` — unchanged.** Its `FsOp` union is `create | rename | move | copy`;
  **deletion is explicitly out of the undo model** and `onDeleteFile` never called `recordFsOp`. The
  **Recycle Bin is the recovery path for a delete.** Bulk delete records no undo entries and adds no
  `delete` op — that would be new scope (see Decisions Needed #1).

## 4. Lane 1 — Explorer file tree (Tier FULL)

Files: `src/menu-selection.ts` (new), `webview/components/right-pane.tsx`, `webview/app.tsx`.

### 4.1 Menu construction

`openMenu` (`right-pane.tsx:1070`) becomes:

```
const ordered = visibleOrder(roots).filter(p => selection.selected.has(p));
const { targets, collapse } = resolveMenuTargets(topLevelPaths(ordered), node.path);
if (collapse) setSelection(selectOne(node.path));
const n = targets.length;
```

**The nested-target de-dupe happens here, at menu-open — before `n` is computed**, so the label, the
confirm's count, and the live-region count are all the same number (see §6 and Decisions Needed #7).
`topLevelPaths` (`src/drop-intent.ts`) is the existing helper `cutPaths`/`copyPaths`
(`right-pane.tsx:1001`, `:1007`) and the drag path already apply for exactly this reason;
`visibleOrder` is the existing helper in `webview/file-tree.ts:270`. Note `topLevelPaths` preserves
input order, so the tree ordering survives it.

The **shape** of the menu (file variant vs folder variant) is still chosen by the **clicked** node's
kind; `targets` decides what the items act on. `Copy relative path` maps each target through the same
`projectPath` relativiser already used for the single case.

### 4.2 Item classification (Explorer)

Order, grouping, separators and casing are **exactly as they are today** (context-menu-consistency
§4.A). Only the Scope / Disabled columns are new.

| Group | Item | Scope | Disabled when N>1 | Notes |
|---|---|---|---|---|
| Primary | **Open** *(file variant)* | selection-scoped | no | acts on **all** N targets, never a subset: a file target opens as a permanent tab, a folder target expands in the tree — exactly what Enter already does per-kind (`onTreeKeyDown`) |
| Primary | **Open externally** | single-only | **yes** | shells out per file; N shell-outs is a footgun |
| Primary | **Open with…** | single-only | **yes** | picker is inherently one-file |
| Create | **New file…** | single-only | **yes** | creates relative to one parent |
| Create | **New folder…** *(folder variant)* | single-only | **yes** | |
| Edit | **Rename…** | single-only | **yes** | the headline case for disabling |
| Edit | **Cut** | selection-scoped | no | **already correct today** (`menuPaths`) |
| Edit | **Copy** | selection-scoped | no | **already correct today** |
| Edit | **Paste into folder** | single-only | **yes** | also still `disabled` when the clipboard is empty |
| Reference | **Copy path** | selection-scoped | no | N lines joined with `\n` |
| Reference | **Copy relative path** | selection-scoped | no | N lines joined with `\n` |
| Reference | **Reveal in Explorer** | single-only | **yes** | N OS windows is a footgun |
| Destructive | **Delete** → `countLabel('Delete', n, 'items')` | selection-scoped | no | `danger` + `separatorBefore`, **last** — unchanged |

**Multi-value clipboard writes join with `\n`** (one path per line), matching VS Code.

### 4.3 Bulk delete flow

`onDeleteFile` (`webview/app.tsx:1670`) generalises from
`(node: {path, kind}, afterDeleted) => void` to a multi-target form. Suggested shape (name/exact
signature at build time):

```
onDeleteFiles(nodes: { path: string; kind: 'dir' | 'file' }[], afterDeleted: () => void): void
```

The single-node call sites (keyboard Delete, any future caller) pass a one-element array and get
byte-identical copy and behaviour to today.

**Flow:**

The `targets` handed to it are already top-level-de-duped and tree-ordered (§4.1), so `N` here is final.

1. **One confirm, up front.** Title `Move to Recycle Bin`; `danger: true`; confirm label
   `Move to Recycle Bin`.
   - N === 1 → the message is **unchanged**: `Move "<name>" to the Recycle Bin?`, and the primary
     button keeps focus (today's ergonomics).
   - N > 1 → `Move <countNoun(N,'item','items')> to the Recycle Bin?` followed by a **capped listing of
     the base names**: the first **5**, then `…and <N-5> more`. (Cap = 5; the dialog is a fixed-size
     modal with no scroll region and an uncapped list would overflow it — Decisions Needed #3.) This
     case sets **`focusCancel: true`** — a bulk destructive default must not be one stray Enter away.
2. **Loop `fsMutate({ op: 'remove', path })` per target**, in the caller's supplied (tree) order.
   Sequential, not parallel: the operations touch overlapping parent directories and the failure
   report must be deterministic.
3. **Per item, on success:** close any open doc tab for that path (`dropDocsFor`, which already drops
   both the file doc and any open diff for the same path) and add its parent to the refresh set. Tabs
   close as each item lands; **rows leave the tree only when the refresh runs in step 5**, so a bulk
   delete reads as one tree update rather than N flickers.
4. **Per item, on failure:** collect it into a `failed[]` list. **Do not abort the loop** — a
   partial failure must not strand the items that would have succeeded.
5. **After the loop:**
   - Refresh **every affected parent directory** (a `Set` of parents, so N siblings cost one refresh),
     via the caller's `afterDeleted`/refresh callback.
   - Announce the outcome on the Explorer's existing `aria-live` region:
     `Deleted <countNoun(k,'item','items')>` (and, when `failed.length > 0`,
     `<k> deleted, <f> failed`). Every count-bearing string in this flow goes through `countNoun`, so
     "Deleted 1 items" is not reachable.
   - If `failed.length > 0` → **one aggregated permanent-delete confirm**, never one dialog per failed
     item: title `Delete permanently`; message
     `Couldn't move <countNoun(f,'item','items')> to the Recycle Bin. Delete permanently? This cannot be undone.`
     followed by the same capped name listing; confirm label `Delete permanently`; `danger: true`.
     Confirming loops `fsMutate({ op: 'removePermanent', path })` over exactly the failed set, with the
     same per-item success handling (close tab, refresh parent) and a toast for anything that still
     fails. Declining leaves those items on disk and in the tree.
   - The **N === 1** path therefore keeps its exact current behaviour: one confirm, and on trash
     failure one explicit permanent-delete confirm for that file.
6. **No undo entries are recorded** (§3.2). The Recycle Bin is the recovery path.

The confirm is the **in-app renderer dialog** (`webview/components/confirm-dialog.tsx`,
`ConfirmState`), **not** a native OS dialog — non-negotiable, because native dialogs are invisible to
Playwright and hang the smoke harness (see `docs/specs/archive/2026-06-16-smoke-harness.md` and the
memory note on native dialogs).

### 4.4 Keyboard Delete

`onTreeKeyDown`'s `Delete` case (`right-pane.tsx:1261-1264`) currently deletes only the roving row.
It uses the **same rule**: `resolveMenuTargets(ordered, rovingPath)` — if the roving row is in the
selection, delete the whole selection; otherwise delete just that row. This matches the already-correct
keyboard Ctrl+X/Ctrl+C at `:1205-1208`.

## 5. Lane 2 — Architecture canvas (Tier LITE)

File: `webview/components/architecture-view.tsx`. Depends on Lane 1 **only** for
`src/menu-selection.ts`. Implements the row already specified at
`2026-07-06-arch-context-menus.md` §4 (~line 271) and Decisions Needed #5 (~lines 500-504) — the
behaviour was specified, never built.

Three defects, all in / around `openNodeMenu` (`:2165`):

1. **No collapse on outside right-click.** It sets `selectedId` but never clears `selectedIds`, so
   right-clicking an unselected node leaves the other nodes **visibly selected** while the menu
   silently behaves single-target. Fix: drive both the selection reset and the targets from
   `resolveMenuTargets(selectedIds, nodeId)`; when `collapse` is true, reset the React Flow selection
   to `nodeId` alone (so the canvas repaints before the menu opens), replacing the bare
   `setSelectedId(nodeId)`.
2. **`Delete component` (`:2260-2269`) removes only the clicked node** even with 2+ selected — while
   the Delete **key** path (React Flow `remove` changes, handled at `:2031`) deletes all of them. Fix:
   delete every target in **one** `applyDoc` (one history entry, matching the key path's single-step
   behaviour), and label it
   `countLabel('Delete component', n, { verb: 'Delete', noun: 'components' })` — `Delete component` at
   n = 1 (verbatim as today), `Delete 3 components` above it.
3. **Single-only items stay enabled during a multi-selection.** Fix: `disabled: n > 1` on them.

**Item classification (architecture node menu)** — order/grouping unchanged from
`2026-07-06-arch-context-menus.md` §2.2.2:

| Group | Item | Scope | Disabled when N>1 |
|---|---|---|---|
| Primary | **Open / Create nested canvas** | single-only | **yes** |
| Create | **Add connected node** | single-only | **yes** |
| Create | **Add input port** / **Add output port** | single-only | **yes** |
| Create | **Group selection** | selection-scoped | no (already conditional on N≥2) |
| Create | **Encapsulate selection into component** | selection-scoped | no (already conditional on N≥2) |
| Edit | **Rename…** | single-only | **yes** |
| Edit | **Edit description…** | single-only | **yes** |
| Edit | **Set icon…** | single-only | **yes** |
| Edit | **Duplicate** | single-only | **yes** |
| Edit | **Explode component** | single-only | **yes** (already conditional on `childGraph`) |
| Reference | **Copy name** | single-only | **yes** |
| Destructive | **Delete component** → `Delete <n> components` | selection-scoped | no |

`Group selection` / `Encapsulate selection into component` are already gated on
`multi = selectedIds.length >= 2 && selectedIds.includes(nodeId)` (`:2171`) — that gate is exactly
`!collapse && n >= 2` and folds into the shared rule with no behaviour change.

**The node menu targets nodes** (§2's precision clause). `selectedIds` is fed from
`onSelectionChange` (`:1425-1431`) and tracks nodes; edges are not in its target set. A selected edge
that is incident to a deleted node goes with it (`removeNode` already cascades); a selected edge
incident to nothing being deleted **survives and stays selected**. Extending `selectedIds` to carry
edges is a Lane-2-sized change to a LITE lane and is flagged, not smuggled in — Decisions Needed #10.

**Pane, port, edge and group menus are untouched** by this spec — they either have no selection
(pane) or are owned by their slice.

## 6. Edge cases & failure modes

| Condition | Expected behaviour |
|---|---|
| **Zero selected**, right-click a row | `collapse: true`, `targets = [row]` — the ordinary single-target menu. |
| **One selected**, right-click *it* | `collapse: false`, N === 1 — nothing is disabled; `Delete` has **no** count. |
| **One selected**, right-click a different row | Collapses to the clicked row; menu identical to the above. |
| **N selected**, right-click one of them | Selection preserved; scoped items act on all N; single-only items disabled. |
| **N selected**, right-click empty tree space | The **container** menu (`openRootMenu`) opens; the selection is **untouched** (rule 3). |
| Right-click a row **while a rename draft is open** | Unchanged from today (the draft input owns the interaction). |
| **Mixed files + folders** selected | Menu *shape* follows the clicked node's kind; `Delete` deletes all N regardless of kind (`fs-mutate remove` already handles both). Noun stays `items`. |
| **Nested selection** (a folder and a file inside it) | The folder's removal takes the child with it; the child's own `remove` then fails ENOENT and lands in `failed[]`. Mitigation: before the loop, drop any target whose ancestor is also a target — reuse `topLevelPaths` (`src/drop-intent.ts`), which `cutPaths`/`copyPaths` (`right-pane.tsx:1001`, `:1007`) and the drag path already apply for exactly this reason. The count in the label and confirm is the **de-duped** count. |
| **Partial failure** (some paths locked / in use) | Loop completes; successes are refreshed + tabs closed; failures collected and offered **one** aggregated permanent-delete confirm. |
| **All targets fail** | Same aggregated permanent-delete confirm; tree unchanged if the user declines. |
| **Path deleted externally** between the confirm and the loop | `remove` fails; the item lands in `failed[]`, and the permanent-delete retry also fails → a toast per remaining failure. Acceptable: the end state (gone) matches the intent. |
| **Selection changes under the open menu** (watcher refresh, agent writes a file) | `targets` was captured at open time — the menu acts on what the user saw. `reconcile` prunes vanished paths from the selection independently; a target that no longer exists just fails its `remove` (see above). |
| **Double activation** of Delete (double-click the item) | `ContextMenu` closes on activation, so a second activation is not reachable; the confirm dialog is modal and single-shot. |
| **Very large selection** (e.g. 500 files) | No cap on the delete itself; the confirm lists 5 names + "and 495 more". Sequential loop keeps the host responsive; refreshes are de-duped per parent. |
| Arch: selection contains **nodes the current graph no longer holds** (drilled level changed) | Targets are filtered against `graph.nodes` at open time; a stale id is dropped. |
| Arch: mixed **node + edge** selection | The node menu targets **nodes** (§2, §5): the count and the delete cover every selected node; an edge incident to a deleted node cascades away with it; an unrelated selected edge survives, still selected. Edge-only deletion stays the edge menu / Delete-key path. Flagged as Decisions Needed #10. |
| Menu opened by **keyboard** (Shift+F10) on the arch canvas | Identical rule against the focused node (`openNodeMenu`'s `keyboard` flag already exists). The Explorer tree has **no** Shift+F10 today; adding it is deferred (§9). |

## 7. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Right-click inside the selection preserves it | Yes | No | The OS standard; a setting would defeat the point. |
| Right-click outside the selection collapses it | Yes | No | Same. Ambiguity is the bug being fixed. |
| Single-only items at N>1 | **Disabled** (visible, greyed) | No | Hiding them makes the menu jump between shapes; silently narrowing them is the reported confusion. |
| Count in the label | **Destructive item only** | No | The disabled/enabled split already signals scope; counting every label is noise. |
| Multi-value clipboard separator | `\n` | No | VS Code parity. |
| Name listing cap in the delete confirm | 5, then "and N more" | No | Fixed-size modal; a magic number, not a preference. |
| Deletion undo | None — Recycle Bin is the recovery path | No | The undo model has no delete op by design (`fs-undo.ts`). |
| Permanent-delete fallback for N failures | **One** aggregated confirm | No | One dialog per failed item is a rage-click generator. |

## 8. Acceptance criteria

**Declarative:**

- Selecting 3 of 5 files, right-clicking one of them, and activating Delete removes exactly those 3
  files from disk and leaves the other 2.
- That menu's destructive item reads `Delete 3 items`, is last, is `danger`, and has a separator above
  it.
- In that same menu, `Rename…`, `Reveal in Explorer`, `Open externally`, `Open with…`, `New file…`,
  `New folder…` and `Paste into folder` are disabled.
- With a 1-path selection the destructive item reads `Delete` and nothing is disabled.
- Right-clicking a row **outside** the selection visibly reduces the selection to 1 row, and its menu
  reads `Delete`.
- `Copy path` with 3 selected puts 3 newline-separated absolute paths on the clipboard.
- Pressing Delete with 3 rows selected and the roving row among them deletes all 3.
- On the arch canvas with 3 nodes selected, the node menu's destructive item reads
  `Delete 3 components` and removes all three; `Rename…` / `Duplicate` / `Copy name` are disabled.
- On the arch canvas, right-clicking an **unselected** node clears the other nodes' selection
  highlight before the menu opens.
- For a 1-item selection, every menu's item sequence, separator positions and label casing match the
  literal expected sequence recorded in the unit tests (§14 B) — i.e. no regression against today.
- With N>1 the bulk delete confirm opens with **Cancel** focused; with N=1 it opens with the primary
  button focused, as today.

**EARS:**

- *Ubiquitous:* The system shall resolve every context-menu invocation on a multi-selectable surface
  through `resolveMenuTargets`.
- *Event:* When the user right-clicks an item that is in the current selection, the system shall
  preserve the selection and scope selection-scoped items to every selected item.
- *Event:* When the user right-clicks an item that is not in the current selection, the system shall
  collapse the selection to that item before rendering the menu.
- *Event:* When the user right-clicks empty container space, the system shall open the container menu
  and shall leave the selection unchanged.
- *State:* While more than one item is targeted, the system shall render every single-only item as
  disabled.
- *State:* While more than one item is targeted, the system shall render the destructive item's label
  with the target count.
- *Event:* When a bulk delete completes, the system shall refresh every affected parent directory,
  close every open document tab for a deleted path, and announce the outcome on the live region.
- *Unwanted:* If one or more targets cannot be moved to the Recycle Bin, then the system shall complete
  the remaining deletions and offer a single permanent-delete confirmation listing the failures.
- *Unwanted:* If a target no longer exists when its removal runs, then the system shall record it as a
  failure and shall not abort the remaining deletions.

**Gherkin:**

```gherkin
Feature: Selection-aware context menus
  Background:
    Given a project with files a.txt, b.txt, c.txt, d.txt, e.txt is open in the Files tree

  Scenario: Delete a multi-selection from the context menu
    Given I have selected a.txt, b.txt and c.txt
    When I right-click c.txt
    Then the last menu item reads "Delete 3 items" and is danger-styled and separated
    And "Rename…" is disabled
    When I activate "Delete 3 items" and confirm
    Then a.txt, b.txt and c.txt no longer exist on disk
    And d.txt and e.txt still exist

  Scenario: Right-clicking outside the selection collapses it
    Given I have selected a.txt, b.txt and c.txt
    When I right-click e.txt
    Then exactly one row is selected
    And the last menu item reads "Delete"
    When I activate "Delete" and confirm
    Then e.txt no longer exists on disk
    And a.txt, b.txt and c.txt still exist

  Scenario: Copy path with a multi-selection
    Given I have selected a.txt and b.txt
    When I right-click a.txt and activate "Copy path"
    Then the clipboard holds two lines, one absolute path per line

  Scenario: Partial failure surfaces the failures only once
    Given I have selected three files and one of them cannot be moved to the Recycle Bin
    When I confirm the deletion
    Then the two deletable files are gone and their tabs are closed
    And exactly one "Delete permanently" confirmation appears, naming the one failure

  Scenario: Architecture canvas delete matches the Delete key
    Given three components are selected on the canvas
    When I right-click one of the selected components
    Then the last menu item reads "Delete 3 components"
    And "Rename…", "Duplicate" and "Copy name" are disabled
    When I activate "Delete 3 components"
    Then all three components are removed in a single undo step
```

## 9. Scope slicing — exactly two lanes

**Lane 1 — Explorer (Tier FULL).** `src/menu-selection.ts` + `test/unit/menu-selection.test.ts`; the
Explorer menu classification and scoping (§4.1–4.2); bulk delete (§4.3); keyboard Delete (§4.4).
Ships the shared rule that Lane 2 consumes.

**Lane 2 — Architecture canvas (Tier LITE).** Collapse-on-outside-right-click; selection-scoped
`Delete <n> components`; disable single-only items (§5). Depends on Lane 1 **only** for
`src/menu-selection.ts` — no other coupling, and the two lanes touch disjoint components.

**Out of scope (explicit non-goals):**

- **Do not add a selection model** to surfaces that lack one — board cards, git change list, editor
  tabs, sessions sidebar, history commits. They are correctly single-target *because* there is nothing
  else selected.
- **Do not add new menu actions.** Only the bulk form of actions that already exist.
- **Do not change the canonical menu ordering / grouping convention**
  (`archive/2026-06-23-context-menu-consistency.md`). Order, separators and casing are frozen.
- **Do not add keyboard multi-select to the Explorer** (Ctrl+A, Shift+Arrow). It is genuinely missing —
  the tree's arrow keys call `focusRow`, which does `setSelection(selectOne(p))`, so the keyboard can
  never build a multi-selection at all. That is a **separate feature**; deferred, noted here only.
- **Do not add Shift+F10 to the Explorer tree.** It has none today; the arch canvas already has it and
  is covered by the invariant. Deferred.
- **Do not make right-click activate a tab or a session.** VS Code does not either.
- No new IPC, no batch host API, no `delete` op in the undo model, no `MenuItem` shape change, no
  restyling.

## 10. State catalog (UI)

The menu's own open/hover/active/disabled/dismiss states live in `ContextMenu` and are **unchanged**.
The states this spec introduces are *which items are enabled* and *what the destructive label reads*:

| Component | State | What the user sees | Action / CTA |
|---|---|---|---|
| Explorer row menu | **N = 1** | Today's menu, verbatim. Destructive reads `Delete`. | any item |
| Explorer row menu | **N > 1** | Single-only items greyed with `aria-disabled`; destructive reads `Delete <N> items`. | the scoped items |
| Explorer row menu | target outside selection | Selection visibly collapses to 1 row *before* the menu paints, so N = 1 | as above |
| Explorer tree | **nothing selected** (before the right-click) | No `.filerow--selected`. The right-click then collapses onto the clicked row, so while the menu is open exactly one row is selected | — |
| Explorer tree | **empty after action** — every child of a folder deleted | The folder refreshes to zero rows and stays expanded; the parent's expand chevron reflects an empty dir. No new empty-state copy is introduced (the tree has no per-folder empty message today and this spec does not add one) | — |
| Explorer tree | **empty after action** — every root deleted | The existing project-level empty state renders, unchanged | — |
| Delete confirm | **N = 1** | `Move "<name>" to the Recycle Bin?` (unchanged) | Move to Recycle Bin / Cancel |
| Delete confirm | **N > 1** | `Move <N> items to the Recycle Bin?` + up to 5 names + `…and <N-5> more` | Move to Recycle Bin / Cancel |
| Delete confirm | **partial failure** | One `Delete permanently` alert naming the failed items | Delete permanently / Cancel |
| Delete in progress | in-flight | The tree is not blocked and shows no spinner; tabs for deleted files close as each lands, rows leave in one update when the post-loop refresh runs (§4.3) | — |
| Delete outcome | success / partial | Live-region announcement `Deleted <k> items` / `<k> deleted, <f> failed`; a toast per hard failure | — |
| Delete outcome | **permission denied / file locked** | The item lands in `failed[]` and is named in the aggregated `Delete permanently` confirm; declining leaves it in the tree | Delete permanently / Cancel |
| Delete outcome | **page-level error** | N/A — there is no page-level failure mode: `fs-mutate` is per-path, so a failure is always scoped to one item and surfaces as the row above. No whole-tree error state exists or is added | — |
| Any surface | **limit reached** | N/A by decision — no cap on the selection size, on `Open`, or on the delete (§7, Decisions Needed #4). The only bound is presentational: the confirm lists 5 names then `…and <N-5> more` | — |
| Arch node menu | **N = 1** | Today's menu, verbatim. Destructive reads `Delete component`. | any item |
| Arch node menu | **N > 1** | Single-only items disabled; `Group selection` / `Encapsulate…` present; destructive reads `Delete <N> components` | the scoped items |
| Arch canvas | target outside selection | Other nodes' selection rings clear before the menu opens | — |

Remaining catalog states: **loading / partial** — N/A, the menu is built synchronously from
already-loaded state, and the delete loop shows no loading chrome (rows are the progress indicator).
**Offline / degraded** — N/A, everything here is local filesystem and in-memory document state; no
network is involved. **First-run / blank slate** — N/A, this feature adds no new surface; it changes
items on menus that already exist. **Permission-denied**, **not-found**, **empty-after-action**,
**page-level error** and **limit-reached** are covered by rows above rather than declared N/A.

## 11. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Touch | Context menu | ARIA role/states |
|---|---|---|---|---|---|---|
| Explorer row | select, open, cut/copy/paste, rename, delete | click = select one; Ctrl/Cmd+click toggles; Shift+click ranges; **right-click = §2 rule** | arrows/Home/End move the roving row; Enter opens; F2 renames; **Delete uses the §2 rule**; Ctrl+X/C/V already selection-scoped; Esc clears | long-press = right-click (platform default) | this menu | `aria-selected` per row; `aria-multiselectable` on the container (both already asserted by `explorer-multiselect.e2e.mjs`) |
| Explorer empty space | container menu | right-click → container menu, **selection untouched** | — | long-press | root menu | unchanged |
| Menu item (disabled) | none | click is inert; hover shows no highlight | skipped by ↑/↓? **No** — remains focusable-in-list and reported disabled, per today's `ContextMenu` | — | — | `aria-disabled="true"` (existing behaviour, now exercised far more) |
| Delete confirm | confirm / cancel | click | Enter confirms, Esc cancels (existing `ConfirmDialog`) | tap | — | `role="alertdialog"`; the count and names are in the visible message, i.e. in the accessible name path |
| Arch node | select, drill, rename, delete | click; Ctrl/Cmd+click adds; Shift+drag marquee; **right-click = §2 rule** | Shift+F10 on the focused node = §2 rule; Delete key already deletes all selected | long-press | node menu | unchanged |

**Where the keyboard pathway is complete, and where it is not — stated plainly rather than claimed:**

- **Complete:** every *action* in this spec has a keyboard path. The Delete **key** applies the
  identical scoping rule to whatever selection exists (§4.4); Ctrl+X/C/V are already selection-scoped;
  the arch canvas opens its node menu with Shift+F10 and navigates it with arrows/Enter/Esc.
- **Incomplete, and out of scope:** on the Explorer the *selection itself* can only be **built** with a
  pointer. The arrow keys call `focusRow`, which does `setSelection(selectOne(p))`, so no keyboard
  gesture can produce N>1; and the tree has no Shift+F10. A keyboard-only user therefore cannot reach
  this feature's N>1 case on Lane 1 at all. That is a **pre-existing** WCAG gap in the selection model,
  not one this spec introduces — but it is the honest limit of the a11y story here, and the two missing
  pieces (Ctrl+A / Shift+Arrow, and Shift+F10 on the tree) belong together in one follow-up
  (§9 Out of scope, Decisions Needed #8). The arch canvas's Shift+drag marquee has the same shape:
  Ctrl/Cmd+click is its pointer alternative, keyboard multi-select is React Flow's gap.

Other rules honoured: destructive actions confirm (and the bulk case defaults focus to Cancel).
Disabled state is conveyed by `aria-disabled` plus the greyed treatment, never colour alone.

## 12. Accessibility & i18n (UI)

**Accessibility:**

- **Scope must be perceivable, not inferable.** The count in the destructive label and the disabled
  state on single-only items are the two signals; both are text/state, not colour. A screen-reader user
  hears "Delete 3 items" and "Rename, dimmed".
- **`aria-disabled`** — `ContextMenu` already emits it for `disabled` items; this spec makes that path
  load-bearing, so the unit tests assert `disabled: true` on the built arrays.
- **Live-region announcement** for the bulk outcome (`Deleted 3 items` / `2 deleted, 1 failed`) reuses
  the Explorer's existing `announce` helper — the same one `runBatch` uses for moves. A sighted user
  sees rows vanish; a screen-reader user must be told.
- **Focus after delete** — focus must not be stranded on a removed row. After the tree refresh, focus
  moves to the nearest surviving row in the previous visible order (the tree's `reconcile` already
  prunes the selection and clears a vanished anchor; `focusPath` must follow the same rule).
- **Confirm dialog** keeps `role="alertdialog"`, Esc-cancels, and Enter-confirms. For **N>1** it sets
  the existing `focusCancel: true` so Cancel holds initial focus — a bulk destructive default must not
  be one stray Enter away. N=1 is unchanged (Decisions Needed #5); asserted in §14 C.
- **Visible focus / high contrast** — no new focus treatments; the existing menu and row focus rings
  are unchanged and must keep surviving forced-colors.
- **Reduced motion** — nothing animates; unchanged.

**i18n:**

- The app has **no i18n framework** (hardcoded English) — unchanged reality. But this feature is the
  first place **count-dependent** strings appear, so **every** count↔noun pair in it goes through the
  one pure `countNoun` helper (§3.1) and never through ad-hoc concatenation: the menu label
  (via `countLabel`), the confirm message, the failure message, and the live-region announcement. That
  is both the seam a future extraction needs and the reason "Deleted 1 items" is unreachable.
- New/changed user-visible strings, enumerated for future extraction: `Delete <n> items`,
  `Delete <n> components`, `Move <n> items to the Recycle Bin?`, `…and <n> more`,
  `Couldn't move <n> items to the Recycle Bin. Delete permanently? This cannot be undone.`,
  `Deleted <n> items`, `<n> deleted, <n> failed`. Everything else is an existing string.
- **Text expansion** — menu width already grows to content and clamps to the viewport
  (`clampMenuPosition`); a ~30% longer translation of `Delete 3 items` is tolerated. The confirm's
  name listing is capped precisely so the modal cannot overflow.
- **RTL** — no RTL support in the app today; noted, not built.

## 13. Design tokens (UI)

**None added.** Reuse `--danger` (destructive items), the existing disabled treatment from the
interaction-state vocabulary (`docs/specs/2026-08-01-interaction-state-vocabulary.md` — disabled is one
rung of the shared ladder; do **not** invent a menu-local disabled style), the menu separator token,
and the existing confirm-dialog styles. All three themes — **Aero, Aero Dark, Neon** — inherit
unchanged, because every role used here already resolves per-theme; no theme-conditional rule is added.
The one thing to check at build time is that the disabled menu-item treatment keeps ≥4.5:1 against the
menu surface in **Neon** (its menu ground is the darkest of the three), since this spec makes disabled
items far more common than they are today.

## 14. Verification

`npm run verify` green is the gate. On top of it:

**A. Pure unit tests — `test/unit/menu-selection.test.ts`** (mirrors `menu-position.test.ts` /
`menu-toggle.test.ts` in style):

- target **in** selection → `targets` = whole selection, `collapse === false`
- target **outside** selection → `targets === [target]`, `collapse === true`
- **empty** selection → `[target]`, `collapse === true`
- **single** selection containing the target → `[target]`, `collapse === false`
- **ordering stability** — the returned order equals the supplied iterable's order, for both a `Set`
  and an array input (the two real callers), and is not re-sorted
- `countNoun`: `1 item`, `3 items`, `0 items` — the singular is used at exactly n = 1 and nowhere else
- `countLabel` forms, both real call shapes: `('Delete', 0|1, {verb:'Delete',noun:'items'})` → `Delete`;
  `('Delete', 3, …)` → `Delete 3 items`; `('Delete component', 1, {verb:'Delete',noun:'components'})` →
  `Delete component` (today's label, verbatim); `('Delete component', 3, …)` → `Delete 3 components`

**B. Unit tests over the built menu item arrays** (the builders must be reachable from a test — extract
a pure builder if the inline construction is not testable as-is; that extraction is in scope for
Lane 1):

- Explorer, **3-path** selection: last item is `Delete 3 items`, carries `danger` **and**
  `separatorBefore`; `Rename…` has `disabled: true`; `Cut` / `Copy` / `Copy path` /
  `Copy relative path` / `Open` are **not** disabled.
- Explorer, **1-path** selection: last item is `Delete`; **no** item is disabled beyond the pre-existing
  clipboard-empty `Paste into folder`.
- **Clipboard join:** activating `Copy path` / `Copy relative path` from the 3-path builder calls the
  clipboard function once with the three values joined by `\n`, in tree order. Asserting it here (with
  a stubbed clipboard fn) is what makes the §8 clipboard criterion automatically observable — reading
  the real clipboard in the harness is not.
- **No-regression baseline:** the 1-path arrays are compared against the **existing** context-menu
  invariant assertions (`archive/2026-06-23-context-menu-consistency.md` §7's cross-menu invariants:
  no first item carries `separatorBefore`; every `danger` item is last in its menu) *and* against a
  literal expected label sequence written into the test. That literal sequence, not the phrase
  "identical to today", is the decidable baseline for §8's no-regression criterion.
- Cross-check: the 1-path and 3-path arrays have the **same length and the same label order** modulo
  the destructive item's count suffix — i.e. this spec changes scope and enabled-ness, never shape.
- Arch node menu, **multi** case: `Delete 3 components` last + `danger` + `separatorBefore`;
  `Rename…` / `Set icon…` / `Duplicate` / `Copy name` / `Open nested canvas` disabled;
  `Group selection` + `Encapsulate selection into component` present and enabled.

**C. Real-app e2e — `test/e2e/explorer-multiselect-delete.e2e.mjs`**, on the existing harness
(`test/e2e/harness.mjs`), run via `node test/e2e/run-smoke.mjs explorer-multiselect-delete`. Modelled
on `test/e2e/explorer-multiselect.e2e.mjs` (same `mkdtempSync` throwaway project, same `fileRow`
locator, same `openSession` + Files-tab preamble):

1. Seed a temp project with `a.txt … e.txt`.
2. Click `a.txt`; Ctrl-click `b.txt`; Ctrl-click `c.txt`; assert 3 selected (class **and**
   `aria-selected`, as the existing scenario does).
3. Right-click `c.txt` (a **selected** row). Assert that **while the menu is open** all 3 rows are
   still selected (the preserve half of rule 1), that the visible `.ctxmenu__item` text has
   `Delete 3 items` as the **last** item, that it carries the danger class, and that `Rename…` is
   rendered disabled.
4. Activate it. Assert the **in-app** `ConfirmDialog` (`.confirm` / `role="alertdialog"` — **not** a
   native dialog; native dialogs are invisible to Playwright and hang the harness) shows the count and
   the name listing, and that **Cancel holds focus** (`document.activeElement` is the Cancel button —
   the `focusCancel` decision, #5). Then confirm.
5. Assert on the **real filesystem** (node `existsSync` in the scenario process, not the renderer) that
   `a.txt`, `b.txt`, `c.txt` are gone and `d.txt`, `e.txt` remain.
6. **Collapse leg**, on the two survivors: click `d.txt` (1 selected), then right-click `e.txt` — a row
   **outside** the selection. Assert the selection collapses to 1 (`expectCount(1)`, class **and**
   `aria-selected`) and that the menu's last item reads `Delete` with **no** count. Activate + confirm,
   then assert on the filesystem that `e.txt` is gone and `d.txt` **still exists** — i.e. the
   originally-selected row was not touched.
7. `shell.trashItem` is spy-able through the harness's `spyMain` — use it to assert the **call count**
   equals the target count and the argument set equals the target set, which pins the "loop over the
   single-path IPC" contract independently of the filesystem assertions.

**D. Architecture canvas.** Unit coverage of the menu builder for the multi case (B above) is the
gate. `test/e2e/arch-node-graph.e2e.mjs` **can** be extended — it already drives the real canvas — with
a short leg: Ctrl-click a second node, right-click one of the two, assert `Delete 2 components` in the
menu, activate, assert both nodes are gone from the canvas. Flagged as **should**, not must, for
Lane 2 (LITE): the canvas selection is React Flow's and marquee/Ctrl-click timing is the flakiest part
of that suite, so if the leg proves flaky it is dropped rather than retried into the gate.

**E. Manual smoke (nice-to-have, not a gate).** The clipboard *join* is gated by B; what B cannot
prove is that the OS clipboard actually receives it. Multi-select 3 files, `Copy path`, paste into an
editor, eyeball 3 lines. Also eyeball the disabled menu-item contrast in Neon (§13).

## 15. Assumptions

- **`shell.trashItem` handles directories** as it does today; a folder in a bulk selection is one
  `remove` call, and its children are not enumerated (the nested-target de-dupe in §6 exists precisely
  so children are never also targeted).
- **`Open` with N selected opens files as permanent tabs**, not preview tabs — a preview tab replaces
  in place, so N previews would leave exactly one tab open and silently discard the other N-1, which is
  the same class of confusion this spec exists to remove. A folder among the targets is **expanded**,
  not skipped: skipping it would be the silent narrowing §2 forbids, and expand is already the folder's
  Enter behaviour, so `Open` acts on every target.
- **The clicked node's kind picks the menu variant** (file vs folder) even in a mixed selection;
  building a hybrid menu would be a new menu shape, i.e. new scope.
- **`ContextMenu` renders `disabled` items greyed and inert already** (`Paste into folder` proves the
  path). No component change is needed to make disabling visible.
- **Menu builders can be extracted to pure functions** for the array-level unit tests without changing
  rendered output. If an extraction proves invasive, the e2e (C) covers the same assertions at higher
  cost; the unit tests are preferred.
- **Sequential deletion is fast enough.** These are local `shell.trashItem` calls; a parallel loop would
  buy little and make the failure report non-deterministic.
- The two lanes can be built and shipped independently once `src/menu-selection.ts` exists; Lane 2 has
  no other dependency on Lane 1.

## 16. Decisions Needed (autonomous mode — resolved as assumptions, none blocking)

- **[normal] #1 — Does bulk delete record undo entries?** **Default taken: no.** The brief originally
  stated `onDeleteFile` calls `recordFsOp`; it does not — `webview/app.tsx:1670` never calls it, and
  `webview/fs-undo.ts:6-10` defines only `create | rename | move | copy`. Deletion is **deliberately**
  outside the undo model and the Recycle Bin is the recovery path. Adding a `delete` op would be new
  scope with a real design question (undoing a trash requires restoring from the bin, which the host
  has no API for). Reversible.
- **[normal] #2 — Permanent-delete fallback when several items fail to reach the Recycle Bin.**
  **Default taken: one aggregated confirm** listing the failures, after the loop completes — not one
  dialog per failed item. Preserves the N=1 behaviour exactly. Reversible.
- **[normal] #3 — How many names does the delete confirm list?** **Default taken: 5, then
  `…and <N-5> more`.** The confirm is a fixed-size modal with no scroll region; an uncapped list would
  overflow it. Reversible (it is one constant).
- **[normal] #4 — Should `Open` be selection-scoped, and is it capped?** **Default taken:
  selection-scoped, uncapped, opened as permanent tabs.** VS Code opens all selected files on Enter.
  A cap (e.g. "opening 40 files") is a plausible follow-up but inventing a threshold now is guesswork.
  Reversible.
- **[normal] #5 — Does the N>1 delete confirm default focus to Cancel (`focusCancel: true`)?**
  **Default taken: yes for N>1, unchanged (confirm-focused) for N=1.** A bulk destructive action should
  not be one stray Enter away; the single-file case keeps today's ergonomics. `focusCancel` already
  exists on `ConfirmState` (no component change), and the choice is asserted in §14 C, so it is a
  decision that ships verified rather than a hedge. Trivially reversible.
- **[normal] #6 — Menu variant for a mixed file/folder selection.** **Default taken: the clicked node's
  kind decides the variant.** Building a third hybrid menu shape is new scope. Reversible.
- **[normal] #7 — Nested targets (a folder plus a file inside it).** **Default taken: de-dupe to
  top-level targets before the loop**, reusing `topLevelPaths` (`src/drop-intent.ts`) exactly as
  `cutPaths`/`copyPaths` and the drag path already do.
  The alternative (let the child fail ENOENT) would report a spurious failure for a file the user did
  in fact delete. **The de-dupe runs at menu-open, before the count is taken** (§4.1), so the label,
  the confirm and the announcement all quote the same N; de-duping later would show `Delete 2 items`
  and announce `Deleted 1 item`. Reversible.
- **[normal] #8 — Does the Explorer gain Shift+F10?** **Default taken: no.** It has none today; adding
  keyboard menu invocation to the tree is a separate a11y feature (and the tree also has no keyboard
  multi-select, so the two belong together). The invariant still states the rule for surfaces that do
  support it. Deferred, not silently dropped.
- **[normal] #9 — Arch canvas e2e leg: required or optional?** **Default taken: optional (should).**
  React Flow marquee/Ctrl-click is the flakiest part of `arch-node-graph.e2e.mjs`; unit coverage of the
  builder is the gate for a LITE lane.

- **[normal] #10 — Should the arch node menu's Delete also remove selected *edges*?** **Default taken:
  no — the node menu targets nodes** (§2's precision clause, §5). `selectedIds` is fed from
  `onSelectionChange` and holds node ids only; extending it to carry edges, and deciding the mixed-noun
  label (`Delete 5 items`?), is more design than a LITE lane should absorb. Consequence, stated openly:
  an edge selected alongside nodes and incident to none of them survives the menu delete, while the
  Delete **key** removes it. That residual asymmetry is the price of keeping Lane 2 small; if it reads
  as a bug in use, the fix is to track edge selection and switch the noun to `items` when the selection
  is mixed. Reversible.

No `high`-severity decisions: every choice is additive, local, and reversible; none changes the data
model, the IPC protocol, or the canonical menu convention.

## 17. Self-audit

This spec was reviewed by an independent read-only pass against the template checklist. That pass
found ten internal contradictions and four coverage gaps; **all were fixed in place**, and the
material ones are recorded here rather than quietly patched, because each was a real defect a builder
would have hit:

| Found | Fix |
|---|---|
| `countLabel(verb, n, plural)` could not produce both `Delete component` (n=1) and `Delete 3 components` (n>1) — no argument set satisfied both | Signature takes the **whole singular label** plus `{verb, noun}` (§3.1) |
| Five other count-bearing strings could not use it; `Deleted 1 items` was reachable | Added `countNoun`; **every** count↔noun pair routes through it (§3.1, §4.3, §12) |
| `Open` "skips folders" — the silent narrowing §2 forbids | `Open` acts on **every** target: files open, folders expand (§4.2, §15) |
| Nested-target de-dupe ran *after* the count, so the label and the announcement could disagree | De-dupe moved to menu-open, before `n` (§4.1, #7) |
| Permission-denied declared N/A while the whole failure path is permission-shaped | Now a catalog row (§10) |
| "Every pointer path has a keyboard path" contradicted §9's own admission that the Explorer selection is pointer-only | Replaced with an explicit complete/incomplete split (§11) |
| Arch node+edge selection "counts nodes only" vs. "acts on the whole selection" | §2 gained a precision clause (menus target a stated kind); the residual asymmetry is flagged as #10 |
| `focusCancel` was a hedge in §12 and a decision in §16, asserted nowhere | Committed, noted as an existing `ConfirmState` field, asserted in §14 C |
| "Byte-identical to today" named no baseline; the clipboard criterion had no automated observer; the collapse criterion asserted a frame-ordering claim | All three restated observably (§8, §14 B/C) |
| Empty-after-action, limit-reached and page-level-error missing from the catalog; "both themes" (there are three) | Rows added / N/A justified (§10); Aero, Aero Dark, Neon named with a Neon contrast check (§13) |

Core spine: problem frame ✓ (incl. the surface survey that justifies exactly two lanes) · behavior &
states ✓ (the invariant, stated once, plus per-surface classification tables) · data/interface contract
✓ (`src/menu-selection.ts` signatures + the explicit "nothing else changes" list: IPC, `MenuItem`,
`fs-undo`) · edge cases ✓ (17 rows incl. zero/one/many, partial failure, stale targets, nesting,
concurrency-under-the-open-menu) · defaults vs. settings ✓ (8 rows, each with a rationale, none
configurable — consistency *is* the feature) · scope slicing ✓ (two lanes with tiers + an explicit
out-of-scope list carrying every stated non-goal) · acceptance criteria ✓ (declarative + EARS +
Gherkin). UI module: state catalog ✓ (N/A states justified inline, not omitted) · interaction inventory
✓ · accessibility & i18n ✓ (the count label and `aria-disabled` are the two perceivable scope signals;
focus-after-delete named; the plural form isolated in one pure function as the future i18n seam) ·
design tokens ✓ (none added; explicitly defers to the interaction-state vocabulary for `disabled`).
Verification ✓ (pure units, menu-array units incl. the clipboard join and a literal no-regression
baseline, a real-app filesystem-asserting e2e with the `spyMain`/renderer-dialog gotchas named, arch
coverage scoped to LITE). Ten `normal` decisions flagged, zero `high`. No section left empty or padded.

**Known limits, not omissions:** keyboard users cannot *build* an Explorer multi-selection (pre-existing
gap, deferred with #8); the arch node menu leaves an unrelated selected edge behind where the Delete key
would not (#10). Both are named at the point they bite, not buried.

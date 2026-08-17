# Queued decisions & blockers

Decisions the conductor resolved without a human (autonomous run) and gaps deliberately left for
the user to rule on. Nothing here blocked the build.

## Resolved as assumptions (conductor call)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | With N>1 selected, should single-target items (Rename…, Open with…, Paste into folder, …) stay enabled and act on the clicked row, or be disabled? | **Disabled while N>1.** | An enabled "Rename…" that silently renames 1 of 5 selected files is exactly the confusion being reported. `docs/specs/2026-07-06-arch-context-menus.md` had already chosen this for the canvas; applying it to the explorer keeps one rule. |
| D2 | Should every selection-scoped label carry a count ("Copy 3 paths")? | **Only the destructive one** — `Delete 3 items`. | Scope on the safe items is already communicated by the enabled/disabled split; a count on every label is noise. Destructive scope must be unmistakable. |
| D3 | Bulk delete: new batch IPC, or a client-side loop over the existing single-path `fs-mutate`? | **Client-side loop.** | The repo already loops for multi-path move/copy (`runBatch`, `right-pane.tsx:907`). A batch IPC would duplicate the path-guard trust boundary for no gain. |
| D4 | `Copy path` with N selected — join with what? | **`\n`** | VS Code behaviour. |
| D5 | Should `Reveal in Explorer` reveal all N? | **No — single-only, disabled at N>1.** | Revealing N paths spawns N OS windows; hostile. |

## Deferred — needs a product call, NOT built in this run

| # | Gap | Note |
|---|---|---|
| P1 | The explorer tree has **no keyboard multi-select**: `onTreeKeyDown` (`right-pane.tsx:1215`) bails on any modified key except Ctrl+X/C/V, and every arrow/Home/End collapses to one row via `focusRow` → `selectOne`. So there is no Ctrl+A and no Shift+Arrow — a keyboard-only user cannot build a multi-selection at all, which means the fixed menu is unreachable for them. Real gap, but it is *adding* selection capability rather than fixing menu scope, so it is out of this run's stated scope. Recommend building it next. |
| P2 | Right-clicking an editor tab or a session card does **not** make it active. Left as-is — VS Code behaves the same way, and every item in those menus is already scoped to the right-clicked object rather than to the active one, so nothing acts on the wrong target. Flagging only because it looks like the same class of bug and is not. |
| P3 | Feature board cards and the git change list have **no selection model at all**. Multi-select there would be greenfield (new state, new gestures, new a11y), explicitly a non-goal here. If the user wants "select several cards → right-click → delete", that is a separate feature. |

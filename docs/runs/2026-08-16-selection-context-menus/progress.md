# Progress ledger

## Phase 0 — grounding (DONE 2026-08-16)

- `npm run verify` baseline: **green**. (One run showed `conduit-proposal-fs.test.ts` timing out at
  5000 ms — reproduced as a load flake from three concurrent verify processes; the file passes in
  68 ms run alone. Not a pre-existing defect.)
- e2e harness present: `node test/e2e/run-smoke.mjs <name>`; extension points
  `explorer-multiselect.e2e.mjs`, `context-menu-order.e2e.mjs`.

## Surface inventory (DONE 2026-08-16) — two independent read-only sweeps

Surfaces that have BOTH a real multi-selection AND a context menu — the only places the bug can exist:

| Surface | Multi-select | Menu scope today | Collapse-on-outside-right-click |
|---|---|---|---|
| Explorer tree (`right-pane.tsx`) | yes (ctrl/shift click) | **Cut/Copy honour the selection; Delete, Copy path, Copy relative path, Rename, Open do NOT** | yes (`right-pane.tsx:1075`) |
| Architecture canvas (`architecture-view.tsx`) | yes (React Flow ctrl+click / marquee) | **Group + Encapsulate honour it; Delete component does NOT** | **no** |

Surveyed and ruled out — these have **no selection model at all**, so single-target is correct, not a bug:

| Surface | Selection state | Verdict |
|---|---|---|
| Editor/doc tabs (`doc-tabs.tsx`) | one `activeId` | single-target correct; close-others/left/right are positional, not selection-based |
| Sessions sidebar (`sidebar.tsx`) | one `activeId` | single-target correct |
| Feature board cards (`board-view.tsx`) | none | no selection concept at all |
| Git change list (`right-pane.tsx` ChangeRow) | none | per-file items + repo-wide bulk ops |
| Git history commits (`git-history-view.tsx`) | one `selectedSha` | **no context menu at all** |
| Terminal / Monaco / markdown | text selection | content menus, not object menus |
| Panel frame / top bar / center pane | none | chrome menus |

Known related gaps, deliberately NOT in scope (see blockers.md): explorer has no keyboard
multi-select (no Ctrl+A, no Shift+Arrow); right-click does not activate a tab or session (matches
VS Code, left as-is).

## Phase 1 — spec (DONE)

`docs/specs/2026-08-16-selection-aware-context-menus.md` (tier FULL, two lanes). Committed `a0444c3`.
Ten decisions resolved as assumptions, none blocking — tabulated in `blockers.md` and the spec's §16.
The spec's own §4.1 snippet had a real bug (de-duped nested targets *before* the membership test, so
right-clicking a selected file inside a selected folder would have collapsed the selection); caught
at build time and fixed in the implementation, pinned by a test.

## Lane 1 — Explorer (DONE, verified, committed `d239933`)

| Item | Evidence |
|---|---|
| `src/menu-selection.ts` — the shared rule | `test/unit/menu-selection.test.ts` |
| `src/delete-confirm.ts` — pure confirm/announce copy | `test/unit/delete-confirm.test.ts` |
| `webview/explorer-menu.tsx` — pure menu builder (extracted from ~90 inline lines) | `test/unit/explorer-menu.test.ts` |
| Bulk delete, keyboard Delete, focus rescue (`nearestSurvivor`) | `test/unit/file-tree.test.ts` |
| **Real-app end-to-end** | `test/e2e/explorer-multiselect-delete.e2e.mjs` — **PASS (36.9s)** |

`npm run verify`: **green — 196 files, 2733 tests** (baseline 2684, so +49).

The e2e is not a vacuous pass: it selects 3 of 5 files, asserts the selection survives under the open
menu, asserts the menu's last row reads `Delete 3 items` with `danger` + `separatorBefore` and that
`Rename…` is disabled, asserts the confirm counts + lists the names and opens with **Cancel** focused,
then asserts against the **real filesystem** that exactly a/b/c are gone and d/e survive, and that
`shell.trashItem` was called exactly 3 times with those paths. The collapse leg then right-clicks a
row outside the selection and proves only that row is deleted.

### Incidental fix (committed separately, `5eac96e`)

`npm run verify` was **already red on `main`** at the audit gate — a high-severity advisory against
`nanoid` 3.3.17. It reaches the repo only via vitest → vite → postcss, so it is dev-only and never in
the shipped bundle, but it fails `npm audit --audit-level=high`. Bumped to 3.3.18; lockfile-only,
semver-compatible, `node-pty` untouched. The gate's threshold was **not** changed.

This was initially mis-read as a green baseline: the first baseline run was piped through `tail`
(which returns tail's exit code, masking the failure) and the second died earlier on a load-induced
test flake. Both mistakes are now recorded as memory notes.

## Lane 2 — Architecture canvas (DONE, verified, committed `f50cea1`)

| Item | Evidence |
|---|---|
| `buildArchNodeMenuItems` + `resolveArchNodeTargets` (pure, mirrors the Explorer builder) | `test/unit/arch-node-menu.test.ts` (19 tests) |
| Collapse on outside right-click; selection-scoped `Delete N components` in one `applyDoc`; single-only items disabled | `test/e2e/arch-multiselect-delete.e2e.mjs` — **PASS (20.4s)** |
| **Ctrl+click multi-select fix** (unspecced; found by the e2e) | same scenario — its ctrl-click leg fails without the fix |

`npm run verify`: **green — 197 files, 2752 tests**.

## Phase 6 — integrate (DONE)

Spec archived per ADR 0003, INDEX row moved to the Archived table, CHANGELOG `[Unreleased]` written,
report at `report.md`. Merged to `main`.

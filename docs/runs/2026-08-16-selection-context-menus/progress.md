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

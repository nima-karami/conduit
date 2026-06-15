# Run report — Wishlist round 6 (2026-06-15)

Autonomous build loop over the 10 captured `docs/wishlist.md` items. Serial on
`main` (the webview is one tightly-coupled SPA; parallel worktrees would collide on
shared entry files). Every feature: pure-logic unit tests where applicable + a
**real-runtime** Playwright-Electron check (not the mock preview) + `npm run verify`
green, committed one at a time.

Final gate on the integrated tree: `npm run verify` exit 0 · **901 tests** · no code
duplication · `test/e2e/paste.e2e.mjs` PASS. The 2 remaining `npm audit` advisories
are the pre-existing **moderate** DOMPurify-via-monaco ones (below the `--audit-level
=high` gate; carried over, see blockers).

## Shipped (9) — with commit SHAs + evidence

| Item | Commit | Runtime evidence |
|---|---|---|
| `'Toggle Explorer'` → `'Toggle explorer'` | `a83d109` | verify |
| Interface font-size setting actually resizes UI text | `a09ce0f` | `.panel-title` 10→12.5px (×1.25) |
| Ctrl/Cmd +/−/0 zoom terminal + editor font | `7ef205d` | term 13→16 persisted; editor `.view-line` 13→16 |
| Copy/paste everywhere (terminal keyboard copy) | `c32833d` | Ctrl+Shift+C token round-trip; paste e2e green |
| Markdown rendered-view context menu | `3a6a62a` | `["Copy","Select All"]`; selLen 2678; copy round-trip |
| Session name syncs to terminal title (OSC 0/2, live /rename) | `4747cc2` | name conduit→CLAUDESYNCTEST→RENAMED2 live |
| Session icon adopts app glyph from title | `d4b1e08` | `appIcon` null→'claude' from title |
| Terminal/session tab right-click menu | `ac9bb0c` | menu shows 5 items; Duplicate 1→2 |
| Select-to-mention (editor v1) | `ba3408b` | select L1-3 → `@package.json#L1-L3` typed in |

Supporting commit: `fdedb6a` — extract `refitVisibleTerminal` (removed a fallow
clone introduced by the zoom effect).

## Needs human smoke (1)

- **focus-restore-flash** (`e9ea878`) — `webPreferences.backgroundThrottling = false`
  (confirmed applied; boot-smoke green, survives minimize/restore, 0 console errors).
  The visual flash absence is GPU/timing-dependent and can't be observed headlessly —
  please minimize for a while, restore, and confirm. If it persists, next steps are
  noted in `.autoloop/blockers.md`.

## Decisions surfaced for you (not blocking)

- **select-to-mention** shipped as a thin **editor-only v1** (`@path#Lx-Ly` ref into
  the active terminal). Open choices: ref-only vs. also pasting the selected text vs.
  a Cursor-style context panel; markdown-view support (no line numbers in the rendered
  DOM); multi/split-terminal target picker; add a keyboard shortcut. See blockers.md.
- **Title-sync**: terminal title drives the name only while auto (manual rename locks);
  cwd-path / folder-name titles are ignored so plain shells keep their default.
- **Icon detection** uses the OSC title, not live process-tree inspection (consistent
  with the 2026-06-11-runtime-icon ADR).

## Notes

- Verification crossed the real PTY/IPC boundary for every host-touching feature
  (title/icon sync, copy/paste, tab menu, mention) via `_electron.launch` against the
  built app with a throwaway `--user-data-dir`.
- No gate was weakened; the duplication gate caught and forced a real refactor
  (`fdedb6a`) rather than being suppressed.

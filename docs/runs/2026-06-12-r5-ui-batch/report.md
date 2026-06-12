# Run report — Round 5: UI bug batch (2026-06-12)

Conductor: Opus (taste-gatekeeper, conductor-direct — these are small, taste-critical
UI fixes that fit one context; no subagent fan-out). All landed on `main`; verify green
end-to-end and every UI change confirmed in the running webview (Playwright over the HTTP
preview), not by assertion.

## Shipped (8 items, 2 commits)

Commit **e7e73da** — `fix(ui): R5 UI bug batch`:

| ID | Bug | Fix | Evidence |
|----|-----|-----|----------|
| R5.1 | Review Changes tab broken: not scrollable with many files, redundant inner X, weak per-file diff/expand | `.review` was `position:fixed` (an R3 overlay) and escaped the editor tab, painting over the side panels → made it `position:absolute; inset:0` so it embeds in the doc area and scrolls its own body. Removed the inner close button (the tab strip's X already closes it). Folds now carry their real hidden lines (`review-hunks.ts`) and expand up / down / all in place (GitHub-style) instead of a dead placeholder. "Open file" kept. | Playwright: `position=absolute`, 10 cards render, `foldWorks=true`, no inner `.review__close`, scroll `overflow-y:auto`; screenshot `r5-1-review.png` |
| R5.2 | Search/Filter boxes highlight the inner field, not the box | `.searchbox:focus-within` lights the box border + ring like the omnibar; inner input's own `:focus-visible` ring suppressed | computed box-shadow on box, `none` on input |
| R5.3 | "EXPLORER" label + divider; bar unlike Changes | Dropped the `panel-title` + `border-bottom`; New-file/folder controls → `iconbtn--sm`; `.files__bar` matches `.changes__header` padding/min-height | no `.panel-title`, 2 `iconbtn--sm`, `border-bottom:0px` |
| R5.4 | No menu on empty sessions body | `onContextMenu` on `.sidebar__scroll` → New session / Close all sessions; `preventDefault` beats the panel layout menu, cards still beat it | menu items `['New session','Close all sessions']` |
| R5.5 | Header button icons not centered | Root cause: UA `<button>` padding `1px 6px` shrank the grid content box below the icon width → icons left-skewed ~2px. Fix: `.iconbtn { padding:0 }` | Playwright `dxCenter` 2/1.5 → 0/0 |
| R5.6 | Can't drop a tab past the last tab | Trailing `.tabbar__tail` drop zone → `onReorder(dragId, null)`; `moveBefore(…, null)` (move-to-end) is already unit-tested | tail present, `flex-grow:1` |
| R5.7 | Layout menu "Hide/Show X" redundant with checkmark | `buildPanelToggleItems` label = bare panel name; check glyph alone signals visibility; unit tests updated | menu items `['Sessions','Explorer']` |

Commit **c624632** — `chore(deps): npm audit fix`:

| ID | Item | Note |
|----|------|------|
| R5.8 | esbuild high-sev advisory tripped the `--audit-level=high` gate | Upstream advisory drift (GHSA-g7r4-m6w7-qqqr), not a code change here — the session-start baseline passed audit. Non-breaking patch bump esbuild 0.28.0→0.28.1 (lockfile only); rebuilt + full verify green after. |

## Deferred / queued for the user (see `.autoloop/blockers.md`)

- **DOMPurify moderates** via `monaco-editor@0.55.1` → `dompurify@3.2.7`. They're
  *moderate* (below the high gate; verify/CI green), and the only audit-fix is a breaking
  monaco downgrade or an untested `overrides` bump to dompurify 3.4.10 — too risky to land
  autonomously. Surfaced so the user can bump monaco or add a tested override deliberately.

## Verification

- `npm run verify` → exit 0: biome clean, both tsconfigs typecheck, **869 tests pass**,
  0 duplicated lines, `--audit-level=high` clean (esbuild patched), security scan.
- `npm run build` → exit 0 (esbuild bundle, including the patched esbuild).
- Runtime: Playwright DOM assertions + screenshots over the HTTP preview for R5.1–R5.7;
  **0 console errors**. Scratch artifacts kept in `%TEMP%\claude-scratch` only.

## Notes

- Not pushed — local commits on `main`, awaiting the user's go (the run's established
  pattern). `origin/main` is one behind: `e766395 → e7e73da → c624632`.

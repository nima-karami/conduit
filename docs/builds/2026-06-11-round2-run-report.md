# Autonomous build-loop — round 2 run report (2026-06-11)

Drove the round-2 Conduit wishlist (`docs/wishlist.md`, groups H/I/J) to verified
completion. **9 items shipped, 0 blocked, all merged to `main`.** Each ran in a
fresh-context subagent (spec → build → verify); LITE items built straight from the
spec, the two FULL UI items got the heavier treatment, and the one trust-boundary
item (I2) had its security core reviewed by the conductor. Every item was verified
behind `npm run verify` + `npm run build` and, for UI, exercised with Playwright
(screenshots to temp, never committed).

- **9 items merged to `main`** (one feature per commit; J3 took two), tip `41115ab`,
  `npm run verify` green.
- Unit tests grew **215 → 302** on `main` (+87 across the round).
- **Base decision:** the user chose to keep round 2 on plain `main`; the
  `autoloop/conduit-northstar` branch was left untouched (not merged, not discarded).

## Shipped to `main` (9)

| Item | Commit | What |
|---|---|---|
| J1 switcher-icons-only | `22798cb` | Top-bar view switcher is icon-only (labels removed; a11y title/aria kept) |
| J2 ctx-menu-position | `2097a5f` | Context menus open at the pointer / anchored to their trigger |
| J3 close-all-startstate | `36f43a6`,`ea9c5dc` | Closing all sessions → initial start state, not a black screen |
| J4 close-all-others | `6a445c1` | "Close all sessions" + "Close others" actions |
| J5 explorer-refresh | `e54b0f0` | Explorer file tree refreshes on focus/visibility (no tab-toggle) |
| H1 settings-sections | `b2beb04` | Appearance settings grouped into 5 meaningful sections |
| H2 settings-live-preview | `da54670` | Live preview box for background / intensity / surface opacity / blur |
| I1 terminal-codeblock-color | `91935a6` | One color drives both the code-block AND terminal background |
| I2 editable-code | `41115ab` | Editable Monaco + save-to-disk over a path-confined write IPC |

## Notable engineering

- **J2 — one root cause, not two.** The editor-offset AND the centered three-dot menu
  were the same bug: `backdrop-filter: blur(...)` on the panels establishes a CSS
  containing block, so the inline-rendered menu's `position: fixed` resolved against the
  panel box instead of the viewport. Fixed once by portaling the menu to `document.body`.
- **J3 — the real black screen.** Beyond the centerView reset (Board/Canvas overlay left
  over an empty workbench), the literal black screen was a crash: `TerminalPane`'s xterm
  WebGL addon `dispose()` throws `Cannot read '_isDisposed' of undefined` on unmount, and
  with no error boundary that blanked the whole React root. Added a guarded dispose helper
  (`safe-dispose.ts`) + an error boundary with a non-black fallback. The repro confirmed the
  crash now fires-but-is-caught.
- **I2 — the write IPC is a trust boundary.** `src/path-guard.ts` does two-stage
  containment: lexical (`path.resolve` + trailing-separator prefix, rejecting `..`,
  absolute-outside, and the `/work` vs `/work-evil` sibling case) then real-path
  (`realpathSync.native`, walking up to the nearest existing ancestor so a symlinked parent
  can't escape). Atomic temp+rename write keeps the buffer dirty on failure. The conductor
  read the guard directly and confirmed it before merging; 17 path-guard tests pin the
  escape matrix.

## Decisions taken autonomously (recorded, not asked)

- **I2 editable-code:** real save-to-disk (Ctrl/Cmd+S via a new host write IPC), not an
  ephemeral buffer. Degrades to a safe no-op + "saving unavailable in preview" banner when
  `window.agentDeck` is absent.
- **I1 terminal color:** unified — one `surfaceColor` key (migrated from `codeBg`) drives
  both surfaces; share the COLOR but not the opacity (the terminal keeps the panel alpha for
  legibility).
- **H2 preview fidelity:** surface-opacity + blur are pixel-exact to the real surfaces;
  background type/intensity are a documented static approximation of the live WebGL shader.
- **J5 fix level:** renderer-only re-fetch on window focus/visibility (deliberately no host
  `fs.watch` — Windows quirks), reconciling the tree while preserving expansion state.

## Needs manual confirmation in the real Electron app

The browser preview can't exercise the host bridge / PTY / FS. These were unit- + build- +
typecheck-verified and Playwright-driven where possible, but want a hands-on pass:
- **J1:** the 28px icon buttons next to the window controls (cosmetic).
- **J2:** right-click an open file under a blurred theme — menu sits under the cursor.
- **J3:** open a real session, switch to Board, close it → editor start state, no black screen.
- **J4:** several real sessions → Close others / Close all → real PTY teardown, no black screen.
- **J5:** alt-tab back to the window after an external write — tree picks up the new file.
- **I1:** live recolor of a real PTY-backed xterm canvas.
- **I2:** the full edit → Ctrl+S → file-on-disk → dirty-dot-clears loop.

## Known pre-existing (not introduced this round)

- A `validateDOMNesting` warning in `DocTabs` (a close `<button>` nested inside the tab
  `<button>`) — surfaced during I2, predates it, left in scope.

## State

- Ledger: `.autoloop/` (gitignored) — `tasks.yaml` round 2 all `done`, `blockers.md` empty.
- Round 1 (groups A–G) report: `docs/builds/2026-06-11-run-report.md`.
- Not pushed (local commits only) — awaiting the user's go to push `main`.
- `board.json` (shared agent state) left modified/untouched throughout, per project rules.

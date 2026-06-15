# Run report — Wishlist round 7 (2026-06-15)

Autonomous build loop over 6 new wishlist items, run as a true **conductor**: a
parallel investigation wave, a parallel build wave for disjoint work, a serial
lane for the coupled session cluster, and a delegated build for the big UI feature
— with the conductor (Opus) gatekeeping every merge and **driving the real built
app** for the marquee items.

Final gate on the integrated tree: `npm run verify` exit 0 · **945 tests** · no code
duplication. Real-runtime gatekeeping via Playwright-Electron against the built app.

## How it was orchestrated

- **Wave 0 — investigation (4 parallel read-only agents):** mapped root causes +
  file lists + collision points for all 6 items. Zero tree risk.
- **Wave A — parallel build (2 worktree agents):** the two fully-disjoint host
  fixes (`pty-host.ts`, `project-info.ts`) built + self-verified in isolated
  worktrees, then cherry-picked onto `main` and re-verified together.
- **Wave B — serial session cluster (conductor on `main`):** 6a → 4 → 3 share
  `session-manager`/`app.tsx`/`docs` so they were serialized, each verified +
  committed individually.
- **Wave C — delegated big UI build (1 worktree agent) + conductor gatekeeping:**
  the Files/Search merge built by a subagent, integrated by the conductor
  (`styles.css` auto-merged clean), then **gatekept live** (14/14 checks +
  screenshots reviewed for taste).

## Shipped (6) — commit SHAs + evidence

| Item | Commit | Evidence |
|---|---|---|
| Claude Code no longer detects Cursor | `ce17a82` | `sanitizeChildEnv` strips `TERM_PROGRAM`/`VSCODE_*`/`CURSOR_*` from child PTY env; 9 unit tests |
| Git stats count added/deleted/untracked files | `2d2d838` | **real app 3/3**: `del.txt` D −3, `new.txt` U +4, `base.txt` M +2 (were 0/0); 20 unit tests |
| CLI `/rename` always overrides the session name | `95877a4` | dropped the `autoTitle` lock; override unit test; cwd/folder titles still ignored |
| Closing a session closes its editors | `a0192fa` | `OpenDoc.sessionId` ownership + `closeSession` reducer + session-removal effect; 3 unit tests |
| Terminal tab adopts the session's app icon | `958dc4d` | `iconForSession` threaded CenterPane→DocTabs→SessionGlyph (tab + overflow); sweep confirms glyph |
| Merge Search into the Files tab (+folder-target, collapse, refresh) | `7ce968e` | **real app 14/14** + screenshots; 4 pure helpers + 15 unit tests |

## Real-runtime gatekeeping (drove the built app)

- **Files/Search merge (14/14):** tab bar = Changes\|Files (no Search); search box
  first; typing a query hid the tree and showed "699 results in 218 files"; a folder
  click highlighted the row; clicking a file deselected; collapse/refresh/new
  buttons present; no "EXPLORER" label. Screenshots reviewed — clean, on-design,
  matches the Changes header styling.
- **Git stats (3/3):** a temp git repo with a modified, an untracked, and a deleted
  file rendered the correct +2 / +4 / −3 in the Changes panel.

## Decisions surfaced for you (not blocking)

- **6b — rename Conduit → Claude Code (DEFERRED, needs your call).** You asked, "if
  possible," to have a right-click rename also rename the running Claude Code
  session. Doing this means injecting `/rename <name>\r` into the live PTY, which is
  a **footgun**: it clobbers half-typed input and only makes sense if Claude Code is
  actually running and idle at its prompt — and there's no reliable signal for that.
  I did **not** ship a blind keystroke injection. If you want it, I'd gate it behind
  an explicit "Sync name to CLI" menu action (not automatic on every rename).
- **CLI-/rename policy tradeoff.** Because we cannot distinguish a deliberate
  `/rename` from any other OSC title, a meaningful in-terminal title now **always**
  wins — including an app's *ambient* title overriding a manual rename. This is the
  direct consequence of "/rename must always win." Reversible in one line if you'd
  rather keep a stronger manual lock with a narrower override.
- **Close-session scope.** Implemented the targeted fix (a session owns the docs it
  opened; closing it closes them). Editor tabs are still globally visible while
  sessions are alive (VS Code-like). Full per-session tab *swapping* (switching
  sessions hides the other's tabs) is a larger redesign — flagged, not assumed.

## Quick human smokes (low risk; gate + unit verified)

- **close-session-closes-docs** (`a0192fa`): open files under session B, close B —
  B's tabs should vanish, A's stay. (Reducer is unit-tested; the wiring is simple.)
- **CLI /rename** (`95877a4`): `/rename` inside Claude Code should now update the
  session name even after a manual rename.
- **app icon** (`958dc4d`): a session running Claude Code should show the Claude
  glyph on its terminal tab (the SessionGlyph path is confirmed; the exact Claude
  glyph needs a live Claude title to see).

## Notes / honesty log

- **No gate weakened.** The duplication gate caught a 16-line clone my git-stats
  integration introduced; I extracted a `pushSide` helper rather than suppress it.
- **A worktree mistake, owned and fixed.** A Wave-A worktree used a `node_modules`
  *junction* to main's deps; `git worktree remove --force` followed the junction and
  emptied main's `node_modules`. Restored via `npm ci`, and the later electron binary
  gap was restored via electron's install script (your environment is whole). Lesson:
  isolated worktrees must run a **real `npm ci`**, never a junction — applied for
  Wave C.
- Carried-over: 2 moderate DOMPurify-via-monaco advisories remain below the
  `--audit-level=high` gate (unchanged this round).

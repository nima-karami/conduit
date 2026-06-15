# Run report — Wishlist round 8 (2026-06-15)

Autonomous build loop over 4 user-reported papercuts, run **solo** (the conductor
built inline rather than fanning out to subagents): the backlog was four small,
in-context fixes and the user asked to be mindful of usage limits, so re-paying the
exploration context per subagent wasn't worth it. The conductor still held the line on
TDD, per-item `npm run verify`, a commit per item, and real-renderer runtime
observation for the UI items.

Final gate on the integrated `main` HEAD (`eefcfe9`): `npm run verify` **exit 0 ·
963 tests · 0 duplication**. Two UI items observed end-to-end in the real renderer
via a browser-preview Playwright drive (0 console errors).

## How it was run

- **Phase 0 — ground:** repo already has the one-command gate (`npm run verify`) and
  a runtime/observation harness (built webview served over HTTP + playwright-cli).
  Re-pinned the anti-gaming gate baseline (`.autoloop/gate-baseline.txt`).
- **Investigation (4 parallel read-only agents):** mapped root cause + file list for
  each item. Two items turned out to be the *direct consequence* of round-7 decisions
  (see below).
- **Build:** solo, sequential on `main`, TDD per item, `npm run verify` + commit each.
  All four items touch disjoint files, so no isolation/merge waves were needed.
- **Verify:** unit gates per item; one consolidated real-renderer sweep for the UI
  items via the preview (faithful where no host/PTY boundary is crossed).

## Shipped (3 done + 1 needs-human-smoke)

| Item | Status | Commit | Evidence |
|---|---|---|---|
| Tool command titles renaming the session ("npm run security") | **done** | `7a2cc1f` | 10 unit tests; verify exit 0 |
| Find-in-files ignores file/folder names | **done** (runtime-verified) | `d709a14` | 33 unit tests (+7); preview: name-only + folder-name matches with NAME badge |
| Editor tabs leak across sessions | **done** (runtime-verified) | `041c3a9` | 13 unit tests (+5); preview: tab isolated on switch, restored on return |
| Chat/terminal stuck mid-scroll on big paste | **needs-human-smoke** | `eefcfe9` | 4 unit tests; strictly-safe fix; symptom not autonomously reproducible |

### 1 · `tab-title` — `7a2cc1f`
`resolveTitleSync` now rejects titles that are a command invocation (a known command
head like `npm`/`yarn`/`pnpm`/`git`/… plus a command-like tail: a subcommand verb,
flag, path, or filename — or a bare command name). Genuine app titles (Claude Code,
`/rename`) and names that merely *start* with a command word ("Node project
dashboard") are still adopted. This closes the regression that round 7's
`cli-rename-wins` opened (any meaningful OSC title was made to win, so a runner's
ambient command title also won). Pure logic → unit-strong; 4 new test cases.

### 2 · `search-names` — `d709a14`
`searchContent` matches the query against each file's relative path, so a file or
folder **name** surfaces even with no content match (and even for binary/oversize
files we never scan), flagged `nameMatch`. The results panel highlights the matched
name (factored into a `Hilite` component to stay under the zero-duplication gate),
shows a "name" badge instead of a count, opens the file on click, and counts name
hits in the summary. Host reuses the same pure core, so no IPC change.
**Runtime:** preview drive — `package` → "1 result in 1 file" (package.json, NAME
badge, a name-only hit that returned nothing before); `lib` → "2 results in 2 files"
with the `lib` folder segment highlighted. Faithful because the preview bridge runs
the *identical* `searchContent` core.

### 3 · `editor-per-session` — `041c3a9`
The round-7 follow-up that was explicitly deferred ("tabs remain globally visible
while sessions live"). `DocsState` gains per-session active-doc memory
(`activeBySession`) and a `switchSession` action; `activate` takes an optional
`sessionId` (existing callers/tests still compile). The center pane renders only the
active session's docs; switching sessions restores that session's last view (its
active doc, or the Terminal) and validates ownership so a transferred-away doc falls
back to the Terminal. Tab/terminal context-menu close-ops and the "Close other tabs"
command are scoped to the active session. **Runtime:** preview drive — opened
README.md in "Portfolio Redesign", switched to "Terminal UI" (README.md tab gone),
switched back (README.md restored). Pure renderer state → preview is faithful.

### 4 · `chat-autoscroll` — `eefcfe9` — needs-human-smoke
`writeAndStick` captures whether the viewport was at the bottom *before* each terminal
write and re-pins via `term.write`'s completion callback when the user was following;
a deliberately scrolled-up user is left alone. The at-bottom decision is a pure,
unit-tested helper (`isViewportAtBottom`).

**Why needs-human-smoke, not done:** the reported bug is *intermittent* and specific
to real-PTY large-write timing (xterm's auto-follow mis-firing on a big/chunked
write). The browser-preview fake shell emits only tiny output, so the symptom can't be
reproduced — and thus the *fix resolving it* can't be observed — autonomously. The fix
is **strictly safe**: it only adds a `scrollToBottom()` after a write when the user was
already at the bottom (a no-op otherwise), so it cannot worsen normal scrolling, and
the full 963-test suite is green.

**Human smoke recipe:** in the real app, open a Claude Code session, scroll to the
bottom and stay there, then have it print a large block (a big file read/edit, or run
`seq 1 100000` / `cat <largefile>`). Expect the view to stay pinned to the bottom (no
manual End). Then scroll up mid-stream and confirm it does *not* yank you down.

## Decisions taken autonomously (no human to ask)

- **execution_mode = solo** (over the skill's default `delegated`): four small
  in-context fixes + the user's explicit usage-limit concern. Architecture/taste calls
  stayed with the conductor regardless.
- **`tab-title` heuristic** is a command denylist + invocation-shape check, not a
  perfect parse: it deliberately accepts a rare false-negative (a genuine title that
  reads exactly like a command line is dropped) over the false-positive of letting
  ambient command titles rename sessions. Reversible/tunable via the two sets in
  `src/session-title.ts`.
- **`editor-per-session` model**: kept the flat `docs[]` (each owns a `sessionId`) and
  added per-session active memory rather than rekeying docs by session — smaller blast
  radius, existing reducer semantics and tests preserved.

## Gate integrity

No gate was weakened. Existing tests were only *added to*; the one signature change
(`activate` gaining an optional `sessionId`) keeps all prior tests compiling and
green. Anti-gaming baseline pinned at Phase 0; `fallow` reports 0 duplication
(the `Hilite` extraction was specifically to avoid a clone).

## Follow-ups for the user

- **`chat-autoscroll`** — please run the human smoke recipe above to confirm the
  intermittent symptom is gone in the real app.

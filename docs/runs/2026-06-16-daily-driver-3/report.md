# Run report — Wishlist batch 3 (2026-06-16/17, "daily-driver-3")

Third autonomous build-loop pass toward making Conduit a **daily driver**. This batch drained
the four spec-ready W-items plus two LITE papercuts, and — most importantly — gave the loop
**eyes**: a reusable real-app smoke harness so host/PTY-boundary features verify themselves
instead of being deferred to `needs-human-smoke`.

Conductor (opus) held architecture + taste and the ledger; implementation was delegated to
fresh-context subagents, **sequential on `main`** (the items share `sidebar.tsx`,
`styles.css`, `right-pane.tsx`, `code-viewer.tsx`, `markdown-viewer.tsx`, `protocol.ts`,
`electron/main.ts`, `src/file-service.ts` — no parallel fan-out; the GUI smoke suite also
can't run scenarios concurrently). Two items (W2, D11) were implemented by the user / a
parallel Claude session and folded in by the conductor.

Final state: `npm run verify` **EXIT 0** (now **including `node esbuild.mjs`** — the standing
gate gap from batches 1–2 is **closed**). Unit suite ~1136 → **1273** (smoke harness,
quit-guard, sidebar-grouping, git-status-dots, media-kind, terminal-links tests added). The
real-app smoke suite is **9 scenarios green + 1 skipped**, run **hidden in the background**.

## Outcome

| Item | Status | Commit | Evidence |
|---|---|---|---|
| **W1** Real-app smoke harness + scenario port + **esbuild-in-verify** gate fix | **done** | `ee9a202` (+ `bed88b6`) | `test/e2e/harness.mjs` + `run-smoke.mjs` + 6 ported scenarios (paste/attention/reveal/dnd/cwd/durability) PASS + scrollback SKIP; `npm run test:smoke`; esbuild folded into `verify`+`verify.yml` |
| **W2** Quit/close/update-relaunch guard | **done** | `00c3b58` | pure `src/quit-guard.ts` (unit-tested) + main-process `close` interception + renderer confirm (no native dialog); `quit-guard.e2e.mjs` PASS (close/cancel/proceed/update/no-prompt-idle) |
| **D12** Update card pinned above the divider, overlaying the session list | **done** | `ab4f463` | sticky-footer CSS verified live in the mock preview (structural — mock has no update-available state) |
| **D13** Git-status dots (M/A/D/U) in the Files tree + folder rollup | **done** | `57aa23d` | pure `buildChangeMap` (8 tests: MM precedence, rollup, D>M>A>U); dots **seen** in preview (amber M, green folder-rollup) |
| **W3** Sidebar per-project collapse + universal drag (auto-switch to manual) | **done** (DnD part needs-human-smoke) | `f04561c` (+ `a40d2d6`) | `src/reorder.ts` helpers (23 tests); collapse + reload-persistence auto-verified; **DnD sort-flip = needs-human-smoke** (synthetic DragEvent can't carry DataTransfer into React handlers) |
| **W4** Image viewer (data URL, SVG) + mermaid in markdown | **done** | `061e865` | `src/media-kind.ts` + `FileContentDTO.image` + ImageViewer + Mermaid (statically bundled); `rich-content.e2e.mjs` PASS (png/svg render, mermaid svg, broken-diagram fallback) |

**Supporting commits:** `7137d31` (single canonical `test:smoke` + name filter + the
no-redundant-comments CLAUDE.md rule), `c99440c` (run the smoke suite **hidden** so it doesn't
pop up windows), `9a36687`/`dd19900` (archive shipped specs, drain wishlist).

**6 shipped · 1 residual needs-human-smoke (W3 DnD).** The W3 drag commit logic is fully
unit-tested; only the synthetic drag *gesture* can't be driven (canvas/React-ref hit-testing,
the same limit hit by sidebar DnD generally).

## Design decisions taken (conductor + user)

- **W1 is the loop's observation harness, not a UI feature.** Assertions observe the real app
  from outside via a main-process spy (`app.evaluate`) — zero production-code change except the
  one `verify`-chain edit. Build it first so every later host item verifies itself.
- **`verify` STRENGTHENED, not weakened:** `node esbuild.mjs` folded into the chain + CI. This
  closes the standing gate gap (a browser-unsafe import in shared `src/` used to pass `verify`
  but break the renderer bundle). Allowed because it *adds* a check.
- **W2 — NO native OS dialog (user decision).** A native `dialog.showMessageBox` is invisible
  to the Playwright smoke harness (the e2e hangs on it) and can stall the main loop (freezing
  PTYs). The guard uses the in-app `confirm-dialog.tsx` only; a wedged renderer falls through
  after a 3s timeout (proceeds) so the app is never unclosable. Spine in the main process
  (`close` event) covers custom ✕, OS Alt+F4/taskbar, and update-relaunch through one seam.
- **W4 — images as base64 data URLs** on the existing `readFile`→`fileContent` channel (no new
  Electron protocol); **mermaid statically bundled** into the IIFE (no CDN under CSP, like
  Lucide) — `out/webview.js` grows to ~22 MB, accepted per spec.
- **Smoke suite runs hidden** (`CONDUIT_E2E=1` → `show:false`) so it doesn't pop up windows;
  `attention` opts out (it needs a real focusable window). Verified paste's real Ctrl+V still
  delivers to a hidden window.
- **Opus-only subagents (user directive, mid-run).** A Sonnet build subagent spun ~30 min
  stuck on the e2e/smoke suite. Going forward: any delegated agent runs Opus, and e2e/smoke-
  heavy work is done inline by the conductor. Recorded in `goal.md` + memory.

## Gate integrity

No gate was weakened; existing tests were only added to. The Phase-0 gate baseline
(`gate-baseline.txt`) was refreshed pre-W1; the only gate *change* is the esbuild
strengthening. Fallow's dupes line is non-gating in this repo (it ships ~248 lines of dupes
green); the gate trigger is dead-code/unlisted-deps — Playwright stays resolved-by-path (never
a bare specifier, even in JSDoc) so it isn't flagged.

## Not done / handed off (for the next run)

- **T2 — terminal scrollback persistence.** The last original-batch item; **not started**
  (user paused new feature work to close out this run and set up a fresh run). Touches
  `persistence.ts`, `main.ts` (PTY), `protocol.ts`; flips W1's authored-but-skipped
  `scrollback.e2e.mjs` to active. Carry into the next run.
- **D11 — clickable terminal paths.** Being implemented by a **parallel Claude session**
  (uncommitted in the working tree as of this report: `webview/terminal-links.ts`, panes,
  `2026-06-17-terminal-path-links.md`). Left for that session — not touched here.
- **agent-chat-ui** — a large new spec (`2026-06-17-agent-chat-ui.md`) added during this run;
  scoped for a future run.

## Follow-ups for the user

1. **Human smoke (W3 DnD):** in a non-manual sort (e.g. Name), drag a session card / project
   header → sort should flip to Manual and persist the on-screen order. Recipe in
   `.autoloop/blockers.md`.
2. **Multi-session hygiene:** this repo had two Claude sessions on `main` concurrently this
   run. Future runs should isolate each agent in its own **git worktree + branch** (junction
   `node_modules` from the main checkout to skip the node-pty rebuild) and merge serially.

Not pushed — all commits on local `main` (standing rule). This report lands on top; the
other session's D11 work remains uncommitted and untouched.

# Run report — Daily-driver batch (2026-06-16)

Autonomous build loop over 12 items toward the user's goal of making Conduit a
**daily driver**: 10 user-reported papercuts/features (D1–D10) plus two
user-approved Tier-1 trust items (T1A OS attention routing, T1B session
durability). Run **delegated** — the conductor (opus) held architecture + taste
and the ledger; implementation fanned out to fresh-context **sonnet** subagents,
**sequential on `main`** (the items share entry files: `sidebar.tsx`, `app.tsx`,
`styles.css`, `session-icon.ts`, so no parallel fan-out). One independent runtime
sweep per cluster (different agent than the builder) drove the **real renderer**
via the preview + playwright-cli.

Final integrated HEAD (`83db7e7`): `npm run verify` **EXIT 0** + the renderer
**esbuild build** green (see the gate-gap note below). Unit suite ~963 → **1084**.

## Outcome

| Item | Status | Commit | Evidence |
|---|---|---|---|
| D1 collapse-all (drop expand toggle) | **done** | `75ca762` | unit; sweep: single collapse-all control, expand gone |
| D2 Reveal in Explorer opens the folder | **needs-human-smoke** | `bb4091c` | pure `revealActionFor` (5 tests); OS-visual undriveable |
| D6 long path overflow in session card | **done** | `7dbabdb` | sweep: 100-char path ellipsized (scrollWidth 642→client 189) |
| D9 hide close-✕ while renaming | **done** | `cb72c9d` | sweep: ✕ absent from DOM during rename, returns on Esc |
| T1A OS attention routing | **needs-human-smoke** | `b118f4c` | pure `shouldRaiseOsAttention` + settings (57 tests); flash/banner undriveable |
| D10 owning-session open + per-session recents | **done** | `15613d1` | `resolveOwningSession` (10 tests); sweep: recents distinct, search routes to owner |
| D8 Changes-tab attention badge | **done** | `b29a647` | `changesBadgeClass` (5 tests); sweep: count badge + accent when Files active |
| D3 Lucide icon picker + double-icon fix | **done** | `8eab002`/`ecd92f3`/`be5effc` | 29+27 tests; sweep: single icon, tag search, categories, reset, virtualized |
| D4 status folded into the icon (dot removed) | **done** | `a01178b` | `sessionIconState` (6 tests); sweep: busy-pulse/attention/stale/idle, no dot |
| D7 markdown rendered-view search jump | **done** | `ede1984` | `findBlockForLine` (8 tests); sweep: line-5 hit flashed + scrolled in rendered view |
| T1B session durability (scoped) | **needs-human-smoke** | `731dc20` | `staleRelaunchTargets` + settings; restart round-trip undriveable |
| D5 file/folder drag-drop + modifiers | **needs-human-smoke** | `5bb1e31`/`83db7e7` | `dropIntent` (26) + guarded `fsMove`/`fsCopy` (14 temp-dir tests); drag gesture undriveable |

**8 done (runtime-verified) · 4 needs-human-smoke (host-boundary).** The four
smoke items are *not* failures — their logic is unit-verified and their commits
are green; only an OS/host side effect that can't be observed autonomously remains.
Recipes are in `.autoloop/blockers.md`.

## Design decisions taken autonomously (conductor)

- **D3 icon picker (taste-critical):** the renderer is a single IIFE esbuild bundle
  (no code-splitting) under CSP `script-src 'self'`, so dynamic `import()` can't
  code-split and there's no CDN — the full Lucide set is **statically bundled** and
  the grid **virtualized**. Real synonym search comes from `lucide-static/tags.json`
  ("delete"→trash). Categories are **prefix-derived** (lucide ships no category
  metadata — accepted). Double-icon fixed via a unified `resolveSessionIcon`
  discriminated union used at every glyph site.
- **T1A:** fire OS attention (`flashFrame` + `Notification`) only on a needs-attention
  edge **while the window is unfocused**; setting-gated (default on); notification
  click activates the session (new `activateSession` message); focus clears the flash.
- **T1B scope:** auto-relaunch on startup is **opt-in (default off)** — re-running an
  arbitrary session command on launch can be destructive. The always-on value is a
  one-click "Relaunch all stale" + a "— session relaunched —" marker. **Scrollback
  persistence is deliberately deferred** (a larger sub-project; queued in blockers).
- **D5 modifiers:** default = move, **Ctrl = copy**, Shift/Alt = move (no link/shortcut
  semantics in-app); host fs ops two-stage path-guarded; refuse-overwrite; EXDEV
  fallback.
- **D10:** open from global search resolves the **owning session** (already-open →
  nearest-ancestor projectPath → active) and switches to it; recents became per-session.

## Gate integrity & a gate gap found

No gate was weakened; existing tests were only added to. One signature change
(`activate` already had `sessionId` from round 8) — all prior tests stayed green.

**Gate gap (recommend fixing next):** `npm run verify` runs biome + dual typecheck +
vitest + fallow + audit + security but does **not** bundle the renderer. A
browser-incompatible import (`node:path` in `src/drop-intent.ts`, which the renderer
imports) therefore passed verify yet broke the esbuild IIFE build — caught only by
the runtime sweep, then fixed (`83db7e7`, browser-safe forward-slash helpers). Adding
`node esbuild.mjs` to the verify chain would fail such imports at the gate; it's a
strengthening, deferred to avoid changing the gate mid-batch.

## Follow-ups for the user

1. **Human smoke (4 items)** — recipes in `.autoloop/blockers.md`: D2 reveal-opens-folder;
   T1A taskbar flash + notification when a backgrounded session finishes (+ click → activate);
   T1B restart → relaunch-all-stale + opt-in auto-relaunch + restarted marker; D3 pick-icon →
   shows on tab + persists across restart; D5 drag-to-move, Ctrl-to-copy in the file tree.
2. **Next durability item:** terminal **scrollback persistence/restore** across restart
   (deferred from T1B) — the highest-value remaining "don't lose my work" gap.
3. **Harden the gate:** add a renderer build (`node esbuild.mjs`) to `npm run verify`.

Not pushed — all commits on local `main` (per the standing rule). `83db7e7` is HEAD.

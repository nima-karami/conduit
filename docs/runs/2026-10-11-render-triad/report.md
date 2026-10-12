# Run report — render-glitch triad (2026-10-11)

User report (no repro): (1) a session pane goes black on activate but renders when torn out to a new
window; (2) relaunching a session that ran Claude Code garbles its history and typed text is invisible
until `clear`; (3) an occasional green flash over the window.

**Landed on local `main` (not pushed, no release cut):** 3fdda9cf (black pane), 3ebd8edb (relaunch /
reload / restart history + PTY size), a8a9a546 (cross-item test fake), d2fff43e (resize line loss),
f8db1622 (stale e2e assumption).

## What shipped

| Item | Root cause (measured) | Evidence |
|---|---|---|
| **Black terminal pane** | A GPU-process restart wipes the pixels of `@xterm/addon-webgl`'s per-document shared glyph atlas while the WebGL contexts *restore*, so `onContextLoss` never fires and every WebGL terminal draws only its cursor. A torn-out window is a new document with a fresh atlas. Windows logged `nvlddmkm` GPU errors, one inside a Conduit run. | e2e `terminal-gpu-reset` (kills the app's own GPU PID twice): before 44–119 bright px, after ~14.9k. Local only (remote runners have no GPU). QA r2: 8 GPU kills, never black or white, WebGL regained at the 2-min retry. |
| Shader background frozen / white after a GPU reset | No `webglcontextrestored` handler; a canvas whose context failed paints opaque white. | unit `shader-bg-gpu-loss`; e2e no-white sampling |
| Shader background restarted on every state broadcast | Inline `onUnsupported` arrow as an effect dep | unit `animated-bg-shader` |
| **Relaunch garbles / erases history** | The replay neutralizer's `?1049l` (DECRC) and `ESC[r` homed the cursor, so the relaunch marker overwrote old text and ConPTY's spawn ED2 erased the last screen. Host-written marker/pad were never persisted, so the *next* relaunch erased again. Only the first cold start per app run replayed, so an in-run relaunch / ↻ Restart showed an empty pane. History was replayed at the current pane size although ConPTY output is absolutely addressed. | e2e `scrollback` (3 launches + in-run restart), `scrollback-inrun`, `scrollback-geometry`; each red at the pre-fix commit. QA r5 PASS. |
| **Typed text invisible until `clear`** | After a reload the pane's first measurement is taller than where layout settles; on `main` the xterm grid overflowed its pane (cursor below the visible area) and/or the PTY got a different size than the xterm. | e2e `terminal-late-font` and `scrollback-inrun` (web fonts held back to make the timing deterministic): red on `main` (850 px grid in a 759 px pane; xterm 109x50 vs PTY 109x44), green after. |
| Emoji drift a row | conhost: 2 cells; xterm Unicode 6: 1 | `@xterm/addon-unicode11`; unit |
| **Resize loses lines** (found by QA) | xterm built without `windowsPty`: a rows-grow pulls scrollback into the viewport, ConPTY's top-anchored repaint overwrites it. | e2e `resize-history`: red on `main` (49 lines lost, live and after relaunch), green after; asserts the renderer sees `backend: 'conpty'`. |

**Gates on the integrated tree:** `npm run verify` exit 0 (d2fff43e). Remote e2e `--full` 189 PASS /
9 EXCLUDED / 1 FAIL (run 38193714670): the failure was `multi-folder-model` asserting "no spawn" by the
absence of text that the new replay now shows; fixed in f8db1622, remote PASS with the verify job green
(run 38194855057). Per-item review APPROVE (independent Opus) and runtime QA on the real app.

## Not fixed

- **Green flash: blocked, cause not provable from inside the app.** Nothing in Conduit paints a
  full-window green. Candidates: the same GPU reset briefly showing an uninitialised frame, or an
  NVIDIA display-driver bug (GTX 1080, driver 572.83). Conduit now logs `child process gone`
  (type GPU). If the next flash lines up with one of those log lines, the GPU reset caused it, and the
  black-pane fix already recovers from that. If there's no log line and other Chromium apps flash
  too, it's the driver.

## Decisions taken autonomously (reversible)

1. **Kept Chromium's per-domain 3D block.** `app.disableDomainBlockingFor3DAPIs()` made a second GPU
   reset recover WebGL, but it's app-global and would let a web-tab page crash-loop the GPU until
   Chromium's fatal exit takes down the app and its PTYs. Instead, terminals stay readable on DOM
   rendering and retry WebGL at 30 s / 2 min / 5 min. Reversing this is one line in `electron/main.ts`.
2. **Raw PTY ring, segmented by geometry** (v2 `segments`), rather than persisting xterm's serialized
   buffer (`@xterm/addon-serialize`). Serialize would remove the remaining replay residuals, but it
   would make the renderer a producer of persisted state.
3. **Cap of 12 live WebGL terminals per window**, so Conduit itself never trips Chromium's ~16-context
   eviction.
4. **Removed the `— restored —` marker**: ConPTY's spawn clear always erased it. The relaunch marker
   now marks every boundary between runs.
5. **Terminal font still loads from Google Fonts at runtime** (`webview/styles.css:1`). Bundling it would
   remove a network dependency and a layout-timing variable. Not done; your call.

## Accepted residuals

- After a backoff retry regains WebGL, the shader background stays on the Flow fallback until it's
  re-selected or the window reloads.
- Fast drag-resize may duplicate lines. Long wrapped lines across column changes can mangle, because
  conhost and xterm reflow differently.
- On Windows 10 (build < 21376), a replay that ends while its pane is hidden can truncate rows wider
  than the pane.
- There's no cap on scrollback segment count.
- `scrollback-inrun`'s font hold-back check is cumulative. It could pass vacuously if only
  fonts.gstatic.com is blocked; `terminal-late-font` would still fail loudly.

## Process notes

- Diagnosis came first, from read-only Opus investigators. Both measured real bytes and pixels, and
  both converged on GPU/terminal-state causes. Every fix went through spec → Opus builder in a
  worktree → independent review → runtime QA.
- **Runtime QA failed a build 6 times. None of those failures were visible to green unit tests or
  review:**
  - a second GPU reset left WebGL blocked;
  - history was lost one relaunch later;
  - in-run restart skipped the replay;
  - an attach replayed at the wrong size;
  - the PTY ended up taller than the xterm after a reload;
  - a transient resize lost lines.

  The QA agent also found the resize line loss and the harness `--inspect` → winpty mismatch.
- **One mechanism was locked from inference and then disproved by measurement:** the guess that a
  late font changes cell size. That round was reverted.
- **The merged-tree check caught a cross-item break:** one item's jsdom fake Terminal lacked an API the
  other item added.
- Candidate gotchas for `CLAUDE.md` are listed in `.autoloop/learnings.md`. They aren't applied.

# Autonomous build run — 2026-06-17 (night)

**Branch:** `autoloop/2026-06-17-night` (worktree `../conduit-night`, off `main` @ `0914e14`).
**Not merged, not pushed.** Another agent was live on `main` integrating the "chat-ui family"
during this run, so this run deliberately stayed in an isolated worktree on its own branch and
did **not** touch `main`. Merge is a follow-up the user can do once the other agent settles.

**Conductor:** claude-opus-4-8[1m] (delegated mode). Packaging features built inline (taste-critical
config); the image-viewer code feature built by an Opus subagent and independently re-verified by
the conductor.

## Scope decision (why these four)

User directive: **macOS build first, then everything else.** Inspecting the repo, the wishlist's
"everything else" split into two groups:

- **Already owned by the concurrent agent** (have live branches + a sibling worktree
  `conduit-wt-chatui` @ `wt-t2-scrollback`): chat-UI, skill-installer, interactive-plans, T2
  scrollback. **Left untouched** to avoid colliding with the live `main` agent.
- **Unclaimed + independent**: macOS build, installer branding, image viewer zoom/diffs, D11
  clickable paths. **This run's lane.**

## Results

| Feature | Status | Commit | Evidence |
|---|---|---|---|
| macOS test build (unsigned arm64 CI) | **needs-human-smoke** | `43d8e0a` | verify EXIT 0; YAML/JSON valid; win invariants intact |
| Installer branding + signing-ready CI | **needs-human-smoke** | `ce3d1ed` | verify EXIT 0; real `--win` build, names unchanged, exe NotSigned |
| Image viewer — zoom/pan + image diffs | **done** ✅ | `ddfdc20` | verify EXIT 0 (independent); e2e `image-diff` PASS (real Electron) |
| D11 — clickable terminal paths | **already shipped** (not built) | `a24b296` (pre-existing) | wishlist was stale |

### 1. macOS test build — `43d8e0a` (needs-human-smoke)

Added `package.json` `build.mac` (arm64 `dmg`+`zip`, `identity:null`, `hardenedRuntime:false`,
`gatekeeperAssess:false`, `artifactName` marked `-unsigned`, `mac.icon` = the existing 1024² PNG so
electron-builder derives the `.icns`) and a new **`.github/workflows/build-mac.yml`**
(`workflow_dispatch`, `macos-latest`, `npm run verify` → `electron-builder --mac --arm64
--publish never` with `CSC_IDENTITY_AUTO_DISCOVERY=false`, a **node-pty darwin-arm64 assertion** via
`lipo -archs`, `upload-artifact` with `if-no-files-found: error`). New doc **`docs/MACOS-TESTING.md`**
(download → Gatekeeper bypass → run; arm64-only, no mac auto-update). Windows NSIS config,
`artifactName`, and Windows auto-update are unchanged.

- **Verified here:** full `npm run verify` EXIT 0; all three workflow YAMLs parse; `package.json`
  valid; Windows `artifactName`/`win` block byte-identical to baseline.
- **needs-human-smoke:** the actual macOS run — no Mac and no CI trigger from this host. To close:
  on GitHub, run the **Build macOS (unsigned)** workflow, download `conduit-macos-arm64-unsigned`,
  and launch on an Apple-Silicon Mac after the documented Gatekeeper bypass (verify a PTY starts).

### 2. Installer branding + signing-ready CI — `ce3d1ed` (needs-human-smoke)

`package.json`: `nsis.installerIcon`/`uninstallerIcon`/`installerHeaderIcon` → the verified
multi-resolution `assets/icon.ico` (contains 16/32/48/256), `uninstallDisplayName`, and
`win.signtoolOptions.publisherName: "Nima Karami"` + `rfc3161TimeStampServer`. `release.yml`: the
`electron-builder --win` step now reads `CSC_LINK`/`CSC_KEY_PASSWORD` from repo secrets
(env-gated). New doc **`docs/WINDOWS-SIGNING.md`** (enabling signing + the SmartScreen ladder).

- **Verified here:** full `npm run verify` EXIT 0; a **real `electron-builder --win` build** produced
  `dist/Conduit-Setup-0.1.11.exe` (+ `latest.yml`, `.blockmap`) — **names unchanged** (the
  auto-update invariant); and `Get-AuthenticodeSignature` on the exe is **`NotSigned`**, proving the
  env-gated hook is a true no-op when no cert/secrets are present (unsigned exactly as today).
- **Gotcha fixed:** electron-builder 26 rejected `publisherName`/`rfc3161TimeStampServer` directly on
  `win`; they belong under `win.signtoolOptions` (saved to memory). Caught by building the real
  installer — a YAML/JSON lint would have missed it.
- **needs-human-smoke:** the *visual* result (Conduit icon on Setup.exe / the install splash / the
  uninstaller, and the "Conduit" + publisher row in Programs & Features) — not observable without a
  real Windows install on this host. Low risk: electron-builder reliably embeds `installerIcon`.

### 3. Image viewer — zoom/pan + image diffs — `ddfdc20` (DONE ✅)

Full spec scope (A zoom/pan polish + B image diffs, incl. the v1 rotate/swipe/onion items).
Host: `FileDiffDTO.image` branch (`src/protocol.ts`), `readDiff` image branch with an extracted pure
`buildImageDiff` status/over-cap decision (`src/file-service.ts`), and a **binary-safe
`gitShowBuffer`** (`electron/main.ts`, `execFile encoding:'buffer'`) since the text `git()`
utf8-corrupts binary — status is derived host-side. Renderer: new pure `webview/image-zoom.ts`
(clamp + zoom-toward-pointer math), `image-stage.tsx` (zoom/pan/rotate, keyboard + pointer + a11y),
`image-diff.tsx` (side-by-side/swipe/onion, sticky per session, text+icon+color badges). 14 + 7 new
unit tests; new `test/e2e/image-diff.e2e.mjs`.

- **Independently verified by the conductor** (not just the subagent's say-so): re-ran
  `npm run verify` → **EXIT 0** (1353 tests, fallow "No issues", gitleaks "no leaks"); re-ran
  `node test/e2e/run-smoke.mjs image-diff` → **PASS (14.1s)** driving the real Electron host
  (modified/added/deleted diffs render; **HEAD blob round-trips byte-identical** to `git show`;
  viewer zoom % changes). Confirmed the **gate baseline is unchanged** (biome/tsconfig/verify.yml
  hashes match; verify script chain intact — gates not weakened). Spot-reviewed the diff: comments
  are WHY-only per CLAUDE.md; `gitShowBuffer` and the pure modules are clean.
- **Real bug fixed in passing:** data-URL images decode synchronously so React `onLoad` often never
  fired → natural dims unset → zoom was inert. Now captured eagerly via a ref when `complete`.
- **Residual needs-human-smoke (minor):** the literal `Ctrl/Cmd +/-/0` and arrow-pan **keystrokes**
  (Playwright-Electron synthetic-key limitation — same class as paste's Ctrl+V). The keyboard
  handler is unit-tested and wired; the e2e asserts zoom via the keyboard-reachable button. A human
  pressing the literal keys in the real window fully closes it.

### 4. D11 — clickable terminal paths — NOT built (wishlist stale)

Discovered already implemented at the branch point: commit **`a24b296`** ("feat(terminal): clickable
file/folder paths open in the editor") shipped `webview/terminal-links.ts`, `registerLinkProvider`
in `terminal-pane.tsx`, the `onOpenFile`/`onRevealFolder` wiring through `app.tsx` → `center-pane`,
and `test/unit/terminal-links.test.ts` + `test/e2e/terminal-links.e2e.mjs`. The wishlist's D11 entry
("net-new, no link provider exists today") is **stale** and should be deleted.

## Decisions taken during autonomy (no human to ask)

- **Left the chat-ui-family wishlist items to the concurrent `main` agent** (branch collision risk).
- **macOS icon:** reused the existing 1024² `assets/icon.png` as `mac.icon` (electron-builder derives
  the icns) rather than committing a hand-authored `.icns` binary — spec assumption #1, reversible.
- **publisherName** pinned to `"Nima Karami"` (spec D1 default) — must match the future cert CN.
- **Did not merge to `main`, archive shipped specs, or prune the wishlist** — all touch shared files
  the live `main` agent may be editing. Deferred to a coordinated merge step (see Follow-ups).

## Follow-ups for the user (post-merge / human)

1. **Merge `autoloop/2026-06-17-night` into `main`** once the other agent settles (3 commits;
   image-viewer touches `src/protocol.ts`/`electron/main.ts`/`src/file-service.ts` — watch for
   conflicts if the chat-ui family touched those seams).
2. **needs-human-smoke:** trigger the macOS workflow + launch on a Mac; install the Windows build and
   eyeball the Setup.exe icon + Programs & Features row; press the literal image-viewer zoom keys.
3. **Doc hygiene at merge:** delete the **D11** wishlist entry (already shipped); move the three
   shipped specs (`macos-test-build`, `installer-branding`, `image-viewer-zoom-and-diffs`) from
   `docs/specs/` to `docs/specs/archive/` per ADR 0003 and update `docs/specs/INDEX.md`; prune the
   three shipped wishlist entries.

## Ledger

Run state: `.autoloop/{goal.md,tasks.yaml,blockers.md,gate-baseline.txt,evidence/}` (gitignored).

---
status: active
date: 2026-06-17
---

# macOS test build — unsigned arm64 artifact via CI

## Problem frame

**Job to be done:** "As the developer, I want a runnable macOS build of Conduit so I can test it
on my Mac — without paying for or standing up Apple code-signing yet."

Today Conduit builds **Windows only** (`build.win` → NSIS; `package.json`). There is no macOS
target, and electron-builder **cannot package a `.dmg`/`.app` on Windows** — macOS artifacts must
be built on macOS. So there is currently no way to get Conduit onto a Mac to test it. The
existing `install-update-experience` and `auto-update` specs both explicitly list macOS as out of
scope; this spec fills the **"just let me run it on a Mac"** gap, deliberately *before* investing
in signing/notarization.

- **Actors:** the developer (downloads + runs the build on a Mac); GitHub Actions CI (produces it).
- **Success outcomes:** a CI job produces an **unsigned, ad-hoc-signed arm64** `.dmg` + `.zip`,
  uploaded as a clearly-labeled workflow artifact; the developer downloads it, bypasses Gatekeeper
  once, and Conduit launches and runs (terminal/PTY, file browsing, the core UI) on macOS.
- **Non-goals:** Developer ID signing / notarization; macOS auto-update; a public/distributable
  mac download; Intel (x64) or universal builds; Linux.

## Feasibility findings (the questions that motivated this spec)

| Question | Answer |
|----------|--------|
| Unsigned mac build possible? | **Yes.** Set `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder skips Developer-ID signing. arm64 binaries still get an **ad-hoc signature automatically** (required just to launch on Apple Silicon) — no certificate, no cost. |
| Will it run? | Yes, after a **one-time Gatekeeper bypass** (unsigned + un-notarized). On recent macOS (15 Sequoia) the reliable methods are **`xattr -dr com.apple.quarantine /Applications/Conduit.app`** or **System Settings → Privacy & Security → Open Anyway**; the older right-click → **Open** trick is no longer dependable for fully-unsigned apps. The first-launch dialog is typically *"cannot be opened because Apple cannot check it for malicious software"* (or *"is damaged"*), not the signed-but-unidentified wording. |
| Build on Windows? | **No.** electron-builder requires macOS to package mac targets → use a GitHub Actions **`macos-latest`** runner (Apple Silicon). |
| Auto-update on mac? | **No, while unsigned.** Squirrel.Mac requires a signed app to apply updates. Mac stays manual-download until a future signing spec. Windows auto-update is unaffected. |
| Native module (`@lydell/node-pty`)? | Ships **darwin-arm64 prebuilds**; with `npmRebuild: false` (as today) and `asarUnpack: ["**/*.node"]`, the arm64 prebuild is bundled and unpacked. The mac runner being arm64 keeps host arch == target arch. |

## Behavior & states (build → run lifecycle)

1. **Trigger** → the mac build job runs on `macos-latest`.
2. **Build** → `electron-builder --mac --arm64` with signing disabled →
   - success → arm64 `.dmg` + `.zip` produced under `dist/`;
   - failure (build error, missing icon, dmg/hdiutil hiccup) → job fails; `.zip` is the resilient
     fallback if only `.dmg` packaging fails (see Edge cases).
3. **Publish** → artifacts uploaded via `actions/upload-artifact`, named to mark them **unsigned**.
4. **Download → first launch** → macOS quarantine blocks the app (*"Conduit" cannot be opened
   because Apple cannot check it for malicious software* / *is damaged*). The `.app` inside a
   mounted `.dmg` carries quarantine too — same bypass applies.
5. **Bypass (once)** → `xattr -dr com.apple.quarantine …` or System Settings → Open Anyway
   (preferred on macOS 15; right-click→Open is unreliable for unsigned apps) → app launches.
6. **Run** → Conduit operates normally (arm64 PTY, file service, UI). No update card action on mac
   (auto-update inert; see Data contract).

## Data / interface contract

### `package.json` → `build.mac` (+ `build.dmg`)

```jsonc
"mac": {
  "target": [
    { "target": "dmg", "arch": "arm64" },
    { "target": "zip", "arch": "arm64" }   // zip = resilient fallback + future Squirrel.Mac
  ],
  "icon": "assets/icon.icns",
  "category": "public.app-category.developer-tools",
  "identity": null,            // belt-and-suspenders with CSC_IDENTITY_AUTO_DISCOVERY=false
  "hardenedRuntime": false,    // no notarization path
  "gatekeeperAssess": false
}
```

- `artifactName` already defaults to `${productName}-Setup-${version}.${ext}` at the top level;
  override per-mac to **mark unsigned**, e.g. `"artifactName": "${productName}-${version}-arm64-unsigned.${ext}"`
  (or set it in the `mac` block) so a downloaded file is self-describing.
- The top-level `files`/`asarUnpack`/`npmRebuild`/`publish` keys are unchanged. `publish` stays
  GitHub but the mac job uses `--publish never` (artifact only, not a Release asset).

### CI: a macOS job (extend `release.yml` or add `build-mac.yml`)

```yaml
build-mac:
  runs-on: macos-latest        # Apple Silicon (arm64)
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22, cache: npm }
    - run: npm ci
    - run: npm run verify       # cross-platform gate; see Decisions Needed if mac-only failures appear
    - run: npx electron-builder --mac --arm64 --publish never
      env:
        CSC_IDENTITY_AUTO_DISCOVERY: "false"   # force unsigned (ad-hoc only)
        # No GH_TOKEN: --publish never needs none, and omitting it removes any path to an
        # accidental Release upload of an unsigned artifact.
    - uses: actions/upload-artifact@v4
      with:
        name: conduit-macos-arm64-unsigned
        if-no-files-found: error               # a zero-artifact build must FAIL, not pass green
        path: |
          dist/*.dmg
          dist/*.zip
```

**Trigger:** `workflow_dispatch` (build on demand) is the MVP; optionally also on `v*` tags
alongside the Windows release job. The job is **independent** of the Windows publish job so a mac
build failure never blocks a Windows release.

**Outputs (artifact contents):** `Conduit-<version>-arm64-unsigned.dmg` and
`…-arm64-unsigned.zip` (+ electron-builder's `*.blockmap`). No `latest-mac.yml` is published
(intentional — no mac auto-update channel).

### Invariants

- The mac artifact is **never** published to the GitHub Release nor to an auto-update channel
  (no `latest-mac.yml` on the Release), so no client ever treats it as an updatable install.
- arm64-only: the artifact will **not run on Intel Macs** (documented limitation).
- Windows artifacts, config, and auto-update are **unchanged** by this spec.

## Edge cases & failure modes

| Case | Behaviour / handling |
|------|----------------------|
| `assets/icon.icns` missing | electron-builder can derive an icns from a ≥512px PNG, but a real `.icns` avoids a fuzzy/placeholder icon. Provide `assets/icon.icns` (or a 1024² PNG it can convert). See Decisions Needed. |
| DMG packaging flaky on CI (`hdiutil` resource-busy) | The `.zip` target is the resilient fallback — unzip-and-run needs no dmg. Job uploads whatever `dist/*` exists; treat zip as the primary test path. |
| Runner arch ≠ target arch | `macos-latest` is arm64 today, matching the arm64 target, so the bundled `@lydell/node-pty` darwin-arm64 prebuild is correct. If GitHub repoints `macos-latest`, pin `macos-14`. |
| `npm ci` resolves the wrong node-pty prebuild | `npmRebuild: false` governs the electron-builder step, but `npm ci` itself must fetch the **darwin-arm64** `@lydell/node-pty` prebuild on the runner. A wrong/cached arch fails at *runtime*, not build — so a CI step asserts the unpacked `.node` is arm64 (`file`/`lipo -archs` on the unpacked binary; see Acceptance). |
| Entitlements | With `hardenedRuntime: false` and no notarization, **no entitlements file is required** — intentionally omitted. |
| Signing identity accidentally discovered on the runner | `CSC_IDENTITY_AUTO_DISCOVERY=false` **and** `mac.identity: null` both force unsigned, so a stray keychain identity can't flip the build to a (broken) signed state. |
| `npm run verify` has a mac-only failure | Tests/biome/typecheck are cross-platform; the e2e smoke suite is **not** in verify (repo convention), so the gate shouldn't be mac-fragile. If a genuine mac-only failure surfaces, narrow that check rather than disabling verify (per CLAUDE.md). |
| Gatekeeper re-quarantine after each download | Expected for unsigned apps; the bypass is per-downloaded-copy. Documented, not "fixable" without signing. |
| GPU/SwiftShader switches (`main.ts`) | Unaffected on mac; the shader background still needs WebGL — no mac-specific change. |
| User on an Intel Mac | arm64 build won't launch; the limitation is documented. Universal/x64 is a future scope bump, not a silent fix. |

## Defaults vs. settings

Build-time only — **no runtime user settings**. Defaults: unsigned, arm64, `dmg`+`zip`, CI
artifact (not a Release asset), `workflow_dispatch` trigger. Each chosen for the
"test-it-on-my-Mac without signing" job; all reversible by editing build config later.

## Scope slicing

- **MVP:** `build.mac` config (arm64, unsigned, dmg+zip) + a `workflow_dispatch` macOS CI job that
  uploads the artifact + a short "Testing on macOS" doc (download → Gatekeeper bypass → run).
- **v1:** also build the mac artifact on `v*` tags next to the Windows release; ensure
  `assets/icon.icns`.
- **Vision (separate future spec):** Apple Developer ID signing + notarization → distributable mac
  download **and** mac auto-update (Squirrel.Mac), plus Intel/universal if demand exists.
- **Out of scope:** signing/notarization; mac auto-update; public mac Release asset; Intel/universal;
  Linux; any renderer/UX change for "this is a test build."

## Acceptance criteria

**Declarative:**
- [ ] A `macos-latest` CI job builds an **unsigned arm64** `.dmg` and `.zip` and uploads them as a
      `*-unsigned`-named workflow artifact, using no signing credentials.
- [ ] The build sets `CSC_IDENTITY_AUTO_DISCOVERY=false` (and `mac.identity: null`); no Developer-ID
      signing or notarization is attempted.
- [ ] No `latest-mac.yml` and no mac asset are published to the GitHub Release / auto-update channel.
- [ ] The uploaded artifact is **non-empty** (`if-no-files-found: error`) and the bundled
      `@lydell/node-pty` `.node` is **darwin-arm64** (CI-checkable via `file`/`lipo -archs` on the
      unpacked binary).
- [ ] **[manual / needs-human-smoke]** The downloaded app launches on an Apple Silicon Mac after the
      documented one-time Gatekeeper bypass, and a terminal session (PTY) starts. (Not CI-automatable
      — requires a human on a Mac.)
- [ ] Windows build, NSIS config, and Windows auto-update are unchanged.
- [ ] A "Testing on macOS" doc records the download + bypass + run steps and the arm64-only / no-auto-update limitations.

**EARS:**
- *When* a maintainer dispatches the macOS workflow, the system *shall* produce an unsigned arm64
  `.dmg` and `.zip` without requiring signing secrets.
- *While* the app is unsigned, the system *shall not* expose a working mac auto-update path (no
  `latest-mac.yml` published).
- *If* `.dmg` packaging fails on the runner, *then* the job *shall* still upload the `.zip` artifact.

**Gherkin:**
```gherkin
Scenario: Developer runs the unsigned build on Apple Silicon
  Given the macOS CI job has uploaded conduit-macos-arm64-unsigned
  When I download and unzip the .zip on an M-series Mac
  And I clear quarantine (`xattr -dr com.apple.quarantine`) or use Open Anyway
  Then Conduit launches
  And a new terminal session starts a shell via node-pty (arm64)

Scenario: Mac build never advertises auto-update
  Given an unsigned mac artifact exists
  When the GitHub Release for the version is inspected
  Then it contains the Windows installer and latest.yml
  And it contains no latest-mac.yml and no mac asset
```

## Decisions Needed / Assumptions

| # | Assumption (default taken) | Severity |
|---|----------------------------|----------|
| 1 | `assets/icon.icns` will be added (or a 1024² PNG provided for electron-builder to convert). Build still succeeds without it (derived/placeholder icon), so not a blocker. | normal |
| 2 | `npm run verify` runs unchanged on the mac job; it's cross-platform and the e2e smoke suite isn't in verify, so it shouldn't be mac-fragile. If a mac-only failure appears, narrow that check (never disable verify). | normal |
| 3 | `macos-latest` is Apple Silicon (arm64) **and** `npm ci` resolves the `@lydell/node-pty` **darwin-arm64** prebuild on the runner. This is the single point of total failure — if either is wrong the deliverable can't run. **Mitigation:** pin `macos-14` and add the CI `.node` arch assertion (Acceptance). | **high** |
| 4 | MVP trigger is `workflow_dispatch` (build on demand); tag-triggered mac builds are a v1 add. | normal |
| 5 | The mac artifact is a CI workflow artifact, not a Release asset (per the chosen destination) — keeps it off the auto-update/download path. | normal |

## Files touched

| File | Change |
|------|--------|
| `package.json` | Add `build.mac` (arm64 dmg+zip, `identity: null`, `hardenedRuntime: false`, `gatekeeperAssess: false`) + unsigned `artifactName` |
| `.github/workflows/release.yml` (or new `build-mac.yml`) | Add a `macos-latest` job: install → verify → `electron-builder --mac --arm64 --publish never` with `CSC_IDENTITY_AUTO_DISCOVERY=false` → `upload-artifact` |
| `assets/icon.icns` | **New** (or a 1024² PNG source) — clean mac app icon |
| `docs/` (e.g. `docs/runs/` note or a short `MACOS-TESTING.md`) | **New.** Download → Gatekeeper bypass → run; arm64-only + no-auto-update caveats |

## Out of scope

- Apple Developer ID signing & notarization (the gate for distribution + mac auto-update).
- macOS auto-update (`latest-mac.yml`, Squirrel.Mac) — requires signing.
- Public/Release mac download; Intel (x64) and universal builds; Linux.
- Any in-app "test build" labeling or mac-specific UI.

## References

- `package.json` `build` (NSIS/win config, `files`, `asarUnpack`, `publish`, `npmRebuild: false`).
- `2026-06-16-auto-update.md` — defers signing; Windows-only update channel (mac stays manual).
- `2026-06-16-install-update-experience.md` — lists "macOS / Linux integration" as out of scope
  (this spec addresses the build/run half for mac).
- `CLAUDE.md` — don't remove the GPU/SwiftShader switches; never disable a verify check to pass.
- electron-builder mac targets + `CSC_IDENTITY_AUTO_DISCOVERY`; Squirrel.Mac signing requirement
  for updates.

---
status: draft
date: 2026-06-17
---

# Installer branding (one-click, signing-ready)

**Tier:** FULL · **Type:** UI

Improves the Windows installer's identity without leaving the frictionless
`oneClick` flow. Scope (user-chosen): **branded one-click** (icon + splash +
uninstaller + Add/Remove-Programs + shortcut identity) and a **signing-ready**
pipeline — **not** a wizard with sidebar artwork, and **not** purchasing/enabling a
certificate now.

What `oneClick` NSIS actually allows: installer icon, install/progress splash icon,
uninstaller icon, ARP branding, shortcut icons. It does **not** allow the big
welcome/sidebar artwork — that is wizard-only (`oneClick:false`), which the user
declined. Recorded so expectations are set.

## 1. Problem frame

**JTBD:** When I download and run the Conduit installer (or see it later in Programs
& Features), I want it to look like a real, trustworthy product — proper icon,
Conduit name/publisher, no "this looks sketchy" cues — so installing feels safe and
finished, not like a hobby script.

**Why it's weak today** (grounded in `package.json` `build` + `.github/workflows/release.yml`):

- `oneClick: true` sets **no** `installerIcon` / `uninstallerIcon` /
  `installerHeaderIcon` — Setup.exe and the uninstaller fall back to defaults.
- No `win.publisherName` → thin ARP/shortcut metadata; **no code signing** →
  SmartScreen *"Unknown publisher / Windows protected your PC"* on first run.
- Unknown whether `assets/icon.ico` is multi-resolution; a single 256px source
  renders blurry at 16/32px (taskbar, ARP list).

**Actors:** a first-time installer (downloads from GitHub Releases); an existing user
receiving a silent auto-update; a user uninstalling.

**Success outcomes:**

- The Conduit icon shows on Setup.exe, the install splash, the uninstaller,
  Start-menu/desktop shortcuts, and the Programs & Features row.
- Publisher identity in ARP + shortcut metadata.
- The pipeline can produce **signed** artifacts the moment a cert/secret is added —
  zero code change — and the design documents the SmartScreen reality until then.

**Non-goals:** a wizard with sidebar artwork (declined — wizard-only); actually
purchasing/enabling a cert now; macOS/Linux installers; winget/Store/MSI; changing
the silent auto-update mechanism.

## 2. Behavior & states (installer lifecycle)

- **Download** — the browser shows `Conduit-Setup-<version>.exe` carrying the Conduit
  exe icon.
- **SmartScreen gate (unsigned, current reality)** — fresh machines may show
  *"Windows protected your PC."* **Out of scope to remove now**; the signing-ready
  design (§3) closes it later. Documented, not silently dropped.
- **Run / one-click install** — a minimal splash window showing the Conduit
  `installerIcon` + progress bar (no wizard pages). Per-user (`perMachine:false`), no
  elevation prompt.
- **Register** — Start-menu + desktop shortcuts (Conduit icon), the existing "Open in
  Conduit" context menu (`build/installer.nsh`), and an ARP entry with
  DisplayIcon/Publisher/URLs/size.
- **Finish** — auto-launch Conduit (`runAfterFinish`, current default).
- **Upgrade (silent auto-update)** — electron-updater runs the new installer with
  `/S`; branding changes must not introduce any prompt or break the silent flow.
- **Uninstall** — the uninstaller shows the Conduit icon; **keeps** user data
  (`deleteAppDataOnUninstall:false`); removes shortcuts + context-menu keys (existing
  `customUnInstall`).
- **Failure / partial** — an install error (disk/permission — rare per-user) → NSIS
  rolls back its own steps; no half-registered shortcuts. A downgrade/older-version
  install → NSIS standard "already a newer version" behavior (block, no corruption).

## 3. Data / interface contract (build + CI config)

Mostly an **electron-builder config + CI** contract, not a runtime API.

**`package.json` `build.nsis` / `build.win` additions:**

- `installerIcon`, `uninstallerIcon`, `installerHeaderIcon` → `assets/icon.ico` (or
  dedicated copies).
- `win.publisherName` — **must equal the eventual cert's subject CN** once signing is
  enabled, or electron-updater signature verification rejects updates (Decision D1).
- ARP/registry: `DisplayIcon` → installed exe; shortcut name "Conduit"; optional
  `nsis.uninstallDisplayName`.
- Keep `deleteAppDataOnUninstall:false`, `runAfterFinish:true`,
  `allowToChangeInstallationDirectory:false` (one-click).

**Invariant — do not break the updater:** `artifactName`
(`Conduit-Setup-${version}.exe`) and the `latest.yml` / `.blockmap` asset names
**must stay byte-identical** to what the updater expects (a rename 404s auto-update —
this bit v0.1.0/v0.1.1). Branding changes touch icons/metadata only, never artifact
names.

**Signing-ready hook (env-gated, no-op today):**

- electron-builder auto-signs when `CSC_LINK` + `CSC_KEY_PASSWORD` (PFX) — or an Azure
  Trusted Signing config — are present in the environment. CI reads these from
  **GitHub secrets if set**, and builds **unsigned exactly as today when absent**. No
  certificate is purchased now.
- Document timestamping (`rfc3161TimeStampServer`) so signatures outlive cert expiry,
  and the SmartScreen ladder: unsigned → warning; OV cert → warning until reputation;
  EV / Azure Trusted Signing → immediate trust.
- Assets to produce/verify: a **multi-resolution `assets/icon.ico`**
  (16/24/32/48/64/128/256), regenerated from `assets/icon.png` if currently
  single-size.

## 4. Edge cases & failure modes

- **Single-resolution .ico** → blurry small icons. MVP must verify/regenerate
  multi-size.
- **Branding change mid-silent-update** → must not add a prompt; verify `/S` stays
  fully silent after the config change.
- **publisherName mismatch** once signed → updater rejects; pin it now to the planned
  cert identity (D1).
- **Antivirus false-positive** on the unsigned NSIS stub → reduced by future signing;
  acknowledged residual risk today.
- **Per-user install, no admin** → context-menu + ARP keys go to HKCU (already the
  case); branding must not require HKLM/elevation.
- **Windows shell icon cache** → an icon swap may not refresh until the cache clears;
  cosmetic, noted.
- **Uninstaller orphan** → ensure `customUnInstall` still removes both context-menu
  keys after the branding edits (don't regress existing behavior).

## 5. Defaults vs. settings

The installer exposes **no runtime settings**; "defaults" here are build-config
decisions:

| Decision | Default | Rationale |
|---|---|---|
| Install scope | Per-user (`perMachine:false`) | No elevation; matches the silent-update + context-menu design. |
| Wizard | One-click (no pages) | User chose to keep the frictionless flow. |
| Install dir choice | Off | One-click has no dir page; simplicity. |
| Launch after install | On (`runAfterFinish`) | Expected "it just opens" finish. |
| Keep user data on uninstall | Yes (`deleteAppDataOnUninstall:false`) | Don't destroy sessions/settings on a reinstall. |
| Signing | Deferred, env-gated | User chose signing-ready, not signed-now. |

## 6. Scope slicing

- **MVP:** `installerIcon` + `uninstallerIcon` + verified multi-resolution `icon.ico`
  + `publisherName` + ARP `DisplayIcon`/publisher/URLs. ⇒ Setup.exe, uninstaller,
  shortcuts, and the Programs & Features row all show the Conduit icon + name.
- **v1:** `installerHeaderIcon`; the signing-ready CI hook (env-gated, unsigned no-op
  when secrets absent) + `rfc3161TimeStampServer`; a `docs/` note on enabling signing
  + the SmartScreen ladder; confirm silent `/S` upgrade is unaffected.
- **Vision (out of this spec):** an assisted branded wizard (sidebar/header BMP art);
  actually enabling a purchased cert / Azure Trusted Signing; macOS DMG branding;
  winget/Store/MSI; a custom NSIS UI.
- **Out of scope:** removing the SmartScreen warning now; any change to artifact names
  or the update mechanism.

## 7. UI module — interaction & a11y/i18n

The installer *is* a UI surface, but it's **standard NSIS** — most a11y/i18n is
inherited, not authored.

### Interaction inventory (our authored surfaces only)

| Surface | Affordance | Pointer | Keyboard | Notes |
|---|---|---|---|---|
| Setup.exe / splash | run + progress | double-click / Cancel | Esc cancels | NSIS-native window; icon = `installerIcon` |
| Finish auto-launch | opens Conduit | n/a | n/a | `runAfterFinish` |
| Uninstaller | remove | click | Tab/Enter/Esc | NSIS-native; icon = `uninstallerIcon` |
| ARP row / shortcuts | launch/uninstall | click | Win-native | DisplayIcon + publisher |

### Accessibility

NSIS uses standard Win32 controls → keyboard operable (Tab/Enter/Esc),
screen-reader-exposed, and honors high-contrast/forced-colors natively. **Our**
obligation is **icon legibility**: provide all sizes (16→256) and ensure the glyph
reads at 16px and against light *and* dark taskbars / high-contrast (contrast, not
color-only). No custom-drawn controls → no new focus/ARIA work.

### Internationalization

NSIS MUI provides localized standard strings + RTL per the selected language
automatically. Our **authored** strings are few — product name "Conduit", the existing
"Open in Conduit" context-menu label, the ARP display name. These stay inline English
by repo convention (no i18n framework); the context-menu label is the only
user-visible custom string and is English-only today (flagged, A4). No
locale-formatted data introduced.

## 8. Acceptance criteria

### EARS

- *Ubiquitous:* The installer, uninstaller, and Setup.exe shall display the Conduit
  icon at every Windows-rendered size.
- *Event:* When the user opens Programs & Features, the system shall show "Conduit"
  with the Conduit icon and the configured publisher.
- *State:* While building without signing secrets, the pipeline shall produce the same
  unsigned artifacts as today (no failure, no name change).
- *Optional:* Where signing secrets are present in the environment, the pipeline shall
  produce signed, timestamped artifacts with no source change.
- *Unwanted:* If branding config changes the artifact or `latest.yml` names, then
  auto-update breaks — therefore the build shall preserve `Conduit-Setup-${version}.exe`
  and the metadata asset names exactly.
- *Unwanted:* If a silent `/S` upgrade is run, then the installer shall complete with
  no prompt or visible wizard.

### Gherkin

```gherkin
Feature: Branded one-click installer
  Scenario: Fresh install shows Conduit identity
    Given I download Conduit-Setup-<version>.exe
    When I run it
    Then the install splash shows the Conduit icon
    And after finishing, the Start-menu shortcut and Programs & Features row
      show the Conduit icon and publisher

  Scenario: Silent auto-update is unaffected by branding
    Given an older Conduit is installed
    When electron-updater runs the new installer with /S
    Then it updates with no prompt and no visible wizard

  Scenario: Build stays green without a certificate
    Given no signing secrets are configured
    When CI builds the release
    Then it produces the same unsigned artifacts with unchanged names
```

### Declarative

- `assets/icon.ico` contains ≥ {16,32,48,256}px; small-size render is crisp.
- `npm run dist` (and the release workflow) succeed unsigned with the new config.
- A documented one-step path (add secret → signed build) exists; `publisherName` is
  pinned to the planned cert identity.

## Assumptions

- **A1** — Reuse `assets/icon.ico`/`icon.png` as the branding source; regenerate a
  multi-res `.ico` if it's single-size. *Cheap, reversible.*
- **A2** — `publisherName: "Nima Karami"`; must match the future cert CN (else updater
  rejects once signed). *Flagged as D1.*
- **A3** — Keep per-user, one-click, runAfterFinish, keep-appdata-on-uninstall.
  *Matches shipped UX.*
- **A4** — Custom strings stay English; no i18n layer. *Repo convention.*
- **A5** — No cert purchased now; CI signs only when secrets exist, else unsigned as
  today. *User-chosen.*

## Decisions needed

- **D1 (normal)** — Confirm the publisher identity to pin (`"Nima Karami"` vs a future
  org/brand name). It must match whatever code-signing cert is eventually obtained, or
  auto-update signature verification will fail post-signing. Safe default chosen:
  `"Nima Karami"`.

## References

- `package.json` — `build` (`:33`): `nsis` (`:57`, `oneClick`), `win.icon` (`:55`),
  `artifactName` (`:36`), `publish` (`:64`).
- `build/installer.nsh` — existing `customInstall`/`customUnInstall` (context menu);
  branding must not regress it.
- `.github/workflows/release.yml` — `electron-builder --win --publish never` (`:38`) +
  the deterministic `gh release create` (`:44`); the signing env hook slots in here.
- `assets/icon.ico` / `assets/icon.png` — branding source.
- Prior spec: `archive/2026-06-16-install-update-experience.md` (one-click + silent
  update + context menu) — the frictionless flow this spec preserves.

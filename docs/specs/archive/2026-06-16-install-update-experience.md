---
status: implemented
date: 2026-06-16
---

# Elevate the install + update experience

## Problem

Two rough edges in how Conduit installs and updates on Windows:

1. **No OS integration.** After install there is no Explorer right-click entry to start
   a session in a folder; the user must launch the app and pick a directory.
2. **Updates show the full installer wizard.** Pressing "Relaunch to update" runs the
   assisted NSIS installer interactively (because the updater calls
   `quitAndInstall(false, …)` against an `oneClick: false` installer). The user expects
   the update to just apply and the app to reopen.

Goal: a frictionless, silent install and update, plus an "Open in Conduit" Explorer
context-menu entry on folders.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Installer type | One-click (`oneClick: true`) | Silent install AND silent update by design. Assisted installers (`oneClick: false` + `allowToChangeInstallationDirectory`) have documented-fragile silent updates (electron-builder #2179, #4312, #6555) — the exact failure we're fixing. |
| Install scope | Per-user (`perMachine: false`) | Installs to `%LOCALAPPDATA%\Programs\Conduit`; no UAC elevation, so updates are truly prompt-free. |
| Integrations | Applied automatically (no install-time checkboxes) | User opted out of toggle UI; removes the only remaining reason to keep the assisted wizard. |
| Context-menu placement | Folder **and** folder background | The two common ways to say "open this directory". |
| CLI / PATH | Out of scope | GUI app; the context menu covers "open this folder". Can add a `conduit` CLI later. |
| Launch routing | Single-instance + `second-instance` | Clicking "Open in Conduit" routes into the running app (new session + focus), or launches it if closed. Conduit is single-window. |

## Architecture

### §1 — Installer config (`package.json` → `build.nsis`)

```jsonc
"nsis": {
  "oneClick": true,
  "perMachine": false,
  "createDesktopShortcut": true,
  "createStartMenuShortcut": true,
  "include": "build/installer.nsh"
}
```

Remove `allowToChangeInstallationDirectory` (incompatible with `oneClick: true`). The
existing `artifactName` and `publish` config are unchanged.

Existing v0.1.x assisted installs relocate cleanly to the per-user location on the next
update — NSIS handles the move; no user action required.

### §2 — Explorer context menu (`build/installer.nsh`)

A custom NSIS include with two macros electron-builder runs for one-click installers:

```nsis
!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conduit" "" "Open in Conduit"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conduit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Conduit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conduit" "" "Open in Conduit"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conduit" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Conduit\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Conduit"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Conduit"
!macroend
```

Notes:
- `HKCU` (not `HKLM`) because the install is per-user — no elevation needed.
- Folder right-click passes the selected folder as `%1`; folder **background** right-click
  passes the open directory as `%V` (NSIS/shell convention).
- `${APP_EXECUTABLE_FILENAME}` resolves to `Conduit.exe`; `Icon` gives the entry the app icon.
- `nsis.include` resolves the script relative to the project root; the file lives at
  `build/installer.nsh`.

### §3 — Launch routing (`electron/main.ts`)

The exe is invoked as `Conduit.exe "<dir>"`. Add single-instance handling:

```ts
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const dir = extractDirArg(argv, (p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
    if (dir) openRepo(dir, defaultAgentId());
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}
```

- **First launch with an arg:** after the window is ready, parse `process.argv`; if it
  contains a directory, `openRepo(dir, …)`.
- **Second launch (app already running):** the new process fails to get the lock and
  quits; the primary receives `second-instance` with the new argv and opens the session
  + focuses the window.
- `defaultAgentId()` reuses the existing fallback (`registry.list()[0]`), mirroring how
  `openRepo` already resolves an agent.

**Pure, unit-testable helper** (no Electron dependency):

```ts
// Returns the first argv entry that is an existing directory, else undefined.
// Skips the exe path, the `.` dev arg, and any `--flags`.
export function extractDirArg(
  argv: readonly string[],
  isDir: (p: string) => boolean,
): string | undefined
```

Injecting `isDir` keeps it testable without touching the filesystem.

### §4 — Silent update (`electron/updater.ts`)

Change the staged-update call from `quitAndInstall(false, true)` to:

```ts
autoUpdater.quitAndInstall(true, true); // isSilent, isForceRunAfter
```

With a one-click installer the update runs with no UI regardless; `isSilent: true` makes
it explicit and `isForceRunAfter: true` reopens the app. "Relaunch to update" → quit →
silent apply → relaunch. No wizard, no UAC (per-user).

## Testing

- **Unit:** `extractDirArg` — directory arg returned; file path / `--flag` / `.` / missing
  all yield `undefined`; first matching dir wins.
- **Manual e2e (requires a real packaged build; cannot run in dev or browser preview):**
  1. Install → desktop shortcut + Start-menu entry exist; "Open in Conduit" appears on a
     folder and on folder background.
  2. App closed → "Open in Conduit" launches the app with a session rooted at that folder.
  3. App open → "Open in Conduit" adds a session to the running app and focuses the window.
  4. Uninstall → both registry keys removed (no orphan menu entry).
  5. Publish a higher version → installed app applies it silently on "Relaunch to update"
     (no wizard), then reopens.

  e2e stays out of `npm run verify` (consistent with the repo's existing convention).

## Files touched

| File | Change |
|------|--------|
| `package.json` | `nsis`: `oneClick: true`, drop `allowToChangeInstallationDirectory`, add `include` |
| `build/installer.nsh` | **New.** `customInstall` / `customUnInstall` registry macros for the context menu |
| `electron/main.ts` | Single-instance lock + `second-instance` handler; first-launch argv parse; call `extractDirArg` |
| `electron/arg-utils.ts` | **New.** Pure `extractDirArg(argv, isDir)` helper |
| `test/unit/arg-utils.test.ts` | **New.** Unit tests for `extractDirArg` |
| `electron/updater.ts` | `quitAndInstall(true, true)` |
| `CHANGELOG.md` | User-facing entry |

## Out of scope

- PATH / `conduit` CLI launcher
- Install-time option checkboxes (custom nsDialogs UI)
- macOS / Linux integration
- Per-machine (all-users) install

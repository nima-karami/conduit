---
status: implemented
date: 2026-06-16
---

# Auto-update via GitHub Releases

## Problem

Conduit has no update mechanism. When a new version is published, users have no
way to know about it or apply it without manually downloading the installer from
GitHub. The app should check for updates, download them silently, and offer a
one-click relaunch — the VS Code / Cursor model.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Update library | electron-updater (electron-builder companion) | Battle-tested, handles NSIS differential updates, typed events, GitHub provider built in |
| Distribution channel | GitHub Releases (`nima-karami/conduit`) | Repo is already public; no server to run |
| Update UX | Silent download → sidebar card → user-initiated relaunch | Zero friction; user stays in control of when to restart |
| CI automation | GitHub Actions workflow on `v*` tag push | Removes manual upload errors; verify gate runs before publish |
| Code signing | Deferred | Not required for Windows auto-update; adds certificate/secrets complexity that doesn't block the feature |

## Architecture

### Host: `electron/updater.ts`

A single module that owns the update lifecycle. Exports `initUpdater(send)`,
called from `main.ts` after the window is ready.

**Configuration:**

```ts
import { autoUpdater } from 'electron-updater';

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
```

The publish/provider config lives in `package.json` under the electron-builder
`build.publish` key:

```json
"publish": {
  "provider": "github",
  "owner": "nima-karami",
  "repo": "conduit"
}
```

electron-updater reads this at runtime to know where to check.

**Lifecycle:**

1. On app launch (after window ready), if `app.isPackaged`: call
   `autoUpdater.checkForUpdates()`.
2. Re-check every 4 hours while running (setInterval; cleared on
   `before-quit`).
3. Manual check: the renderer sends `{ type: 'updateCheck' }` → the host calls
   `autoUpdater.checkForUpdates()`.
4. Events are forwarded to the renderer as `updateStatus` messages (see
   Protocol below).
5. Relaunch: on `{ type: 'updateRelaunch' }` from the renderer, call
   `autoUpdater.quitAndInstall(false, true)` (don't force-close dirty windows,
   do relaunch).

**Event mapping (electron-updater → renderer):**

| electron-updater event | `updateStatus.status` | Extra fields |
|------------------------|-----------------------|--------------|
| `checking-for-update` | `checking` | — |
| `update-available` | `available` | `version`, `releaseNotes?` |
| `download-progress` | `downloading` | `percent` |
| `update-downloaded` | `ready` | `version`, `releaseNotes?` |
| `error` | `error` | `message` |
| `update-not-available` | `up-to-date` | — |

**Dev guard:** all check/download logic is wrapped in `if (!app.isPackaged)
return` so dev builds never hit the network or show update UI.

### Protocol additions

**HostToWebview:**

```ts
| {
    type: 'updateStatus';
    status: 'checking' | 'available' | 'downloading' | 'ready'
          | 'up-to-date' | 'error';
    version?: string;
    releaseNotes?: string;
    percent?: number;
    message?: string;
  }
```

**WebviewToHost:**

```ts
| { type: 'updateCheck' }    // manual check from Settings
| { type: 'updateRelaunch' } // user clicked "Relaunch to update"
```

### Renderer: update card (`webview/components/update-card.tsx`)

Positioned in the sidebar, directly above the "Settings" button.

**Visibility rules:**

| `updateStatus.status` | Card visible? | Content |
|-----------------------|---------------|---------|
| `up-to-date` / `checking` | No | — |
| `error` | No (silent; retry on next cycle) |
| `available` / `downloading` | Yes | "Updating to v{version}…" + thin progress bar |
| `ready` | Yes | "Conduit v{version} is ready" + "Relaunch to update" button |

**Design:**
- Compact single-row banner — Lucide icon (e.g. `download` during download,
  `refresh-cw` when ready), version text, action button.
- Uses `--surface`, `--accent`, `--border`, `--text`, `--text-dim` — no new
  design tokens.
- Progress bar: thin accent-colored bar across the bottom of the card.
- "Relaunch to update" button: accent-styled, matches the app's primary action
  buttons.
- Dismissible: "✕" hides the card for this session. State resets on next app
  launch or next check cycle that finds a `ready` update.

**State in `app.tsx`:** a single `updateStatus` state variable (latest
`updateStatus` message from the host) plus a `dismissed` boolean (local, not
persisted). The `UpdateCard` component reads both.

### Settings: manual check button

A "Check for updates" button in the Settings pane (one-shot action, not a
toggle). Clicking sends `{ type: 'updateCheck' }`. The same `updateStatus`
events flow back, so:
- If an update is found → the sidebar card appears.
- If already up-to-date → a toast: "You're on the latest version".

The current app version is shown next to the button as context
("v0.1.0 — Check for updates").

### CI: `.github/workflows/release.yml`

Triggered by pushing a version tag (`v*`).

```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  build-and-publish:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run verify
      - run: npx electron-builder --win --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**What this produces in the GitHub Release:**
- The NSIS installer `.exe`
- `latest.yml` (version, filename, SHA512 hash, file size — what
  electron-updater fetches to check for updates)
- Blockmap files (for differential/delta updates)

**Version bumping is manual:** edit `package.json` version → commit → tag →
push. The workflow does NOT auto-bump to avoid commit loops.

**Release flow:**

```
npm version patch    # bumps package.json, creates commit + tag
git push --tags      # triggers the workflow
```

## Edge cases

| Scenario | Behaviour |
|----------|-----------|
| Dev build (`!app.isPackaged`) | No checks, no downloads, no UI — completely silent |
| Network offline during check | `error` event → card stays hidden, retries on next 4h cycle |
| Download interrupted | electron-updater resumes on next check; partial download is discarded |
| User ignores the card and quits | `autoInstallOnAppQuit = true` → update applies on next launch |
| User dismisses the card | Hidden for this session; reappears on next launch if the update is still staged |
| Multiple rapid version publishes | electron-updater always fetches `latest.yml` → only the newest version is offered |
| Manual check when already up-to-date | Toast "You're on the latest version", no card |
| Manual check when update is downloading | No-op; existing download continues, card already visible |

## Files touched

| File | Change |
|------|--------|
| `electron/updater.ts` | **New.** Update lifecycle module |
| `electron/main.ts` | Import + call `initUpdater(send)`; handle `updateCheck` and `updateRelaunch` messages; clear interval on `before-quit` |
| `src/protocol.ts` | Add `updateStatus` to `HostToWebview`; add `updateCheck` and `updateRelaunch` to `WebviewToHost` |
| `webview/components/update-card.tsx` | **New.** Sidebar update card component |
| `webview/styles.css` | Styles for the update card |
| `webview/app.tsx` | `updateStatus` state; wire `UpdateCard` into sidebar; handle `updateStatus` messages; toast for up-to-date on manual check |
| `webview/components/sidebar.tsx` | Render `UpdateCard` above the Settings button |
| `webview/components/settings-modal.tsx` | "Check for updates" button + current version display |
| `package.json` | Add `electron-updater` dependency; add `build.publish` config |
| `.github/workflows/release.yml` | **New.** CI release workflow |

## Out of scope

- macOS / Linux targets (Windows NSIS only today)
- Code signing (deferred; not required for Windows auto-update)
- Staged/percentage rollouts
- Release notes rendering in the card (version string only for v1; `releaseNotes` is available in the protocol for later)
- Auto-update settings toggle (on/off) — the 4h check is lightweight; can add a disable toggle later if users want it

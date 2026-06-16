# Install + Update Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-click silent installer with silent updates, plus an "Open in Conduit" Windows Explorer context-menu entry that opens a session rooted at the clicked folder.

**Architecture:** Switch the NSIS installer to one-click (silent install + silent update by design). A custom NSIS include script writes per-user registry keys for the context menu. The Electron main process gains a single-instance lock so the context-menu launch routes a new session into the running app (or launches it if closed); a small pure helper extracts the directory argument from `argv`. The updater applies staged updates silently.

**Tech Stack:** electron-builder NSIS, electron-updater, Electron `requestSingleInstanceLock`, vitest.

**Spec:** `docs/specs/2026-06-16-install-update-experience.md`

**Verify command:** `npm run verify` (format + lint + dead-code + typecheck + tests + security). The installer/registry/silent-update behavior is **not** covered by `verify` — it requires a packaged build and a real install (manual e2e, see Task 6). Building the installer locally: `npm run build && npx electron-builder --win --publish never`.

## Global Constraints

- **Per-user install only** — `perMachine: false`; registry writes go to `HKCU` (no elevation/UAC).
- **One-click installer** — `oneClick: true`; `allowToChangeInstallationDirectory` must be removed (incompatible).
- **Windows-only** — this feature targets the Windows NSIS target; no macOS/Linux work.
- **Context-menu label** — exactly `Open in Conduit`, on `Directory` and `Directory\Background`.
- **Executable reference in NSIS** — `$INSTDIR\${APP_EXECUTABLE_FILENAME}` (resolves to `Conduit.exe`).
- **Never weaken `npm run verify`** — fix code, not the gate. Never `| tail` its output.
- **e2e stays out of `verify`** — consistent with the repo convention.
- **Scratch artifacts** → OS temp dir, never the repo.

---

### Task 1: `extractDirArg` pure helper

**Files:**
- Create: `electron/arg-utils.ts`
- Test: `test/unit/arg-utils.test.ts`

**Interfaces:**
- Produces: `extractDirArg(argv: readonly string[], isDir: (p: string) => boolean): string | undefined` — returns the first argv entry that `isDir` accepts, skipping the executable path, the Electron dev `.` arg, and any `--flags`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/arg-utils.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractDirArg } from '../../electron/arg-utils';

// Injected directory predicate: treat exactly these paths as existing directories.
const dirsAre = (dirs: string[]) => (p: string) => dirs.includes(p);

describe('extractDirArg', () => {
  it('returns the directory argument after the packaged exe path', () => {
    expect(
      extractDirArg(['C:/App/Conduit.exe', 'C:/work/proj'], dirsAre(['C:/work/proj'])),
    ).toBe('C:/work/proj');
  });

  it('skips the Electron dev "." argument', () => {
    expect(
      extractDirArg(['electron', '.', 'C:/work/proj'], dirsAre(['C:/work/proj'])),
    ).toBe('C:/work/proj');
  });

  it('skips --flags', () => {
    expect(
      extractDirArg(['Conduit.exe', '--squirrel-firstrun', 'C:/work/proj'], dirsAre(['C:/work/proj'])),
    ).toBe('C:/work/proj');
  });

  it('returns undefined when no argument is a directory (e.g. a file path)', () => {
    expect(extractDirArg(['Conduit.exe', 'C:/work/file.txt'], dirsAre([]))).toBeUndefined();
  });

  it('returns undefined for argv with only the exe path', () => {
    expect(extractDirArg(['Conduit.exe'], dirsAre([]))).toBeUndefined();
  });

  it('returns the first directory when several match', () => {
    expect(extractDirArg(['Conduit.exe', 'C:/a', 'C:/b'], dirsAre(['C:/a', 'C:/b']))).toBe('C:/a');
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL (module missing)**

```bash
npx vitest run test/unit/arg-utils.test.ts
```

Expected: FAIL — cannot find module `../../electron/arg-utils`.

- [ ] **Step 3: Implement the helper**

Create `electron/arg-utils.ts`:

```ts
/**
 * Find the directory argument in a process `argv`. The "Open in Conduit" Explorer action
 * launches `Conduit.exe "<dir>"`, so on launch (or via the single-instance `second-instance`
 * event) we scan argv for the folder to open. Skips the executable path (a file, so the
 * `isDir` check rejects it), the Electron dev `.` arg, and any `--flags`. Returns the first
 * remaining entry that `isDir` accepts, or `undefined`.
 *
 * `isDir` is injected so this stays pure and unit-testable without touching the filesystem.
 */
export function extractDirArg(
  argv: readonly string[],
  isDir: (p: string) => boolean,
): string | undefined {
  for (const arg of argv) {
    if (!arg || arg === '.' || arg.startsWith('-')) continue;
    if (isDir(arg)) return arg;
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
npx vitest run test/unit/arg-utils.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Run full verify**

```bash
npm run verify
```

Expected: EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add electron/arg-utils.ts test/unit/arg-utils.test.ts
git commit -m "feat(host): add extractDirArg — find the directory argument in argv"
```

---

### Task 2: Single-instance lock + launch routing in main.ts

**Files:**
- Modify: `electron/main.ts`

**Interfaces:**
- Consumes: `extractDirArg` (Task 1); the existing `openRepo(p: string, agentId: string, cardId?: string)` (defined inside the `app.whenReady()` callback, ~line 383); the module-level `win: BrowserWindow | null`; the in-scope `registry` (an `AgentRegistry` with `.list()`).

The context-menu launch invokes `Conduit.exe "<dir>"`. A single-instance lock makes the second launch route its folder into the already-running primary instead of opening a duplicate app.

- [ ] **Step 1: Add the import**

In `electron/main.ts`, after the existing `import { OpenFileWatcher } from './open-file-watcher';` line (near line 66), add:

```ts
import { extractDirArg } from './arg-utils';
```

(`fs` and `path` are already imported in this file.)

- [ ] **Step 2: Acquire the single-instance lock at the top of `whenReady`**

Find the start of the ready handler (line ~221):

```ts
app.whenReady().then(() => {
  // Detected shells first (so nothing defaults to an agent), then configured agents.
  const registry = new AgentRegistry([...detectShells(), ...loadAgents(agentsFile())]);
```

Insert the lock guard as the very first statements inside the callback, before the `registry` line:

```ts
app.whenReady().then(() => {
  // Single-instance: a second launch (e.g. the "Open in Conduit" context menu while the
  // app is already running) must route its folder into THIS instance, not open a duplicate.
  // The loser instance quits immediately; the primary handles `second-instance` below.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // Detected shells first (so nothing defaults to an agent), then configured agents.
  const registry = new AgentRegistry([...detectShells(), ...loadAgents(agentsFile())]);
```

- [ ] **Step 3: Register the second-instance handler + handle the first-launch arg**

Find where the window is created near the end of the ready callback (line ~941):

```ts
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
```

Replace that block with:

```ts
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // "Open in Conduit" launches `Conduit.exe "<dir>"`. Resolve the directory argument and
  // open a session there with the default terminal (openRepo falls back to registry.list()[0]
  // when the agent id is unknown). Used for both a second launch and this first launch.
  const isDir = (p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const openDirArg = (argv: readonly string[]) => {
    const dir = extractDirArg(argv, isDir);
    if (dir) openRepo(dir, registry.list()[0]?.id ?? '');
  };

  app.on('second-instance', (_event, argv) => {
    openDirArg(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // First launch opened via the context menu while the app was closed.
  openDirArg(process.argv);
});
```

- [ ] **Step 4: Typecheck both projects**

```bash
npm run typecheck
```

Expected: EXIT 0.

- [ ] **Step 5: Run full verify**

```bash
npm run verify
```

Expected: EXIT 0. (No unit test for the Electron wiring; the routing logic is covered by Task 1's `extractDirArg` tests and the Task 6 manual e2e.)

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts
git commit -m "feat(host): single-instance lock + route 'Open in Conduit' folder to a session"
```

---

### Task 3: Silent update

**Files:**
- Modify: `electron/updater.ts`

- [ ] **Step 1: Make the staged update apply silently**

In `electron/updater.ts`, find `quitAndInstall`:

```ts
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true);
}
```

Change the first argument (`isSilent`) to `true`:

```ts
export function quitAndInstall(): void {
  // isSilent=true, isForceRunAfter=true: with the one-click installer the update applies
  // with no installer UI and the app relaunches. (The old `false` showed the full wizard.)
  autoUpdater.quitAndInstall(true, true);
}
```

- [ ] **Step 2: Run full verify**

```bash
npm run verify
```

Expected: EXIT 0.

- [ ] **Step 3: Commit**

```bash
git add electron/updater.ts
git commit -m "fix(updater): apply staged updates silently (no installer wizard)"
```

---

### Task 4: One-click installer config + Explorer context-menu script

**Files:**
- Modify: `package.json` (`build.nsis`)
- Create: `build/installer.nsh`

- [ ] **Step 1: Create the custom NSIS include**

Create `build/installer.nsh`:

```nsis
; Custom NSIS include — electron-builder merges this via the `nsis.include` option.
; Adds an "Open in Conduit" entry to the Windows Explorer context menu for folders and
; for folder backgrounds, pointing at the installed executable. Written to HKCU to match
; the per-user (perMachine:false) install, so no elevation is required.
;   %1  — the selected folder (Directory right-click)
;   %V  — the open folder (Directory\Background right-click)

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

- [ ] **Step 2: Switch the installer to one-click + register the include**

In `package.json`, replace the `"nsis"` block (currently):

```json
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    },
```

with:

```json
    "nsis": {
      "oneClick": true,
      "perMachine": false,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "include": "build/installer.nsh"
    },
```

(`allowToChangeInstallationDirectory` is removed — it is invalid with `oneClick: true`.)

- [ ] **Step 3: Build the installer locally to confirm it packages**

```bash
npm run build && npx electron-builder --win --publish never
```

Expected: EXIT 0, and `dist/Conduit-Setup-<version>.exe` is produced. A successful build confirms the NSIS script compiled and was included (a syntax error in `build/installer.nsh` would fail the build).

> Note: a passing build does NOT prove the registry keys land — that is verified by a real install in Task 6. If, on install, the context menu is absent, the include was not picked up: confirm the path `nsis.include` resolves to `<projectDir>/build/installer.nsh`.

- [ ] **Step 4: Run full verify**

```bash
npm run verify
```

Expected: EXIT 0. (`.nsh` is not linted; the only code change is `package.json`.)

- [ ] **Step 5: Commit**

```bash
git add package.json build/installer.nsh
git commit -m "feat(installer): one-click installer + 'Open in Conduit' Explorer context menu"
```

---

### Task 5: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add an Unreleased section**

In `CHANGELOG.md`, directly below the intro paragraph and above the `## [0.1.1] — 2026-06-16` heading, add:

```markdown
## [Unreleased]

### Added
- **"Open in Conduit" in the Explorer right-click menu:** right-click a folder (or the
  empty space inside one) and choose "Open in Conduit" to start a session rooted there —
  it opens in your running Conduit, or launches the app if it's closed.

### Changed
- **Installs and updates are now silent:** Conduit ships as a one-click installer, and
  applying an update no longer shows the installer wizard — pressing "Relaunch to update"
  simply updates and reopens the app.

```

- [ ] **Step 2: Run full verify**

```bash
npm run verify
```

Expected: EXIT 0.

- [ ] **Step 3: Commit + push**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for one-click installer, context menu, silent updates"
git push
```

---

### Task 6: Manual end-to-end verification (real build)

**Files:** none (verification only).

This feature's behavior lives in the packaged installer and the running OS integration, so it cannot be exercised by `verify`, dev mode, or the browser preview. Validate on a real Windows install. This is the gate before cutting a release.

- [ ] **Step 1: Build the installer**

```bash
npm run build && npx electron-builder --win --publish never
```

Run `dist/Conduit-Setup-<version>.exe`.

- [ ] **Step 2: Verify install integrations**

- Install completes one-click (no folder-picker, no wizard pages).
- A desktop shortcut and a Start-menu entry exist.
- Right-clicking a folder shows "Open in Conduit" (with the app icon).
- Right-clicking empty space inside an open folder shows "Open in Conduit".

- [ ] **Step 3: Verify launch routing**

- With Conduit **closed**, click "Open in Conduit" on a folder → the app launches with a new session rooted at that folder.
- With Conduit **open**, click "Open in Conduit" on a different folder → a new session for that folder appears in the running app and the window is focused (no second app instance).

- [ ] **Step 4: Verify silent update**

- Note the installed version. Bump the version and publish a new release (`npm run release` once this branch is merged), or sideload a higher-version `latest.yml` + installer to the GitHub release.
- In the installed (older) app, wait for the update card / use Settings → Check now → the update downloads.
- Press "Relaunch to update" → the app closes, updates with **no installer wizard**, and reopens on the new version.

- [ ] **Step 5: Verify uninstall cleanup**

- Uninstall Conduit.
- Confirm "Open in Conduit" no longer appears on folders or folder backgrounds (registry keys removed).

- [ ] **Step 6: Record the result**

Note the outcome in the PR / run notes. If any step fails, file the specific failure and address it before release.

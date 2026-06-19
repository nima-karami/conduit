# Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add silent auto-update via electron-updater + GitHub Releases, with a sidebar card announcing ready updates and a manual "Check for updates" button in Settings.

**Architecture:** `electron/updater.ts` owns the lifecycle (check/download/install). It forwards typed `updateStatus` events to the renderer via the existing `send()` IPC. The renderer shows a compact card above the sidebar's Settings button when an update is downloading or ready. A CI workflow builds and publishes on version-tag push.

**Tech Stack:** electron-updater, GitHub Releases provider, GitHub Actions (windows-latest), existing React + esbuild renderer

**Spec:** `docs/specs/archive/2026-06-16-auto-update.md`

**Verify command:** `npm run verify` (format + lint + typecheck + tests + security). Also `node esbuild.mjs` (renderer bundle — verify doesn't catch browser-unsafe imports).

---

### Task 1: Install electron-updater and add publish config

**Files:**
- Modify: `package.json` (dependencies + build.publish)

- [ ] **Step 1: Install electron-updater**

```bash
npm install electron-updater
```

This adds it to `dependencies` in package.json. It must be a runtime dependency (not devDependency) because the packaged app imports it.

- [ ] **Step 2: Add publish config to the electron-builder build section**

In `package.json`, add a `publish` key inside the `"build"` object (after the `"nsis"` block, around line 59):

```json
    "publish": {
      "provider": "github",
      "owner": "nima-karami",
      "repo": "conduit"
    }
```

This tells both the CI build (where to upload) and the running app (where to check).

- [ ] **Step 3: Run verify**

```bash
npm run verify
```

Expected: EXIT 0 (no code changes, just dependency + config).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add electron-updater + GitHub publish config"
```

---

### Task 2: Protocol — add updateStatus, updateCheck, updateRelaunch messages

**Files:**
- Modify: `src/protocol.ts`
- Create: `test/unit/protocol-update.test.ts`

- [ ] **Step 1: Write a type-level test**

Create `test/unit/protocol-update.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { HostToWebview, WebviewToHost } from '../../src/protocol';

describe('update protocol types', () => {
  it('updateStatus message is assignable to HostToWebview', () => {
    const msgs: HostToWebview[] = [
      { type: 'updateStatus', status: 'checking' },
      { type: 'updateStatus', status: 'available', version: '0.2.0' },
      { type: 'updateStatus', status: 'available', version: '0.2.0', releaseNotes: 'Bug fixes' },
      { type: 'updateStatus', status: 'downloading', percent: 42 },
      { type: 'updateStatus', status: 'ready', version: '0.2.0' },
      { type: 'updateStatus', status: 'up-to-date' },
      { type: 'updateStatus', status: 'error', message: 'Network error' },
    ];
    expect(msgs).toHaveLength(7);
  });

  it('updateCheck and updateRelaunch are assignable to WebviewToHost', () => {
    const msgs: WebviewToHost[] = [
      { type: 'updateCheck' },
      { type: 'updateRelaunch' },
    ];
    expect(msgs).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test — expect it to FAIL (types don't exist yet)**

```bash
npx vitest run test/unit/protocol-update.test.ts
```

Expected: TypeScript compilation error — `'updateStatus'` is not assignable.

- [ ] **Step 3: Add the types to protocol.ts**

In `src/protocol.ts`, add to the `HostToWebview` union (after the `fileChanged` entry, before the closing semicolon):

```ts
  // Auto-update lifecycle events from electron-updater. The renderer shows a
  // sidebar card when status is 'available'/'downloading'/'ready'.
  | {
      type: 'updateStatus';
      status: 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';
      version?: string;
      releaseNotes?: string;
      percent?: number;
      message?: string;
    }
```

Add to the `WebviewToHost` union (after `term:dispose`, before the closing semicolon):

```ts
  | { type: 'updateCheck' }
  | { type: 'updateRelaunch' }
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
npx vitest run test/unit/protocol-update.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full verify**

```bash
npm run verify
```

Expected: EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add src/protocol.ts test/unit/protocol-update.test.ts
git commit -m "feat(protocol): add updateStatus, updateCheck, updateRelaunch messages"
```

---

### Task 3: Host — create electron/updater.ts

**Files:**
- Create: `electron/updater.ts`

This is the core update lifecycle module. It cannot be unit-tested in vitest (it imports `electron-updater` which requires Electron runtime), so it is kept thin and declarative — a wiring layer, not business logic.

- [ ] **Step 1: Create electron/updater.ts**

```ts
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { HostToWebview } from '../src/protocol';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Wire electron-updater events to a send function and start the periodic
 * update check. Call once after the BrowserWindow is ready.
 *
 * Returns a cleanup function for `before-quit`.
 */
export function initUpdater(send: (msg: HostToWebview) => void): () => void {
  if (!app.isPackaged) return () => {};

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    send({ type: 'updateStatus', status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    send({
      type: 'updateStatus',
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    send({
      type: 'updateStatus',
      status: 'downloading',
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    send({
      type: 'updateStatus',
      status: 'ready',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    });
  });

  autoUpdater.on('update-not-available', () => {
    send({ type: 'updateStatus', status: 'up-to-date' });
  });

  autoUpdater.on('error', (err) => {
    send({ type: 'updateStatus', status: 'error', message: err?.message ?? String(err) });
  });

  // Initial check on launch.
  void autoUpdater.checkForUpdates().catch(() => {});

  // Periodic re-check.
  intervalId = setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, CHECK_INTERVAL_MS);

  return () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

/** Trigger a manual update check (from Settings). */
export function checkForUpdate(): void {
  if (!app.isPackaged) return;
  void autoUpdater.checkForUpdates().catch(() => {});
}

/** Quit and install the staged update. */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true);
}
```

- [ ] **Step 2: Run typecheck (host tsconfig)**

```bash
npx tsc -p tsconfig.json --noEmit
```

Expected: EXIT 0. (electron-updater types are available from the installed package.)

- [ ] **Step 3: Run full verify**

```bash
npm run verify
```

Expected: EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add electron/updater.ts
git commit -m "feat(host): add updater.ts — electron-updater lifecycle + event forwarding"
```

---

### Task 4: Host — wire updater into main.ts

**Files:**
- Modify: `electron/main.ts`

- [ ] **Step 1: Add import**

At the top of `electron/main.ts`, after the `OpenFileWatcher` import (around line 66):

```ts
import { checkForUpdate, initUpdater, quitAndInstall } from './updater';
```

- [ ] **Step 2: Initialize the updater after the window is created**

In `main.ts`, find the `openFileWatcher` instantiation (around line 412, the line that starts with `const openFileWatcher`). Add the updater initialization right after it:

```ts
  const cleanupUpdater = initUpdater(send);
```

- [ ] **Step 3: Handle updateCheck and updateRelaunch messages**

In the `switch (m.type)` inside `async function handle(m: WebviewToHost)`, add two new cases. Add them after the `watchFiles` case (around line 514):

```ts
        case 'updateCheck':
          checkForUpdate();
          break;
        case 'updateRelaunch':
          quitAndInstall();
          break;
```

- [ ] **Step 4: Clean up on before-quit**

In the `app.on('before-quit', ...)` handler, add the updater cleanup before `pty.disposeAll()`:

```ts
    cleanupUpdater();
```

- [ ] **Step 5: Run typecheck**

```bash
npx tsc -p tsconfig.json --noEmit
```

Expected: EXIT 0.

- [ ] **Step 6: Run full verify**

```bash
npm run verify
```

Expected: EXIT 0.

- [ ] **Step 7: Commit**

```bash
git add electron/main.ts
git commit -m "feat(host): wire updater into main.ts — init, message handling, cleanup"
```

---

### Task 5: Renderer — update card component

**Files:**
- Create: `webview/components/update-card.tsx`
- Modify: `webview/styles.css`

- [ ] **Step 1: Create update-card.tsx**

```tsx
import type { HostToWebview } from '../../src/protocol';
import { post } from '../bridge';
import { IconDownload, IconRefreshCw, IconX } from '../icons';

/** The subset of updateStatus the card cares about. */
export type UpdateStatus = Extract<HostToWebview, { type: 'updateStatus' }>;

interface UpdateCardProps {
  status: UpdateStatus;
  dismissed: boolean;
  onDismiss: () => void;
}

export function UpdateCard({ status, dismissed, onDismiss }: UpdateCardProps) {
  if (dismissed) return null;
  const s = status.status;

  if (s === 'available' || s === 'downloading') {
    return (
      <div className="update-card">
        <div className="update-card__body">
          <IconDownload size={14} />
          <span className="update-card__text">
            Updating to v{status.version ?? '?'}…
          </span>
          <button
            type="button"
            className="update-card__dismiss"
            onClick={onDismiss}
            title="Dismiss"
          >
            <IconX size={12} />
          </button>
        </div>
        {s === 'downloading' && (
          <div className="update-card__progress">
            <div
              className="update-card__bar"
              style={{ width: `${status.percent ?? 0}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  if (s === 'ready') {
    return (
      <div className="update-card">
        <div className="update-card__body">
          <IconRefreshCw size={14} />
          <span className="update-card__text">
            v{status.version ?? '?'} ready
          </span>
          <button
            type="button"
            className="update-card__dismiss"
            onClick={onDismiss}
            title="Dismiss"
          >
            <IconX size={12} />
          </button>
        </div>
        <button
          type="button"
          className="update-card__action"
          onClick={() => post({ type: 'updateRelaunch' })}
        >
          Relaunch to update
        </button>
      </div>
    );
  }

  return null;
}
```

- [ ] **Step 2: Check that the icon imports exist**

Open `webview/icons.tsx` (or wherever the Lucide icon re-exports live) and confirm `IconDownload`, `IconRefreshCw`, and `IconX` are exported. If any are missing, add them:

```ts
export { Download as IconDownload } from 'lucide-react';
export { RefreshCw as IconRefreshCw } from 'lucide-react';
export { X as IconX } from 'lucide-react';
```

Only add the ones that are missing — don't duplicate existing exports.

- [ ] **Step 3: Add styles to webview/styles.css**

Add after the `sidebar__foot` / `.footbtn` block (around line 2992):

```css
/* ---------- update card (above Settings) ---------- */
.update-card {
  margin: 0 8px 6px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  overflow: hidden;
}
.update-card__body {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  color: var(--text-dim);
  font-size: calc(12px * var(--font-scale));
}
.update-card__text {
  flex: 1;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.update-card__dismiss {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: var(--text-faint);
  cursor: pointer;
  padding: 2px;
  border-radius: var(--r-sm);
  line-height: 1;
}
.update-card__dismiss:hover {
  color: var(--text);
  background: var(--raise);
}
.update-card__progress {
  height: 2px;
  background: var(--border);
}
.update-card__bar {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s ease;
}
.update-card__action {
  display: block;
  width: calc(100% - 16px);
  margin: 0 8px 8px;
  padding: 5px 10px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: var(--r-sm);
  cursor: pointer;
  font-size: calc(12px * var(--font-scale));
  font-family: var(--font-mono);
  text-align: center;
}
.update-card__action:hover {
  filter: brightness(1.1);
}
```

- [ ] **Step 4: Run typecheck (webview tsconfig)**

```bash
npx tsc -p tsconfig.webview.json --noEmit
```

Expected: EXIT 0.

- [ ] **Step 5: Build the renderer bundle**

```bash
node esbuild.mjs
```

Expected: EXIT 0 (no node:* imports in the new component).

- [ ] **Step 6: Run full verify**

```bash
npm run verify
```

Expected: EXIT 0.

- [ ] **Step 7: Commit**

```bash
git add webview/components/update-card.tsx webview/styles.css webview/icons.tsx
git commit -m "feat(ui): add update card component + styles"
```

(Omit `webview/icons.tsx` from the add if no icon exports were added.)

---

### Task 6: Renderer — wire update card into sidebar and app.tsx

**Files:**
- Modify: `webview/app.tsx`
- Modify: `webview/components/sidebar.tsx`

- [ ] **Step 1: Add updateStatus state to app.tsx**

In `app.tsx`, near the other `useState` declarations (around line 104), add:

```ts
  const [updateStatus, setUpdateStatus] = useState<HostToWebview & { type: 'updateStatus' } | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
```

- [ ] **Step 2: Handle updateStatus messages in the subscribe handler**

In the `subscribe((msg) => { ... })` block in `app.tsx`, add a new `else if` branch after the `fileChanged` handler (around line 211):

```ts
      else if (msg.type === 'updateStatus') {
        setUpdateStatus(msg);
        // When a new 'ready' update arrives, un-dismiss (in case user dismissed
        // during download and the download has now completed).
        if (msg.status === 'ready') setUpdateDismissed(false);
      }
```

- [ ] **Step 3: Pass update props to Sidebar**

In the JSX where `<Sidebar>` is rendered, add three new props:

```tsx
  updateStatus={updateStatus}
  updateDismissed={updateDismissed}
  onUpdateDismiss={() => setUpdateDismissed(true)}
```

- [ ] **Step 4: Update Sidebar component to accept and render the update card**

In `webview/components/sidebar.tsx`, add the import at the top:

```ts
import { UpdateCard, type UpdateStatus } from './update-card';
```

Extend the component's props type with three new fields:

```ts
  updateStatus?: UpdateStatus | null;
  updateDismissed?: boolean;
  onUpdateDismiss?: () => void;
```

In the JSX, insert the `UpdateCard` inside `sidebar__foot`, directly above the Settings button:

```tsx
      <div className="sidebar__foot">
        {updateStatus && onUpdateDismiss && (
          <UpdateCard
            status={updateStatus}
            dismissed={updateDismissed ?? false}
            onDismiss={onUpdateDismiss}
          />
        )}
        <button className="footbtn" onClick={onOpenSettings} title="Settings (Ctrl+,)">
          <IconSettings size={15} />
          <span>Settings</span>
        </button>
      </div>
```

- [ ] **Step 5: Run typecheck (both tsconfigs)**

```bash
npm run typecheck
```

Expected: EXIT 0.

- [ ] **Step 6: Build renderer**

```bash
node esbuild.mjs
```

Expected: EXIT 0.

- [ ] **Step 7: Run full verify**

```bash
npm run verify
```

Expected: EXIT 0.

- [ ] **Step 8: Commit**

```bash
git add webview/app.tsx webview/components/sidebar.tsx
git commit -m "feat(ui): wire update card into sidebar — state, message handling, rendering"
```

---

### Task 7: Settings — "Check for updates" button

**Files:**
- Modify: `webview/components/settings-modal.tsx`

- [ ] **Step 1: Add manual check button to the About section**

In `settings-modal.tsx`, find the `About` component (around line 785). The component currently receives `about?: AboutInfo`. Add an `onCheckUpdate` prop and an `updateStatus` prop:

```ts
function About({
  about,
  onCheckUpdate,
  updateChecking,
}: {
  about?: AboutInfo;
  onCheckUpdate: () => void;
  updateChecking: boolean;
}) {
```

After the version display (`<span className="about__version">v{about?.version ?? '—'}</span>`), add a check-for-updates row inside the `about__rows` div:

```tsx
        <div className="about__row">
          <span className="about__rowlabel">Updates</span>
          <button
            type="button"
            className="about__checkbtn"
            onClick={onCheckUpdate}
            disabled={updateChecking}
          >
            {updateChecking ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
```

- [ ] **Step 2: Thread the props from SettingsModal**

The `SettingsModal` component needs to receive the update status and expose the check action. Add props:

```ts
  onCheckUpdate?: () => void;
  updateChecking?: boolean;
```

Pass them through to the `About` component where it's rendered:

```tsx
  <About
    about={about}
    onCheckUpdate={onCheckUpdate ?? (() => {})}
    updateChecking={updateChecking ?? false}
  />
```

- [ ] **Step 3: Wire it from app.tsx**

In `app.tsx`, where `<SettingsModal>` is rendered, add the new props:

```tsx
  <SettingsModal
    agents={agents}
    initialTab={settingsTab}
    about={state?.about}
    onClose={() => setSettingsOpen(false)}
    onCheckUpdate={() => {
      post({ type: 'updateCheck' });
    }}
    updateChecking={updateStatus?.status === 'checking'}
  />
```

- [ ] **Step 4: Add a toast for "up-to-date" on manual check**

In `app.tsx`, in the `updateStatus` message handler (added in Task 6), extend the logic to toast when a manual check finds no update. Track whether the check was manual:

```ts
  const manualCheckRef = useRef(false);
```

Update the check trigger:

```tsx
    onCheckUpdate={() => {
      manualCheckRef.current = true;
      post({ type: 'updateCheck' });
    }}
```

In the `updateStatus` handler:

```ts
      else if (msg.type === 'updateStatus') {
        setUpdateStatus(msg);
        if (msg.status === 'ready') setUpdateDismissed(false);
        if (msg.status === 'up-to-date' && manualCheckRef.current) {
          pushToast({ message: "You're on the latest version.", variant: 'info' });
        }
        if (msg.status !== 'checking') manualCheckRef.current = false;
      }
```

- [ ] **Step 5: Add the button style**

In `webview/styles.css`, add near the existing `about__` styles:

```css
.about__checkbtn {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text);
  cursor: pointer;
  font-size: calc(12px * var(--font-scale));
  font-family: var(--font-mono);
  padding: 4px 10px;
}
.about__checkbtn:hover:not(:disabled) {
  background: var(--raise);
}
.about__checkbtn:disabled {
  color: var(--text-faint);
  cursor: default;
}
```

- [ ] **Step 6: Run typecheck + verify + build**

```bash
npm run verify && node esbuild.mjs
```

Expected: both EXIT 0.

- [ ] **Step 7: Commit**

```bash
git add webview/components/settings-modal.tsx webview/app.tsx webview/styles.css
git commit -m "feat(settings): add Check for updates button in About section"
```

---

### Task 8: CI workflow — release.yml

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

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

Key details:
- `permissions: contents: write` — required so the `GITHUB_TOKEN` can create releases and upload assets.
- `windows-latest` — matches the only target (NSIS).
- `--publish always` — creates a GitHub Release and uploads installer + `latest.yml` + blockmap.
- `npm run verify` runs before building — the gate must pass before any artifact is published.

- [ ] **Step 2: Run verify (the workflow itself is not testable locally, but the repo should stay green)**

```bash
npm run verify
```

Expected: EXIT 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow — build + publish on version tag push"
```

---

### Task 9: Update mock bridge for browser preview

**Files:**
- Modify: `webview/bridge.ts`

The mock bridge (used in `preview-server.mjs`) needs to handle the new `updateCheck` and `updateRelaunch` messages so the preview doesn't crash. These are no-ops in the mock.

- [ ] **Step 1: Add cases to the mock handler**

Find the `mockHost` function in `webview/bridge.ts`. Add the new message types to whatever switch/if chain handles mock messages. They should be silent no-ops:

```ts
    case 'updateCheck':
    case 'updateRelaunch':
      break;
```

If `mockHost` uses a different pattern (e.g. it ignores unknown types by default), verify that these new types don't cause a console warning or error. If they're already silently ignored, no change is needed.

- [ ] **Step 2: Run the preview server and verify no console errors**

```bash
node esbuild.mjs
node tools/preview-server.mjs 5180
```

Open `http://127.0.0.1:5180/preview.html` in a browser. Check the console for errors. Expected: no new errors from the update-related code (since `updateStatus` is null, the card doesn't render).

- [ ] **Step 3: Run full verify + build**

```bash
npm run verify && node esbuild.mjs
```

Expected: both EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add webview/bridge.ts
git commit -m "fix(bridge): handle updateCheck/updateRelaunch in mock bridge"
```

(Skip this task entirely if the mock already ignores unknown message types.)

---

### Task 10: CHANGELOG + final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry**

In `CHANGELOG.md` under `## [Unreleased]` → `### Added`, add:

```markdown
- **Automatic updates:** the app checks for updates on launch (and every 4 hours),
  downloads silently, and shows a card in the sidebar when a new version is ready.
  Click "Relaunch to update" to apply. A "Check for updates" button in Settings
  triggers a manual check. Updates are published via GitHub Releases.
```

- [ ] **Step 2: Run full verify + renderer build**

```bash
npm run verify && node esbuild.mjs
```

Expected: both EXIT 0.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for auto-update feature"
```

- [ ] **Step 4: Push**

```bash
git push
```

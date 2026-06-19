---
status: implemented
date: 2026-06-19
---

# Open files in Conduit from the OS

## Problem

Conduit can be launched on a **folder** from the OS (the shipped "Open in Conduit"
Explorer entry on directories + single-instance routing, `docs/specs/2026-06-16-install-update-experience.md`),
but there is no way to open a **file** from the OS into Conduit's editor — no "Open with
Conduit" on files, no registration that lets Conduit be picked as a default code editor,
and the launch-argv parser (`extractDirArg`) only recognises directories.

Goal: right-click **any file** → "Open with Conduit" opens it in Conduit's editor, and
Conduit is a registered handler the user can set as the **default app** for chosen file
types via Windows (Open-with / Settings → Default apps). Reuses the shipped single-instance
launch routing and the renderer's existing doc/viewer infrastructure.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| OS hook | Universal "Open with Conduit" context menu on all files **+** ProgID/app registration | User wants both a right-click entry and the ability to set Conduit as default editor. |
| "Default editor" mechanism | Register a selectable handler (ProgID + `Applications\Conduit.exe` + Default-Apps `Capabilities`); user confirms the default | Modern Windows won't let an app silently claim defaults — registration makes Conduit *selectable*, the user opts in. |
| Session root for a lone file | Git root if the file is inside a repo, else the file's parent directory | Matches Conduit's repo-centric session model. |
| Reuse vs. new session | Reuse an existing session whose `projectPath` is the nearest ancestor of the file; else create one at the root | Opening a file in an already-open project adds a tab, not a duplicate session. |
| Routing | Host-led: the host creates/reuses the session, then tells the renderer to open the doc | Session creation lives on the host (`openRepo`); the renderer only renders. |
| Platform | Windows only (v1) | Consistent with the shipped folder integration; macOS/Linux are out of scope. |

## Architecture

### §1 — Windows registration (`build/installer.nsh`)

Extend the existing `customInstall` / `customUnInstall` macros (all `HKCU`, per-user, no
elevation — matching the shipped folder entries). Three additions:

1. **Universal file context menu** — `Software\Classes\*\shell\Conduit` ("Open with
   Conduit", `Icon` = the exe, `command` = `'"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'`).
   `*` is the all-files class, so the entry appears on every file's right-click.
2. **App registration (ProgID)** — `Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command`
   = `'"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'`, plus
   `Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes` listing the curated extensions
   (below). This makes Conduit appear in **Open with → Choose another app** and selectable
   as "Always".
3. **Default-Apps capability** — `Software\Conduit\Capabilities` with
   `ApplicationName`/`ApplicationDescription` and a `FileAssociations` subkey mapping each
   curated extension → a shared ProgID (`Conduit.Document`, whose `shell\open\command`
   opens the exe with `"%1"`), referenced from `Software\RegisteredApplications`
   (`"Conduit" = "Software\\Conduit\\Capabilities"`). This surfaces Conduit in **Settings →
   Default apps** so the user can make it the default editor per type.

**Curated extension set** (text/code/config — the "default code editor" surface):
`.txt .md .markdown .json .jsonc .yml .yaml .toml .xml .csv .log .ini .env .js .jsx .ts
.tsx .mjs .cjs .css .scss .less .html .htm .py .rs .go .rb .java .kt .c .h .cpp .hpp .cs
.php .lua .sh .bash .zsh .ps1 .sql .gitignore .dockerfile .pdf`. (`.pdf` is included now that
the in-app PDF viewer has shipped — see `2026-06-19-pdf-viewer.md`.)

`customUnInstall` deletes `Software\Classes\*\shell\Conduit`,
`Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}`, `Software\Classes\Conduit.Document`,
`Software\Conduit`, and the `RegisteredApplications` value — no orphan entries.

### §2 — Launch-argv parsing (`electron/arg-utils.ts`)

Generalise the shipped pure helper. `extractDirArg(argv, isDir)` stays (thin wrapper) so
existing callers/tests are untouched; add:

```ts
export type OpenTarget = { kind: 'dir' | 'file'; path: string };

// First argv entry that is an existing dir or file (skips exe path, the `.` dev arg, and
// any `--flags`). `classify` is injected for testability (no real fs in unit tests).
export function extractOpenTarget(
  argv: readonly string[],
  classify: (p: string) => 'dir' | 'file' | 'none',
): OpenTarget | undefined;
```

### §3 — Host routing (`electron/main.ts`)

Replace `openDirArg` with `openArg(argv)` that switches on the target kind:

- **dir** → `openRepo(dir, registry.list()[0]?.id ?? '')` (unchanged behaviour).
- **file** → `openFileFromOS(filePath)`:
  1. **root** = `gitRootOf(filePath)` (walk up for a `.git`), else `path.dirname(filePath)`.
  2. Resolve the owning session: reuse the existing session whose `projectPath` is the
     nearest ancestor of `filePath` (the same nearest-ancestor rule as
     `src/owning-session.ts`); else `openRepo(root, …)` to create one and use its id.
  3. `send({ type: 'openFileInEditor', path: filePath, sessionId })` to the renderer.

Both `second-instance` and the first-launch parse call `openArg`. Multi-select "Open with"
yields several `second-instance` events → several files open.

The git-root walk is a small pure helper (`gitRootOf(file, exists)` in `electron/arg-utils.ts`
or `src/`), injectable for tests.

### §4 — Protocol + renderer (`src/protocol.ts`, `webview/app.tsx`)

- Add to the `HostToWebview` union: `{ type: 'openFileInEditor'; path: string; sessionId: string }`.
- The renderer handles it by opening the doc in `sessionId` via the **existing** open-file
  flow (the same one `openFile` / `openTerminalFileLink` use — `readFile` → `OpenDoc` →
  `doc-view.tsx` selects the viewer: code / markdown / image / pdf) and focusing the center
  pane. If `sessionId` isn't present yet (just created), open once its `state` arrives
  (open-after-session-ready, mirroring how a freshly created session becomes active).

No change to `doc-view.tsx`, `file-service.ts`, or the viewers — file-kind/viewer selection
already keys off the path/content.

## Edge cases

| Condition | Behaviour |
|---|---|
| File not in a repo | Session roots at the file's parent directory. |
| App closed when invoked | App launches, then opens the file once the window/session is ready. |
| App already open | `second-instance` routes the open + restores/focuses the window. |
| Multiple files (multi-select) | One `second-instance` per file → multiple tabs. |
| Unsupported / binary file | Opens in the normal viewer; a non-previewable binary shows the existing "binary" notice. |
| A directory passed to the file path | Classified as `dir` → existing folder path. |
| Missing path / only `--flags` / `.` | Ignored (no target), exactly as today. |
| File already open in a session | `resolveOwningSession` Rule 1 reuses that session + focuses the existing tab. |

## Testing

- **Unit:** `extractOpenTarget` (dir vs file vs flag vs `.` vs missing; first match wins;
  `classify` injected) and `gitRootOf` (walks up to a `.git`, else undefined; `exists`
  injected). The host root/reuse decision reuses `resolveOwningSession` (already unit-tested).
- **Manual e2e (packaged build — the OS launch boundary can't be driven by the smoke
  harness, consistent with the shipped install spec):**
  1. Install → "Open with Conduit" appears on a file's right-click; Conduit appears in "Open
     with → Choose another app" and in Settings → Default apps for the curated types.
  2. App closed → "Open with Conduit" on a `.ts` launches Conduit with a session rooted at
     the file's git root and the file open in the editor.
  3. App open → opens the file as a new tab in the matching (or new) session and focuses.
  4. Set Conduit default for `.md` → double-clicking a `.md` opens it in Conduit.
  5. Uninstall → all registry keys removed (no orphan menu/Default-Apps entries).

  e2e stays out of `npm run verify` (repo convention).

## Files touched

| File | Change |
|------|--------|
| `build/installer.nsh` | Add `*` context menu + Applications/ProgID + Capabilities/RegisteredApplications; extend uninstall |
| `electron/arg-utils.ts` | Add `extractOpenTarget` + `gitRootOf`; keep `extractDirArg` as a wrapper |
| `electron/main.ts` | `openArg` switch (dir/file); `openFileFromOS` (root → owning session → `openFileInEditor`) |
| `src/protocol.ts` | `openFileInEditor` host→webview message |
| `webview/app.tsx` | Handle `openFileInEditor` (open doc in session + focus), incl. open-after-ready |
| `test/unit/arg-utils.test.ts` | Tests for `extractOpenTarget` + `gitRootOf` |
| `CHANGELOG.md` | User-facing entry |

## Out of scope

- macOS / Linux file integration (and macOS `open-file` event).
- A `conduit` CLI / PATH launcher.
- Auto-claiming defaults at install (the user sets defaults via Windows).
- Opening a file at a specific line/column from the OS (the in-app path-link flow already
  does line/col; OS args don't carry it).

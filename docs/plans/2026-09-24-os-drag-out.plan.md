# os-drag-out — implementation plan

**Spec:** `docs/specs/2026-09-24-os-drag-out.md`  **Tier:** FULL

Tier reason: a new host IPC boundary (drag-out + OS clipboard) that is also a disclosure boundary
(D9), a new host module, a renderer state machine shared by the tree and every drop surface, and a
measured spike (S0) that picks between two build branches.

Build after mf-sidebar lands on `feat/multi-folder`. Line anchors below are from `e3e7326`; after
mf-sidebar merges, find code **by name**, not by line. mf-sidebar touches `webview/app.tsx`,
`webview/bridge.ts` and `test/e2e/harness.mjs`. This plan edits none of them.

## Goal

Dragging Files-tree rows onto Explorer, Finder, a browser upload zone or a chat compose box delivers
real files. Explorer Copy also puts a real file list on the OS clipboard (Windows, macOS). The host
validates every outgoing path against the requesting session's present folders.

## Architecture

The renderer only asks. It sends paths, and the host decides from its own session model. All
host-side drag-out and clipboard logic lives in **one new host module**, `electron/drag-out-host.ts`,
built by a factory with injected deps (the `electron/folder-picker.ts` shape). `main.ts` only wires
IPC cases and Electron events to it, per the L12 S1 boundary ruling. Pure logic (path validation,
clipboard payloads, drop classification, the outgoing-drag reducer, the download URL, the navigation
predicate) lives in `src/` and is unit-tested on Linux, with no `process.platform` reads inside it.

The spike decides which mechanism each platform uses, and one table in `src/drag-out-policy.ts`
records the answer. Both host and renderer read it: the renderer to choose native vs HTML5 at
`dragstart`, and the host to refuse a native request on a platform whose mode isn't `native`.

## Data flow

```
 Files row dragstart (folder-section.tsx)
   │ pane.startDrag(paths, e)           text/plain + x-conduit-path still stamped (terminal-drop e2e)
   ▼
 useOutgoingDrag.begin ── mode native ─► e.preventDefault(); post fs:startDrag{dragId,sessionId,paths}
   │ state: requested(dragId)                     │ to-host (ipcMain) → main.ts case
   │                                              ▼
   │                          dragOutHost.startDrag(m, ctx)
   │                            sender = an app window's MAIN webContents? else drop+log
   │                            DRAG_OUT_MODE[platform]==='native'? else refuse bad-request
   │                            sessionFolders(sessionId, windowId) (owner check) else unknown-session
   │                            validateOutgoingPaths(paths, folders)  else refuse(reason)
   │                            icon non-empty                          else refuse bad-request
   │                            e2e: push __conduitDragOutLog, reply dragStarted, stop
   │                            reply fs:dragStarted → e.sender.startDrag({file,files,icon})
   │                            (blocks on win/linux) → reply fs:dragEnded (not darwin)
   ▼
 state: active ──► OS drag ──► Explorer/Chrome/Slack (CF_HDROP, copy|link only)
   │                     └──► back over the tree: types has 'Files', outgoing set →
   │                          internal dragover (dropIntent, one highlight, spring, dropEffect copy)
   │                          drop → pane.drop → classifyDrop(outgoing, droppedPaths, textPaths)
   │                                   internal → moveOrCopyInto   os → today's OS-drop flow
   └─ clears on: any in-window drop (window bubble listener + pane.drop), matching fs:dragEnded /
      fs:dragRefused, pointerdown/pointerup while active. Never pointermove, never a stale dragId.

 Explorer Copy (menu / Ctrl+C) → pane.copy: in-app clipboard + announce (unchanged, immediate)
   └─ osCopier(sessionId, paths) → requestHost fs:copyToOsClipboard{requestId,sessionId,paths}
        → dragOutHost.copyToOsClipboard: sender + owner + validate → osClipboardPayload(...)
             win32: powershell.exe (absolute) -Sta -NoProfile -NonInteractive -Command <fixed>,
                    paths = base64(UTF-8 JSON) on stdin → Set-Clipboard -LiteralPath
             darwin: clipboard.writeBuffer('NSFilenamesPboardType', plist)
             linux: unsupported
             e2e: push __conduitClipboardLog, reply ok, never write
        → fs:osClipboardResult → renderer: toast + announce on failure; last request wins
```

## Settled decisions — do not re-litigate

- D1: explorer drag-out uses `webContents.startDrag`, **gated by S0**. D3 fallback is VS Code parity:
  `DownloadURL`, the first non-directory file only.
- D2: Windows clipboard goes through Windows PowerShell 5.1 `Set-Clipboard -LiteralPath`, with paths
  on stdin as base64 of UTF-8 JSON. No native dependency.
- D3: native drag replaces HTML5 for internal drags too. The dropEffect is `copy`, and move vs copy
  is decided by `classifyDrop` plus Ctrl.
- D4: Linux gets no OS clipboard write. D5: Cut never writes the OS clipboard.
- D6: a bundled static drag icon (file / folder / several).
- D7: `DownloadURL` surfaces ship only if the host gates them in `will-download` (F5).
- D8: a terminal drop pastes every dragged path. D9: validation is against the requesting session's
  **present** folders, owned by the sender's window, realpath'd both sides, whole-request refusal.
- D10: a cross-window drag becomes copy, not move (accepted regression). D12: on-disk bytes are
  delivered. D13: links inside a dragged folder are not inspected. D14: web tabs receive real files.
- D15: native drag-out on macOS only if F6 passes a same-volume Finder drop as a copy.
- 500 top-level items max. Refusal strings are exactly spec §10.
- L12 S1: host lifecycle logic lives in a module, not grown into `main.ts`.
- User, this run: no e2e is run per item. Per-slice gates are tsc ×2 + units + build, with one final
  verify. The e2e file is still written (Slice 7).

## Spec staleness

| Spec claim | Measured | How this plan proceeds |
|---|---|---|
| Message ids are `string` (`dragId`, `requestId`) | Every request/reply in the repo uses a numeric `requestId`, and `requestHost` generates numbers (`webview/host-request.ts:8-15`, `src/protocol.ts:633,777`) | `number` for both |
| `agentDeck.fs.startDrag(...)` / `agentDeck.fs.copyToOsClipboard(...)` | The bridge has no `fs` namespace (`electron/preload.ts:14-148`). Spec §3.2 also says "through the existing to-host send" | No preload change. The renderer uses `post` / `requestHost` from `webview/bridge.ts` / `webview/host-request.ts` |
| `classifyDrop({…, platform})` with win32/posix normalisation | The repo's path identity is `folderKey` (`src/folder-key.ts:3-7`), which is string-only and never platform-keyed | `classifyDrop` compares by `folderKey` and takes no `platform` |
| E2E file `test/e2e/drag-out.e2e.mjs` | The conductor names `test/e2e/os-drag-out.e2e.mjs` | `test/e2e/os-drag-out.e2e.mjs` |
| D8 "used to insert only the grabbed row" needs a terminal change | A `Files` drop already pastes every `getPathForFile` path (`webview/components/terminal-pane.tsx:798-801`). A native drag carries `Files` | `terminal-pane.tsx` is **unchanged**. S0 F2 confirms `getPathForFile` returns originals |
| Sender check `BrowserWindow.fromWebContents(e.sender)` is one of ours | `handle` already drops senders with no window (`electron/main.ts:2387-2391`). What `fromWebContents` returns for a `<webview>` guest is unverified | The host module requires `e.sender.id` to equal an app window's **main** `webContents.id` |
| §2.1 anchors | All hold with line drift only: Copy/Cut are at `files-view.tsx:474-485`, row dragstart is at `folder-section.tsx:461-470`, `will-navigate` is at `main.ts:1047-1051`. No document-level drop listener exists | None |
| "internal DnD e2es … exercise the text/draggedPaths branch" | `dnd.e2e.mjs` and `explorer-dnd-polish.e2e.mjs` drive host ops directly. Only `terminal-drop.e2e.mjs:26-35` synthesizes a row `dragstart`, and it asserts the `x-conduit-path` stamp | `pane.startDrag` keeps stamping `text/plain` + `x-conduit-path` even when it `preventDefault`s |
| The spec is listed in `docs/specs/INDEX.md` | No row (`grep os-drag-out docs/specs/INDEX.md` is empty) | Slice 7 adds the row |
| codemap: ChangesView lives in `right-pane.tsx` | It lives in `webview/components/changes-view.tsx:63` (`ChangeRow`) | Slice 6 edits `changes-view.tsx` |

## Global constraints

- **Gate per slice:** `npm run typecheck` (both tsconfigs), the slice's `npx vitest run <files>`,
  and `npm run build` **once the machine is free**. The build is the conductor's call, because
  another agent builds here. **Final:** `npm run verify`. Capture exit codes directly and never pipe
  verify through `tail`.
- **No e2e run per item.** S0 probes are measurements, run from the OS temp dir and never from the
  repo.
- **Comments:** why-only. A pointer to the spec section is enough (`// see os-drag-out spec §2.2
  step 7`). Never restate the spec.
- **CI is ubuntu:**
  - pure modules take their platform facts as arguments (`HostPlatform`, `caseInsensitive`) and never
    read `process.platform`;
  - Windows paths in tests are strings built with `path.win32`;
  - the symlink unit test uses real `os.tmpdir()` dirs and `it.skipIf` when `fs.symlinkSync` throws
    `EPERM`.
- **Naming:**
  - files are kebab-case;
  - host modules are `electron/<noun>-host.ts` / `electron/<noun>.ts`, with a `createX(deps)` factory
    and a `XDeps` interface;
  - React hooks are `webview/use-<name>.ts`;
  - unit tests are flat, `test/unit/<module>.test.ts`;
  - strings are a `STR` const beside the component, or a pure message module when they're shared.
- **Security (CLAUDE.md):**
  - validate every path host-side;
  - never trust a renderer path;
  - never spawn through a shell or `PATH` lookup: an absolute `powershell.exe`, `shell:false`, and
    paths never in argv;
  - never kill a process by name; kill only the child you spawned.
- **Temp:** PowerShell `$env:TEMP\claude-scratch\os-drag-out\` (a per-lane subdir). Never `$env:TEMP`
  in Bash, and never `rm` the shared `claude-scratch` parent.
- **No new overlay.** `test/unit/drag-region.test.ts` stays untouched.

## Out of scope

- Paste *from* the OS clipboard.
- Cut → an OS move-paste.
- Linux clipboard files.
- Drag-out from quick open or breadcrumbs.
- Editor-content drags.
- Terminal path formatting.
- Changing `conduit-preview:` confinement.
- A `CLAUDE.md` edit (see Decisions Needed).

## S0 outcome → branch table

The builder fills this in from `docs/runs/2026-09-24-os-drag-out/s0-spike.md` and builds only the
listed slices. **UNMEASURED counts as FAIL.**

| Outcome | `DRAG_OUT_MODE` (win32 / linux / darwin) | `DOWNLOAD_URL_GATED` | Windows clipboard | Slices built |
|---|---|---|---|---|
| **A**: F1 ∧ F2 ∧ F3 PASS, F5 PASS | `native` / `native` / (F6 PASS ? `native` : `download`) | `true` | F4 | 0,1,2,3,4,5,6,7 |
| **A′**: F1 ∧ F2 ∧ F3 PASS, F5 FAIL | `native` / `native` / (F6 PASS ? `native` : `none`) | (not created) | F4 | 0,1,2,3,4,7 |
| **B**: not A, F5 PASS | `download` / `download` / `download` | `true` | F4 | 0,1,2,5,6,7 |
| **C**: not A, F5 FAIL | (not created) | (not created) | F4 | 0,1,2,7 |

- "Windows clipboard = F4": if F4 FAILS, `osFileClipboardSupported('win32')` returns `false`, and
  the PowerShell payload branch is **not built**. `osClipboardPayload` then returns `unsupported` on
  win32.
- F6 cannot be measured on this machine, so it is UNMEASURED and darwin is never `native` in this
  run.
- In outcome **C**, report to the user that folder and multi-file drag-out are deferred.
- In outcome **B**, report the same, plus that only the first file drags out.

**`DragOutMode` union:** only the members the chosen row uses.
- A: `'native' | 'download'`
- A′: `'native' | 'none'`
- B: `'download'`

## Contracts

### `src/drag-out-policy.ts` (created Slice 2; extended Slice 3/5)

```ts
import type { HostPlatform } from './lsp-binary';
/** Slice 2. S0 F4 decides win32; darwin true; linux false (D4). */
export function osFileClipboardSupported(platform: HostPlatform): boolean;
/** Slice 2. navigator.platform → HostPlatform: /^Win/ → win32, /^Mac/ → darwin, else linux. */
export function platformFromNavigator(navPlatform: string): HostPlatform;
/** Slice 3 (A/A′) or Slice 5 (B). Values from the S0 table. */
export type DragOutMode = 'native' | 'download' | 'none';   // narrowed per S0 row
export const DRAG_OUT_MODE: Readonly<Record<HostPlatform, DragOutMode>>;
/** Slice 5 only (F5 PASS). */
export const DOWNLOAD_URL_GATED: true;
```

### `src/outgoing-paths.ts` (Slice 2)

```ts
import type { Session } from './types';
export type DragOutRefusal =
  | 'bad-request' | 'unknown-session' | 'outside-folders' | 'folder-missing'
  | 'symlink-escape' | 'missing' | 'too-many';
export const MAX_OUTGOING_PATHS = 500;
export interface OutgoingFolders { present: string[]; missing: string[] }
export interface OutgoingPathDeps {
  realpath(p: string): string;        // realPathLeaf semantics
  exists(p: string): boolean;
  caseInsensitive: boolean;           // dedupe key; true on win32
}
export type OutgoingVerdict =
  | { ok: true; paths: string[] }
  | { ok: false; reason: DragOutRefusal; path?: string };
/** present = home (unless homeMissing) + presentRoots(s); missing = missingRoots + home if homeMissing. */
export function outgoingFoldersFor(
  s: Pick<Session, 'home' | 'roots' | 'missingRoots' | 'homeMissing'>,
): OutgoingFolders;
export function validateOutgoingPaths(
  paths: unknown, folders: OutgoingFolders, deps: OutgoingPathDeps,
): OutgoingVerdict;
/** realpath: realPathLeaf (src/path-guard.ts); exists: fs.statSync succeeds; caseInsensitive: platform==='win32'. */
export function nodeOutgoingPathDeps(platform: NodeJS.Platform): OutgoingPathDeps;
```

**Validation order (first failure wins, and the whole request is refused):**

1. `paths` is not an array, is empty, or has a non-string entry → `bad-request`.
2. More than `MAX_OUTGOING_PATHS` raw entries → `too-many`. This is checked **before** per-entry
   work.
3. Any entry is not `path.isAbsolute` → `bad-request` + `path`.
4. Dedupe:
   - the key is `folderKey(p)`, lowercased again when `deps.caseInsensitive`, so `C:\A` and `c:\a`
     collapse **before** `topLevelPaths`;
   - `topLevelPaths` (`src/drop-intent.ts:72`) would drop both case-variants against each other;
   - the first spelling is kept, then `topLevelPaths`.
5. Per path, lexical:
   - `isInsideAnyRoot(p, present)`, else
   - `isInsideAnyRoot(p, missing)` → `folder-missing`, else `outside-folders`.
6. Per path: `isInsideAnyRoot(deps.realpath(p), present.map(deps.realpath))`, else `symlink-escape`.
7. Per path: `deps.exists(p)`, else `missing`.
8. `{ ok: true, paths }`: the deduped top-level **lexical** spellings.

### `src/os-clipboard-payload.ts` (Slice 2)

```ts
import type { HostPlatform } from './lsp-binary';
export interface PowerShellSpawn { file: string; args: string[]; stdin: string }
export type OsClipboardPayload =
  | { kind: 'powershell'; spawn: PowerShellSpawn }
  | { kind: 'plist'; format: 'NSFilenamesPboardType'; xml: string }
  | { kind: 'unsupported' }
  | { kind: 'unavailable'; detail: string };    // win32 with no SystemRoot
/** file = path.win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 *  args = ['-Sta','-NoProfile','-NonInteractive','-Command', SET_CLIPBOARD_SCRIPT];
 *  stdin = base64(UTF-8(JSON.stringify(paths))). No path ever appears in args. */
export function buildPowerShellClipboardSpawn(paths: readonly string[], systemRoot: string): PowerShellSpawn;
export function decodeClipboardStdin(stdin: string): string[];
/** XML plist <array><string>…</string></array>, escaping & < > " '. */
export function buildFilenamesPlist(paths: readonly string[]): string;
export function osClipboardPayload(
  paths: readonly string[], platform: HostPlatform, systemRoot: string | undefined,
): OsClipboardPayload;
export const SET_CLIPBOARD_SCRIPT: string;
```

- `SET_CLIPBOARD_SCRIPT` is fixed text: read stdin to the end, then base64 → UTF-8 → `ConvertFrom-Json`,
  then `Set-Clipboard -LiteralPath $p`, with `$ErrorActionPreference='Stop'`. S0 F4 runs this exact
  string.
- win32 support depends on F4: when `osFileClipboardSupported('win32')` is false, win32 →
  `unsupported`.
- darwin → `plist`. linux → `unsupported`.

### `electron/os-file-clipboard.ts` (Slice 2)

```ts
import type { OsClipboardPayload, PowerShellSpawn } from '../src/os-clipboard-payload';
export const OS_CLIPBOARD_TIMEOUT_MS = 10_000;
export type OsClipboardWriteResult = { ok: true } | { ok: false; detail: string };
export interface OsFileClipboardDeps {
  runPowerShell(spec: PowerShellSpawn, timeoutMs: number): Promise<OsClipboardWriteResult>;
  writeBuffer(format: string, data: Buffer): void;
}
export interface OsFileClipboard {
  /** Serialised: a write starts only after the previous one settled. */
  execute(p: Extract<OsClipboardPayload, { kind: 'powershell' | 'plist' }>): Promise<OsClipboardWriteResult>;
}
export function createOsFileClipboard(deps: OsFileClipboardDeps): OsFileClipboard;
/** The real runner: child_process.spawn(file,args,{windowsHide:true,shell:false,stdio:['pipe','ignore','pipe']});
 *  writes stdin and ends it; exit 0 → ok; non-zero → {ok:false,detail:stderr (first 500 chars)};
 *  timer → child.kill() of THIS child only → {ok:false,detail:'timeout'}; 'error' event → detail = err.code. */
export function spawnPowerShell(spec: PowerShellSpawn, timeoutMs: number): Promise<OsClipboardWriteResult>;
```

### Protocol (`src/protocol.ts`, Slice 2 + Slice 3)

```ts
export type { DragOutRefusal } from './outgoing-paths';
export type OsClipboardFailure = DragOutRefusal | 'unsupported' | 'failed';
// WebviewToHost
| { type: 'fs:copyToOsClipboard'; requestId: number; sessionId: string; paths: string[] }   // Slice 2
| { type: 'fs:startDrag'; dragId: number; sessionId: string; paths: string[] }             // Slice 3
// HostToWebview
| { type: 'fs:osClipboardResult'; requestId: number; ok: true }                             // Slice 2
| { type: 'fs:osClipboardResult'; requestId: number; ok: false; reason: OsClipboardFailure; path?: string; detail?: string }
| { type: 'fs:dragStarted'; dragId: number }                                                // Slice 3
| { type: 'fs:dragRefused'; dragId: number; reason: DragOutRefusal; path?: string }
| { type: 'fs:dragEnded'; dragId: number }
```

`path` on the clipboard failure is an addition to the spec. It lets the toast name the item, the same
way `fs:dragRefused` does.

### `electron/drag-out-host.ts` (Slice 2 creates; Slice 3 adds `startDrag`; Slice 5 adds `allowDownload`)

```ts
export interface DragOutLogEntry { paths: unknown; accepted: boolean; reason?: DragOutRefusal }
export interface ClipboardLogEntry { payload: OsClipboardPayload; stdinPaths?: string[] }
export interface DragOutProbes { dragOut: DragOutLogEntry[]; clipboard: ClipboardLogEntry[] }
export type DragIconKind = 'file' | 'folder' | 'many';
export interface DragOutRequestCtx {
  senderContentsId: number;
  reply: (msg: HostToWebview) => void;
}
export interface NativeDragCtx extends DragOutRequestCtx {
  startNativeDrag: (item: { file: string; files: string[]; icon: Electron.NativeImage }) => void;
}
export interface DragOutHostDeps {
  platform: HostPlatform;
  e2e: boolean;
  systemRoot: string | undefined;
  /** The app window whose MAIN webContents has this id; undefined for guests / unknown. */
  appWindowIdFor(contentsId: number): number | undefined;
  /** undefined when the session is unknown or not owned by windowId. */
  sessionFolders(sessionId: string, windowId: number): OutgoingFolders | undefined;
  validate(paths: unknown, folders: OutgoingFolders): OutgoingVerdict;
  clipboard: OsFileClipboard;
  /** e2e only: main.ts sets globalThis.__conduitDragOutLog / __conduitClipboardLog to these arrays. */
  installProbes(p: DragOutProbes): void;
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void;
  // Slice 3
  isDirectory(p: string): boolean;
  dragIcon(kind: DragIconKind): Electron.NativeImage;
  // Slice 5
  windowFolders(windowId: number): OutgoingFolders;
}
export interface DragOutHost {
  copyToOsClipboard(m: Extract<WebviewToHost, { type: 'fs:copyToOsClipboard' }>, ctx: DragOutRequestCtx): Promise<void>;
  startDrag(m: Extract<WebviewToHost, { type: 'fs:startDrag' }>, ctx: NativeDragCtx): void;   // Slice 3
  /** true for any non-file: URL; a file: URL must come from an app window and validate. */
  allowDownload(url: string, contentsId: number): boolean;                                   // Slice 5
}
export function createDragOutHost(deps: DragOutHostDeps): DragOutHost;
```

The factory calls `deps.installProbes` once, and only when `deps.e2e` is set.

**`copyToOsClipboard` behaviour, in order:**

1. `appWindowIdFor` is undefined → `log.warn('fs', 'os clipboard from non-app sender')`, and no
   reply.
2. `typeof m.requestId !== 'number'` → log, and no reply.
3. `sessionFolders` is undefined → reply `{ok:false, reason:'unknown-session'}`.
4. `validate` fails → `log.warn('fs', 'os clipboard refused', {reason, path})`, then reply the
   refusal.
5. Build the payload:
   - `unsupported` → reply `{ok:false, reason:'unsupported'}` (logged at info);
   - `unavailable` → reply `failed` with `detail`.
6. e2e → push `{payload, stdinPaths: decodeClipboardStdin(...)}` (for a powershell payload), then
   reply `{ok:true}`. **Never execute.**
7. Otherwise `await clipboard.execute(payload)`:
   - ok → reply `{ok:true}`;
   - otherwise `log.warn` and reply `{ok:false, reason:'failed', detail}`.

**`startDrag` behaviour, in order:**

1. Sender or `dragId` invalid → log, and no reply.
2. `DRAG_OUT_MODE[platform] !== 'native'` → refuse `bad-request`.
3. No owned session → `unknown-session`.
4. `validate` fails → refuse with its reason and `path`.
5. Pick the icon kind: `paths.length > 1` → `many`, `isDirectory(paths[0])` → `folder`, else
   `file`. An `icon.isEmpty()` → `log.error('fs', 'drag icon missing')` and refuse `bad-request`.
6. e2e → push `{paths, accepted:true}`, reply `fs:dragStarted`, **return**.
7. Otherwise:
   - reply `fs:dragStarted`;
   - call `startNativeDrag({file: paths[0], files: paths, icon})`;
   - if `platform !== 'darwin'`, reply `fs:dragEnded`.

Every refusal is `log.warn('fs', 'drag-out refused', {reason, path})`. Under e2e it also pushes
`{paths: m.paths, accepted:false, reason}` before replying `fs:dragRefused`.

### `src/app-navigation.ts` (Slice 1)

```ts
/** True only for the app shell itself: same protocol + pathname as indexUrl (query/hash ignored);
 *  a /X:/ drive letter compares case-insensitively. Any parse failure → false. */
export function isAppIndexUrl(url: string, indexUrl: string): boolean;
```

`main.ts` `will-navigate` (app window):

- `isAppIndexUrl(url, pathToFileURL(path.join(__dirname, 'index.html')).href)` → allow;
- otherwise `preventDefault()`;
- then, if it isn't a `file:` URL, `openExternalUrl(url)`. A `file:` URL is dropped with
  `log.warn('nav', 'blocked file navigation', {url})`.

### `webview/unclaimed-drop-guard.ts` (Slice 1)

```ts
/** Capture-phase dragover: a 'Files' drag gets preventDefault() + dropEffect='none', so only a
 *  handler that sets its own dropEffect claims it. Bubble-phase drop: a 'Files' drop nobody
 *  preventDefault'ed is preventDefault'ed. Returns the uninstaller. */
export function installUnclaimedDropGuard(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void;
```

**Why capture:** a row's `onDragOver` calls `stopPropagation()` even when it declines
(`folder-section.tsx:472-497`). A bubble listener would never see that event, and the undeclined
default is what navigates.

### `src/classify-drop.ts` (Slice 4)

```ts
export type DropRoute = { kind: 'internal'; sources: string[] } | { kind: 'os' } | { kind: 'none' };
/** Set equality by folderKey. internal+outgoing if droppedPaths≡outgoing (outgoing non-empty);
 *  internal+textPaths if droppedPaths empty and textPaths non-empty; os if droppedPaths non-empty
 *  and ≢ outgoing; else none. */
export function classifyDrop(i: {
  outgoing: readonly string[]; droppedPaths: readonly string[]; textPaths: readonly string[];
}): DropRoute;
/** native → 'copy' (the source mask is copy|link, so 'move' would refuse the drop); else ctrl ? 'copy' : 'move'. */
export function internalDropEffect(native: boolean, ctrl: boolean): 'copy' | 'move';
```

### `src/outgoing-drag.ts` (Slice 4)

```ts
export type OutgoingDragState =
  | { phase: 'idle' }
  | { phase: 'html5'; paths: string[] }
  | { phase: 'requested'; dragId: number; paths: string[] }
  | { phase: 'active'; dragId: number; paths: string[] };
export type OutgoingDragEvent =
  | { type: 'begin'; dragId: number; paths: string[] }   // native
  | { type: 'beginHtml5'; paths: string[] }
  | { type: 'started'; dragId: number }                  // requested(same id) → active
  | { type: 'refused'; dragId: number }                  // matching id → idle
  | { type: 'ended'; dragId: number }                    // matching id → idle
  | { type: 'pointer' }                                  // active → idle; else unchanged
  | { type: 'drop' }                                     // any phase → idle
  | { type: 'end' };                                     // any phase → idle (dragend / explicit)
export function reduceOutgoingDrag(s: OutgoingDragState, e: OutgoingDragEvent): OutgoingDragState;
export function outgoingPathsOf(s: OutgoingDragState): readonly string[];   // [] when idle
export function isNativeOutgoing(s: OutgoingDragState): boolean;           // requested | active
```

- A `begin` / `beginHtml5` in any phase replaces the state.
- An id-carrying event whose id doesn't match the state's `dragId` returns the **same object**.

### `webview/use-outgoing-drag.ts` (Slice 4)

```ts
export interface OutgoingDrag {
  paths: readonly string[];
  native: boolean;
  /** native mode + hosted: e.preventDefault(), post fs:startDrag; else beginHtml5. */
  begin(sessionId: string, paths: string[], e: React.DragEvent): void;
  end(): void;
}
export function useOutgoingDrag(opts: {
  native: boolean;   // DRAG_OUT_MODE[platform]==='native' && isHosted
  onRefused: (reason: DragOutRefusal, path: string | undefined, paths: readonly string[]) => void;
}): OutgoingDrag;
```

- Binds `subscribe` for `fs:dragStarted` / `fs:dragRefused` / `fs:dragEnded`.
- Binds `document` capture listeners for `pointerdown` and `pointerup`, which dispatch `pointer`.
  **Never** `pointermove`.
- Binds a `window` **bubble** `drop` listener that dispatches `drop`. It is bubble, not capture,
  because a capture clear would land before the tree's own drop handler reads `paths`.
- `dragId` comes from a module counter, starting at 1.

### `webview/drag-out-messages.ts` (Slice 2; refusal map used by Slice 4)

```ts
export function dragRefusalMessage(reason: DragOutRefusal, name: string): string;          // spec §10 exact
export function clipboardFailureMessage(count: number, reason: OsClipboardFailure, name: string): string;
// `Couldn't put ${countNoun(count,'item','items')} on the system clipboard. ${reasonSentence | "PowerShell didn't respond."}`
```

### `webview/os-clipboard-copy.ts` (Slice 2)

```ts
export interface OsClipboardCopierDeps {
  enabled: boolean;                                  // isHosted && osFileClipboardSupported(platform)
  request: typeof requestHost;
  report: (message: string) => void;                 // pushToast error + announce
}
/** Last call wins: a result for a superseded call is ignored. No reply within 15 s reads as 'failed'. */
export function createOsClipboardCopier(deps: OsClipboardCopierDeps): (sessionId: string, paths: string[]) => Promise<void>;
```

A result of `reason: 'unsupported'` is silent (AC9).

### `src/download-url.ts` (Slice 5)

```ts
/** 'C:\\a b\\c.txt' → 'file:///C:/a%20b/c.txt'; '/a/b' → 'file:///a/b'; '\\\\srv\\s\\f' → 'file://srv/s/f'. Segments encodeURIComponent'd. */
export function fileUrlFor(absPath: string): string;
/** `application/octet-stream:${name}:${fileUrlFor(p)}`; null when name contains ':' or p is not absolute (either style). */
export function downloadUrlFor(absPath: string): string | null;
```

### `webview/file-drag-data.ts` (Slice 5)

```ts
/** DownloadURL when download && DOWNLOAD_URL_GATED && isHosted; x-conduit-path when terminal. */
export function stampFileDrag(dt: DataTransfer, absPath: string, opts: { download: boolean; terminal: boolean }): void;
```

## Producer/consumer map

| Behavior changed | Produced by | Consumed by | Sides this plan touches |
|---|---|---|---|
| Outgoing drag set | `useOutgoingDrag` (FilesView) | row/section/scroller dragover (`internalDropEffect`, `dropIntent`), `pane.drop` (`classifyDrop`), spring re-collapse effect (`folder-section.tsx:446-455`, keyed on `pane.draggedPaths`) | both (Slice 4) |
| `fs:startDrag` → `dragStarted/Refused/Ended` | renderer / host | host validator → `startDrag` / renderer reducer | both (Slices 3–4) |
| Native drag data (CF_HDROP) | `startDrag` | tree (`pane.drop`); terminal (the `Files` branch, `terminal-pane.tsx:798-801`, unchanged); other windows (today's OS flow, D10); `<webview>` guests (D14); settings image drop (`settings-modal.tsx:715`, accepts a `File`, intended); dock (`center-pane.tsx:196-203`, `panel-frame.tsx:88-91`); board (`board-view.tsx:378-388`), which acts only when its own `dragCard.current` / dock state is set; dead space (Slice 1 guard) | producer + tree; the other consumers are measured unaffected |
| Dead-space `Files` drop | any OS/native drag | `will-navigate` + the unclaimed guard | both (Slice 1) |
| `fs:copyToOsClipboard` → OS clipboard | renderer `pane.copy` | host → PowerShell / `writeBuffer` → Explorer/Finder paste | both. The external consumer is covered by manual smoke |
| In-app clipboard | `pane.cut` / `pane.copy` | `pane.paste` | unchanged: `pane.copy` still sets it first and announces synchronously |
| `DownloadURL` | folder-section (B / darwin), doc-tabs, changes-view, search-pane | Chromium drag-download → `will-download` → `allowDownload` | both (Slices 5–6) |
| `FilesPaneApi` shape (`dropInternal` / `dropOs` → `drop`, + `internalDropEffect`, + `dragOutMode`) | files-view | folder-section, `test/unit/folder-section-dir-entries.test.ts:33-41` (fake pane) | both |

`grep -rn "dropInternal\|dropOs" webview test` has exactly these consumers: `files-view.tsx`,
`folder-section.tsx` and `folder-section-dir-entries.test.ts`.

## File map

| Path | Action | Responsibility |
|---|---|---|
| `src/app-navigation.ts` | create | `isAppIndexUrl` |
| `webview/unclaimed-drop-guard.ts` | create | the document-level unclaimed `Files` guard |
| `webview/index.tsx` | modify | install the guard once, next to `installPerfProbe()` |
| `src/drag-out-policy.ts` | create | the per-platform modes + limits from S0 |
| `src/outgoing-paths.ts` | create | `DragOutRefusal`, `validateOutgoingPaths`, `outgoingFoldersFor`, `nodeOutgoingPathDeps` |
| `src/os-clipboard-payload.ts` | create | the pure PowerShell / plist payload builders |
| `electron/os-file-clipboard.ts` | create | serialised execution of a payload; the real PowerShell spawner |
| `electron/drag-out-host.ts` | create | the one host owner of drag-out + OS clipboard + download gating + e2e probes |
| `src/protocol.ts` | modify | the new message variants + `OsClipboardFailure` + the re-exported `DragOutRefusal` |
| `electron/main.ts` | modify | `will-navigate`; construct `dragOutHost`; the `fs:*` cases; `will-download`; drag icons |
| `webview/drag-out-messages.ts` | create | spec §10 sentences |
| `webview/os-clipboard-copy.ts` | create | the renderer copier (last wins, toast/announce) |
| `webview/components/files-view.tsx` | modify | `pane.copy` → copier; Slice 4 outgoing drag + `pane.drop`; Slice 5 `dragOutMode` |
| `webview/components/folder-section.tsx` | modify | Slice 4 `pane.drop` / `internalDropEffect`; Slice 5 `stampFileDrag` |
| `src/outgoing-drag.ts` | create | the outgoing-drag reducer |
| `src/classify-drop.ts` | create | `classifyDrop`, `internalDropEffect` |
| `webview/use-outgoing-drag.ts` | create | the hook binding the reducer to IPC + pointer/drop events |
| `assets/drag-file.png`, `assets/drag-file@2x.png`, `assets/drag-folder.png`, `assets/drag-folder@2x.png`, `assets/drag-many.png`, `assets/drag-many@2x.png` | create | the bundled drag icons, 32/64 px (D6) |
| `package.json` | modify | `build.files` += `"assets/drag-*.png"` |
| `src/download-url.ts` | create | `fileUrlFor`, `downloadUrlFor` |
| `webview/file-drag-data.ts` | create | `stampFileDrag` |
| `webview/components/doc-tabs.tsx` | modify | a file tab's dragstart stamps DownloadURL; `effectAllowed='copyMove'` when stamped |
| `webview/components/changes-view.tsx` | modify | `ChangeRow` draggable (not for deleted), stamps DownloadURL + x-conduit-path |
| `webview/components/search-pane.tsx` | modify | the `searchgroup__head` button draggable, stamps DownloadURL + x-conduit-path |
| `test/unit/app-navigation.test.ts` | create | predicate |
| `test/unit/unclaimed-drop-guard.test.ts` | create | the guard (jsdom) |
| `test/unit/drag-out-policy.test.ts` | create | the platform mapping + table invariants |
| `test/unit/outgoing-paths.test.ts` | create | the validator |
| `test/unit/os-clipboard-payload.test.ts` | create | the builders |
| `test/unit/os-file-clipboard.test.ts` | create | serialisation, the timeout path via a fake runner |
| `test/unit/drag-out-host.test.ts` | create | sender / owner / e2e / refusal behaviour |
| `test/unit/drag-out-messages.test.ts` | create | every reason → exact sentence |
| `test/unit/os-clipboard-copy.test.ts` | create | last-wins, timeout → failed, unsupported silent |
| `test/unit/classify-drop.test.ts` | create | the routes |
| `test/unit/outgoing-drag.test.ts` | create | the reducer |
| `test/unit/use-outgoing-drag.test.ts` | create | bindings (jsdom): pointer after started, no pointermove, stale id |
| `test/unit/files-view-drag-out.test.ts` | create | FilesView: dragstart → preventDefault + post; native drop routing; copy → post (jsdom, mocked bridge as `files-view-drop-guard.test.ts`) |
| `test/unit/folder-section-dir-entries.test.ts` | modify | the fake pane follows the new `FilesPaneApi` |
| `test/unit/download-url.test.ts` | create | URL building |
| `test/unit/doc-tabs-drag.test.ts` | create | a file tab stamps DownloadURL; reorder intact |
| `test/unit/change-row-drag.test.ts` | create | Changes row drag data; deleted rows not draggable |
| `test/unit/search-head-drag.test.ts` | create | search result head drag data |
| `test/e2e/os-drag-out.e2e.mjs` | create | the e2e scenario (written, not run per item) |
| `docs/runs/2026-09-24-os-drag-out/s0-spike.md` | create | the S0 measurements + chosen branch |
| `CHANGELOG.md` | modify | `[Unreleased]` → Added / Changed entries |
| `docs/specs/INDEX.md` | modify | add the missing spec row |

## Scripts

Neither script is committed. Both live under `$env:TEMP\claude-scratch\os-drag-out\`.

1. **`s0\drive-input.ps1 -Action <drag|ctrl-drag|click> -From x,y -To x,y [-StepMs 15]`.** It wraps
   `user32!SendInput` (mouse down, then 20 moves, then up, with optional VK_CONTROL) so that S0
   performs **real** OS drags. A synthetic DOM event can't start `DoDragDrop`. It replaces manual
   mouse work in F1, F2, F3 and F5.
2. **`gen-drag-icons.cjs`.** Run it with `node_modules\electron\dist\electron.exe gen-drag-icons.cjs
   <outDir>`. It renders three inline SVG glyphs (a neutral glyph with a 1 px outline, readable on
   light and dark) in a hidden transparent `BrowserWindow`, then writes `capturePage().toPNG()` at 32
   and 64 px. It produces the six `assets/drag-*.png`, and replaces hand-drawing PNGs.

## Slices

### Slice 0: S0 spike (measurement, no repo code)

**Check:**
- `docs/runs/2026-09-24-os-drag-out/s0-spike.md` exists;
- it has one row per F1–F6, each `PASS | FAIL | UNMEASURED`, with the evidence (the command run,
  the file listing, the log lines);
- it names the chosen outcome row (A / A′ / B / C) from the branch table.

**Parallel groups:** Serial: T0.1 → T0.2 → T0.3

#### Task 0.1: spike app

**Files:** everything goes in the temp dir `$env:TEMP\claude-scratch\os-drag-out\s0\` (`package.json`
`{ "main": "main.cjs" }`, `main.cjs`, `index.html`, `preload.cjs`).

**Steps:**
- [ ] Build `main.cjs`:
  - one visible window with `contextIsolation`;
  - `ipcMain.on('drag', (e, {files}) => { e.sender.send('started'); e.sender.startDrag({ file:
    files[0], files, icon: nativeImage.createFromPath(<repo>/assets/icon.png).resize({width:32}) });
    e.sender.send('ended'); log('returned') })`;
  - an `ipcMain.handle('rt', () => Date.now())` round-trip;
  - a 50 ms `setInterval` that sends `tick{n}` to the renderer (the stand-in for PTY output);
  - `session.defaultSession.on('will-download', (ev, item) => { log('will-download', item.getURL());
    if (process.env.S0_CANCEL) ev.preventDefault() })`;
  - every event is appended with a timestamp to `s0\log.jsonl`.
- [ ] Build `index.html`:
  - row A, whose dragstart calls `preventDefault()` and then `ipc drag` with 3 files + 1 folder from
    a temp fixture `s0\src\`;
  - a drop zone that logs `ctrlKey`, `dataTransfer.types` and every `webUtils.getPathForFile`;
  - a `pointerdown` / `pointerup` / `pointermove` logger with timestamps, plus the arrival of
    `started` / `ended` / ticks;
  - during a drag it calls `ipc rt` every 100 ms and logs the latency (the spring-open readDir
    stand-in);
  - row B: a plain `draggable` with `DownloadURL` = `application/octet-stream:one.txt:file:///…/s0/src/one.txt`.
- [ ] Launch it with `& "<repo>\node_modules\electron\dist\electron.exe" "$env:TEMP\claude-scratch\os-drag-out\s0"`.
  Record the window rect.

#### Task 0.2: measure F1–F5

**Steps:**
- [ ] **F1.** Open `explorer.exe "<s0>\dst1"` and place both windows side by side.
  - Run `drive-input.ps1 -Action drag` from row A onto the Explorer pane.
  - PASS iff `dst1` holds all 4 items with identical bytes, and `s0\src` still holds all 4.
- [ ] **F2.** Run `drive-input.ps1 -Action drag` from row A to the in-window drop zone, holding the
  mouse over it for 1.5 s mid-drag. PASS requires all of:
  1. the drop is delivered, and `getPathForFile` returns the 4 original paths;
  2. `started` arrives before the drop;
  3. during the drag, the `rt` round trips complete in < 1000 ms (this is what spring-open needs; if
     the main process is blocked until drop, that is **FAIL**);
  4. after the drop, the ticks resume with no gap in `n` (queued, not lost);
  5. a `pointerup` or `pointerdown` arrives after the drop, and **no** pointerdown/pointerup arrives
     between `started` and the drop.

  Record the `pointermove` timing as information.
- [ ] **F3.** Run `drive-input.ps1 -Action ctrl-drag` onto the drop zone. PASS iff `ctrlKey === true`
  on `drop`.
- [ ] **F4.** Clipboard, no mouse needed:
  - first save the current text clipboard with `Get-Clipboard -Raw`;
  - run the exact `SET_CLIPBOARD_SCRIPT` from the Contracts, with stdin = base64(JSON(["…\s0\src\one.txt",
    "…\s0\src\dir", "…\s0\src\ünï 日本.txt"]));
  - `Get-Clipboard -Format FileDropList` must list the 3 paths;
  - then `(New-Object -ComObject Shell.Application).NameSpace("<s0>\dst4").Self.InvokeVerb('Paste')`,
    and PASS iff `dst4` holds all 3 with the non-ASCII name intact;
  - restore the saved text with `Set-Clipboard`.
  - Chrome/Slack paste stays in manual smoke. It is recorded, but it doesn't gate.
- [ ] **F5.** First run with `S0_CANCEL` unset:
  - drag row B onto Explorer `dst5`;
  - PASS part 1 iff `will-download` logged a `file:` URL.

  Then relaunch with `S0_CANCEL=1` and repeat onto an empty `dst5b`. PASS part 2 iff no file
  appears. F5 = both parts.
- [ ] **F6.** UNMEASURED (no macOS here).

#### Task 0.3: record + pick

**Files:**
- Create: `docs/runs/2026-09-24-os-drag-out/s0-spike.md`

**Steps:**
- [ ] Write the table, the evidence, the outcome row, and the resulting `DRAG_OUT_MODE`,
  `DOWNLOAD_URL_GATED` and win32 clipboard values.
- [ ] Close the spike app by PID.
- [ ] Delete `s0\` (the lane subdir only).

**If `drive-input.ps1` cannot start an OS drag** (no `started` or no Explorer copy after 3 attempts),
mark F1, F2, F3 and F5 as UNMEASURED and take the row the table gives. Record it as a `high` item for
the user.

---

### Slice 1: navigation guard (always)

**Check:** `npx vitest run test/unit/app-navigation.test.ts test/unit/unclaimed-drop-guard.test.ts`
green; `npm run typecheck` green.

**Parallel groups:** G1: T1.1 · G2: T1.2 · Serial: T1.3
**Claims (serial lane):** `electron/main.ts`, `webview/index.tsx`

#### Task 1.1: `isAppIndexUrl`

**Files:**
- Create: `src/app-navigation.ts`
- Test: `test/unit/app-navigation.test.ts`

**Interfaces:**
- Produces: `isAppIndexUrl(url: string, indexUrl: string): boolean`

**Steps:**
- [ ] Failing tests:
  - 'admits the shell with a hash or query': `isAppIndexUrl('file:///C:/app/out/index.html#x',
    'file:///C:/app/out/index.html') === true`;
  - 'drive letter case-insensitive': `file:///c:/…` vs `file:///C:/…` → true;
  - 'refuses any other file': `file:///C:/Windows/win.ini` → false;
  - 'refuses a sibling html': `…/out/other.html` → false;
  - 'refuses http': false;
  - 'garbage': `isAppIndexUrl('::', idx) === false`.
- [ ] Run `npx vitest run test/unit/app-navigation.test.ts`. It FAILs (module missing).
- [ ] Implement.

#### Task 1.2: unclaimed drop guard

**Files:**
- Create: `webview/unclaimed-drop-guard.ts`
- Test: `test/unit/unclaimed-drop-guard.test.ts` (`// @vitest-environment jsdom`; the events are
  `new Event(type, {bubbles:true, cancelable:true})` with `Object.defineProperty(ev, 'dataTransfer',
  {value: {types:[…], dropEffect:'copy'}})`)

**Interfaces:**
- Produces: `installUnclaimedDropGuard(target: Pick<Window,'addEventListener'|'removeEventListener'>): () => void`

**Steps:**
- [ ] Failing tests:
  - 'Files dragover over dead space is cancelled with none': `defaultPrevented === true &&
    dataTransfer.dropEffect === 'none'`;
  - 'a handler that claims keeps its own effect': an element listener that sets `dropEffect='copy'`
    → it stays `'copy'`;
  - 'text drags untouched': types `['text/plain']` → `defaultPrevented === false`;
  - 'unclaimed Files drop is prevented': `defaultPrevented === true`;
  - 'uninstall removes both listeners'.
- [ ] Run it. It FAILs.
- [ ] Implement: a capture `dragover` on `target`; a bubble `drop` on `target`.

#### Task 1.3: wire

**Files:**
- Modify: `electron/main.ts` (the `will-navigate` handler in `createWindow`, `main.ts:1047-1051`)
- Modify: `webview/index.tsx` (`installUnclaimedDropGuard(window)` right after `installPerfProbe()`)

**Interfaces:**
- Consumes: `isAppIndexUrl(url: string, indexUrl: string): boolean`;
  `installUnclaimedDropGuard(target): () => void`

**Steps:**
- [ ] Replace the `url.startsWith('file://')` allow with the rule in Contracts (`src/app-navigation.ts`).
  Compute the index URL once per window from the same `path.join(__dirname, 'index.html')` that
  `loadFile` uses (`main.ts:1091`).
- [ ] `npm run typecheck`.

---

### Slice 2: host validator + OS clipboard Copy (always; the win32 part per F4)

**Check:**
- `npx vitest run test/unit/outgoing-paths.test.ts test/unit/os-clipboard-payload.test.ts
  test/unit/os-file-clipboard.test.ts test/unit/drag-out-host.test.ts test/unit/drag-out-policy.test.ts
  test/unit/drag-out-messages.test.ts test/unit/os-clipboard-copy.test.ts
  test/unit/files-view-drag-out.test.ts` green;
- `npm run typecheck` green.

**Parallel groups:** G1: T2.1 · G2: T2.2 · Serial: T2.3 → T2.4 → T2.5 → T2.6
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `webview/components/files-view.tsx`

#### Task 2.1: `validateOutgoingPaths`

**Files:**
- Create: `src/outgoing-paths.ts`
- Test: `test/unit/outgoing-paths.test.ts`

**Interfaces:**
- Produces: `DragOutRefusal`, `OutgoingFolders`, `OutgoingPathDeps`, `OutgoingVerdict`,
  `outgoingFoldersFor`, `validateOutgoingPaths`, `nodeOutgoingPathDeps` (exact types in Contracts).
- Consumes: `isInsideAnyRoot`, `realPathLeaf` (`src/path-guard.ts`), `topLevelPaths`
  (`src/drop-intent.ts`), `folderKey` (`src/folder-key.ts`), `presentRoots` (`src/session-folders.ts`),
  and it owns `export const MAX_OUTGOING_PATHS = 500` (nothing re-exports it).

**Steps:**
- [ ] Failing tests. They use fake deps (`realpath: p => p`, an `exists` over a Set, posix paths)
  unless noted:
  - 'non-array / empty / non-string → bad-request';
  - '501 entries → too-many before any stat': an `exists` spy is never called;
  - 'relative → bad-request with path';
  - 'outside → outside-folders with path';
  - 'under a missing root → folder-missing';
  - 'realpath outside → symlink-escape': `realpath` maps `/w/home/link` → `/etc`;
  - 'home reached through a junction is allowed': `realpath` maps both `/w/home` → `/real/home` and
    `/w/home/a` → `/real/home/a`;
  - 'nonexistent → missing';
  - 'caseInsensitive dedupe keeps one': with `caseInsensitive:true`, `['/w/home/A.txt','/w/home/a.txt']`
    gives `paths.length === 1`;
  - 'top-level reduction': `['/w/home/d','/w/home/d/x']` → `['/w/home/d']`;
  - 'one bad path refuses the whole request': `ok === false`;
  - `outgoingFoldersFor`: home missing → home in `missing`, not `present`; missingRoots excluded from
    `present`;
  - **real fs** (`nodeOutgoingPathDeps(process.platform)`, tmpdir): a symlink inside home pointing at
    a sibling tmpdir → `symlink-escape`. Use `it.skipIf` on `EPERM`.
- [ ] Run it. It FAILs.
- [ ] Implement the Contracts order exactly.

#### Task 2.2: clipboard payloads + policy

**Files:**
- Create: `src/os-clipboard-payload.ts`, `src/drag-out-policy.ts`
- Test: `test/unit/os-clipboard-payload.test.ts`, `test/unit/drag-out-policy.test.ts`

**Interfaces:**
- Produces: `PowerShellSpawn`, `OsClipboardPayload`, `buildPowerShellClipboardSpawn`,
  `decodeClipboardStdin`, `buildFilenamesPlist`, `osClipboardPayload`, `SET_CLIPBOARD_SCRIPT`;
  `osFileClipboardSupported(platform)`, `platformFromNavigator(navPlatform)`. No import from T2.1.
- Consumes: `HostPlatform` (`src/lsp-binary.ts:6`).

**Steps:**
- [ ] Failing tests:
  - 'paths never in argv': for paths including `'`, `;`, `$`, a space and `日本`, no `args` element
    contains any path;
  - 'stdin round-trips': `decodeClipboardStdin(spawn.stdin)` deep-equals the paths;
  - 'stdin is pure base64 ASCII': `/^[A-Za-z0-9+/=]+$/`;
  - 'absolute Windows PowerShell 5.1': `file === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'`
    for `systemRoot 'C:\\Windows'`;
  - 'plist escapes': `buildFilenamesPlist(['/a&<b>.txt'])` contains `/a&amp;&lt;b&gt;.txt` and parses
    as `<array>` of one `<string>`;
  - `osClipboardPayload`:
    - linux → unsupported;
    - darwin → plist;
    - win32 with an undefined systemRoot → unavailable;
    - win32 per F4 (powershell, or unsupported);
  - `platformFromNavigator`: `'Win32'` → win32, `'MacIntel'` → darwin, `'Linux x86_64'` → linux;
  - `osFileClipboardSupported('linux') === false`.
- [ ] Run it. It FAILs.
- [ ] Implement.

#### Task 2.3: protocol variants

**Files:**
- Modify: `src/protocol.ts`:
  - add `export type { DragOutRefusal } from './outgoing-paths'`;
  - add `OsClipboardFailure`;
  - add the `fs:copyToOsClipboard` variant to `WebviewToHost`;
  - add both `fs:osClipboardResult` variants to `HostToWebview`.

**Interfaces:**
- Produces: exactly the Slice 2 lines of the Protocol contract.

**Steps:**
- [ ] `npm run typecheck`. It passes (additive).

#### Task 2.4: clipboard executor + host module (copy path)

**Files:**
- Create: `electron/os-file-clipboard.ts`, `electron/drag-out-host.ts`
- Test: `test/unit/os-file-clipboard.test.ts`, `test/unit/drag-out-host.test.ts`

**Interfaces:**
- Produces:
  - `createOsFileClipboard`, `spawnPowerShell`, `OS_CLIPBOARD_TIMEOUT_MS`, `OsFileClipboard`;
  - `createDragOutHost` with `copyToOsClipboard` only;
  - `DragOutHostDeps` **without** `isDirectory` / `dragIcon` / `windowFolders` (those are added in
    Slices 3 and 5);
  - `DragOutProbes`, `ClipboardLogEntry`, `DragOutLogEntry`, `DragOutRequestCtx`.
- Consumes: `validateOutgoingPaths`, `OutgoingFolders`, `OutgoingVerdict` (T2.1);
  `osClipboardPayload`, `decodeClipboardStdin` (T2.2); the protocol variants (T2.3).

**Steps:**
- [ ] Failing tests (`drag-out-host.test.ts` uses fakes for every dep):
  - 'guest sender dropped': `appWindowIdFor → undefined` → `reply` never called, and `log` called
    with `'warn'`;
  - 'session of another window → unknown-session': `sessionFolders → undefined`;
  - 'refusal carries reason+path';
  - 'e2e records the payload and never executes': `clipboard.execute` not called, `probes.clipboard[0].stdinPaths`
    deep-equals the paths, reply `{ok:true}`;
  - 'installProbes only under e2e';
  - 'execute failure → failed with detail';
  - 'linux → unsupported, no execute'.
- [ ] Failing tests (`os-file-clipboard.test.ts`, with a deferred fake `runPowerShell`):
  - 'second execute waits for the first': `runPowerShell` call count is 1 until the first resolves;
  - 'plist → writeBuffer("NSFilenamesPboardType", Buffer of xml)'.
- [ ] Run both. They FAIL.
- [ ] Implement. `spawnPowerShell` is exercised only by S0 F4 and manual smoke. Unit tests cover the
  deps seam, never a real spawn.

#### Task 2.5: wire the host

**Files:**
- Modify: `electron/main.ts`:
  - construct `dragOutHost` right after `folderPicker` (`main.ts:1141-1147`);
  - add `case 'fs:copyToOsClipboard'` beside `case 'folder:probe'` (`main.ts:2555`).

**Interfaces:**
- Consumes: `createDragOutHost(deps)`, `createOsFileClipboard({ runPowerShell: spawnPowerShell,
  writeBuffer: (f, d) => clipboard.writeBuffer(f, d) })`, `nodeOutgoingPathDeps(process.platform)`,
  `outgoingFoldersFor`.

**Steps:**
- [ ] Wire the deps:
  - `appWindowIdFor = (cid) => [...windows.values()].find((w) => w.webContents.id === cid)?.id`;
  - `sessionFolders = (sid, wid) => { const s = mgr.get(sid); return s && sessionOwner.get(sid) ===
    wid ? outgoingFoldersFor(s) : undefined }`;
  - `validate = (p, f) => validateOutgoingPaths(p, f, pathDeps)`;
  - `installProbes = (p) => { (global as Record<string, unknown>).__conduitDragOutLog = p.dragOut;
    (global as Record<string, unknown>).__conduitClipboardLog = p.clipboard }`;
  - `log = (lvl, msg, d) => log[lvl]('fs', msg, d)`;
  - `platform = hostPlatform`, `e2e = process.env.CONDUIT_E2E === '1'`,
    `systemRoot = process.env.SystemRoot`.
- [ ] Add the case: `await dragOutHost.copyToOsClipboard(m, { senderContentsId: e.sender.id, reply:
  replyHere })`.
- [ ] `npm run typecheck`.

#### Task 2.6: renderer copy

**Files:**
- Create: `webview/drag-out-messages.ts`, `webview/os-clipboard-copy.ts`
- Modify: `webview/components/files-view.tsx` (`pane.copy`, `files-view.tsx:480-485`; a `copier`
  `useMemo` keyed on nothing, with `sessionId` passed per call)
- Test: `test/unit/drag-out-messages.test.ts`, `test/unit/os-clipboard-copy.test.ts`,
  `test/unit/files-view-drag-out.test.ts` (copy case only in this task)

**Interfaces:**
- Produces: `dragRefusalMessage`, `clipboardFailureMessage`, `createOsClipboardCopier`,
  `OsClipboardCopierDeps`.
- Consumes: `DragOutRefusal`, `OsClipboardFailure` (`src/protocol.ts`); `osFileClipboardSupported`,
  `platformFromNavigator` (`src/drag-out-policy.ts`); `requestHost` (`webview/host-request.ts`);
  `isHosted` (`webview/bridge.ts`); `countNoun` (`src/menu-selection.ts`).

**Steps:**
- [ ] Failing tests:
  - every `DragOutRefusal` maps to its spec §10 sentence byte for byte;
  - `clipboardFailureMessage(1,'failed','a')` gives
    `"Couldn't put 1 item on the system clipboard. PowerShell didn't respond."`;
  - copier:
    - 'superseded result ignored': two calls where the first resolves last with a failure → `report`
      is never called;
    - 'null reply → failed';
    - 'unsupported → silent';
    - 'disabled → no request';
  - files-view: `pane.copy` via Ctrl+C on a selected row → `posted` has `fs:copyToOsClipboard` with
    the top-level paths **and** the live region reads `Copied 1 item` **before** any reply (mocked
    bridge, `isHosted` mocked true, `navigator.platform` stubbed `'Win32'`).
- [ ] Run them. They FAIL.
- [ ] Implement. `report` = `pushToast({message, variant:'error'})` + `announce(message)`.

---

### Slice 3: native drag host (outcomes A, A′)

**Check:** `npx vitest run test/unit/drag-out-host.test.ts test/unit/drag-out-policy.test.ts` green;
`npm run typecheck` green; `npm run build` (when free), then `out/` resolves `assets/drag-file.png`.

**Parallel groups:** G1: T3.1 · Serial: T3.2 → T3.3
**Claims (serial lane):** `src/protocol.ts`, `electron/main.ts`, `package.json`, `src/drag-out-policy.ts`,
`electron/drag-out-host.ts`

#### Task 3.1: drag icons

**Files:**
- Create: the six `assets/drag-*.png` (via script 2)

**Steps:**
- [ ] Run `gen-drag-icons.cjs`, then check the dimensions (32×32 and 64×64) and that no pixel is
  fully transparent over the whole image.
- [ ] Delete the script.

#### Task 3.2: `startDrag` in the host module + policy table

**Files:**
- Modify: `src/drag-out-policy.ts` (add `DragOutMode`, `DRAG_OUT_MODE` per the S0 row);
  `src/protocol.ts` (the Slice 3 variants); `electron/drag-out-host.ts` (`startDrag`, and the deps
  `isDirectory` and `dragIcon`)
- Test: `test/unit/drag-out-host.test.ts`, `test/unit/drag-out-policy.test.ts`

**Interfaces:**
- Produces: `DragOutHost.startDrag(m, ctx: NativeDragCtx): void`; `DragIconKind`; `NativeDragCtx`;
  `DRAG_OUT_MODE`; `DragOutMode`.
- Consumes: the T2.4 host module (`createDragOutHost`, `DragOutHostDeps`, `DragOutRequestCtx`,
  `DragOutProbes`).

**Steps:**
- [ ] Failing tests:
  - 'accepted: dragStarted replied before startNativeDrag, then dragEnded on win32': the recorded
    order is `['reply:fs:dragStarted','startNativeDrag','reply:fs:dragEnded']`;
  - 'darwin: no dragEnded' (with a table that has darwin `native` injected via a test-only `platform`
    whose mode is native; if the S0 row has no native darwin, assert that darwin → `bad-request`
    instead);
  - 'item has every validated path + a non-empty icon': `item.files` deep-equals the verdict paths;
  - 'icon kind': 2 paths → `many`, a dir → `folder`;
  - 'empty icon → bad-request, no startNativeDrag';
  - 'e2e: logged accepted, dragStarted, no startNativeDrag';
  - 'e2e refusal logged with reason';
  - 'guest sender: nothing replied';
  - 'non-number dragId: nothing replied';
  - policy: for every platform, `DRAG_OUT_MODE[p]` is one of the S0 row's values.
- [ ] Run them. They FAIL.
- [ ] Implement.

#### Task 3.3: wire

**Files:**
- Modify: `electron/main.ts`:
  - the `dragIcon` dep, `nativeImage.createFromPath(path.join(__dirname, '..', 'assets',
    `drag-${kind}.png`))` cached per kind, the same base as `appIconPath` (`main.ts:942-948`);
  - `isDirectory = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }`;
  - `case 'fs:startDrag': dragOutHost.startDrag(m, { senderContentsId: e.sender.id, reply: replyHere,
    startNativeDrag: (item) => e.sender.startDrag(item) })`, synchronous and with no `await` before
    it;
- Modify: `package.json`: `build.files` += `"assets/drag-*.png"` after `"assets/icon.*"`.

**Steps:**
- [ ] `npm run typecheck`.

---

### Slice 4: native drag in the renderer (outcomes A, A′)

**Check:** `npx vitest run test/unit/classify-drop.test.ts test/unit/outgoing-drag.test.ts
test/unit/use-outgoing-drag.test.ts test/unit/files-view-drag-out.test.ts
test/unit/folder-section-dir-entries.test.ts test/unit/files-view-drop-guard.test.ts
test/unit/drop-intent.test.ts test/unit/terminal-drop.test.ts` green; `npm run typecheck` green.

**Parallel groups:** G1: T4.1 · G2: T4.2 · Serial: T4.3 → T4.4
**Claims (serial lane):** `webview/components/files-view.tsx`, `webview/components/folder-section.tsx`

#### Task 4.1: `classifyDrop`

**Files:**
- Create: `src/classify-drop.ts`
- Test: `test/unit/classify-drop.test.ts`

**Interfaces:**
- Produces: `DropRoute`, `classifyDrop`, `internalDropEffect` (the Contracts).

**Steps:**
- [ ] Failing tests:
  - 'equal set → internal with outgoing': `C:\a\x.txt` vs `c:/a/x.txt` counts as equal, and the
    sources keep the outgoing spelling;
  - 'different → os';
  - 'subset → os';
  - 'stale outgoing + real OS drop of other files → os';
  - 'text only → internal with textPaths';
  - 'nothing → none';
  - `internalDropEffect(true, false) === 'copy'` and `internalDropEffect(false, false) === 'move'`.
- [ ] Run it. It FAILs.
- [ ] Implement.

#### Task 4.2: outgoing-drag reducer

**Files:**
- Create: `src/outgoing-drag.ts`
- Test: `test/unit/outgoing-drag.test.ts`

**Interfaces:**
- Produces: `OutgoingDragState`, `OutgoingDragEvent`, `reduceOutgoingDrag`, `outgoingPathsOf`,
  `isNativeOutgoing`.

**Steps:**
- [ ] Failing tests:
  - requested → started(id) → active;
  - a stale `started`, `refused` or `ended` returns the identical object;
  - `pointer` while requested is unchanged, and while active → idle;
  - `drop` from each phase → idle;
  - `begin` while active replaces it with the new id;
  - `refused(id)` from requested → idle.
- [ ] Run it. It FAILs.
- [ ] Implement.

#### Task 4.3: `useOutgoingDrag`

**Files:**
- Create: `webview/use-outgoing-drag.ts`
- Test: `test/unit/use-outgoing-drag.test.ts` (jsdom; `vi.mock('../../webview/bridge')` the way
  `files-view-drop-guard.test.ts:11-20` does)

**Interfaces:**
- Produces: `useOutgoingDrag(opts: { native: boolean; onRefused: (reason: DragOutRefusal, path:
  string | undefined, paths: readonly string[]) => void }): OutgoingDrag`, where `OutgoingDrag =
  { paths: readonly string[]; native: boolean; begin(sessionId: string, paths: string[], e:
  React.DragEvent): void; end(): void }`.
- Consumes: `reduceOutgoingDrag`, `outgoingPathsOf`, `isNativeOutgoing`, `OutgoingDragState`
  (T4.2); `post`, `subscribe` (`webview/bridge.ts`); the `fs:dragStarted` / `fs:dragRefused` /
  `fs:dragEnded` variants and `DragOutRefusal` (`src/protocol.ts`).

**Steps:**
- [ ] Failing tests:
  - 'native begin prevents default and posts fs:startDrag': `e.defaultPrevented === true`, and
    `posted[0]` equals `{type:'fs:startDrag', dragId:1, sessionId, paths}`;
  - 'html5 begin does not prevent default';
  - 'pointerup before dragStarted keeps paths; after dragStarted clears them';
  - 'pointermove never clears';
  - 'dragRefused(other id) ignored; matching → onRefused(reason, path, paths) and paths cleared';
  - 'window drop clears';
  - 'unmount removes the listeners'.
- [ ] Run it. It FAILs.
- [ ] Implement.

#### Task 4.4: FilesView / FolderSection integration

**Files:**
- Modify: `webview/components/files-view.tsx`:
  - replace the `draggedPaths` state (`files-view.tsx:142`) with `useOutgoingDrag`;
  - `pane.startDrag` (`:444-449`): top-level paths + `text/plain` + `effectAllowed`, then
    `outgoing.begin(sessionId, top, e)`;
  - `pane.endDrag` → `outgoing.end()` + clear the target;
  - replace `dropInternal` / `dropOs` with `pane.drop(e, targetDir)`, which runs `classifyDrop` and
    then `moveOrCopyInto` or the existing `dropOs` body; it ends the outgoing drag first;
  - add `pane.internalDropEffect(ctrl)`;
  - the scroller's `onDragOver` / `onDrop` (`:688-712`) use `pane.internalDropEffect` / `pane.drop`;
  - `onRefused` → `dragRefusalMessage(reason, nameOf(path ?? paths[0]))` toast + announce.
- Modify: `webview/components/folder-section.tsx`:
  - in the `FilesPaneApi` interface (`:105-129`), remove `dropInternal` and `dropOs`, and add
    `drop(e: React.DragEvent, targetDir: string): void` and `internalDropEffect(ctrl: boolean): 'copy'
    | 'move'`;
  - in the row `onDragOver` (`:493`) and `onSectionDragOver` (`:915`), the internal dropEffect comes
    from `pane.internalDropEffect(e.ctrlKey)`;
  - `dropOn` (`:510-523`) becomes `pane.drop(e, folder)`;
  - `onDragStart` still stamps `TERMINAL_PATH_MIME` (`:468`);
- Modify: `test/unit/folder-section-dir-entries.test.ts` (the fake pane at `:33-41`)
- Test: `test/unit/files-view-drag-out.test.ts` (the native cases)

**Interfaces:**
- Consumes: `useOutgoingDrag` / `OutgoingDrag` (T4.3); `classifyDrop`, `internalDropEffect`
  (T4.1); `DRAG_OUT_MODE`, `platformFromNavigator` (`src/drag-out-policy.ts`); `dragRefusalMessage`
  (`webview/drag-out-messages.ts`); `isHosted`, `pathForDroppedFile` (`webview/bridge.ts`).

**Call sites:**
- `FilesPaneApi.dropInternal` / `dropOs` are used only by `folder-section.tsx` `dropOn`, by
  `files-view.tsx` scroller `onDrop`, and by `test/unit/folder-section-dir-entries.test.ts:40-41`.
- `pane.draggedPaths` readers are unchanged: `folder-section.tsx:446, 477, 911-919`.

**Steps:**
- [ ] Failing tests (jsdom, mocked bridge with `isHosted` true, `navigator.platform` `'Win32'`):
  - 'row dragstart: defaultPrevented and fs:startDrag with the selection';
  - 'text/plain and x-conduit-path still stamped' (the terminal-drop e2e invariant);
  - 'drop whose files equal outgoing → fsDndMove, and fsDndCopy with ctrlKey' (with
    `pathForDroppedFile` mocked to map fake `File`s to paths);
  - 'drop with other files → OS flow' (`folder:probe` posted or `fsDndImport` called);
  - 'dragover during native outgoing sets dropEffect copy';
  - 'dragRefused → error toast with the §10 sentence';
  - 'isHosted false → no preventDefault, no post'.
- [ ] Run them. They FAIL.
- [ ] Implement.
- [ ] Run the Slice 4 check.

---

### Slice 5: `DownloadURL` gate + explorer fallback (outcomes A, B)

**Check:** `npx vitest run test/unit/download-url.test.ts test/unit/drag-out-host.test.ts
test/unit/drag-out-policy.test.ts test/unit/files-view-drag-out.test.ts` green; `npm run typecheck`
green.

**Parallel groups:** G1: T5.1 · Serial: T5.2 → T5.3
**Claims (serial lane):** `electron/main.ts`, `src/drag-out-policy.ts`, `electron/drag-out-host.ts`,
`webview/components/folder-section.tsx`, `webview/components/files-view.tsx`

#### Task 5.1: URL builders

**Files:**
- Create: `src/download-url.ts`
- Test: `test/unit/download-url.test.ts`

**Interfaces:**
- Produces: `fileUrlFor(absPath: string): string`; `downloadUrlFor(absPath: string): string | null`.

**Steps:**
- [ ] Failing tests:
  - `'C:\\a b\\c#1.txt'` → `file:///C:/a%20b/c%231.txt`;
  - `/a/日.txt` → `file:///a/%E6%97%A5.txt`;
  - UNC → `file://srv/share/f`;
  - `downloadUrlFor('/a/b:c')` → null;
  - relative → null;
  - `downloadUrlFor('C:\\x\\y.txt') === 'application/octet-stream:y.txt:file:///C:/x/y.txt'`.
- [ ] Run it. It FAILs.
- [ ] Implement.

#### Task 5.2: host gate

**Files:**
- Modify: `electron/drag-out-host.ts` (add `allowDownload`, and the dep `windowFolders`);
  `src/drag-out-policy.ts` (`DOWNLOAD_URL_GATED`, and `DRAG_OUT_MODE` created here in outcome B)
- Modify: `electron/main.ts`:
  - `windowFolders = (wid) =>` the union of `outgoingFoldersFor(s)` over `sessionsOwnedBy(sessionOwner,
    wid, mgr.list())`;
  - register once in the app-ready closure: `session.defaultSession.on('will-download', (ev, item,
    wc) => { if (!dragOutHost.allowDownload(item.getURL(), wc.id)) { ev.preventDefault();
    log.warn('fs', 'drag-download refused', { url: item.getURL() }) } })`.
- Test: `test/unit/drag-out-host.test.ts`

**Interfaces:**
- Produces: `DragOutHost.allowDownload(url: string, contentsId: number): boolean`.
- Consumes: `validateOutgoingPaths` via `deps.validate`; `fileURLToPath` (node:url).

**Steps:**
- [ ] Failing tests:
  - 'https url → true';
  - 'file url from a guest → false';
  - 'file url inside the window folders → true' (use `pathToFileURL(tmpdir path)` so Linux CI
    parses it);
  - 'file url outside → false';
  - 'malformed file url → false'.
- [ ] Run it. It FAILs.
- [ ] Implement.

#### Task 5.3: explorer DownloadURL

**Files:**
- Create: `webview/file-drag-data.ts`
- Modify: `webview/components/files-view.tsx` (`pane.dragOutMode: DragOutMode` =
  `isHosted ? DRAG_OUT_MODE[platformFromNavigator(navigator.platform)] : 'none'`, computed once at
  module scope)
- Modify: `webview/components/folder-section.tsx`:
  - `FilesPaneApi` += `dragOutMode: DragOutMode`;
  - `onDragStart`: when `pane.dragOutMode === 'download' && !multi && node.kind === 'file'`, call
    `stampFileDrag(e.dataTransfer, node.path, { download: true, terminal: false })`;
- Modify: `test/unit/folder-section-dir-entries.test.ts` (fake pane `dragOutMode: 'none'`)
- Test: `test/unit/files-view-drag-out.test.ts` (with `navigator.platform` stubbed to a platform whose
  mode is `download`, e.g. `'MacIntel'` in outcome A)

**Interfaces:**
- Consumes: `downloadUrlFor` (T5.1); `DOWNLOAD_URL_GATED`, `DRAG_OUT_MODE`, `DragOutMode`;
  `TERMINAL_PATH_MIME` (`webview/terminal-drop.ts`).

**Steps:**
- [ ] Failing tests:
  - 'download mode: single file row stamps DownloadURL and does not preventDefault';
  - 'folder row / multi: no DownloadURL';
  - `stampFileDrag` with `terminal:true` sets `application/x-conduit-path`.
- [ ] Run them. They FAIL.
- [ ] Implement.

---

### Slice 6: v1 surfaces (outcomes A, B)

**Check:** `npx vitest run test/unit/doc-tabs-drag.test.ts test/unit/change-row-drag.test.ts
test/unit/search-head-drag.test.ts` green; `npm run typecheck` green.

**Parallel groups:** G1: T6.1 · G2: T6.2 · G3: T6.3
**Claims:** none. Three disjoint source files, one test file each.

For all three tasks:
- **Consumes:** `stampFileDrag(dt: DataTransfer, absPath: string, opts: { download: boolean;
  terminal: boolean }): void` (`webview/file-drag-data.ts`).
- **Test:** jsdom render + a dispatched `dragstart` with a stub `dataTransfer` recording `setData`.

#### Task 6.1: doc tabs

**Files:**
- Modify: `webview/components/doc-tabs.tsx` (tab `onDragStart`, `:245-248`)
- Test: `test/unit/doc-tabs-drag.test.ts`

**Steps:**
- [ ] Failing test: 'file tab dragstart stamps DownloadURL, and effectAllowed is copyMove; a diff tab
  stamps nothing, and effectAllowed stays move'.
- [ ] Implement:
  - when `d.kind === 'file'`, call `stampFileDrag(e.dataTransfer, d.path, {download:true,
    terminal:false})` and set `effectAllowed = 'copyMove'`;
  - the reorder (`dragIdRef`) is untouched.

#### Task 6.2: Changes rows

**Files:**
- Modify: `webview/components/changes-view.tsx` (`ChangeRow` root `div`, `:84-90`)
- Test: `test/unit/change-row-drag.test.ts`

**Steps:**
- [ ] Failing test: 'non-deleted row is draggable and stamps both types with the joined absolute
  path; a deleted row is not draggable'.
- [ ] Implement:
  - `draggable={change.kind !== 'D'}` (confirm the deleted kind's literal in `ChangeDTO` first);
  - build the absolute path with the repo's existing repo-relative join helper (`src/repo-rel.ts`).
    If none fits, **stop and report**; do not add another join.

#### Task 6.3: search result heads

**Files:**
- Modify: `webview/components/search-pane.tsx` (the `searchgroup__head` button, `:112-117`)
- Test: `test/unit/search-head-drag.test.ts`

**Steps:**
- [ ] Failing test: 'result head is draggable and stamps DownloadURL + x-conduit-path for
  result.abs'.
- [ ] Implement.

---

### Slice 7: e2e scenario, changelog, docs (always)

**Check:**
- `node --check test/e2e/os-drag-out.e2e.mjs` passes;
- `npm run verify` green (the final gate);
- `git status` shows only planned files.

**Parallel groups:** Serial: T7.1 → T7.2
**Claims (serial lane):** `CHANGELOG.md`, `docs/specs/INDEX.md`

#### Task 7.1: e2e (written, not run this item)

**Files:**
- Create: `test/e2e/os-drag-out.e2e.mjs`. Win32-only skip, as `os-import.e2e.mjs:15-18` does; uses
  `runScenario`, `launchApp`, `openSession`, `tapBridge` from `harness.mjs`; fixtures in `mkdtempSync`.

**Steps:**
- [ ] **Outcomes A / A′:**
  - dispatch a synthetic `dragstart` (`new DragEvent` with a `new DataTransfer()`) on a file row, then
    on a ctrl-click-selected pair, then on a folder row;
  - after each, `app.evaluate(() => globalThis.__conduitDragOutLog.at(-1))` has `accepted:true` and
    the expected paths.
- [ ] **Outcomes A / A′:**
  - crafted `window.agentDeck.post({type:'fs:startDrag', dragId: 900, sessionId, paths:['C:\\Windows\\win.ini']})`
    → logged `outside-folders`;
  - a deleted fixture path → `missing`;
  - a second session moved to a new window via `session:move` and requested from window 1 →
    `unknown-session`.
- [ ] **All outcomes:**
  - select `ünï 日本.txt` and press Ctrl+C;
  - `__conduitClipboardLog.at(-1).stdinPaths` equals `[that path]` (when the win32 clipboard is
    built), or the entry is absent and no toast appears (when it's unsupported).
- [ ] **All outcomes:**
  - `page.evaluate(() => { location.href = 'file:///C:/Windows/win.ini' })`;
  - after 500 ms, `page.url()` still ends with `index.html`;
  - a synthetic `dragover` with `types` containing `Files` on `.center` dead space returns
    `defaultPrevented === true` with dropEffect `none`.
- [ ] `node --check` the file.

#### Task 7.2: changelog + docs

**Files:**
- Modify: `CHANGELOG.md` `[Unreleased]`:
  - Added: drag files and folders out of the Files tree, and Copy → paste in Explorer/Finder (worded
    per the outcome actually built);
  - Changed: a cross-window tree drag now copies (D10); a terminal drop pastes every dragged path.
- Modify: `docs/specs/INDEX.md` (add the active row for `2026-09-24-os-drag-out.md`)

**Steps:**
- [ ] Write it.
- [ ] Run `npm run verify`, capturing the exit code directly.

## Manual smoke (human, after the build; no automation performs a real OS drag out)

- Drag a single file, a multi-selection and a folder onto an Explorer folder. The copies appear and
  the originals are intact.
- Drag onto a Chrome upload zone and into Slack/Teams compose. They attach.
- Drag back into the tree. It moves, and Ctrl copies. One highlight shows, spring-open works, and the
  conflict prompt appears on a collision.
- Drag onto the terminal. Every path is inserted.
- Copy, then paste in Explorer, including a non-ASCII name. Copy, then paste into Slack. Paste into
  folder in Conduit still copies.
- A drop on dead space, the Monaco gutter and the board does not navigate the window.
- Drag from window A's tree to window B's tree. It copies, per D10.
- Refusals: rename a file away on disk, then drag its stale row. The toast reads `Can't drag …: it no
  longer exists.`
- macOS: repeat the Finder drag and paste. This is owed, because F6 is unmeasured.

## Verification

- **Per task:** its own `npx vitest run <test file>`.
- **Per slice:** `npm run typecheck` plus the slice Check, plus `npm run build` when the machine is
  free. The conductor sequences builds because another agent builds here.
- **Final:** `npm run verify`, with the exit code captured directly (never `| tail`).
- `test:smoke` for `os-drag-out`, `terminal-drop` and `os-import` runs in the run-end e2e sweep, not
  per item (user decision).

## Deviation rule

If a task's assumption turns out wrong (the piece it builds on is misaligned, or a locked signature
doesn't fit reality), that task **stops**, and fixing the misaligned piece becomes the work. Never a
shim, a second copy, a special case, a widened type, a fallback, or an override patched in place of
its semantic source. The report leads with the fix that keeps the locked decision. S0 results are
the one sanctioned fork: the branch table picks the slices, and nothing outside it is improvised.

## Decisions Needed

- **[high]** S0 drives real OS input (`SendInput`), which takes the mouse and focus for about 1
  minute. It also briefly overwrites the clipboard in F4 (text is saved and restored, other formats
  are lost).
  - Default taken: run it, and state it in the run report.
  - If the machine is attended, the conductor should warn the user first.
- **[high]** An unmeasured F1/F2/F3 counts as FAIL, so outcome B or C ships and folder/multi
  drag-out is deferred.
  - Default taken: conservative. The user can re-run S0 by hand and flip `DRAG_OUT_MODE`.
- **[high]** F2 treats a main process blocked during the drag (IPC stalled until drop) as FAIL,
  because spring-open into an unloaded folder needs a `readDir` reply mid-drag.
  - An untaken middle path: accept the stall (loaded folders still spring open), keep native, and
    document it.
  - Default taken: the spec's fallback. Flag it to the user if F2 fails only on criterion 3.
- **[normal]** macOS is never `native` this run (F6 can't be measured here). It gets `download` in
  outcome A and `none` in A′. The macOS clipboard `writeBuffer` ships unmeasured, on VS Code's TPI
  evidence.
- **[normal]** Linux takes the Windows result for native drag (same Views drag code), unmeasured.
- **[normal]** `fs:osClipboardResult` failure gains `path?` so the toast can name the item.
- **[normal]** A `CLAUDE.md` gotcha is not added: "`startDrag` blocks main on win/linux; `dragend`
  never fires after a prevented dragstart; the e2e host never calls `startDrag`". The conductor
  decides whether it belongs there after the build.

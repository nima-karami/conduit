# Remote over SSH, slice 8: browse and view files on B (CON-43) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` (§4.3 F9, §4.4 "Served", §5.3 fs.* frames and deny-list, §6, §8, §9.1 "Remote file tab", §10 row 8, §11 S8 row) **Tier:** FULL
**Builds on:** CON-41 (remote rows, `activeRemote`, RemotePane, `electron/remote-panes.ts` routing pattern), CON-40 call machinery (`server/network/calls.ts`: inbound-controller rule, pending map, `settleAbsent`), CON-42 (LINK_PROTOCOL minor 3; this slice takes minor 4 — agreed with claude-24 2026-11-16 15:32Z).

## Goal
When the owner selects a session on B, the Files pane shows that session's folders on B as a read-only tree, and clicking a file opens a viewer tab with B's content, refreshed when it changes on B. B serves only paths inside that session's folders and never a deny-listed path.

## Architecture
- **B is the only judge of what may be read.** A's renderer, Electron and server never decide confinement; B resolves every path against the named session's `home` + `roots` (lexical check, then realpath recheck — `src/path-guard.ts` `isInsideAnyRoot` + `realPathLeaf`, the `validateWrite` pattern) and a fixed deny-list, and reads with the existing pure `src/file-service.ts` (`readDir`, `readFile`). Size caps shrink to fit one frame.
- **New sibling frames, not `call`.** `fs.req`/`fs.res` (request/response, never replayed) and `fs.watch`/`fs.unwatch`/`fs.changed` (re-established on reconnect, never replayed). Served on B only on an inbound ssh controller link; the machine id comes from the link, never the frame; refusals are audited (rate-limited like `call.refused`). A accepts `fs.res`/`fs.changed` only from machines it dialed.
- **A side mirrors calls.ts:** a pending map with a timeout, settled `peer_unreachable` when the link drops or the machine leaves the list; a desired-watch registry re-sent when the link comes back up.
- **Renderer: a separate, read-only `RemoteFilesView`** reusing the pure tree helpers (`webview/file-tree.ts`) and file icons, not a mode of `FolderSection` (which is wired to local create/rename/delete/drag and path-keyed `dirEntries` replies that would collide with same-path local roots). Remote viewer tabs are ordinary `OpenDoc`s with a `machine` field and their own content store, so no path-keyed local code (watchers, read grants, md:image, preview) ever sees them.

## Data flow
```
renderer RemoteFilesView ─remoteFs:list{requestId,machineId,sessionId,path}─▶ electron remote-files ─C2 remote.fs.list─▶ A fs-client
   A fs-client ─fs.req{id,op:'list',sessionId,path}─▶ B fs-serve: inbound-controller? → session(sessionId).home+roots → confine(path) → denied? → readDir → fs.res
   ◀─ remoteFs:listed{requestId,result} ◀─ C2 result ◀─ pending[id] settled
open file → OpenDoc{kind:'file', path, machine:{machineId,sessionId}, id:`file@<machineId>:<path>`, sessionId: remoteKeyId}
   ─remoteFs:read─▶ … op:'read' → B readFile (caps below) → FileContentDTO + readOnlyReason 'remote'
watch: RemoteFilesView (expanded dirs) + open remote docs ─remoteFs:watch{key,…}─▶ electron (key→window) ─C2 remote.fs.watch─▶ A registry ─fs.watch─▶ B watchDir (per link, cap)
   B change ─fs.changed{watchId,paths}─▶ A ─C2 event remote.fs.changed─▶ electron ─remoteFs:changed{key,paths}─▶ renderer re-lists / re-reads
link down: A settles pending fs.req peer_unreachable; B drops that link's watches; link up: A re-sends desired watches.
```

## Settled decisions — do not re-litigate
- §5.3: 8 MiB per frame → `too_large`; confined to the session's folders, symlinks resolved and rechecked; the fixed deny-list wins inside them: `.ssh`, `.gnupg`, `.claude*`, `.codex`, `.cursor`, `.config/opencode`, `%APPDATA%` credential stores, `.env*` → `refused`.
- §11 S8: outside the folders, deny-listed, or over 8 MiB → `refused` / `too_large`, and B touches nothing.
- RS-D10: viewing in MVP; editing is slice 9 (CON-44) — tabs are read-only here.
- FS_MIN_MINOR = 4; LINK_PROTOCOL bumps to {1, 4} in this slice (claude-24 agreed).

## Technical decisions this plan makes
1. **Frames** (strictly parsed, extra keys rejected, in `src/contracts/link-protocol.ts`):
   - `{ t:'fs.req', id, op:'list'|'read'|'stat', sessionId, path }` (id ≤ 64 chars; path ≤ 4096; sessionId ≤ 64)
   - `{ t:'fs.res', id, ok:true, result: FsResult } | { t:'fs.res', id, ok:false, error:{ code: FsErrorCode, message } }`
   - `{ t:'fs.watch', watchId, sessionId, path }`, `{ t:'fs.unwatch', watchId }`, `{ t:'fs.changed', watchId, paths: string[] }` (≤ 256 paths per frame; more → one frame with `paths: []` meaning "re-list everything under the watch")
   - `FsErrorCode = 'refused' | 'not_found' | 'too_large' | 'unavailable' | 'failed'`
   - `FsResult = { op:'list'; path; entries: DirEntryDTO[] } | { op:'read'; file: FileContentDTO } | { op:'stat'; kind:'file'|'dir'; size; mtimeMs }`
2. **Caps on B:** text as `file-service` today (2 MiB, tail window for logs); image and PDF ≤ 6 MiB raw (base64 ≈ 8 MiB, inside §5.3's 8 MiB and the 16 MiB frame) else `too_large`; any encoded result over 8 MiB → `too_large`.
3. **Deny-list** `src/network/fs-deny.ts` `isDenied(absPath: string, home: string): boolean` — case-insensitive on Windows paths only; a path is denied if any segment equals `.ssh`, `.gnupg`, `.codex`, `.cursor`, starts with `.claude`, the segment pair `.config/opencode`, the basename starts with `.env`, or it lies under `AppData/Roaming/Microsoft/{Credentials,Protect}` / `AppData/Local/Microsoft/Credentials`. Checked on the lexical AND the real path. A `list` result omits denied entries (they are never shown), a `read`/`stat`/`watch` of one is `refused`.
4. **Confinement** `src/network/fs-confine.ts` `confineFsPath(path, roots: string[]): Promise<{ ok:true; real: string } | { ok:false; code: 'refused'|'not_found' }>` — absolute paths only; lexical `isInsideAnyRoot`, then `realPathLeaf` and recheck against the real roots; `..` segments refused before resolution (`hasDotSegment` in `src/canonical-path.ts`).
5. **Session lookup on B:** the `sessionId` must be a live or stopped session in B's domain (`domain.sessions.list()`); roots = `[home, ...roots]`. Unknown → `not_found`.
6. **Watches on B:** at most 64 per link (`refused` beyond), via `watchDir` (CLAUDE.md), 150 ms trailing debounce per watch, dropped on link down/forget.
7. **A side:** `FS_REQ_MS = 30_000`; pending settled `peer_unreachable` on drop or when the machine leaves the link list (hook into the existing `onLinksChanged` teardown loop from CON-41 L1); a peer below minor 4 → `peer_incompatible` without sending.
8. **C2:** `remote.fs.list|read|stat {machineId, sessionId, path}`, `remote.fs.watch {machineId, sessionId, path} → {watchId}`, `remote.fs.unwatch {watchId}`; event `remote.fs.changed {watchId, paths}` to the peer that watched.
9. **Renderer messages** (new, never overloading `readDir`/`readFile`): `remoteFs:list|read` (requestId) → `remoteFs:listed|content`; `remoteFs:watch {key, machineId, sessionId, path}` / `remoteFs:unwatch {key}` → `remoteFs:changed {key, paths}`. Electron's `electron/remote-files.ts` owns key → window → watchId, like remote-panes.
10. **Remote doc identity (revised after the T4 review):** a remote tab is its own `DocKind` `'remote-file'`, not a `'file'` doc with a flag, because ~20 app paths key on `kind === 'file'` and would read, watch, save or reopen its path locally. `OpenDoc.machine: { machineId: string; sessionId: string }` is set on every `'remote-file'` doc; id `remote-file@<machineId>:<path>`; `sessionId` = `remoteKeyId(...)` so the tab shows with that remote session; never persisted (`PersistedDoc` skips it); content in `webview/remote-files-store.ts`, passed to `DocView` as `file`; `readOnlyReason: 'remote'` (new union member) until slice 9.
11. **Files pane:** while `activeRemote` is set, the right pane's Files tab renders `RemoteFilesView` for that row's `session.home` + `session.roots`; local sections otherwise. Changes/Messages tabs show their existing empty state for a remote session (slice 10 adds Changes).

## Spec staleness
- §5.3 lists fs frames as additions to the link; measured: none exist, and C2 has no file methods (`src/contracts/server-protocol.ts`), file reads live only in Electron (`electron/main.ts:2969,2979`). This plan adds both.
- No deny-list exists anywhere (grep `.ssh`/`.gnupg` in src/server: only ssh config reads). New in `src/network/fs-deny.ts`.

## Global constraints
As CON-41's plan, plus the gate lock (`flock /tmp/claude-1000/conduit-gate.lock`) for every esbuild/full vitest/verify/e2e; lanes run tsc, biome and named vitest only.

## Out of scope
Writing (CON-44), git (CON-45), find-in-files on B, opening a B file from a terminal link, markdown image/HTML preview for remote docs (shown as source text), drag and drop.

## Contracts (orchestrator commits after merging CON-35-remote-ssh with CON-42)
- `src/contracts/link-protocol.ts`: frame types above, `FsErrorCode`, `FsResult`, `FS_MIN_MINOR = 4`, LINK_PROTOCOL `{1, 4}`. (Parser cases are Task 1's.)
- `src/contracts/server-protocol.ts`: the five C2 methods and the event.
- `src/protocol.ts`: the renderer messages; `readOnlyReason` gains `'remote'`; `OpenDoc` lives in webview/docs.ts (Task 3).

## Producer/consumer map
| Behavior | Produced by | Consumed by | Sides |
|---|---|---|---|
| fs.req/res | A fs-client | B fs-serve | both |
| fs.watch/changed | A registry / B fs-serve | B watchDir / A → C2 event | both |
| refusal audit | B fs-serve | B audit log → Activity | both |
| remote.fs.* C2 | electron remote-files | server c2 → fs-client | both |
| remoteFs:* messages | renderer stores | electron remote-files | both |
| OpenDoc.machine | app open-file path | center-pane DocView, docs persistence (skip) | both; persistence measured: `PersistedDoc` (src/protocol.ts:90) |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `src/network/fs-deny.ts` | create | deny-list |
| `src/network/fs-confine.ts` | create | confinement |
| `src/contracts/link-protocol.ts` | modify | types (orchestrator), parser cases (T1) |
| `server/network/fs-serve.ts` | create | B: serve fs.req / watches |
| `server/network/fs-client.ts` | create | A: pending, watches, events |
| `server/network/index.ts` | modify | dispatch frames to serve/client; teardown hook |
| `server/network/c2.ts` | modify | five C2 cases |
| `server/services.ts` | modify | sessions roots dep for fs-serve |
| `electron/remote-files.ts` | create | key→window routing |
| `electron/main.ts`, `electron/server-events.ts` | modify | renderer cases, event |
| `webview/remote-files-store.ts` | create | requests, content map, watch keys |
| `webview/components/remote-files-view.tsx` | create | read-only remote tree |
| `webview/components/right-pane.tsx` | modify | Files tab shows RemoteFilesView while remote |
| `webview/docs.ts` | modify | `machine` on OpenDoc, id, persistence skip |
| `webview/app.tsx`, `webview/components/center-pane.tsx` | modify (serial) | open remote file, pass content |
| `test/e2e/net-remote-files.e2e.mjs` | create | headless e2e |

## Slices
### Slice 1 (parallel lanes)
- **T1 B-serve (security; mutation checks required):** fs-deny, fs-confine, parser cases + tests, fs-serve, its index.ts dispatch hunk (B side), services.ts dep. Tests: S8 cases (outside → refused and no read call; `..` → refused; symlink inside → target outside → refused; each deny-list entry refused; denied entries omitted from list; >6 MiB image → too_large; frame from a TLS or A-side record → refused + audited; unknown session → not_found; 65th watch → refused; watches dropped on link down).
- **T2 A-client + C2:** fs-client, c2.ts cases, its index.ts hunk (A side + teardown hook). Tests: timeout, drop → peer_unreachable, never re-sent, minor 3 peer → peer_incompatible, fs.res from a non-dialed machine dropped + audited, watches re-sent on up, event routed to the watching peer.
- **T3 Electron:** remote-files.ts + main.ts/server-events cases, tests as remote-panes.
- **T4 Renderer:** remote-files-store, RemoteFilesView, right-pane, docs.ts. Tests: tree lists and expands; a file click calls the open handler with the machine; changed → re-list; docs id/persistence.
**Claims:** `server/network/index.ts` — T1 (B dispatch hunk) and T2 (A hunk + teardown) touch different functions; the orchestrator merges T1 first. `src/contracts/link-protocol.ts` parser — T1 only.
### Slice 2 (serial, orchestrator): app.tsx/center-pane wiring, CHANGELOG, e2e `net-remote-files` (fake-ssh: lead opens a session on B with a folder containing `a.txt`, `.env`, `.ssh/id`; Files shows a.txt, not .env/.ssh; open a.txt shows its text; change it on B → tab updates; a direct C2 `remote.fs.read` of `<folder>/.env` and of `/etc/passwd` → refused).

## Verification
Lanes: tsc + biome + named vitest. Orchestrator: full verify under the lock per merge; mutation checks on T1 (remove realpath recheck; remove one deny entry; skip the inbound-controller check); headless screenshots of the remote Files pane and a remote tab; e2e local once, then `e2e:remote`.

## Deviation rule
If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a shim, second copy, special case, widened type, fallback, or an override patched in place of its semantic source.

## Decisions Needed
- [normal] Read-only `RemoteFilesView` instead of reusing `FolderSection` (no create/rename/delete/drag on B in MVP). Default taken.
- [normal] Image/PDF cap 6 MiB raw on B (local is 25/50 MiB). Default taken.
- [normal] B serves any of its sessions' folders to the controller, not only sessions that controller opened (monitor already shows all). Default taken.

# Remote over SSH, slice 9: edit files on B (CON-44) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` (§4.3 F9, §4.4 `attach_folder` row, §5.3 `fs.write { path, data, expect }`, §11 S9, RS-D17) **Tier:** FULL
**Builds on:** CON-43 (fs frames, `fs-serve`/`fs-client`, confinement + deny-list, `'remote-file'` tabs rendered read-only on their own Monaco model by CON-43 R).

## Goal
The owner edits a B file in its remote tab and saves; B writes it only if the file still has the content the editor loaded, otherwise B refuses with `conflict`, the tab shows a diff (B's current text vs the edit) and offers Re-apply (overwrite) or Discard. A lead can `attach_folder { machine, folder }` to add a B folder to a B session.

## Architecture
- **B decides, by content.** `fs.write { id, sessionId, path, data, expect }` where `expect` is the SHA-256 of the content the editor loaded (or `null` for "create, must not exist"). B confines the path (parent-dir confine for a new file), checks the deny-list, hashes the current file, refuses `conflict` on mismatch, else writes atomically (`src/file-service.ts` `writeFile` / `src/atomic-write.ts`). Every remote save carries `expect` (manual saves too — local manual saves don't, S9 requires it here). Re-apply is an explicit overwrite: a second write with `expect` = the hash B just reported.
- **A second save instance, keyed by doc identity.** `createFileSaves(deps)` (`webview/file-save-controller.ts`) is already dependency-injected; a `remoteFileSaves` instance uses `write` = `remoteFs:write`, `getModel` = the remote model (`conduit-remote://<machineId><path>`), `requestRead` = the remote reader. The path-keyed registries (`save-registry.ts`, `dirty-store.ts`, the controller's `entries`) gain a key accessor so remote entries are keyed `remote-file@<machineId>:<path>` and can never collide with a local path.
- **attach_folder routed** as a seventh routed tool, gated on the link minor that adds it; B runs it as the remote principal (CON-40 machinery) with absolute paths only (no home on a remote caller).

## Data flow
```
edit → dirty (key remote-file@m:path) → save → remoteFileSaves.write → remoteFs:write{requestId, machineId, sessionId, path, data, expect}
  → electron remote-files → C2 remote.fs.write → A fs-client → fs.write frame → B fs-serve:
     controller? → confineForWrite(path) → denied? → sha256(current) === expect ? atomic write → {ok, hash} : {conflict, currentHash}
  ◀ remoteFs:written{requestId, result: ok{hash} | conflict{currentHash} | error}
conflict → tab banner: diff(B's current text via fs.read, the buffer) + Re-apply (write with expect=currentHash) / Discard (reload)
lead → attach_folder{machine, folder} on A → routed call → B: remote principal, absolute folder confined? (no: it ADDS a root — B checks it's a directory and not deny-listed) → addRoot
```

## Settled decisions — do not re-litigate
- RS-D17 (a): refuse on mismatch and offer a diff to re-apply.
- §5.3: 8 MiB per frame → `too_large`; deny-list wins; writes stay inside the session's folders.
- §11 S9: on conflict B leaves the file unchanged; otherwise the save lands and shows in B's Changes (CON-45).

## Technical decisions this plan makes
1. **Frames:** new sibling frames `{ t:'fs.write', id, sessionId, path, data, expect: string | null }` → reply on the existing `fs.res` with result `{ op:'write'; hash }` or error code `'conflict'` (added to `FS_ERROR_CODES`) carrying `{ currentHash }` in a dedicated field — the strict parser validates `data` ≤ 8 MiB UTF-8 and `expect`/hashes as 64 hex chars. `FS_WRITE_MIN_MINOR` = the next free link minor at merge (coordinate with claude-24); a peer below it → `peer_incompatible`, the tab stays read-only with "Update Conduit on <machine> to edit".
2. **`confineFsPathForWrite(path, roots)`** in `src/network/fs-confine.ts`: the parent directory must confine (realpath) and the leaf must not be a symlink that escapes; deny-list on lexical and resolved paths.
3. **Hash:** SHA-256 hex of the UTF-8 content; computed on B for the read result too (`FileContentDTO` gains `hash?: string` for remote reads only) so the editor's `expect` is exactly what B hashed.
4. **Read-only lifts per peer:** `readOnlyReason: 'remote'` is set by B only when the controller's minor is below `FS_WRITE_MIN_MINOR`; `webview/read-only-doc.ts` handles `'remote'` (added by CON-43 R).
5. **Registry keys:** `save-registry.ts`, `dirty-store.ts` and the controller key entries by a `keyOf(doc)` = `doc.id` for remote-file docs and the path for local ones; every existing caller keeps passing paths for local docs (no behaviour change — tests pin it).
6. **Conflict UI:** the CodeViewer conflict banner (code-viewer.tsx ~828-856) gains a "Show diff" action for remote docs that opens a `DiffViewer` (head = B's current text fetched with `remoteFs:read`, work = the buffer) and Re-apply / Discard buttons. Local conflict UI unchanged.
7. **attach_folder routed:** add `'attach_folder'` to `ROUTED_TOOLS` behind `ROUTED_ATTACH_MIN_MINOR` (same next-minor rule), to `MACHINE_ARG_TOOLS`, a `routedAskSummary` case, `policy-targets.ts` remote-folder branch; on B, `prepareAttachFolder` accepts a remote caller only with an absolute folder (relative → `invalid_args` "use an absolute path on <machine>"), not deny-listed, an existing directory.

8. **CodeViewer shape (from the CON-43 R review):** replace R's single `local = source == null` boolean with (a) an injected `saves` instance plus a `bufferKey` (default: the app's `fileSaves` and `doc.path`; remote: the remote save store keyed by doc id) that drives attach, save triggers, `useFileSaveStatus` and the conflict banner (which today hard-codes `fileSaves.save/reload` and `closeDocForPath`); (b) a `projectBound` flag for nav, blame, change markers, review notes, reveal, selection and cursor publishing; (c) the remote MODEL owned by the remote save store, not the editor's unmount (mirroring idle-models), so a tab switch never loses unsaved edits. The R-era `local` save gates then disappear.

## Spec staleness
- §5.3 `expect` = "the content hash the editor loaded": no hash exists today; local conflicts compare whole strings (`src/file-service.ts:223-236` `compareOnDisk`). This plan adds SHA-256 for remote only.

## Global constraints
As CON-43's plan (gate lock; both tsc configs; biome on every changed file incl. CSS; named vitest without flock in lanes).

## Out of scope
Rename/delete/create from the remote tree UI, auto-save for remote docs (manual save only in v1; auto-save stays off for `'remote-file'`), credential files.

## Slices
### Slice 0 (orchestrator): frames + parser + tests; C2 `remote.fs.write`; renderer messages; `hash` on remote reads.
### Slice 1 (parallel): W1 B write serve (security, mutation-checked: confine-for-write, deny, expect check, atomic) · W2 A client write + C2 · W3 electron route · W4 renderer: key accessor in registries, remoteFileSaves, conflict diff banner. Serial: W5 attach_folder routing (touches remote-routing.ts/host.ts/calls.ts — coordinate with claude-24 before starting).
### Slice 2 (orchestrator): wiring, CHANGELOG, e2e `net-remote-edit` (edit + save lands on B; change on B meanwhile → conflict banner, diff, Re-apply lands; `.env` write refused; attach_folder adds a B folder that then shows in the remote Files pane).

## Verification
Lanes: both tsc configs + biome + named vitest. Orchestrator: full verify per merge under the lock; mutation checks on W1 (drop expect check; drop parent confine; drop deny on write); headless screenshots of the conflict banner and diff; e2e local once then `e2e:remote`.

## Deviation rule
If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a shim, second copy, special case, widened type, fallback, or an override patched in place of its semantic source.

## Decisions Needed
- [normal] Remote docs get manual save only (no auto-save) in v1. Default taken.
- [normal] Re-apply overwrites B's newer content after the owner has seen the diff (RS-D17 a). Default taken.

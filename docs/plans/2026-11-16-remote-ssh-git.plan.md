# Remote over SSH, slice 10: Changes, diff, history and Review for B's folders (CON-45) — implementation plan

**Spec:** `docs/specs/2026-11-16-remote-ssh.md` (§4.3 F9, §5.3 `git.status/diff/log/show` read-only frames, §9.1 "Remote Changes / Review / history", §10 row 10, §11 S10) **Tier:** FULL
**Builds on:** CON-43's served-file path end to end (fs frames, `server/network/fs-serve.ts` confinement + `sessionRoots`, `fs-client.ts`, `electron/remote-files.ts`, `webview/remote-files-store.ts`, `'remote-file'` doc kind, RightPane `remote` prop).

## Goal
For a selected session on B, the Changes tab lists B's git changes per repo, a change opens a diff tab of B's file, git history shows B's commits, and a commit opens its diff — all read-only, refreshed when files change on B.

## Architecture
- **Same shape as CON-43, a second service.** `git.req`/`git.res` sibling frames (never replayed), served on B only on an inbound ssh controller link, confined to the named session's roots (`confineFsPath` from `src/network/fs-confine.ts`, reused), running the existing pure git code through `runGitBin` (CLAUDE.md). A's `git-client` mirrors `fs-client` (pending map, timeout, settle on drop/forget/reconnect, minor gate, accept only from dialed machines).
- **No push channel.** The renderer re-requests on the `fs.changed` it already gets from watching the remote folders (CON-43); no new watch frames.
- **Renderer:** remote diffs and remote history are their own doc kinds (`'remote-diff'`, `'remote-history'`) for the same reason CON-43 made `'remote-file'`: every local `kind === 'diff'` path reads the local repo. Changes uses a small read-only `RemoteChangesView` fed by remote status; local `changes-view.tsx` is not modified.
- **Writes are out:** stage/unstage/discard/stash/switch/commit and review marks stay local-only in this slice (they become routed calls later — Decisions Needed).

## Data flow
```
RightPane Changes (remote row) → remote-git-store.status(machineId, sessionId) → remoteGit:status → electron remote-git → C2 remote.git.status
   → A git-client → git.req{id, op:'status', sessionId, root} → B git-serve: inbound-controller? → confine(root) → readRepoChanges(root) → git.res
change click → OpenDoc{kind:'remote-diff', path, machine} → remoteGit:diff → … op:'diff' {path} → readDiffReply(path) (gitShow via src/git-show.ts) → FileDiffDTO
history → OpenDoc{kind:'remote-history', path: root, machine} → op:'log' {limit, before?} → getHistory + assignLanes → {commits, layout, hasMore}
commit click → OpenDoc{kind:'remote-diff', path: sha, machine, …} → op:'show' {sha} → getCommitDiff → FileDiffDTO[]
fs.changed (CON-43 watch) under a repo → store re-requests status / open remote-diff docs
```

## Settled decisions — do not re-litigate
- §5.3: git reads are read-only frames; git actions run as routed calls (not in this slice).
- §11 S10: B's git state shown; views update when files change on B.
- CON-43's confinement and deny-list apply: a diff of a deny-listed path is refused; status entries for denied paths are omitted.

## Technical decisions this plan makes
1. **Frames:** `{ t:'git.req', id, op: 'status'|'diff'|'log'|'show', sessionId, root, path?, sha?, limit?, before? }` and `{ t:'git.res', id, ok, result | error:{code: FsErrorCode, message} }`; results: status → `{ op:'status'; root; changes: ChangeDTO[]; lines: … as RepoSnapshot }`, diff → `{ op:'diff'; file: FileDiffDTO }`, log → `{ op:'log'; commits; layout; hasMore }`, show → `{ op:'show'; files: FileDiffDTO[]; truncated }`. `GIT_MIN_MINOR` = the next free link minor at merge time (CON-43 = 4, CON-46 = 5; coordinate with claude-24). Strict parser validates every field; results bounded by the 8 MiB rule (`too_large`).
2. **Move `gitShow`/`gitShowBuffer`/`gitShowBlob`/`repoTopLevel`/`headShaFor`** out of `electron/main.ts` (~860-950) into `src/git-show.ts` (pure, `runGitBin`), used by both Electron and B. Behaviour unchanged for Electron (tests pin it).
3. **Confinement:** `root` must confine to the session's roots; `path` (diff) must confine to `root` and pass the deny-list; `sha` matches `/^[0-9a-f]{7,40}$/`; `limit` ≤ 500.
4. **C2:** `remote.git.status|diff|log|show {machineId, sessionId, root, …}`.
5. **Renderer:** `remoteGit:*` request messages (never overloading `readDiff`/`git:history`); `webview/remote-git-store.ts`; `RemoteChangesView` (read-only list per repo: status letter, path, +/− lines; click opens `'remote-diff'`); `'remote-diff'` renders through `DiffViewer` with a remote model scheme (same rule as CON-43 R); `'remote-history'` reuses `git-history-view.tsx`'s rendering with a data-source prop (no local `git:history` calls when remote).
6. **Refresh (revised after the G4 review):** B's folder watches are not recursive, so a nested edit never fires. The remote Changes store polls `status` every 5 s while the Changes tab is visible, and also watches `<repo>/.git` for an immediate refresh after a stage/commit/checkout, debounced 300 ms. A folder in no repo is answered `{ op:'status', root, snapshot: null }` — shown as "No git repository", never as an error. The remote diff and history viewers are built in Slice 2 (orchestrator wiring), not G4.

## Security hardening after the G1 re-review
The re-review found that git, run on a repo the session can write, can be pointed elsewhere or made to run programs. What B does now, on every served read:
- **Fresh top.** The repo top is asked fresh, never through gitShow's 30 s memo, so a new `core.worktree` can't move it unseen.
- **Pinned dirs.** Every spawn has `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` set to the checked real paths. A later `.git` file, `commondir` or `core.worktree` can't redirect it.
- **Program keys neutralised.** `server/network/git-neutral.ts`:
  - fixed overrides: `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `log.showSignature=false`;
  - for each `filter.<name>.*` the effective config lists: `clean`, `smudge` and `process` set to empty, and `required=false`;
  - for each `diff.<name>.textconv|command`: both set to empty;
  - `GIT_NO_LAZY_FETCH=1`;
  - an `extensions.*` outside the known format-only set is refused.
  LFS repos keep working.
- **Show hides denied content by blob id.** It drops a file whose blob id is a deny-listed path's blob in the index, as well as one whose name is denied.
- **Line counts.** An untracked symlink counts as git stores it (one line); a FIFO or device is never opened.
- **`.git` is deny-listed.** fs reads, listings and (CON-44) writes never touch `.git/**`.

Where this differs from the lead's list (2026-11-16 18:38Z), and why:
- **`GIT_CONFIG_NOSYSTEM` is not set.** The system file is not writable from a session, and its filters are neutralised like any other's. Dropping it would lose Git for Windows' system `core.autocrlf`, and status would then show every file of a CRLF checkout as changed.
- **`include*` is not refused.** `git config --list` expands includes, so what an include brings in is neutralised the same way. An include only adds risk through the race below. Refusing it would break users whose global config uses `includeIf` for an identity.
- **`gpg.program` is not overridden.** `log.showSignature=false` is what starts it, and `/bin/false` doesn't exist on a Windows B.
- **`diff.external` and `--no-ext-diff` / `--no-textconv`.** None of the served reads produce a patch: they use numstat, name-status, raw and blob show. An empty `diff.external` makes `git diff` fail. Per-driver textconv is neutralised by config.

**Accepted residual: the race between the check and the spawn.** A writer to the session folders can plant alternates, symlinks or config inside the pinned git dir after the check passes. User-space checks can't close that. It is accepted because the ssh controller already has a shell on B, and B-side agents already run as B's user. Future fix: run git in an OS sandbox (read-only to the session roots, no exec), or read repos with a pure-JS git reader. Owner decision, via the lead.

## Spec staleness
- §5.3 "the owner's git actions in Review run as routed calls": no routed git tool exists (`ROUTED_TOOLS` has six session tools). Out of this slice; Decisions Needed.

## Global constraints
As CON-43's plan (gate lock for esbuild/full vitest/verify/e2e; lanes run both tsc configs, biome on every changed file incl. CSS, named vitest without flock).

## Out of scope
Git writes (stage/discard/stash/switch/commit), review marks/notes on B, blame, head-blob change markers in remote tabs, range diffs, refs.

## Slices
### Slice 0 (orchestrator): frames + strict parser + tests, C2/renderer message contracts, `src/git-show.ts` move (behaviour-preserving, Electron tests green).
### Slice 1 (parallel): G1 B git-serve (security: confinement + deny + controller rule, mutation-checked) · G2 A git-client + C2 · G3 electron remote-git · G4 renderer store + RemoteChangesView + remote-diff/remote-history kinds + viewer source scheme.
### Slice 2 (orchestrator): app wiring, CHANGELOG, e2e `net-remote-git` (fake-ssh B with a git repo in the session folder: Changes lists a modified file; its diff shows the change; history lists the commits; editing the file on B refreshes Changes).

## Verification
Lanes: both tsc configs + biome + named vitest. Orchestrator: full verify per merge under the lock; mutation checks on G1; headless screenshots of remote Changes, a remote diff, remote history; e2e local once then `e2e:remote`.

## Deviation rule
If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature doesn't fit reality — that task **stops** and fixing the misaligned piece becomes the work. Never a shim, second copy, special case, widened type, fallback, or an override patched in place of its semantic source.

## Decisions Needed
- [normal] B's `git status --numstat` and `git show` read deny-listed files internally (e.g. a line count for a modified `.env`) before the filter drops them; no content leaves B. Default: accepted; a pathspec-exclude derived from the deny-list is a follow-up.
- [normal] Git actions on B (stage/discard/commit from Review) need a routed path; not in this slice. Default: read-only remote git in MVP.
- [normal] Remote Changes is a separate read-only view rather than `changes-view.tsx` with a source. Default taken.

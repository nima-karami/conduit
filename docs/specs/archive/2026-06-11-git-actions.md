# Spec: git-actions (L1)

## Problem

The right pane's **Changes** tab renders three action buttons — *Stage Changes*,
*Stash*, *Reset all* — with **no `onClick` handlers**. They are dead. The change
list is also a flat list with no staged/unstaged distinction and no per-file
actions. This is the most visible "feature is thin" offender in the app.

## Goal

Make the Changes tab a working git staging area:

- Two sections — **Staged** and **Changes** (unstaged + untracked).
- Per-file row actions (stage / unstage / discard, as appropriate).
- Header actions: Stage all, Unstage all, Stash, Stash pop, Discard all.
- Destructive actions (discard file, discard all) gated by a `ConfirmDialog`.
- After every action: re-fetch the changes list so the UI reflects reality.
- Errors surface as a toast; the existing click-to-open-diff still works.

## Architecture

Reuse the existing plumbing — do **not** invent a parallel system.

- **Status production** stays in `src/project-info.ts` (`gitChanges`), extended to
  emit a `staged` flag per entry (below).
- **Command construction** is a new pure module `src/git-actions.ts` (arg arrays,
  unit-tested).
- **Execution** is a thin `execFile` executor wired into an `ipcMain.handle`
  request/response channel (mirrors the existing `writeFile` handle), because
  results/errors must propagate back to the renderer.
- **Refresh** reuses the existing `requestProject` → `project` round-trip.

## Staged/unstaged model

`git status --porcelain` emits `XY <path>` where **X** is the index (staged)
status and **Y** is the worktree (unstaged) status.

- A file staged AND further modified in the worktree (e.g. `MM`) yields **two**
  `ChangeDTO` entries: one `staged: true` (kind from X) and one `staged: false`
  (kind from Y). Each section then shows it independently — correct git behaviour.
- Untracked (`??`) is a single `staged: false`, `kind: 'U'` entry.
- Numstat for staged side comes from `git diff --numstat --cached`; unstaged from
  `git diff --numstat` (worktree vs index). Untracked files have no numstat (0/0).

`ChangeDTO` gains: `staged: boolean`.

### Diff on staged vs unstaged rows

Both staged and unstaged rows open the same diff (HEAD vs worktree) for now — the
existing `readDiff`/`gitShow` path is unchanged. Noted as acceptable; a future
task can split staged diffs (`--cached`).

## Command table

All commands run with `cwd = repo root` via `execFile('git', args)` — **arg
arrays, never shell strings**. Every path argument is validated to resolve inside
the repo root (`isInsideRoot` from `src/path-guard.ts`) and is always passed after
a `--` separator so a path that looks like a flag can't be misread.

| Action            | git invocation (args)                         | Notes |
|-------------------|-----------------------------------------------|-------|
| Stage file        | `add -- <path>`                               | Also stages a deletion (`git add` records removals). |
| Unstage file      | `restore --staged -- <path>`                  | git ≥ 2.23. See compat note. |
| Discard tracked   | `restore -- <path>`                           | Reverts worktree file to index. git ≥ 2.23. |
| Discard untracked | *delete the file on disk* (no git command)    | See untracked-discard semantics. |
| Stage all         | `add -A`                                       | Stages adds, mods, and deletions across the tree. |
| Unstage all       | `reset`                                        | `git reset` (mixed, no paths) unstages everything; works on very old git too. |
| Stash push        | `stash push`                                   | Includes tracked changes; untracked left as-is (default). |
| Stash pop         | `stash pop`                                    | Restores the most recent stash. |

### git compatibility note

`git restore` (used for unstage-file and discard-tracked) landed in **git 2.23
(Aug 2019)**. Conduit already requires a modern git for the diff viewer, and 2.23
is over five years old, so `restore` is acceptable. We deliberately use the
**older, universally-available** `git reset` (no `--`) for *unstage all* rather
than `restore --staged :/`, since a bulk unstage has a clean legacy spelling.
(Per-file unstage keeps `restore --staged` for precision and to avoid resetting
unrelated staged files.)

## Untracked-discard semantics (handle carefully)

For an **untracked** file, "discard" means **delete the file from disk** — there
is nothing in git to restore it to. This is destructive and unrecoverable.

- The executor handles `discardUntracked` specially: it does **not** shell out to
  git. It validates the path is inside the repo root (and is not the root itself),
  resolves it, confirms it is a regular file (never a directory — we never
  recursively delete), then `fs.rm` (no `recursive`, no `force`-ignore-missing
  semantics beyond a clear error).
- The renderer labels the confirm precisely: *"Delete untracked file X?"* vs the
  tracked discard's *"Discard changes to X? This cannot be undone."*

## Path safety

Every path argument is checked with `isInsideRoot(resolvedPath, repoRoot)` before
the command is built/run. Rejected paths return a typed error result and never
reach git or the filesystem. The `--` separator is always present so a path can
never be parsed as an option. Bulk actions (`add -A`, `reset`, `stash`) take no
path argument and so need no per-path check (they're inherently repo-scoped by
`cwd`).

## Refresh strategy

After every successful (or failed) action the renderer re-issues
`post({ type: 'requestProject', path })`, which the host already answers with a
fresh `project` message (changes + file tree). No new refresh channel is added.
This is the same path used today when the active project changes.

## IPC shape

New request/response channel `git-action` (via `ipcMain.handle`, like `writeFile`):

```
gitAction(req: GitActionRequest): Promise<GitActionResult>
GitActionRequest = { root: string; op: GitOp; path?: string }
GitOp = 'stageFile' | 'unstageFile' | 'discardTracked' | 'discardUntracked'
      | 'stageAll' | 'unstageAll' | 'stashPush' | 'stashPop'
GitActionResult = { ok: true } | { ok: false; error: string }
```

The host validates `root` is a known workspace root (reuse the same root set the
write-file path uses) before running anything, so the renderer cannot drive git in
an arbitrary directory.

## Preview mock

`webview/bridge.ts` exposes `gitAction`; the fake shell resolves it `{ ok: true }`
and the subsequent `requestProject` returns the mock change list, so the preview
renders both sections and the actions no-op gracefully (the list simply reloads
unchanged — honest for a host-less preview).

## Acceptance

- Command-construction functions unit-tested (arg arrays + path rejection).
- Host integration test drives the real executor against a scratch temp git repo
  (never the project repo): stage → staged; unstage; discard tracked; discard
  untracked (file gone); stash push/pop. Skips if git absent; cleans up temp.
- Changes tab renders Staged + Changes sections with per-row + header actions.
- Discard file / Discard all show a 2-way confirm before running.
- `npm run verify` and `npm run build` exit 0.

## Folded header (R2 git-actions-fold)

The squished five-button row (`right__actions`) was removed and replaced with a
compact kebab trigger (three-dot `⋮`) in the Changes-tab header.

**Header layout:** `<N> change(s) +<add> -<del>` summary on the left, kebab
button on the right — one line, no wasted vertical space.

**Kebab menu items** (Stage all, Unstage all | Stash changes, Pop stash |
Discard all changes [danger]) use the `triggerRef + menuToggleIntent` toggle
contract from `src/menu-toggle.ts` and `anchorMenuToRect` from
`src/menu-position.ts` — matching the sessions sort/filter pattern in
`webview/components/sidebar.tsx`.

**Context-menu bulk actions:** The same five bulk ops are appended
(separator-divided) to the per-file right-click context menu in `app.tsx`
`onChangeContextMenu`, so every git bulk action is reachable from either
the kebab or a right-click on any change row.

**ConfirmDialog + toast behaviour unchanged:** `onGitAction` in `app.tsx`
gates destructive ops (`discardAll`, `discardTracked`, `discardUntracked`)
with the existing 2-way confirm; failures surface as toasts.

Relevant files: `webview/components/right-pane.tsx`, `webview/app.tsx`,
`webview/styles.css`.

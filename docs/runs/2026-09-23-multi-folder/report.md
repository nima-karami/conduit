# Run report — multi-folder sessions and projects (2026-09-23 → 2026-09-25)

Source: the 2026-09-23 design handoff "Multi-folder sessions and projects" (README, two prototypes,
screens 9a–12j), plus one item the user added mid-run (os-drag-out). Built on `feat/multi-folder`,
one worktree per item, each through spec → plan → design review → build → independent review →
runtime QA → merge. Released as **v0.41.1**: the v0.41.0 tag failed the Linux CI gate on a unit
test that assumed Windows path separators (fixed in 8115ea5) and was never published.

## Shipped

| Item | Merge | What |
|---|---|---|
| mf-model | 57a3cd0 | `projectPath`→`home`, `roots[]`, `projectId`, `userData/projects.json`, crash-safe migration, folder runtime, claude `--add-dir` (cmd-shim metacharacter guard) |
| mf-changes | e297a66 | git leaves the terminal tab row; Changes tab per repo with branch chip, History per repo |
| mf-new-session | 0089252 | New session dialog: launcher pills, project chip, folders, host-resolved "Launches as" |
| mf-files | 8937a9b | Files tab per folder, Locate, attach-on-drop, search / quick open across folders |
| idle-loop | 1158688 | a deleted watched folder is dropped once, not refreshed forever |
| mf-sidebar | 617e554 | sidebar grouped by project, header +, menus, Move to project, drop on header |
| mf-board | 728499d | board cards list linked sessions; + Start session prefills project/card/folders |
| watcher-audit | 2f7e4c5 | every directory watch goes through `watchDir` (Windows libuv self-rename loop) |
| follow-ups | fa1b612 | source-bytes guard, per-window health switch, ordered project replies, popover/menu fixes |
| mf-live-edits | d2288f0 | "claude can't see <folder> yet" banner, paste-only /add-dir confirmed by claude's output, missing home, Can't start |
| mf-review | 85fa13b | Review's All repos chip, grouped diffs/navigator; git status parsed with `-z`; Discard all gated per step |
| escape-picker | b3dd9ac | Escape closes only the picker, not Review |
| os-drag-out (outcome C) | a0c636f | Explorer Copy puts real files on the Windows clipboard; stray drops can't navigate the window |
| e2e-fix | 1269ec0 | full-suite sweep: Caps Lock clipboard keys, Review navigator/measure anchoring, note-glyph landing, 8 test fixes |

## Blocked / not built

- **Resolved after v0.41.1 (fb2beac, unreleased):** the user did the S0 drags by hand. The results:
  native `startDrag` blocks the main process for the whole drag, and the host gate for
  `DownloadURL` drags works. The user chose VS Code parity (outcome B). One file per drag now goes
  out from the Files tree, tabs, Changes rows and search results, through a host-gated
  `DownloadURL`. Folders and multi-file selections still go out via Copy → paste. The original
  note follows.
- **Native drag-out of files and folders to the OS (os-drag-out slices A/A′/B).** The S0 spike needs a
  real-input (SendInput) driver to measure in-window drops, Ctrl and spring-open under
  `webContents.startDrag`; the session's permission classifier refused writing it twice. Copy → paste
  in Explorer ships instead. To unblock: allow the driver for one spike step, or run the ~1-minute
  mouse test yourself; the remaining slices are planned (`docs/plans/2026-09-24-os-drag-out.plan.md`,
  `docs/runs/2026-09-24-os-drag-out/s0-spike.md`).

## Decisions taken for you (override any)

Full list in the run ledger; the ones that change behaviour you'd notice:

- **Run /add-dir pastes `/add-dir <path>` and does not press Enter** — you press Enter in claude. A
  folder counts as seen only when claude prints "Added … as a working directory". Typing Enter blind
  answered a claude dialog in QA (once picked "No, exit" and claude quit). Deviates from the handoff's
  one-click flow.
- **Files tree no longer follows `cd`** — it shows the session's folders.
- **A missing home never spawns**, and an unresolvable launcher command disables Start (previously a
  node-pty failure). Bare `agents.json` commands now resolve to an absolute path — they never spawned
  on Windows before.
- Roots containing `" % & | < > ^ !` are skipped for `--add-dir` on `.cmd`/`.bat` launchers
  (BatBadBut); escaping is deferred to a security review.
- Board cards gained an optional read-only `ticket` field that's preserved on save.
- Discard / Stash / Pop are disabled in Review's All repos view.
- No ticket-key pill on project headers; card age, busy meter and Review diffstat dropped from cards.

## Incidents

- An executor ran `taskkill /PID 67856 /T /F` on a cmd.exe its own probe launched; the output said
  hundreds of processes couldn't be terminated. PID reuse can't be ruled out — **check your
  Claude/cmd sessions were intact on 2026-09-24**. Briefs since forbid `/T` tree kills.
- An executor `rm -rf`'d the shared `%TEMP%\claude-scratch` (another session's files may have gone).
  Briefs since use per-lane subdirectories.
- mf-live-edits QA against real claude accepted the folder-trust dialog for 3 temp folders, leaving
  harmless entries in `~/.claude.json`.

## Learnings

- Real-claude QA overturned a design every gate passed: focus-report bytes read as "busy", and a typed
  Enter answers whatever dialog is up. Probe the real TUI before designing input injection.
- On Windows a deleted watched directory loops at ~80k events/s and pins the directory — now a
  CLAUDE.md gotcha with `watchDir` as the only door.
- Non-ASCII paths broke porcelain parsing; `-z` + `--literal-pathspecs` everywhere a path meets git.
- The deferred full e2e sweep (user waiver: e2e only at the end) found 12 failures: 4 real product
  bugs (Caps Lock made Explorer Ctrl+C a no-op; Review navigator picks drifted as cards measured; a
  search reveal double-shifted; a note-glyph landing was dropped while Review was hidden) and 8 stale
  or racy tests. Two clipboard scenarios fail only while another process holds the Windows clipboard
  (`OpenClipboard` error 5); they pass alone on a quiet machine.

## Needs a human smoke

- Native drag-out (blocked above).
- Anything under a real mouse over `.topbar` (no e2e can see the app-region mask).
- Run /add-dir with your own claude version — the confirmation matcher is keyed to 2.1.282's wording.

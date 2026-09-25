---
status: shipped
date: 2026-09-23
---

# Feature Spec: New session dialog: launchers, project chip, folders (mf-new-session)

**Tier:** FULL   **Feature type:** UI, plus host work (launcher detection, use counter, probes)
**One-line request:** the New session dialog (handoff 9a). Launch pills ranked by use, `More ▾`
(PATH-detected CLIs and shells, `+ Custom command…`), a removable project chip, a Folders list
(home / attached, Make home, ×, `+ Add folder…`), a "Launches as" preview, Cancel / Start session.

Written in autonomous mode against `.autoloop/locked.md` (L1–L10). mf-model lands first. It owns
`Session.home/roots/projectId`, the Project store, `openRepo {roots, projectId}` and the L5
`--add-dir` adapter. This item owns the dialog, launcher detection, the use counter, custom
launchers, the folder probe and the preview. Would-be questions are recorded in §13.

## 1. Problem frame

- **Job:** start one agent session over one or more folders, in the right project, knowing what
  will run, in a few clicks. The motivating case is `room-message-bus` (edited) plus
  `bitbucket-ci-image` (reference) in one claude session.
- **Actors:** the user; the host, which owns launchers, usage, projects and sessions; and the
  callers that open the dialog prefilled (§3.1).
- **Success outcomes:**
  - A user with `claude` on PATH and no `agents.json` sees a `claude` pill. Starting it passes
    `--add-dir` for each attached folder. Today there is no such pill (§2.6).
  - The most-used launchers come first.
  - The preview is exactly `formatCommandLine(buildLaunchSpec(…))`, and `buildLaunchSpec` is the
    same function `term:start` spawns from.
  - The dialog opens with the project and folders that fit where it was opened from.
- **Non-goals:**
  - Folder edits on a running session (mf-files, mf-live-edits).
  - The sidebar + buttons (mf-sidebar) and board card UI (mf-board).
  - Codex and cursor-agent context notes (deferred by L5).
  - Changing agents.json semantics, and any agents settings UI.

## 2. Behavior & states

**Flow.**
1. Open the dialog. It seeds the launcher, project and folders (§3.1).
2. The user adjusts them. The preview refreshes on each change (host round trip, latest
   `requestId` wins).
3. Start posts `openRepo {path: home, agentId, roots, projectId, cardId?, requestId}` and waits for
   `openRepo:result`. On success it closes.

**Layout, top to bottom.** Copy is verbatim; sizes and colours come from 9a.
- Head: `New session`, with a faint mono `Esc` on the right. An optional subtitle below it (the
  board sets `Start a session for "<title>"`).
- `Launch` and the pill row.
- The project chip.
- `Folders` and a bordered list.
- `Launches as` and a dark preview.
- Footer: `Cancel` (`.btn`) and `Start session` (`.btn--primary`).

The `Terminal` SelectField, the recents `.repolist` and the pinned `Browse…` row are removed.
Recents and Browse now live inside `+ Add folder…`.

### 2.1 Launch row
- **Pills:** the top 3 non-shell launchers by rank (§3.3), then a pinned `Shell` pill as the 4th
  (D16). With no history on this machine the row is `claude`, `codex`, `Shell`, because
  cursor-agent isn't installed (§2.6).
  - `Shell` launches the *preferred shell*: `settings.defaultAgentId` if that is a shell, else the
    first detected shell. Usage is counted under that id.
- **Selected state:** the selected pill has the accent outline (white fill, accent border and
  text). If a launcher picked from More isn't in the row, it shows as an extra selected pill
  before `More ▾`, labelled with its own label, until the dialog closes. The `Shell` pill is
  selected only when the preferred shell is the pick.
- **More menu:** `More ▾` (dashed) toggles a `Popover` right-aligned to the button (`align:
  'end'`, width 210). `triggerRef` is the button, so a second click closes it.
  - Header: `Found on this machine`.
  - Rows: every launcher not in the row, in rank order, each labelled and tagged in faint mono:
    `PATH` (detected CLI), `shell`, `config` (agents.json) or `custom`.
  - Last row: an accent `+ Custom command…` behind a top border.
- **Custom command form (v1):** `+ Custom command…` closes the menu and opens an inline form
  under the row.
  - Fields: a mono `Command` input (placeholder `e.g. aider --model sonnet`) and an optional
    `Label`.
  - Buttons: `Add` and `Cancel`.
  - `Add` posts `launcher:addCustom`. Success selects the new launcher. An error shows inline
    under the input.
  - At 50 custom launchers the menu row reads `Custom launcher limit reached (50)` and is
    disabled.

### 2.2 Project chip
- **Set:** an accent-tint chip reading `in <name> ▼ ×`.
  - Clicking the body opens a start-aligned `Popover` below the chip. It lists `No project`,
    then the projects by `order` (the current one checked), then `+ New project…` behind a
    top border.
  - `×` (`aria-label="Remove from project"`) makes the session standalone.
- **Standalone:** a neutral dashed `No project ▼` chip opens the same dropdown (D6).
- **`+ New project…`:** the row becomes a `Project name` input. Enter confirms, Esc reverts.
  - The name is trimmed, must be non-empty, and is at most 80 characters.
  - A name that case-insensitively matches an existing project selects that project instead.
  - Otherwise the chip shows `in <name>` as pending. The project is created at Start (D7).

### 2.3 Folders list
- **Rows:** one per folder, in a bordered list.
  - Home row: a filled `--accent` dot, the basename, `path · branch` in mono, and an accent
    `Home` pill.
  - Attached row: a hollow dot, the same two lines, a neutral `Make home` and `×`.
  - Last row: a dashed top border and an accent `+ Add folder…`.
- **Order and home:**
  - The home row has `×` only when it is the only folder (D5).
  - `Make home` swaps the chosen folder with the old home, which becomes the first attached
    folder. Otherwise rows stay in the order they were added (L1).
  - The first folder added to an empty list becomes home.
- **`+ Add folder…`** opens a `Popover`:
  - `Recent`: up to 10 repos.json folders not already listed. Each shows name plus faint mono
    path, left-truncated like `.repo__path` with LRM bookends. With none, a faint
    `No recent folders` shows.
  - `Browse…`, which posts `folder:pick`.
  - The list is capped at 32 folders. At the cap, the Add row reads `Folder limit reached (32)`
    and is disabled.
- **Branch:** comes from `folder:probe`.
  - The path shows alone until the probe returns.
  - A folder that isn't a repo shows the path only.
  - A detached HEAD shows the short sha.
- **Not found** (a prefilled folder that no longer exists): the row gets a warn `Not found` tag.
  - `Make home` is hidden on that row; `×` stays.
  - The folder is still sent in `openRepo.roots` (D17). The host then marks it `missingRoots`
    and leaves it out of `--add-dir` (L9).
  - A missing home disables Start with `Home folder not found`.
- **Conflicts:** comparison uses `normalizeRoot` (`src/review-marks.ts`, the key mf-model uses) through one pure `folderConflict` in `src/`.
  - An exact duplicate adds nothing and briefly highlights the existing row.
  - A folder inside, or containing, a listed folder is refused inline with
    `Already covered by <name>` or `Contains <name>` (D9).

### 2.4 Launches as
- **Look:** a dark box (`--term-bg`, `--term-surface`) in mono. A faint `<cwd>>` prompt, then the
  command's basename without `.exe`/`.cmd`/`.bat`, then the args. Flags starting `--` are tinted
  accent. The text wraps and never scrolls sideways. `title` holds the full resolved command
  path.
- **Source:** the text is exactly `launch:previewResult.display`; the renderer only tints flags.
  - While a request is in flight, the last value stays, dimmed.
  - `error` shows `Can't resolve <label>: <reason>`, faint, and disables Start with the same
    copy. `error` is a token (`home-missing` | `unknown-launcher` | `unresolvable` |
    `invalid-request`) the renderer maps to copy. The host never spawns an unresolved command:
    `buildLaunchSpec` resolves the launcher's command once and both the preview and
    `term:start` use that absolute path (fix1, QA F1 — node-pty on win32 cannot start a bare
    `claude` that is really `claude.cmd`; this was already broken before this item).
  - While a request is in flight Start is disabled (`Checking the command…`); a timed-out
    request clears the stale result.
  - With no folders it reads `Add a folder to see the command`. The homedir fallback in
    `resolveLaunchSpec` can't show here, because a missing home disables Start.

### 2.5 States
- `closed → seeding`: the seed is computed synchronously, once. Rescan, probe and preview are
  requested.
- `seeding → editing`. `editing ⇄ form-open` (custom command or new-project input).
- `editing → starting`: one `project:create` round trip if a project is pending, then `openRepo`.
- `starting → closed` on `openRepo:result {sessionId}`.
- `starting → editing` on an error or a 5 s timeout, with inline copy: `Couldn't create project`
  on the chip, or `Couldn't start session: <reason>` above the footer.

### 2.6 Current behavior (measured 2026-09-23)

| Claim | How measured | Status |
|---|---|---|
| The real profiles (`%APPDATA%\{Conduit (dev),conduit,agent-deck}`) have **no agents.json**, and every recent has `lastAgentId: "shell:powershell"`. So there is no claude/codex pill. | `ls`/`cat` of the three dirs | Measured |
| On PATH: `claude.exe` in `~\.local\bin`, `codex.exe` in `AppData\Local\Programs\OpenAI\Codex\bin`. No `cursor-agent`. | PATH-dir listing | Measured |
| `@lydell/node-pty` spawns a `.cmd` directly, and an arg with spaces arrives quoted (`--add-dir "D:\a b\c"`). | Scratch `pty.spawn(stub.cmd, …)` under Node 24 | Measured on Node. Electron build ASSUMED (D3). |
| The registry is built once from `detectShells()` and agents.json (`main.ts:1107`, `const`, passed into `SessionManager`). `AgentRegistry.agents` is `readonly`. `DEFAULT_AGENTS=[]`. | Source read | Inferred |
| `openRepo` silently substitutes `registry.list()[0]` for an unknown agentId and has no reply. | `main.ts:1805-1830` source | Inferred |
| The dialog's `Enter` is a window keydown listener that fires from any focus. Browse uses `showOpenDialog` with no e2e seam. | Source, e2e grep | Inferred |

## 3. Data / interface contract

### 3.1 Prefill
This item owns app.tsx's `newSession` state and gives it its final shape. mf-sidebar's
`projectId?` is a subset of it, and mf-board's §3.3 shape matches it.
```ts
interface NewSessionPrefill {
  agentId?: string;
  projectId?: string | null; // undefined → derive; null → standalone
  home?: string;             // replaces today's `path`
  roots?: string[];          // ignored without home
  cardId?: string;
  cardTitle?: string;
}
```
`seedNewSession(prefill, ctx)` is pure and lives in `src/`. `ctx` is the active session,
sessions, projects, repos, agents and settings. It returns
`{agentId, projectId: string|null, home?: string, roots: string[]}`:
- **projectId:** the prefill's value, if it names a live project. Otherwise
  `projectForNewSession(active, projects)`, which is mf-sidebar's helper, **pinned to `src/`**
  so the host tsconfig can import it (D18).
- **Folders:**
  1. `prefill.home` and `prefill.roots`. Missing ones are kept.
  2. Else the most recently active session in that project: its home and roots.
  3. Else `repos[0]`, as today.
  4. Else empty.
- **agentId:**
  1. `prefill.agentId`, if registered.
  2. Else the home's `lastAgentId` in repos.json.
  3. Else `settings.defaultAgentId`.
  4. Else the first detected shell. This is today's `agents[0]`, deliberately a shell
     (`main.ts:1106`).

  The pick follows home changes until the user picks a pill in this dialog; from then on it
  sticks (D13).

| Caller (in this repo today) | Prefill |
|---|---|
| Header +, Ctrl+N, command palette, empty-state New session | `{}` (mf-sidebar later passes `projectId`) |
| Board card menu "Start session for this card" (`app.tsx:3518`) | `{home: active.home, roots: active.roots, projectId: active.projectId ?? null, cardId, cardTitle}`. mf-board replaces this with its last-session prefill (its §3.3). |
| Explorer `Open as new session` | `{home: dir}` (project derived) |
| Omni-bar agent result | `{agentId}` |

The group-header + (mf-sidebar) passes `{projectId}`.

### 3.2 Messages (all host-validated)
```ts
// renderer → host
| { type: 'openRepo'; path: string; agentId: string; roots?: string[]; projectId?: string | null;
    cardId?: string; requestId?: number }            // requestId: additive to L3 (D19)
| { type: 'launchers:rescan' }                        // on each dialog open
| { type: 'launcher:addCustom'; requestId: number; commandLine: string; label?: string }
| { type: 'folder:pick'; requestId: number }
| { type: 'folder:probe'; requestId: number; paths: string[] }   // ≤ 16 per message; batch
| { type: 'launch:preview'; requestId: number; agentId: string; home: string; roots: string[] }
// host → renderer
| { type: 'openRepo:result'; requestId: number; sessionId?: string; droppedRoots?: string[]; error?: string }
| { type: 'launcher:added'; requestId: number; id?: string; error?: string }
| { type: 'folder:picked'; requestId: number; path: string | null }
| { type: 'folder:probeResult'; requestId: number;
    results: { path: string; exists: boolean; branch?: string; detached?: boolean }[] }
| { type: 'launch:previewResult'; requestId: number; cwd?: string; command?: string;
    args?: string[]; display?: string; error?: string; unsafeArg?: string }
// state gains (labels still come from state.agents; this is agents + usage, joined by id)
launchers: { id: string; kind: 'cli' | 'shell' | 'config' | 'custom'; uses: number; lastUsed?: number }[]
```
- **`openRepo`:** when `requestId` is set, the host replies with `sessionId`. It replies with
  `error` instead of silently substituting when the agentId is unknown, a root fails validation,
  or the `projectId` is dangling. Callers without a `requestId` keep today's behavior.
- **`browseRepo`** and its handler are **deleted**; the old dialog was its only caller. Fallow
  gates the leftovers.
- **`folder:pick`:** calls `showOpenDialog({properties:['openDirectory'], title:'Add a folder'})`
  parented to the sender window.
  - **E2E seam:** under `CONDUIT_E2E=1`, `global.__pickDirHook = {queue(paths: (string|null)[])}`.
    Each queued entry answers one pick. With an empty queue the real dialog shows, so a
    scenario must queue first. Same pattern as `__osOpenColdHook`.
- **`folder:probe`:** rejects a path that is not absolute, contains `.`/`..` segments, or is
  longer than 4096 characters (`exists:false`). Then `fs.stat`, then, **only via `runGitBin`**,
  `rev-parse --abbrev-ref HEAD` with a 2 s timeout. `HEAD` → `rev-parse --short HEAD` with
  `detached: true`. Paths outside the write roots are allowed: the probe is read-only and only
  returns a branch name.
- **`launch:preview`:** runs the same path checks, then `buildLaunchSpec({registry, agentId,
  home, roots, exists})`. That function is `resolveLaunchSpec` plus the L5 adapter over the
  roots that exist, and it is the single function `term:start` spawns from (D15).
  `display = formatCommandLine(spec, process.platform)`, without the cwd-reporting
  augmentation (D8).
- **`launcher:addCustom`:**
  - `splitCommandLine(line, platform)` splits on the host's platform.
    - win32 follows CommandLineToArgvW rules: `"` groups; a backslash is literal except in runs
      before a `"`. So `C:\tools\aider.exe --x` survives.
    - posix: `'…'` is literal, `"…"` groups, and a backslash escapes outside single quotes.
  - Rejections:
    - empty input, or longer than 1024 characters;
    - a command that is not an existing absolute path and does not resolve with `which()`
      (win32: `.exe`, `.cmd`, `.bat`) → `Can't find "<cmd>" on PATH`;
    - the 51st custom launcher.
  - Persisted: `{id: 'custom:' + slug(label), label (default: the command's basename),
    command: <resolved absolute path>, args, icon: 'terminal', color: 'green',
    cwdStrategy: 'workspaceFolder'}`. The slug gets a `-2`… suffix if taken; a taken label
    gets ` (2)`.
  - The command is not re-resolved later. If it vanishes, the preview shows the error.

### 3.3 Launcher detection, ranking, persistence (host)
- **`detectAgentClis()`** lives in `src/shells.ts` and shares `which`/`toDef` with the shell
  detection. It uses the same `AgentDefinition` fields as shells (`icon: 'terminal'`, `color`,
  `cwdStrategy: 'workspaceFolder'`), with args `[]`.

  | Id | Label |
  |---|---|
  | `cli:claude` | `claude` |
  | `cli:codex` | `codex` |
  | `cli:cursor-agent` | `cursor-agent` |
  | `cli:gemini` | `gemini` |
  | `cli:aider` | `aider` |
  | `cli:opencode` | `opencode` |

  - **win32:** in each PATH dir, try `.exe`, then `.cmd`, then `.bat`. Never `.ps1` (not
    CreateProcess-able) or extensionless (npm's sh shim).
  - **Unix:** the bare name with `X_OK`, plus `~/.local/bin`, `/opt/homebrew/bin`,
    `/usr/local/bin`, `~/.npm-global/bin` and `~/.bun/bin` (D4).
- **Shadowing:** when an agents.json entry's command basename (extension dropped) matches a
  detected CLI, the agents.json entry wins and the detected entry is hidden. `registry.get(
  'cli:<name>')` then **aliases** to it, so persisted sessions, usage and repos.json
  `lastAgentId` still resolve (D20).
- **Registry:** order is shells, detected CLIs, agents.json, custom. `AgentRegistry` gains
  `replace(defs)` and mutates in place, so `SessionManager` and the `resolveSpec` closure keep
  their reference. `launchers:rescan` re-runs both detections and posts state only when the set
  changed. A restored session whose launcher is gone falls back to a shell, as today.
- **Batch-file safety (win32, BatBadBut):** when the resolved command ends in `.cmd` or `.bat`,
  CreateProcess routes the args through cmd.exe's parser. `buildLaunchSpec` therefore refuses
  any arg containing `& | < > ^ % ! " ( )` or a newline. `term:start` falls back to *not
  launching* and shows the error in the terminal. The preview returns `unsafeArg: <the arg>`,
  and the dialog disables Start with `<label> is a .cmd shim and can't take "<folder>" (contains
  <char>). Rename the folder or use an .exe install.` `.exe` targets are unaffected, and claude's
  native install is `.exe` (§2.6). This applies to custom launchers too. (D3)
- **Usage:** host-owned `userData/launchers.json`, shaped
  `{ version: 1, usage: Record<agentId, {count, lastUsed}>, custom: AgentDefinition[] }`. It gets
  the same atomic write and before-quit flush as repos.json. A bad file reads as empty.
  `openRepo` increments `usage[agentId]` on every host creation. Duplicate and relaunch don't.
- **Ranking:** `rankLaunchers(agents, launchers, preferredShellId)` is pure. It sorts by uses
  (desc), then lastUsed (desc), then canonical order: the CLI table, then agents.json order, then
  custom. `Shell` is pinned, so ranking only orders non-shells and More.
- **repos.json:** `openRepo` upserts home with `lastAgentId`, and each attached folder without
  touching its `lastAgentId` (D14).

### 3.4 Producers / consumers

| Data | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Launch argv | `buildLaunchSpec` (L5 adapter from mf-model, extracted here if session-bound) | `term:start` spawn; `launch:preview` | Yes: one function |
| `openRepo {roots, projectId, requestId}` | this dialog | mf-model handler, plus this item's `openRepo:result` reply | Handler: mf-model. The reply and the usage bump are here. |
| `launchers[]` and the registry set | host | dialog; omni-bar Agents; Settings default terminal; session glyphs | Yes. `AgentDefinition` shape is unchanged. |
| repos.json | `openRepo` (now also writes attached folders) | `Recent`; `plainShellTarget` / `lastSessionTarget` | Yes. Attached upserts never set `lastAgentId`. |
| `NewSessionPrefill` | the callers in §3.1 | `seedNewSession` | In-repo callers: yes. The group + (mf-sidebar) and mf-board's prefill: **no**. They pass this documented shape and are unit-covered through `seedNewSession`. |
| Projects | Project store (mf-model) | chip; `project:create` at Start | Yes |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Start double-click, or Enter held | `starting` ignores repeats; only one `openRepo` goes out. |
| Enter inside an input, popover or button | That control handles it. The dialog's Enter fires only from the frame or a pill. |
| No launcher at all | The row reads `No terminals found`; Start is disabled. |
| Zero folders / one folder / 32 folders | Zero: only Add, Start disabled. One: home × shown. 32: Add disabled. |
| Many folders | The list scrolls inside a bounded height. Probes go out in batches of 16. |
| Browse cancelled | `path: null`; nothing changes. |
| Probe slow, git missing, or timeout | The path shows without a branch. Nothing blocks. |
| Preview replies out of order | Only the latest `requestId` is applied. |
| Project deleted while the dialog is open | The chip falls back to standalone. |
| `openRepo:result` error or timeout | The dialog stays open with the reason. |
| Launcher removed from PATH after detection | The preview shows the error and Start is disabled; a relaunch prints `— can't start: <cmd> not found —` instead of spawning. |
| Folder name with `&` or `%`, using a `.cmd` launcher | `unsafeArg`; Start disabled (§3.3). |
| State updates mid-edit | The seed is not recomputed. Ids are only re-validated. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Row | 3 ranked + pinned `Shell` | No | The mock; Shell is always one click away. |
| CLI table | 6 names | No (agents.json and custom cover the rest) | A cheap, predictable scan. |
| Initial launcher | prefill → home's last → `defaultAgentId` → first shell | Via `defaultAgentId` | Keeps today's remember-per-repo and the shell-first fallback. |
| Initial project | from the caller; else the active session's | No | Handoff 11a. |
| Project creation | at Start | No | Cancel leaves nothing behind. |
| Limits | 10 recents, 32 folders, 50 custom launchers | No | Keeps lists bounded. |

## 6. Scope slicing
- **MVP:**
  - The §2 layout: pills, More and ranking; CLI detection with the alias; usage counting.
  - The chip, including New project.
  - Folders: probe, Make home, ×, Add folder (Recent and Browse).
  - The host preview, the batch-file guard and `openRepo:result`.
  - The in-repo callers rewired; `browseRepo` deleted; the e2e seam.
- **v1:** `+ Custom command…`, and a `×` to delete a custom launcher in More.
- **Vision:** filtering in Recent; reading the live Windows registry PATH on rescan.
- **Out of scope:** codex and cursor-agent context notes; editing agents.json; running-session
  folder edits.

## 7. Acceptance criteria

**Declarative**
1. With a stub PATH containing `claude.cmd` and a fresh userData without agents.json, the row is
   `claude`, `codex`, `Shell`.
2. After 3 codex and 1 claude `openRepo`, the row order is `codex`, `claude`, … `Shell`: the same
   members, reordered.
3. More's right edge is within 1px of the button's right edge. It lists the non-row launchers
   with tags, ends with `+ Custom command…`, and a second click closes it.
4. The preview's text equals `display` for the same inputs, and the spawned stub receives
   exactly one `--add-dir <path>` per existing attached folder.
5. Removing the chip creates the session with no `projectId`; picking a project stamps its id.
6. Make home swaps home with the first attached folder, and the preview cwd changes to match.
7. The four in-repo callers in §3.1 seed as tabulated (e2e for explorer and board card menu;
   unit tests for the rest).
8. With a `.cmd` launcher and an attached folder named `a&b`, Start is disabled with the
   batch-file message, and nothing is spawned.
9. Setting agents.json to `{id:'my-claude', command:'claude'}` hides `cli:claude`, and a session
   persisted with `cli:claude` launches `my-claude`.
10. `npm run verify` is green. Unit tests cover `seedNewSession`, `rankLaunchers`,
    `detectAgentClis` (injected fs and PATH; `.exe`/`.cmd`/`.bat`; no `.ps1`; shadow alias),
    `splitCommandLine` (win32 backslashes, quotes; posix escapes), `formatCommandLine`,
    `buildLaunchSpec` (including the metacharacter refusal), `folderConflict`, and launchers.json
    parse and serialize.

**EARS**
- WHEN the dialog opens, the renderer SHALL post `launchers:rescan`, probe every folder, and
  request a preview.
- WHILE Start is in flight, the dialog SHALL ignore further Start activations.
- IF the home is missing, THEN Start SHALL be disabled with `Home folder not found`.
- WHEN the first folder is added to an empty list, it SHALL become home.
- IF a `.cmd`/`.bat` target would receive an arg containing a cmd metacharacter, THEN the host
  SHALL NOT spawn it.

**Gherkin: `test/e2e/new-session-folders.e2e.mjs`**

Setup:
- Hidden launch with a fresh userData.
- `env.PATH` = a temp stub dir plus System32. The stub dir holds `claude.cmd` and `codex.cmd`,
  which print `STUB-ARGS:%*` and pause. `detectShells` finds PowerShell by its explicit path.
- Folders: A is `git init` on `main`; B is plain; C is named `x&y`.
```gherkin
Scenario: multi-folder claude session in a project
  Given a project "RMB pipeline"
  When I open New session from the header +
  Then the Launch row is "claude", "codex", "Shell"
  When I queue A then B on __pickDirHook and use "+ Add folder…" → "Browse…" twice
  Then A is the Home row with "· main" and B is attached with "Make home" and "×"
  And "Launches as" reads "<A>> claude --add-dir <B>"
  When I pick "RMB pipeline" in the chip dropdown and click "Start session"
  Then the new session has home A, roots [B], that projectId and agentId "cli:claude"
  And its terminal prints "STUB-ARGS:--add-dir <B>"

Scenario: More toggles; ranking follows use
  Given codex was started 3 times
  When I open New session
  Then the first pill is "codex"
  And "More ▾" opens "Found on this machine" on the first click and closes it on the second

Scenario: batch-file guard
  When I attach C with claude selected
  Then Start is disabled and the message names "x&y"

Scenario: board card prefill
  Given the active session has home A, roots [B] and a card "Move RMB to CI"
  When I choose "Start session for this card" in the card menu
  Then the subtitle names the card, the folders are A and B, and Start stamps the cardId
```
- **Retired:** `new-session-browse-pinned.e2e.mjs`, whose subject no longer exists.
- **Rewritten:** `explorer-open-as-session.e2e.mjs:109`. It asserted `.repo--active .repo__path`,
  and must now assert the Home row's path.
- Run: `node test/e2e/run-smoke.mjs new-session-folders`.

## 8. State catalog (UI)

| Component | States (what the user sees) |
|---|---|
| Pill row | populated; extra selected pill; `No terminals found` |
| More | closed; open; custom limit reached |
| Custom form | idle; validating (Add disabled); inline error |
| Chip | set `in X ▼ ×`; pending `in X`; standalone `No project ▼`; create failed |
| Folders | empty (Add only); populated; probing (no branch); `Not found`; conflict hint; at cap |
| Add folder menu | recents and Browse; `No recent folders` and Browse |
| Preview | placeholder; dimmed while loading; ready; faint error; unsafe-arg message |
| Footer | enabled; disabled with reason; starting; start failed |

## 9. Interaction inventory (UI)

| Component | Pointer | Keyboard | ARIA |
|---|---|---|---|
| Pills | click | Arrows move and select (roving tabindex) | `radiogroup` `aria-label="Launch"`; `radio` with `aria-checked` |
| More | toggle | Enter/Space opens; arrows; Esc closes and refocuses the button | `aria-haspopup=menu`, `aria-expanded`. Launcher rows `menuitemradio`; `+ Custom command…` is `menuitem`; the header is a `group` label |
| Chip | body opens; × removes | Enter opens; Delete on the chip = × | `aria-label="Project: <name>"`; × `aria-label="Remove from project"` |
| Folder rows | buttons | Tab | `list`/`listitem`; `aria-label="Make <name> home"`, `"Remove <name>"` |
| Add folder | opens menu | Enter; arrows | `aria-haspopup=menu`. `Recent` is a `group`; each recent and `Browse…` is a `menuitem` |
| Dialog | Cancel / outside click | Esc closes the innermost popover first; Enter = Start (scoped) | `dialog`, `aria-modal`, `aria-labelledby` |

There is no drag. The dialog goes through `ModalLayer` and the menus through `Popover`. Both
declare `-webkit-app-region: no-drag`; extend `test/unit/drag-region.test.ts` to cover them.

## 10. Accessibility & i18n (UI)
- **Focus:**
  - On open: the selected pill.
  - After adding a folder: that row's first button.
  - After ×: the next row, or Add.
  - When a popover closes: its trigger. When the form closes: `More ▾`.
- **Not colour-only:** `Home` is a text pill as well as a dot. `Not found` is text. The
  selected pill has `aria-checked` as well as a border.
- **Live region** (`polite`) announces `Added <name>`, `<name> is now home`, `Removed <name>`
  and start errors. The preview is not live.
- A disabled Start's reason is linked through `aria-describedby`. The focus ring survives
  forced-colors.
- **i18n:** the repo has no i18n layer, so copy stays in the component (D10). There are no
  plurals; limit copy shows the number. Paths are mono with LRM bookends. Pills and the chip wrap,
  and the command is never truncated. RTL isn't supported app-wide.

## 11. Design tokens (UI)
- Colour: `--accent` (selected pill, Home pill and dot, chip, Add rows, flag tint), `--warn`
  (Not found), `--bad` (errors), the muted and faint text tokens, and `--term-bg` /
  `--term-surface` for the preview. No hex; Neon follows from the tokens.
- Reuse `.modal`, `.btn`, `.btn--primary`, `.repo__path`, the Popover and ContextMenu item
  classes, and `IconPlus`, `IconFolder` and `IconChevronDown`.

## 12. Assumptions
- mf-model's `openRepo` (its spec §3) drops and logs an invalid root but still creates the
  session, and keeps missing paths as `missingRoots`. `openRepo:result` therefore also carries
  `droppedRoots?: string[]`, shown as a toast (`Skipped <name>: not a valid folder`) once
  the session opens. `project:create` replies with `{requestId, id}`.
- `Popover`'s `triggerRef` excludes the trigger from outside-mousedown, so a second click
  toggles it closed.
- **Accepted trust:** `launcher:addCustom` gives the renderer a persisted "run this command"
  primitive. That is equivalent to typing into a PTY, which the renderer can already do. The
  probe and preview read outside the write roots, but only read (stat and branch name).

## 13. Decisions Needed
Over the ~400-line budget because of these twenty entries and the §3 contract they drive.
- **D1 [normal] Detected CLIs become launchable how?** Picked: `cli:<name>` definitions merged
  into the registry at runtime. **agents.json is never written**, because it is user-owned.
- **D2 [normal] Where does the use counter live?** Picked: `userData/launchers.json`, which also
  holds custom launchers, bumped in `openRepo`. Not settings.json, which holds preferences.
- **D3 [high] `.cmd` shims.** A direct spawn worked on Node 24. Electron is ASSUMED to match; the
  e2e stub proves it.
  - Batch targets pass args through cmd.exe (BatBadBut), so any arg containing a metacharacter
    is refused rather than escaped (§3.3).
  - If escaping is wanted later, it needs its own security review.
  - If a direct spawn fails under Electron, wrap with `%ComSpec% /d /s /c` and keep the same
    refusal.
- **D4 [normal] macOS/Linux GUI PATH.** Picked: probe the well-known user bin dirs. No
  login-shell PATH import.
- **D5 [normal] Home ×.** Picked: shown only when home is the only folder, as the mock shows.
- **D6 [normal] Standalone chip.** The mock has none. Picked: a dashed `No project ▼`.
- **D7 [normal] New project timing.** Picked: create at Start.
- **D8 [normal] Preview for shells.** Picked: omit the internal cwd-reporting augmentation.
- **D9 [normal] Nested folders.** Picked: refuse them, via a shared pure `folderConflict`.
- **D10 [normal] i18n.** Picked: follow the repo; no externalisation.
- **D11 [normal] `+ Custom command…`.** Picked: a persisted, host-validated custom launcher.
  It must survive restore and relaunch. It is not a one-off command and not an agents.json
  editor.
- **D12 [normal] Recents and Browse.** Picked: moved into the `+ Add folder…` menu. E2E uses
  `__pickDirHook`.
- **D13 [normal] Launcher follows home.** Picked: until the user picks a pill, then it sticks.
  Today it re-follows on every change.
- **D14 [normal] Attached folders enter recents,** without `lastAgentId`.
- **D15 [normal] Adapter composition.** mf-model specifies a pure `launchArgsFor(def, roots,
  platform)`. `buildLaunchSpec` = `resolveLaunchSpec` + `launchArgsFor` over present roots, and
  `term:start` is switched to call `buildLaunchSpec` so preview and spawn cannot diverge.
- **D16 [normal] Shell pinned as the 4th pill.** Otherwise installed gemini, aider or agents.json
  entries would push it into More.
- **D17 [normal] Missing prefilled roots.** Picked: kept and sent in `openRepo.roots`, and the
  host marks them missing (L9). **mf-board §3.3 says "filtered as the dialog normally does"**:
  it should pass them through unfiltered and let this dialog show `Not found`.
- **D18 [normal] `projectForNewSession` placement.** Pinned to `src/`. mf-sidebar left it to the
  planner, and `seedNewSession` in `src/` needs it.
- **D19 [normal] `openRepo` gets an optional `requestId` and an `openRepo:result` reply.** This
  extends L3 additively. Without a requestId the host behaves as today.
- **D20 [normal] Shadowed detected CLI.** Picked: `cli:<name>` aliases to the agents.json entry
  that shadows it, so persisted ids, usage and `lastAgentId` keep resolving.

---
status: active
date: 2026-10-26
---

# Feature Spec: Role brief at launch

Builds on [conduit-mcp-server](2026-10-25-conduit-mcp-server.md) (adapters, §3.1 launch wiring).
**Tier FULL, feature type UI** (New session dialog) **+ host** (launch args, brief store).
Self-hosting backlog item 1b.

> **S0 outcome (2026-10-26, [s0.md](../runs/2026-10-26-role-brief/s0.md)); edits applied below.**
> `--` + prompt last works for all three CLIs and Claude needs it, so `--` is used uniformly and
> the no-`--` fallback is gone (§3.2). Read access (D1, ruled): Claude `--add-dir <briefDir>`
> (silent read); Codex reads in place and asks once to approve the read, which is accepted; Cursor
> reads in place silently. Codex gets no `--add-dir` (it would make the dir writable). The §2.1
> ASSUMED rows are confirmed. The prompt survives Claude's and Cursor's trust dialogs; Codex showed
> none. Claude loaded no `CLAUDE.md` from the brief dir, so the dir is not made read-only (§12.6).
> D2–D6 take their defaults. Plan: [role-brief plan](../plans/2026-10-26-conduit-role-brief.plan.md).

## 1. Problem frame

A worker CLI acts on a peer agent's message only when its own human has told it to. That authority
can't come from another agent. Today the human pastes a role brief into every team manager by hand
after each launch.

- **Job:** the human sets a session's role once, when the session is created, and the CLI starts
  its first turn already holding that brief.
- **Actors:** the human (writes the brief in `agents.json` or the New session dialog), the host
  (stores the brief, builds the launch), the CLI (reads the brief file on its first turn).
- **Success:** a session created with a brief starts with a first user turn of exactly
  `Read your role brief at <path> and follow it.`, the CLI reads `<path>` (Claude and Cursor with
  no approval prompt; Codex after one read approval the human gives, S0-2 / D1), and no later
  launch of that session repeats the turn.
- **Non-goals:**
  - Re-sending or editing a brief after first launch. The file stays, so the human can type
    "re-read your brief".
  - Session resume (item 2). This spec only promises that a brief is never re-sent.
  - Briefs for CLIs without a known initial-prompt argument (shells, aider, gemini, …).
  - Any way for an agent to set or change a brief over MCP (§3.4).
  - Defending against an agent that can already write `userData` (it can rewrite `agents.json`
    args today; same trust level).
  - A Settings editor for agent definitions (D5).

## 2. Behavior & states

### 2.1 Current behavior

| Claim | How measured | Status |
|---|---|---|
| `claude` 2.1.310: `Usage: claude [options] [command] [prompt]`. `--add-dir <directories...>`, `--mcp-config <configs...>` and `--allowedTools <tools...>` are variadic. | `claude --help` | Measured |
| `codex` 0.164.0: `codex [OPTIONS] [PROMPT]`. `-i/--image <FILE>...` is variadic. `--add-dir` makes a dir **writable**. | `codex --help` | Measured |
| Cursor `agent` 2026.10.22-27dcf5f: `agent [options] [command] [prompt...]` (variadic prompt). `--add-dir <path>` is repeatable. The selfhost profile launches it through `agent.cmd`, a batch file, so the cmd metachar guard applies. | `agent.cmd --help`, `--version`, selfhost `agents.json` | Measured |
| Host MCP args are appended **after** the definition's args and the `--add-dir` roots, so a positional appended after them would be read as a flag value. | `src/mcp-launch.ts`, `electron/conduit-mcp-host.ts` (`args: [...spec.args, ...wiring.args]`) | Confirmed (S0 source check) |
| A new session's first spawn, Relaunch, `session:restart` and an app-start restore all cold-spawn through `term:start` → `buildLaunchSpec` → `pty.start`. A window move takes the attach path and never spawns. | `electron/main.ts` `term:start` | Confirmed (S0 source check) |
| `agents.json` is read once at startup, and no Settings UI edits agent definitions. | `loadAgents` call site; grep of `settings-modal.tsx` | Confirmed (S0 source check) |

S0 (§12, [s0.md](../runs/2026-10-26-role-brief/s0.md)) measured the CLI behavior.

### 2.2 Flow

1. **Create.** The human starts a session in the New session dialog, or through a path with no
   dialog (§2.4). The host resolves the brief source: the dialog's choice, else the agent
   definition's `brief`. It **pre-mints the session id** through a new `id` option on
   `SessionManager.create` (and on `duplicate`). It then writes the **canonical** copy
   `<userData>/brief-store/<id>.md` synchronously, and only after that calls `create` with
   `brief: 'pending'`. So the session never exists without its brief. If the write fails, or
   `openRepo` fails after the write, the canonical file is deleted before replying. In the dialog
   path a failure means no session is created.
2. **Every spawn** (§3.3): right before `pty.start`, the host **re-materializes** the exposed dir.
   It empties `<userData>/briefs/<id>/` and copies the canonical file to
   `<userData>/briefs/<id>/brief.md`. Whatever an agent wrote there (an edited brief, a planted
   `CLAUDE.md`) never survives into the next launch.
3. **First spawn.** At `term:start`, if `brief === 'pending'`, the host adds the adapter's brief
   args (§3.2). After `pty.start`, if `pty.isAlive(id)` is true it moves `pending → sent` and
   writes sessions.json immediately. (`PtyHost.start` catches spawn errors and doesn't throw, so
   `isAlive` is the success signal.) That is the whole send: the brief is never typed into the
   PTY.
4. **Every later spawn** (Relaunch, `session:restart`, restore, a crash relaunch) sees `'sent'` and
   adds no prompt. It still gets the read access from §3.2, so the agent can re-read the file
   after compaction.

### 2.3 Session brief states

| `session.brief` | Meaning | Next spawn |
|---|---|---|
| absent | no brief | nothing added |
| `pending` | canonical file written, prompt not yet passed to a live CLI | prompt + read access; → `sent` if the PTY is alive after `pty.start` |
| `sent` | the prompt was on a launched command line | read access only |

- A spawn that is refused (`can't start`, home missing) or that leaves no live PTY stays `pending`,
  so the next successful spawn sends.
- Terminal outcomes that **clear** `brief` (→ absent), each with one dim banner (§4): the
  canonical file is missing at spawn, or the cmd guard trips (§3.2). Neither cause goes away on a
  retry.
- `sent` means the CLI was **launched** with the prompt, not that it read the file. A CLI that
  dies first (auth failure, trust dialog refused) isn't re-sent. The human types "read your role
  brief" (D3).

### 2.4 Creation paths

| Path | Brief source |
|---|---|
| New session dialog (incl. board `+ Start session` and Ctrl+N, both of which open it) | the dialog's choice (§8) |
| Second-instance / OS-open folder (`openRepo` with `registry.list()[0]`) | the agent definition's `brief`, if any |
| Duplicate | a copy of the source's **canonical** file (never the exposed one), `pending` (D4); if the copy fails, the duplicate is created without a brief and shows a banner |
| Restore at app start | no change; the persisted state applies |

The plan enumerates every `mgr.create` call site and assigns each one a row. A creator not listed
here gets no brief.

## 3. Data / interface contract

### 3.1 `agents.json` field

```jsonc
{ "id": "claude", "command": "…/claude.exe", "args": [...],
  "brief": "You are the Claude team manager. …" }            // inline text
{ "id": "codex", …, "brief": { "file": "C:/team/codex-manager.md" } }   // file, snapshotted
```

- `brief?: string | { file: string }`. A relative `file` resolves against the folder that holds
  `agents.json`. `~/` expands to the home dir.
- Valid shapes are exactly a string, or an object whose only key is `file` with a non-empty string
  value. Anything else (`{}`, `{ file: 1 }`, `{ file, x }`, a number) drops **the brief, not the
  agent**, and logs `agents` warn once at load.
- `brief` on a definition whose adapter has no initial prompt (§3.2) is ignored with one warn.
- The file is read at **session creation**, not at load and never live (D2).

### 3.2 Brief args per adapter

The prompt is the fixed string `Read your role brief at ${briefFile} and follow it.`, with
`briefFile` the native absolute path. A new optional adapter field `brief` in
`src/conduit-mcp/adapters.ts` describes:

| Adapter | Read access (every launch while the file exists) | Prompt (pending only) | Placement |
|---|---|---|---|
| claude | `--add-dir <briefDir>` | `-- <prompt>` | read access after the root `--add-dir`s; `--` + prompt are the **last** argv entries, after `--mcp-config`/`--allowedTools` |
| codex | none: reads in place; Codex asks once to approve the `Get-Content` (S0-2, accepted by D1). Never `--add-dir`, which makes the dir writable | `-- <prompt>` | last |
| cursor | none: reads in place with no approval (S0-3) | `-- <prompt>` | last |
| fake (e2e) | none | `-- <prompt>` | last |
| any other | — | — | no brief support; UI hides the section |

- `--` ends option parsing, so neither the variadic flags nor the definition's own args can swallow
  the prompt. S0-1: all three CLIs accept `--` + prompt last. Without it Claude's trailing
  `--allowedTools` ate the prompt; Codex and Cursor kept it either way. `--` is used for every
  adapter, and there is no fallback placement.
- `briefDir = <userData>/briefs/<sessionId>/`, one per session, so `--add-dir` exposes only this
  session's brief.
- The brief `--add-dir` is **not** a session root. It is never in `launchedRoots` and never feeds
  the agent-scope banner ("claude can't see …").
- **Cmd guard:** if `batchGuarded` and the prompt or `briefDir` contains a cmd metachar, the brief
  is dropped: no prompt, no read flag, `brief` cleared (terminal: `userData` won't change), and one
  banner names the char (§4). The rest of the launch is unchanged. The dialog sees this coming:
  `launch:preview` reports `briefBlocked: '<c>'` for a batch launcher whose `userData` path has a
  metachar, and the section shows it as an error before Start.
- The "Launches as" preview shows the brief args the host would add, with the path elided to
  `…/briefs/<id>/brief.md`.

### 3.3 Brief store

- **Canonical** `<userData>/brief-store/<id>.md`: host-private. It is never passed to a CLI and
  never exposed to one through `--add-dir`, and it is the only source the host reads to
  re-materialize or duplicate. It holds the brief text verbatim: UTF-8, BOM stripped, no header
  added (D6). It is written atomically.
- **Exposed** `<userData>/briefs/<id>/brief.md`: rebuilt from the canonical copy before every
  spawn (§2.2 step 2). The CLI reads it and may write it; the host never reads it.
- **Limits:** at most 65 536 bytes of trimmed UTF-8 (64 KiB). Text containing NUL, or a file that
  isn't valid UTF-8, is refused. Text that is empty or whitespace only means no brief. The host
  applies the cap to `openRepo` text before writing anything.
- **Lifecycle:** both copies are removed on session delete (async; a failure is logged). The
  orphan sweep runs at startup **before** windows load or second-instance opens are handled, so it
  can't race a creation. It removes the canonical files and exposed dirs whose id is in neither
  the live set nor the ids parsed from sessions.json on disk. Including the on-disk ids means a
  restore-off run, which keeps sessions.json, never loses those sessions' briefs, yet still
  cleans up failed or crashed writes.

### 3.4 Protocol and security

- `openRepo` gains `brief?: { kind: 'agent' } | { kind: 'none' } | { kind: 'text'; text: string } |
  { kind: 'file'; path: string }`. Absent means `agent`, so existing callers are unchanged.
- `openRepo:result.error` gains `'brief-unreadable' | 'brief-too-large' | 'brief-invalid' |
  'brief-io'`. The dialog maps each to a string. No session is created.
- New `brief:probe { requestId, path }` → `brief:probed { requestId, ok, bytes?, error? }` lets
  the dialog validate a path before Start. The latest `requestId` wins, and a stale reply is
  dropped. It is advisory: the host re-validates in `openRepo`.
- New `brief:agentPreview { requestId, agentId }` →
  `brief:agentPreviewed { requestId, supported: boolean, has: boolean, firstLine?, path?, error? }`
  reads the definition's brief for the dialog's **From agent** row. `supported` (added by the plan)
  is whether the launcher's adapter takes a brief; it is what shows or hides the section. The host reads the file; the renderer
  never sees `agents.json`.
- New `file:pick { requestId, title }` → `file:picked { requestId, path? }`. It adds an
  `openFile` mode to `electron/folder-picker.ts`, which today only has `openDirectory`.
- **Host-enforced provenance:** the only writers of the **canonical** brief are `openRepo` (the
  human's dialog), session creation from `agents.json`, and duplicate (copying canonical to
  canonical). No MCP tool, MCP argument, message or notice reaches the brief store or
  `session.brief`. The exposed copy is agent-writable by design but is never a source: it is
  rebuilt before every spawn, and duplicate copies from the canonical. So nothing an agent
  writes ever becomes a later first turn.
- The prompt is a constant template plus a host-generated path, so no brief text ever reaches argv.

### 3.5 Persistence

`Session.brief?: 'pending' | 'sent'` is persisted in sessions.json. The parser drops any other
value, which means no brief. MVP has no renderer consumer; the v1 card line uses it (§6).

### 3.6 Producers / consumers

| Data | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `agents.json` `brief` | human (hand edit) | host at session creation | yes |
| `openRepo.brief`, `brief:probe`, `file:pick` | New session dialog | host | yes |
| `brief:agentPreviewed` | host (reads the agent's brief) | dialog **From agent** row | yes |
| `brief-store/<id>.md` (canonical) | host (create, duplicate) | host (re-materialize, duplicate, sweep, delete) | yes |
| `briefs/<id>/brief.md` (exposed) | host (re-materialized each spawn) | the CLI's file read | yes (the CLI read is S0) |
| `session.brief` | host (create, spawn) | host spawn decision, persistence (renderer: v1 only) | yes |
| brief launch args | host (`term:start`) | the CLI's argv parser; the "Launches as" preview | yes (S0-1) |
| the CLI's first turn | the CLI | the notice gate (parent §2): the session is busy, not `empty-input`, so notices wait | yes; no gate change needed |

## 4. Edge cases & failure modes

| Condition | Behavior |
|---|---|
| Dialog: file missing / too big / not UTF-8 / NUL | probe error inline; Start blocked with the reason; host re-check fails → `openRepo:result` error, no session |
| Agent-default brief unreadable (dialog path) | same as above; the human can pick **None** and start |
| Agent-default brief unreadable (no-dialog path) | session created without a brief; dim banner `— role brief not sent: <reason> —` before the CLI starts; warn log |
| Canonical file deleted before first spawn | no prompt; `brief` cleared; banner `— role brief not sent: file missing —` |
| Exposed dir can't be rebuilt at spawn (EPERM/EBUSY) | spawn proceeds with no brief args; `pending` stays; warn log + banner |
| Canonical write fails (EPERM/ENOSPC) at creation | dialog: `brief-io`, no session; no-dialog path: created without a brief + banner |
| Cmd metachar in prompt/briefDir for a batch launcher | brief dropped, `brief` cleared, one banner `— role brief not sent: path has "<c>" —`; the dialog warns before Start |
| Two `term:start` race | the `pty.isAlive` re-check after the awaits (`term:start`) lets one spawn through; the `pending` read, the re-materialize, `pty.start` and `→ sent` run in one synchronous block after it |
| Spawn fails (`PtyHost.start` prints `failed to launch`, no live PTY) | stays `pending` |
| Agent plants files (`CLAUDE.md`, `.claude/`) in its brief dir | wiped by the re-materialize before the next spawn |
| Messaging off / cursor not connected / MCP unavailable | brief still sent; it doesn't depend on messaging |
| CLI shows a trust dialog first | Claude and Cursor: the prompt survives it and submits after it is accepted (S0-4). Codex showed no trust dialog in S0; checked in runtime QA |
| Codex asks to approve the brief read | expected (S0-2); the human approves it. The approval screen is a blocking screen to the notice gate, so no notice is typed over it |
| Agent edits its own exposed `brief.md` | allowed until the next spawn rebuilds it; never a source for the host (§3.4) |
| Session moved to another window | attach path, no spawn, no brief |
| App quits or crashes right after spawn | `pending → sent` is written to sessions.json immediately (not debounced), so a restore never re-sends. A crash between `pty.start` and that write re-sends once; accepted |
| `agents.json` brief changed after a session was created | no effect on existing sessions (snapshot) |
| Many sessions | one small file each; swept with the session |

## 5. Defaults vs settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Brief source in dialog | the agent definition's brief if it has one, else None | per session | team managers are defined once, in `agents.json` |
| Size cap | 64 KiB | no | a role brief, not a document dump; keeps the file read cheap |
| Re-send on relaunch/restore | never | no | decided; resume (item 2) relies on it |
| File source | snapshot at creation | no | D2 |
| Keep file after send | yes, until session delete | no | lets the agent re-read after compaction |

## 6. Scope

- **MVP:** S0 measurements; `agents.json` `brief`; brief store + lifecycle; per-adapter brief args
  for claude, codex, cursor and fake; `session.brief` persistence; dialog section + probe; preview;
  banners; units; one e2e; runtime QA with the three real CLIs.
- **v1:** a card/info line "Role brief sent · Open" that opens `brief.md` read-only in an editor tab.
- **Vision:** a Settings editor for per-launcher briefs (D5); brief templates per project.
- **Out:** resume, re-send, MCP-set briefs, CLIs without an initial-prompt arg.

## 7. Acceptance criteria

**Unit** (`test/unit/role-brief.test.ts` and siblings; injected fs, userData and `PtyHost`):
1. `parseBriefField`: a string gives text; `{file}` gives a file resolved against the `agents.json`
   dir, with `~/` expanded; `{}`, `{file:1}`, `{file,x}` and a number give `undefined` plus one
   warn, and the agent stays valid. A brief on an unsupported command logs one warn and is ignored.
2. `briefArgs` for claude, given def args ending in a variadic flag, plus roots, plus MCP wiring:
   - the argv ends `['--', 'Read your role brief at <abs> and follow it.']`;
   - `--add-dir <briefDir>` appears once, after the root `--add-dir`s;
   - `launchedRoots` excludes `briefDir`.
3. codex, cursor and fake: the argv ends `['--', prompt]` and carries no brief read-access flag
   (S0 outcome: they read in place).
4. `batchGuarded` with a `%` in `briefDir`: no brief args, reason `cmd-metachar`, `brief` cleared,
   and the rest of the argv equals the no-brief argv. `launch:preview` for that launcher reports
   `briefBlocked: '%'`.
5. Spawn decision, with a stub `PtyHost`:
   - `pending` + a live PTY after start → prompt, `sent`, and an immediate (non-debounced)
     sessions.json write;
   - `pending` + a stub that "fails to launch" (no live PTY) → stays `pending`;
   - `sent` → read access only;
   - `pending` + no canonical file → nothing, cleared, banner reason;
   - a restored `pending` session (app start) sends once.
6. Re-materialize: a planted `briefs/<id>/CLAUDE.md` and an edited `brief.md` are gone before the
   spawn, and `brief.md` equals the canonical copy.
7. Store:
   - text is written verbatim with the BOM stripped;
   - whitespace only → no brief;
   - 65 537 trimmed bytes → `brief-too-large`, with nothing written;
   - NUL or invalid UTF-8 → `brief-invalid`;
   - a file source is snapshotted (editing it afterwards doesn't change the canonical copy);
   - `openRepo` failing after the write leaves no canonical file.
8. Creation: the session id is pre-minted, the canonical file exists before `create` emits, and a
   no-dialog creation with an unreadable agent brief creates the session with no `brief` and
   queues the banner.
9. Duplicate copies the source's **canonical** file (not an agent-edited exposed copy) as
   `pending`. If the copy fails, the duplicate has no brief and gets a banner.
10. Persistence: `brief` round-trips; `'bogus'` → absent. Delete removes both copies. The sweep
    keeps ids that are live or in the on-disk sessions.json, and removes the rest, with restore on
    and off.
11. Provenance:
    - a grep test confirms the MCP host/dispatch modules don't import the brief module;
    - the tool schemas have no `brief` property;
    - the canonical-store writer is called only from the creation and duplicate paths.
12. Dialog (component test): the mode resets on a launcher change; an unsupported launcher hides
    the section; a stale `brief:probed` is ignored; a probe error, an over-cap count and
    `briefBlocked` each disable Start, with the reason in `ns__reason`; the preview shows the
    elided brief args.

**EARS**
- WHEN a session whose `brief` is `pending` cold-spawns with a supported adapter and the PTY is
  alive after `pty.start`, the host SHALL have passed the prompt as the final argv entry after `--`,
  and SHALL persist `brief = 'sent'` immediately.
- WHEN a session whose `brief` is `sent` spawns, the host SHALL NOT pass the prompt.
- IF the brief can't be read at creation in the dialog path, THEN the host SHALL create no session
  and SHALL return a brief error.

**e2e** `test/e2e/role-brief.e2e.mjs` (the fake agent is extended to append its argv to its JSONL
record and to exit on a typed `quit`):
```gherkin
Given the fake agent is selected in New session
When I choose Role brief → Text, type "You manage the fake team", and Start
Then the fake's recorded argv ends with "--" and "Read your role brief at <p> and follow it."
And the file at <p> contains "You manage the fake team"
When I type "quit" so the fake exits, and press Relaunch
Then the new argv contains no "Read your role brief" entry
```

**Runtime QA** (real CLIs, selfhost profile): a claude, codex and cursor session created with a
brief each start a first turn that reads the file and act on it: Claude and Cursor **with no
approval prompt**, Codex after **one** read approval. A Relaunch of each starts with no turn.
Codex in a never-trusted folder is checked for a trust dialog (S0 saw none).

## 8. UI: New session dialog → "Role brief" section

Shown between **Folders** and **Launches as**, only when the selected launcher has brief support.

| Component | State | User sees | Action |
|---|---|---|---|
| Mode radio group | agent has a brief | `From agent` (default) · `None` · `Text` · `File` | arrows move, Space/Enter selects (Enter on a radio = Start, matching the launch pills) |
| | agent has none | `None` (default) · `Text` · `File` | |
| From agent | ok | first line of the brief (from `brief:agentPreviewed`), ellipsized, plus the file path if it's a file brief | — |
| | unreadable | inline error, Start blocked with the reason | choose None |
| Text | empty | textarea, placeholder "Tell this session its role…" | type |
| | typing | trimmed UTF-8 byte count `1.2 / 64 KiB` (1 KiB = 1024) | — |
| | over cap | count turns error; Start blocked | — |
| File | empty | path field + **Browse…** | type a path or browse (native picker; e2e types) |
| | probing | "Checking…" | — |
| | ok / error | size, or error text | — |
| | `briefBlocked` | error naming the char in the app's data path; Start blocked | choose None |
| Section | unsupported launcher | hidden; the mode resets to the default on launcher change | — |

- **Interaction:** everything is keyboard-reachable in DOM order; the textarea owns Enter (newline);
  **Browse…** sends `file:pick` (native open-file dialog).
- **Accessibility:** the radio group has `role="radiogroup"` and `aria-labelledby` = the section
  label. The textarea and path field have visible labels, and the count and error are in
  `aria-describedby`. Errors go in `role="alert"`; probe results go in the dialog's existing
  `aria-live` region. Browse has the accessible name "Choose role brief file". The blocked-Start
  reason uses the existing `ns__reason` + `aria-describedby`.
- **i18n:** all strings go in a new `webview/role-brief-strings.ts`. Byte counts are formatted with
  `Intl.NumberFormat`. Paths are shown verbatim as LTR with `overflow-wrap: anywhere`. Brief text
  isn't translated. Check with `npm run text-fit`.
- **Tokens:** existing `ns__*` / form tokens only; the error uses the existing danger text token.
  No new colors.

## 9. Doc updates in the same change
- `CHANGELOG.md` (user-facing).
- The parent spec §3.1 gets one pointer line to this spec. Its owner applies it after the
  concurrent slice lands; this spec doesn't edit it now.
- The adapters header gains a pointer to §3.2.

## 10. Assumptions
- `--` works for all three CLIs. **Measured** (S0-1).
- The prompt submits as a normal first user turn in interactive mode for all three CLIs.
  **Measured** (S0-1, S0-4), including after Claude's and Cursor's trust dialogs.
- `userData` paths contain no cmd metachars on the human's machines. They contain spaces and
  parentheses (`Conduit (selfhost)`), and both survived Cursor's `agent.cmd` intact. **Measured**
  (S0-5) on a temp path of that shape, not the real `%APPDATA%`.

## 11. Decisions Needed
**Resolved.** D1 was ruled by the human after S0: agents may read anywhere on the machine, and a
read approval the human gives is acceptable. Claude gets `--add-dir <briefDir>`; Codex and Cursor
read in place (§3.2). D2–D6 take their defaults. The original entries stay below for the record.

- **D1 (high) Read access for each CLI.** Default: Claude gets `--add-dir <briefDir>` (a per-session
  dir, so no cross-session exposure; never inside the user's roots, which would put a file in their
  repo). Codex gets nothing **if** S0-2 shows that workspace-write reads outside the roots with no
  approval. Otherwise it falls back to `--add-dir <briefDir>`. That makes the dir writable, which
  is the same exposure Claude's `--add-dir` already has. Cursor gets `--add-dir` only if S0-3 shows
  that an outside read prompts. If every option fails for a CLI, that CLI drops brief support and
  the dialog hides the section for it. Copying the brief into the session's roots is rejected,
  because it puts a file in the user's repo.
- **D2 (normal) File brief: snapshot vs live.** Default: snapshot at creation. Live reads would make
  "what was sent" unknowable and fail when the CLI can't reach the user's path.
- **D3 (normal) `sent` = launched, not read.** Default: accepted, because confirming a read needs
  screen parsing per CLI. A CLI that exits on its first turn is not re-sent.
- **D4 (normal) Duplicate copies the source's canonical brief as `pending`.** Alternative: re-apply only the
  agent definition's brief. Default: copy, because a duplicated manager keeps its role.
- **D5 (normal) No Settings editor for briefs in MVP.** `agents.json` is hand-edited today and has
  no UI. The dialog is the only UI.
- **D6 (normal) No provenance header in the brief file.** The prompt arrives as a user turn, which is
  already the human's authority. Default: verbatim text.

## 12. S0 measurements (Codex runs these; real CLIs, bare ConPTY, scratch dirs; record in `docs/runs/2026-10-26-role-brief/s0.md`)
1. **`--` + prompt last.** For each CLI, launch with the selfhost definition args, the full MCP
   wiring (claude: `--add-dir r1 --mcp-config f --allowedTools x`; codex: the `-c` pairs; cursor via
   `agent.cmd`), then `-- "Read your role brief at <p> and follow it."`. Record whether the turn
   submits with the exact text, or whether the CLI errors or eats it. Repeat without `--` to
   confirm the variadic-swallow failure.
2. **Codex read outside roots.** With `-s workspace-write -a on-request`, cwd = a scratch repo,
   brief at `%APPDATA%\Conduit (selfhost)\briefs\x\brief.md`: does the read need approval, get
   refused, or succeed? Repeat with `-s read-only`.
3. **Cursor read outside roots.** Same file, `agent --model auto` from a scratch repo: does the read
   prompt or fail? Then repeat with `--add-dir <briefDir>`.
4. **Trust dialog first.** For each CLI in a never-trusted folder: does the positional prompt
   survive the trust/workspace dialog and submit after it, get dropped, or answer the dialog?
5. **Path quoting through `agent.cmd`.** A prompt containing `C:\Users\…\Conduit (selfhost)\briefs\…`
   arrives intact (record the argv the agent echoes back).
6. **Claude read of an `--add-dir` file** under the selfhost `--permission-mode auto` and under the
   default mode: no approval prompt. Also check whether `--add-dir` makes Claude load a
   `CLAUDE.md` (or `.claude/`) from that dir. Re-materializing before each spawn (§2.2) wipes
   planted files, but an agent could plant one mid-session for a later in-session reload. If
   Claude loads it, record that; the plan decides whether to mark the dir read-only after the
   rebuild. **Outcome:** neither a planted `CLAUDE.md` nor `.claude/CLAUDE.md` was loaded
   (observational), so the dir is not marked read-only; the per-spawn rebuild stays the defence.

---
status: draft
date: 2026-09-23
---

# Feature Spec: mf-live-edits — folder changes on a running session, and missing folders

**Tier:** FULL   **Feature type:** UI (terminal banner + centre state) over a host contract
**One-line request (tasks.yaml `mf-live-edits`):** "12c terminal banner after a folder change on a
running claude (Run /add-dir types it, Restart claude, ×; shells none); 12d missing home centre
state (Locate…, Use <other> as home) + card 'Can't start'; Locate… flow for attached folders."

Builds on `.autoloop/locked.md` and the sibling specs. **mf-model**
(`2026-09-23-mf-model.md`) delivers L3 edits, the `launchArgsFor` claude adapter (§2.5), the
`missingRoots`/`homeMissing` health check with a 5 s reconnect poll (§2.6), and explicitly hands the
missing-home spawn refusal and "Can't start" to this item (its D5). **mf-files**
(`2026-09-23-mf-files.md` §3.2) builds `session:locateFolder` and `pickFolder` with the
`__folderPickerQueue` e2e seam; this item reuses both for the home state. This item owns what a folder
change means for a process **already running**, the missing-**home** state, and restart. Design:
handoff README §12c/§12d, `screenshots/12c-edit-folders.png`, `12d-missing-folder.png`.

## 0. What exists

| Claim about today | How measured | Status |
|---|---|---|
| A missing launch cwd falls back to the **OS home dir** | `npx vitest run test/unit/resolve-launch-spec.test.ts` ("uses fallbackCwd when the requested cwd does not exist" passes); fallback `os.homedir()` at `electron/main.ts:1834` | Measured |
| Claude Code 2.1.281 `/add-dir` takes the **whole trimmed remainder** as the path; quotes are not stripped | Strings in the installed binary `~/.local/share/claude/versions/2.1.281`: `let o=r.trim()` → `One(o,…)` | Measured |
| With an argument, `/add-dir` is `immediate` (runs even mid-response) | Same binary: `immediate:(e,n)=>e.trim()!==""…` | Measured |
| Claude refuses a **network path** mid-session | Same binary: "…map the share to a drive letter and pass it at launch with --add-dir" | Measured |
| No `/remove-dir` exists | Same binary: no `name:"remove-dir"` | Measured |
| Success text `Added <path> as a working directory for this session` | Same binary | Measured |
| `busy` = output within 1500 ms (`src/session-activity.ts:109`); `deliverTimedMessage` = alive → text → `SUBMIT_GAP_MS` 120 → alive → `\r` (`electron/main.ts:1432`); `relaunch` only flips status + relaunch marker and is only offered when not running (`main.ts:2731`, `app.tsx:2035,2951`); `pty.dispose` kills **and** deletes the proc entry at once, before `onExit` (`src/pty-host.ts:194`); `sanitizeMessage` collapses whitespace runs | Source read, citations re-checked by the reviewer | ASSUMED → D12 |
| No `--warn`/`--ok`/`--bad` tokens; warning hue is `--amber`, plus `--success`/`--danger` | `Grep --(warn|ok|bad)` over `webview/` → 0 hits | Measured |

## 1. Problem frame

- **Job:** "I attached a folder to a session whose agent is already working. Let the agent use it
  without losing the conversation. If a folder vanished, tell me plainly and let me point Conduit at
  where it went."
- **Actors:** the user; the host (sessions, PTYs, spawn args, folder existence); the running agent
  (sees only what it was launched with, plus what it was told since).
- **Success outcomes:** one click makes a running claude see a new folder, conversation intact.
  Shells and non-claude agents never show a banner. A session whose home is gone never starts
  anywhere else. It says "Can't start" and offers Locate… / Use <other> as home. A folder that
  comes back needs no action.
- **Non-goals:** Files-tab folder UI and the missing-attached box (mf-files); existence detection
  (mf-model); `--add-dir` equivalents for codex / cursor-agent (L5); resuming the conversation on
  restart (`--continue`); auto-spawning once a home returns; an i18n layer (the repo has none).

## 2. Behavior & states

### 2.1 What the running agent can see (host-owned, derived)

At each cold `term:start` whose command matches the claude adapter (mf-model §2.5), the host records
the process's **scope**: `{ cwd: spec.cwd, dirs }`. `dirs` is every value given to `--add-dir` in the
**final** spawn args, in any of three forms: `--add-dir x`, `--add-dir=x`, or variadic
`--add-dir a b` (values run until the next `-`-prefixed token). Relative values resolve against
`spec.cwd`. This way a user's own `agents.json` `--add-dir` counts too. A delivered `/add-dir` (§2.3)
appends to `dirs`. The scope lives in host memory only. It is dropped when that process exits, and on
dispose. A non-claude spawn has no scope.

The pure `agentScopeDrift(session, scope, dismissed, exists, samePath)` returns two lists:

- `unseen`: each of `[home, ...presentRoots]` that is not **covered** by `scope.cwd` or any
  `scope.dirs` entry. A path is covered when it equals a scope entry or sits inside one; claude itself
  says "already accessible within" for a subfolder.
- `stillSeen`: each entry of `scope.dirs ∪ {scope.cwd}` that is not covered by `home` or by any of
  `roots` (missing roots included: a root that went missing was not removed), **and that still exists
  on disk**. A gone path cannot be read, so the banner never names one.

Dismissed paths are excluded from both. The host publishes the result as runtime-only
`Session.agentScope?: { unseen; stillSeen; typeable }`, where `typeable ⊆ unseen` (§2.3). The field is
omitted when both lists are empty, and is added to the `serializeSessions` strip list. It is
recomputed on any home / roots / missing / scope change. `exists` is the async stat mf-model's health
check already uses.

| Edit on a running claude | Result |
|---|---|
| Add folder, attach from explorer, a missing root reconnecting, Locate replacing a root | the new path is `unseen` → banner |
| Remove from session | a still-existing path in scope → `stillSeen` → banner (Restart only) |
| Make home (L3: old home becomes attached) | normally no drift, so **no banner**. The process keeps its cwd; only new terminals start in the new home |
| Any edit on a shell / codex / cursor-agent / non-claude custom session | no scope → no banner |

Explorer, search and git follow the edit immediately (mf-model / mf-files). This item only asserts
that end-to-end (AC-12).

### 2.2 The banner (12c)

The banner is an in-flow strip at the top of `.termhost__body`, above `TerminalPane`; the terminal
refits to the height left. It shows while the session is `running`, its pane is mounted and
`agentScope` is present. A session gets one banner, however many folders are involved.

| Situation | Message | Actions |
|---|---|---|
| 1 unseen | `claude can't see {a} yet` | **Run /add-dir** (primary), Restart claude, × |
| 2 unseen | `claude can't see {a} and {b} yet` | same |
| ≥3 unseen | `claude can't see {a} and {n} more folders yet` (`plural(n,'more folder')`) | same |
| unseen, none typeable | same message | **Restart claude** (primary), × |
| only stillSeen | `claude can still see {a} until it restarts` (≥2: `{a} and {n} more folders`) | **Restart claude** (primary), × |
| both | unseen message + second line `It can still see {x} until it restarts.` | unseen actions |

`{a}` is the folder's basename, and the message's `title` lists every full path. The copy says
`claude` literally, because only the claude adapter gets a banner.

- **Run /add-dir:**
  - `ready`.
  - `waiting` while `busy`: the button is disabled, with `title="claude is working — try again when
    it's idle"`.
  - `sending` after the click: disabled.
  - When it finishes, the delivered folders leave `unseen`. On failure a toast appears (§3.3) and the
    banner is unchanged.
- **Restart claude** takes two steps inside the banner. The first click replaces the banner content
  with `Restart claude? This conversation ends.`, a **Restart** button (primary) and a **Cancel**
  button, and focus moves to **Cancel**. Cancel restores the banner, and so does Esc when focus is
  inside the banner (Esc with focus in the terminal still goes to claude). Confirming runs §2.4.
- **×** runs §2.5.

### 2.3 Run /add-dir: delivery

The renderer posts `session:addDirsToAgent { sessionId }` with no paths. The host types only its own
current `typeable` list, so a stale or hostile renderer cannot type an arbitrary line. The host logic
lives in a unit-testable function `runAddDirs(deps)`:

1. Refuse unless the session exists, `pty.isAlive`, a scope exists and `typeable` is non-empty.
2. If `activity.statusOf(id).busy`, refuse with `busy`. Nothing is queued, so a deferred write can
   never land unseen.
3. A per-session in-flight latch: a second request while one is running gets `inFlight` and does
   nothing.
4. For each typeable path in order, deliver `/add-dir <path>` the same way timed messages deliver
   (alive → line → `SUBMIT_GAP_MS` → alive → `\r`), then wait `ADD_DIR_LINE_GAP_MS` (300). Each
   delivered path joins `scope.dirs`. Stop at the first failed write.
   - It is a raw host-side PTY write, **not** `term.paste()`. Bracketed paste is for user clipboard
     text and needs a mounted pane (timed-messages §2 "Delivery").
5. No `mgr.touch`: a robot keystroke is not user activity (timed-messages §2).

The path is typed **unquoted and verbatim**; spaces are fine. It is `typeable` only if it contains
no C0/C1/DEL character and is not a network path (`\\…` or `//…`), both measured as refused.
`sanitizeMessage` is not used, because it would collapse spaces inside the path. mf-model D6 skips
win32 roots with `" % & | < > ^` from launch args; those show up here as `unseen` and are typeable,
since no shell sits between us and claude's input.

After the click, focus returns to the terminal, so the user sees claude's reply, including any
confirmation claude's interactive `/add-dir` may show (ASSUMED, D3).

### 2.4 Restart claude

`session:restart { sessionId }`, "today's relaunch with the new args":

- Not alive → identical to `relaunch`.
- Alive → **kill without forgetting**: signal the process but keep its PtyHost entry until its own
  `onExit`. Then set status `running`, add the id to `pendingRelaunchMarker` and remount the pane,
  which posts `term:start`. The fresh spawn resolves the **current** home, roots and adapter args.
  `dispose` stays the teardown for `kill`.
- **Invariants:**
  - **(R1)** Every PTY exit event is matched to the process that produced it. Give each spawn a
    generation; `onExit`, `term:exit` handling, `procs.delete` and activity/scanner teardown act
    only when the generation matches. A late exit from the old child must never tear down the new
    one.
  - **(R2)** Exactly one new spawn per restart. The pane remount keys on the generation, not on
    seeing an `exited` broadcast, which may coalesce away.
  - **(R3)** main's scrollback ring (`scrollbacks`) and the `— session relaunched —` marker behave
    as they do for relaunch today.
- With `homeMissing` → refuse with `homeMissing`; the centre state takes over.

### 2.5 Dismiss

`session:dismissAgentScope { sessionId }` adds the current `unseen ∪ stillSeen` to a per-session
runtime dismissed set on the host, so every window agrees. A folder that is not in the set, such as
a later add, shows the banner again. Removing a folder from the session drops it from the set. The
set is cleared on exit, restart and dispose.

### 2.6 Missing home (12d right)

**Host** (consumes `homeMissing`; mf-model D5 hands the refusal to this item):
- `term:start`, `relaunch` and `session:restart` **never spawn** for a `homeMissing` session. The
  cwd resolves as: live cwd if it exists → home if it exists → refuse. The `os.homedir()` fallback
  is removed for sessions (D11).
- A **running** session whose home disappears keeps its process and terminal until the process
  exits.

**Renderer:**
- `sessionIconState` gains `cantStart`, returned first when `status !== 'running' && homeMissing`,
  for both `stale` and `exited`. `SESSION_STATE_WORD.cantStart = "Can't start"`; the glyph reuses the
  stale glyph.
- Every relaunch affordance skips `homeMissing` sessions, for `stale` and `exited` alike: card ↻,
  context-menu Relaunch, palette `cmd:relaunch`, `relaunchAllStale`, `autoRelaunchStale`.
- **Centre pane:** while the active session is not running and `homeMissing`, the `.stale` block
  replaces "Session not running"/"Process exited" with:
  - the title `Home folder not found`;
  - the full path (mono, selectable, wrapping);
  - **Locate…** (primary) → `session:locateFolder { sessionId, path: home }`;
  - **Use {name} as home** (secondary), shown only when a present attached root exists; `{name}` is
    the **first** present root in `roots` order. It runs `session:setHome`. Per L3 the missing old
    home becomes an attached root, and mf-files' missing box then offers Remove;
  - the timed-messages Waiting line, unchanged.
- When the home returns or is fixed, the block reverts to the block for the session's status:
  `stale` → "Session not running" + ↻ Relaunch; `exited` → "Process exited" + ↻ Restart. Nothing
  auto-spawns (D14).

### 2.7 Locate… (mf-files' `session:locateFolder`, reused)

mf-files §3.2 defines it: picker at the nearest existing ancestor → replace in place (home →
`home`, else the same index in `roots`) → validated as `addRoot`. This item relies on three
properties of it:
1. Locating the home drops the old path; it is not moved to roots.
2. Picking the original path once it has returned is a no-op success.
3. The edit fires the same recompute as any L3 edit, so a located root on a running claude shows
   the unseen banner.

## 3. Data / interface contract

### 3.1 Messages (renderer → host, all host-validated)

| Message | Payload | Result |
|---|---|---|
| `session:addDirsToAgent` | `{ sessionId }` | `agentScope:result { sessionId, ok, reason? }` to the sender |
| `session:restart` | `{ sessionId }` | state broadcast; refusal → `agentScope:result { ok:false, reason }` |
| `session:dismissAgentScope` | `{ sessionId }` | state broadcast |
| `session:locateFolder` | mf-files §3.2 | mf-files §3.2 |

`reason`: `'noSession' | 'notRunning' | 'notClaude' | 'nothingPending' | 'busy' | 'inFlight' |
'writeFailed' | 'homeMissing'`.

### 3.2 Session (runtime-only)

`agentScope?: { unseen: string[]; stillSeen: string[]; typeable: string[] }`, never persisted.
`busy`, `status`, `missingRoots` and `homeMissing` are read, not changed.

### 3.3 User-visible failures

| reason | Toast |
|---|---|
| `busy` (a race past the disabled button) | `claude is working — try again when it's idle` |
| `writeFailed`, `notRunning` | `Couldn't type /add-dir — claude isn't running` |
| `notClaude`, `homeMissing`, `noSession`, `nothingPending`, `inFlight` | silent, `log.info` (the UI never offers these; they are races) |
| locate failures | mf-files §2.6 copy |

### 3.4 Invariants

- The renderer never names a path to type.
- A `homeMissing` session never spawns.
- `agentScope` exists only for a live claude-adapter process.
- R1–R3 hold (§2.4).
- Path comparisons go through an injected `samePath` (case-folding on win32), never
  `process.platform` inside the pure function, because CI runs on ubuntu.

### 3.5 Producers / consumers

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| `home`/`roots` edits | mf-model L3 handlers, mf-files `locateFolder` | drift recompute (here), Files/search/git | Yes: the recompute hooks the shared handlers |
| `missingRoots`/`homeMissing` + return | mf-model health check + 5 s poll (§2.6) | centre state, card, drift, spawn refusal | **No**: the producer is locked (L9) and specified in mf-model, including the missing home in the poll (D20) |
| spawn args | mf-model `launchArgsFor` | scope capture | Yes: read off the final args, so it does not depend on how they are built |
| `busy` | `SessionActivity` | button state, host gate | Yes (read-only) |
| typed `/add-dir` line | `runAddDirs` | claude's input | Yes; claude's reaction is probed in QA-2 |
| PTY exit / status | PtyHost + `session:restart` | pane mount, card, activity teardown | Yes: R1/R2 change the producer (PtyHost exit), not only the consumer |

## 4. Edge cases & failure modes

| Condition | Behavior |
|---|---|
| Two windows click Run /add-dir | in-flight latch; the second is silent |
| Claude exits mid-sequence | the alive re-check fails → stop; paths already delivered stay in scope |
| Folder removed while its line is typed | the line stays; the recompute makes it `stillSeen` if it exists |
| Removed or relocated root no longer exists | not in `stillSeen` (existence filter) |
| 10 unseen folders | one banner reading "{a} and 9 more folders"; 10 lines ~420 ms apart |
| Spaces / non-ASCII / `&` in the path | typed verbatim, unquoted |
| Control char or UNC path | not typeable; Restart is primary |
| User typed `/add-dir` themselves | invisible to Conduit; the banner stays until × (output scan is Vision) |
| Busy never drops | the button stays disabled; Restart and × still work |
| Unseen folder goes missing before the click | drops out of `unseen` |
| Session moved to another window | the scope is keyed by session in host memory; the attach path keeps it |
| App restart | every process is new and its scope is rebuilt → no banner |
| Old child's exit arrives after the restart's new spawn | ignored by generation (R1) |
| Home missing and no present root | only Locate… |
| Home returns while the picker is open | a pick still applies; cancel leaves the now-present home |
| Home missing but the live cwd exists | still refused: home is the session's identity (`.conduit/`, L7) |
| Restart confirmed on a busy claude | allowed; the confirm copy says the conversation ends |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Unseen banner | on, claude adapter only | no | the fix only exists for claude |
| Removed-folder banner | on, Restart only | no | removal may mean "revoke"; claude can't drop a dir live |
| Busy gate | refuse, no queue | no | a deferred write lands unseen |
| Line gap | 300 ms constant | no | lets claude answer each line |
| Restart confirm | inline two-step | no | it ends the conversation |
| Use-as-home candidate | first present root | no | deterministic |

## 6. Scope slicing

- **MVP:** scope capture + `unseen`, banner (Run /add-dir / Restart / ×), busy gate, `session:restart`
  with R1–R3, missing-home refusal + centre state + "Can't start".
- **v1:** `stillSeen`, multi-folder copy, untypeable handling, two-step confirm.
- **Vision:** learn manual `/add-dir`s from `Added … as a working directory` output; restart with
  `--continue`; codex / cursor-agent equivalents.
- **Out of scope:** mf-files UI, mf-model detection, preview confinement (L6).

## 7. Acceptance criteria

### Unit (vitest)

- **AC-1** `agentScopeDrift`:
  - add → unseen;
  - subfolder of a scope dir → not unseen;
  - remove → stillSeen;
  - a removed path that no longer exists → not stillSeen;
  - missing root in scope → neither;
  - Make home swap → empty;
  - dismissed paths excluded;
  - the win32 `samePath` case-folds, the posix one doesn't.
- **AC-2** Scope capture handles `--add-dir x`, `--add-dir=x`, variadic `--add-dir a b -p`,
  user-supplied and relative values; a non-claude basename → no scope.
- **AC-3** `typeable` keeps double spaces verbatim and rejects C0/C1/DEL and `\\host\share`.
- **AC-4** `sessionIconState` → `cantStart` for `stale`+`homeMissing` **and** `exited`+`homeMissing`;
  the word is "Can't start"; the relaunch-affordance predicate is false for both.
- **AC-5** Banner copy for 1 / 2 / 3+ unseen, stillSeen-only, both, and none-typeable.
- **AC-6** Spawn cwd: live cwd → home → refuse; never `os.homedir()` for a `homeMissing` session
  (extends `resolve-launch-spec.test.ts`).
- **AC-7** `serializeSessions` strips `agentScope`.
- **AC-8** `runAddDirs` with a fake pty:
  - busy → `busy` with **zero** writes;
  - idle with 2 paths → writes exactly `/add-dir <p1>`, `\r`, `/add-dir <p2>`, `\r` in order;
  - dead after write 1 → stops, only p1 joins scope;
  - concurrent call → `inFlight`.
- **AC-9** PtyHost generations: an exit from generation 1 arriving after generation 2 has spawned
  leaves generation 2 alive, and emits no `term:exit` for the session.

### EARS

- **E1** When a present folder that the process does not cover is added to a running claude
  session, the terminal shall show the 12c banner naming it within 1 s.
- **E2** Where the launcher is not the claude adapter, the system shall never show the banner.
- **E3** While the session is busy, Run /add-dir shall be disabled, and the host shall refuse it
  without writing to the PTY.
- **E4** When Run /add-dir is activated on an idle session, the host shall type `/add-dir <path>`
  + Enter per typeable folder, and the banner shall drop those folders.
- **E5** If a session's home is missing, then term:start, relaunch, restart and auto-relaunch shall
  not spawn.
- **E6** When a missing home returns, the centre state shall revert to its status's normal block
  and the card word shall leave "Can't start", with no spawn.
- **E7** When a restart is confirmed on a live claude, exactly one new process shall start with the
  current args.

### E2E (real app, hidden, `test/e2e/mf-live-edits.e2e.mjs`)

**Seam:** `<userData>/agents.json` defines an agent whose `command` is a temp **`claude.cmd`** running
`node fake-claude.mjs %*` (the adapter matches by basename, as in mf-model §7.4).
- The fake prints `FAKE-CLAUDE ARGS <json argv>` on start.
- It echoes each input line as `FAKE-CLAUDE GOT <line>`.
- On the line `work` it streams output for 4 s, which drives `busy`.

Picks come from mf-files' `__folderPickerQueue`.

```gherkin
Feature: live folder edits and missing folders
  Background:
    Given a session on the fake claude with home H and no attached folders

  Scenario: add a folder, run /add-dir (E1, E4)
    When folder "D with space" is added via session:addRoot
    Then the banner reads "claude can't see D with space yet" within 1 s
    And the terminal still shows exactly one "FAKE-CLAUDE ARGS" line
    When I click "Run /add-dir"
    Then the terminal shows "FAKE-CLAUDE GOT /add-dir <abs path of D with space>" unquoted
    And the banner is gone

  Scenario: busy gate (E3)
    Given I type "work" into the terminal
    When I add folder E
    Then "Run /add-dir" is disabled while output streams
    And no "FAKE-CLAUDE GOT /add-dir" appears until I click it after output stops

  Scenario: restart picks up new args (E7)
    Given folder E is unseen
    When I click "Restart claude", focus lands on "Cancel", and I click "Restart"
    Then exactly two "FAKE-CLAUDE ARGS" lines exist and the second contains "--add-dir" and E
    And the banner is gone

  Scenario: shells get nothing (E2)
    Given a shell session with home H
    When a folder is added
    Then no banner is rendered

  Scenario: edits apply live
    When folder E containing needle.txt is added to the running session
    Then the Files tab lists E and Search finds "needle" in it with no new "FAKE-CLAUDE ARGS" line

  Scenario: missing home (E5, E6)
    Given the app is closed, H is renamed away, and the app is relaunched
    Then the card says "Can't start" and the centre shows "Home folder not found" with H's path
    And the host log has no pty spawn for that session
    When H is renamed back
    Then within 6 s the centre shows "Session not running" with Relaunch

  Scenario: Locate and Use-as-home
    Given the home is missing and attached folder E is present
    Then "Use E as home" is shown
    When I click "Locate…" with the picker queue holding P
    Then the session's home is P, the missing state clears, and Relaunch spawns in P
```

- **AC-10** × dismisses; adding a second folder re-shows the banner for the new one only.

### Runtime QA (outside the gate)

- **QA-1** Banner and home state in Aero, Neon and light vs. 12c/12d; long folder names truncate.
- **QA-2** Real claude 2.1.281: add a folder with a space to a running claude and run /add-dir →
  expect "Added … as a working directory…" or claude's confirm prompt. While it responds, the button
  stays disabled. Record whether the raw-written line submits as a command (D3/D4).

## 8. State catalog (UI)

| Component | State | User sees | CTA |
|---|---|---|---|
| Banner | hidden | nothing (no drift / shell / dismissed / not running) | — |
| Banner | ready | amber dot + message | Run /add-dir, Restart claude, × |
| Banner | waiting (busy) | Run /add-dir disabled + title | Restart, × |
| Banner | sending | Run /add-dir disabled | — |
| Banner | untypeable / stillSeen | message | Restart claude (primary), × |
| Banner | confirming | "Restart claude? This conversation ends." | Restart, Cancel |
| Banner | failed | unchanged + toast | retry |
| Centre | home missing | title, path, Locate… [+ Use {name} as home] | Locate… |
| Centre | picker open | buttons disabled | — |
| Centre | locate rejected | mf-files toast; state unchanged | retry |
| Centre | home back / fixed | status's normal block | Relaunch / Restart |
| Card | can't start | stale glyph + "Can't start"; no ↻ | select → centre state |

Loading, offline and permission states do not apply (host-local IPC).

## 9. Interaction inventory (UI)

| Component | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|
| Banner buttons | click | Tab order Run → Restart → ×; Enter/Space; Esc cancels the confirm only with focus in the banner | none | `<button>`; × `aria-label="Dismiss"`; disabled via `disabled` + `title` |
| Banner message | — | not a focus stop | — | the **message element only** is `role="status" aria-live="polite"`, so button labels are not re-announced |
| Centre buttons | click | Tab, Enter/Space; no autofocus (never steals the terminal's focus) | none | the title is a heading |
| Card | as today | as today | Relaunch hidden when can't start | the state word is text |

**Focus:**
- Run /add-dir → the terminal.
- First Restart click → Cancel. Restart confirmed → the terminal. Cancel → the Restart claude button.
- Locate / Use-as-home success → the centre's Relaunch button.

## 10. Accessibility & i18n

- No state is colour alone: there is always a message or "Can't start" text beside the amber dot.
- The live region announces once per banner change, not per `busy` flip (the disabled state is not
  in the region).
- Visible focus uses the existing button ring; buttons keep borders in forced-colors mode.
- There is no i18n layer. All strings sit in one module beside the banner (`plural()` for counts),
  never inline in JSX branches.
- Folder names in the message **and** in `Use {name} as home` truncate with an ellipsis (max-width,
  full path in `title`). Buttons never shrink, and the message wraps to two lines first, which
  tolerates 30%+ expansion.
- Paths are `dir="ltr"`, in mono.

## 11. Design tokens

- Banner surface: `color-mix(in srgb, var(--amber) 14%, <terminal background token>)`.
- Dot and primary button: `--amber` (D10). The secondary button uses the existing quiet role, and ×
  uses the close glyph from `icons.tsx`.
- The centre state reuses `.stale`, `.stale__title` and `.btn--primary`; the path uses the mono
  token.
- Neon's `--amber` is pink by design and is accepted as its warn hue.
- The banner is in-flow in the centre pane and never overlaps `.topbar`, so no app-region change
  is needed.

## 12. Assumptions

- The L3 edits and `session:locateFolder` all publish through the ordinary state broadcast, and the
  drift recompute can hook them host-side.
- node-pty/ConPTY spawns a `.cmd` agent command directly. mf-model's e2e relies on this too.

## 13. Decisions Needed

- **D3 [high] Enter or not.** Pick: type the line **and** press Enter, idle-gated, reusing timed
  messages' delivery ("always press Enter" is a locked user decision there).
  - Risk: a permission prompt that is quietly waiting reads as idle, and the keys and Enter would
    act on it.
  - Alternative: type without Enter and let the user submit.
  - QA-2 probes it.
- **D5 [high] Busy.** Pick: refuse while `busy`, with no queue.
  - `busy` means "output within 1.5 s", so a quiet prompt counts as idle (see D3).
  - Claude runs `/add-dir <arg>` immediately even mid-response (measured), so the gate protects
    against the prompt and draft-text hazards, not against claude.
- **D11 [high] Lock deviation (L5 "cwd rule unchanged").** For a `homeMissing` session, pick:
  refuse the spawn instead of today's measured fallback to `os.homedir()`.
  - Live cwd missing → home. Home missing → refuse.
  - mf-model's D5 hands this to this item, but it still bends L5's letter.
- **D1 [normal]** Removed-folder banner: yes, as `stillSeen` with Restart + ×, only for paths that
  still exist. Claude has no `/remove-dir` (measured).
- **D2 [normal]** Several pending folders: one banner and one `/add-dir` line per folder, 300 ms
  apart.
- **D4 [normal]** Paths typed unquoted and verbatim (measured parse). Whether a raw write is
  submitted as a slash command rather than as paste text is ASSUMED → QA-2.
- **D6 [normal]** Make home: no banner of its own.
- **D7 [normal]** Non-claude agents get no banner. The handoff's "a restart for everything else"
  gives them nothing, because L5 adds no flag for them.
- **D8 [normal]** Restart confirm is an inline two-step because restart ends the conversation.
  `--continue` is deferred.
- **D9 [normal]** New `session:restart` with kill-without-forget and per-spawn generations (R1–R3).
  This changes PtyHost's exit bookkeeping, a producer, and is not a renderer-only change.
- **D10 [normal]** Lock text names `--warn/--ok/--bad`, which don't exist (measured). The lock's
  intent (reuse tokens, no hex) is kept with `--amber/--success/--danger`.
- **D12 [normal]** Source-read §0 claims stay ASSUMED until the builder confirms them.
- **D13 [normal]** The Use-as-home candidate is the first present root; there is no chooser.
- **D14 [normal]** No auto-start after a fix or return.
- **D15 [normal]** The e2e picker comes from mf-files' `__folderPickerQueue`, with no second seam.
- **D16 [normal]** The banner is an in-flow strip that refits the terminal, not an overlay.
- **D17 [normal]** A running session that loses its home keeps running. "Can't start" appears only
  after it exits.
- **D18 [normal]** Dismissal is a host runtime set, not persisted.
- **D19 [normal]** Scope capture accepts `--add-dir x`, `=x` and variadic forms, so user args count.
- **D20 [normal]** "Reconnects automatically" for a missing **home** depends on mf-model's 5 s poll
  covering `homeMissing` as well as `missingRoots`. If mf-model's build polls roots only, that is a
  broken L9 and E6 fails.

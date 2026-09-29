---
status: active
date: 2026-09-28
---

# Feature Spec: Dirty-editor quit guard (VS Code "Save changes?" parity)

**Tier:** FULL   **Feature type:** UI (host orchestration + renderer dialog)
**Mode:** autonomous. Would-be questions are assumptions (§12) or flagged decisions (§13).
**One-line request:** quitting the app, closing a window, closing a session that owns dirty tabs,
or relaunching for an update while editors hold unsaved changes must ask "Do you want to save the
changes you made to N files?" (Save All / Don't Save / Cancel, files listed) and never lose edits
silently. One coherent dialog flow with the existing session quit guard, not stacked prompts.

Related: auto-save [2026-09-28-auto-save.md](2026-09-28-auto-save.md) (its D3 deferred a
guaranteed pre-quit flush to "v1": this spec is that v1), split-editor
[2026-09-28-split-editor.md](2026-09-28-split-editor.md) (dirty state is per path),
quit guard [archive/2026-06-16-quit-guard.md](archive/2026-06-16-quit-guard.md).

## 1. Problem frame

- **Job:** "Let me close Conduit (or a window, or a session) without thinking about whether an
  editor still has my edits, and without being asked when nothing would be lost."
- **Actors:** the user; the host (Electron main, owns quit/close/update and every write); each
  window's renderer (owns the Monaco buffers, `dirty-store`, `fileSaves`); electron-updater.
- **Success outcomes (observable):**
  1. No quit / window close / session close / session move / update relaunch discards a dirty
     buffer unless the user picked **Don't Save** for it.
  2. At most **one dialog per window** per attempt. When the window also has running sessions,
     the session warning is a line *inside* the dirty dialog, not a second dialog.
  3. With auto-save on, anything auto-save can land is saved before the dialog; the dialog lists
     only what is still dirty.
  4. Nothing dirty and nothing running → closes with no dialog (as today).
  5. A hung or dead renderer can never make the app unquittable (MVP, not deferred).
- **Non-goals:** hot exit (VS Code's default `files.hotExit`, D6); OS shutdown/logoff (D8);
  renderer reload (Ctrl+R / crash-recovery reload) losing buffers; other unsaved non-editor state
  (plan comment drafts, review note drafts): small, separately owned, and not "files" (D14);
  macOS window semantics (Windows is the release target; darwin keeps today's behavior).

## 2. Behavior & states

### 2.1 Current behavior

Measured 2026-09-28 against the hidden built app at `de36575` (the `out/` build is newer than HEAD),
with a scratch script on `test/e2e/harness.mjs` + `auto-save-helpers.mjs` (in `%TEMP%`, deleted
afterwards). Each run opened `a.ts` in a `shell:cmd` session, typed `EDIT`, fired the trigger,
then answered any `confirmQuit` with `quitDecision{proceed:true}`. *Plan* rows come from the
auto-save plan's run notes (`docs/plans/2026-09-28-auto-save.plan.md`, "Run notes", C5).

| Claim about today's behavior | How measured | Verdict |
|---|---|---|
| C1. Window close with a dirty file shows only the **session** dialog ("2 sessions still running / Quitting will stop 2 running agents…", Cancel/Quit), with no mention of unsaved files. | `win.close()` ×3, dialog `textContent` | Measured |
| C2. After Quit the edit usually lands anyway, because the renderer's `beforeunload` save-all (`app.tsx` ~589) races the teardown. Today 3/3 (close, `off`) and 1/1 (close, `afterDelay`); the plan's earlier runs 3/4 (window close 1/2). **Racy, not guaranteed.** | disk read after exit | Measured |
| C3. `app.quit()` fires `before-quit` **before** any window close guard, so `pty.disposeAll()` kills the terminals first. The renderer then shows "Terminal exited … Close the session and its tabs?" and the quit guard's `confirmQuit` arrives as well: two unrelated prompts. | `app.once('before-quit')` order probe, dialog text, session status `exited` | Measured |
| C4. A `kill` of a session owning a dirty tab closes its tabs and **discards the edit silently**: no dialog, disk unchanged. | `post({type:'kill'})`, disk `orig` after exit | Measured |
| C5. The UI close-session confirm ("…has open editor tabs…") is gated by `confirmCloseRunning`, says nothing about unsaved edits, and confirming takes the C4 path. | Source (`app.tsx` `requestKill`) | ASSUMED (D11) |
| C6. The host asks the renderer only when the window owns a running session (`needsQuitConfirm`). A window with dirty files but only exited/stale sessions closes with no round-trip. | Source (`onWindowClose`). Measurable with an exited agent session; not run | ASSUMED (builder measures) |
| C7. The host's 3000 ms fallback proceeds if the renderer never sends `quitDialogShown`; once the ACK arrives it waits forever. | `quit-guard.e2e.mjs` Part 1b | Measured (existing e2e) |
| C8. `updateRelaunch` confirms (sender window's sessions only; the count can be 0 while another window runs sessions) **before** `quitAndInstall()`, then marks every window confirmed. That flag leaks if the install doesn't happen. | Source (`main.ts` `updateRelaunch`) | ASSUMED |
| C9. `ConfirmDialog`'s window Enter handler runs `onConfirm` unless **Cancel** is focused. With the middle button focused, Enter fires **both** Save (handler) and Discard (native activation). | Source (`confirm-dialog.tsx`) | ASSUMED (D12) |
| C10. Moving a session to another window (`moveSessionToWindow`) drops it from the source window's state. The renderer effect (`app.tsx` ~1168) then runs `releaseFileTab` + `closeSession` on its docs, so dirty buffers are lost silently. | Source | ASSUMED (D11) |
| C11. A `conflict`-phase path ignores `manual` saves: `autoSaveStep` only leaves `conflict` on `force`, so `save(path,'manual')` returns false with `error: null`. | Source (`auto-save-policy.ts`) | ASSUMED |
| C12. `saveAllDirtyDocs` (palette Save All) treats a path with no save entry as a success (skips it). | Source (`save-registry.ts:97`) | ASSUMED |

### 2.2 The flow (target)

One host-side **close guard** asks each affected window's renderer. The renderer owns everything
about dirty buffers and shows at most one dialog.

**Triggers → scope**

| Trigger | Guard | Windows asked | Sessions on proceed |
|---|---|---|---|
| Last window closed (✕, Alt+F4, taskbar) | app quit (`quit`) | that window | preserved for restore (as today) |
| `app.quit()` from anywhere (window-all-closed, electron-updater incl. `autoInstallOnAppQuit`) | app quit (`quit`) | all, focused first | preserved |
| Close one window of several | window (`windowClose`) | that window | that window's disposed (as today) |
| Update "Relaunch & update" | app quit (`update`) | all, sender first | preserved as stale (as today) |
| Close session(s) in the renderer (single, bulk, "Terminal exited" warn) | renderer-only | n/a | killed on proceed |
| Move a session to another window (drag, context menu, tear-out) | renderer-only | n/a | moved on proceed |

The single-instance loser (`app.quit()` at `main.ts` ~1096) returns before the `before-quit`
listener exists and is **unaffected**.

**Host ordering (fixes C3):**

1. `before-quit`: if there is no quit **grant** → `flushStateSync()` (idempotent atomic snapshot, so a
   process death while the guard waits loses nothing), then `preventDefault()`, start (or join) the
   app guard, and return. **No teardown, no `isQuitting = true`.** (Amended, critic B2.)
2. App guard: snapshot the live windows and ask each in order (focused/sender first). Before
   asking: `restore()` if minimized, `show()` **only when `CONDUIT_E2E !== '1'`** (repo convention,
   see `moveSessionToWindow`), `focus()`. A window destroyed before its turn is skipped. A window
   created during the guard (second-instance open, tear-out) is appended and asked before the
   guard finishes. Any **Cancel** → send `quitAborted` to every window that already answered
   (they unlock, §2.3), and stop. All proceed → issue a one-shot **grant** and call `app.quit()`.
3. `before-quit` with a grant → consume it and run today's teardown once (a `tornDown` flag makes
   later `before-quit`s, e.g. electron-updater's own `setImmediate(app.quit)`, no-ops). Window
   `close` events pass while `isQuitting`.
4. Update: the app guard runs **first**; on proceed issue the grant, then `quitAndInstall()`
   (it spawns the installer before quitting, so it is never called for a quit that could still be
   cancelled). A grant not consumed by a `before-quit` within 5 s expires (install returned false),
   every window gets `quitAborted`, and the app carries on. The update stays pending on Cancel.
5. Last-window close: `preventDefault()` and `app.quit()`, so steps 1–3 run exactly once (no
   second prompt from `window-all-closed`).
6. Non-last window close: `preventDefault()`, ask that window (`windowClose`). Proceed → add it to
   `windowConfirmed` (**only this path uses `windowConfirmed`**), dispose its sessions, `close()`.
7. At most one guard in flight app-wide. A close/quit trigger while one is pending focuses the
   window being asked and, if that window's ask is `shown`, **re-sends its `confirmQuit` with the same
   `requestId`** (re-probe; critic B1b). An update click, or a close of a *different* window, during a
   pending `windowClose` guard is **queued** and runs after it settles; a queued close that finds its
   window now the last one becomes an app quit (critic S4). A quit guard pending: joined, reason
   upgraded to `update`. If the other window vanishes during a non-last `windowClose` guard, a proceed
   is treated as a last-window close (sessions kept for restore).

**Renderer handling of one ask (per window):**

1. On `confirmQuit` whose `requestId` is the live flow's (a re-probe): re-focus the live dialog, or
   answer `proceed:false` if the flow has none (already answered). Otherwise post
   `quitAck{requestId}` immediately (liveness), then:
2. If `autoSave !== 'off'`: `fileSaves.flushAll('windowBlur')` (auto kind, on-disk precondition),
   bounded by **5 s** (D7). Per-file failure toasts are suppressed during the guard; the dialog
   carries the reasons.
3. Dirty set = `getDirtySnapshot()` for the window: paths, not tabs (split-editor's two tabs of one
   file count once). Tag each from `fileSaves.getStatus(path)`: `conflict` → "changed on disk";
   `failed` → "save failed: <error>"; `edited:false` → "not edited" (D4); no save entry → "can't be
   saved here"; truncated doc → "partly loaded, can't be saved" (D13).
4. Nothing dirty, nothing running → post `quitDecision{proceed:true}`, no dialog.
   Nothing dirty, sessions running → today's session dialog, copy unchanged.
   Dirty → the **dirty dialog** (§8), with the running line when `running > 0`.
   Post `quitDialogShown{requestId}` once either dialog has painted.
5. **Save All** → saves every saveable listed path: `force` kind for `conflict` paths (C11, D3),
   `manual` for the rest. All ok → proceed. Any failure, or any unsaveable path left → the dialog
   stays, listing only what is still unsaved with reasons. Never proceeds past an unsaved path
   except through **Don't Save**.
6. **Don't Save** → proceed. Buffers are not reverted (if another window cancels, they survive).
7. **Cancel** / Esc / backdrop → `quitDecision{proceed:false}`.
8. Before posting `proceed:true`, wait for in-flight write chains to settle (bounded 5 s, then
   proceed anyway and log it), so teardown never races a half-done temp+rename write.
9. After posting `proceed:true` in an **app** guard, the window shows a non-dismissable "Quitting…"
   scrim that blocks input until the window closes or `quitAborted` arrives. This stops new edits,
   sessions or moves in a window that already answered while another window is being asked.

**Session close / move (renderer-only):** `requestKill`, `closeSessions`, the exited-shell "warn"
path and every move-session entry compute the dirty paths of docs owned by the target session(s).
If any are dirty, the dirty dialog replaces the "Close session?" / "Terminal exited" confirm,
**regardless of `confirmCloseRunning`** (that setting gates only the running-session warning).
Save All → save, then post `kill`/move; Don't Save → post; Cancel → nothing. No dirty paths →
today's behavior.

**One modal slot** (critic B1a): every renderer confirm and the dirty dialog share one slot, and
opening an entry settles the one it displaces as Cancel (a displaced quit ask posts
`quitDecision{proceed:false}`; a displaced tab-close confirm resolves false). The automatic
"Terminal exited" confirm can therefore never orphan a quit ask.

**`beforeunload` save-all is kept under Electron as the backstop** (D2, amended by critic B3) for
every path where the guard gives up (no ACK, 12 s silence, "Close anyway", window destroyed). It is
skipped **only** when this window answered **Don't Save** (`discarded`, cleared by `quitAborted` or a
new ask), so it never overrides the user.

### 2.3 Host ask (per window): lifecycle

`asked → acked → shown → decided(proceed|cancel)`, plus terminal exits:

| From | Event | To |
|---|---|---|
| asked | no `quitAck` within 3000 ms | `quitAborted` to it (renderer ends that flow, never locks), then decided(proceed), `log.warn` (C7 semantics kept; covers a renderer that is reloading or not yet subscribed) |
| acked | no `quitDialogShown`/`quitDecision` within 12 s (5 s flush + 5 s write-settle + margin) | `quitAborted` to it, then decided(proceed), `log.warn` |
| shown | a repeat close/quit trigger | re-send `confirmQuit` with the same `requestId` (re-probe, B1b) |
| any | matching `quitDecision` from **that** window | decided |
| any | window destroyed or `render-process-gone` | decided(proceed): no buffers remain to save |
| shown | window `unresponsive` | native box "Conduit isn't responding. Unsaved changes in this window can't be saved." **Wait** / Close anyway (default Wait; D5). Close anyway → proceed. A decision arriving first wins. |
| any | stale `requestId` or another window's decision | ignored |

## 3. Data / interface contract

```ts
// HostToWebview
{ type: 'confirmQuit'; requestId: number; reason: 'quit' | 'windowClose' | 'update';
  running: number; busy: number }
{ type: 'quitAborted'; requestId: number }          // unlock the "Quitting…" scrim
// WebviewToHost
{ type: 'quitAck'; requestId: number }              // on receipt, before the flush
{ type: 'quitDialogShown'; requestId: number }      // a dialog painted
{ type: 'quitDecision'; requestId: number; proceed: boolean }
```

- `running`/`busy` count that window's owned sessions (today's `sessionsOwnedBy`). For `update`,
  every window is asked with its own counts, which fixes C8's sender-only count. **Behavior
  change:** several windows with running sessions now each show their session dialog in turn.
- `requestId` is host-unique and monotonic. A decision whose id doesn't match is ignored. The
  harness `closeApp` and `quit-guard.e2e.mjs` must echo the id from the captured `confirmQuit`.
- `QuitReason` in `src/quit-guard.ts` gains `'windowClose'`. The dirty-dialog copy is a new pure
  function beside `quitConfirmCopy`. Input: files `{path, name, dir, tag, session?}[]`, `running`,
  `busy`, reason `quit | windowClose | update | sessionClose | sessionMove`. Output: title,
  sublines, rows, overflow count, labels.
- The host guard is a pure, injectable state machine (clock, window list, send, native dialog),
  so ordering is unit-tested without Electron.
- **Invariants:** (I1) teardown runs only after every asked window proceeded; a cancelled or
  expired quit leaves `isQuitting === false`, no grant, and persistence live. (I2) one guard in
  flight. (I3) one dialog per window per attempt. (I4) no Save All or in-flight write is cut by
  teardown (step 8 bound excepted). (I5) teardown runs at most once.

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| Dirty set (`dirty-store`, per path) | CodeViewer / `fileSaves` | guard dialog (new), tab dots, close-dirty | Yes (read-only; producer unchanged) |
| Save status / write chains | `file-save-controller` | dialog tags, flush bound, step 8 settle | Yes: needs a "toast suppression while guarding" switch and a "wait for in-flight" query |
| `confirmQuit`/`quitAck`/`quitDialogShown`/`quitDecision`/`quitAborted` | host guard / renderer | renderer / host guard | Yes |
| `before-quit` → teardown | window-all-closed, electron-updater (`quitAndInstall`, `autoInstallOnAppQuit`) | teardown + `flushStateSync` | Yes. An ordinary guarded quit with a staged update installs after the guard (the installer runs on `quit`) |
| File writes (`writeFile` IPC) | Save All / flush | host path-guard write (`src/file-service.ts` temp+rename) | Yes (I4) |
| Session removal → `closeSession` docs + `releaseFileTab` | `kill`, `moveSessionToWindow` | renderer docs reducer (discards dirty) | Consumer unchanged; **both producers gated** in the renderer before posting. Any other host-side removal is assumed not to exist (D11) |
| `beforeunload` save-all | renderer | host `writeFile` | Yes (removed under Electron) |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Second close/quit trigger while a dialog is open | No second dialog; focus the asking window and re-probe it (same `requestId`); a renderer with no live dialog for that id answers Cancel (I2, B1b). |
| Taskbar "Close all windows" | The second close is queued behind the first and runs without a second click (S4). |
| Update click during a pending window-close guard | Queued; runs after it settles. |
| Two windows dirty on quit | Asked in turn. Cancel in window 2 → `quitAborted` to window 1, which unlocks. Its Save All writes stay saved; its Don't Save buffers are untouched. |
| Window opened / closed / torn out mid-guard | New windows appended and asked; destroyed ones skipped. |
| Same file dirty in two windows | Independent buffers: each window lists it. |
| Split-editor: file in both groups | Counted and listed once. |
| Another confirm already open (hunk discard, close-dirty, "Terminal exited") | The guard dialog replaces it and the displaced one is settled as Cancel. Conversely, a confirm opened while the guard dialog is up (e.g. the automatic "Terminal exited") displaces it, which settles the ask as Cancel. One modal slot for all 12 openers (B1a). |
| Save All while a save is in flight for that path | Joins the chain (auto-save E1); success only when the path is clean. |
| Save All partially fails (EACCES, path-guard refusal, deleted parent) | Dialog stays and lists only the failed paths with reasons. |
| Save All hangs (network drive) | "Saving…"; Save All / Don't Save disabled, **Cancel enabled** and aborts. No auto-proceed. |
| A listed save finishes while the dialog is open (late auto-save) | The row shows "Saved" and stays; the user still chooses. Save All then saves only the remainder. |
| Flush exceeds 5 s | Dialog opens with the still-dirty paths. |
| Conflicted path | Listed "changed on disk"; Save All force-writes (D3). |
| Seed-only dirty (`edited:false`) | Listed "not edited" (D4). |
| Truncated doc dirty | Listed "partly loaded, can't be saved"; Save All skips it; only Don't Save or Cancel get past (D13). |
| Dirty path with no save entry | Listed "can't be saved here"; same rule (unlike the palette, C12). |
| 0 / 1 / many | 0: no dirty dialog. 1: "…the changes you made to a.ts?". >10: 10 rows + "and N more". |
| Same basename twice | Each row shows the root-relative directory. |
| Bulk session close | One dialog; with more than one session, rows are grouped under session names. |
| Session already exited ("Terminal exited" path) | Subline "“S” has exited. Closing it closes its tabs." (no running line). |
| Renderer never ACKs / reloading / not yet subscribed | Proceed after 3 s (logged). A close of a freshly spawned window may therefore take up to 3 s. |
| Renderer ACKs, then throws or wedges before a dialog | Proceed after 12 s (logged). |
| Renderer crashes / window destroyed mid-ask | Proceed for that window. |
| Renderer unresponsive with a dialog up | Native Wait / Close anyway (D5). |
| Cancel on app quit | As before the attempt: `isQuitting` false, no grant, PTYs alive, update pending, scrims gone. |
| `quitAndInstall` doesn't quit (no staged file) | Grant expires in 5 s; `quitAborted`; app carries on. |
| Browser preview (no host) | No guard; `beforeunload` save-all kept. |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Prompt on dirty quit/close/move | Always | No | Data loss. VS Code has no switch (hot exit is its alternative, D6). |
| Gate by `confirmCloseRunning` | Never for dirty files | No | That setting is about terminals. |
| Flush auto-save first | Yes, 5 s bound | No | Parity; keeps quit snappy. |
| Save All write kind | `force` for conflicts, `manual` otherwise | No | The user saw "changed on disk" and chose Save (D3). |
| Default focus | Save All in the dirty dialog; Cancel stays in the session-only dialog | No | Saving is non-destructive (D9). |
| Liveness / post-ACK / write-settle / grant timeouts | 3 s / 12 s / 5 s / 5 s | No | §2.3. |
| List cap | 10 rows + "and N more"; list max-height with its own scroll | No | Dialog never exceeds the viewport. |

## 6. Scope slicing

- **MVP:** everything in §2.2–§2.3: `before-quit` grant + idempotent teardown; app guard (ordered,
  snapshot + appended windows, scrim/`quitAborted`); window guard for every closing window;
  protocol with `requestId`, `quitAck`, post-ACK timeout; the `unresponsive` native fallback;
  renderer flush → dirty dialog (tags, running/update lines, re-prompt on failure); session close
  and move gating; `beforeunload` save-all removed under Electron; ConfirmDialog Enter fix, focus
  trap/restore and labelling.
- **v1:** per-file "Save" in the list.
- **Vision:** hot exit; OS shutdown handling.
- **Out of scope:** renderer reload losing buffers; plan-comment / review-note drafts (D14).

## 7. Acceptance criteria

**Declarative**
- A1. Every trigger in §2.2 with a dirty buffer shows the dirty dialog before anything is torn
  down: terminals still running, no "Terminal exited" prompt (C3 gone).
- A2. Save All writes every listed file, then the close proceeds; disk holds the edits.
- A3. Don't Save proceeds and writes nothing new (the `beforeunload` race is gone).
- A4. Cancel leaves app, windows, sessions and buffers as before; a later session change still
  persists to `sessions.json` (I1).
- A5. A window with running sessions *and* dirty files shows exactly one dialog.
- A6. With auto-save on and a file that saves cleanly, quit shows no dirty dialog and the edit is on disk.
- A7. A failed save keeps the dialog open with its reason; the app does not quit.
- A8. No renderer state can block quit: no ACK → 3 s; ACK and no dialog → 12 s.
- A9. Closing or moving a session that owns a dirty tab prompts, even with `confirmCloseRunning` off.
- A10. Enter activates only the focused button.

**EARS**
- E1 (Event): When a quit, window close, update relaunch, session close or session move is
  requested and the affected scope has a dirty path, the renderer shall show one dialog listing them.
- E2 (Unwanted): If any listed path is still unsaved after Save All, the close shall not proceed.
- E3 (State): While a close guard is pending, the host shall not run quit teardown.
- E4 (Unwanted): If a window doesn't ACK within 3 s, or shows no dialog within 12 s of its ACK,
  the host shall treat it as proceed and log it.
- E5 (Event): When the user cancels in any window during an app quit, the host shall abort the
  quit and unlock every window.
- E6 (Optional): Where auto-save is not `off`, the renderer shall flush pending saves (≤ 5 s)
  before deciding whether to show the dirty dialog.

**Gherkin (smoke, hidden app; the dialog is in-app so Playwright drives it)**

```gherkin
Scenario: Quit with a dirty file, Save All
  Given a shell session with "a.ts" open and "EDIT" typed, auto-save off
  When the last window is closed
  Then one dialog "Do you want to save the changes you made to a.ts?" lists "a.ts"
  And it says the running sessions will be stopped, and the session is still running
  When the user clicks "Save All"
  Then the app exits and "a.ts" on disk starts with "EDIT"

Scenario: Don't Save
  When the window is closed and the user clicks "Don't Save"
  Then the app exits and "a.ts" on disk is unchanged

Scenario: Cancel keeps everything
  When app.quit() is called and the user clicks "Cancel"
  Then the window is open, the session is running, "a.ts" is still dirty
  And no "Terminal exited" dialog is shown
  And opening a second session afterwards is persisted to sessions.json

Scenario: Auto-save clears the way
  Given auto-save "afterDelay" 1000 ms and "EDIT" typed just now
  When the window is closed
  Then only the session dialog appears and, after Quit, "a.ts" contains "EDIT"

Scenario: Save failure re-prompts
  Given the host writeFile handler returns { ok:false }
  When the user quits and clicks "Save All"
  Then the dialog stays, lists "a.ts" with "save failed", and the app is still running

Scenario: Conflicted file
  Given "a.ts" is dirty with auto-save on and changed on disk by another process
  When the user quits
  Then "a.ts" is listed "changed on disk", and "Save All" writes the buffer

Scenario: Non-last window, dirty only
  Given two windows; window 2 has a dirty file and only an exited agent session
  When window 2 is closed
  Then the dirty dialog appears in window 2 and window 1 is untouched

Scenario: Session close / move with a dirty tab
  Given confirmCloseRunning is off and "a.ts" is dirty in session S
  When S is closed from the rail (or moved to a new window)
  Then the dirty dialog appears; "Cancel" keeps S and its dirty tab where they were

Scenario: Update relaunch through the guard
  Given a staged update (quitAndInstall spied) and a dirty "a.ts"
  When "Relaunch & update" is clicked and the user clicks "Cancel"
  Then quitAndInstall was not called; after "Save All" it was called once

Scenario: Two windows, second cancels
  Given windows 1 and 2 each have a dirty file
  When app.quit() is called, window 1 answers "Save All", window 2 answers "Cancel"
  Then both windows are open and usable, window 1's file is saved, window 2's still dirty
```

**Unit (no Electron):** host guard machine: ordering, cancel restores every flag, grant expiry,
teardown once, re-entrancy/queueing, appended/destroyed windows, each timeout, `unresponsive`
with an injected native dialog (Playwright can't drive native dialogs, CLAUDE.md). Copy function:
0/1/many, overflow, tags, reasons, plurals. ConfirmDialog: Enter per focused button.

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Dirty dialog | ready | Title "Do you want to save the changes you made to N files?" (1: "…to a.ts?"); rows (name, muted dir, tag); "Your changes will be lost if you don't save them."; running line "Quitting will also stop N running agents (M actively working)."; update line "Conduit will relaunch to install the update."; session sublines (§4) | Cancel / Don't Save / **Save All** |
| | flushing (≤ 5 s) | nothing; the dialog appears afterwards or not at all | — |
| | saving | "Saving…" on Save All (static text under reduced motion, spinner otherwise); Save All / Don't Save disabled | Cancel |
| | partial failure / unsaveable | rows cut to what's unsaved, each with its reason in the danger color; title recounts | Save All (retry) / Don't Save / Cancel |
| | row saved late | row tag "Saved" | same |
| | overflow | 10 rows + "and N more" | same |
| "Quitting…" scrim | locked | full-window scrim "Quitting… waiting for another window" | none (unlocks on `quitAborted`) |
| Session dialog (no dirty) | unchanged | today's copy | Cancel / Quit / Relaunch & update |

No button gets danger styling: Save All is primary; Don't Save and Cancel are neutral. The
running line says what is destructive.

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Dirty dialog | Save All, Don't Save, Cancel | click | Enter/Space = focused button only (C9 fix); Esc = Cancel; Tab/Shift+Tab cycle inside; initial focus Save All | none | `alertdialog`, `aria-modal`, `aria-labelledby` title, `aria-describedby` summary line only (rows are read as a list, not dumped into the description) |
| File list | read-only | full path in `title` | not focusable | none | `<ul>` with `aria-label="Unsaved files"`; tag is text in the item, not color only |
| Status | save progress / failure | — | — | — | `aria-live="polite"`: "Saving 3 files", "2 files couldn't be saved" |
| Scrim | none | swallows pointer | swallows keys | none | `aria-busy`, labelled "Quitting" |

## 10. Accessibility & i18n

- **New work (not existing):** `ModalLayer` only stacks and dismisses. It doesn't trap focus or
  restore it. The dialog traps Tab and returns focus to the previously focused element on Cancel.
  `ConfirmDialog` gains `aria-labelledby`/`aria-describedby`.
- Disabled buttons use `disabled`. The focus ring stays visible in forced-colors mode (system
  `Highlight` outline). Contrast comes from existing tokens in all three themes.
- Plurals go through `countNoun` (`src/menu-selection.ts`), including "Saving N files" and the
  recounted title. All copy lives in the pure copy function. English only, like the rest of the app.
- Long names get a middle ellipsis from a JS helper (CSS can't do it), with the full path in
  `title`. Buttons wrap to a second row at narrow widths rather than overflow. No horizontal page
  scroll.
- `.modal__backdrop` already declares `-webkit-app-region: no-drag` (CLAUDE.md topbar rule); the
  scrim must too.

## 11. Design tokens

Reuse `.confirm`, `ModalLayer`, `.btn--primary`. Rows use the muted text token for the directory
and the danger token for failure tags; the scrim uses the existing modal backdrop token. No raw
hex; same in Neon, Aero and light.

## 12. Assumptions

- A1. Electron honors `preventDefault()` in `before-quit`, and a later `app.quit()` re-emits it.
  Documented behavior; **the builder confirms it with a smoke probe first.**
- A2. electron-updater's `quitAndInstall` runs `install()` (spawning the installer), then
  `setImmediate(app.quit)`. The reviewer confirmed this in `BaseUpdater`; not measured.
- A3. `fileSaves.getStatus` tracks `edited`/`conflict`/`failed` in `off` mode too.
- A4. VS Code parity means the prompt behavior with `files.hotExit: off` (D6).

## 13. Decisions Needed

- **[high] D1 — Multi-window quit: one dialog per window, in turn.** VS Code does this; one
  aggregated dialog would need saves routed to other renderers. *Default:* sequential, focused
  first, any Cancel aborts; windows that already answered are locked behind a scrim until then.
- **[high] D2 — `beforeunload` save-all under Electron.** *Amended 2026-09-28 (critic B3):* kept as
  the backstop for every guard give-up path; skipped only when the window answered Don't Save
  (`discarded`). Browser preview unchanged.
- **[high] D3 — Save All on a conflicted file force-writes the buffer** *only when its row carries the
  explicit tag "changed on disk — Save All overwrites it"* (conductor condition, 2026-09-28) (a manual save is a no-op in `conflict`, C11). The alternative is an unsaveable row the
  user can only Don't Save past. *Default:* force.
- **[normal] D4 — Seed-only dirty (not edited) files are listed.** *Default:* listed, tagged "not
  edited". Excluding them is one filter.
- **[normal] D5 — Unresponsive renderer → native Wait / Close anyway box.** Departs from the
  2026-06-16 "no native dialog" decision, but only as a fallback no in-app dialog can serve.
  *Default:* MVP, default Wait.
- **[normal] D6 — No hot exit.** *Default:* prompt; hot exit is vision.
- **[normal] D7 — Timeouts:** flush 5 s, post-ACK 12 s, write-settle 5 s, grant 5 s. *Default:* as listed.
- **[normal] D8 — OS shutdown/logoff not guarded.** *Default:* out of scope.
- **[normal] D9 — Dirty dialog initial focus is Save All.** The session-only dialog keeps Cancel.
- **[normal] D10 — Protocol:** keep `confirmQuit`/`quitDialogShown`/`quitDecision`, add
  `requestId`, `quitAck`, `quitAborted`; the harness echoes the id. *Default:* as stated.
- **[normal] D11 — Session-removal producers.** C5 and C10 are read from source. Only renderer
  `kill` and move are assumed to remove a session with docs. *Default:* gate both; the builder
  greps for any other `postState` removal.
- **[normal] D12 — ConfirmDialog Enter semantics (C9).** *Default:* the focused button only; a unit
  test pins it.
- **[normal] D13 — Truncated / entry-less dirty paths are unsaveable in the guard** (a manual save
  of a truncated buffer would cut the file). *Default:* listed; only Don't Save or Cancel get past.
- **[normal] D14 — Plan-comment and review-note drafts are not guarded.** *Default:* out of scope.

## 14. Amendments (architecture review, 2026-09-28; conductor-locked)

- **B1a / B1b:** one modal slot, where displacement settles as Cancel, and a re-probe of a
  `shown` ask on a repeat trigger. See §2.2, §2.3 and §4.
- **B2:** the unguarded `before-quit` runs `flushStateSync()` before `preventDefault()`. Each
  window's `session-end` also flushes; D8 still means OS shutdown is not guarded.
- **B3:** D2 is amended (see §13).
- **S1:** a session drag-end is gated unless the drop lands at least 8 px inside the source
  window, so edge drops prompt.
- **S2:** a window the host timed out on gets `quitAborted`. Its renderer ends that flow and
  never shows the "Quitting…" scrim.
- **S4:** window closes queue like update clicks.
- **Nit:** the unresponsive box is closed through an `AbortSignal` when a decision arrives first.

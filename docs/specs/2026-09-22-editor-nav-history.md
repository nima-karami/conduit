---
status: active
date: 2026-09-22
supersedes: archive/2026-06-10-f2-chrome-nav.md (Part B — the view-level history model)
---

# Feature Spec: Editor navigation history (VS Code model)

**Tier:** FULL   **Feature type:** UI
**Mode:** autonomous: no human in the loop. Would-be questions are assumptions (§12) or queued
decisions (§13).
**One-line request (external user):** "the back/forward navigation doesn't seem to work, it seems
to switch windows, not where I have navigated so far in code".

This supersedes Part B of the archived `2026-06-10-f2-chrome-nav.md`, the "center view" model where
an entry is `{sessionId, docId|null}` and `null` means the session's Terminal tab. It also delivers
the promise in the archived `2026-08-07-editor-navigation-parity.md` EARS block (line 438): a
cross-file navigation "shall … record the jump in navigation history". That was never built.

## 1. Problem frame

- **Job:** after moving through code (go to definition, following references, jumping around a
  file), return to where I was, at the line I was on, and then move forward again. This is VS Code's
  Go Back / Go Forward.
- **Actors:** the user of one Conduit window, using the keyboard, mouse or trackpad.
- **Success outcomes (observable):**
  - After go-to-definition from `a.ts:12` into `b.ts:40`, Back shows `a.ts` with the cursor on
    line 12 (centered). Forward returns to `b.ts:40`.
  - A jump of more than 10 lines inside one file (Ctrl+End, a click far away, a search hit, a
    same-file definition) can be undone with Back.
  - Switching sessions or clicking a session's Terminal tab adds **no** entry. Back never lands on
    a terminal.
- **Non-goals:**
  - Navigation inside a `<webview>` / web tab (browser history of the guest page).
  - Undo/redo of edits. "Last edit location" (VS Code Ctrl+K Ctrl+Q).
  - Persisting history across an app restart.
  - Drill-level history on the architecture canvas (arch-navigation-hierarchy B). That spec plans
    to reuse `src/nav-history.ts`; see §3 and §13 D1.
  - A history dropdown or long-press list on the Back button.

## 2. Behavior & states

### 2.1 The entry

`NavEntry = { sessionId, doc: DocRef, pos?: { line, column } }`

- `DocRef` identifies the doc by **what it shows**, not by the tab instance: `{ kind, path }`, plus
  the doc id at record time as a fast-path hint. The id alone is not enough, because a
  `commit-diff` preview tab (`commit-diff:@preview`) retargets in place and is re-keyed when
  pinned (`webview/docs.ts:12-18`).
- `pos` is present only for a **text entry**: a `file` doc showing Monaco (code, or raw markdown/
  plan source). It is absent for diff, review, web, git-history, commit-diff, image, PDF, rendered
  markdown, the plan view, and HTML preview. These are **doc entries**.
- Stack cap is 50 (`NAV_STACK_CAP`, unchanged). The oldest entry is evicted first.
- The history is in memory and belongs to **one window's renderer**. Every window has its own
  (§4, multi-window).

### 2.2 Recording rules (producers)

**The "from" side.** Every record resolves "from" in this order, then pushes the target, subject
to coalescing (R4):

- **F1.** The active doc *is* the current entry (same session + doc) → update that entry's `pos`
  to the live cursor, captured just before the move.
- **F2.** The active view is a doc that is *not* the current entry → push it first as its own
  entry, with its cursor. This happens when you reach a doc by something that doesn't record: a
  session switch, the tab activated after a close, or launch restore.
- **F3.** The active view is a Terminal tab, or there is no doc → no "from" side. Only the target
  is pushed.

**The "to" side.** Its `pos` is the staged reveal target when there is one (goto, search hit,
hunk). Otherwise `pos` is left **absent** until F1 fills it when the doc is left. The restored
view-state cursor of an unmounted doc isn't known at record time.

**One record per move.** A cursor change made by an R2 producer's own `setPosition`, or by a
viewer consuming a staged reveal (`code-viewer.tsx` onMount ~281 and live subscribe ~579), never
also fires R3. The producer that staged or made the move has already recorded it, or deliberately
hasn't, in the apply case. The mechanism for this: a programmatic/reveal move is tagged, and the
R3 listener ignores the tagged event. This does not depend on timing.

| # | Trigger | Records? |
|---|---|---|
| R1 | A user-initiated activation of a *different* doc: tab click, tree / quick open / palette / terminal-link / md-link / recent / reopen-closed-tab / review jump-to-hunk / search-result open, Ctrl+Tab cycling | Yes: "from" per F1–F3; "to" = new doc, with `pos` per the "to" rule above |
| R2 | Go to Definition / Type Definition / Implementation, picking a result in a peek or references widget, Ctrl+click, breadcrumb symbol jump, **same file or cross-file** | Yes, before + after, even within one file (subject to R4). A same-file peek/references pick is moved by Monaco internally (the opener returns `false` for the current model, `monaco-opener.ts:37`), so R3 covers it. Under R4 the result is the same. There is no code outline panel (grep: only `markdown-toc.tsx`, which is rendered markdown, A8) |
| R3 | A single cursor change inside a text doc that moves **more than 10 lines** and is **not caused by an edit** (typing, paste, undo/redo, format, model reload). Examples: mouse click, Ctrl+Home/End, PageUp/Down, Go to Line, find-widget next match, reveal from search | Yes: "from" = the position before the change, "to" = the new position |
| R4 | Coalescing: the new entry is the same doc (`{kind, path}`, amended §2.4), and either side lacks `pos`, or the lines are within **10** of each other | **Replaces** the current entry's `pos` (with the new one, when the new one has a `pos`). No push, and forward history is **not** truncated |
| — | Arrow keys, typing, any cursor delta ≤ 10 lines, scrolling (no cursor move) | No |
| — | Session switch (sidebar, palette, shortcut). The active doc changing because of it | No |
| — | Clicking or activating a session's **Terminal** tab | No |
| — | Automatic activation: closing the active tab activates a neighbour, launch restore, a doc re-keyed (pin), a session moved to another window | No |
| — | Applying a history entry (Back/Forward) | No, and it must not trigger R1/R3 as a side effect |

R3 is judged **per cursor event** against the previous cursor position. That is why holding Down
never records, even over 50 lines (§12 A3). R3 listens only to the CodeViewer's main editor.
Cursor moves inside a peek widget's embedded editor, a diff editor, or a plan code block never
count. *Amended 2026-09-23 (QA ruling):* an Undo/Redo that moves the cursor far is an edit, not an
entry, so Back after it returns to the stop before the undo.

Ctrl+Tab (measured: `app.tsx:792-796` `cycleTab` activates on every press, with no release-commit,
and includes the Terminal stop): each **doc** stop records under R1, and the Terminal stop records
nothing.

### 2.3 Applying an entry (Back / Forward)

0. **Update the departing entry** (not a record: no push, no truncation). If the active doc is
   `stack[index]`, write the live cursor into its `pos`, so Forward later returns to where the user
   actually was.
1. Step the index in the chosen direction, skipping entries that fail the liveness check (§2.4).
   If nothing live is found, do nothing. The buttons would already have shown disabled (§2.5).
   *Amended 2026-09-22 (QA):* Back starts AT the current entry when it is not what is on screen (a
   Terminal tab, Board/Canvas), and a step never lands on an entry already on screen (same doc,
   within the R4 window). It skips it and keeps stepping, so no press looks dead.
2. If the entry's session is not the active one, switch to it. This is allowed: it is where the
   user navigated.
3. Resolve the doc:
   - An open doc matches `DocRef` → activate it.
   - Else, for a `file` entry whose file still exists → reopen it in the entry's session as a
     **preview** tab (same mode as a nav-opened file).
   - Else the entry is dead: remove it and continue stepping in the same direction (step 1).
4. Put the center view on `editor` (Back from Board/Canvas must show the doc, not activate it
   behind the board).
5. Position:
   - The target doc is already active (same-file entry) → `setPosition` + `revealLineInCenter` +
     focus the editor.
   - Another tab, or a reopened one → stage the reveal (`setReveal`) so the viewer puts the cursor
     there on activation. The explicit reveal wins over the saved view state (existing contract,
     `code-viewer.tsx:279-288`).
   - Clamp the line to the model's line count and the column to that line's length. Edits may have
     shifted lines (§12 A4).
6. Announce in the existing polite live region (`navLiveRef`): `Editor: <title>, line <n>`, or
   `Editor: <title>` for a doc entry. The `Terminal: …` label goes away. A text entry recorded
   without a `pos` (left by a session switch) announces the line its editor was left at.
7. Nothing in 2–5 records. The session/doc activation is not a producer call, because producers
   are explicit (§3), and the reveal-driven `setPosition` is a tagged move that R3 ignores (§2.2).
   This holds for the async landings too: the reopen after `pathExists`, and the live-subscribe
   reveal. There is no time-window suppression. A user action after the apply records normally.
8. A text entry whose file is currently shown **rendered** (markdown) lands in the view the tab is
   in. The view is not flipped to source, and `pos` is kept for a later source view.

### 2.4 Liveness (skip rules)

An entry is **live** when:

- its session exists **in this window**, and
- (file entry) a doc for that path is open, or the file exists on disk (host `pathExists`,
  `src/protocol.ts:857`, async). The reply has no request id (`pathExistsResult {path, exists,
  isDir}`, `protocol.ts:585`) and `terminal-links.ts` also consumes it, so it is correlated by
  canonical path. `isDir: true` counts as dead (the host `statSync` reports a directory as
  existing). No reply within 2 s counts as dead (A7). Or:
- (non-file doc entry) an open doc matches `{kind, path}`. Closed non-file docs are **not**
  reopened (§12 A5).

*Amended 2026-09-22 (review):* an entry's identity is `{kind, path}`; its `sessionId` only says
where a closed file reopens. An open doc is live under its current owner whatever session recorded
it (ownership moves on reopen, `docs.ts:43-46`), so the same doc recorded under two sessions is one
place for R4, F1 and "on screen".

The disk check is async, so Back can't pre-filter the whole stack synchronously. Sync liveness
(session + open doc) gates the step. A file entry that is not open is *tentatively* live, and the
existence probe runs during the apply (§2.3 step 3). A failed probe removes the entry and steps on.
One press still lands on exactly one live entry, or none.

### 2.5 States (whole feature)

| State | Back | Forward |
|---|---|---|
| Empty (launch, new window) | disabled | disabled |
| One entry | disabled | disabled |
| At tip, ≥2 entries | enabled | disabled |
| Mid-stack | enabled | enabled |
| At bottom | disabled | enabled |
| Every entry in a direction is dead (sync check) | disabled in that direction | — |
| Applying (existence probe in flight) | a second press queues behind the first; it does not start a parallel apply | same |

"Enabled" uses sync liveness. A direction whose only candidates are unopened files that turn out to
be deleted can show enabled, and then a press does nothing. §4 covers this.

### 2.6 Current behavior (measured vs assumed)

| Claim about today | How measured | Status |
|---|---|---|
| Entries are `{sessionId?, docId\|null}`. There is no position field. Cap 50, browser-style truncate | Read `src/nav-history.ts`; ran `npx vitest run test/unit/nav-history.test.ts`: 14/14 pass, including "treats different docId in same session as distinct" and the cap tests | Measured (unit) |
| Every change of the active `{sessionId, docId}` records, including session switches and Terminal-tab activation | `webview/use-nav-history.ts:25-35`: an effect on those deps, so recording is derived from state and not tied to user intent | Source inspection → **ASSUMED** at runtime |
| Go-to-definition cross-file drops line/col from history. A same-file jump calls `setPosition` and records nothing | `webview/ts-nav.ts:399-416` `openLocation`, `webview/monaco-opener.ts`: reveal only, no history call | Source inspection → **ASSUMED** at runtime |
| `applyNav` switches session + tab and never restores a cursor or center view | `webview/app.tsx:2353-2364` | Source inspection → **ASSUMED** at runtime |

The runtime claims get measured by the builder's red-first e2e (§7 AC1–AC3 fail on today's build).
That run is the measurement. See §13 D4.

## 3. Data / interface contract

- **Pure module** (`src/nav-history.ts`, rewritten; still pure + unit-tested):
  `NavEntry`, `NavState { stack, index }`, and operations for:
  - `record(state, from?: pos, to: NavEntry)` → updates current `pos`, applies R4, truncates
    forward, pushes, caps
  - `back/forward(state, isLive)`
  - `canBack/canForward(state, isLive)`
  - `drop(state, index)` → removes one dead entry and fixes the index
  - `coalesces(a, b)` → R4 predicate (same session + same doc + |Δline| ≤ 10, true for two doc
    entries with no `pos`)

  Exact signatures are left to the plan.
- **Invariants:**
  - `-1 ≤ index < stack.length`, and `stack.length ≤ 50`.
  - No two *adjacent* entries coalesce.
  - Applying changes the stack in only two ways: `drop` of dead entries, and the departing
    entry's `pos` update (§2.3 step 0). It never pushes or truncates.
  - The index moves only via back/forward/record/drop.
- **Recording API** (renderer, replaces the effect in `use-nav-history.ts:25-35`): an imperative
  `recordNav(from, to)` / `recordJump(...)` seam called by the producers in §3.1. The
  state-watching effect is removed. Recording driven by activation state is the defect.
- **Errors:** none surface to the user. A dead entry is dropped silently, and the live region
  announces only where Back actually landed.

### 3.1 Producers / consumers

| Data / state | Produced by | Consumed by | Both in scope? |
|---|---|---|---|
| History entries (doc activation) | `app.tsx` open paths (`openFile`, `openDiff`, `openWeb`, `openMatch`, `jumpToHunk`, reopen-closed-tab, tab click, Ctrl+Tab) → `recordNav` | `useNavHistory` → `applyNav` | Yes |
| History entries (code jumps) | `ts-nav.ts` `openLocation` (same + cross-file), `monaco-opener.ts` `openCodeEditor`, breadcrumb jump (`breadcrumb-bar.tsx:186`), Ctrl+click (`code-viewer.tsx` ~385) | same | Yes |
| History entries (R3 big cursor moves, and the "from" cursor) | `code-viewer.tsx` `onDidChangeCursorPosition` (already exists for breadcrumbs at ~391) | `recordNav`. The "from" position is read from the live editor, or from the last published cursor for that path | Yes |
| Reveal target (`setReveal`/`takeReveal`/`subscribeReveal`) | `applyNav` (new producer), plus the existing search/goto/hunk producers | `code-viewer.tsx` mount + subscribe, `markdown-viewer.tsx` | Yes. The new producer must obey the existing "reveal wins over saved view state" rule. It must also not make the viewer's reveal-driven `setPosition` count as an R3 jump (the apply's suppression covers it) |
| Session activation (`activeId`) + `switchSession` ordering | `applyNav` | `docsReducer` `activate`/`switchSession` (guarded by `test/unit/docs.test.ts:657`) | Yes. The activate-before-switchSession order must be kept |
| Nav inputs → `goBack`/`goForward` | buttons, Alt+Arrows, X1/X2 (non-Windows DOM path), Windows `appCommand` (`electron/main.ts:987` → renderer), palette | `navBack`/`navForward` (modal-guarded) | Yes. The **palette** calls `goBack` directly (`app.tsx:2618-2624`), bypassing `isAnyModalOpen`, because the palette is itself the open modal. The rewire must keep that, or palette Back gets swallowed |
| `pathExists` round-trip | `applyNav` (new consumer) | host `pathExists` handler (existing, read-only) | Producer unchanged. It is safe because the existing handler is a pure read |
| `src/nav-history.ts` exports | this spec | the app **and** the planned arch-navigation-hierarchy (B), which says it "reuses `src/nav-history.ts`" | **No.** B has no code consumer today (grep: only `app.tsx`, `use-nav-history.ts` and the unit test import it). Changing the entry shape would break B's plan → §13 D1 |

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Rapid Back presses / X1 auto-repeat | Applies run one at a time. Each press moves at most one live entry. No double-apply, no skipped entry, no stray record from an earlier apply's reveal |
| Back while a go-to-definition is in flight | Back applies. When the late definition result arrives, it records as a new jump from wherever the cursor is then (it is a user-initiated nav) |
| Empty history / one entry | Buttons disabled. Inputs do nothing: no error, no browser-back |
| Cap exceeded | Oldest evicted. Back from the tip reaches exactly the 50 most recent |
| Entry's session killed | Skipped (sync liveness) |
| Entry's doc closed, file exists | Reopened as a preview tab in the entry's session, cursor at `pos` |
| Entry's file deleted or renamed | Probe fails → entry dropped, stepping continues. A rename is not tracked (§12 A6) |
| Non-file doc closed (diff, review, web, commit-diff…) | Skipped, not reopened |
| `commit-diff` preview retargeted since recorded | The `{kind, path}` no longer matches → skipped, unless a pinned doc for that path is open, in which case that doc is used |
| File edited so `pos` is past EOF or mid-line | Clamped to the last line / line length |
| Session moved to another window ("Move to window…") | Its entries in the source window go dead and are skipped. The destination window's history does not inherit them |
| New window / torn-out window | Starts empty. History is **per window** and never shared or synced |
| Binary / image / PDF / rendered markdown / plan view | Doc entry, no `pos`. R3 does not apply (no Monaco cursor). Switching to a markdown file's raw source is not an entry |
| Same doc open in two sessions? | Not possible (ownership transfers on reopen, `docs.ts:43-46`), so `{kind, path}` alone identifies it (amended, §2.4) |
| Back / Forward while a modal or overlay is open | Swallowed (existing `isAnyModalOpen` guard, unchanged) |
| Alt+Left/Right with the terminal focused | Ignored as today (`decide-shortcut.ts`; `shortcut-precedence.e2e.mjs` still guards it). X1/X2 and the top-bar buttons still work from a focused terminal and move focus to the editor |
| Webview guest focused | X1/X2 ignored (existing `guestFocused` gate) |
| An entry is the same doc and within 10 lines of what is on screen | Passed over; the step continues to the next entry (amended 2026-09-22, §2.3 step 1) |
| Back from a Terminal tab or Board/Canvas | Lands on the current entry first (amended 2026-09-22, §2.3 step 1) |
| History entry for the active doc but a Board/Canvas center view | Center view switches to `editor` |
| Launch restore of tabs/sessions | Records nothing, so Back is disabled at launch (keeps the R5.2 behavior) |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Significant-jump threshold | 10 lines | No | VS Code's value. Users of this feature expect parity |
| Coalesce radius | 10 lines, same doc | No | Same as above |
| Cap | 50 | No | Unchanged. Bounded memory per window |
| Reopen mode for a closed file | preview tab | No | Matches how nav-opened files open. Avoids tab pile-up |
| Scope | per window, in memory | No | Session↔window ownership is per window. Persisting it is a separate feature |
| Focus after apply | the editor (text entry); any other landing (image, PDF, rendered markdown, diff…) leaves focus where it is, so repeated Back clicks keep working (amended 2026-09-23, QA ruling) | No | VS Code parity. Lets Back be followed by typing |

## 6. Scope slicing

- **MVP (must):** the new entry model (§2.1), R1–R4, apply with cursor restore (§2.3), the
  liveness/reopen/skip rules (§2.4), all five inputs rewired, per-window scope, and removal of the
  session/terminal entries.
- **v1 (should):** clamping, live-region line announcement, center-view switch.
- **Vision (could):** a history dropdown on the Back button, persistence across restart, "last
  edit location", tracking renames.
- **Out of scope:** webview guest history, arch canvas level history (B), cross-window shared
  history.

## 7. Acceptance criteria

All AC are e2e-drivable in the real Electron app on the shared harness (`test/e2e/harness.mjs`).
The new scenario is `test/e2e/editor-nav-history.e2e.mjs`, run hidden.

**Fixtures:** `x.ts`, `a.ts`, `b.ts`, `c.ts`, each ≥ 120 lines. `a.ts:12` references a symbol
defined at `b.ts:40`.

**Reads:**
- Cursor line: the focused `window.monaco.editor.getEditors()` entry's `getPosition()`, the handle
  `test/e2e/goto-matrix.mjs:348-350` already uses.
- "Visible": `getVisibleRanges()` contains the line.
- Active tab: `.tabbar [role="tab"].tab--active` (as in `mouse-nav.e2e.mjs`).
- Button state: the `disabled` attribute.

Each scenario starts from a fresh app with **no tabs restored and no preview tab open**.

1. **AC1: cross-file goto.**
   - Open `a.ts` and set the cursor to line 12 on the symbol. Press F12 → `b.ts` active, cursor 40.
   - Alt+Left → `a.ts` active, cursor 12, visible.
   - Alt+Right → `b.ts`, cursor 40.
2. **AC2: same-file big jump.**
   - Open `x.ts`, then `a.ts`. Click line 5. Press Ctrl+End (line ≥ 120).
   - Alt+Left → `a.ts` still active, cursor 5, visible.
   - Alt+Left again → `x.ts`.
3. **AC3: session switches are not entries.**
   - Launch with sessions S1 and S2 and no docs. Back is disabled.
   - In S1, open `a.ts`. Switch to S2 via the sidebar, then back to S1 via the sidebar. Back is
     **disabled** (one entry: `a.ts`).
   - Open `b.ts` in S1. Back → `a.ts` (S1). Back is now disabled: no terminal or S2 stop was
     recorded.
4. **AC4: the Terminal tab is not an entry.**
   - `a.ts` → click the Terminal tab → click the `b.ts` tab (open it via the tree first).
   - One Back from `b.ts` lands on `a.ts`, not on the terminal.
5. **AC5: small moves coalesce.**
   - Open `x.ts`, then `a.ts` (cursor line 1). Click line 8, then 14, then 20 (each step ≤ 10
     lines, so every step coalesces).
   - One Back lands on **`x.ts`**.
   - Forward → `a.ts`, cursor 20 (departing-entry update, §2.3 step 0).
6. **AC6: arrows don't record.**
   - Open `x.ts`, then `a.ts` (cursor line 1). Press ArrowDown 30 times.
   - One Back lands on `x.ts`, not on `a.ts:1`.
7. **AC7: a closed file reopens.**
   - `a.ts:12` → F12 into `b.ts` → close the `a.ts` tab.
   - Back → `a.ts` is open and active, has `.tab--preview`, cursor 12.
8. **AC8: a deleted file is skipped.**
   - Open `a.ts` → `b.ts` → `c.ts`. Close the `b.ts` tab and delete it with `fs.unlinkSync` from
     the harness.
   - One Back from `c.ts` lands on `a.ts`. One Forward from `a.ts` lands on `c.ts`.
9. **AC9: a cross-session entry.**
   - Open `a.ts` in S1. Switch to S2 and open `c.ts`.
   - Back → the active session is S1 with `a.ts` active (the recorded doc, preserving
     `docs.test.ts:657`).
10. **AC10: a dead session is skipped.**
    - Continue from AC9 at `c.ts` (S2), with a `b.ts` entry in S1 before `a.ts`.
    - Kill S1. Back is disabled, or else lands on an S2 entry. It never lands on an S1 doc.
11. **AC11: applying doesn't record.**
    - After AC1's Alt+Left / Alt+Right, repeat Alt+Left then Alt+Right 5 times. Forward is
      disabled at `b.ts`.
    - From `b.ts`, exactly one Back reaches `a.ts` and a second Back is disabled. No entries were
      added.
12. **AC12: rapid presses.**
    - With `x.ts` → `a.ts` → `b.ts` → `c.ts`, press Alt+Left 3 times with no awaits in between.
    - It lands on `x.ts` with nothing skipped: Forward ×1 → `a.ts`.
13. **AC13: every input.** Each of the following performs AC1's return, and the button's
    `disabled` attribute matches at launch, after one nav, and at the tip:
    - the top-bar Back button
    - Alt+Left
    - the palette "Go back" command
    - on Windows, `electronApp.evaluate(({BrowserWindow}) =>
      BrowserWindow.getAllWindows()[0].emit('app-command', {}, 'browser-backward'))` through the
      real host path (`electron/main.ts:987`)
    - on non-Windows, a synthesized button-3 `auxclick`. The DOM thumb path is gated off on
      Windows (`app.tsx` ~2398), so this branch is platform-conditional.
14. **AC14: Board view.** With the Board open over the center, Back shows the editor with the
    target doc active. *Amended:* the first Back lands on the doc behind the Board, the next on
    the entry before it.
15. **AC15: focus and announcement.**
    - With the terminal focused, click the top-bar Back button → the editor has focus.
    - The `role="status"` live region reads `Editor: a.ts, line 12`. *Amended:* from the Terminal
      tab at `b.ts`, the first Back lands on `b.ts` (`Editor: b.ts, line 40`), the second on
      `a.ts:12`.
16. **AC16: existing guards stay green.**
    - `shortcut-precedence.e2e.mjs`: Alt+Arrow in the terminal is a no-op.
    - `mouse-nav.e2e.mjs`: its Alt+Arrow traversal across opened docs holds under R1.
    - An assertion that relied on session or terminal entries gets rewritten to the new model,
      never deleted.
17. **AC17: unit.** The pure module covers:
    - R4 coalescing: Δ10 coalesces, Δ11 pushes; a pos-less side always coalesces.
    - Coalescing never truncates forward history.
    - F1/F2/F3 "from" resolution.
    - The departing-entry update on step.
    - `drop` index repair.
    - The cap.
    - Skip-dead in both directions.

Needs-human-smoke (same as today): only the **physical** X1/X2 press and the OS delivery of
`app-command`. The host→renderer app-command path is covered by AC13.

### EARS

- *Event-driven:* When a navigation command (definition, type definition, implementation,
  reference pick, Ctrl+click, breadcrumb jump) moves the cursor, the system shall record
  the prior cursor location and the target location in navigation history.
- *Event-driven:* When the user activates a different document, the system shall record the prior
  document's cursor and the newly active document.
- *Event-driven:* When a single non-edit cursor change moves more than 10 lines, the system shall
  record the prior and new positions.
- *State-driven:* While a new entry is within 10 lines of the current entry in the same document,
  the system shall replace the current entry's position instead of adding an entry.
- *Unwanted:* If a history entry's session no longer exists in this window, or its file no longer
  exists, then the system shall skip and remove it and continue in the same direction.
- *Ubiquitous:* The system shall not record session switches, Terminal-tab activations, automatic
  activations, or the application of a history entry.

### Gherkin (AC1)

```gherkin
Scenario: Back returns to the line I jumped from
  Given a.ts is open with the cursor on line 12
  When I press F12 on a symbol defined at b.ts line 40
  And I press Alt+Left
  Then a.ts is the active tab
  And the cursor is on line 12 and visible
  When I press Alt+Right
  Then b.ts is the active tab with the cursor on line 40
```

## 8. State catalog (UI)

| Component | State | What the user sees | Action |
|---|---|---|---|
| Top-bar Back/Forward | enabled / disabled per §2.5 | existing quiet-role ladder (`interaction-state-vocabulary`), no new visuals | click → apply |
| Editor | after apply | the target tab active, the cursor line centered, the editor focused | — |
| Tab strip | reopen | the reopened file as an italic preview tab | — |
| Live region | after apply | (SR only) "Editor: b.ts, line 40" | — |

There are no loading or error visuals. The existence probe is a local fs check, a few milliseconds
(§12 A7).

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Back / Forward | go back / forward | click. X1/X2 anywhere except a focused webview | Alt+Left/Right (not in terminal), palette "Go back/forward" (`app.tsx` ~2622) | none (no change) | existing `aria-label`s, native `disabled` |
| Windows | same | OS app-command (host forwards `appCommand`) | — | — | — |

No new shortcuts, and no bindings change.

## 10. Accessibility & i18n (UI)

- **Keyboard:** the whole feature is reachable by keyboard (Alt+Arrows, palette). Focus lands in the
  editor after apply, so no focus is lost to `body`.
- **Screen reader:** the existing `role="status" aria-live="polite"` region announces the landing
  doc and line. It is not announced when nothing moved.
- **Disabled state:** native `disabled` on the buttons (already there). It must track the new
  `canBack`/`canForward`.
- **Reduced motion:** `revealLineInCenter` uses Monaco's default (no smooth scroll is configured).
  Nothing new animates.
- **i18n:** the app has no i18n layer. The new strings ("line", the existing "Editor:") are
  English, next to the existing labels. The line number is formatted as a plain integer.
- **RTL:** Back is Alt+Left regardless of direction (VS Code parity). No mirrored icons.

## 11. Design tokens (UI)

None new. The buttons keep their existing quiet-role tokens. No visual change.

## 12. Assumptions

- **A1:** "Doc switch" producers are the explicit user paths in §3.1. An activation caused by
  closing a tab is automatic and does not record (VS Code: closing an editor then going Back
  reopens it, which §2.3 provides).
- **A2:** Moving a session to another window does not carry its history. Per window is acceptable
  (conductor-allowed).
- **A3:** R3 is judged per cursor event (delta from the previous cursor). PageUp/PageDown count
  when a page is > 10 lines. Find-widget "next match" counts.
- **A4:** Positions are not tracked through edits. They are clamped on apply. VS Code tracks
  through decorations. That is deferred to the vision tier.
- **A5:** Closed non-file docs (diff, review, commit-diff, web, git-history) are skipped, not
  reopened. They may carry transient state (review source, preview target) that can't be rebuilt
  faithfully.
- **A6:** A renamed file's entries die (the probe fails on the old path). They are not re-pathed.
- **A7:** The existence probe (`pathExists`) replies quickly enough that no in-flight UI is needed.
  If it has not replied after 2 s, treat the entry as dead.
- **A8:** Rendered markdown, the plan view, HTML preview and PDF are doc entries without `pos`. A
  jump inside them (TOC click, PDF page) is not recorded.
- **A9:** A reopened file opens as a preview tab and may replace the current preview tab. This is
  the existing preview semantics.

### Known limitations

- **L1 (rendered file views):** a `file` doc shown without Monaco (rendered markdown/HTML, image)
  has no live cursor and consumes no reveal, so its current entry has no `pos`. Same-file text
  stops then coalesce with it and are treated as on screen: Back can pass over them, or re-land
  on the file without a visible move.
- **L2 (button state):** Back/Forward enablement is computed when the app renders, and a cursor
  move alone does not re-render it. Crossing the 10-line window around a same-file neighbour stop
  can leave a button state stale until the next render; a press still steps correctly.
- **L3 (edit then API move):** an edit that moves no cursor (forward Delete) marks the next
  non-Explicit cursor move as an edit. If that move is an API jump (same-file F12, find next,
  peek pick) more than 10 lines away, it is not recorded. A click or keyboard move is unaffected.

## 13. Decisions Needed

- **D1 [normal]** — The arch-navigation-hierarchy spec (B) plans to reuse `src/nav-history.ts` for
  canvas drill levels. This spec changes its entry type to editor locations. **Default taken:** the
  stack mechanics (record / truncate / cap / step-with-skip) stay generic over the entry type, and
  R4 coalescing is a predicate the editor supplies. B can reuse the core without editor semantics.
  If that makes the module awkward, B gets its own copy later.
- **D2 [normal]** — Ctrl+Tab activates on every press, with no release-commit (measured,
  `app.tsx:792-796`), so a fast cycle adds one entry per doc stop. VS Code records only the final
  tab. **Default taken:** record each doc stop. Alternative: add a release-commit model to
  `cycleTab`, which is a larger change to tab behavior.
- **D3 [normal]** — Reopening a closed file on Back: preview (default taken) vs permanent tab.
- **D4 [normal]** — The runtime claims in §2.6 come from source inspection, not a run. The
  builder's red-first e2e (AC1–AC4 failing on this branch's base, 3d56a24) is the measurement. If any AC passes
  on the old build, re-read that claim before building on it.
- **D5 [normal]** — Should history survive a renderer auto-recovery (the crash-recover path)?
  **Default taken:** no. It is in memory and starts empty after a reload, like a restart.

## Files expected to change (for the plan; not binding)

- `src/nav-history.ts`: entry model, `record` with from-`pos`, coalescing, `drop`.
- `webview/use-nav-history.ts`: imperative record API. Remove the state-watching effect. Serialize
  applies, suppress recording during an apply.
- `webview/app.tsx`: `isAlive` → the liveness from §2.4, `applyNav` → session + doc resolution +
  reopen + reveal + center view + announce, and the producers wired at the open paths / tab click
  / Ctrl+Tab.
- `webview/ts-nav.ts` (`openLocation`), `webview/monaco-opener.ts`,
  `webview/components/breadcrumb-bar.tsx`: record jumps.
- `webview/components/code-viewer.tsx`: R3 detection in `onDidChangeCursorPosition`, and exposing
  the current cursor for the "from" position.
- Tests: `test/unit/nav-history.test.ts` (rewritten to the new model),
  `test/e2e/editor-nav-history.e2e.mjs` (new), `test/e2e/mouse-nav.e2e.mjs` (adjust to the model).
  `test/unit/docs.test.ts:657` stays as is.
- `CHANGELOG.md` (user-facing fix).

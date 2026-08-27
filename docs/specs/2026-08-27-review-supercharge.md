---
status: active
date: 2026-08-27
---

# Feature Spec: Review supercharge — change decorations, review workflow, hunk staging, agent handoff

**Tier:** FULL   **Feature type:** UI
**One-line request:** "Supercharge the way we can review the changes … in the code editor … I should be able to see the changed lines as an indicator on the scroll map on the right-hand side … look at what we have first and … see what features or sub-features are missing and expand on that."

This is an **epic** sliced into six independently shippable lanes (§6). Lane A is the literal
ask; B–F are the gaps the inventory found. Each lane has its own acceptance block in §7 so a run
can pick one lane, ship it, and archive the row. Order: **A → B → D → E → C → F** (D before E:
hunk staging needs the index baseline D introduces — see §2E).

> Revision 2026-08-27 (post architecture review): patch construction moved host-side and keyed
> by line range; Lane E stages against the index (D now precedes E); reviewed marks split from
> notes (`userData` vs enveloped `.conduit/review-notes.json`); decorations get their own LCS
> budget; change peek deferred to Lane E; search runs over loaded diffs with an explicit
> "search all files"; the terminal buses are unified with liveness.

## 0. What exists (summary — the spec builds on this, doesn't restate it)

| Surface | Today | Gap |
|---|---|---|
| Editor (`webview/components/code-viewer.tsx`) | No git decorations. Minimap off (`:143`). Zero `createDecorationsCollection` / `changeViewZones` usage anywhere in `webview/`. Only git-aware thing: the blame lens. Editor is **editable** (`readOnly:false`). | **Lane A** |
| Review tab (`review-view.tsx`, custom rows, not Monaco) | Working / commit / range sources; working source **streams per card** (windowed), commit/range preload; folds; 40-row cap; navigator; reviewed meter (tab-lifetime only); word diff; Split escape hatch. Keyboard = Escape only. No search. Staged/unstaged deduped by path. | **B, C, D** |
| Monaco diff tab | `DiffControlsBar` + `webview/diff-nav.ts` (`nextChange`/`prevChange`, wrapping, unit-tested) — **reuse for Lane A**. Oversize "Open file" is dead (no caller passes `onOpenFile`). | B fixes it |
| Host git | One runner `src/git-exec.ts` (accepts `stdin`). `GitOp` is file/repo scoped; `GitActionPlan` (`src/git-actions.ts:44`) has no stdin field; `discardTracked` = `git restore --` (revert to **index**). `readDiff` LF-normalises both sides; `review-hunks` strips `\r` and loses the EOF-newline fact — so a renderer-built patch can never be byte-correct. `gitShow` helper at `electron/main.ts:689`. | **D, E** |
| `.conduit/` persistence | ADR 0002 envelope `{conduit, kind, updatedAt, data}` (`src/conduit-store.ts:26-46`, `FILE_FOR` in `electron/conduit-fs.ts:38`); `BoardWatcher` with single-slot self-echo (`src/board-watch.ts`); `.conduit/` is gitignored in Conduit itself (`.gitignore:22`) but not necessarily in a foreign repo. Two windows share one main process (`src/window-registry.ts`). | **B, F** |
| Renderer→terminal | `term.paste()` is private to `terminal-pane.tsx`; `terminal-focus-bus.ts` is a sessionId-addressed bus with no liveness; `mention-bus.ts` targets the active session via raw `term:input`. | **F** |
| Comments | None. | **F** |

Inherited constraints: Review stays plain rows (`review-view.tsx:56`); all git spawns go through
`git-exec.ts`; app-level shortcuts live in `webview/shortcuts.ts` (precedence spec 2026-07-03),
Monaco-scoped ones via `editor.addAction`; `.conduit/` files follow ADR 0002; host/IPC-boundary
work gets a `test/e2e/<name>.e2e.mjs` scenario.

## 1. Problem frame

- **Job:** the user runs agents that change code; they need to *see what changed, judge it, act
  on it (stage / discard / send feedback) and not lose their place* — without leaving Conduit.
- **Actors:** the user (reviewer); the session's agent (Lane F receiver); the host git layer.
- **Success outcomes:**
  - Any tracked file with uncommitted changes shows where they are — gutter, overview ruler,
    minimap — live while editing; next/prev change works.
  - A whole review can be done keyboard-only: hunk→hunk, file→file, mark reviewed, stage/discard
    a hunk, open in editor.
  - Reviewed state survives restart and self-clears when a file changes again.
  - The reviewer can attach notes to lines and hand them to the agent in one action.
- **Non-goals:** side-by-side inside Review (dual gutters + Split were the deliberate answer);
  a blame column; PR/GitHub integration; AI-written review summaries; editing inside Review
  rows; multi-window merge of review state beyond host broadcast; an i18n layer (repo has none).

## 2. Behavior & states

### Lane A — editor change decorations

**Baseline: working tree vs HEAD, always** — the same baseline as Review's *working* source
(All scope), so editor markers and Review agree. VS Code's vs-index default is deliberately not
copied: the question is "what did the agent change", not "what's unstaged". Not configurable.

**Data flow**
1. On `file:` doc mount, on HEAD change (existing HEAD watch → git refresh), and on `fsChanged`
   for that path, the renderer asks `git:headBlob { path }` → `{ path, headSha, text | null,
   reason? }`. Host reuses `readDiff`'s plumbing (`gitShow`, `MAX_BYTES` 2 MB, `toLf`,
   repo-from-file-dir with containment like `git:blame`) — no second `git show` path. The
   toplevel lookup is memoised per directory so one HEAD change with N editors is N `show`s,
   not 2N spawns. Renderer caches `text` per `path+headSha` so split panes don't refetch.
2. Hunks are computed **in the renderer** with `computeFileReview` between HEAD text and the
   live model text: on mount, then debounced **300 ms** after the last edit, and on save. The
   editor gets its **own, smaller cell budget** — `MAX_DECORATION_LCS_CELLS = 250_000` (≈500×500
   changed-region; recomputed on a keystroke debounce it must stay well under a frame) —
   exposed as an option on `computeFileReview`; exceeding it → `degraded`.
3. Pure `hunksToDecorations(hunks): IModelDeltaDecoration[]` (new `webview/change-decorations.ts`,
   unit-tested) emits per hunk: **added** = `linesDecorationsClassName` solid bar + `overviewRuler`
   mark + `minimap` mark; **modified** = dashed bar + marks; **deleted** = triangle on the line
   after the deletion (last line at EOF) + marks; `hoverMessage` "Added 3 lines" etc. Applied via
   one `editor.createDecorationsCollection()` per editor, `.set()` wholesale on recompute,
   `.clear()` on model swap; disposed with the editor. Next/prev reuse `webview/diff-nav.ts`.
4. `minimap: { enabled: true, renderCharacters: false, showSlider: 'mouseover' }` becomes the
   editor default (reverses spec 2026-06-11-minimap — user decision 2026-08-27).

**Next / previous change** — `Alt+F5` / `Shift+Alt+F5` (VS Code parity; free in both
`shortcuts.ts` and Monaco's defaults). Registered via `editor.addAction` (Monaco F1), plus
`PaletteEntry` rows in Conduit's palette (`app.tsx:2106`), plus rows in `buildEditorMenuItems`
(`EditorMenuContext` gains `hasChanges: boolean`), plus rebindable entries in the shortcuts
registry's Editor group. Wraps; announces "Change N of M" via the live region.

**Change peek** (click a marker → view zone with the removed lines + Stage/Discard) is **Lane E**:
it is the codebase's first view zone and only earns its keep with actions.

**States:** `none` (binary / oversize / not a repo / any non-ok `GitResult` — notFound, timeout,
aborted — → no markers, one host log line, no UI error); `loading` (blob in flight → no markers,
no spinner); `live`; `degraded` (budget hit → markers off + one status hint "Change markers off —
file changed too much to line-match"); `stale` (HEAD moved → refetch; old collection held until
the new one is ready). **Untracked file = `live` with one whole-file added hunk.**

### Lane B — Review navigation, keyboard model, persistence, polish

**Scoped keymap** — active only while focus is inside the Review scroller (non-editable surface;
History owns local arrow keys the same way; handled keys stop propagation so nothing reaches
`decide-shortcut.ts`). `?` shows it:

| Key | Action |
|---|---|
| `j` / `k` | next / previous hunk (across files, wraps; scrolls + focuses hunk header) |
| `J` / `K` | next / previous file |
| `m` | toggle reviewed on the current file |
| `o` / `Enter` | open current hunk in the editor (existing `jumpToHunk`) |
| `s` / `d` | stage / discard current hunk (Lane E — absent until it ships) |
| `c` | note on the current hunk's first line (Lane F) |
| `e` / `Shift+E` | expand all / collapse all cards |
| `/` or `Mod+F` | search in diff (Lane C) |
| `Esc` | close peek/search/composer → then close Review (existing) |

"Current hunk" = the hunk header nearest the scroller's anchor (`computeReviewAnchor`); a
visible focus ring marks it; clicking a header also makes it current.

- **Collapse all / Expand all** header buttons; the current file stays in view.
- **Sticky file header** inside each card (`position: sticky`; height cache unaffected).
- **Reviewed marks persist in `userData`** (per-user, per-machine, high-frequency state — the
  same home as `sessions.json`, CLAUDE.md), file `review-marks.json`, atomic write + sync flush
  on quit like sessions. Host holds it in memory and **broadcasts** `review:marks` to every
  window on change (windows share one main process — no FS round trip):
  ```ts
  interface ReviewMarksFile {
    version: 1;
    repos: Record<string /* repo root, posix */, Array<{ source: string; path: string; contentHash: string; at: string }>>;
  }
  ```
  `source` = `'working'` | `commit:<sha>` | `range:<rangeKey>`; `contentHash` = FNV-1a of the
  new-side text (fast, dependency-free; a collision only yields a stale "reviewed"). Mismatched
  hash → ignored and pruned. Newest **2 000 per repo** kept.
- **Source quick-picks** in `CommitPickerMenu`'s pinned rows: *Last commit* (maps onto the
  existing **commit** source for `HEAD` — no new render path) · *Unpushed* · *Since branch
  point*. The latter two need `git:resolveRange { sessionId, preset }` → `{ base, head }` as
  **sha endpoints** (`rev-parse --abbrev-ref @{upstream}`, `merge-base <default> HEAD`; default
  = `origin/HEAD` → `main` → `master`). Resolved to shas rather than a preset-shaped
  `RefEndpoint` so `rangeKey` stays a stable cache key and `git:rangeDiff`'s ref validation
  (`validateCommits`) accepts them. A row is hidden when unresolvable.
- **Fix:** `doc-view.tsx` passes `onOpenFile` to `DiffViewer`.
- **Ignore whitespace** header toggle (persisted `reviewIgnoreWhitespace`, default off):
  `computeFileReview` gains an equality option comparing whitespace-collapsed lines.
- **Load gate:** mark controls are disabled until the first `review:marks` push arrives.

### Lane C — search in diff

- `Mod+F` / `/` with Review focused opens a find bar in the header (CSS Custom Highlight API,
  mirroring `pdf-find.ts`; no row DOM mutation).
- Scope: **loaded diffs** — every hunk line of every *loaded* file, including collapsed cards
  and rows past the 40-row cap, excluding folded unchanged context. Commit/range sources are
  fully preloaded so this is everything; the working source streams per card, so the bar shows
  "n / m in N of M files" plus a **"Search all files"** action that fetches the remaining diffs
  (bounded by the existing per-card loader, progress in the bar). Runs over `FileReview` data,
  not the DOM. Placeholder: "Search changed lines".
- `n / total`; `Enter` / `Shift+Enter` cycle; revealing a match expands a collapsed card or
  lifts the cap, then scrolls via `scrollToFile` + row offset. Case-insensitive; `Aa` toggle; no
  regex. Match list capped at **2 000** ("2 000+").
- **File filter** field in the navigator (fuzzy on path) narrows navigator + cards; `Esc` clears.
- Zero matches → "No matches" inline; bar stays open.

### Lane D — staged / unstaged scoping

- Working source gains **Scope** in `ReviewSourceControl`: **All** (HEAD→worktree, today) ·
  **Staged** (HEAD→index) · **Unstaged** (index→worktree). Disabled for commit/range sources.
- `readDiff` gains `{ base?: 'head' | 'index', side?: 'index' | 'worktree' }` (defaults = today);
  index text via `git show :<rel>` through the same runner and cap.
- Changes-panel Staged / Changes section headers get a Review icon that opens Review pre-scoped.
- Scope is per Review doc, not persisted.

### Lane E — hunk-level stage / unstage / discard (+ editor change peek)

- **Patches are built by the host from git's own diff** — never from renderer text. The renderer
  sends a *line range*, the host selects git's hunks:
  - `stageHunk { path, range }` → `git diff -U3 -- <rel>` (index→worktree); keep hunks whose
    **new-side** span intersects `range.new`; `git apply --cached` (plain — context matching is
    what makes "file changed since" fail safely).
  - `unstageHunk { path, range }` → `git diff --cached -U3 -- <rel>` (HEAD→index); keep hunks
    intersecting `range.new` (index-side lines); `git apply --cached --reverse`.
  - `discardHunk { path, range }` → `git diff -U3 -- <rel>`; keep hunks intersecting
    `range.new`; `git apply --reverse` — i.e. **revert the worktree to the index**, the same
    target as `discardTracked` (`git restore --`).
  `range = { new: [start, end], old: [start, end] }` (1-based inclusive; a pure deletion has an
  empty `new` span and matches by `old`). Pure `selectHunks(diffText, range): string` in
  `src/hunk-patch.ts` (parse `@@` headers, filter, re-emit with the file header) is unit-tested
  on LF, CRLF and no-EOF-newline fixtures with `git apply --check`. `GitActionPlan` gains
  `stdin`. Renderer-side, nothing is trusted: `path` containment + the range is just numbers.
- **Baseline rule:** Stage/Discard act on the **index→worktree** hunks. Under Review's
  **Unstaged** scope the ranges map 1:1. Under **All** (HEAD→worktree) they map 1:1 only when the
  file has no staged side; when it does (`ChangeDTO.staged` exists for the path), the hunk
  buttons read "Switch to Unstaged scope to stage hunks" (disabled, tooltip). Unstage is offered
  only under **Staged** scope. This is why D lands before E.
- **Where:** Review hunk header (Stage / Discard; Unstage under Staged scope), the editor
  **change peek** (below), scoped keys `s` / `d`.
- **Change peek (editor):** click a gutter marker → Monaco view zone (`changeViewZones`) under
  the hunk; React portal into `domNode`, owned by a `usePeekZone` hook that removes the zone and
  unmounts the portal on close / model swap / editor dispose. Shows the removed lines (Review
  row styling), "Change 2 of 5", **Stage · Discard · ↑ ↓ ×**. One at a time; Esc closes and
  returns focus to the editor line. Editor peek actions use the editor's HEAD hunks under the
  same baseline rule (disabled with the tooltip when the file has a staged side).
- **Discard confirms** via `confirm-dialog.tsx`: "Discard this change? 12 lines in `src/foo.ts`
  will be reverted to the index. This can't be undone." [Discard] [Cancel]. Stage/Unstage don't.
- **After any op:** normal git refresh; the card re-requests its diff; the file's reviewed mark
  prunes by hash; the current-hunk index clamps.
- **Conflict:** file changed after the diff loaded → `git apply` rejects (context mismatch) →
  toast "The file changed since this diff was loaded — refreshed." + card reload. No partial
  apply (`git apply` is atomic per invocation); no blind retry.
- Untracked file: Stage = existing `stageFile`.

### Lane F — review notes + agent handoff

- **Model** (`src/review-notes.ts`, pure helpers). Persisted **enveloped per ADR 0002** as
  `.conduit/review-notes.json` — `ConduitKind` gains `'review-notes'`, `FILE_FOR` gains the
  filename, read/write through the existing `conduit-fs` serialise/read helpers + `writeAtomic`:
  ```ts
  interface ReviewNotesData { version: 1; notes: ReviewNote[] }
  interface ReviewNote {
    id: string;            // ulid
    path: string;          // repo-relative posix
    side: 'new' | 'old';
    line: number;          // 1-based on `side`
    anchor: string;        // FNV-1a of the line text + one context line each side
    body: string;          // markdown, ≤ 4 KB
    createdAt: string;     // ISO-8601 UTC
    resolvedAt?: string;
    sentAt?: string;
  }
  ```
  Notes live in-project because the point is that the agent can read them. Bound: **500 per
  repo** (composer refuses with "Resolve or delete some notes first").
- **Sync model:** host holds notes in memory, writes on change, **broadcasts** `review:notes` to
  all windows. The `.conduit/` watcher exists only to pick up **external** (agent) edits, with
  `recordWrite`-style self-echo suppression. The project watcher's `fsChanged` **excludes
  `.conduit/`** (`src/watch-filter.ts`) — `.conduit/` has its own watchers, and without the
  exclusion every note save would reload the Review that wrote it.
- **Re-anchoring** on load and each diff refresh: exact line, else nearest match within **±50**
  lines, else **detached**: listed at the top of the card ("1 note lost its place — was on line
  42: `<first 60 chars>`") with Resolve / Delete. Never silently dropped.
- **Composer:** hover a Review row → `+` in the marker column; click or `c` opens an inline
  composer row. `Mod+Enter` saves, `Esc` cancels (confirm only if non-empty). Notes render as
  thread rows inside the card (height cache invalidated for that path). Actions: Edit ·
  Resolve/Unresolve · Delete (confirms).
- **Editor mirror:** gutter glyph on anchored lines; hover shows the body; click opens Review at
  the note. Read-only in the editor.
- **Handoff:** footer button **"Send to agent (N)"**, N = unresolved + unsent. Pure
  `buildHandoffMarkdown(notes, files)`:
  ```
  Review notes on 2 files (working tree):

  ### src/foo.ts
  - L42 (`const x = …`): <body>

  Please address these and reply with what you changed.
  ```
  Delivery goes through **one terminal bus** — `terminal-focus-bus.ts` becomes
  `terminal-bus.ts`: a sessionId-keyed registry each `TerminalPane` registers into with
  `{ focus(), paste(text), }`, plus `hasLiveTerminal(sessionId)`. Paste = xterm `paste()`
  (bracketed; never raw `term:input`), targeting the **Review doc's session**. No Enter. On
  send: `sentAt` stamped, toast "Sent 4 notes to <session>", count → 0. When
  `hasLiveTerminal` is false the button reads **"Copy as markdown"** with a tooltip saying why.

## 3. Data / interface contract

| Item | Shape | Notes |
|---|---|---|
| `git:headBlob` | `{ path }` → `{ path, headSha: string\|null, text: string\|null, reason?: 'untracked'\|'binary'\|'oversize'\|'notRepo'\|'error', error? }` | `readDiff` plumbing; containment as `git:blame`; LF; 2 MB |
| `git:resolveRange` | `{ sessionId, preset: 'unpushed'\|'branchPoint' }` → `{ base, head } \| { error }` | sha endpoints (stable `rangeKey`, pass `validateCommits`) |
| `readDiff` (ext.) | `{ path, base?, side? }` → `FileDiffDTO` | defaults reproduce today |
| `git-action` new ops | `{ root, op: 'stageHunk'\|'unstageHunk'\|'discardHunk', path, range: { new: [n,n], old: [n,n] } }` | host builds the patch from `git diff -U3`; `GitActionPlan.stdin` |
| `review-marks.json` (userData) | `ReviewMarksFile` | host in-memory + atomic write + quit flush; `review:marks` broadcast |
| `review:marks` / `review:setMark` | `{ root, marks }` / `{ root, mark, on }` | |
| `.conduit/review-notes.json` | ADR 0002 envelope, `kind:'review-notes'`, `data: ReviewNotesData` | absent/invalid = empty; `writeAtomic`; external-edit watch with self-echo suppression |
| `review:notes` / `review:setNotes` | `{ root, notes }` / `{ root, patch }` | host merges, writes, broadcasts |
| `terminal-bus` (renderer) | `register(sessionId, api)`, `focus(id)`, `paste(id, text)`, `hasLiveTerminal(id)` | replaces `terminal-focus-bus.ts` |

Invariants: editor markers equal Review's **All** scope for the same file; a stale-hash mark is
never shown; a patch is built only from git's own diff of the requested path; no `.conduit/`
file is written in a project the user didn't open (ADR 0002); a `.conduit/` write never
triggers a Review reload.

## 4. Edge cases & failure modes

| Condition | Expected behavior |
|---|---|
| Rapid edits (A) | 300 ms debounce; last edit wins; `.set()` atomic; per-recompute cost bounded by the decoration budget |
| HEAD changes with a file open | refetch; old markers held until new ones are ready |
| Same file in two panes | one cached HEAD blob (path+headSha); each editor owns its collection |
| Untracked file | one whole-file added hunk; Stage = `stageFile` (E) |
| Not a repo / binary / > 2 MB / git error or timeout | `none`; one host log line; no UI error |
| Decoration budget exceeded | `degraded`; hint once per doc |
| 0 / 1 / many hunks | `Alt+F5` with 0 → "No changes"; 1 → wraps to itself |
| Search on a streaming working source | "n / m in N of M files" + "Search all files" |
| Search 0 / 10k matches | "No matches"; capped "2 000+" |
| Hunk op races a save | `git apply` context mismatch → toast + card reload; nothing partial |
| File has staged changes, All scope | hunk buttons disabled with "Switch to Unstaged scope" |
| Range intersects two git hunks | both are applied (the user asked for "this change", git's split is an artefact) |
| CRLF / no-EOF-newline file | host patch is git's own bytes → applies; unit fixtures cover both |
| Two windows on one repo | host broadcast; last writer wins |
| Agent edits `review-notes.json` externally | watcher → reload → broadcast; self-writes suppressed |
| Note anchor lost | detached list, never dropped |
| 500 notes reached | composer refuses with guidance |
| Handoff, 0 unsent / no live terminal | disabled + tooltip / "Copy as markdown" |
| Handoff into a TUI in mouse mode | bracketed paste lands; user presses Enter |
| `review-marks.json` / `review-notes.json` corrupt | empty; host log line; next write replaces |
| Actions before first `review:marks` / `review:notes` | controls disabled until loaded |
| Truncated 1 000-file source | search / `j` `k` cover shipped files only |

## 5. Defaults vs. settings

| Decision | Default | Configurable? | Rationale |
|---|---|---|---|
| Decoration baseline | HEAD | no | matches Review All; "what did the agent change" |
| Minimap | on, no characters | `editorMinimap` — Settings › Appearance | user decision 2026-08-27 |
| Change markers | on | `editorChangeMarkers` — Appearance | gutters read as noise to some |
| Next/prev change | `Alt+F5` / `Shift+Alt+F5` | rebindable | VS Code parity |
| Review scoped keys | on | no | non-editable surface; `?` reveals them |
| Ignore whitespace | off | `reviewIgnoreWhitespace` | durable preference |
| Review scope | All | no (per doc) | a fresh review shows everything |
| Budgets | 300 ms · 250k cells · ±50 · 2 000 matches · 2 000 marks/repo · 500 notes/repo | no | inline rationale in §2 |
| Handoff presses Enter | never | no | the user must read what reaches the agent |
| Marks storage | `userData/review-marks.json` | no | per-user, high-frequency, must not touch the reviewed tree |
| Notes storage | `.conduit/review-notes.json` (enveloped) | no | agent-readable; board contract |

## 6. Scope slicing

- **MVP — Lane A + Lane B fixes:** markers (gutter / ruler / minimap), live re-diff, next/prev
  change, minimap default flip, dead "Open file" fix, collapse/expand all.
- **v1:** Lane B keymap + persistence + quick-picks + ignore-whitespace; Lane D scoping; Lane E
  hunk ops + change peek; Lane C search + file filter; Lane F notes + handoff.
- **Vision:** note editing from the editor; agent-filled review checklist; host LRU for
  `git show <sha>:<path>`; Explorer "changed only" filter.
- **Out of scope:** §1 non-goals.

## 7. Acceptance criteria

Each lane names its e2e scenario (`test/e2e/<name>.e2e.mjs`) — every lane crosses the
host/IPC boundary.

### Lane A — e2e `editor-change-markers`
- When a tracked file with uncommitted changes opens, the editor shall show a bar per
  added/modified hunk, a triangle per deletion, and matching ruler + minimap marks within 500 ms
  of model ready.
- When the model text changes, markers shall recompute within 300 ms of the last edit, and a
  recompute on a 2 000-line file with a 50-line change shall cost < 16 ms (unit benchmark).
- When HEAD changes, markers shall recompute without an intermediate all-added frame.
- If the file is untracked, the whole file shall show as one added hunk.
- If the file is binary, oversize, outside a repo, or git fails, no markers and no error.
- When `Alt+F5` is pressed, the editor shall reveal the next hunk (wrapping) and announce
  "Change N of M" via `aria-live="polite"`.
- When a marker is hovered, a tooltip shall state the kind and line count.
- The editor shall open with the minimap visible by default; `editorMinimap=false` hides it.
- Where `editorChangeMarkers` is off, no markers render and next/prev announce "Change markers
  are off".

```gherkin
Feature: Editor change decorations
  Scenario: Live markers while editing
    Given a tracked, unchanged file is open
    When three lines are inserted at line 10
    Then within 300 ms the gutter shows an added bar on lines 10–12
    And the overview ruler and minimap each show one mark there
```

### Lane B — e2e `review-keymap-persist`
- While focus is in the Review scroller, `j`/`k` shall move the current hunk (wrapping across
  files) and scroll it into view; `J`/`K` by file; `m` shall toggle reviewed.
- When Review reopens after a restart on the same source, unchanged-hash files shall show as
  reviewed; changed files shall not. The mark shall not appear as a change in the repo.
- When "Collapse all" is pressed, all cards shall collapse and the current file shall stay in view.
- While a card is scrolled through, its file header shall remain visible at the top.
- When ignore-whitespace is on, a file whose only changes are indentation shall show zero hunks.
- The oversize notice's "Open file" shall open the file in the editor.
- The picker shall offer Unpushed / Since branch point only when `git:resolveRange` resolves
  (fixture without upstream hides Unpushed); Last commit opens the commit source for HEAD.

### Lane D — e2e `review-scope`
- Scope Staged shall show HEAD→index; Unstaged index→worktree; All shall equal today.
- A path both staged and unstaged shall appear once under All and under each scope with only
  that side's hunks.

### Lane E — e2e `hunk-staging`
- Under Unstaged scope, when "Stage hunk" is pressed on a two-hunk file, `git diff --cached`
  shall contain exactly that hunk; the card shall then show only the other.
- When "Discard hunk" is confirmed, the worktree shall lose exactly that hunk and equal the index
  there (CRLF and no-EOF-newline fixtures included).
- If the file has staged changes under All scope, hunk buttons shall be disabled with the tooltip.
- If the file changed after the diff loaded, the op shall fail, the card shall reload, nothing
  shall be partially applied.
- The host shall build the patch only from `git diff` of the requested path (unit: `selectHunks`
  output passes `git apply --check` on all fixtures).
- Clicking a gutter marker in the editor shall open a peek showing the removed lines; Esc
  closes it and focus returns to the editor.

```gherkin
Feature: Hunk staging
  Scenario: Stage one of two hunks
    Given a file with two separate hunks in the working tree and nothing staged
    When the user stages the second hunk from its header under Unstaged scope
    Then `git diff --cached` contains only the second hunk
    And the card shows only the first hunk
```

### Lane C — e2e `review-search`
- Fixture: a 200-file **commit** source. When the user types in the find bar, `n / total` shall
  update within 100 ms and `Enter` shall reveal the next match, expanding a collapsed or capped
  card as needed.
- On a working source with unloaded cards, the bar shall show "in N of M files" and "Search all
  files" shall load the rest and update the count.
- Search shall include collapsed and capped rows and exclude folded context.

### Lane F — e2e `review-notes-handoff`
- When a note is saved on line L, it shall persist to `.conduit/review-notes.json` (enveloped)
  and reappear on L after restart while L's anchored text is unchanged; saving it shall not
  reload the Review.
- If the anchored line moves within ±50 lines, the note shall follow; otherwise it shall be
  listed as detached.
- When "Send to agent (N)" is pressed with a live session terminal, `buildHandoffMarkdown` output
  shall be delivered to the terminal bus for the Review's `sessionId` (e2e spy
  `window.__conduitPasteSpy` under `CONDUIT_E2E`), with no trailing newline, and all N notes
  stamped `sentAt`.
- Where `hasLiveTerminal` is false, the control shall read "Copy as markdown" and place the same
  text on the clipboard.

## 8. State catalog (UI)

| Component | State | User sees | Action |
|---|---|---|---|
| Editor markers | none / loading | plain gutter | — |
| | live | bars / triangles / ruler / minimap | hover → tooltip; click → peek (E) |
| | degraded | no marks + one status hint | — |
| Change peek (E) | open | removed lines, "Change 2 of 5", Stage · Discard · ↑ ↓ × | keys/buttons |
| | untracked | "New file — no previous version", Stage file | |
| | staged-side present | actions disabled + tooltip | |
| Review current hunk | focused | focus ring on header | keymap |
| Search bar | idle / typing / results / partial / none | placeholder / `n / m` / "in N of M files" + Search all / "No matches" | Enter, Shift+Enter, Aa, × |
| Scope control | All / Staged / Unstaged / disabled | segmented; selected = filled | click, ←/→ |
| Hunk actions | idle / working / failed / disabled | button; spinner; toast; tooltip | Stage, Unstage, Discard(confirm) |
| Note composer | empty / typing / saving / error / limit | inline row; "Saving…"; error + Retry; refusal | Mod+Enter, Esc |
| Note row | open / resolved / detached | body; struck; "lost its place" | Edit, Resolve, Delete(confirm) |
| Handoff | enabled / disabled (0) / no-terminal | "Send to agent (N)" / tooltip / "Copy as markdown" | click |
| Marks/notes controls | not loaded | disabled | — |
| Persistence files | absent / valid / corrupt | nothing / state / empty + host log | — |
| Review loading / partial / error / empty | unchanged from today | | |

## 9. Interaction inventory (UI)

| Component | Actions | Pointer | Keyboard | Context menu | ARIA |
|---|---|---|---|---|---|
| Gutter marker | hover; peek (E) | hover tooltip; click | `Alt+F5` / `Shift+Alt+F5`; `agentdeck.peekChange` (no default key — editor is editable) | editor menu: Next / Previous change (+ Peek change in E) | presentational; live-region |
| Change peek (E) | stage / discard / nav / close | buttons | Tab cycle; Esc closes, focus returns | — | `role="dialog"` `aria-label="Change 2 of 5"` |
| Review hunk header | current, open, stage, discard, note | click; buttons | `j k J K o s d c m` | Stage hunk / Discard hunk / Add note | `role="group"` `aria-current` |
| Collapse / Expand all | toggle | click | `e` / `Shift+E` | — | `aria-pressed` |
| Search bar | find; search all | click | `Mod+F`, `/`, Enter, Shift+Enter, Esc | — | `role="search"`; count `aria-live` |
| Scope control | select | click | ←/→ | — | `role="radiogroup"` |
| Note `+` | compose | hover-reveal, click | `c` | Add note | `aria-label="Add note on line 42"` |
| Composer | save / cancel | buttons | Mod+Enter / Esc | — | labelled textarea |
| Handoff | send / copy | click | Tab/Enter | — | `aria-disabled` + `aria-describedby` |
| Minimap | scrub | click/drag | — | — | Monaco-native |

Every pointer action has a keyboard path; every destructive action confirms; no drag is introduced.

## 10. Accessibility & i18n

- **Color never alone:** added = solid bar, modified = dashed bar, deleted = triangle; ruler and
  minimap marks are redundant with the gutter.
- Marker tokens ≥ 3:1 against the gutter on all three themes; the peek's removed-line wash reuses
  `--diff-remove` with the glyph carrying the signal (`styles.css:9375` rule).
- Live-region announcements: "Change N of M", "No changes", "Marked reviewed" / "Unmarked",
  "Staged hunk", "Discarded hunk", "N matches", "Sent N notes".
- Focus: peek traps and returns focus; composer returns focus to the row's `+`; after a discard
  the current hunk moves to the next.
- Reduced motion: peek opens without animation under `prefers-reduced-motion`.
- Forced colors: markers use `border`, not `background`.
- i18n: repo convention (English literals, no layer); ISO-8601 UTC timestamps; relative display
  like History.

## 11. Design tokens (UI)

Beside the existing `--diff-*` block (`styles.css:176`), per theme (Aero / Aero Dark / Neon):
- **Lane A:** `--change-added`, `--change-modified`, `--change-deleted` (≥ 3:1 on the gutter).
- **Lane E:** `--change-peek-bg`.
- **Lane F:** `--note-accent`.

Monaco can't read CSS vars for `overviewRuler.color` / `minimap.color`: resolve tokens via
`getComputedStyle` in the existing `applyToDom` theme hook and re-`set()` the collection on
theme change.

## 12. Assumptions

1. Baseline is HEAD (§2A); reversible with one setting later.
2. Review's scoped single-letter keys are acceptable (non-editable surface; History precedent).
3. Reviewed marks are per-user state → `userData`; notes are agent-facing → `.conduit/`
   (enveloped). `.conduit/` is gitignored in Conduit itself; in a foreign repo the user owns the
   gitignore decision (same as the board today) — no auto-gitignore.
4. Handoff never presses Enter and targets the Review doc's session.
5. No i18n layer (repo convention).
6. Minimap on by default reverses spec 2026-06-11-minimap (user decision 2026-08-27).
7. Multi-window writes are last-writer-wins via host broadcast.
8. Hunk patches are git's own `-U3` output filtered by range; a range spanning two git hunks
   applies both.
9. `git:resolveRange`'s default-branch fallback is `origin/HEAD` → `main` → `master`.
10. Excluding `.conduit/` from the project watcher's `fsChanged` is safe because board /
    proposal / spec artifacts already have dedicated watchers (`conduit-dir-watch.ts`,
    `board-watcher.ts`, `proposal-watcher.ts`).

## 13. Decisions Needed
_None — interactive mode; the three material choices were asked and answered (notes + handoff:
yes; hunk staging: v1; minimap: on by default). The architecture review's four blockers were
resolved by the conductor as recorded in the revision note._

## 14. Open questions
_None._

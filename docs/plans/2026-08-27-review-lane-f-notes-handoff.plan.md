# Review Notes + Agent Handoff (Review supercharge — Lane F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer attach a note to any line in the Review tab, keep those notes in the project (`.conduit/review-notes.json`, ADR 0002 envelope) so the agent can read them, mirror them as a gutter glyph in the editor, re-anchor them when the code moves under them, and hand every open note to the session's agent in one click as one bracketed paste.

**Architecture:** A pure model (`src/review-notes.ts`) owns the note shape, the five mutations as one `applyNotePatch`, the FNV anchor (reusing Lane B's `contentHash`), and re-anchoring. The host holds one repo's notes in memory, applies patches, writes the enveloped artifact atomically, and **broadcasts** `review:notes` to every window — so two windows never round-trip through the filesystem. A `.conduit/` watcher exists only to pick up an agent's own edits, with `recordWrite`/`isSelfEcho` suppression borrowed from the board watcher; the project watcher stops emitting `fsChanged` for `.conduit/` entirely, which is what stops a note save reloading the Review that wrote it. The renderer mirrors the host in an external store (`review-notes-store.ts`) exactly like Lane B's marks store. Review renders notes as thread rows interleaved into the hunk rows; the editor renders them as glyph-margin decorations through the same decoration-collection machinery Lane A built. Handoff is a pure markdown builder plus one unified `terminal-bus.ts` — `terminal-focus-bus.ts` widened into a sessionId-keyed registry with `focus`, `paste` and `hasLiveTerminal`.

**Tech Stack:** TypeScript (two tsconfigs: host `tsconfig.json`, renderer `tsconfig.webview.json`), React 18, monaco-editor, xterm, Electron IPC via `src/protocol.ts`, Vitest for unit tests, Playwright-Electron for the e2e scenario, Biome for lint/format.

**Spec:** `docs/specs/2026-08-27-review-supercharge.md` — read the revision note at the top, §0, §2 "Lane F", §3, §4, §5, §7 "Lane F", §8–§12. This plan implements **Lane F only**. Lanes A/B/D are already on `main` and are *built on*; Lanes C and E are **not** in scope — do not build them.

> **What is actually on `main` right now** (verified against the tree, not assumed):
> - **Lane A shipped:** `webview/change-decorations.ts`, `webview/use-change-markers.ts`, `webview/head-blob-cache.ts`, `src/repo-rel.ts`, the `--change-*` tokens and the `.cdec*` CSS. Lane F's editor mirror **reuses this decoration-collection pattern**.
> - **Lane B shipped:** `webview/review-keymap.ts` (`ACTIONS`, `ReviewAction`, `REVIEW_KEY_HELP`, `reviewActionAllowed`), `src/review-marks.ts` (including **`contentHash`**, the FNV-1a helper Lane F reuses), `webview/review-marks-store.ts`, the host's `userData/review-marks.json` store and the `review:marks` broadcast.
> - **Lane D shipped:** `ReviewScope`, `scopeOfSource`, `diffKey`, `diffsForScope` (`webview/review-scope.ts`), `DiffScope` on `readDiff`/`fileDiff`.
> - **Lane E is NOT shipped.** There is no `webview/use-peek-zone.ts` and no `webview/components/change-peek.tsx`; a partial Lane E lives in the worktree `.claude/worktrees/lane-e-hunk-staging`. **Lane F must not depend on any Lane E artifact, and must not add a Monaco view zone** — the editor mirror is a decoration only.
> - **Lane C is NOT shipped.** See "Lane C collision surface" below before touching row rendering.

## Global Constraints

Copied from the spec and from `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Notes live in the project, enveloped.** `.conduit/review-notes.json`, ADR 0002 envelope `{conduit, kind, updatedAt, data}`; `ConduitKind` gains `'review-notes'`, `FILE_FOR` gains the filename, read/write go through the existing `conduit-store` serialise/read helpers + `conduit-fs`'s `writeAtomic`. Absent/invalid = **empty**, never an error. (§2 Lane F, §3, §5)
- **Marks and notes are different stores.** Reviewed marks stay in `userData/review-marks.json` (Lane B). Lane F **follows the marks store's broadcast shape** (`review:notes` push, in-memory host ownership, renderer external store, load gate) but shares **no file** with it. (§5, revision note)
- **Sync model:** host holds notes in memory, applies the patch, writes, **broadcasts** `review:notes` to all windows. The `.conduit/` watcher exists only for **external** (agent) edits, with `recordWrite`-style self-echo suppression. (§2 Lane F, §4)
- **The project watcher's `fsChanged` excludes `.conduit/`** (`src/watch-filter.ts`). Root cause, stated once: `.conduit/` has its own dedicated watchers (`board-watcher.ts`, `proposal-watcher.ts`, and Lane F's notes watcher, all on `ConduitDirWatch`); without the exclusion **every note save emits `fsChanged`, which reloads the Review that wrote it** — the card re-requests its diff, the height cache churns and the composer's own row jumps. (§2 Lane F, §12.10)
- **Model** (§2 Lane F): `ReviewNote { id, path (repo-relative posix), side: 'new'|'old', line (1-based on `side`), anchor (FNV-1a of the line + one context line each side), body (markdown, ≤ 4 KB), createdAt (ISO-8601 UTC), resolvedAt?, sentAt? }`; `ReviewNotesData { version: 1; notes: ReviewNote[] }`.
- **Reuse Lane B's hash.** `anchorFor` calls `contentHash` from `src/review-marks.ts`. Never write a second FNV-1a. (`CLAUDE.md` root-cause rule; verify's duplication check)
- **Re-anchoring** on load and each diff refresh: exact line, else **nearest match within ±50 lines**, else **detached** — listed at the top of the card, never silently dropped. (§2 Lane F, §4)
- **Bound: 500 notes per repo**; the composer refuses with "Resolve or delete some notes first". (§2 Lane F, §5 Budgets)
- **Composer:** hover a Review row → `+` in the marker column; click or `c` opens an inline composer row. `Mod+Enter` saves, `Esc` cancels (**confirm only if non-empty**). Notes render as thread rows inside the card, **height cache invalidated for that path**. Actions: Edit · Resolve/Unresolve · Delete (**confirms**, via `webview/components/confirm-dialog.tsx`). (§2 Lane F, §8, §9)
- **Editor mirror:** gutter glyph on anchored lines; hover shows the body; click opens Review at the note. Read-only in the editor. **Decoration only — no view zone.** (§2 Lane F; revision note moves the view zone to Lane E)
- **Handoff:** footer button **"Send to agent (N)"**, N = **unresolved + unsent**. Pure `buildHandoffMarkdown`. Delivery through **one terminal bus**: `terminal-focus-bus.ts` becomes `terminal-bus.ts`, a sessionId-keyed registry each `TerminalPane` registers into with `{ focus(), paste(text) }`, plus `hasLiveTerminal(sessionId)`. Paste = xterm `paste()` (bracketed) — **never raw `term:input`**, which is the path `mention-bus.ts` takes and the one Lane F must not copy. Targets the **Review doc's session**. **No Enter, ever.** On send: `sentAt` stamped, toast "Sent 4 notes to <session>", count → 0. When `hasLiveTerminal` is false the button reads **"Copy as markdown"** with a tooltip saying why. (§2 Lane F, §5, §7 Lane F)
- **`c` is bound in `review-keymap.ts`** (today it is deliberately unbound — see that file's header comment). `REVIEW_KEY_HELP` gains the row so the `?` panel and the table can't drift. (§2 Lane B table, §2 Lane F)
- **Load gate:** note controls are disabled until the first `review:notes` push for that root arrives. (§4, §8)
- **Token:** `--note-accent`, per theme (Aero / Aero Dark / Neon), beside the existing `--diff-*` / `--change-*` block in `webview/styles.css`. (§11)
- **Accessibility (§10):** composer is a **labelled** textarea; live-region announcements ("Note added", "Note resolved", "Note deleted", "Sent N notes"); focus returns to the row's `+` when the composer closes; reduced motion honoured; colour never alone (the glyph and the "Resolved" text carry the state, not just the accent).
- **Overlay controls must be inert at rest.** The row's `+` is `opacity: 0; pointer-events: none` until `.rline:hover` / `:focus-within` — the hover-obstruction class of bug this repo already shipped once.
- **i18n:** none — English literals, ISO-8601 UTC stored, relative display like History. (§10)
- **NEVER write redundant comments.** A comment explains *why* (a non-obvious constraint or gotcha), never restates *what* the code says. Don't re-explain a decision that lives in the spec — link to it (`// see spec 2026-08-27-review-supercharge §2 Lane F`). (`CLAUDE.md`)
- **Fix root causes, no band-aids.** No `!important`, no specificity escalation, no `as any` / `@ts-ignore`. (`CLAUDE.md`)
- **Two tsconfigs.** `npm run typecheck` runs both. `src/review-notes.ts` and `src/review-handoff.ts` are imported by BOTH sides — they must stay node-free (no `node:` imports). (`CLAUDE.md`)
- **CI `verify` runs on `ubuntu-latest`.** No unit test may depend on `process.platform`, `path.sep`, or drive-letter casing. Root keys go through `normalizeRoot` (`src/review-marks.ts`), which already derives case folding from the root's *shape*. (`CLAUDE.md`)
- **`npm run verify` is the gate.** Never disable, downgrade, narrow, or defer one of its checks. (`CLAUDE.md`)
- **The e2e scenario runs hidden** on the shared harness (`test/e2e/harness.mjs`, `CONDUIT_E2E=1` → `show:false`). Run it ALONE on a quiet machine. (`CLAUDE.md`)
- **Scratch artifacts never land in the repo.** Screenshots go to an absolute path under `%TEMP%\claude-scratch`, as `test/e2e/review-keymap-persist.e2e.mjs:150` already does.
- **Docs layout is a contract (ADR 0003).** User-facing changes go in root `CHANGELOG.md`.

## Assumptions

Recorded because this is an unattended pipeline — no questions were asked. Each names the conservative reading taken.

1. **`ReviewNote` gains a `snippet: string` field** (the anchored line's first 60 characters) that §2 Lane F's model literal does not list. The spec *requires* the line text in two places — the handoff line `- L42 (\`const x = …\`): <body>` and the detached notice "was on line 42: `<first 60 chars>`" — but gives the pure builder no way to recover it: `anchor` is a one-way hash and `buildHandoffMarkdown(notes, files)` receives no file text. Storing the snippet at creation is the only way both literals can be produced. It is capped at 60 chars so the artifact stays small.
2. **The id is `note-<base36 epoch>-<6 random base36 chars>`, not a ULID.** The repo has no ulid dependency and its own id convention is exactly this shape (`src/pipeline.ts:183`). Adding a dependency for an id that is only ever compared for equality would fail the dep-audit's own bar. The generator is injected as a defaulted parameter so tests are deterministic.
3. **The 500 bound counts UNRESOLVED notes**, and a second, larger ceiling (`MAX_STORED_NOTES_PER_REPO = 2000`) is applied at parse/write time so the artifact cannot grow without bound. This is the only reading under which the spec's own refusal copy — "**Resolve** or delete some notes first" — is true; a cap on the total would make resolving pointless. The stored ceiling keeps unresolved notes first, then newest-first, so trimming can never drop live work. **Flagged: the spec is ambiguous here (§2 Lane F "500 per repo" vs. the copy).**
4. **`reanchor` is a pure VIEW computation and never rewrites the stored `line`.** Persisting a followed anchor on every diff refresh would mean a write (and a broadcast) triggered by a read — write amplification, and exactly the loop the `.conduit/` exclusion exists to prevent. The stored line is only rewritten when the user edits or resolves the note. The cost is that drift accumulates across sessions rather than per session; ±50 absorbs any single refactor, and anything larger becomes a detached note, which is surfaced rather than lost.
5. **A tie in the ±50 search resolves to the LOWER line number.** The spec says "nearest match"; when line−d and line+d both match, something has to break the tie deterministically or the note flickers between two rows across refreshes.
6. **Notes are keyed by the REPO root** (`effectiveRoot` in `ReviewView`, normalised with Lane B's `normalizeRoot`), and `.conduit/review-notes.json` is resolved at that same root. §3's wire shape is `{ root, notes }` and note paths are repo-relative, so the repo is the only key under which a path is meaningful. In a multi-repo workspace each sub-repo gets its own artifact — consistent with the board, which is per opened project root.
7. **A third message, `review:loadNotes { root }`, is added** alongside §3's `review:notes` / `review:setNotes`. The host cannot know which repo to read or which directory to watch until a renderer asks; the marks store gets away without one because it pushes *every* repo on `ready`, which is fine for a 2 000-mark index file and wrong for per-project artifacts the host must not go hunting for.
8. **`review:setNotes` carries a discriminated `patch`, not a whole list.** §3 says "`{ root, patch }`" and "host merges"; a five-member union (`add` / `edit` / `resolve` / `delete` / `sent`) applied by one shared pure function is what lets the host merge rather than accept a clobber, and it is what makes two windows converge on something better than last-writer-wins.
9. **The e2e seams are harness-opt-in objects, not `process.env.CONDUIT_E2E` reads.** The renderer has no access to the host's environment; the established precedent is `window.__terms`, which `terminal-pane.tsx:176` populates *only if the harness pre-created it*. `window.__conduitPasteSpy` follows exactly that: the bus pushes to it when it exists and is a no-op otherwise, so the seam cannot exist in production. The companion `window.__conduitTerminalBus` (an `unregister` handle, used once to drive the no-terminal branch) is gated on the spy's presence for the same reason.
10. **The handoff does not switch views or focus the terminal.** §2 Lane F specifies the toast and "no Enter"; it says nothing about moving the user. Yanking a reviewer out of a half-read review is the worse failure, so the toast is the whole signal. (`mention-bus`'s sink *does* switch views — that is a different interaction, initiated from the editor.)
11. **`sourceLabel` is a third parameter of `buildHandoffMarkdown`** (the spec writes `buildHandoffMarkdown(notes, files)` but hard-codes "(working tree)" in the output). Passing the label keeps the builder pure and lets a Staged/Unstaged/commit review say what it actually is.
12. **Composer state is owned by `ReviewView`, not the card.** `Esc` must unwind composer → help → Review in that order (§2 Lane B's Esc row), and `useEscapeKey` listens on `window`, so the state has to be visible where the unwind is decided. The draft *text* stays local to the composer; the composer reports dirtiness up so the confirm-on-cancel rule can be applied from either entry point.
13. **The `+` affordance reaches its handler by event delegation.** `Line` is memoised on primitives for a documented perf reason (`review-view.tsx:1743`); handing it a callback prop would re-tokenise every row of a card on every fold toggle. `Line` therefore gains only primitives (`noteSide`, `noteAnchorLine`, `noteCount`) and renders a static `<button>`; the click is read off `data-*` by a delegated handler on `.rhunks`.
14. **The editor's glyph margin is toggled on demand.** `code-viewer.tsx` creates the editor without `glyphMargin`, so `glyphMarginClassName` would not render. The note hook calls `updateOptions({ glyphMargin: markers.length > 0 })`, so the column appears with the first note on a file and disappears with the last, rather than reserving an always-empty gutter on every file.
15. **`isSelfEcho` is imported from `src/board-watch.ts` rather than re-implemented.** It is already generic over two fingerprint strings; a second copy would be flagged by verify's duplication check and would be the band-aid `CLAUDE.md` names. Only the notes *fingerprint* is new.
16. **`requestTerminalFocus` and `shouldFocusActiveTerminal` keep their names** when `terminal-focus-bus.ts` becomes `terminal-bus.ts`. Renaming them would touch `webview/app.tsx:667` and `:805` for no behavioural gain and would bury the actual change (the registry) in a diff of call-site churn.

---

## Lane C collision surface (read before touching row rendering)

Lane C (search in diff) is unbuilt and will also touch `review-view.tsx`'s rows. **Whichever lane lands second must reconcile these five points**; they are recorded here so it is a five-minute read rather than a rediscovery.

| # | Collision | What the second lane must do |
|---|---|---|
| 1 | **Row interleaving.** F inserts non-`Line` rows (`.rnote`, `.rnote-composer`) into `.rhunk__lines`, between diff rows. | C's "reveal a match" must locate a row by DOM query (`[data-seq]`), never by `index * rowHeight`. F adds `data-seq` to every `.rline` for exactly this. |
| 2 | **Search corpus.** C searches `FileReview` data, not the DOM. | Note bodies are **not** diff content and stay out of the corpus — the bar says "Search changed lines". If that is later wanted, it is a separate scope, not an accident of the DOM. |
| 3 | **Row highlighting.** C uses the CSS Custom Highlight API over `.rline__text` ranges. | F's `+` button and note-count badge live in the row but **outside** `.rline__text`, so C's ranges are unaffected. Keep it that way. |
| 4 | **The `Esc` chain.** §2 Lane B says Esc closes peek/search/composer, *then* Review. F implements composer → help → Review. | C inserts search between composer and help: composer → search → help → Review. One `useEscapeKey` callback in `ReviewView`, one ordered chain of refs — do not add a second window listener. |
| 5 | **`/` and `Mod+F` inside the composer.** | `isTypingEntry` already returns true for the composer's `<textarea>`, and `ReviewView.onKeyDown` returns early on it. C must not bypass that guard for `/`. |
| 6 | **Height cache.** F invalidates `measuredRef` for a path when its note rows change. C's "lift the cap / expand a collapsed card to reveal a match" changes heights too. | Both go through the same helper (`invalidateHeight(path)` added in Task 9) rather than two ad-hoc `measuredRef.current.delete` calls. |

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/review-notes.ts` | Pure model: `ReviewNote`, `ReviewNotesData`, `ReviewNotePatch`, the anchor (`anchorFor` / `anchorAt`), `applyNotePatch`, `reanchor`, the caps, validation, serialise/restore, fingerprint. Node-free. |
| `src/review-handoff.ts` | Pure `buildHandoffMarkdown(notes, files, sourceLabel)` + `handoffLabel(pending, live)`. Node-free. |
| `electron/notes-watcher.ts` | `NotesWatcher` on `ConduitDirWatch`, filtered to `review-notes.json`, with `recordWrite`/`isSelfEcho`. Mirrors `board-watcher.ts`. |
| `webview/review-notes-store.ts` | Renderer mirror of the host's notes: external store, per-root load gate, optimistic patch + `review:setNotes`. Mirrors `review-marks-store.ts`. |
| `webview/note-decorations.ts` | Pure: anchored notes → glyph-margin decoration descriptors + hover text. Monaco imported **type-only**. |
| `webview/use-note-markers.ts` | The editor hook: pick the repo root for a path, subscribe to the store, re-anchor against the model, own one decorations collection, toggle `glyphMargin`, route a glyph click. |
| `webview/review-note-target.ts` | Tiny external store carrying "open Review at this note" from the editor to `ReviewView`. Mirrors `webview/save-registry.ts`'s shape. |
| `webview/terminal-bus.ts` | The unified bus: sessionId-keyed registry (`register`, `focus`/`requestTerminalFocus`, `paste`, `hasLiveTerminal`), plus `shouldFocusActiveTerminal` moved over unchanged. Replaces `terminal-focus-bus.ts`. |
| `webview/components/note-thread.tsx` | `NoteThread` (one note's row: body, meta, Edit / Resolve / Delete), `NoteComposer` (the inline composer row), `DetachedNotes` (the card-top list). |
| `test/unit/review-notes.test.ts` | Model, caps, anchor, `applyNotePatch`, `reanchor` (incl. detached + two-candidate). |
| `test/unit/review-notes-fs.test.ts` | Envelope round-trip, absent file, corrupt file, atomic write leaves no temps. |
| `test/unit/review-notes-store.test.ts` | Load gate, optimistic patch, push replacement. |
| `test/unit/review-handoff.test.ts` | Markdown format, ordering, snippet, no trailing newline, label. |
| `test/unit/note-decorations.test.ts` | Grouping per line, hover text, resolved exclusion. |
| `test/unit/terminal-bus.test.ts` | Registry, liveness after unmount, focus fan-out (replaces `terminal-focus-bus.test.ts`). |
| `test/e2e/review-notes-handoff.e2e.mjs` | The lane's host-boundary scenario. |

**Modified**

| File | Change |
|---|---|
| `src/conduit-store.ts` | `ConduitKind` gains `'review-notes'`; `serializeReviewNotesArtifact` / `readReviewNotesArtifact`. |
| `electron/conduit-fs.ts` | `FILE_FOR` gains the filename; `REVIEW_NOTES_FILE_NAME`, `readReviewNotesBlob`, `readReviewNotesForProject`, `writeReviewNotesArtifactFile`. |
| `src/watch-filter.ts` | `.conduit/` is ignored by the project watcher. |
| `src/protocol.ts` | `ReviewNote` / `ReviewNotePatch` re-export; `review:notes` push; `review:loadNotes` / `review:setNotes` requests. |
| `electron/main.ts` | In-memory notes per root, `NotesWatcher` wiring, the two message cases. |
| `webview/bridge.ts` | Preview (no-host) replies for the two new requests. |
| `webview/review-keymap.ts` | `'addNote'` action, `c` binding, help row. |
| `webview/components/review-view.tsx` | Notes store + load, composer state + Esc chain, `+` delegation, note/detached rows, height invalidation, handoff footer, `c` handling, `repoKey` rename. |
| `webview/components/note-thread.tsx` | (created — listed above) |
| `webview/components/center-pane.tsx` | Pass `sessionLabel` to `ReviewView`. |
| `webview/components/terminal-pane.tsx` | Register/unregister with the bus instead of subscribing to focus only. |
| `webview/components/code-viewer.tsx` | `useNoteMarkers` wiring + glyph click. |
| `webview/app.tsx` | Import from `terminal-bus`; load notes for the active repo; install the note-open sink. |
| `webview/styles.css` | `--note-accent` per theme; `.rline__note`, `.rnote*`, `.rcard__detached`, `.review__handoff`, `.ndec` glyph. |
| `test/unit/watch-filter.test.ts` | `.conduit/` cases. |
| `test/unit/conduit-store.test.ts` | The new kind's envelope. |
| `test/unit/theme-tokens.test.ts` | `--note-accent` declared in all three themes. |
| `test/unit/review-keymap.test.ts` | `c` → `addNote`; help row present. |
| `CHANGELOG.md` | `[Unreleased]` → `### Added`. |

**Deleted**

| File | Why |
|---|---|
| `webview/terminal-focus-bus.ts` | Widened into `webview/terminal-bus.ts`; leaving it would fail the dead-code check. |
| `test/unit/terminal-focus-bus.test.ts` | Replaced by `test/unit/terminal-bus.test.ts`. |

---

## Task 1: The pure note model (`src/review-notes.ts`)

**Files:**
- Create: `src/review-notes.ts`
- Test: `test/unit/review-notes.test.ts`

**Interfaces:**
- Consumes: `contentHash` from `src/review-marks.ts` (Lane B's FNV-1a — the hash helper this lane reuses instead of writing a second one).
- Produces: `NoteSide`, `ReviewNote`, `ReviewNotesData`, `ReviewNotePatch`, `AnchoredNote`; `MAX_OPEN_NOTES_PER_REPO`, `MAX_STORED_NOTES_PER_REPO`, `MAX_NOTE_BODY`, `SNIPPET_CHARS`, `REANCHOR_RADIUS`; `emptyNotesData`, `newNoteId`, `snippetOf`, `anchorFor`, `anchorAt`, `isNote`, `restoreNotes`, `serializeNotes`, `notesFingerprint`, `openNotes`, `pendingNotes`, `canAddNote`, `applyNotePatch`, `reanchor`.

Node-free: the HOST reads/writes `.conduit/review-notes.json` with it and the RENDERER anchors, re-anchors and folds patches with it, so the two sides can only disagree by disagreeing with this file — the same contract `src/review-marks.ts` carries for Lane B.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review-notes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  anchorAt,
  anchorFor,
  applyNotePatch,
  canAddNote,
  emptyNotesData,
  MAX_NOTE_BODY,
  MAX_OPEN_NOTES_PER_REPO,
  MAX_STORED_NOTES_PER_REPO,
  notesFingerprint,
  openNotes,
  pendingNotes,
  reanchor,
  restoreNotes,
  type ReviewNote,
  serializeNotes,
  snippetOf,
} from '../../src/review-notes';

const NOW = '2026-08-28T10:00:00.000Z';

function note(over: Partial<ReviewNote> = {}): ReviewNote {
  const text = over.snippet ?? 'const x = 1;';
  return {
    id: 'note-1',
    path: 'src/foo.ts',
    side: 'new',
    line: 2,
    anchor: anchorFor(text, 'before', 'after'),
    snippet: text,
    body: 'why this?',
    createdAt: NOW,
    ...over,
  };
}

describe('anchorFor / anchorAt', () => {
  it('hashes the line together with one context line each side', () => {
    expect(anchorFor('b', 'a', 'c')).not.toBe(anchorFor('b', 'a', 'd'));
    expect(anchorFor('b', 'a', 'c')).not.toBe(anchorFor('b', 'x', 'c'));
    expect(anchorFor('b', 'a', 'c')).toBe(anchorFor('b', 'a', 'c'));
  });

  it('treats a missing neighbour as distinct from an empty one, so file edges are stable', () => {
    expect(anchorFor('only', null, null)).toBe(anchorFor('only', null, null));
    expect(anchorFor('only', null, null)).not.toBe(anchorFor('only', '', ''));
  });

  it('anchorAt reads 1-based lines and returns null outside the file', () => {
    const lines = ['a', 'b', 'c'];
    expect(anchorAt(lines, 2)).toBe(anchorFor('b', 'a', 'c'));
    expect(anchorAt(lines, 1)).toBe(anchorFor('a', null, 'b'));
    expect(anchorAt(lines, 3)).toBe(anchorFor('c', 'b', null));
    expect(anchorAt(lines, 0)).toBeNull();
    expect(anchorAt(lines, 4)).toBeNull();
  });
});

describe('snippetOf', () => {
  it('trims and caps at 60 characters with an ellipsis', () => {
    expect(snippetOf('   const x = 1;   ')).toBe('const x = 1;');
    expect(snippetOf('x'.repeat(80))).toBe(`${'x'.repeat(60)}…`);
    expect(snippetOf('')).toBe('');
  });
});

describe('applyNotePatch', () => {
  it('adds a note', () => {
    const next = applyNotePatch([], { op: 'add', note: note() });
    expect(next).toHaveLength(1);
    expect(next[0].body).toBe('why this?');
  });

  it('refuses an add at the OPEN-note cap, and allows it again after a resolve', () => {
    const full = Array.from({ length: MAX_OPEN_NOTES_PER_REPO }, (_, i) => note({ id: `n${i}` }));
    expect(canAddNote(full)).toBe(false);
    expect(applyNotePatch(full, { op: 'add', note: note({ id: 'extra' }) })).toHaveLength(
      MAX_OPEN_NOTES_PER_REPO,
    );

    const oneResolved = applyNotePatch(full, { op: 'resolve', id: 'n0', resolved: true, at: NOW });
    expect(canAddNote(oneResolved)).toBe(true);
    expect(applyNotePatch(oneResolved, { op: 'add', note: note({ id: 'extra' }) })).toHaveLength(
      MAX_OPEN_NOTES_PER_REPO + 1,
    );
  });

  it('ignores an add whose body is blank or over the 4 KB bound', () => {
    expect(applyNotePatch([], { op: 'add', note: note({ body: '   ' }) })).toHaveLength(0);
    expect(
      applyNotePatch([], { op: 'add', note: note({ body: 'x'.repeat(MAX_NOTE_BODY + 1) }) }),
    ).toHaveLength(0);
  });

  it('ignores an add whose id is already present, so a replayed patch is idempotent', () => {
    const once = applyNotePatch([], { op: 'add', note: note() });
    expect(applyNotePatch(once, { op: 'add', note: note() })).toHaveLength(1);
  });

  it('edits a body and ignores an edit of an unknown id', () => {
    const list = [note()];
    expect(applyNotePatch(list, { op: 'edit', id: 'note-1', body: 'better' })[0].body).toBe('better');
    expect(applyNotePatch(list, { op: 'edit', id: 'nope', body: 'x' })).toEqual(list);
  });

  it('resolves and unresolves', () => {
    const resolved = applyNotePatch([note()], { op: 'resolve', id: 'note-1', resolved: true, at: NOW });
    expect(resolved[0].resolvedAt).toBe(NOW);
    const reopened = applyNotePatch(resolved, { op: 'resolve', id: 'note-1', resolved: false, at: NOW });
    expect(reopened[0].resolvedAt).toBeUndefined();
  });

  it('deletes', () => {
    expect(applyNotePatch([note()], { op: 'delete', id: 'note-1' })).toHaveLength(0);
  });

  it('stamps sentAt on exactly the listed ids', () => {
    const list = [note(), note({ id: 'note-2' })];
    const sent = applyNotePatch(list, { op: 'sent', ids: ['note-2'], at: NOW });
    expect(sent[0].sentAt).toBeUndefined();
    expect(sent[1].sentAt).toBe(NOW);
  });

  it('never mutates the input array', () => {
    const list = [note()];
    applyNotePatch(list, { op: 'delete', id: 'note-1' });
    expect(list).toHaveLength(1);
  });
});

describe('openNotes / pendingNotes', () => {
  it('open = unresolved; pending = unresolved AND unsent', () => {
    const list = [note({ id: 'a' }), note({ id: 'b', sentAt: NOW }), note({ id: 'c', resolvedAt: NOW })];
    expect(openNotes(list).map((n) => n.id)).toEqual(['a', 'b']);
    expect(pendingNotes(list).map((n) => n.id)).toEqual(['a']);
  });
});

describe('reanchor', () => {
  const lines = ['a', 'b', 'c', 'd', 'e'];

  it('keeps a note on its exact line when the text is unchanged', () => {
    const n = note({ line: 3, anchor: anchorFor('c', 'b', 'd'), snippet: 'c' });
    expect(reanchor([n], lines)).toEqual([{ note: n, line: 3 }]);
  });

  it('follows a line that moved within the radius', () => {
    const n = note({ line: 1, anchor: anchorFor('c', 'b', 'd'), snippet: 'c' });
    expect(reanchor([n], lines)[0].line).toBe(3);
  });

  it('detaches a note whose anchored line is gone', () => {
    const n = note({ line: 3, anchor: anchorFor('gone', 'x', 'y'), snippet: 'gone' });
    expect(reanchor([n], lines)[0].line).toBeNull();
  });

  it('detaches a note whose line moved further than the radius', () => {
    const far = [...Array.from({ length: 200 }, (_, i) => `f${i}`), 'b', 'c', 'd'];
    const n = note({ line: 1, anchor: anchorFor('c', 'b', 'd'), snippet: 'c' });
    expect(reanchor([n], far)[0].line).toBeNull();
  });

  it('picks the NEAREST of two candidate lines, and the lower one on a tie', () => {
    // `x` with context `w`/`y` appears at line 2 and at line 8 — equidistant from 5.
    const dup = ['w', 'x', 'y', 'p', 'q', 'r', 'w', 'x', 'y'];
    const anchor = anchorFor('x', 'w', 'y');
    expect(reanchor([note({ line: 5, anchor, snippet: 'x' })], dup)[0].line).toBe(2);
    expect(reanchor([note({ line: 7, anchor, snippet: 'x' })], dup)[0].line).toBe(8);
  });

  it('detaches everything in an empty file', () => {
    expect(reanchor([note()], [])[0].line).toBeNull();
  });
});

describe('restoreNotes / serializeNotes', () => {
  it('round-trips', () => {
    const data = { version: 1 as const, notes: [note()] };
    expect(restoreNotes(serializeNotes(data))).toEqual(data);
  });

  it('is empty for absent, unparseable, foreign-version and non-object input', () => {
    expect(restoreNotes(undefined)).toEqual(emptyNotesData());
    expect(restoreNotes('{oops')).toEqual(emptyNotesData());
    expect(restoreNotes('[]')).toEqual(emptyNotesData());
    expect(restoreNotes(JSON.stringify({ version: 2, notes: [note()] }))).toEqual(emptyNotesData());
  });

  it('drops malformed entries rather than the whole file', () => {
    const blob = JSON.stringify({ version: 1, notes: [note(), { id: 'bad' }, null] });
    expect(restoreNotes(blob).notes).toHaveLength(1);
  });

  it('trims to the stored ceiling, keeping unresolved notes first', () => {
    const many = [
      ...Array.from({ length: MAX_STORED_NOTES_PER_REPO }, (_, i) =>
        note({ id: `r${i}`, resolvedAt: NOW, createdAt: '2020-01-01T00:00:00.000Z' }),
      ),
      note({ id: 'live' }),
    ];
    const kept = restoreNotes(JSON.stringify({ version: 1, notes: many })).notes;
    expect(kept).toHaveLength(MAX_STORED_NOTES_PER_REPO);
    expect(kept.some((n) => n.id === 'live')).toBe(true);
  });
});

describe('notesFingerprint', () => {
  it('is stable for equal content and differs on any change', () => {
    const a = { version: 1 as const, notes: [note()] };
    const b = { version: 1 as const, notes: [note()] };
    expect(notesFingerprint(a)).toBe(notesFingerprint(b));
    expect(notesFingerprint(a)).not.toBe(
      notesFingerprint({ version: 1, notes: [note({ body: 'other' })] }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-notes.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/review-notes"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/review-notes.ts`:

```ts
import { contentHash } from './review-marks';

/**
 * The review-notes model (spec 2026-08-27-review-supercharge §2 Lane F). Node-free on purpose:
 * the HOST reads/writes `.conduit/review-notes.json` with it and the RENDERER anchors, re-anchors
 * and folds patches with it, so the two sides can only disagree by disagreeing with this file.
 *
 * Notes live IN the project (ADR 0002 envelope) because the point is that the agent can read
 * them — the opposite call from reviewed marks, which are per-user and stay in userData (§5).
 */

/** Which side of the diff a note is pinned to. `old` is a note on a removed line. */
export type NoteSide = 'new' | 'old';

export interface ReviewNote {
  id: string;
  /** Repo-relative posix path, exactly as ChangeDTO carries it. */
  path: string;
  side: NoteSide;
  /** 1-based on `side`. The VIEW position is recomputed by `reanchor`; this is the last one saved. */
  line: number;
  /** FNV-1a of the line plus one context line each side. */
  anchor: string;
  /**
   * The anchored line's text, capped at SNIPPET_CHARS. Not in the spec's model literal: the spec
   * needs the line text in two outputs (the handoff line, the detached notice) and `anchor` is
   * one-way — see the plan's assumption 1.
   */
  snippet: string;
  /** Markdown, <= MAX_NOTE_BODY. */
  body: string;
  /** ISO-8601 UTC. */
  createdAt: string;
  resolvedAt?: string;
  sentAt?: string;
}

export interface ReviewNotesData {
  version: 1;
  notes: ReviewNote[];
}

/** What one window asks the host to merge. `add` carries a whole note so the renderer can render
 *  it optimistically under the same id the host will persist. */
export type ReviewNotePatch =
  | { op: 'add'; note: ReviewNote }
  | { op: 'edit'; id: string; body: string }
  | { op: 'resolve'; id: string; resolved: boolean; at: string }
  | { op: 'delete'; id: string }
  | { op: 'sent'; ids: string[]; at: string };

/** The composer's refusal threshold, counted over UNRESOLVED notes — see the plan's assumption 3. */
export const MAX_OPEN_NOTES_PER_REPO = 500;
/** Hard ceiling on the artifact so resolved notes can't grow it without bound. */
export const MAX_STORED_NOTES_PER_REPO = 2000;
export const MAX_NOTE_BODY = 4096;
export const SNIPPET_CHARS = 60;
/** How far a moved line is followed before the note is called detached (§2 Lane F). */
export const REANCHOR_RADIUS = 50;

export function emptyNotesData(): ReviewNotesData {
  return { version: 1, notes: [] };
}

/** Matches the repo's own id shape (src/pipeline.ts); the clock is injected so tests can pin it. */
export function newNoteId(now: number = Date.now()): string {
  return `note-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function snippetOf(lineText: string): string {
  const t = lineText.trim();
  return t.length > SNIPPET_CHARS ? `${t.slice(0, SNIPPET_CHARS)}…` : t;
}

/** A missing neighbour is a distinct value from an empty one, so a note on line 1 and a note whose
 *  predecessor is a blank line can't collide. */
const NEIGHBOUR_ABSENT = String.fromCharCode(0);
const neighbour = (s: string | null): string => (s === null ? NEIGHBOUR_ABSENT : s);

export function anchorFor(
  lineText: string,
  prevLine: string | null,
  nextLine: string | null,
): string {
  return contentHash(`${neighbour(prevLine)}\n${lineText}\n${neighbour(nextLine)}`);
}

/** The anchor a 1-based `line` of `fileLines` would produce; null when the line isn't there. */
export function anchorAt(fileLines: readonly string[], line: number): string | null {
  if (line < 1 || line > fileLines.length) return null;
  const prev = line >= 2 ? fileLines[line - 2] : null;
  const next = line < fileLines.length ? fileLines[line] : null;
  return anchorFor(fileLines[line - 1], prev, next);
}

/** Shape check for anything crossing a boundary — the parse path AND the host write path, which
 *  persists what it is handed into a file the user commits. */
export const isNote = (v: unknown): v is ReviewNote => {
  if (typeof v !== 'object' || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.id === 'string' &&
    typeof n.path === 'string' &&
    (n.side === 'new' || n.side === 'old') &&
    typeof n.line === 'number' &&
    Number.isFinite(n.line) &&
    typeof n.anchor === 'string' &&
    typeof n.snippet === 'string' &&
    typeof n.body === 'string' &&
    typeof n.createdAt === 'string' &&
    (n.resolvedAt === undefined || typeof n.resolvedAt === 'string') &&
    (n.sentAt === undefined || typeof n.sentAt === 'string')
  );
};

const isOpen = (n: ReviewNote): boolean => n.resolvedAt === undefined;

export function openNotes(notes: readonly ReviewNote[]): ReviewNote[] {
  return notes.filter(isOpen);
}

/** What "Send to agent (N)" counts: unresolved AND not yet sent (§2 Lane F). */
export function pendingNotes(notes: readonly ReviewNote[]): ReviewNote[] {
  return notes.filter((n) => isOpen(n) && n.sentAt === undefined);
}

export function canAddNote(notes: readonly ReviewNote[]): boolean {
  return openNotes(notes).length < MAX_OPEN_NOTES_PER_REPO;
}

/** Unresolved first, then newest-first — the order the stored ceiling trims from the end of. */
function trim(notes: readonly ReviewNote[]): ReviewNote[] {
  if (notes.length <= MAX_STORED_NOTES_PER_REPO) return [...notes];
  return [...notes]
    .sort((a, b) => {
      if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    })
    .slice(0, MAX_STORED_NOTES_PER_REPO);
}

const validBody = (body: string): boolean => body.trim().length > 0 && body.length <= MAX_NOTE_BODY;

/**
 * The single merge path, shared by the host (authoritative) and the renderer (optimistic). Every
 * refusal is a silent no-op returning the list unchanged: the renderer gates on `canAddNote` and
 * shows the guidance, and the host must never throw on a message a window could malform.
 */
export function applyNotePatch(notes: readonly ReviewNote[], patch: ReviewNotePatch): ReviewNote[] {
  switch (patch.op) {
    case 'add': {
      if (!isNote(patch.note) || !validBody(patch.note.body)) return [...notes];
      if (!canAddNote(notes)) return [...notes];
      if (notes.some((n) => n.id === patch.note.id)) return [...notes];
      return trim([...notes, patch.note]);
    }
    case 'edit': {
      if (!validBody(patch.body)) return [...notes];
      return notes.map((n) => (n.id === patch.id ? { ...n, body: patch.body } : n));
    }
    case 'resolve':
      return notes.map((n) => {
        if (n.id !== patch.id) return n;
        if (patch.resolved) return { ...n, resolvedAt: patch.at };
        const { resolvedAt: _reopened, ...rest } = n;
        return rest;
      });
    case 'delete':
      return notes.filter((n) => n.id !== patch.id);
    case 'sent': {
      const ids = new Set(patch.ids);
      return notes.map((n) => (ids.has(n.id) ? { ...n, sentAt: patch.at } : n));
    }
  }
}

/** A note and where it currently sits; `line` null ⇒ detached (§2 Lane F: never dropped). */
export interface AnchoredNote {
  note: ReviewNote;
  line: number | null;
}

/**
 * Exact line → nearest match within REANCHOR_RADIUS → detached. `fileLines` is ONE side of ONE
 * file, so the caller partitions by `side` first. Pure and view-only: the stored `line` is never
 * rewritten from here (plan assumption 4), so a read can never provoke a write.
 */
export function reanchor(
  notes: readonly ReviewNote[],
  fileLines: readonly string[],
): AnchoredNote[] {
  return notes.map((note) => {
    if (anchorAt(fileLines, note.line) === note.anchor) return { note, line: note.line };
    for (let d = 1; d <= REANCHOR_RADIUS; d++) {
      // Lower line first, so two equidistant candidates resolve deterministically (assumption 5).
      if (anchorAt(fileLines, note.line - d) === note.anchor) return { note, line: note.line - d };
      if (anchorAt(fileLines, note.line + d) === note.anchor) return { note, line: note.line + d };
    }
    return { note, line: null };
  });
}

export function serializeNotes(data: ReviewNotesData): string {
  return JSON.stringify({ version: 1, notes: trim(data.notes) });
}

/** A corrupt or foreign-version payload is an EMPTY set of notes, never an error (§4). */
export function restoreNotes(blob: string | undefined): ReviewNotesData {
  if (!blob) return emptyNotesData();
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return emptyNotesData();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return emptyNotesData();
  const { version, notes } = parsed as { version?: unknown; notes?: unknown };
  if (version !== 1 || !Array.isArray(notes)) return emptyNotesData();
  return { version: 1, notes: trim(notes.filter(isNote)) };
}

/** Content fingerprint for the watcher's self-echo guard — the notes only, never the envelope's
 *  `updatedAt`, which changes on every write. Mirrors src/board-watch.ts's `fingerprint`. */
export function notesFingerprint(data: ReviewNotesData): string {
  return JSON.stringify(data.notes);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/review-notes.test.ts`
Expected: PASS — 25 tests.

- [ ] **Step 5: Commit**

```bash
git add src/review-notes.ts test/unit/review-notes.test.ts
git commit -m "feat(review): the review-note model, its anchor and its re-anchoring"
```

---

## Task 2: ADR 0002 persistence (`.conduit/review-notes.json`)

**Files:**
- Modify: `src/conduit-store.ts`, `electron/conduit-fs.ts`
- Test: `test/unit/review-notes-fs.test.ts`, `test/unit/conduit-store.test.ts`

**Interfaces:**
- Consumes: `ReviewNotesData`, `restoreNotes`, `serializeNotes` (Task 1); `writeAtomic`, `readBlob` (private to `conduit-fs.ts`).
- Produces:
  - `src/conduit-store.ts`: `ConduitKind` gains `'review-notes'`; `serializeReviewNotesArtifact(data, updatedAt?): string`; `readReviewNotesArtifact(blob): ReviewNotesData`.
  - `electron/conduit-fs.ts`: `REVIEW_NOTES_FILE_NAME`; `readReviewNotesBlob(root): string | undefined`; `readReviewNotesForProject(root): ReviewNotesData`; `writeReviewNotesArtifactFile(root, data): Promise<void>`.

`FILE_FOR` is a `Record<ConduitKind, string>`, so adding the kind without the filename is a compile error — the two can't drift. `readReviewNotesBlob` exists for the same reason `readBoardBlob` does: the watcher must tell "unreadable right now" (mid-write, locked) from "successfully read and empty", or a transient failure would broadcast an empty note list over the user's notes.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review-notes-fs.test.ts`:

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conduitDir,
  conduitPath,
  readReviewNotesBlob,
  readReviewNotesForProject,
  REVIEW_NOTES_FILE_NAME,
  writeReviewNotesArtifactFile,
} from '../../electron/conduit-fs';
import { CONDUIT_VERSION, readReviewNotesArtifact } from '../../src/conduit-store';
import { anchorFor, emptyNotesData, type ReviewNote } from '../../src/review-notes';

let root: string;

const note = (over: Partial<ReviewNote> = {}): ReviewNote => ({
  id: 'note-1',
  path: 'src/foo.ts',
  side: 'new',
  line: 42,
  anchor: anchorFor('const x = 1;', 'a', 'b'),
  snippet: 'const x = 1;',
  body: 'why this?',
  createdAt: '2026-08-28T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-notes-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('.conduit/review-notes.json', () => {
  it('is named review-notes.json inside .conduit/', () => {
    expect(REVIEW_NOTES_FILE_NAME).toBe('review-notes.json');
    expect(conduitPath(root, REVIEW_NOTES_FILE_NAME)).toBe(
      path.join(root, '.conduit', 'review-notes.json'),
    );
  });

  it('writes an ADR 0002 envelope and reads it back', async () => {
    await writeReviewNotesArtifactFile(root, { version: 1, notes: [note()] });
    const raw = JSON.parse(fs.readFileSync(conduitPath(root, REVIEW_NOTES_FILE_NAME), 'utf8'));
    expect(raw.conduit).toBe(CONDUIT_VERSION);
    expect(raw.kind).toBe('review-notes');
    expect(typeof raw.updatedAt).toBe('number');
    expect(raw.data.version).toBe(1);
    expect(raw.data.notes[0].id).toBe('note-1');
    expect(readReviewNotesForProject(root).notes).toHaveLength(1);
  });

  it('leaves no atomic-write temp files behind', async () => {
    await writeReviewNotesArtifactFile(root, { version: 1, notes: [note()] });
    expect(fs.readdirSync(conduitDir(root)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('is EMPTY when the file is absent, and for a falsy root', () => {
    expect(readReviewNotesForProject(root)).toEqual(emptyNotesData());
    expect(readReviewNotesForProject('')).toEqual(emptyNotesData());
    expect(readReviewNotesBlob(root)).toBeUndefined();
  });

  it('is EMPTY for a corrupt file, and the next write replaces it', async () => {
    fs.mkdirSync(conduitDir(root), { recursive: true });
    fs.writeFileSync(conduitPath(root, REVIEW_NOTES_FILE_NAME), '{ not json');
    expect(readReviewNotesForProject(root)).toEqual(emptyNotesData());
    await writeReviewNotesArtifactFile(root, { version: 1, notes: [note()] });
    expect(readReviewNotesForProject(root).notes).toHaveLength(1);
  });

  it('reads a bare (un-enveloped) payload too, like every other kind', () => {
    fs.mkdirSync(conduitDir(root), { recursive: true });
    fs.writeFileSync(
      conduitPath(root, REVIEW_NOTES_FILE_NAME),
      JSON.stringify({ version: 1, notes: [note()] }),
    );
    expect(readReviewNotesForProject(root).notes).toHaveLength(1);
  });

  it('drops a malformed note out of an otherwise valid envelope', () => {
    expect(
      readReviewNotesArtifact(
        JSON.stringify({
          conduit: 1,
          kind: 'review-notes',
          updatedAt: 1,
          data: { version: 1, notes: [note(), { id: 'bad' }] },
        }),
      ).notes,
    ).toHaveLength(1);
  });
});
```

Add to `test/unit/conduit-store.test.ts` (inside the existing `conduit-store envelope` describe):

```ts
  it('serializes a review-notes envelope with conduit version, kind, updatedAt, and data', () => {
    const json = serializeReviewNotesArtifact({ version: 1, notes: [] }, 3000);
    const parsed = JSON.parse(json);
    expect(parsed.conduit).toBe(CONDUIT_VERSION);
    expect(parsed.kind).toBe('review-notes');
    expect(parsed.updatedAt).toBe(3000);
    expect(parsed.data).toEqual({ version: 1, notes: [] });
  });
```

…with `readReviewNotesArtifact, serializeReviewNotesArtifact` added to that file's `src/conduit-store` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-notes-fs.test.ts test/unit/conduit-store.test.ts`
Expected: FAIL — `REVIEW_NOTES_FILE_NAME` / `serializeReviewNotesArtifact` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/conduit-store.ts` — extend the kind union and its doc comment, import the model, and add the pair beside the pipeline helpers:

```ts
import { type ReviewNotesData, restoreNotes, serializeNotes } from './review-notes';
```

```ts
export type ConduitKind =
  | 'architecture'
  | 'board'
  | 'pipeline'
  | 'pipeline-queue'
  // Line-anchored review notes, in-project because the agent is meant to read them (§2 Lane F).
  | 'review-notes';
```

```ts
/** Serialize review notes as a `.conduit/review-notes.json` envelope (Lane F). */
export function serializeReviewNotesArtifact(
  data: ReviewNotesData,
  updatedAt: number = Date.now(),
): string {
  const payload = JSON.parse(serializeNotes(data)) as ReviewNotesData;
  return JSON.stringify(wrap('review-notes', payload, updatedAt), null, 2);
}

/**
 * Read a review-notes envelope (or a bare `ReviewNotesData`) into a validated payload.
 * Falls back to EMPTY when missing/invalid — `restoreNotes` never throws (§4).
 */
export function readReviewNotesArtifact(blob: string | undefined): ReviewNotesData {
  const payload = unwrapPayload(blob);
  if (payload === undefined) return emptyNotesData();
  return restoreNotes(JSON.stringify(payload));
}
```

(`emptyNotesData` comes from the same import; add it to the `./review-notes` import list.)

In `electron/conduit-fs.ts`:

```ts
import {
  // …existing imports…
  readReviewNotesArtifact,
  serializeReviewNotesArtifact,
} from '../src/conduit-store';
import { emptyNotesData, type ReviewNotesData } from '../src/review-notes';
```

```ts
/** The review-notes artifact's filename — exported so the notes watcher filters FS events on the
 *  same single source of truth instead of duplicating the literal (as BOARD_FILE_NAME does). */
export const REVIEW_NOTES_FILE_NAME = 'review-notes.json';

const FILE_FOR: Record<ConduitKind, string> = {
  architecture: 'architecture.json',
  board: BOARD_FILE_NAME,
  pipeline: 'pipeline.json',
  'pipeline-queue': 'pipeline-queue.json',
  'review-notes': REVIEW_NOTES_FILE_NAME,
};
```

…and, beside the board readers:

```ts
/** Raw `.conduit/review-notes.json` blob, or `undefined` when it can't be read (absent, mid-write,
 *  locked). The watcher needs that distinction — see readBoardBlob. */
export function readReviewNotesBlob(projectRoot: string): string | undefined {
  return readBlob(artifactPath(projectRoot, 'review-notes'));
}

/** Read a project's review notes; EMPTY if absent/invalid. A falsy root never reads the cwd. */
export function readReviewNotesForProject(projectRoot: string): ReviewNotesData {
  if (!projectRoot) return emptyNotesData();
  return readReviewNotesArtifact(readReviewNotesBlob(projectRoot));
}

/** Write `.conduit/review-notes.json` (mkdir -p, atomic, errors surfaced). */
export function writeReviewNotesArtifactFile(
  projectRoot: string,
  data: ReviewNotesData,
): Promise<void> {
  return writeAtomic(artifactPath(projectRoot, 'review-notes'), serializeReviewNotesArtifact(data));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/review-notes-fs.test.ts test/unit/conduit-store.test.ts test/unit/conduit-fs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/conduit-store.ts electron/conduit-fs.ts test/unit/review-notes-fs.test.ts test/unit/conduit-store.test.ts
git commit -m "feat(review): persist review notes as a .conduit artifact"
```

---

## Task 3: Stop the project watcher reporting `.conduit/`

**Files:**
- Modify: `src/watch-filter.ts`
- Test: `test/unit/watch-filter.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `shouldIgnoreWatchPath('.conduit/**') === true`.

This is the **root cause fix**, and it lands before any host wiring so the loop it prevents never exists in the tree. Without it, the host's own note write fires the recursive `ProjectWatcher`, which broadcasts `fsChanged`, which makes `app.tsx:995` refresh git changes and `right-pane.tsx:685` re-read the tree — and Review's cards re-request their diffs under the composer the user is still typing in.

**Verified safe** — nothing that reads `.conduit/` depends on `fsChanged`:

| Consumer | Watch it actually uses |
|---|---|
| Board view | `BoardWatcher` → its own `fs.watch` on `<root>/.conduit` via `ConduitDirWatch`, filtered to `board.json` (`electron/main.ts:2430`) |
| Proposals | `ProposalWatcher`, same primitive, filtered to `*.proposed.json` |
| Feature specs | re-emitted by the board/spec write paths (`specsList`), not by `fsChanged` |
| Architecture | read on request + the proposal watcher |
| Review notes | Task 5's `NotesWatcher`, same primitive |

The two things that genuinely change: the **Explorer** no longer live-refreshes for a `.conduit/` write, and the **Changes panel** no longer refreshes for one in a repo where `.conduit/` is tracked. Both still refresh on the next unrelated change and on window focus, and `.conduit/` is an app/agent-owned directory the user does not edit by hand. That is the trade the spec makes in §12.10, recorded here so it is not rediscovered as a bug.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/watch-filter.test.ts`:

```ts
  it('ignores everything under .conduit/, which has its own watchers', () => {
    expect(shouldIgnoreWatchPath('.conduit/review-notes.json')).toBe(true);
    expect(shouldIgnoreWatchPath('.conduit\\review-notes.json')).toBe(true);
    expect(shouldIgnoreWatchPath('.conduit/board.json')).toBe(true);
    expect(shouldIgnoreWatchPath('.conduit/specs/card-1.md')).toBe(true);
    expect(shouldIgnoreWatchPath('.conduit')).toBe(true);
  });

  it('does not ignore a .conduit named deeper in the tree', () => {
    // Only the project root's own `.conduit/` has dedicated watchers.
    expect(shouldIgnoreWatchPath('packages/app/.conduit/board.json')).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/watch-filter.test.ts`
Expected: FAIL — five `expected false to be true`.

- [ ] **Step 3: Write minimal implementation**

In `src/watch-filter.ts`, immediately after the `.git` branch:

```ts
  // `.conduit/` is watched by its own dedicated watchers (board, proposal, review notes — all on
  // ConduitDirWatch). Letting it through here would make the app's own artifact writes broadcast
  // `fsChanged`, and a note save would reload the Review that wrote it. See spec
  // 2026-08-27-review-supercharge §2 Lane F and §12.10.
  if (segs[0] === '.conduit') return true;
```

Extend the module doc-comment's list of what is dropped to name `.conduit` alongside `.git/objects`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/watch-filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watch-filter.ts test/unit/watch-filter.test.ts
git commit -m "fix(watch): keep .conduit/ out of fsChanged, it has its own watchers"
```

---

## Task 4: The protocol pair

**Files:**
- Modify: `src/protocol.ts`
- Test: none of its own (a type-only change; `npm run typecheck` is the gate, and Tasks 5–6 exercise it).

**Interfaces:**
- Consumes: `ReviewNote`, `ReviewNotePatch` from `src/review-notes.ts`.
- Produces:
  - Host→webview: `{ type: 'review:notes'; root: string; notes: ReviewNote[] }`
  - Webview→host: `{ type: 'review:loadNotes'; root: string }`
  - Webview→host: `{ type: 'review:setNotes'; root: string; patch: ReviewNotePatch }`

One repo per message, unlike `review:marks`'s list of repos: notes are a per-project artifact the host must be *told* to go and read (assumption 7), so a push always answers a load or a change for exactly one root.

- [ ] **Step 1: Write the failing test**

No test file. The failing state is the compile error in Task 5 — `case 'review:loadNotes'` on a union that has no such member.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run typecheck`
Expected: PASS today (nothing references the new members yet); it fails at Task 5 Step 2 without this task.

- [ ] **Step 3: Write minimal implementation**

In `src/protocol.ts`, beside the Lane B re-export block:

```ts
export type { ReviewNote, ReviewNotePatch, ReviewNotesData } from './review-notes';
```

…and import the types for use in the unions:

```ts
import type { ReviewNote, ReviewNotePatch } from './review-notes';
```

Host→webview, next to `review:marks`:

```ts
  // One repo's review notes from `<root>/.conduit/review-notes.json`. Sent in reply to
  // `review:loadNotes`, on every change the host applies, and when the `.conduit/` watcher sees an
  // EXTERNAL (agent) edit. An empty list is a real answer: it is what opens the renderer's note
  // controls (§2 Lane F, §4).
  | { type: 'review:notes'; root: string; notes: ReviewNote[] }
```

Webview→host, next to `review:setMark`:

```ts
  // Ask the host to read a repo's `.conduit/review-notes.json`, push it, and start watching that
  // `.conduit/` for external edits. Idempotent; the renderer sends it once per root.
  | { type: 'review:loadNotes'; root: string }
  // Merge ONE change into a repo's notes. The host applies the patch to its in-memory list,
  // writes the artifact, and echoes the whole repo to every window (§3). A patch rather than a
  // list so two windows converge on a merge instead of clobbering each other.
  | { type: 'review:setNotes'; root: string; patch: ReviewNotePatch }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck`
Expected: PASS (both tsconfigs).

- [ ] **Step 5: Commit**

```bash
git add src/protocol.ts
git commit -m "feat(review): add the review:notes protocol pair"
```

---

## Task 5: Host store, watcher and IPC

**Files:**
- Create: `electron/notes-watcher.ts`
- Modify: `electron/main.ts`
- Test: `test/unit/notes-watcher.test.ts`

**Interfaces:**
- Consumes: `ConduitDirWatch` (`electron/conduit-dir-watch.ts`), `isSelfEcho` (`src/board-watch.ts`), `REVIEW_NOTES_FILE_NAME` / `readReviewNotesBlob` / `readReviewNotesForProject` / `writeReviewNotesArtifactFile` (Task 2), `readReviewNotesArtifact` (Task 2), `applyNotePatch` / `notesFingerprint` / `isNote` (Task 1), `normalizeRoot` (`src/review-marks.ts`).
- Produces:
  - `electron/notes-watcher.ts`: `class NotesWatcher { watch(root, onChange); recordWrite(fp); stop(); }`
  - `electron/main.ts`: `case 'review:loadNotes'`, `case 'review:setNotes'`.

`isSelfEcho` is **imported, not re-implemented** — it is already generic over two fingerprint strings, and a second copy is exactly the duplication `npm run verify` checks for (assumption 15). Only the fingerprint (`notesFingerprint`) is Lane F's.

The host keeps `reviewNotes: Map<string, ReviewNotesData>` keyed by normalised root, but the **watcher watches one root at a time** — the same shape as `BoardWatcher`, and the same reasoning: the user reviews one repo at a time, and an unbounded set of recursive-adjacent watches is a resource leak nobody asked for. Re-`watch`ing simply re-points it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/notes-watcher.test.ts` (modelled on `test/unit/board-watcher.test.ts`; reuse its helpers if `test/unit/watch-test-helpers.ts` already provides them):

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conduitDir, writeReviewNotesArtifactFile } from '../../electron/conduit-fs';
import { NotesWatcher } from '../../electron/notes-watcher';
import {
  anchorFor,
  notesFingerprint,
  type ReviewNote,
  type ReviewNotesData,
} from '../../src/review-notes';

let root: string;
let watcher: NotesWatcher;

const note = (body: string): ReviewNote => ({
  id: `note-${body}`,
  path: 'src/foo.ts',
  side: 'new',
  line: 1,
  anchor: anchorFor('a', null, null),
  snippet: 'a',
  body,
  createdAt: '2026-08-28T10:00:00.000Z',
});

const data = (body: string): ReviewNotesData => ({ version: 1, notes: [note(body)] });

/** Resolve on the first emit, or reject after `ms` — the watcher is debounced, so no polling. */
function nextEmit(w: NotesWatcher, dir: string, ms = 3000): Promise<ReviewNotesData> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no emit')), ms);
    w.watch(dir, (d) => {
      clearTimeout(timer);
      resolve(d);
    });
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-watch-'));
  fs.mkdirSync(conduitDir(root), { recursive: true });
  watcher = new NotesWatcher(20);
});
afterEach(() => {
  watcher.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('NotesWatcher', () => {
  it('emits an external edit to review-notes.json', async () => {
    const emitted = nextEmit(watcher, root);
    await writeReviewNotesArtifactFile(root, data('external'));
    expect((await emitted).notes[0].body).toBe('external');
  });

  it('suppresses the app own write echoing back', async () => {
    let emits = 0;
    watcher.watch(root, () => {
      emits++;
    });
    watcher.recordWrite(notesFingerprint(data('ours')));
    await writeReviewNotesArtifactFile(root, data('ours'));
    await new Promise((r) => setTimeout(r, 200));
    expect(emits).toBe(0);
  });

  it('still emits a genuine edit made after one of our own writes', async () => {
    watcher.recordWrite(notesFingerprint(data('ours')));
    const emitted = nextEmit(watcher, root);
    await writeReviewNotesArtifactFile(root, data('theirs'));
    expect((await emitted).notes[0].body).toBe('theirs');
  });

  it('ignores writes to another file in .conduit/', async () => {
    let emits = 0;
    watcher.watch(root, () => {
      emits++;
    });
    fs.writeFileSync(path.join(conduitDir(root), 'board.json'), '{}');
    await new Promise((r) => setTimeout(r, 200));
    expect(emits).toBe(0);
  });

  it('drops the recorded fingerprint on stop, so it cannot leak across projects', async () => {
    watcher.recordWrite(notesFingerprint(data('ours')));
    watcher.stop();
    const emitted = nextEmit(watcher, root);
    await writeReviewNotesArtifactFile(root, data('ours'));
    expect((await emitted).notes[0].body).toBe('ours');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/notes-watcher.test.ts`
Expected: FAIL — `Failed to resolve import "../../electron/notes-watcher"`.

- [ ] **Step 3: Write minimal implementation**

Create `electron/notes-watcher.ts`:

```ts
// Host-side live watcher for a project's `.conduit/review-notes.json`. It exists for ONE reason:
// picking up an EXTERNAL (agent) edit (spec 2026-08-27-review-supercharge §2 Lane F). Every change
// the app itself makes reaches the other window by broadcast, not by the filesystem — which is why
// the app's own write is suppressed here and why `.conduit/` is out of `fsChanged` entirely
// (src/watch-filter.ts). Structure mirrors board-watcher.ts; the loop-avoidance predicate is the
// shared, unit-tested `isSelfEcho`.

import { isSelfEcho } from '../src/board-watch';
import { readReviewNotesArtifact } from '../src/conduit-store';
import { notesFingerprint, type ReviewNotesData } from '../src/review-notes';
import { ConduitDirWatch } from './conduit-dir-watch';
import { readReviewNotesBlob, REVIEW_NOTES_FILE_NAME } from './conduit-fs';

export type OnExternalNotes = (notes: ReviewNotesData) => void;

export class NotesWatcher {
  private readonly watch_: ConduitDirWatch;
  private root = '';
  private onChange: OnExternalNotes | null = null;
  private lastWritten: string | undefined;

  constructor(debounceMs = 250) {
    this.watch_ = new ConduitDirWatch(debounceMs, 'notes-watcher');
  }

  /** Start watching `<projectRoot>/.conduit/review-notes.json`; replaces any prior watch. */
  watch(projectRoot: string, onChange: OnExternalNotes): void {
    this.stop();
    if (!projectRoot) return;
    this.root = projectRoot;
    this.onChange = onChange;
    this.watch_.start(
      projectRoot,
      (filename) => !filename || filename === REVIEW_NOTES_FILE_NAME,
      () => this.readbackAndEmit(),
    );
  }

  /** Fingerprint of the notes the app is about to write, so the imminent FS event is its own echo. */
  recordWrite(fingerprint: string): void {
    this.lastWritten = fingerprint;
  }

  stop(): void {
    this.watch_.stop();
    this.root = '';
    this.onChange = null;
    this.lastWritten = undefined;
  }

  private readbackAndEmit(): void {
    if (!this.root || !this.onChange) return;
    // `undefined` means unreadable right now (mid-write, locked — common on Windows during an
    // external writer's rename). Skip rather than emit an empty list over the user's notes.
    const blob = readReviewNotesBlob(this.root);
    if (blob === undefined) return;
    const notes = readReviewNotesArtifact(blob);
    if (isSelfEcho(this.lastWritten, notesFingerprint(notes))) return;
    this.onChange(notes);
  }
}
```

In `electron/main.ts` — imports:

```ts
import {
  // …existing conduit-fs imports…
  readReviewNotesForProject,
  writeReviewNotesArtifactFile,
} from './conduit-fs';
import { NotesWatcher } from './notes-watcher';
import {
  applyNotePatch,
  emptyNotesData,
  notesFingerprint,
  type ReviewNotesData,
} from '../src/review-notes';
```

Beside `let reviewMarks = …` (inside the same scope that owns `boardWatcher`):

```ts
  // Per-repo review notes, held in memory and pushed to windows directly — two windows share one
  // main process, so a change never needs an FS round trip to reach the other (§2 Lane F). The
  // ARTIFACT is the durable copy; there is no quit flush, because every mutation writes through.
  const reviewNotes = new Map<string, ReviewNotesData>();
  const notesWatcher = new NotesWatcher();

  const pushNotes = (dispatch: Dispatch, root: string, data: ReviewNotesData): void => {
    dispatch({ type: 'review:notes', root, notes: data.notes });
  };
```

The two cases, beside `case 'review:setMark'`:

```ts
        case 'review:loadNotes': {
          const root = normalizeRoot(m.root);
          if (!root) break;
          const data = reviewNotes.get(root) ?? readReviewNotesForProject(m.root);
          reviewNotes.set(root, data);
          pushNotes(replyHere, root, data);
          // One repo at a time, like the board watcher: re-pointing is what a source switch does.
          notesWatcher.watch(m.root, (external) => {
            reviewNotes.set(root, external);
            pushNotes(broadcast, root, external);
          });
          break;
        }
        case 'review:setNotes': {
          const root = normalizeRoot(m.root);
          if (!root) break;
          const current = reviewNotes.get(root) ?? readReviewNotesForProject(m.root);
          // `applyNotePatch` validates the payload itself (a malformed note is a no-op): this file
          // outlives every window, so nothing unchecked may be persisted into it.
          const next: ReviewNotesData = { version: 1, notes: applyNotePatch(current.notes, m.patch) };
          reviewNotes.set(root, next);
          // Every window, not just the sender: both may be showing the same repo (§4).
          pushNotes(broadcast, root, next);
          writeReviewNotesArtifactFile(m.root, next)
            .then(() => {
              // Record ONLY on success: a rejected write left the file unchanged, so priming the
              // echo guard would suppress a later genuine external edit (the board write's lesson).
              notesWatcher.recordWrite(notesFingerprint(next));
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              console.error('Failed to write .conduit/review-notes.json:', message);
              replyHere({ type: 'error', message: `Could not save notes: ${message}` });
            });
          break;
        }
```

`emptyNotesData` is imported for the `reviewNotes` fallback in the `pushNotes` helper's callers; if Biome flags it as unused after the final shape, drop it rather than keeping a dead import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/notes-watcher.test.ts && npm run typecheck`
Expected: PASS — 5 tests, both tsconfigs clean.

- [ ] **Step 5: Commit**

```bash
git add electron/notes-watcher.ts electron/main.ts test/unit/notes-watcher.test.ts
git commit -m "feat(review): host-owned review notes with an external-edit watcher"
```

---

## Task 6: The renderer notes store

**Files:**
- Create: `webview/review-notes-store.ts`
- Modify: `webview/bridge.ts`
- Test: `test/unit/review-notes-store.test.ts`

**Interfaces:**
- Consumes: `post` / `subscribe` (`webview/bridge.ts`), `applyNotePatch` (Task 1), `normalizeRoot` (`src/review-marks.ts`).
- Produces: `NotesSnapshot`; `subscribeNotes`, `getNotesSnapshot`, `loadNotesFor(root)`, `notesFor(snapshot, root)`, `notesLoaded(snapshot, root)`, `patchNotes(root, patch)`.

A module-singleton external store mirroring `webview/review-marks-store.ts`, with one difference: the load gate is **per root**, because loading is on demand (assumption 7). `notesLoaded` is the gate every note control reads.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review-notes-store.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const posted: unknown[] = [];
let emit: (msg: unknown) => void = () => {};

vi.mock('../../webview/bridge', () => ({
  post: (m: unknown) => {
    posted.push(m);
  },
  subscribe: (cb: (m: unknown) => void) => {
    emit = cb;
    return () => {};
  },
}));

const {
  getNotesSnapshot,
  loadNotesFor,
  notesFor,
  notesLoaded,
  patchNotes,
  subscribeNotes,
} = await import('../../webview/review-notes-store');
const { anchorFor } = await import('../../src/review-notes');

const ROOT = 'C:/work/repo';
const note = (id: string) => ({
  id,
  path: 'src/foo.ts',
  side: 'new' as const,
  line: 1,
  anchor: anchorFor('a', null, null),
  snippet: 'a',
  body: 'why?',
  createdAt: '2026-08-28T10:00:00.000Z',
});

beforeEach(() => {
  posted.length = 0;
});

describe('review notes store', () => {
  it('is NOT loaded for a root until a push lands, and posts one load request per root', () => {
    expect(notesLoaded(getNotesSnapshot(), ROOT)).toBe(false);
    loadNotesFor(ROOT);
    loadNotesFor(ROOT);
    expect(posted).toEqual([{ type: 'review:loadNotes', root: 'c:/work/repo' }]);

    emit({ type: 'review:notes', root: 'c:/work/repo', notes: [] });
    expect(notesLoaded(getNotesSnapshot(), ROOT)).toBe(true);
    expect(notesFor(getNotesSnapshot(), ROOT)).toEqual([]);
  });

  it('folds a root key case-insensitively only for a drive-letter root', () => {
    emit({ type: 'review:notes', root: 'C:/Work/Repo', notes: [note('a')] });
    expect(notesFor(getNotesSnapshot(), 'c:/work/repo')).toHaveLength(1);
  });

  it('applies a patch optimistically and posts it', () => {
    emit({ type: 'review:notes', root: ROOT, notes: [] });
    const seen: number[] = [];
    const off = subscribeNotes(() => seen.push(notesFor(getNotesSnapshot(), ROOT).length));

    patchNotes(ROOT, { op: 'add', note: note('n1') });
    expect(notesFor(getNotesSnapshot(), ROOT)).toHaveLength(1);
    expect(seen).toEqual([1]);
    expect(posted.at(-1)).toEqual({
      type: 'review:setNotes',
      root: 'c:/work/repo',
      patch: { op: 'add', note: note('n1') },
    });
    off();
  });

  it('lets the host echo win over the optimistic list', () => {
    emit({ type: 'review:notes', root: ROOT, notes: [] });
    patchNotes(ROOT, { op: 'add', note: note('n1') });
    emit({ type: 'review:notes', root: ROOT, notes: [note('n2')] });
    expect(notesFor(getNotesSnapshot(), ROOT).map((n) => n.id)).toEqual(['n2']);
  });

  it('leaves other roots untouched on a push', () => {
    emit({ type: 'review:notes', root: '/a', notes: [note('a')] });
    emit({ type: 'review:notes', root: '/b', notes: [note('b')] });
    expect(notesFor(getNotesSnapshot(), '/a')).toHaveLength(1);
    expect(notesFor(getNotesSnapshot(), '/b')).toHaveLength(1);
  });

  it('returns a STABLE empty array for an unknown root, so a memo does not re-run', () => {
    const a = notesFor(getNotesSnapshot(), '/never-loaded');
    const b = notesFor(getNotesSnapshot(), '/never-loaded');
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-notes-store.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/review-notes-store"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview/review-notes-store.ts`:

```ts
import type { ReviewNote, ReviewNotePatch } from '../src/protocol';
import { normalizeRoot } from '../src/review-marks';
import { applyNotePatch } from '../src/review-notes';
import { post, subscribe } from './bridge';

/**
 * Renderer mirror of the host's per-repo review notes (spec 2026-08-27-review-supercharge §2
 * Lane F). A module-singleton external store, mirroring review-marks-store.ts: views read it with
 * useSyncExternalStore and the host stays the single owner of the artifact.
 *
 * The load gate is PER ROOT (not one global flag as the marks store has): notes are a per-project
 * artifact the host only reads when asked, so "no notes yet" and "not asked yet" are different
 * answers and only the second one may disable a control (§4).
 */

export interface NotesSnapshot {
  byRoot: ReadonlyMap<string, readonly ReviewNote[]>;
}

type Listener = () => void;

/** Stable identity so a memo over "this root has no notes" doesn't re-run every render. */
const EMPTY: readonly ReviewNote[] = [];

let snapshot: NotesSnapshot = { byRoot: new Map() };
const listeners = new Set<Listener>();
const requested = new Set<string>();

function set(key: string, notes: readonly ReviewNote[]): void {
  const byRoot = new Map(snapshot.byRoot);
  byRoot.set(key, notes);
  snapshot = { byRoot };
  listeners.forEach((l) => {
    l();
  });
}

subscribe((msg) => {
  if (msg.type === 'review:notes') set(normalizeRoot(msg.root), msg.notes);
});

export function subscribeNotes(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getNotesSnapshot(): NotesSnapshot {
  return snapshot;
}

export function notesFor(snap: NotesSnapshot, root: string): readonly ReviewNote[] {
  return snap.byRoot.get(normalizeRoot(root)) ?? EMPTY;
}

/** The load gate: false until the host has answered for THIS root. */
export function notesLoaded(snap: NotesSnapshot, root: string): boolean {
  return snap.byRoot.has(normalizeRoot(root));
}

/** Ask the host to read + watch a repo's notes. Idempotent per root for the window's lifetime. */
export function loadNotesFor(root: string): void {
  const key = normalizeRoot(root);
  if (!key || requested.has(key)) return;
  requested.add(key);
  post({ type: 'review:loadNotes', root: key });
}

/**
 * Apply one change locally first so the row answers in the same frame; the host's echo replaces the
 * optimistic list a tick later and wins any cross-window race.
 */
export function patchNotes(root: string, patch: ReviewNotePatch): void {
  const key = normalizeRoot(root);
  set(key, applyNotePatch(snapshot.byRoot.get(key) ?? EMPTY, patch));
  post({ type: 'review:setNotes', root: key, patch });
}
```

In `webview/bridge.ts` — the no-host preview shell. Beside the existing `review:setMark` handler:

```ts
  if (msg.type === 'review:loadNotes') {
    setTimeout(() => emit({ type: 'review:notes', root: msg.root, notes: previewNotes(msg.root) }), 15);
    return;
  }
  if (msg.type === 'review:setNotes') {
    const next = applyNotePatch(previewNotes(msg.root), msg.patch);
    previewNotesByRoot.set(msg.root, next);
    setTimeout(() => emit({ type: 'review:notes', root: msg.root, notes: next }), 15);
    return;
  }
```

…with, near the file's other mock state:

```ts
// Preview-only note store: the browser shell has no host, and a Review with permanently disabled
// note controls would misrepresent the surface (see the fake-shell note in CLAUDE.md).
const previewNotesByRoot = new Map<string, ReviewNote[]>();
const previewNotes = (root: string): ReviewNote[] => previewNotesByRoot.get(root) ?? [];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/review-notes-store.test.ts && npm run typecheck`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add webview/review-notes-store.ts webview/bridge.ts test/unit/review-notes-store.test.ts
git commit -m "feat(review): renderer notes store fed by the host broadcast"
```

---

## Task 7: Bind `c` in the Review keymap

**Files:**
- Modify: `webview/review-keymap.ts`
- Test: `test/unit/review-keymap.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ReviewAction` gains `'addNote'`; `ACTIONS.c === 'addNote'`; a `REVIEW_KEY_HELP` row.

`c` is listed as unbound in that file's header comment ("Keys this lane does NOT bind: … `c` (Lane F)"); update that comment as part of the change so it stays true.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/review-keymap.test.ts`:

```ts
  it('maps c to addNote, and leaves Shift+C unbound', () => {
    expect(reviewActionFor({ ...base, key: 'c' })).toBe('addNote');
    expect(reviewActionFor({ ...base, key: 'C' })).toBeNull();
  });

  it('does not map c while a modifier is held', () => {
    expect(reviewActionFor({ ...base, key: 'c', ctrlKey: true })).toBeNull();
    expect(reviewActionFor({ ...base, key: 'c', metaKey: true })).toBeNull();
  });

  it('prints the note key in the help panel', () => {
    expect(REVIEW_KEY_HELP.some((r) => r.keys === 'c')).toBe(true);
  });
```

(`base` is the existing all-modifiers-false literal in that file; add `REVIEW_KEY_HELP` to its imports if it is not there yet.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-keymap.test.ts`
Expected: FAIL — `expected null to be 'addNote'`.

- [ ] **Step 3: Write minimal implementation**

In `webview/review-keymap.ts`:

```ts
export type ReviewAction =
  | 'nextHunk'
  | 'prevHunk'
  | 'nextFile'
  | 'prevFile'
  | 'toggleReviewed'
  | 'openHunk'
  | 'addNote'
  | 'expandAll'
  | 'collapseAll'
  | 'toggleHelp';
```

```ts
  o: 'openHunk',
  Enter: 'openHunk',
  c: 'addNote',
```

```ts
  { keys: 'c', description: 'Add a note on the current change' },
```
…placed after the `o / Enter` row, and the header comment narrowed to:

```ts
 * Keys this lane does NOT bind: `s`/`d` (Lane E), `/` and `Mod+F` (Lane C).
```

`Shift+C` stays unbound: `reviewActionFor` already rejects a shifted press of an unshifted letter binding, so no extra code is needed — the test pins that.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/review-keymap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webview/review-keymap.ts test/unit/review-keymap.test.ts
git commit -m "feat(review): bind c to adding a note"
```

---

## Task 8: The `--note-accent` token and the note styling

**Files:**
- Modify: `webview/styles.css`
- Test: `test/unit/theme-tokens.test.ts`

**Interfaces:**
- Consumes: the existing per-theme token blocks (`:root` = Aero Dark, `:root[data-theme="aero"]`, `:root[data-theme="neon"]`).
- Produces: `--note-accent` in all three; `.rline__note`, `.rline__notecount`, `.rnote*`, `.rcard__detached*`, `.review__handoff`, `.ndec` (the editor glyph).

Colour is never the only signal (§10): a resolved note also strikes its body and says "Resolved", a detached one says "lost its place", and the editor glyph is a shape, not a wash. The `+` is **inert at rest** — the hover-obstruction rule.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/theme-tokens.test.ts`, inside the `theme token contrast on the code surface` loop (it already has `tokens` and `surface` in scope):

```ts
    it(`${id}: --note-accent is declared and reads on ${surface}`, () => {
      expect(contrast(resolve(tokens, '--note-accent'), surface)).toBeGreaterThanOrEqual(3);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/theme-tokens.test.ts`
Expected: FAIL — `token --note-accent is not declared` (three times).

- [ ] **Step 3: Write minimal implementation**

In `webview/styles.css`, beside `--change-added` in each of the three blocks:

```css
  /* Lane F: review notes — the thread rail, the `+` affordance and the editor glyph
     (spec 2026-08-27-review-supercharge §11). */
  --note-accent: #7f9cf5;   /* :root (Aero Dark) */
```
```css
  --note-accent: #5a76d8;   /* :root[data-theme="aero"] — darker, the page is light */
```
```css
  --note-accent: #00d8ff;   /* :root[data-theme="neon"] */
```

> Each value must be re-measured against that theme's `--code-base` when written — the test above is the gate, not this table. If a value comes in under 3:1, darken/lighten it rather than lowering the threshold.

Then the surfaces:

```css
/* ---- review notes (spec 2026-08-27-review-supercharge §2 Lane F) ---- */

/* The `+` sits over the sign column and is INERT until its row is hovered or holds focus.
   An always-live overlay in a scrolling list is the hover-obstruction bug this repo shipped
   once already. */
.rline__note {
  position: absolute;
  left: 0;
  width: var(--density-rgutter-w);
  border: 0;
  background: none;
  color: var(--note-accent);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  font: inherit;
  line-height: inherit;
}
.rline:hover .rline__note,
.rline:focus-within .rline__note {
  opacity: 1;
  pointer-events: auto;
}
.rline__note:focus-visible {
  opacity: 1;
  pointer-events: auto;
  outline: 1px solid var(--note-accent);
}
/* The row becomes the positioning context for the affordance; nothing else about it changes. */
.rline {
  position: relative;
}
/* A row that already carries notes says so without hovering. */
.rline__notecount {
  flex: 0 0 auto;
  padding: 0 6px;
  color: var(--note-accent);
  font-size: calc(10px * var(--font-scale));
  align-self: flex-start;
  user-select: none;
}

.rnote,
.rnote-composer {
  border-left: 3px solid var(--note-accent);
  padding: 6px 10px 6px 12px;
  font-family: var(--font-ui);
  font-size: calc(12px * var(--font-scale));
  background: var(--surface-2);
}
.rnote__body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rnote--resolved .rnote__body {
  text-decoration: line-through;
  color: var(--text-faint);
}
.rnote__meta {
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--text-faint);
  font-size: calc(10.5px * var(--font-scale));
}
.rnote__act {
  border: 0;
  background: none;
  color: var(--text-faint);
  cursor: pointer;
  padding: 0;
}
.rnote__act:hover {
  color: var(--text);
}
.rnote-composer__field {
  width: 100%;
  min-height: calc(48px * var(--font-scale));
  resize: vertical;
  font: inherit;
  color: var(--text);
  background: var(--surface-1);
  border: 1px solid var(--line);
}
.rnote-composer__row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-top: 6px;
}
.rnote-composer__hint,
.rnote-composer__error {
  color: var(--text-faint);
  font-size: calc(10.5px * var(--font-scale));
}
.rnote-composer__error {
  color: var(--red);
}

/* Notes whose anchor is gone: listed at the TOP of the card, never dropped (§2 Lane F). */
.rcard__detached {
  border-left: 3px dashed var(--note-accent);
  padding: 6px 10px;
  font-size: calc(11.5px * var(--font-scale));
}

.review__handoff {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-top: 8px;
}

/* The editor's note glyph (glyph margin, Lane A's decoration machinery — NOT a view zone). */
.ndec {
  background: var(--note-accent);
  mask: var(--icon-note-mask) center / 12px 12px no-repeat;
  -webkit-mask: var(--icon-note-mask) center / 12px 12px no-repeat;
}
@media (forced-colors: active) {
  .ndec {
    background: CanvasText;
  }
}
@media (prefers-reduced-motion: reduce) {
  .rnote,
  .rnote-composer {
    transition: none;
  }
}
```

`--icon-note-mask` is an inline `url("data:image/svg+xml,…")` speech-bubble path declared once in `:root` beside the other icon masks; if the file has no such convention, draw the glyph with a `::after` border triangle exactly as `.cdec--deleted` does and drop the mask entirely — do not add a new asset pipeline for one 12px mark.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/theme-tokens.test.ts`
Expected: PASS — three new assertions.

- [ ] **Step 5: Commit**

```bash
git add webview/styles.css test/unit/theme-tokens.test.ts
git commit -m "feat(review): the note accent token and the note row styling"
```

---

## Task 9: The note thread, composer and detached list components

**Files:**
- Create: `webview/components/note-thread.tsx`
- Test: covered by Task 15's e2e and by the pure helpers already under test; no new unit file (these are presentational and hold no logic that isn't in `src/review-notes.ts`).

**Interfaces:**
- Consumes: `ReviewNote`, `AnchoredNote`, `MAX_NOTE_BODY` (Task 1); `relativeTime` (`webview/relative-time.ts`).
- Produces:
  - `NoteThread({ note, disabled, onEdit, onResolve, onDelete })`
  - `NoteComposer({ label, initialBody, refused, onSave, onCancel, onDirtyChange })`
  - `DetachedNotes({ notes, disabled, onResolve, onDelete })`

The composer owns its draft and reports dirtiness up so `ReviewView` can apply the confirm-on-cancel rule from either entry point (the button or the global `Esc`) — assumption 12.

- [ ] **Step 1: Write the failing test**

None of its own. The behaviour these render is asserted end-to-end in Task 15; adding a jsdom harness for three presentational components would be test surface without a failure mode behind it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run typecheck`
Expected: FAIL once Task 10 imports the module and it does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `webview/components/note-thread.tsx`:

```tsx
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import type { ReviewNote } from '../../src/protocol';
import { type AnchoredNote, MAX_NOTE_BODY } from '../../src/review-notes';
import { relativeTime } from '../relative-time';

/** One note, rendered as a row inside the card's hunk rows (spec §2 Lane F, §8 "Note row"). */
export function NoteThread({
  note,
  disabled,
  onEdit,
  onResolve,
  onDelete,
}: {
  note: ReviewNote;
  /** True before the first `review:notes` push for this repo — the load gate (§4). */
  disabled: boolean;
  onEdit: (id: string, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (note: ReviewNote) => void;
}) {
  const [editing, setEditing] = useState(false);
  const resolved = note.resolvedAt !== undefined;

  if (editing) {
    return (
      <NoteComposer
        label={`Edit note on line ${note.line}`}
        initialBody={note.body}
        onSave={(body) => {
          onEdit(note.id, body);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className={`rnote${resolved ? ' rnote--resolved' : ''}`} data-note-id={note.id}>
      <div className="rnote__body">{note.body}</div>
      <div className="rnote__meta">
        <span>{relativeTime(note.createdAt)}</span>
        {/* Text, not colour alone (§10). */}
        {resolved && <span>Resolved</span>}
        {note.sentAt && <span>Sent</span>}
        <button
          type="button"
          className="rnote__act rnote__edit"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button
          type="button"
          className="rnote__act rnote__resolve"
          disabled={disabled}
          aria-pressed={resolved}
          onClick={() => onResolve(note.id, !resolved)}
        >
          {resolved ? 'Unresolve' : 'Resolve'}
        </button>
        <button
          type="button"
          className="rnote__act rnote__delete"
          disabled={disabled}
          onClick={() => onDelete(note)}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * The inline composer row. `Mod+Enter` saves, `Esc` cancels — and the Esc keydown is stopped here
 * so it never reaches ReviewView's window-level Escape handler, which would close Review.
 */
export function NoteComposer({
  label,
  initialBody = '',
  refused,
  onSave,
  onCancel,
  onDirtyChange,
}: {
  label: string;
  initialBody?: string;
  /** Set when the repo is at its open-note cap; the field is read-only and the guidance shows. */
  refused?: string;
  onSave: (body: string) => void;
  onCancel: (dirty: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [body, setBody] = useState(initialBody);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dirty = body.trim() !== initialBody.trim();

  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (body.trim()) onSave(body);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel(dirty);
    }
  };

  return (
    <div className="rnote-composer">
      <label className="sr-only" htmlFor="rnote-composer-field">
        {label}
      </label>
      <textarea
        id="rnote-composer-field"
        ref={ref}
        className="rnote-composer__field"
        value={body}
        maxLength={MAX_NOTE_BODY}
        readOnly={!!refused}
        aria-label={label}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="rnote-composer__row">
        <button
          type="button"
          className="btn btn--primary rnote-composer__save"
          disabled={!!refused || !body.trim()}
          onClick={() => onSave(body)}
        >
          Save
        </button>
        <button
          type="button"
          className="btn rnote-composer__cancel"
          onClick={() => onCancel(dirty)}
        >
          Cancel
        </button>
        {refused ? (
          <span className="rnote-composer__error" role="alert">
            {refused}
          </span>
        ) : (
          <span className="rnote-composer__hint">Ctrl/Cmd+Enter to save · Esc to cancel</span>
        )}
      </div>
    </div>
  );
}

/** Notes whose anchor no longer matches anything within the radius (§2 Lane F: never dropped). */
export function DetachedNotes({
  notes,
  disabled,
  onResolve,
  onDelete,
}: {
  notes: readonly AnchoredNote[];
  disabled: boolean;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (note: ReviewNote) => void;
}) {
  if (notes.length === 0) return null;
  return (
    <div className="rcard__detached" role="note">
      <p>
        {notes.length} note{notes.length === 1 ? '' : 's'} lost{' '}
        {notes.length === 1 ? 'its' : 'their'} place
      </p>
      {notes.map(({ note }) => (
        <div key={note.id} className="rnote rnote--detached" data-note-id={note.id}>
          <div className="rnote__body">
            was on line {note.line}: <code>{note.snippet}</code> — {note.body}
          </div>
          <div className="rnote__meta">
            <button
              type="button"
              className="rnote__act rnote__resolve"
              disabled={disabled}
              onClick={() => onResolve(note.id, note.resolvedAt === undefined)}
            >
              {note.resolvedAt === undefined ? 'Resolve' : 'Unresolve'}
            </button>
            <button
              type="button"
              className="rnote__act rnote__delete"
              disabled={disabled}
              onClick={() => onDelete(note)}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

> `relativeTime`'s exact export name must be checked against `webview/relative-time.ts` before writing this; History already renders timestamps through it and Lane F must use the same one rather than formatting a second way.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck`
Expected: the module compiles; the unused-export warning stands until Task 10 imports it.

- [ ] **Step 5: Commit**

```bash
git add webview/components/note-thread.tsx
git commit -m "feat(review): note thread, composer and detached-note rows"
```

---

## Task 10: Wire notes into the Review view

**Files:**
- Modify: `webview/components/review-view.tsx`, `webview/components/center-pane.tsx`
- Test: covered by Task 16's e2e (this is DOM glue over already-tested pure code).

**Interfaces:**
- Consumes: the notes store (Task 6), `note-thread.tsx` (Task 9), `reanchor` / `anchorFor` / `snippetOf` / `newNoteId` / `canAddNote` / `pendingNotes` (Task 1), `ConfirmDialog` (`webview/components/confirm-dialog.tsx`).
- Produces: the `+` affordance, the composer, note rows, the detached list, height invalidation, the `addNote` key action, and `sessionLabel` on `ReviewView`'s props.

**Six edits, in order.** Do them one at a time and keep `npm run typecheck` green between each.

### 10a — rename `marksRoot` to `repoKey`

`marksRoot` is now the key for two stores. Six references (`review-view.tsx` around the marks block and `canMark`/`onToggleReviewed`/the stale-mark effect). Mechanical; no behaviour change.

```ts
  const repoKey = effectiveRoot ? normalizeRoot(effectiveRoot) : '';
  const rootMarks = marks.byRoot.get(repoKey) ?? EMPTY_MARKS;
```

### 10b — subscribe, load, and index the notes

Beside the marks block:

```ts
  // Per-repo review notes. Durable, host-owned and shared across windows (§2 Lane F); this view
  // reads them and sends one patch at a time.
  const notesSnapshot = useSyncExternalStore(subscribeNotes, getNotesSnapshot, getNotesSnapshot);
  const repoNotes = notesFor(notesSnapshot, repoKey);
  const notesReady = notesLoaded(notesSnapshot, repoKey);

  useEffect(() => {
    if (repoKey) loadNotesFor(repoKey);
  }, [repoKey]);

  const notesByPath = useMemo(() => {
    const m = new Map<string, ReviewNote[]>();
    for (const n of repoNotes) {
      const list = m.get(n.path);
      if (list) list.push(n);
      else m.set(n.path, [n]);
    }
    return m;
  }, [repoNotes]);
```

…with `const EMPTY_NOTES: ReviewNote[] = [];` beside `EMPTY_MARKS` (same reason: a stable identity so an unnoted card's memo doesn't re-run).

### 10c — height-cache invalidation

A card whose note rows change is a different height, and a card the window has unmounted cannot report that itself. One helper, shared with Lane C (see the collision table):

```ts
  /** Drop a path's measured slot height so the next mount re-measures it. Called whenever
   *  something OUTSIDE the card changes how tall it renders — today, its note rows. */
  const invalidateHeight = useCallback((path: string) => {
    measuredRef.current.delete(path);
    setMeasureTick((t) => t + 1);
  }, []);

  // Note counts per path, so a change invalidates exactly the affected card's height.
  const noteCountsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const seen = new Set<string>();
    for (const [path, list] of notesByPath) {
      seen.add(path);
      if (noteCountsRef.current.get(path) !== list.length) {
        noteCountsRef.current.set(path, list.length);
        invalidateHeight(path);
      }
    }
    for (const path of [...noteCountsRef.current.keys()]) {
      if (seen.has(path)) continue;
      noteCountsRef.current.delete(path);
      invalidateHeight(path);
    }
  }, [notesByPath, invalidateHeight]);
```

The composer opening/closing changes height too, and is handled the same way where `composer` is set (below).

### 10d — composer state, the Esc chain, and the five mutations

Composer state lives here, not in the card (assumption 12):

```ts
  const [composer, setComposer] = useState<{
    path: string;
    side: NoteSide;
    line: number;
    snippet: string;
    anchor: string;
  } | null>(null);
  const composerDirtyRef = useRef(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  /** The `+` that opened the composer, so focus can return to it on close (§10). */
  const composerOriginRef = useRef<HTMLElement | null>(null);

  const closeComposer = useCallback(() => {
    const path = composer?.path;
    composerDirtyRef.current = false;
    setComposer(null);
    if (path) invalidateHeight(path);
    const origin = composerOriginRef.current;
    composerOriginRef.current = null;
    origin?.focus();
  }, [composer, invalidateHeight]);

  const requestCloseComposer = useCallback(
    (dirty: boolean) => {
      if (!dirty) {
        closeComposer();
        return;
      }
      setConfirm({
        title: 'Discard this note?',
        message: "It hasn't been saved yet.",
        confirmLabel: 'Discard',
        danger: true,
        focusCancel: true,
        onConfirm: closeComposer,
      });
    },
    [closeComposer],
  );
```

The Esc chain — replace the existing `useEscapeKey` callback so it unwinds composer → help → Review (Lane C inserts search between the first two; see the collision table):

```ts
  useEscapeKey(
    useCallback(() => {
      if (confirmRef.current) return; // ConfirmDialog owns its own Escape
      if (composerRef.current) {
        requestCloseComposer(composerDirtyRef.current);
        return;
      }
      if (helpOpenRef.current) {
        setHelpOpen(false);
        return;
      }
      onClose();
    }, [onClose, requestCloseComposer]),
  );
```
…with `composerRef` / `confirmRef` assigned on every render exactly as `helpOpenRef` already is, so the window listener is not re-bound per keystroke.

The mutations, all through the store:

```ts
  const openComposer = useCallback(
    (path: string, side: NoteSide, line: number, snippet: string, anchor: string, origin?: HTMLElement) => {
      if (!notesReady || !repoKey) {
        setAnnounce('Still loading notes for this repository');
        return;
      }
      composerOriginRef.current = origin ?? null;
      composerDirtyRef.current = false;
      setComposer({ path, side, line, snippet, anchor });
      invalidateHeight(path);
    },
    [notesReady, repoKey, invalidateHeight],
  );

  const saveNote = useCallback(
    (body: string) => {
      if (!composer || !repoKey) return;
      const note: ReviewNote = {
        id: newNoteId(),
        path: composer.path,
        side: composer.side,
        line: composer.line,
        anchor: composer.anchor,
        snippet: composer.snippet,
        body,
        createdAt: new Date().toISOString(),
      };
      patchNotes(repoKey, { op: 'add', note });
      setAnnounce(`Note added on line ${composer.line} of ${composer.path}`);
      closeComposer();
    },
    [composer, repoKey, closeComposer],
  );

  const editNote = useCallback(
    (id: string, body: string) => {
      if (repoKey) patchNotes(repoKey, { op: 'edit', id, body });
    },
    [repoKey],
  );

  const resolveNote = useCallback(
    (id: string, resolved: boolean) => {
      if (!repoKey) return;
      patchNotes(repoKey, { op: 'resolve', id, resolved, at: new Date().toISOString() });
      setAnnounce(resolved ? 'Note resolved' : 'Note reopened');
    },
    [repoKey],
  );

  // Destructive, so it confirms — the same dialog the Changes panel's Discard uses (D10).
  const deleteNote = useCallback(
    (note: ReviewNote) => {
      if (!repoKey) return;
      setConfirm({
        title: 'Delete this note?',
        message: `The note on line ${note.line} of ${note.path} will be removed. This can't be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        focusCancel: true,
        onConfirm: () => {
          patchNotes(repoKey, { op: 'delete', id: note.id });
          setAnnounce('Note deleted');
        },
      });
    },
    [repoKey],
  );
```

`c` in the key switch — "note on the current hunk's first line" (§2 Lane B's table):

```ts
        case 'addNote': {
          const el = scrollerRef.current?.querySelector<HTMLElement>(
            '.review__scroll [aria-current="true"]',
          );
          // The card knows the hunk's first line and its context; asking it is one click's worth
          // of DOM, and it is the same path the `+` takes.
          el?.closest('.rcard')?.querySelector<HTMLElement>('.rline__note')?.click();
          break;
        }
```

Render the dialog at the end of the component, beside the help panel:

```tsx
      {confirm && <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />}
```

### 10e — pass it all down, and delegate the `+`

`ReviewFileCard` gains six props (all stable identities, so the memo still holds):

```ts
  notes: readonly ReviewNote[];
  notesReady: boolean;
  composer: { side: NoteSide; line: number } | null;
  onAddNote: (path: string, side: NoteSide, line: number, snippet: string, anchor: string, origin?: HTMLElement) => void;
  onSaveNote: (body: string) => void;
  onCancelNote: (dirty: boolean) => void;
  onEditNote: (id: string, body: string) => void;
  onResolveNote: (id: string, resolved: boolean) => void;
  onDeleteNote: (note: ReviewNote) => void;
  onComposerDirty: (dirty: boolean) => void;
```
…passed as `notes={notesByPath.get(c.path) ?? EMPTY_NOTES}` and `composer={composer?.path === c.path ? composer : null}`.

Inside the card, re-anchor each side against the diff it is showing:

```ts
  // Re-anchored on every diff refresh (§2 Lane F). Cheap: two array scans per note, bounded by
  // REANCHOR_RADIUS, only for cards the window has mounted.
  const anchored = useMemo(() => {
    if (!diff || diff.binary) return { byLine: new Map<string, ReviewNote[]>(), detached: [] };
    const newLines = diff.work.split('\n');
    const oldLines = diff.head.split('\n');
    const all = [
      ...reanchor(notes.filter((n) => n.side === 'new'), newLines).map((a) => ({ ...a, side: 'new' as const })),
      ...reanchor(notes.filter((n) => n.side === 'old'), oldLines).map((a) => ({ ...a, side: 'old' as const })),
    ];
    const byLine = new Map<string, ReviewNote[]>();
    const detached: AnchoredNote[] = [];
    for (const a of all) {
      if (a.line === null) {
        detached.push(a);
        continue;
      }
      const key = `${a.side}:${a.line}`;
      const list = byLine.get(key);
      if (list) list.push(a.note);
      else byLine.set(key, [a.note]);
    }
    return { byLine, detached };
  }, [diff, notes]);
```

`DetachedNotes` renders directly under the card header, above the hunk list. The per-line rows and the composer are interleaved in `Hunk`:

```tsx
        {lines.map((l) => {
          const side: NoteSide = l.newLine !== null ? 'new' : 'old';
          const anchorLine = l.newLine ?? l.oldLine;
          const key = anchorLine === null ? '' : `${side}:${anchorLine}`;
          const rowNotes = notesByLine.get(key) ?? EMPTY_NOTES;
          const composing = composer !== null && composer.side === side && composer.line === anchorLine;
          return (
            <Fragment key={l.seq}>
              <Line
                line={l}
                hljsLang={hljsLang}
                emph={emphBySeq.get(l.seq)}
                noteSide={anchorLine === null ? null : side}
                noteAnchorLine={anchorLine}
                noteCount={rowNotes.length}
                notesReady={notesReady}
              />
              {rowNotes.map((n) => (
                <NoteThread
                  key={n.id}
                  note={n}
                  disabled={!notesReady}
                  onEdit={onEditNote}
                  onResolve={onResolveNote}
                  onDelete={onDeleteNote}
                />
              ))}
              {composing && (
                <NoteComposer
                  label={`Note on line ${anchorLine}`}
                  refused={refusedMessage}
                  onSave={onSaveNote}
                  onCancel={onCancelNote}
                  onDirtyChange={onComposerDirty}
                />
              )}
            </Fragment>
          );
        })}
```

`Line` gains **only primitives** (assumption 13) and renders the affordance plus the `data-*` the delegated handler reads:

```tsx
      <span className="rline__gutter">{line.oldLine ?? ''}</span>
      <span className="rline__gutter">{line.newLine ?? ''}</span>
      <span className="rline__sign">{SIGN[line.kind]}</span>
      {noteSide !== null && noteAnchorLine !== null && (
        <button
          type="button"
          className="rline__note"
          disabled={!notesReady}
          data-note-side={noteSide}
          data-note-line={noteAnchorLine}
          aria-label={`Add note on line ${noteAnchorLine}`}
          title="Add a note (c)"
        >
          +
        </button>
      )}
      {noteCount > 0 && (
        <span className="rline__notecount" aria-label={`${noteCount} note${noteCount === 1 ? '' : 's'}`}>
          {noteCount}
        </span>
      )}
```
…and the `<pre>` gains `data-seq={line.seq}` (Lane C needs it — see the collision table).

The delegated handler lives on `.rhunks` in `HunkList`, so no callback prop reaches `Line`:

```tsx
    <div
      className="rhunks inkbox"
      onClick={(e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('.rline__note');
        if (!btn) return;
        const side = btn.dataset.noteSide as NoteSide | undefined;
        const line = Number(btn.dataset.noteLine);
        if (!side || !Number.isFinite(line)) return;
        const row = btn.closest('.rline');
        const text = row?.querySelector('.rline__text')?.textContent ?? '';
        // Anchor context comes from the FileReview, not the DOM: the rows are capped and folded,
        // so the neighbours on screen are not always the neighbours in the file.
        const ctx = contextFor(review, side, line);
        onAddNote(path, side, line, snippetOf(text), anchorFor(text, ctx.prev, ctx.next), btn);
      }}
    >
```

`contextFor` is a small pure helper added at the bottom of `review-view.tsx` (or, better, beside `computeFileReview` in `src/review-hunks.ts` if a second caller appears): it walks the review's hunks + folds for the given side and returns `{ prev, next }` line texts, or `null` at a file edge. **The anchor must be computed from file content, never from the rendered rows** — a folded card would otherwise hash the wrong neighbours and every note would detach on the next load.

`refusedMessage` is derived once in `ReviewView` and passed down:

```ts
  const refusedMessage = canAddNote(repoNotes)
    ? undefined
    : 'Resolve or delete some notes first — this repository is at 500 open notes.';
```

### 10f — `sessionLabel` for the handoff toast

`center-pane.tsx` already has `active`; add one prop to the `<ReviewView>` element:

```tsx
                  sessionLabel={active?.name}
```
…and to `ReviewView`'s props (`sessionLabel?: string`), documented as "the Review doc's session, for the handoff toast — a Review only shows while its owning session is active."

- [ ] **Step 1: Write the failing test**

None here; Task 16's e2e is this task's test, and it is written before the wiring is finished so it fails first.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/e2e/run-smoke.mjs review-notes-handoff`
Expected: FAIL — no `.rline__note` in the DOM.

- [ ] **Step 3: Write minimal implementation**

The six edits above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run && npm run typecheck`
Expected: PASS. (The e2e goes green at the end of Task 16.)

- [ ] **Step 5: Commit**

```bash
git add webview/components/review-view.tsx webview/components/center-pane.tsx
git commit -m "feat(review): line notes in Review — composer, threads and the detached list"
```

---

## Task 11: The unified terminal bus

**Files:**
- Create: `webview/terminal-bus.ts`, `test/unit/terminal-bus.test.ts`
- Delete: `webview/terminal-focus-bus.ts`, `test/unit/terminal-focus-bus.test.ts`
- Modify: `webview/components/terminal-pane.tsx`, `webview/app.tsx`

**Interfaces:**
- Consumes: `isTypingEntry` (`webview/typing-guard.ts`).
- Produces: `TerminalApi`; `registerTerminal(sessionId, api): () => void`; `requestTerminalFocus(sessionId)`; `pasteToTerminal(sessionId, text): boolean`; `hasLiveTerminal(sessionId): boolean`; `shouldFocusActiveTerminal` (moved unchanged).

**Existing `requestTerminalFocus` callers that must keep working** (assumption 16 — the names do not change):

| Call site | What it does |
|---|---|
| `webview/app.tsx:667` | after creating/opening a session, `requestAnimationFrame(() => requestTerminalFocus(sessionId))` |
| `webview/app.tsx:805` | the active-session focus effect, gated on `shouldFocusActiveTerminal` |
| `webview/components/terminal-pane.tsx:683` | the subscriber — **this one changes**, from `subscribeTerminalFocus` to `registerTerminal` |
| `test/unit/terminal-focus-bus.test.ts` | replaced by `test/unit/terminal-bus.test.ts` |

The bus is a **registry**, not a fan-out: `paste` and `hasLiveTerminal` need to know whether a *specific* session has a live xterm, which a set of anonymous listeners cannot answer. Focus keeps working because a registry lookup is strictly more precise than the old broadcast-and-filter.

Paste goes through xterm's `paste()` so bracketed-paste mode is honoured — a multi-line handoff reaches a TUI as ONE atomic paste, not N lines each acting like Enter. **`term:input` is the wrong path** (it is what `mention-bus.ts` uses for a single short reference) and must not be copied here.

- [ ] **Step 1: Write the failing test**

Create `test/unit/terminal-bus.test.ts` — the whole of the old `terminal-focus-bus.test.ts`'s `shouldFocusActiveTerminal` describe block carried over verbatim, plus:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasLiveTerminal,
  pasteToTerminal,
  registerTerminal,
  requestTerminalFocus,
} from '../../webview/terminal-bus';

describe('terminal registry', () => {
  beforeEach(() => {
    // Each test registers and unregisters its own sessions; nothing leaks between them.
  });

  it('reports no live terminal for an unknown session', () => {
    expect(hasLiveTerminal('nope')).toBe(false);
    expect(pasteToTerminal('nope', 'hi')).toBe(false);
  });

  it('routes focus and paste to the registered session only', () => {
    const a = { focus: vi.fn(), paste: vi.fn() };
    const b = { focus: vi.fn(), paste: vi.fn() };
    const offA = registerTerminal('s1', a);
    const offB = registerTerminal('s2', b);

    requestTerminalFocus('s2');
    expect(a.focus).not.toHaveBeenCalled();
    expect(b.focus).toHaveBeenCalledTimes(1);

    expect(pasteToTerminal('s1', 'text')).toBe(true);
    expect(a.paste).toHaveBeenCalledWith('text');
    expect(b.paste).not.toHaveBeenCalled();

    offA();
    offB();
  });

  it('is no longer live after unmount, and a stale unregister cannot evict the remount', () => {
    const first = { focus: vi.fn(), paste: vi.fn() };
    const off = registerTerminal('s1', first);
    expect(hasLiveTerminal('s1')).toBe(true);

    // A remount registers BEFORE React runs the old instance's cleanup.
    const second = { focus: vi.fn(), paste: vi.fn() };
    const off2 = registerTerminal('s1', second);
    off(); // the stale cleanup
    expect(hasLiveTerminal('s1')).toBe(true);
    pasteToTerminal('s1', 'x');
    expect(second.paste).toHaveBeenCalledWith('x');
    expect(first.paste).not.toHaveBeenCalled();

    off2();
    expect(hasLiveTerminal('s1')).toBe(false);
  });

  it('focusing an unknown session is a silent no-op', () => {
    expect(() => requestTerminalFocus('gone')).not.toThrow();
  });

  it('records a paste on the harness spy when one exists', () => {
    const spy: Array<{ sessionId: string; text: string }> = [];
    (window as unknown as { __conduitPasteSpy?: unknown }).__conduitPasteSpy = spy;
    const off = registerTerminal('s1', { focus: vi.fn(), paste: vi.fn() });
    pasteToTerminal('s1', 'payload');
    expect(spy).toEqual([{ sessionId: 's1', text: 'payload' }]);
    off();
    (window as unknown as { __conduitPasteSpy?: unknown }).__conduitPasteSpy = undefined;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/terminal-bus.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/terminal-bus"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview/terminal-bus.ts`:

```ts
// The one channel between the rest of the renderer and a session's live xterm. Widened from the
// old focus-only fan-out (terminal-focus-bus.ts) into a sessionId-keyed REGISTRY, because Lane F's
// handoff has to ask a question a fan-out cannot answer — "does this session have a live terminal
// right now?" — and has to deliver text to that one terminal (spec §2 Lane F).
//
// Paste goes through xterm's own paste(), which honours bracketed-paste mode: a multi-line handoff
// reaches a TUI as ONE atomic paste rather than N lines each acting like Enter. Raw `term:input`
// (what mention-bus.ts uses for a short reference) would bypass that and is deliberately not used.

import { isTypingEntry } from './typing-guard';

export interface TerminalApi {
  focus(): void;
  /** xterm's paste(): bracketed, atomic, never followed by Enter. */
  paste(text: string): void;
}

const terminals = new Map<string, TerminalApi>();

/**
 * Register a session's live terminal. Returns the unregister. The unregister is IDENTITY-CHECKED:
 * React can mount a replacement before it runs the old instance's cleanup, and a blind delete
 * would then evict the terminal that is actually on screen.
 */
export function registerTerminal(sessionId: string, api: TerminalApi): () => void {
  terminals.set(sessionId, api);
  return () => {
    if (terminals.get(sessionId) === api) terminals.delete(sessionId);
  };
}

export function hasLiveTerminal(sessionId: string): boolean {
  return terminals.has(sessionId);
}

/** Hand focus to a session's terminal. Name unchanged from the focus bus — see the callers table. */
export function requestTerminalFocus(sessionId: string): void {
  terminals.get(sessionId)?.focus();
}

/** Deliver text to a session's terminal. False when it has none (the caller offers a fallback). */
export function pasteToTerminal(sessionId: string, text: string): boolean {
  // Test observability (opt-in), mirroring window.__terms in terminal-pane.tsx: a harness that
  // pre-creates the array gets every delivery; nothing creates it in production, so this is inert.
  const spy = (window as unknown as { __conduitPasteSpy?: Array<{ sessionId: string; text: string }> })
    .__conduitPasteSpy;
  if (spy) spy.push({ sessionId, text });

  const api = terminals.get(sessionId);
  if (!api) return false;
  api.paste(text);
  return true;
}

/**
 * Whether switching to a session should pull keyboard focus into its terminal. Only when the
 * Terminal — not a doc/editor/web tab — is that session's visible view (its doc `activeId` is
 * `null`), and never while focus sits in a real form field the user is typing in. See the
 * active-session focus effect in app.tsx.
 */
export function shouldFocusActiveTerminal(
  docActiveId: string | null,
  focusedEl: Element | null,
): boolean {
  return docActiveId === null && !isTypingEntry(focusedEl);
}
```

In `webview/components/terminal-pane.tsx`, replace the focus subscription:

```ts
  // Register this pane's live terminal so focus requests AND the review-notes handoff can reach
  // exactly this session. termRef is stable, so this registers once per session, not per render.
  useEffect(
    () =>
      registerTerminal(sessionId, {
        focus: () => termRef.current?.focus(),
        // paste() honours bracketed-paste mode; see terminal-bus.ts.
        paste: (text) => termRef.current?.paste(text),
      }),
    [sessionId],
  );
```
…and swap the import from `subscribeTerminalFocus` to `registerTerminal`.

In `webview/app.tsx`, change the import path only:

```ts
import { requestTerminalFocus, shouldFocusActiveTerminal } from './terminal-bus';
```

Then delete `webview/terminal-focus-bus.ts` and `test/unit/terminal-focus-bus.test.ts`.

> The registry holds an API object per session for as long as the pane is mounted. That is the same lifetime the old subscriber had; there is no new retention. It holds **no xterm reference** — only two closures over `termRef` — so a disposed terminal cannot be resurrected through it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/terminal-bus.test.ts && npm run typecheck && npx biome check webview/`
Expected: PASS; no dangling import of the deleted module.

- [ ] **Step 5: Commit**

```bash
git add -A webview/terminal-bus.ts webview/terminal-focus-bus.ts webview/components/terminal-pane.tsx webview/app.tsx test/unit/terminal-bus.test.ts test/unit/terminal-focus-bus.test.ts
git commit -m "refactor(terminal): one sessionId-keyed bus with focus, paste and liveness"
```

---

## Task 12: The pure handoff builder (`src/review-handoff.ts`)

**Files:**
- Create: `src/review-handoff.ts`
- Test: `test/unit/review-handoff.test.ts`

**Interfaces:**
- Consumes: `ReviewNote`, `pendingNotes` (Task 1).
- Produces: `buildHandoffMarkdown(notes, files, sourceLabel): string`; `handoffLabel(pending, live): { label, title, disabled }`.

`files` is the Review's file order (repo-relative paths) so the markdown reads in the same order the reviewer just walked. `sourceLabel` is a parameter rather than the spec's hard-coded "working tree" — assumption 11. **No trailing newline**: §7 Lane F asserts it, because a trailing newline in a bracketed paste is what makes some TUIs submit.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review-handoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildHandoffMarkdown, handoffLabel } from '../../src/review-handoff';
import { anchorFor, type ReviewNote } from '../../src/review-notes';

const note = (over: Partial<ReviewNote>): ReviewNote => ({
  id: 'n',
  path: 'src/foo.ts',
  side: 'new',
  line: 42,
  anchor: anchorFor('const x = 1;', null, null),
  snippet: 'const x = 1;',
  body: 'why this?',
  createdAt: '2026-08-28T10:00:00.000Z',
  ...over,
});

describe('buildHandoffMarkdown', () => {
  it('matches the spec format exactly, with no trailing newline', () => {
    const md = buildHandoffMarkdown(
      [note({ id: 'a' }), note({ id: 'b', path: 'src/bar.ts', line: 7, snippet: 'return y;', body: 'unused?' })],
      ['src/foo.ts', 'src/bar.ts'],
      'working tree',
    );
    expect(md).toBe(
      [
        'Review notes on 2 files (working tree):',
        '',
        '### src/foo.ts',
        '- L42 (`const x = 1;`): why this?',
        '',
        '### src/bar.ts',
        '- L7 (`return y;`): unused?',
        '',
        'Please address these and reply with what you changed.',
      ].join('\n'),
    );
    expect(md.endsWith('\n')).toBe(false);
  });

  it('singularises one file', () => {
    expect(buildHandoffMarkdown([note({})], ['src/foo.ts'], 'staged changes')).toContain(
      'Review notes on 1 file (staged changes):',
    );
  });

  it('orders files by the review order and lines ascending inside a file', () => {
    const md = buildHandoffMarkdown(
      [note({ id: 'c', line: 9 }), note({ id: 'a', line: 2 }), note({ id: 'b', path: 'a.ts', line: 1 })],
      ['a.ts', 'src/foo.ts'],
      'working tree',
    );
    expect(md.indexOf('### a.ts')).toBeLessThan(md.indexOf('### src/foo.ts'));
    expect(md.indexOf('- L2')).toBeLessThan(md.indexOf('- L9'));
  });

  it('appends a file the review order does not mention, rather than dropping its notes', () => {
    const md = buildHandoffMarkdown([note({ path: 'gone.ts' })], ['src/foo.ts'], 'working tree');
    expect(md).toContain('### gone.ts');
  });

  it('indents the continuation lines of a multi-line body so the list survives', () => {
    const md = buildHandoffMarkdown([note({ body: 'first\nsecond' })], ['src/foo.ts'], 'working tree');
    expect(md).toContain('- L42 (`const x = 1;`): first\n  second');
  });

  it('is empty for no notes, so a caller can gate on it', () => {
    expect(buildHandoffMarkdown([], ['src/foo.ts'], 'working tree')).toBe('');
  });
});

describe('handoffLabel', () => {
  it('offers the send when a terminal is live and something is pending', () => {
    expect(handoffLabel(4, true)).toEqual({
      label: 'Send to agent (4)',
      title: 'Paste 4 open notes into this session (you press Enter)',
      disabled: false,
    });
  });

  it('falls back to the clipboard when there is no live terminal', () => {
    const r = handoffLabel(2, false);
    expect(r.label).toBe('Copy as markdown');
    expect(r.disabled).toBe(false);
    expect(r.title).toContain('no live terminal');
  });

  it('is disabled at zero, both ways', () => {
    expect(handoffLabel(0, true).disabled).toBe(true);
    expect(handoffLabel(0, false).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-handoff.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/review-handoff"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/review-handoff.ts`:

```ts
import type { ReviewNote } from './review-notes';

/**
 * The agent handoff (spec 2026-08-27-review-supercharge §2 Lane F). Pure and node-free so the
 * exact bytes that reach a terminal are unit-testable — the delivery is a bracketed paste with NO
 * trailing newline, because a trailing newline is what makes some TUIs submit, and the spec is
 * explicit that the user presses Enter.
 */

/** Continuation lines are indented so a multi-line body stays inside its markdown list item. */
const indentBody = (body: string): string => body.trimEnd().split('\n').join('\n  ');

export function buildHandoffMarkdown(
  notes: readonly ReviewNote[],
  files: readonly string[],
  sourceLabel: string,
): string {
  if (notes.length === 0) return '';

  const byPath = new Map<string, ReviewNote[]>();
  for (const n of notes) {
    const list = byPath.get(n.path);
    if (list) list.push(n);
    else byPath.set(n.path, [n]);
  }

  // The reviewer's own order first; anything the file list doesn't mention (a path that scrolled
  // out of the changeset since the note was written) is appended rather than silently dropped.
  const ordered = [
    ...files.filter((f) => byPath.has(f)),
    ...[...byPath.keys()].filter((p) => !files.includes(p)),
  ];

  const out: string[] = [
    `Review notes on ${ordered.length} file${ordered.length === 1 ? '' : 's'} (${sourceLabel}):`,
  ];
  for (const path of ordered) {
    const list = [...(byPath.get(path) ?? [])].sort((a, b) => a.line - b.line);
    out.push('', `### ${path}`);
    for (const n of list) out.push(`- L${n.line} (\`${n.snippet}\`): ${indentBody(n.body)}`);
  }
  out.push('', 'Please address these and reply with what you changed.');
  return out.join('\n');
}

/** What the footer control says. One place, so the button and its tooltip can't disagree (§8). */
export function handoffLabel(
  pending: number,
  live: boolean,
): { label: string; title: string; disabled: boolean } {
  if (!live) {
    return {
      label: 'Copy as markdown',
      title: 'This session has no live terminal — copy the notes and paste them yourself',
      disabled: pending === 0,
    };
  }
  return {
    label: `Send to agent (${pending})`,
    title: `Paste ${pending} open note${pending === 1 ? '' : 's'} into this session (you press Enter)`,
    disabled: pending === 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/review-handoff.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/review-handoff.ts test/unit/review-handoff.test.ts
git commit -m "feat(review): compose the agent handoff markdown"
```

---

## Task 13: The handoff control

**Files:**
- Modify: `webview/components/review-view.tsx`
- Test: covered by Task 16's e2e.

**Interfaces:**
- Consumes: `buildHandoffMarkdown` / `handoffLabel` (Task 12), `pendingNotes` (Task 1), `hasLiveTerminal` / `pasteToTerminal` (Task 11), `patchNotes` (Task 6), `pushToast` (`webview/toast-store.ts`).
- Produces: the `.review__handoff` row in the Review aside.

It sits in its own row **below** the existing `.review__foot`, not inside it: the foot is gated on `showFooter` (`!preloaded && files.length > 0 && onGitAction`), and notes are worth handing over on a commit review too. Gating them together would make the control vanish for reasons that have nothing to do with notes.

- [ ] **Step 1: Write the failing test**

None here; Task 16 asserts both branches end to end and Task 12 already pins the label copy.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/e2e/run-smoke.mjs review-notes-handoff`
Expected: FAIL — no `.review__handoff` in the DOM.

- [ ] **Step 3: Write minimal implementation**

In `ReviewView`:

```ts
  const pending = useMemo(() => pendingNotes(repoNotes), [repoNotes]);
  // Read live rather than memoised: a terminal can register or go away between renders, and the
  // control has to say what is true right now.
  const terminalLive = sessionId ? hasLiveTerminal(sessionId) : false;
  const handoff = handoffLabel(pending.length, terminalLive);

  const sourceLabel =
    source?.kind === 'commit'
      ? `commit ${source.sha.slice(0, 7)}`
      : source?.kind === 'range'
        ? `${endpointLabel(source.base)}…${endpointLabel(source.head)}`
        : scope === 'all'
          ? 'working tree'
          : `${SCOPE_LABEL[scope].toLowerCase()} changes`;

  const onHandoff = useCallback(() => {
    if (pending.length === 0 || !repoKey) return;
    const md = buildHandoffMarkdown(
      pending,
      files.map((f) => f.path),
      sourceLabel,
    );
    const stamp = () => {
      patchNotes(repoKey, {
        op: 'sent',
        ids: pending.map((n) => n.id),
        at: new Date().toISOString(),
      });
      setAnnounce(`Sent ${pending.length} note${pending.length === 1 ? '' : 's'}`);
    };

    if (sessionId && pasteToTerminal(sessionId, md)) {
      stamp();
      // Deliberately no view switch and no Enter (§2 Lane F): the user must read what reached the
      // agent, and yanking them out of a half-read review is the worse failure.
      pushToast({
        message: `Sent ${pending.length} note${pending.length === 1 ? '' : 's'} to ${sessionLabel ?? 'the session'}`,
        variant: 'info',
      });
      return;
    }

    navigator.clipboard
      .writeText(md)
      .then(stamp)
      .then(() =>
        pushToast({
          message: `Copied ${pending.length} note${pending.length === 1 ? '' : 's'} as markdown`,
          variant: 'info',
        }),
      )
      .catch(() =>
        pushToast({ message: 'Copy failed: the clipboard is unavailable.', variant: 'error' }),
      );
  }, [pending, repoKey, files, sourceLabel, sessionId, sessionLabel]);
```

…and, after the `showFooter` block in the aside:

```tsx
            {repoNotes.length > 0 && (
              <div className="review__handoff">
                <button
                  type="button"
                  className="btn review__send"
                  disabled={handoff.disabled || !notesReady}
                  aria-disabled={handoff.disabled || !notesReady}
                  aria-describedby={handoffHintId}
                  title={handoff.title}
                  onClick={onHandoff}
                >
                  {handoff.label}
                </button>
                <span id={handoffHintId} className="sr-only">
                  {handoff.title}
                </span>
              </div>
            )}
```
…with `const handoffHintId = useId();` beside the existing `useId` usage (§9 asks for `aria-disabled` + `aria-describedby` on this control).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run && npm run typecheck`
Expected: PASS. (The e2e goes green at the end of Task 16.)

- [ ] **Step 5: Commit**

```bash
git add webview/components/review-view.tsx
git commit -m "feat(review): send open notes to the session agent in one paste"
```

---

## Task 14: The editor mirror (gutter glyph, no view zone)

**Files:**
- Create: `webview/note-decorations.ts`, `webview/use-note-markers.ts`, `webview/review-note-target.ts`
- Modify: `webview/components/code-viewer.tsx`, `webview/app.tsx`, `webview/components/review-view.tsx`
- Test: `test/unit/note-decorations.test.ts`

**Interfaces:**
- Consumes: `AnchoredNote`, `reanchor` (Task 1); the notes store (Task 6); `isUnderRoot` (`src/repo-rel.ts`, Lane A).
- Produces:
  - `webview/note-decorations.ts`: `NoteMarker`; `notesToMarkers(anchored): NoteMarker[]`; `noteHoverText(notes): string`; `notesToDecorations(markers): editor.IModelDeltaDecoration[]`.
  - `webview/use-note-markers.ts`: `useNoteMarkers({ editor, path, onOpenNote })`.
  - `webview/review-note-target.ts`: `setNoteTarget(target)`, `subscribeNoteTarget`, `getNoteTarget`.

**This is a decoration, not a view zone.** The revision note moved the codebase's first view zone into Lane E; Lane F reuses Lane A's collection pattern (`editor.createDecorationsCollection()` once per editor, `.set()` wholesale, `.clear()` on model swap) and puts the mark in the **glyph margin** so it never fights Lane A's `linesDecorationsClassName` bar for the same strip. The margin is toggled on demand (assumption 14): `code-viewer.tsx` creates the editor without one, so an always-on `glyphMargin` would reserve an empty column on every file in the app.

Only **unresolved** notes get a glyph: a resolved note is finished business and a permanent mark for it is noise.

- [ ] **Step 1: Write the failing test**

Create `test/unit/note-decorations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { noteHoverText, notesToDecorations, notesToMarkers } from '../../webview/note-decorations';
import { type AnchoredNote, anchorFor, type ReviewNote } from '../../src/review-notes';

const note = (over: Partial<ReviewNote>): ReviewNote => ({
  id: 'n',
  path: 'src/foo.ts',
  side: 'new',
  line: 10,
  anchor: anchorFor('a', null, null),
  snippet: 'a',
  body: 'why this?',
  createdAt: '2026-08-28T10:00:00.000Z',
  ...over,
});
const at = (n: ReviewNote, line: number | null): AnchoredNote => ({ note: n, line });

describe('notesToMarkers', () => {
  it('groups notes by line, ascending', () => {
    const markers = notesToMarkers([
      at(note({ id: 'b', line: 20 }), 20),
      at(note({ id: 'a', line: 10 }), 10),
      at(note({ id: 'a2', line: 10 }), 10),
    ]);
    expect(markers.map((m) => [m.line, m.notes.length])).toEqual([
      [10, 2],
      [20, 1],
    ]);
  });

  it('drops detached and resolved notes', () => {
    expect(notesToMarkers([at(note({}), null)])).toEqual([]);
    expect(notesToMarkers([at(note({ resolvedAt: 'x' }), 10)])).toEqual([]);
  });

  it('only mirrors NEW-side notes: the editor shows the file as it is now', () => {
    expect(notesToMarkers([at(note({ side: 'old' }), 10)])).toEqual([]);
  });
});

describe('noteHoverText', () => {
  it('is the body for one note, and a numbered list for several', () => {
    expect(noteHoverText([note({ body: 'one' })])).toBe('one');
    expect(noteHoverText([note({ id: 'a', body: 'one' }), note({ id: 'b', body: 'two' })])).toBe(
      '2 notes\n\n1. one\n2. two',
    );
  });
});

describe('notesToDecorations', () => {
  it('emits a glyph-margin decoration per marker with the body as its hover', () => {
    const [dec] = notesToDecorations(notesToMarkers([at(note({}), 10)]));
    expect(dec.range).toEqual({
      startLineNumber: 10,
      startColumn: 1,
      endLineNumber: 10,
      endColumn: 1,
    });
    expect(dec.options.glyphMarginClassName).toBe('ndec');
    expect(dec.options.glyphMarginHoverMessage).toEqual({ value: 'why this?' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/note-decorations.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/note-decorations"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview/note-decorations.ts`:

```ts
import type { editor } from 'monaco-editor';
import type { AnchoredNote, ReviewNote } from '../src/review-notes';

/**
 * Review notes → Monaco glyph-margin decorations (spec 2026-08-27-review-supercharge §2 Lane F).
 * Pure; monaco is imported TYPE-ONLY so this stays unit-testable in Node, exactly like Lane A's
 * change-decorations.ts. The mark lives in the GLYPH margin so it never competes with Lane A's
 * change bar for the line-decorations strip.
 */

export interface NoteMarker {
  /** 1-based model line. */
  line: number;
  notes: ReviewNote[];
}

/** Unresolved, anchored, new-side notes, grouped per line. The editor shows the file as it is
 *  NOW, so an old-side note has no line there; it stays a Review-only row. */
export function notesToMarkers(anchored: readonly AnchoredNote[]): NoteMarker[] {
  const byLine = new Map<number, ReviewNote[]>();
  for (const { note, line } of anchored) {
    if (line === null || note.side !== 'new' || note.resolvedAt !== undefined) continue;
    const list = byLine.get(line);
    if (list) list.push(note);
    else byLine.set(line, [note]);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, notes]) => ({ line, notes }));
}

export function noteHoverText(notes: readonly ReviewNote[]): string {
  if (notes.length === 1) return notes[0].body;
  return [
    `${notes.length} notes`,
    '',
    ...notes.map((n, i) => `${i + 1}. ${n.body}`),
  ].join('\n');
}

export function notesToDecorations(markers: readonly NoteMarker[]): editor.IModelDeltaDecoration[] {
  return markers.map((m) => ({
    range: { startLineNumber: m.line, startColumn: 1, endLineNumber: m.line, endColumn: 1 },
    options: {
      glyphMarginClassName: 'ndec',
      glyphMarginHoverMessage: { value: noteHoverText(m.notes) },
      stickiness: 1, // NeverGrowsWhenTypingAtEdges — a glyph marks a line, not a range.
    },
  }));
}
```

> `stickiness: 1` is `monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges`. It is written as a literal because the module is type-only; if the repo already injects enum values (as `ChangeDecorationStyle` does in `change-decorations.ts`), follow that instead of hard-coding.

Create `webview/review-note-target.ts`:

```ts
// "Open Review at this note" — the one signal the editor's glyph needs to send to a view it does
// not own. A tiny external store rather than a prop chain through app → center-pane → doc-view,
// mirroring webview/save-registry.ts. The nonce is what makes clicking the SAME note twice work.

export interface NoteTarget {
  path: string;
  line: number;
  noteId: string;
  nonce: number;
}

type Listener = () => void;

let target: NoteTarget | null = null;
const listeners = new Set<Listener>();
let nonce = 0;

export function subscribeNoteTarget(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getNoteTarget(): NoteTarget | null {
  return target;
}

export function setNoteTarget(t: Omit<NoteTarget, 'nonce'>): void {
  nonce += 1;
  target = { ...t, nonce };
  listeners.forEach((l) => {
    l();
  });
}
```

Create `webview/use-note-markers.ts`:

```ts
import type * as monaco from 'monaco-editor';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { isUnderRoot } from '../src/repo-rel';
import { reanchor, type ReviewNote } from '../src/review-notes';
import { notesToDecorations, notesToMarkers } from './note-decorations';
import { getNotesSnapshot, subscribeNotes } from './review-notes-store';

/**
 * The editor's read-only mirror of Review's notes (spec §2 Lane F). Reuses Lane A's decoration
 * lifecycle — one collection per editor, `.set()` wholesale, cleared with the editor — and adds
 * NOTHING to the model: no view zone (that is Lane E's), no editing from here.
 */
export function useNoteMarkers({
  editor,
  path,
  onOpenNote,
}: {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  /** Absolute path of the open file. */
  path: string;
  onOpenNote: (note: ReviewNote, line: number) => void;
}): void {
  const snapshot = useSyncExternalStore(subscribeNotes, getNotesSnapshot, getNotesSnapshot);
  const collectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const markersRef = useRef<ReturnType<typeof notesToMarkers>>([]);
  const onOpenRef = useRef(onOpenNote);
  onOpenRef.current = onOpenNote;

  // Which repo this file belongs to: the longest loaded root that contains it. No new IPC — the
  // store already holds every root Review or app.tsx has asked for.
  const notesForPath = useCallback((): ReviewNote[] => {
    let best = '';
    for (const root of snapshot.byRoot.keys()) {
      if (root.length > best.length && isUnderRoot(root, path)) best = root;
    }
    if (!best) return [];
    const rel = path.replace(/\\/g, '/').slice(best.length + 1);
    return (snapshot.byRoot.get(best) ?? []).filter((n) => n.path === rel);
  }, [snapshot, path]);

  useEffect(() => {
    if (!editor) return;
    const collection = editor.createDecorationsCollection([]);
    collectionRef.current = collection;
    return () => {
      collection.clear();
      collectionRef.current = null;
      editor.updateOptions({ glyphMargin: false });
    };
  }, [editor]);

  useEffect(() => {
    const model = editor?.getModel();
    if (!model || !collectionRef.current) return;
    const markers = notesToMarkers(reanchor(notesForPath(), model.getValue().split('\n')));
    markersRef.current = markers;
    collectionRef.current.set(notesToDecorations(markers));
    // The margin appears with the first note on a file and goes away with the last, rather than
    // reserving an empty column on every file in the app (plan assumption 14).
    editor?.updateOptions({ glyphMargin: markers.length > 0 });
  }, [editor, notesForPath]);

  useEffect(() => {
    if (!editor) return;
    const sub = editor.onMouseDown((e) => {
      // 2 === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN.
      if (e.target.type !== 2) return;
      const line = e.target.position?.lineNumber;
      if (line === undefined) return;
      const marker = markersRef.current.find((m) => m.line === line);
      if (!marker) return;
      onOpenRef.current(marker.notes[0], line);
    });
    return () => sub.dispose();
  }, [editor]);
}
```

In `webview/components/code-viewer.tsx`, beside the `useChangeMarkers` call:

```ts
  useNoteMarkers({
    editor,
    path: doc.path,
    onOpenNote: useCallback(
      (note, line) => setNoteTarget({ path: note.path, line, noteId: note.id }),
      [],
    ),
  });
```

In `webview/app.tsx` — two small effects:

```ts
  // Keep the notes store loaded for the active repo even when Review was never opened, so the
  // editor's note glyphs work on their own (they read the same store).
  useEffect(() => {
    if (changesRoot) loadNotesFor(changesRoot);
  }, [changesRoot]);
```
```ts
  // A glyph click in the editor opens Review; ReviewView itself scrolls to the note (below).
  useEffect(
    () =>
      subscribeNoteTarget(() => {
        const target = getNoteTarget();
        if (target) openReviewTab();
      }),
    [openReviewTab],
  );
```

In `ReviewView`, land on the note:

```ts
  const noteTarget = useSyncExternalStore(subscribeNoteTarget, getNoteTarget, getNoteTarget);
  const landedNonceRef = useRef(0);
  useEffect(() => {
    if (!noteTarget || landedNonceRef.current === noteTarget.nonce) return;
    if (!pathIndex.has(noteTarget.path)) return; // not in this changeset — leave the user where they are
    landedNonceRef.current = noteTarget.nonce;
    scrollToFile(noteTarget.path);
    setAnnounce(`Opened the note on line ${noteTarget.line} of ${noteTarget.path}`);
  }, [noteTarget, pathIndex, scrollToFile]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/note-decorations.test.ts && npm run typecheck`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add webview/note-decorations.ts webview/use-note-markers.ts webview/review-note-target.ts webview/components/code-viewer.tsx webview/app.tsx webview/components/review-view.tsx test/unit/note-decorations.test.ts
git commit -m "feat(editor): mirror review notes as a gutter glyph"
```

---

## Task 15: Changelog

**Files:**
- Modify: `CHANGELOG.md`
- Test: none.

**Interfaces:**
- Consumes: nothing.
- Produces: two `### Added` bullets under `[Unreleased]`.

Written for a user, not a reviewer: what it does for them, where it lives, and the one surprising fact (the notes are files in their repo).

- [ ] **Step 1: Write the failing test**

None — a docs change.

- [ ] **Step 2: Run test to verify it fails**

n/a.

- [ ] **Step 3: Write minimal implementation**

Append to the existing `### Added` list under `## [Unreleased]`:

```markdown
- **Leave notes on a line, and hand them to the agent.** Hover any line in Review and a `+` appears
  in the marker column — or press `c` on the change you are on. Write what you want changed, save
  with Ctrl/Cmd+Enter, and the note sits under that line as a thread you can edit, resolve or
  delete. Notes are stored in your project, at `.conduit/review-notes.json`, precisely so the agent
  can read them; they come back when you reopen Review, in either window, and an agent that edits
  the file itself shows up live. When the code moves under a note it follows the line it was
  written on; when the line is gone for good the note is listed at the top of the file's card
  ("lost its place") rather than quietly disappearing. Open files show the same notes as a small
  mark in the editor's gutter — hover for the text, click to jump back to Review.
- **Send to agent.** One button in the Review sidebar pastes every open note into the session's
  terminal as a single markdown block, grouped by file with the line and the code it was written
  against. It never presses Enter — you read what reached the agent and send it yourself. If that
  session has no terminal, the button offers the same text on the clipboard instead.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx biome check CHANGELOG.md` (if markdown is in Biome's scope; otherwise skip).
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): review notes and the agent handoff"
```

---

## Task 16: The `review-notes-handoff` e2e scenario

**Files:**
- Create: `test/e2e/review-notes-handoff.e2e.mjs`
- Test: itself.

**Interfaces:**
- Consumes: `test/e2e/harness.mjs` (`assert`, `closeApp`, `loadPlaywright`, `makeLog`, `openSession`, `REPO`, `tapBridge`).
- Produces: the lane's host-boundary coverage — every acceptance bullet in §7 Lane F.

Two launches against **one** fixture repo, because the whole point is that a note outlives the process — and unlike Lane B's marks, the durable copy is a file **in the repo**, so the scenario also asserts the artifact's shape on disk. Windows-only, run ALONE on a quiet machine.

- [ ] **Step 1: Write the failing test**

Create `test/e2e/review-notes-handoff.e2e.mjs`:

```js
/**
 * Review notes + agent handoff (real-app smoke, spec 2026-08-27-review-supercharge §7 Lane F).
 *
 * Two launches against ONE fixture repo. What only the real app can answer:
 *  - the note lands in `.conduit/review-notes.json` as an ADR 0002 ENVELOPE,
 *  - saving it does NOT bounce back through `fsChanged` and reload the Review that wrote it
 *    (the `.conduit/` exclusion in src/watch-filter.ts — a pure unit test cannot see the loop),
 *  - the note survives a restart and re-anchors when the line moves,
 *  - the handoff reaches the TERMINAL BUS for the Review's own sessionId, with no trailing newline.
 *
 * Windows only. Run it ALONE on a quiet machine.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assert,
  closeApp,
  loadPlaywright,
  makeLog,
  openSession,
  REPO,
  tapBridge,
} from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[review-notes-handoff] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('review-notes-handoff');
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

// ── Fixture ────────────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'conduit-rnh-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-rnh-ud-'));
const notesPath = join(root, '.conduit', 'review-notes.json');

const BASE = `${lines(30, (i) => `const a${i} = ${i};`)}\n`;
writeFileSync(join(root, 'alpha.ts'), BASE);
git(root, 'init', '-q');
git(root, 'add', '.');
git(root, '-c', 'user.email=e2e@conduit.test', '-c', 'user.name=e2e', 'commit', '-qm', 'base');

/** One changed line, far from the edges, so a note on it has real context both sides. */
const CHANGED = BASE.replace('const a12 = 12;', 'const a12 = 1200;');
writeFileSync(join(root, 'alpha.ts'), CHANGED);
log(`fixture: ${root}`);

const { _electron } = loadPlaywright();
const require = createRequire(import.meta.url);
const electronPath = require('electron');

async function launch() {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, REPO],
    cwd: REPO,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!window.agentDeck, null, { timeout: 20000 });
  await tapBridge(page);
  // Opt-in seams, created BEFORE anything can use them (mirrors window.__terms).
  await page.evaluate(() => {
    window.__conduitPasteSpy = [];
    window.__fsChanged = [];
    window.agentDeck.subscribe((m) => {
      if (m.type === 'fsChanged') window.__fsChanged.push(m.root);
    });
  });
  return { app, page };
}

/** Open the fixture repo and put Review on screen with its cards + note controls ready. */
async function openReview(page) {
  const sessionId = await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 25000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review .rcard[data-path="alpha.ts"]', {
    state: 'visible',
    timeout: 20000,
  });
  await page.waitForSelector('.rcard[data-path="alpha.ts"] .rline', { timeout: 20000 });
  // The load gate: every note control is disabled until the first review:notes push (§4).
  await page.waitForFunction(
    () => document.querySelector('.rline__note')?.disabled === false,
    null,
    { timeout: 15000 },
  );
  return sessionId;
}

/** The `+` on the row whose NEW-side line number is `n`. */
const plusOnLine = (page, n) =>
  page.locator(`.rcard[data-path="alpha.ts"] .rline__note[data-note-line="${n}"]`).first();

const noteBodies = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.rcard[data-path="alpha.ts"] .rnote__body')].map((e) =>
      (e.textContent ?? '').trim(),
    ),
  );

let firstApp;
let secondApp;
let firstPage;
let secondPage;
const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');

try {
  // ── Launch 1 ─────────────────────────────────────────────────────────────────────────────────
  const first = await launch();
  firstApp = first.app;
  firstPage = first.page;
  const page = first.page;
  const sessionId = await openReview(page);
  log('Review open with the fixture changeset ✓');

  // (1) The `+` is inert until its row is hovered — the hover-obstruction rule.
  const atRest = await page.evaluate(() => {
    const b = document.querySelector('.rline__note');
    return b ? getComputedStyle(b).pointerEvents : null;
  });
  assert(atRest === 'none', `the + must be pointer-events:none at rest; got ${atRest}`);
  log('the + affordance is inert until its row is hovered ✓');

  // (2) Save a note on the changed line.
  await page.evaluate(() => {
    window.__fsChanged.length = 0;
  });
  await plusOnLine(page, 12).click({ force: true });
  await page.waitForSelector('.rnote-composer__field', { state: 'visible', timeout: 8000 });
  await page.fill('.rnote-composer__field', 'this constant needs a name');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(
    () => document.querySelectorAll('.rcard[data-path="alpha.ts"] .rnote').length === 1,
    null,
    { timeout: 8000 },
  );
  log('the composer saved a note onto the line ✓');

  // (3) It landed on disk, ENVELOPED (ADR 0002).
  await page.waitForFunction(() => true, null, { timeout: 1 });
  await page.waitForTimeout(600); // the host writes after it broadcasts
  assert(existsSync(notesPath), `review-notes.json was not written to ${notesPath}`);
  const envelope = JSON.parse(readFileSync(notesPath, 'utf8'));
  assert(envelope.conduit === 1, `envelope.conduit should be 1; got ${envelope.conduit}`);
  assert(
    envelope.kind === 'review-notes',
    `envelope.kind should be review-notes; got ${envelope.kind}`,
  );
  assert(typeof envelope.updatedAt === 'number', 'envelope.updatedAt should be a number');
  assert(envelope.data.version === 1, 'the payload should self-version at 1');
  const saved = envelope.data.notes[0];
  assert(saved.path === 'alpha.ts', `note.path should be repo-relative; got ${saved.path}`);
  assert(saved.line === 12, `note.line should be 12; got ${saved.line}`);
  assert(saved.body === 'this constant needs a name', 'the body should round-trip');
  assert(typeof saved.anchor === 'string' && saved.anchor.length > 0, 'the note must be anchored');
  log('the note persisted to .conduit/review-notes.json as an envelope ✓');

  // (4) Saving it did NOT reload the Review — the `.conduit/` exclusion (§2 Lane F).
  const bounced = await page.evaluate(() => window.__fsChanged.slice());
  assert(
    bounced.length === 0,
    `a note save must not emit fsChanged; got ${JSON.stringify(bounced)}`,
  );
  log('a note save does not bounce back through fsChanged ✓');

  // (5) Send to agent (1) → the composed markdown reaches the bus for THIS session.
  await page.waitForFunction(
    () => /Send to agent \(1\)/.test(document.querySelector('.review__send')?.textContent ?? ''),
    null,
    { timeout: 8000 },
  );
  await page.click('.review__send');
  const delivered = await page.waitForFunction(
    () => (window.__conduitPasteSpy.length > 0 ? window.__conduitPasteSpy[0] : null),
    null,
    { timeout: 8000 },
  );
  const paste = await delivered.jsonValue();
  assert(
    paste.sessionId === sessionId,
    `the handoff must target the Review's session ${sessionId}; got ${paste.sessionId}`,
  );
  assert(
    paste.text.startsWith('Review notes on 1 file (working tree):'),
    `unexpected handoff header:\n${paste.text}`,
  );
  assert(paste.text.includes('### alpha.ts'), 'the handoff must group by file');
  assert(
    paste.text.includes('- L12 (`const a12 = 1200;`): this constant needs a name'),
    `unexpected handoff line:\n${paste.text}`,
  );
  assert(
    paste.text.endsWith('Please address these and reply with what you changed.'),
    'the handoff must end with the ask',
  );
  assert(!paste.text.endsWith('\n'), 'the handoff must carry NO trailing newline');
  log('Send to agent delivered the markdown to the bus for the right session ✓');

  // (6) sentAt was stamped and the count fell to zero.
  await page.waitForFunction(
    () => /Send to agent \(0\)/.test(document.querySelector('.review__send')?.textContent ?? ''),
    null,
    { timeout: 8000 },
  );
  await page.waitForTimeout(400);
  const afterSend = JSON.parse(readFileSync(notesPath, 'utf8')).data.notes[0];
  assert(typeof afterSend.sentAt === 'string', 'every sent note must be stamped with sentAt');
  log('sent notes are stamped and the count drops to 0 ✓');

  // (7) With no live terminal for the session, the control offers the clipboard instead.
  await page.evaluate((sid) => window.__conduitTerminalBus.unregister(sid), sessionId);
  await page.waitForFunction(
    () => /Copy as markdown/.test(document.querySelector('.review__send')?.textContent ?? ''),
    null,
    { timeout: 8000 },
  );
  log('without a live terminal the control reads "Copy as markdown" ✓');

  mkdirSync(shotDir, { recursive: true });
  await page
    .screenshot({ path: join(shotDir, 'review-notes-handoff-1.png') })
    .catch(() => {});

  await closeApp(firstApp, page);
  firstApp = null;
  log('first launch closed');

  // ── Between launches: the anchored line MOVES (5 lines pushed in above it) ───────────────────
  writeFileSync(join(root, 'alpha.ts'), `${lines(5, (i) => `// header ${i}`)}\n${CHANGED}`);

  // ── Launch 2 ─────────────────────────────────────────────────────────────────────────────────
  const second = await launch();
  secondApp = second.app;
  secondPage = second.page;
  const page2 = second.page;
  await openReview(page2);

  await page2.waitForFunction(
    () => document.querySelectorAll('.rcard[data-path="alpha.ts"] .rnote').length === 1,
    null,
    { timeout: 20000 },
  );
  const followed = await page2.evaluate(() => {
    const row = document.querySelector('.rcard[data-path="alpha.ts"] .rnote')?.previousElementSibling;
    return row?.querySelector('.rline__note')?.dataset.noteLine ?? null;
  });
  assert(
    followed === '17',
    `the note should have followed its line from 12 to 17; got ${followed}`,
  );
  assert((await noteBodies(page2))[0] === 'this constant needs a name', 'the body should survive');
  log('the note survived the restart and followed its moved line ✓');

  // ── The anchored line is DELETED: the note becomes detached, never dropped ───────────────────
  writeFileSync(
    join(root, 'alpha.ts'),
    `${lines(5, (i) => `// header ${i}`)}\n${CHANGED.replace('const a12 = 1200;\n', '')}`,
  );
  await page2.waitForSelector('.rcard[data-path="alpha.ts"] .rcard__detached', { timeout: 20000 });
  const detachedText = await page2.textContent('.rcard[data-path="alpha.ts"] .rcard__detached');
  assert(
    detachedText.includes('lost its place') && detachedText.includes('const a12 = 1200;'),
    `the detached notice must name the line it was on; got: ${detachedText}`,
  );
  log('a note whose line is gone is listed as detached, with its snippet ✓');

  await page2
    .screenshot({ path: join(shotDir, 'review-notes-handoff-2.png') })
    .catch(() => {});
  await closeApp(secondApp, page2);
  secondApp = null;

  log('PASS ✓ review-notes-handoff');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) log('FAIL ✗', e.message);
  else {
    console.error('[review-notes-handoff] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  try {
    if (firstApp) await closeApp(firstApp, firstPage);
    if (secondApp) await closeApp(secondApp, secondPage);
  } catch {
    /* already gone */
  }
  process.exit(isAssertion ? 1 : 2);
}
```

Two things this test needs from the implementation, both already specified above but easy to miss:

1. `webview/terminal-bus.ts` must expose the unregister handle under the **same opt-in gate** as the paste spy, so step (7) can drive the no-terminal branch honestly rather than through a production backdoor:

```ts
// Companion to the paste spy, gated on it: the smoke suite needs to drive the "no live terminal"
// branch of the handoff, and there is no other way to make a mounted pane stop being live.
if ((window as unknown as { __conduitPasteSpy?: unknown }).__conduitPasteSpy) {
  (window as unknown as { __conduitTerminalBus?: unknown }).__conduitTerminalBus = {
    unregister: (sessionId: string) => terminals.delete(sessionId),
  };
}
```
…placed at module scope in `terminal-bus.ts`, after `terminals` is declared. Because the harness creates `__conduitPasteSpy` before the app's first render, the check runs once and is false in production.

2. Removing a registration has to re-render whatever reads `hasLiveTerminal`. `ReviewView` reads it during render, and the store push that follows a `patchNotes` is what re-renders it in step (7) — but step (7) does not patch. Add a **version counter** to the bus and expose it as an external store so the label is never stale:

```ts
let version = 0;
const busListeners = new Set<() => void>();
const bump = () => {
  version += 1;
  busListeners.forEach((l) => {
    l();
  });
};
export function subscribeTerminalBus(cb: () => void): () => void {
  busListeners.add(cb);
  return () => {
    busListeners.delete(cb);
  };
}
export function getTerminalBusVersion(): number {
  return version;
}
```
…called from `registerTerminal`, its unregister, and the test unregister; `ReviewView` reads `useSyncExternalStore(subscribeTerminalBus, getTerminalBusVersion, getTerminalBusVersion)` purely to re-render. Add a unit test for the bump to `test/unit/terminal-bus.test.ts` in Task 11 rather than here.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/e2e/run-smoke.mjs review-notes-handoff`
Expected: FAIL at step (1) — no `.rline__note` in the DOM — until Tasks 10–14 are in.

- [ ] **Step 3: Write minimal implementation**

The two additions to `terminal-bus.ts` above; everything else exists by now. Fix whatever the scenario surfaces **in the code**, never by loosening an assertion.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/e2e/run-smoke.mjs review-notes-handoff`
Expected: PASS — every `✓` line above, then `PASS ✓ review-notes-handoff`.

> If it fails on a machine with leftover `cmd.exe` / `conhost` from earlier runs, re-run it ALONE before believing it: a loaded machine starves ConPTY and fails PTY-adjacent scenarios exactly the way a real regression does (`CLAUDE.md`). Never clean up by killing processes by name.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/review-notes-handoff.e2e.mjs webview/terminal-bus.ts test/unit/terminal-bus.test.ts
git commit -m "test(e2e): review notes, re-anchoring and the agent handoff"
```

---

## Task 17: Full gate + evidence

**Files:** none.

**Interfaces:**
- Consumes: everything above.
- Produces: `.autoloop/evidence/lane-f-verify.log`, `.autoloop/evidence/lane-f-e2e.log`, `.autoloop/evidence/lane-f-notes.png`.

- [ ] **Step 1: Write the failing test**

n/a — this task IS the test.

- [ ] **Step 2: Run test to verify it fails**

n/a.

- [ ] **Step 3: Write minimal implementation**

Nothing new. If the gate is red, fix the **code**; never disable, downgrade, narrow, or defer one of verify's checks (`CLAUDE.md`).

Two failure modes this lane makes likely, and the fix for each:
- **Dead-code / unlisted-export**: `webview/terminal-focus-bus.ts` must be *deleted*, not left orphaned, and every export added in Tasks 1/12 must have a caller. If `emptyNotesData` or `openNotes` ends up with none, delete it rather than exporting for a future.
- **Duplication**: `notesFingerprint` next to `board-watch.ts`'s `fingerprint`, and `NotesWatcher` next to `BoardWatcher`, are the two shapes jscpd will look at. `isSelfEcho` is already shared; if the watcher pair still trips the (non-gating) duplication report, note it in the run report rather than inventing a premature abstraction over two watchers.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run verify 2>&1 | tee .autoloop/evidence/lane-f-verify.log
node test/e2e/run-smoke.mjs review-notes-handoff 2>&1 | tee .autoloop/evidence/lane-f-e2e.log
```
Expected: verify green end to end (format-check, lint, dead-code, duplication, typecheck ×2, tests, SAST/dep-audit/secrets); the scenario ends `PASS ✓`.

> Never pipe verify's output through `tail` — the truncation has hidden real failures in this repo before. `tee` the whole thing.

Then the screenshot the run report needs — **a note thread and the Send button in one frame**:

```bash
node test/e2e/run-smoke.mjs review-notes-handoff
# copies %TEMP%\claude-scratch\review-notes-handoff-1.png (Review with the saved note + the
# "Send to agent (1)" button) into the evidence dir:
cp "$TEMP/claude-scratch/review-notes-handoff-1.png" .autoloop/evidence/lane-f-notes.png
```

Confirm `git status` shows only the intended files — no screenshots, no `.conduit/` churn, no scratch (`CLAUDE.md` workspace hygiene). The fixture repos live under the OS temp dir and are never inside the project.

- [ ] **Step 5: Commit**

```bash
git add .autoloop/evidence/lane-f-verify.log .autoloop/evidence/lane-f-e2e.log .autoloop/evidence/lane-f-notes.png
git commit -m "chore(evidence): Lane F gate and smoke output"
```

---

## Self-Review

**1. Spec coverage (revision note, §0, §2 Lane F, §3, §4, §5, §7 Lane F, §8–§12)**

| Spec requirement | Task |
|---|---|
| `ReviewNote` / `ReviewNotesData` model (§2F) | 1 |
| FNV anchor of line + one context line each side, reusing Lane B's hash (§2F) | 1 |
| 500-per-repo bound, composer refuses with guidance (§2F, §4, §5) | 1 (bound), 10 (`refusedMessage`) |
| Re-anchor: exact → ±50 → detached, never dropped (§2F, §4) | 1 (`reanchor`), 10 (detached list) |
| Enveloped `.conduit/review-notes.json`; `ConduitKind` + `FILE_FOR`; absent/invalid = empty; `writeAtomic` (§2F, §3, §5) | 2 |
| Host in-memory + `review:notes` broadcast on load and change (§2F, §3) | 5 |
| `review:setNotes` — host merges, writes, broadcasts (§3) | 4, 5 |
| External-edit watcher with self-echo suppression (§2F, §4) | 5 |
| `fsChanged` excludes `.conduit/` (§2F, §12.10) | 3 |
| Renderer store + load gate (§4, §8 "Marks/notes controls: not loaded") | 6 |
| Hover `+` in the marker column (§2F, §9) | 8 (CSS), 10 (markup + delegation) |
| Inline composer, `Mod+Enter` save, `Esc` cancel with confirm when non-empty (§2F, §8) | 9, 10 |
| Thread rows in the card: Edit · Resolve/Unresolve · Delete (confirms) (§2F, §8) | 9, 10 |
| Detached list at the top of the card with its snippet (§2F, §8) | 9, 10 |
| Height cache invalidated when rows are added/removed (§2F) | 10 (`invalidateHeight`) |
| `c` bound (§2 Lane B table, §9) | 7, 10 |
| Editor gutter glyph, body as hover, click opens Review; read-only (§2F, §9) | 14 |
| `buildHandoffMarkdown` exact format (§2F) | 12 |
| "Send to agent (N)", N = unresolved + unsent (§2F, §8) | 12, 13 |
| Unified `terminal-bus` — `register` / `focus` / `paste` / `hasLiveTerminal` (§2F, §3) | 11 |
| Bracketed paste to the Review doc's session, no Enter, `sentAt`, toast (§2F) | 13 |
| "Copy as markdown" when no live terminal (§2F, §4, §8) | 12, 13 |
| `--note-accent` in all three themes (§11) | 8 |
| a11y: labelled composer, live-region announcements, focus return, colour never alone, reduced motion (§10) | 8, 9, 10 |
| Corrupt file → empty + host log (§4) | 2, 5 |
| Two windows on one repo → broadcast, last writer wins (§4) | 5, 6 |
| e2e `review-notes-handoff`, every §7 Lane F bullet | 16 |
| CHANGELOG (ADR 0003) | 15 |

**Not covered, deliberately:** the change peek, hunk staging, search, and the scope control — Lanes C and E. The `s`/`d` and `/`/`Mod+F` keys stay unbound.

**2. Placeholder scan**

Every code block is complete and compiles as written, with three explicitly-flagged lookups the implementer must resolve against the tree rather than guess (each is called out inline, not left as a TODO):
- `relativeTime`'s exact export name in `webview/relative-time.ts` (Task 9).
- Whether `webview/styles.css` has an icon-mask convention for `.ndec`, with the `.cdec--deleted`-style border fallback named if it does not (Task 8).
- Whether `change-decorations.ts`'s injected-enum style should be followed for `stickiness` instead of the literal `1` (Task 14).

No `TODO`, no `…`, no "implement X here", no invented API: every imported symbol was read out of the tree while writing this plan (`contentHash`, `normalizeRoot`, `isSelfEcho`, `ConduitDirWatch`, `writeAtomic`, `readBlob`, `broadcast`/`replyHere`/`persistFile`, `isUnderRoot`, `pushToast`, `ConfirmDialog`, `useEscapeKey`, `isTypingEntry`, `computeFileReview`, `diffKey`, `endpointLabel`, `SCOPE_LABEL`).

**3. Type consistency**

- `ReviewNote` / `ReviewNotesData` / `ReviewNotePatch` are declared **once** in `src/review-notes.ts` and re-exported from `src/protocol.ts` — the same arrangement Lane B uses for `ReviewMark`, so the disk shape and the wire shape cannot drift.
- `NoteSide` (`'new' | 'old'`) is used identically in the model, the protocol, the composer state, the `data-note-side` attribute and `notesToMarkers`.
- `AnchoredNote { note, line: number | null }` is the single "where is it now" type, consumed by the card, the detached list and the editor hook.
- Root keys go through `normalizeRoot` on **both** sides (`review-notes-store.ts` and `main.ts`), so `C:/Work/Repo` and `c:/work/repo` can never become two note sets.
- `applyNotePatch` is the only mutation path, used by the host, the renderer store and the preview bridge — three callers, one semantics.
- `TerminalApi` is the only shape the bus stores; `registerTerminal` returns an identity-checked unregister, so `hasLiveTerminal` cannot report a pane that has been replaced.
- `buildHandoffMarkdown(notes, files, sourceLabel)` takes `readonly string[]` for `files`, which is what `files.map((f) => f.path)` produces at the call site.
- Both node-free modules (`src/review-notes.ts`, `src/review-handoff.ts`) import nothing from `node:`, so the renderer tsconfig accepts them; `electron/notes-watcher.ts` and `electron/conduit-fs.ts` are host-only and never reached from `webview/`.

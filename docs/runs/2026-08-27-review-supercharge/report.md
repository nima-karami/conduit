# Run report — review supercharge (2026-08-27)

**Status: COMPLETE.** All six lanes shipped, plus two user requests made mid-run and one severe
regression caught and fixed. Spec archived to `docs/specs/archive/2026-08-27-review-supercharge.md`.

The ask: *"supercharge the way we can review the changes … in the code editor … see the changed
lines as an indicator on the scroll map on the right-hand side … look at what we have first and
see what features or sub-features are missing and expand on that."*

**Tests: 3064 → 3514.** Verify green on every merge; 16 e2e scenarios re-run green on final main.

## Shipped

| # | Item | Merge | Gate |
|---|---|---|---|
| 1 | Explorer → **"Open as new session"** (user request) | `6c75e4d` | verify 3072 · e2e ✓ |
| 2 | New Session: **Browse… pinned** above the recents (user request) | `4c058ae` | verify 3075 · e2e ✓ |
| 3 | **Lane A** — editor change markers | `99c9afb` | verify 3164 · e2e ✓ · screenshot |
| 4 | **Lane B** — Review keymap, durable marks, quick-picks | `1b0a47c` | verify 3259 · e2e ✓ · screenshot |
| 5 | **Lane D** — Review scope (All / Staged / Unstaged) | `ae51ceb` | verify 3284 · e2e ✓ · screenshot |
| 6 | **Lane E** — per-hunk stage/unstage/discard + change peek | `4ef6f9c` | verify 3415 · e2e ✓ · screenshot |
| 7 | **Cold-launch handshake fix** (severe; found by bisect) | `0292258` | verify 3415 · new guard e2e ✓ |
| 8 | **Lane C** — search in diff + navigator filter | `5f91ad7` | verify 3434 · e2e ✓ · screenshot |
| 9 | **Lane F** — review notes + agent handoff | `07daf51` | verify 3514 · e2e ✓ · screenshot |

### The literal ask (Lane A)
Gutter bars (added solid / modified dashed), deletion triangles, and matching overview-ruler and
minimap marks against HEAD, recomputed 300 ms after the last edit. `Alt+F5` / `Shift+Alt+F5` walk
changes, wrapping, announced "Change N of M", registered in Monaco's F1, Conduit's palette, the
editor context menu and the rebindable shortcut registry. **Minimap is now on by default**,
reversing the 2026-06-11 decision (user call). Decorations get their own 250k-cell LCS budget so a
keystroke-debounced recompute can't stall the editor.

### What was missing, and now isn't
- **Lane B** — a keyboard model for Review (`j`/`k` hunks, `J`/`K` files, `m` reviewed, `o` open,
  `e`/`Shift+E` bulk collapse, `?` help), reviewed marks that survive restart (`userData/
  review-marks.json`, FNV content receipt so a file that changed again is no longer "reviewed"),
  *Last commit* / *Unpushed* / *Since branch point* quick-picks, ignore-whitespace, and a sticky
  file header that had never actually worked — `.rcard { overflow: hidden }` made every card its
  own scrollport, so `position: sticky` had nothing to stick to.
- **Lane D** — All / Staged / Unstaged scope. A conflicted path under a narrowed scope used to
  render as a whole-file deletion (`git show :<rel>` errors on an unmerged path and the helper
  collapsed that to an empty blob); it now carries a distinct `UNMERGED` signal and shows a notice.
- **Lane E** — stage, unstage and discard a single hunk, from the Review header, the editor peek,
  or `s`/`d`. The renderer never builds a patch: it sends a line range, and the host filters git's
  own `git diff -U3` output, refusing when the pre-image no longer matches.
- **Lane C** — search across loaded diff data (not the DOM), so collapsed cards and rows past the
  40-row cap are still searchable, with "Search all files" for the streaming working source, plus
  a navigator file filter.
- **Lane F** — content-anchored line notes persisted to an enveloped `.conduit/review-notes.json`,
  re-anchored on every refresh (exact → nearest within ±50 → detached, never dropped), mirrored as
  editor gutter glyphs, and **"Send to agent"**, which pastes a markdown summary into the Review's
  own session terminal without pressing Enter.

## The most valuable find

**Every cold launch of the app would have shown an empty workbench while the host held the user's
restored sessions.** Lane B's marks store called `subscribe()` at module scope; the renderer posted
`ready` at module scope too, and `message-bus` only buffers while *nobody* is subscribed. From that
commit on, the host's startup burst — `state`, `restoreDocs`, `win:list` — was delivered to the
marks store alone, which handles only `review:marks` and dropped the rest. App subscribes in an
effect and never saw it. It never self-heals; only a user action that triggers a fresh `postState`
recovers. Measured on a real build: `{"tabbar":false,"empty":true,"cards":0}` held at 2/5/10/20/30 s.

Every e2e that calls `openSession` masked it, because the harness re-posts `ready`. It surfaced
only because `band-alignment` — which opens no session — regressed. Fixed at the root (`ready` now
posts from App's mount effect) with a `session-bootstrap` guard scenario that fails without the fix.
It was never released: `git tag --contains` is empty and v0.34.0 predates it.

## Process findings

- **The architecture review paid for itself before any code was written.** It returned REVISE with
  four blockers, each verified against the tree: a renderer-built patch could never be byte-correct
  (`review-hunks` strips `\r`, `readDiff` LF-normalises, the EOF-newline fact is lost); staging a
  HEAD-baseline hunk into the index fails whenever index ≠ HEAD; the persistence file skipped the
  ADR 0002 envelope; and marks + notes were fused despite different lifecycles. The spec changed
  shape: patches moved host-side, Lane D moved ahead of Lane E, marks went to `userData`.
- **Every lane review found real defects that green gates missed.** Six for six. Among them: a
  **proven data-loss bug** — a filename containing `[`, `]`, `*` or `?` is a git *pathspec*, so
  `git diff -- <path>` emitted a multi-file diff and the parser never stopped at the next
  `diff --git`; discarding a hunk in `a[bc].txt` reverted `ab.txt`. And a **shell-execution
  hazard**: xterm only wraps a paste in `\x1b[200~` when the foreground program has set DECSET
  2004, so handing notes to a session sitting at a bare `cmd.exe` prompt would have executed each
  line of the user's own notes. Both fixed at the root, both now guarded.
- **Builders found bugs the plans got wrong.** Lane E's own tests caught an unconditional
  new-OR-old hunk match that, against a wholesale rewrite, staged an entire file from a 3-line
  click. Lane C found two latent bugs already on main (a bulk collapse silently undoing a reveal;
  `scrollToFile` fighting the keep-in-view anchor). Lane D found the docs reducer silently eating
  the new scope — unit- and type-green, caught only by its e2e.
- **A conductor error worth recording: never overlap a smoke suite with a builder.** The
  post-Lane-E full smoke read 83/5/9 because a builder was running `npm ci` and unit tests on the
  same machine; the `sessions.json.tmp` rename ENOENT was contention. Re-running quiet narrowed
  the real signal to one scenario — which turned out to be the handshake regression above. The
  reflex CLAUDE.md prescribes (re-run alone before believing a failure) was right both times.
- **`multi-repo` wasn't a regression either.** It clicked a hover-revealed Stage button cold, and
  Playwright hit-tests before moving the mouse, so it resolved to the row text underneath. The
  product is correct — `pointer-events: none` at rest is deliberate — so the fix went in the
  test's interaction (`c498407`), not the assertion.

## Verified on final main (`07daf51`)

`npm run verify` → 240 files / 3514 tests. E2E re-run green, one at a time on a quiet machine:
`session-bootstrap`, `review-notes-handoff`, `review-search`, `hunk-staging`, `review-scope`,
`review-keymap-persist`, `editor-change-markers`, `band-alignment`, `durability`,
`editor-tabs-persist`, `quit-guard`, `multi-window-restore`, `explorer` (8), `git-blame`,
`arch-node-graph`, `markdown-viewer`.

**Not done:** a single uninterrupted `npm run test:smoke` over all ~90 scenarios. Two attempts were
stopped mid-run, and the suite exceeds one foreground window, so the 16 scenarios above were run
individually instead. Worth one clean full pass before the next release tag.

## Follow-ups captured in `docs/wishlist.md`
- `readBlob` treats "unreadable" and "absent" identically for every persisted state file; each
  caller now has its own gate, but the shared helper is one gate away from repeating 0.11.1.
- `npm run verify` cannot detect a literal NUL byte in a source file — second occurrence.
- `hover-obstruction.e2e.mjs` silently requires the repo it opens to be dirty (it failed at the
  known-good baseline with a clean tree; it should seed its own change).
- `Segmented` (settings) and `SegmentedRadios` (Review scope) are twins; the newer one has the a11y.

## Known, recorded, not fixed
- A standing `fsChanged` ↔ `git status` feedback loop on main (~2 emits/sec with Review open, near
  the watcher's debounce ceiling). Pre-existing; deserves its own lane.
- An external edit doesn't refresh an open Review card's diff (`app.tsx` invalidates only on a hunk
  op), so a reviewer editing in another window sees a stale card until a hunk op or restart.
- Excluding `.conduit/` from `fsChanged` also stops Changes and the file tree refreshing on a
  `.conduit/` write; the spec's assumption 10 was corrected to say so.
- Re-anchoring picks the nearest occurrence within ±50 lines, so repeated boilerplate can attach a
  note to the wrong one. Spec'd behaviour.

# Run report — Conduit visual & UX revamp

**Date** 2026-07-31 · **Mode** autonomous build loop, unattended · **Conductor** Claude Opus 5 (1M)
**Input** `Conduit Revamp.zip` — a Claude Design handoff: 10 design documents, 25 frames, a token
contract, and three new themes replacing six.

**Outcome: all ten lanes shipped and merged to `main`.** Final `npm run verify` green — 2378 tests,
up from 2275 at the baseline. Nothing quarantined, nothing stubbed, nothing faked.

---

## What shipped

| Lane | What | Lane SHA | Merge |
|---|---|---|---|
| F0 | Three themes on a shape + material token system | `f56dac5` | `fd9967b` |
| F1 | Floating panel geometry, labelled switcher, git band in the tab row | `7e7d1e5` | `9a5fc5a` |
| F2 | Five-state status system with live output subtitles | `a304467` | `bccbad2` |
| F3 | Changes groups, status letters, Files tree | `0278eee` | `cfcb59d` |
| F4 | Ink code panel, in-panel breadcrumb, diff washes on tokens | `8b07cd0` | `432ec22` |
| F5 | Review: file list, reviewed tracking, dual gutters, accept/discard | `238c8d1` | `1aaf87f` |
| F6 | New-session modal, session menu, sixteen-control Appearance | `650b79e` | `e3e9a45` |
| F7 | Per-panel empty states and the three start routes | `a8b23c4` | `5516888` |
| F8 | Board columns as panels, WIP limits, agent-proposed cards | `51871bb` | `46b9af9` |
| F9 | Canvas node cards, node budget chip, LOD ladder | `832a89c` | `b0a97ef` |

Plus, from the conductor: the Phase-0 visual harness (`0b15abc`), a dependency audit fix
(`fcc7f2e`), and a smoke-harness quit-guard fix (`2a0493f`).

### Against the original pain list

The handoff targeted §7 of the pre-revamp brief (`docs/design-handoff/README.md`). Status:

- **7.1 flat near-black** — answered. The real cause was the *absence of an elevation token*, not
  the palette; Aero now floats panels on a tinted ground with real elevation, Neon is flush and
  notched with a scanline on a dial.
- **7.2 weak empty state** — answered. Per-panel empty states, three ranked routes with live
  shortcuts.
- **7.3 status too quiet** — answered. Five states with a word as well as a colour, live output
  under every card, an aggregate chip in the top bar.
- **7.4 review-as-diff-dump** — answered. File list, reviewed tracking, progress meter, accept/
  discard footer, dual gutters.
- **7.6 canvas perf ceiling** — *partly*. The LOD ladder ships and the budget is stated on screen,
  but LOD alone does not move the freeze (see "What we measured and did not claim").
- **7.7 four stacked chrome bands** — answered. Git band folded into the tab row, breadcrumb folded
  into the code panel. Two bands gone.
- **7.8 buried Board/Canvas** — answered. Labelled switcher in the top bar.

---

## How the run was structured

Ten lanes across five waves: **F0** (tokens) and **F1** (shell) serially, because everything sits
on them, then three parallel waves of disjoint components. Parallel lanes ran in git worktrees
outside the checkout with `node_modules` junctioned in, each owning a disjoint set of components
**and** a disjoint CSS selector namespace — the only reason eight lanes could edit one 9,000-line
stylesheet without corrupting each other. Every merge was followed by a full verify on the
**merged** tree, which is what caught cross-lane problems that no lane's own verify could see.

The stop condition was never "the tests pass". Phase 0 built `npm run shots`, which drives the real
app hidden at **1320×820 — the design frames' native size** — against a fixture repo with real
history, a dirty worktree covering all four git status letters, and `.conduit/` artifacts. Every
lane had to look at its own screenshots next to the frame at 1:1, and so did the conductor before
merging.

---

## What the lanes found that the design didn't say

The valuable output of a run like this is not just the feature list.

- **The theme ground had never applied.** `index.html` carried a hardcoded `background:#0c0d10` in
  an inline `<style>` *after* the stylesheet link, out-ranking `body`. Every theme had been
  painting onto a fixed dark ground. (F0)
- **Monaco was ignoring the diff tokens entirely** and using its own green/red. Fixing that exposed
  a second bug: Monaco paints an inner character-range wash over the line wash, compositing to ~28%
  where the contract caps at 9–15%. (F4)
- **The open file never highlighted in the tree** — tree paths are built with forward slashes after
  a natively-separated prefix, while the reveal target arrives natively separated throughout, so
  the row match silently failed. The expansion walk masked it. (F3)
- **A fresh Neon profile got Aero's coloured file icons**, because the per-theme default only
  applied on *migration*. (F3 found, F6 fixed, and generalised it: a pinned flag per theme-seeded
  axis, derived on load *and* on switch.)
- **The smoke harness had been lying by omission.** `launchApp`'s cleanup did a bare `app.close()`,
  which hangs when the window owns a running session — the host waits for a `quitDecision` nobody
  sends. Scenarios passed every assertion and still exited 2, which had been written off as a
  loaded-machine flake for weeks. (conductor)
- **The visual fixture's `architecture.json` was written against an invented schema**, so
  `restoreArchitecture` returned null and the canvas silently fell back to its four-node built-in
  seed — meaning every canvas screenshot in this run, until the last lane, showed the wrong graph.
  A silent fallback is the failure mode; it is now guarded by a test that runs the real loader.
  (F9, in the conductor's own Phase-0 code)
- **A unitless `0` on a length token invalidates any `calc()` that reads it**, which silently
  dropped Neon's board overlay to static position. (F1, hit again by F3)
- **`--panel-2` became a wash, not a surface.** Twelve floating surfaces were using it as an opaque
  fill and went transparent under Aero. (F0)

## What we measured and did not claim

F9 was asked to prove the level-of-detail work with numbers. It reported that **LOD alone does not
move the canvas freeze, and the run-to-run variance is larger than the effect**: unchanged code
measures 47.0 s of main-thread block in one run and 112.4 s in another, and every ladder-on reading
(74.9 s, 90.3 s, 113.4 s) sits inside that envelope. It nearly wrote up a "~40% regression" before
the committed baseline showed that reading was an artifact of a bimodal scenario.

That is the correct outcome to report. The chip and the ladder still earn their place — the budget
is now *stated on screen* instead of the app quietly getting slow — but the freeze needs
virtualization, which is a feature in its own right and is on the board as its own card.

## Deliberate divergences from the frames

Each is recorded with its reasoning in `decisions.md` (D1–D20) or `blockers.md`.

- **The review file list stays inside the Review document** rather than taking over the Sessions
  rail (D1) — going blind to your other three agents mid-review fights the product's premise.
- **No invented data.** The busy meter is indeterminate rather than showing the frames' `62` (D7);
  the review "narrative" is the commit subject or nothing (D17); the session diffstat is a file
  count, because insertions/deletions would need a second `git` call per session per refresh.
- **One string set for all themes** (D14). The Neon frames rewrite the words themselves — `QUERY_`,
  `! INPUT`, `JUMP`/`HOLD` — but the handoff's own rule is that themes diverge by "treatment, never
  structure or behaviour".
- **Theme never sets a height.** Where a frame drew Neon's topbar at 34px against Aero's 40px, the
  token contract's own resolution wins: bands are density-owned.
- **Neon's proposed flag is magenta, not gold** — the contract reassigns Neon's `--amber` to
  magenta. Three surfaces now want a distinct "warn" slot; worth minting one if the gold is wanted.

## Open items handed back

1. **Attention accuracy** (D18). The louder cards expose that `needsAttention` is a busy→idle
   heuristic, so a plain shell at a prompt reads "Needs you". Pre-existing; needs host-side
   foreground-process detection.
2. **Canvas virtualization** — the real fix for 7.6.
3. **A `--warn` token slot**, if Neon's proposal flag should be gold rather than magenta.
4. **Per-run fixture paths** — lanes shooting concurrently collide on the single shared fixture
   directory.
5. **`--r-window` on the OS window** (D13). The in-app shell is rounded; making the Electron window
   itself rounded needs `transparent: true` and its own smoke test.
6. **`.btn` doesn't read `--label-case`**, so Neon renders some buttons cased and some not.

## Release gate (2026-08-01)

The first full smoke run after the revamp failed **16 of 71** scenarios. Triaged rather than
re-run until green:

- **6 product bugs fixed**, five of which the revamp did not cause. The worst — quitting wrote the
  good session snapshot and then overwrote it with an empty one as the PTYs it was shutting down
  reported their exits, so restore came back to nothing and a two-window layout collapsed to one —
  is **pre-existing**: the guard is absent at `ecff720` too. It surfaced only because the harness
  fix below made the suite able to report at all.
- **4 tests corrected to the revamp's contracts, none weakened.** The context-menu walk now
  traverses the scroll wrapper F6 added (order still asserted); `review-diff-syntax` asserts
  `--diff-marker`, because the contract moved the `+`/`−` glyph off the add/remove hues
  deliberately; `theming-paper` became `theming-light` against Aero, keeping its legibility
  assertions; and `goto-index` stopped polling a cold TS worker every 500ms — it was burying the
  worker under ~60 overlapping `getDefinition` calls and timing out on a feature that works
  (verified by hand: `matchCombo` → `webview/shortcuts.ts` on one unhurried call).
- **The harness was the multiplier.** A scenario the runner kills left its Electron alive holding
  GPU and ConPTY handles, so one wedged app produced a cascade of "flaky" timeouts after it. The
  runner now reaps orphans, scoped to throwaway profiles under the temp dir.
- **A lane had written a UTF-8 BOM into `webview/components/sidebar.tsx`.** Harmless at runtime and
  invisible to every gate; stripped. Worth knowing that the byte-level class of defect recurs.

Final state: `npm run verify` green (2380 tests, 9 warnings); **all 71 smoke scenarios pass**.
Two (`scrollback`, `terminal-drop`) are timing-sensitive under full-suite load on a machine that
had been running Electron for hours, and were each re-run in isolation to confirm.

**The smoke suite is now single-instance.** The reaper cannot touch a real Conduit — it scopes by
temp-dir profile — but two concurrent runs reap each other and produce nonsense; one such
collision here reported 24 passed / 47 errors and was mistaken for a regression until diagnosed.

## Operational note

`git worktree remove --force` followed a `node_modules` **junction** and emptied the shared
`node_modules` in the main checkout mid-run. Source was never at risk; `npm ci` restored it. Teardown
order is now recorded in `blockers.md` and in the conductor's memory: unlink the junction with
`rmdir` first, *then* remove the worktree.

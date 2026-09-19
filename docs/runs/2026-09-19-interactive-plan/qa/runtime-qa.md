# Runtime QA · Interactive plan documents

**When:** 2026-09-19
**Tier:** FULL — multi-surface (document editor, diagram editor, Monaco fences, comments sidecar, host watcher), persistence on both sides of an agent round trip, and a multi-root matrix.
**Artifact:** desktop / packaged app (Electron, driven with Playwright-Electron)
**Build under test:** `conduit-wt-plan` at `G:\awby\projects\conduit-wt-plan`, branch `feat/interactive-plan` @ `b793d8a` ("fix(a11y): make keyboard focus visible under forced colours, and free the fence tab trap")
**Build identity confirmed from the running artifact:** the worktree was verified clean at `b793d8a` before building (`git status --porcelain` empty, `git rev-parse --short HEAD` = `b793d8a`); `npm run build` was run in that worktree and every scenario launched Electron with `args: [..., REPO]` where `REPO` resolves to that worktree (`test/e2e/harness.mjs:21`). No in-app version banner exists to read back, so identity rests on the single-worktree launch path; no other Conduit process was running (each launch used a fresh `--user-data-dir` under the OS temp dir).
**Environment:** `npm run build` in the worktree, then `node test/e2e/<name>.e2e.mjs` one scenario at a time, nothing else running. The app launches hidden (`CONDUIT_E2E=1` → `show:false`).
**Isolation:** no ports. Each scenario got a fresh `--user-data-dir` (`mkdtempSync(tmpdir(), 'conduit-ud-')`) and one or two fresh project roots (`mkdtempSync(tmpdir(), 'conduit-plan*-')`). Screenshots to `%TEMP%\claude-scratch\plan-qa\` by absolute path.
**Configurations driven:** default theme only, one window size, Windows 11 / win32. Theme variants were **not** driven (see Not covered).
**Teardown:** yes — every app closed via the harness `cleanup()`/`closeApp` path (never by image name), every temp project root removed, the read-only fixture chmod'ed back before removal, all six throwaway scenario files deleted, all 27 screenshots deleted, the build log deleted. `git status` in the worktree is clean (verified after teardown).

## Scope

Acceptance criteria come from `docs/specs/2026-09-19-interactive-plan.md` §7 (the EARS list and the three Gherkin scenarios) and §8 (the state catalog), plus the session-binding statement in §2. The three committed scenarios (`plan-editor`, `plan-blocks`, `plan-handoff`) were run first as a regression baseline and all passed; this pass then went after what they do not cover: the undriven §8 states, the agent-side round trip that is the whole point of the baseline model, multi-root watching, and the Source toggle.

## Verdict

`Works, with 4 issues` — the core loop (agent writes → human edits → Send → agent revises → reload) is solid and the baseline model is correct under a real agent round trip. Two states in §8 are unreachable or wrong in the running app, an empty-bodied plan is uneditable, and a plan opened while another project is on screen sends the human's work to **the wrong project's agent**.

## Criteria

| # | Criterion (§7 EARS / §8 state / §2) | Result | Evidence |
|---|---|---|---|
| 1 | Agent write under `.conduit/plans/` → open-plan banner within 1 s | observed pass | toast seen within 3 s budget in `plan-editor`; re-observed in `planqa-multiroot` |
| 2 | A `.md` under `.conduit/plans/` renders in the plan editor, `ts` fences as Monaco, supported `mermaid` as a structural diagram | observed pass | `plan-editor`, `plan-blocks` (3 nodes, 1 region, laid out on canvas) |
| 3 | An edit writes the whole document within the debounce, preserving bytes of untouched blocks | observed pass | `plan-editor`, `plan-blocks`; re-observed for a frontmatter-less plan |
| 4 | Edge delete / connect / rename / add / remove / move serialises back as valid Mermaid | observed pass | `plan-blocks`, `plan-handoff`; edge delete re-observed in `planqa-extra` |
| 5 | **While a node is being dragged, nothing is written to the file** | observed pass | `planqa-extra` — file byte-identical before, during (900 ms mid-drag, well past the 300 ms debounce) and after |
| 6 | File changes on disk while clean → reload in place, changed blocks marked | observed pass | `plan-editor`; re-observed under a real agent revision in `planqa-roundtrip` |
| 7 | File changes while an edit is pending → keep the edit, stop writing, show the conflict banner | observed pass | `plan-editor` |
| 8 | A comment persists to the sidecar with `{index, hash, snippet}` before the composer closes | observed pass | `plan-handoff`; re-observed **on a read-only plan** in `planqa-states` |
| 9 | Send with a live terminal pastes one bracketed paste, no trailing newline, records the new baseline | observed pass | `plan-handoff`; second Send re-observed in `planqa-roundtrip` |
| 10 | **An agent write replaces that block's baseline so it is not reported as human-changed next Send** | observed pass | `planqa-roundtrip` — after the agent rewrote the `ts` fence, the bar still read `Send to agent (1)` and the paste carried only the human's block |
| 11 | No live terminal → Send becomes Copy as markdown | observed pass | `plan-handoff` (bar read `Copy as markdown` until DECSET 2004 was set) |
| 12 | Every diagram edit reachable without a drag, announced via a polite live region | observed pass | `plan-blocks` (keyboard connect); `planqa-extra` — `.planflow__live[aria-live=polite]` read `"Removed edge txn to identity"` after a context-menu delete |
| 13 | Mermaid outside the subset → read-only + Edit as text, never rewritten structurally | observed pass | `planqa-states` — a `sequenceDiagram` gave `"…can't round-trip: expected a flowchart or graph header"`, rendered a picture, mounted **no** `.react-flow`, and Edit as text round-tripped to disk with the fence intact |
| 14 | §8 **not-found**: "This plan was deleted" + Recreate empty / Close | **observed fail** | Finding 1 |
| 15 | §8 **load-failed**: "Can't open this plan: `<reason>`" + **Open as text** | **observed fail (partial)** | Finding 3 — the message and reason are right; the action is `Copy path`, not `Open as text` |
| 16 | §8 **read-only**: "This file is read-only"; editing blocked, commenting allowed | observed pass | `planqa-states` — bar and banner both correct, file byte-identical after typing, comment still reached the sidecar |
| 17 | §8 **unsupported diagram** / **empty diagram** | observed pass (empty: partial) | Add node present and functional on a node-less `flowchart LR`; the §8 "dashed canvas" is absent (`border-style: none`) — Finding 4 |
| 18 | §8 **source view**: Monaco over the whole file, live blocks hidden, toggle back | observed pass | `planqa-roundtrip` — source held frontmatter + fences, `.plan__editor` count 0, edit wrote through, document and diagram came back correct |
| 19 | §8 comments panel **never-commented** / **all-resolved** | observed pass | `"No comments yet. Press c on a block to comment."`; `"All 2 resolved"` after the agent's reply |
| 20 | §2 **session binding**: the plan's session terminal is the one that owns it | **observed fail** | Finding 2 |
| 21 | A plan with no frontmatter / only frontmatter | **observed fail (only-frontmatter)** | Finding 5 — no-frontmatter passes; only-frontmatter and zero-byte are uneditable |
| 22 | Multi-root: the watcher is per opened project | observed pass | `planqa-multiroot` — a plan written into the **background** project raised its toast, Open rendered it, the second root had its own watch, and editing A's plan left B's file untouched |

## What happened

1. Verified the worktree clean at `b793d8a`; `npm run build` exit 0.
2. Ran the three committed scenarios one at a time as the regression baseline — `plan-editor` PASS (18.8 s), `plan-blocks` PASS (20.5 s), `plan-handoff` PASS (20.7 s).
3. `planqa-states` — 15 checks over the undriven §8 states, each independent so one broken state could not hide the rest. 10 pass, 5 fail.
4. `planqa-probe` (two rounds) — narrowed the three ambiguous results to their actual DOM and disk state.
5. `planqa-roundtrip` — the agent-side round trip plus the Source toggle. 7/7 pass.
6. `planqa-multiroot` — two projects, agent writes into the background one. 4/4 pass.
7. `planqa-extra` — session binding across roots, the polite live region, and drag-does-not-write. 2/3 pass; the session-binding failure reproduced 3/3 runs.

**Negative scenarios driven:** invalid UTF-8, a file 73 bytes over the 2 MB ceiling, a read-only file, a deleted file, a zero-byte file, a frontmatter-only file, a Mermaid dialect outside the subset, a node-less flowchart, a plan with no frontmatter, and an agent write landing inside the human's debounce window (conflict).

**Relaunch scenario:** not driven — see Not covered.

**Negative controls:** three assertions that looked suspicious were deliberately re-pointed and re-run rather than trusted.
- The "only the agent's block is marked" check first reported a failure; re-pointed at the same block with NBSP folding it reported a pass, and the block-count assertion ahead of it had already held. Both directions observed.
- The live-region check first reported a failure against `.plan__live` (the document's region) and a pass against `.planflow__live` (the diagram's), with the region's text printed in both runs — confirming the check discriminates rather than always passing.
- The `Add node` check failed on a regex demanding an indented node, then passed once corrected, with the fence contents printed both times.

## Findings

### 1. Deleting a plan while it is open leaves a dead pane — §8's not-found state, Recreate empty and Close are all unreachable

**Severity:** blocks the flow
**Affects:** every plan tab, every theme (theme-independent: the failing branch is above any styling)
**Evidence:** pane HTML captured at +0.8 s, +1.8 s, +2.8 s and +3.8 s after the delete, and again at +3 s in a second probe run — identical every time.

Repro, from a clean start:
1. Open a project, let the agent write `.conduit/plans/x.md`, open it from the toast — the live document renders.
2. Delete `x.md` on disk (the agent's own `rm`, a `git checkout`, a branch switch).
3. The tab `x.md` stays in the tab bar and the pane becomes exactly:
   `<div class="viewer__notice">File could not be read.</div>`

Expected §8's not-found state — "This plan was deleted." with **Recreate empty** and **Close**. Observed a generic doc-store notice with no actions at all. The state stayed for the full 5 s observed; re-creating the file brought the document back (with `1 block changed by the agent` + `Next change (1)`, correctly).

**Cause:** `webview/components/doc-view.tsx:124-125` — `if (!file) return <div className="viewer__notice">Loading…</div>; if (file.error) return <div className="viewer__notice">{file.error}</div>;` both run **before** the plan routing at line 141-143. A deleted file makes the doc store set `file.error`, so `PlanView` never mounts and the plan store's `status: 'not-found'` (which it does reach — `webview/plan-store.ts` `adopt(key, null)` via `planWith`) is never rendered. The plan branch needs to sit above the generic error branch, since the plan owns its own not-found presentation.

### 2. A plan opened while another project is on screen sends the human's edits to the WRONG project's agent

**Severity:** blocks the flow (cross-project misdelivery)
**Affects:** any window with two or more projects open — which is the case the per-root watcher exists to serve
**Evidence:** reproduced 3 runs out of 3, each with fresh session ids. Last run: plan belongs to session `uo3whxxrq7o` (project A); the paste spy recorded `sessionId: "xmc6mueimi"` (project B).

Repro, from a clean start:
1. Open project A, then project B — B is the active session.
2. The agent writes `.conduit/plans/alpha.md` into **A**. The toast fires correctly (that part works).
3. Click **Open** on the toast. `alpha.md` opens as a tab in **B's** workspace (the tab strip shows B's session row plus `alpha.md`).
4. Edit a paragraph — it correctly writes through to **A's** file on disk.
5. Click **Send to agent**.

Expected the handoff pasted into A's terminal — the project that owns the plan and whose agent asked for review. Observed it pasted into **B's** terminal: B's agent receives a plan path and fences from a project it is not working in, and A's agent never learns the human answered.

**Cause:** `webview/app.tsx:1559-1571` — the toast's Open calls `openFileRef.current(\`${root}/${PLANS_DIR}/${slug}.md\`, undefined, 'permanent')` with `targetSessionId` **undefined**, and `openFile` (`webview/app.tsx:1420`) then falls back to `effectiveSessionId = activeIdRef.current`. The subscriber already has the `root` the write came from; it does not map that root back to its session. `PlanView` takes `doc.sessionId` straight through to `pasteToTerminal`, so the binding error is invisible until Send.

### 3. The load-failed state offers "Copy path" where the spec and the plan both say "Open as text"

**Severity:** degrades the flow
**Affects:** every load failure — invalid UTF-8, over the 2 MB ceiling, an unreadable file
**Evidence:** both load-failure states drove correctly and read, verbatim:
`Can't open this plan: plan unreadable: not valid UTF-8` + `[Copy path]`
`Can't open this plan: plan unreadable: 2097225 bytes exceeds the 2097152 byte limit` + `[Copy path]`

The message and the reason are exactly right, and it is not a blank pane — that half is good. But §8's action column says `Open as text`, and `docs/plans/2026-09-19-interactive-plan.plan.md:464` is more specific still: *"error/load-failed (reason + Open as text → opens the same path with `mode` forcing CodeViewer)"*. The shipped affordance copies a path to the clipboard instead, so a user staring at a corrupt plan has no in-app way to look at the bytes and fix them. `webview/components/plan-view.tsx` renders `copyPath` in both the `state.status === 'error'` branch and the invalid-slug branch.

### 4. An empty diagram has no dashed canvas

**Severity:** cosmetic
**Evidence:** on a node-less `flowchart LR`, `getComputedStyle('.planflow__canvas')` returned `borderStyle: "none"`, `borderWidth: "0px"`.

§8 specifies "Dashed canvas, **Add node**". The Add node affordance is present and works (clicking it put `n1` in the fence and one node on the canvas), but nothing distinguishes the empty canvas from a loading or broken one.

### 5. A plan whose body is empty cannot be edited at all — and once claimed "Saved" over text that was never written

**Severity:** blocks the flow; the false "Saved" is latent silent data loss
**Affects:** a frontmatter-only plan and a zero-byte plan. A plan with a body is unaffected (a frontmatter-less plan edits fine).
**Evidence:** both cases, identical bar text:

- `onlyfm.md` = `---\ntitle: Shell only\nstatus: draft\n---\n` → type `ONLYFM-BODY` → disk unchanged, bar reads `Couldn't save: block count mismatch at 0`, Send goes disabled.
- `blank.md` = `""` (zero bytes) → type `BLANK-BODY` → disk still `""`, same bar.

**Cause:** `webview/components/plan-editor.tsx:181-186` — `emit` refuses when `base.nodes.length !== base.blocks.length`. An empty body gives `splitPlan('')` **0** blocks while ProseMirror's empty document has **1** top-level node (the trailing-break paragraph), so the guard fires on the very first keystroke and never clears. The corpus test that was meant to catch this (`docs/plans/2026-09-19-interactive-plan.plan.md:449`) enumerates a heading, paragraphs, lists, tables, fences and more — but no empty document, which is exactly the case that breaks.

**The false "Saved", observed once (2 of 3 attempts showed `Couldn't save` instead, so this is timing-dependent):** after the refusal, clicking **Retry** wrote only a blank body and the bar flipped to `Saved` — while the editor still showed the typed text:

```
ONLYFM after Retry:       {"disk":"---\ntitle: Shell only\n---\n\n","save":"Saved"}
ONLYFM after second type: {"disk":"---\ntitle: Shell only\n---\n\n","save":"Saved"}
```

The editor showed `FIRST-SECOND`; the file had no body at all, and the bar said Saved. The mechanism is consistent with `emit`'s `if (next !== base.body)` short-circuit over a stale `baseRef` — nothing is emitted, so `PlanView`'s `barSaveState` falls back to `saved` — but I did not prove that path directly, so treat the cause as unconfirmed.

## Visual / design fidelity

**Baseline:** none obtainable — this is a new surface with no pre-change build to compare against, and no design source was supplied to this pass. **Fidelity is not covered.**

Screenshots were taken at every state and read against the criterion in words (that is how the missing dashed canvas in Finding 4 and the missing actions in Finding 1 were caught), but no side-by-side comparison was possible and no verdict on appearance is offered.

## What worked

The whole reason the feature exists works, under a real simulation of the agent's side:

- The **agent round trip** is correct end to end. After the human edited a paragraph, commented, and sent; then made a second unsent edit; the "agent" then appended a `status: 'resolved'` reply to `.conduit/plans/identity.comments.json` and rewrote the `ts` fence. The document reloaded in place, the human's unsent text survived, exactly one block carried `[data-changed]` (the signature), the chip read `1 block changed by the agent`, the agent's reply rendered in the panel with `All 2 resolved`, the bar still read `Send to agent (1)` — **not** 2 — and the next Send's paste carried `Changed blocks (1):` with the human's text and **not** the agent's `org: string`. The baseline model holds.
- **Multi-root** is genuinely per-root: a plan written into the background project raised its toast, opened and rendered, the second root had its own watch, and A's edit did not touch B's file.
- **Source toggle** round-trips: raw markdown showed the whole file including frontmatter, `.plan__editor` was gone, a Monaco edit reached disk with the mermaid fence and frontmatter intact, and toggling back showed the new paragraph with the diagram live again.
- **Read-only** is handled properly on both halves — the write is refused, the file is byte-identical, and commenting still reaches the sidecar.
- **Unsupported Mermaid** does exactly what §7 demands: read-only picture, no structural editor mounted, and Edit as text round-trips.
- **Drag persists nothing**, mid-drag and after.

## Not covered

- **Theme variants.** Every scenario ran in the default theme. The hidden-window repaint constraint means a theme has to be seeded into the profile's `settings.json` before launch; that was not done, so Aero / Neon / light were not driven. Given the CLAUDE.md drag-region and Monaco-stacking gotchas, the plan's floating chrome (`.plan__gutter`, `.plan__conflict`, `.plan__actionbar`) is worth a per-theme pass.
- **Relaunch / restore.** No scenario closed and re-launched the app to check that an open plan tab, its Source-toggle view state (`plan-source:<docId>`), and its unsent baseline survive a restart. This is the restart criterion the skill mandates and it is a real gap.
- **§8 save-failed with a non-permission reason.** Reached only incidentally via the block-count refusal (Finding 5); a disk-full / EBUSY style failure and its Retry were not driven.
- **§8 comment-thread detached / unsaved states and the composer's 4 KB limit-reached state.** Not driven.
- **§8 signature-block worker-pending ("checking…") and diagnostics squiggles.** The `ts` fence was driven as an editor; TS diagnostics against the open project's worker were not asserted.
- **"Keep mine" on the conflict banner.** `plan-editor` drives Load theirs; the Keep mine branch was not driven by any scenario, committed or added.
- **The 1 s banner budget as a measurement.** Observed well within a 3 s wait, not timed to the 1 s the EARS states.
- **Node move into a subgraph, rename, and group** (§7 lists them among the structural edits). `plan-blocks` covers add / connect / delete; move-into-subgraph and rename were not driven here.

## Decisions needed

- **`high` — Finding 1 is a spec criterion the build cannot currently satisfy.** §8's not-found state, Recreate empty and Close exist in `PlanView` and are correct code; they are simply unreachable behind `doc-view.tsx`'s generic error branch. The criterion is buildable, so it should be fixed rather than restated — but the ordering change in `doc-view.tsx` affects every doc kind's error path, so it wants a decision rather than a reflex edit.
- **`high` — Finding 2 needs a settled rule for which session a toast-opened plan binds to.** The obvious answer is "the session that owns the plan's root", but nothing in §2 says what should happen when that project has no open session, or has several. Left undecided, the current behaviour silently misroutes the human's work.
- **`normal` — Finding 3: `Open as text` vs `Copy path`.** The spec and the implementation plan both name `Open as text`; the build shipped `Copy path`. Either build the affordance or amend §8 deliberately — do not leave the two disagreeing.

## Environment faults

None. No PTY flakiness, no starved ConPTY, no orphaned Electrons; every scenario was run alone on an otherwise quiet machine, one at a time, as the project's smoke conventions require.

## Artifacts

All evidence was captured, read against the criteria, described above in words, and then **deleted** as the run required. Nothing remains on disk.

- 27 screenshots were written to `%TEMP%\claude-scratch\plan-qa\` (numbered `01-not-found.png` … `40-drag-no-write.png` plus six `probe*.png`) and deleted after being described.
- Six throwaway scenarios (`test/e2e/planqa-states.e2e.mjs`, `planqa-probe.e2e.mjs`, `planqa-roundtrip.e2e.mjs`, `planqa-multiroot.e2e.mjs`, `planqa-extra.e2e.mjs`) were written, run, and deleted.
- The build log (`%TEMP%\claude-scratch\plan-qa-build.log`) was deleted.
- Every temp project root and user-data dir was removed by each scenario's own teardown.
- **`git status` in `G:\awby\projects\conduit-wt-plan` shows no new, modified or untracked files.**

---

```
QA: docs/runs/2026-09-19-interactive-plan/qa/runtime-qa.md
BUILD_UNDER_TEST: conduit-wt-plan feat/interactive-plan@b793d8a
VERDICT: fail
NOT_COVERED: theme variants, relaunch/restore of an open plan tab, save-failed with a non-permission reason, comment detached/unsaved states, composer 4 KB limit, signature worker-pending and TS diagnostics, conflict "Keep mine", the 1 s banner budget as a timed measurement, diagram node rename and move-into-subgraph, visual/design fidelity (no baseline)
```

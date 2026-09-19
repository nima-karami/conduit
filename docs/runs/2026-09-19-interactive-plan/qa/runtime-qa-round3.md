# Runtime QA round 3 · Interactive plan documents

**When:** 2026-09-19
**Tier:** FULL — re-drive of the three round-two defects, first drive of the two the round-three audit fixed, then the round-two NOT_COVERED list, plus a three-theme variant pass and five negative controls.
**Artifact:** desktop / packaged app (Electron, driven with Playwright-Electron)
**Build under test:** `conduit-wt-plan` at `G:\awby\projects\conduit-wt-plan`, branch `feat/interactive-plan` @ `b5add34` ("fix(plan): Retry keeps bytes, and a write-ack recomputes the state it acknowledges")
**Build identity confirmed from the running artifact:** the worktree was verified clean at `b5add34` before building (`git status --porcelain` empty, `git rev-parse --short HEAD` = `b5add34`); `npm run build` ran in that worktree (exit 0) and every scenario launched Electron with `args: [--user-data-dir=<fresh>, REPO]`, where `REPO` resolves to that worktree (`test/e2e/harness.mjs:21`). There is still no in-app version banner to read back, so identity rests on the single-worktree launch path; each launch used a fresh `--user-data-dir` and no other Conduit process was running. Every path, tab title and breadcrumb in the captures shows only temp roots this run created.
**Environment:** `npm run build` in the worktree, then scenarios **one at a time**, nothing else running. **Every reported result is from a hidden-window run** (`CONDUIT_E2E=1` → `show:false`) — see Environment faults for why that distinction cost a cycle.
**Isolation:** no ports. Fresh `--user-data-dir` (`mkdtempSync`) per launch, own temp project root per scenario. Screenshots to `%TEMP%\claude-scratch\plan-qa3\` by absolute path.
**Configurations driven:** all three themes — `aero`, `aero-dark`, `neon` — each seeded into its profile's `settings.json` before launch. One window size, Windows 11 / win32.
**Teardown:** yes — every app closed through the harness `cleanup()` / `closeApp` path (never by image name), every temp project root and user-data dir removed, the read-only fixture `chmod`-ed back before removal, all five throwaway scenario files deleted, all screenshots and the build log deleted. `git status` in the worktree is clean (verified after teardown).

## Scope

1. Re-drive the three defects round two reported.
2. Drive the two defects the round-three audit found and fixed, which nobody had driven.
3. Work the round-two NOT_COVERED list, highest value first: signature-block TS diagnostics and the worker-pending state, diagram move-into-subgraph and group, theme variants — plus any §8 row nobody asserts.
4. Negative controls for every assertion that carried a verdict.

The three committed `plan-*` scenarios were run first as a regression baseline. Everything else was driven with my own scenarios and my own assertions.

## Verdict

**`pass`** — every in-scope criterion was observed working. All three round-two defects are fixed, both round-three fixes hold, and the four uncovered areas drove clean in all three themes.

Three §8 rows are **specified but not built** (Findings 1–3). None is a regression and none blocks a flow; they are reported so the spec and the build can be reconciled rather than re-discovered every round. One further observation (Finding 4) is about a code path the audit hardened that has no user-reachable trigger I could find.

## Regression baseline — the three committed scenarios

| Scenario | Result |
|---|---|
| `plan-editor` | PASS (39.9 s) |
| `plan-blocks` | PASS (28.7 s) |
| `plan-handoff` | PASS (23.0 s) |

## 1–3 · The round-two defects, re-driven

Scenario: `planqa3-redrive` — 9 assertions, run hidden, twice, both green.

### 1. "Recreate empty" left the pane dead — **fixed**

From a clean start: open project → agent writes `.conduit/plans/recre.md` → toast → Open → live document. Delete it on disk → `.plan__state` reads "This plan was deleted." with **Recreate empty** / **Close**. Click **Recreate empty**:

- the file is written back (`# recre\n`) in **0 ms** of poll budget
- `.plan__editor` is **visible again**, and `.plan__state` matching "deleted" is **0** — the pane is no longer stranded
- the editor renders the new content (`recre`)
- **it is genuinely editable**: ` AFTER-RECREATE` typed into it reached disk in **556 ms**, with `.plan__state--bar` count 0 (no failure bar behind a false recovery)
- re-deleting reaches not-found again, and **Close** detaches the plan's own tab

Evidence: `01-after-recreate.png`, `02-recreate-typed.png`.

The round-two cause (`write-ack` shallow-merging four fields and never recomputing `status`) is gone: `acknowledgeWrite` now derives `status` from the markdown it acknowledges (`webview/plan-store.ts:141`).

### 2. Read-only stranded the first keystroke — **fixed; the view reconciles**

`ro.md` (prose + a mermaid fence), opened, then `chmod 0444`, then typed `RO-FIRST` into the first paragraph:

- the `This file is read-only.` bar appears
- **the editor no longer shows `RO-FIRST`** — the view reconciles back to what the file holds. This is the exact round-two Finding 2, and it is closed.
- the file is byte-identical to the fixture throughout
- `[contenteditable]` is **`"false"`**, and a second keystroke (`RO-SECOND`) is refused — the editor did not gain it
- the diagram toolbar is exactly `["Fit","Edit as text"]` — Add node / Add subgraph are gone, **Fit and Edit as text stay reachable**, and clicking Fit does not fault the pane (`.planflow .react-flow` still 1)
- **commenting still works**: the panel composer opens, Save writes through, and the text reached `ro.comments.json`

Evidence: `03-readonly-reconciled.png`, `04-readonly-comment.png`.

### 3. The composer overhung the panel at the default right pane — **fixed**

At the default `--right-w: 340px`, with the panel composer open and carrying its counter and hint:

| Measure | Value |
|---|---|
| `.plancomment` clientWidth / scrollWidth | **219 / 219** — no horizontal scroll |
| composer right edge vs panel right edge | 1065 vs 1077 — inside |
| hint text | `Ctrl/Cmd+Enter to save · Esc to cancel` — **full string**, clientWidth 170 = scrollWidth 170, not clipped |
| hint right edge vs panel right edge | 1055 vs 1077 — inside |

Evidence: `05-composer-layout.png`, and the three theme captures, where the hint wraps to two lines inside the panel rather than overhanging it.

The fix is the `flex-wrap: wrap` / `min-width: 0` pair on `.rnote-composer__row` / `__hint`. **Negative control 1** defeats exactly that pair and the panel immediately goes to scrollWidth **352** against clientWidth 219 with the hint overhanging by 133 px — i.e. round two's Finding 3 reproduced on demand, so the passing measurement is not vacuous.

## 4–5 · The two round-three fixes, driven for the first time

Scenario: `planqa3-newfix` — 8 assertions, run hidden, three times, all green.

### 4. A load failure's reason must not survive a later successful write — **holds**

Reached the only way it can be (the watcher skips a plan it cannot read, so the valid write raises the toast and the file is corrupted behind it):

- load-failed shows `Can't open this plan: plan unreadable: not valid UTF-8`, with **Open as text** and **Copy path**
- **Open as text** mounts `.plan__source-view .monaco-editor` over the real bytes, with the reason still on the `.plan__state--bar` above it
- the file then becomes valid again → **the pane comes back healthy**: `.plan__state` count **0**, no `.plan__state--bar` matching "Can't open this plan", and the repaired bytes on screen
- toggling Source off returns the live document, and ` POST-REPAIR` typed into it reached disk in **557 ms** with no failure bar

Evidence: `10-load-failed.png`, `11-as-text.png`, `12-repaired.png`.

**Observed, and it matters for what this proves** — see Finding 4: the error state's source view is `readOnly` (`webview/components/plan-view.tsx:522`). I confirmed it at runtime: Monaco reports `readOnly=true` and typing into it changed nothing on disk. So the repair above went through the **external** path (`adopt` → `planWith`), which already cleared `error`. The audit's new `error: undefined` in `acknowledgeWrite` is defensive against a trigger I could not reach from the UI.

### 5. `agentChanged` must be pruned to blocks that still exist — **fixed**

A four-paragraph plan; the agent changes **A** and **C**, leaving **B** between them so deleting C cannot disturb A.

| Step | Chip | Next change |
|---|---|---|
| agent changes two blocks | `2 blocks changed by the agent` | `Next change (2)` |
| human deletes block C | **`1 block changed by the agent`** | **`Next change (1)`** |
| click Next change | chip **gone** (count 0) | `.plan__next` **gone** |

Deleting C left A's agent-changed text and B's own bytes intact on disk, so the surviving hash is a real one. The last row is the discriminator: without pruning the stale hash would keep the count at 1 forever and a second **Next change** would silently do nothing, because `onNextChange` `find`s over `splitPlan(disk).blocks` and a deleted block is not there (`plan-view.tsx:340`).

Evidence: `13-chip-two.png`, `14-chip-pruned.png`, `15-next-cleared.png`.

## What was still uncovered — now driven

Scenario: `planqa3-gaps` — 11 assertions, run hidden, twice, green.

### Signature-block TS diagnostics and the worker-pending state

| Check | Observed |
|---|---|
| clean `ts` fence | **0** markers under owner `plan-ts`, at mount and still 0 after 2 507 ms |
| type error typed in (`const answer: number = 'nope'`) | **TS2322** — "Type 'string' is not assignable to type 'number'." |
| fix it again | markers back to **0** — the worker is live, not a mount-time snapshot |
| `import { thing } from './nowhere'` | **TS2307** — "Cannot find module './nowhere' or its corresponding type declarations." |
| a fence edit reaching disk | 683 ms |

**An import in a fence is an error by design, confirmed.** The block's model is created at `<root>/.conduit/plans/.blocks/<slug>.<nonce>.ts` (`webview/plan-diagnostics.ts` `blockModelUri`), so a relative specifier resolves against a directory that holds nothing; a signature block is a signature, not a compilable module.

**The worker-pending state has no UI.** Diagnostics are per-model markers published under a private owner; there is no `checking…` chip and no language chip — see Finding 1. Markers being empty before the worker answers is the only observable, and it is indistinguishable from "no problems".

Evidence: `20-ts-error.png`, `21-ts-import.png`.

### Diagram move-into-subgraph and group

Fixture: `subgraph backend [Backend]` holding `identity`, with `web` outside and `web --> identity`.

| Step | Observed in the fence on disk |
|---|---|
| right-click `web` → menu offers **Move to subgraph…** (`Shift+G`) | picker opens with `["(none)","Backend"]` |
| pick **Backend** | `web[Web app]` moves **inside** `subgraph backend`, appears **exactly once** (no stale-splice duplicate), and `web --> identity` survives; live region reads **"Moved web to Backend"** |
| toolbar **Add subgraph** | `subgraph group1 [Group]` added, and it renders as a second `.planflow__region` (`["Backend","Group"]`) |
| right-click `web` → Move to subgraph… → **Group** | re-parented into `group1`; it is no longer inside `backend` |
| → **(none)** | back out to the top level |

Evidence: `22-move-picker.png`, `23-moved-in.png`, `24-add-subgraph.png`, `25-moved-out.png`.

### Theme variants — all three, seeded per launch

Scenario: `planqa3-themes` — one launch per theme, each with `{ theme, restoreSessions: false }` written into the profile's `settings.json` before launch, and `document.documentElement.dataset.theme` read back to confirm the seed took before first paint.

Per theme, on a plan carrying prose + a `ts` fence + a mermaid diagram, with the comment gutter shown and the panel composer open:

- the document, the Monaco fence and the diagram all render
- **six floating controls hit-tested** with `elementFromPoint` at their centre — `.plan__source`, `.plan__send`, a `.planflow__toolbar` button, the composer's Save and Cancel, and `.plan__gutter` — every one returns itself or a descendant. This is the check for the class of defect the project's own CLAUDE.md records (a control drawn under `monaco-editor`'s `.minimap{z-index:5}`); **negative control 2** covers one of them and the check reports the covering element, so it discriminates.
- **no horizontal overflow** on `.plan`, `.plan__body`, `.plancomment`, `.plan__actionbar`, `.planflow`
- every semantic token used by the plan surfaces resolves to a value, and the diagram node surface actually paints:

| Theme | node bg / fg | `--panel` |
|---|---|---|
| aero | `rgb(255,255,255)` / `rgb(27,31,42)` | `rgba(255,255,255,0.74)` |
| aero-dark | `rgb(35,37,46)` / `rgb(231,233,240)` | `#1b1d24` |
| neon | `rgb(15,12,28)` / `rgb(200,195,224)` | `#0a0812` |

Captures `30-aero.png`, `30-aero-dark.png`, `30-neon.png` were read against the criteria, not merely filed: in all three the composer's Save/Cancel row and the wrapped hint sit inside the comments panel, the diagram toolbar's four buttons are clear of the canvas, the action bar reads `Saved` / `Source` / `Copy as markdown`, and the counter reads `19 / 4,096`. Neon draws the subgraph region with a visible dashed border; aero and aero-dark draw it as a very low-contrast rounded rect — a taste call, not a defect, and no baseline exists to judge it against.

### Two more §8 rows nobody asserts

- **Diagram block / empty.** An empty `mermaid` fence still mounts the structural editor: 0 nodes, 0 `.planflow__unsupported`, toolbar `["Add node","Add subgraph","Fit","Edit as text"]`. **Add node is offered**, as §8 requires. The **dashed canvas is not there** — `.planflow__canvas` computes `border-style: none` (`.planflow` itself is `solid`). See Finding 2. Evidence: `26-empty-diagram.png`.
- **Send button.** Both rows driven in one plan: with a bare `cmd.exe` session (which has never set DECSET 2004) the control reads **`Copy as markdown`**, is disabled, and its `title` explains why — "This session has no terminal ready to take a multi-line paste…". Arming bracketed paste on the owning session flips the same control to **`Nothing to send`**, still disabled. Evidence: `27-send-states.png`.

## Findings

All four are **specification-versus-build** observations. None is a regression, none blocks a flow, and none was introduced by `b5add34`.

### 1. The signature block has neither the language chip nor the "checking…" chip §8 specifies

**Severity:** cosmetic / spec drift
**Evidence:** measured at runtime — the block renders as a bare `<div class="plan__code" data-lang="ts">`; `getComputedStyle(host,'::before').content` and `'::after').content` are both `"none"`, and the block's parent contains no element whose class matches `chip` or `lang`. `webview/components/plan-code-block.tsx` returns that single div and nothing else.

Spec §8 asks for two things this build does not have: "Signature block | populated | Monaco, diagnostics squiggles, **language chip**" and "Signature block | worker-pending | Monaco without diagnostics; **chip 'checking…'**". The diagnostics half works (above); the chips do not exist. The practical consequence is the worker-pending state is **not distinguishable from a clean fence** — both show Monaco with no markers.

### 2. An empty diagram still has no dashed canvas

**Severity:** cosmetic
**Evidence:** `.planflow__canvas` computes `border-style: none`; `26-empty-diagram.png`.

§8 says "Diagram block | empty | **Dashed canvas**, Add node". Add node is present. This is round one's Finding 4, unchanged, and is recorded here because round two did not re-drive it.

### 3. §8's first-run row has no implementation and no surface

**Severity:** low
**Evidence:** source-level, and stated as such — `grep -rn "No plans yet" webview/ src/ electron/ resources/` matches only `docs/specs/2026-09-19-interactive-plan.md:282`, and `"Copy prompt"` / `"write an interactive plan for"` match nothing anywhere in the build.

§8's "Plan editor | first-run | 'No plans yet. Ask your agent: …' | Copy prompt" describes a plan-*list* surface. A plan is a document tab opened from a toast or the explorer; there is no list view for the empty state to live in. Either the row belongs to a surface that was cut, or it should be struck from §8. **This one is not runtime-observable** — there is no state to drive — so it is listed under NOT_COVERED as well.

### 4. The `write-ack`-over-`error` branch the audit hardened has no user-reachable trigger I could find

**Severity:** informational — a note so the next round does not hunt for it
**Evidence:** `plan-view.tsx:522` renders the load-failed source view as `<PlanSourceView … readOnly />`; measured at runtime, Monaco reports `readOnly=true` and typing into it left the file byte-identical.

`acknowledgeWrite` gained `error: undefined` in `b5add34`. `status === 'error'` is only ever set from a **load** failure (`onError`, `op: 'load'`), and the only three `writePlan` callers are the live editor (not rendered in that state), Recreate empty (not offered in that state) and the source view (read-only in that state). So every repair of a load-failed plan arrives externally, through `adopt` → `planWith`, which already cleared `error` before this commit. I drove that path and it is clean; I could not reach the branch the new line guards. The `status` half of the same fix **is** reachable and is what Defect 1 exercises.

## Negative controls

Scenario: `planqa3-control`. Five assertions that carry a verdict in this report, each re-pointed at a state where it must fail. **All five reported a failure**, run both visible and hidden.

| Assertion | Re-pointed at | Reported |
|---|---|---|
| composer fits the panel | `flex-wrap` / `min-width` fix defeated by injected CSS | FAIL — panel 219 client / **352** scroll, hint right 1210 vs panel right 1077 |
| floating controls are hit-testable | Source button covered by a transparent overlay | FAIL — `elementFromPoint` returns `.plan__actionbar` |
| the chip prunes to "1 block changed" | agent changed two blocks, **nothing deleted** | FAIL — chip reads `2 blocks changed by the agent` |
| a `ts` fence publishes TS2322 | a fence with no error | FAIL — markers `[]` |
| a refused keystroke is reconciled away | a **writable** plan | FAIL — the keystroke stayed on screen and reached disk |

## Visual / design fidelity

**Baseline:** none obtainable — still a new surface with no pre-change build to compare against, and no design source was supplied. **Fidelity is not covered.**

Every state was captured and read against its criterion in words (that is how Findings 1 and 2 were confirmed by measurement rather than assumed), and all three themes were captured, but no side-by-side comparison was possible and no verdict on appearance is offered.

## What worked

- All three round-two defects are genuinely fixed, in the branches the committed tests reach and in the branches they do not.
- Both round-three fixes hold. The `agentChanged` prune is the more valuable of the two: without it the chip count and **Next change** drift apart from the document permanently.
- The read-only reconcile closes a real screen-versus-disk disagreement, and it does not cost the commenting or Fit / Edit as text affordances.
- TS diagnostics in a `ts` fence are live in both directions — they appear on an error and clear on a fix — against the open project's own worker.
- Move-into-subgraph, Add subgraph and move-back-out all round-trip through the fence with no duplication and no lost edges, and each announces itself.
- Every plan surface holds up in all three themes: no covered control, no horizontal overflow, no token that resolves to nothing.

## Not covered

- **Visual / design fidelity** — no baseline (see above).
- **§8's first-run row** — not runtime-observable; there is no surface for it (Finding 3).
- **The signature block's worker-pending state as a distinct state** — not observable, because no chip exists (Finding 1). The marker-empty window was timed instead.
- **The `write-ack`-over-`error` branch** — no user-reachable trigger found (Finding 4). Driving it would require manufacturing a state the UI cannot produce, which would prove nothing about the product.
- **The 1 s banner budget as a timed measurement.** Observed well inside generous waits again, never timed to the 1 s §7 states. (Carried over from round two.)
- **Keyboard-only diagram navigation** (§9's Tab-into-diagram, arrows, `Shift+C`, `Shift+G`). The context-menu pathway to Move to subgraph… was driven; the keyboard hint on that row was not exercised as a key press.
- **Diagram node drag and connect-by-drag.** The non-drag pathways were driven; the drags themselves were not.
- **Reduced motion, forced-colors and focus-ring visibility** (§10). Not driven in any theme.

## Decisions needed

- **`low` — Findings 1, 2 and 3.** Three §8 rows describe UI that does not exist: the signature block's language and "checking…" chips, the empty diagram's dashed canvas, and the plan-editor first-run state. Each is either a small build or a strike-through in the spec. Left as they are, §8 reads as coverage that is not there, and every QA round re-discovers them.
- **`low` — Finding 4.** The `error: undefined` added to `acknowledgeWrite` guards a branch nothing can reach while the load-failed source view stays read-only. Keep it as defence, or make that source view writable so a user can repair a corrupt plan in place — which would make the guard load-bearing and give the load-failed state a real recovery instead of only a way to look.

## Environment faults

**One, and it cost a cycle — worth recording because it is a trap for anyone driving this suite.** `test/e2e/run-smoke.mjs` sets `CONDUIT_E2E=1`, which is what makes the window hidden (`main.ts` → `show:false`). Running a scenario file directly with `node test/e2e/<name>.e2e.mjs` does **not** set it, so the window is visible and the run is not the suite's run. One of my own assertions — a caret placed by a plain `.click()` on a paragraph — passed visible and failed hidden, three times out of three, and the diagnostic dump proved it was my harness (the editor text was untouched, save state `Saved`, no failure bar) rather than a refused write. Switching to a triple-click that asserts its own selection fixed it. **Every result in this report is from a hidden run**, and the two scenarios that had first been driven visible were re-driven hidden before anything here was written.

No PTY flakiness, no starved ConPTY, no orphaned Electrons. Scenarios ran one at a time on an otherwise quiet machine. A concurrent read-only source review was running and neither built nor launched anything.

## Artifacts

All evidence was captured, read against the criteria, described above in words, and then **deleted** as the run required. Nothing remains on disk.

- 19 screenshots were written to `%TEMP%\claude-scratch\plan-qa3\` (`01-after-recreate.png` … `30-neon.png`) and deleted after being described.
- The build log (`%TEMP%\claude-scratch\plan-qa3\build.log`) was deleted.
- Five throwaway scenarios were written, run and deleted: `test/e2e/planqa3-redrive.e2e.mjs`, `planqa3-newfix.e2e.mjs`, `planqa3-gaps.e2e.mjs`, `planqa3-themes.e2e.mjs`, `planqa3-control.e2e.mjs`.
- Every temp project root and user-data dir was removed by each scenario's own teardown; the read-only plan fixture was `chmod`-ed back before removal.
- **`git status` in `G:\awby\projects\conduit-wt-plan` shows no new, modified or untracked files**, and the scratch directory `%TEMP%\claude-scratch\plan-qa3\` was removed. Confirmed after teardown.

---

```
QA: docs/runs/2026-09-19-interactive-plan/qa/runtime-qa-round3.md
BUILD_UNDER_TEST: conduit-wt-plan feat/interactive-plan@b5add34
VERDICT: pass
NOT_COVERED: visual/design fidelity (no baseline), §8 first-run row (no surface exists), signature-block worker-pending as a distinct state (no chip exists), the write-ack-over-error branch (no user-reachable trigger), the 1 s banner budget as a timed measurement, keyboard-only diagram navigation, diagram drag and connect-by-drag, reduced-motion / forced-colors / focus-ring visibility
```

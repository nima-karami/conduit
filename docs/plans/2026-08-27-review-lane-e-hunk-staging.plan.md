# Hunk-level Stage / Unstage / Discard + Editor Change Peek (Review supercharge — Lane E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the reviewer act on ONE change instead of a whole file — Stage / Discard from a Review hunk header, Unstage under the Staged scope, the same two from a click-to-open peek inside the editor, and `s` / `d` from the Review keymap. Every patch is built **host-side out of git's own `git diff` bytes**, so CRLF and no-EOF-newline files apply correctly and a file that moved under the diff fails safely instead of half-applying.

**Architecture:** Three layers, each testable on its own.

1. **`src/hunk-patch.ts` (pure, node-free).** Parses a unified diff byte-faithfully (`split('\n')` only — `\r` is content, never a separator) and re-emits a valid sub-patch containing only the hunks a caller's line range touches. Also converts a `ReviewHunk` into that line range. No git, no IO.
2. **`src/git-actions.ts` (host).** `GitOp` gains `stageHunk | unstageHunk | discardHunk`. `planGitAction` stays pure and now yields a `{ kind: 'hunk' }` plan carrying the **arg arrays** for both git invocations; `executeGitAction` runs the diff, calls `selectHunks`, and runs `git apply` with the patch on **stdin** through a `{ kind: 'git'; args; stdin }` plan. Containment is the existing `isInsideRoot` check — the renderer's `range` is just numbers.
3. **Renderer.** One module, `webview/hunk-actions.ts`, owns the button-mode rule, the copy, and the async orchestration (confirm → `gitAction` → toast/announce → invalidate + refresh), with its app-level capabilities injected through a tiny external store (`change-nav-registry.ts`'s pattern) that `app.tsx` populates. Both consumers — the Review hunk header and the editor's `usePeekZone` view zone — call the same function.

**Tech Stack:** TypeScript (two tsconfigs: host `tsconfig.json`, renderer `tsconfig.webview.json`), React 18, monaco-editor, Electron IPC via `src/protocol.ts` + the `git-action` invoke channel, Vitest (node + jsdom) for unit tests, Playwright-Electron for the e2e scenario, Biome for lint/format.

**Spec:** `docs/specs/2026-08-27-review-supercharge.md` — read the revision note at the top, §0, **§2 Lane E**, §2 Lane D (E consumes D's interface), §3, §4, §5, **§7 Lane E**, §8–§11, §12 #8. This plan implements **Lane E only**. Lanes B, C, D and F are out of scope; do not build them.

## Lane D contract this plan CONSUMES

Lane D is a **LITE** lane that lands before this one. Lane E reads exactly three things from it and nothing else:

| From Lane D | Shape E assumes | How E reads it |
|---|---|---|
| `readDiff` gains a base/side pair | `{ type: 'readDiff'; path: string; base?: 'head' \| 'index'; side?: 'index' \| 'worktree' }` (defaults reproduce today) | **E never sends `readDiff` itself.** It invalidates the cached diff for one path and lets the Review card's existing `onRequestOnce` → `onRequestDiff` path re-issue whatever request D's scope currently implies. |
| Review's working source carries a scope | `ReviewSource = { kind: 'working'; scope?: 'all' \| 'staged' \| 'unstaged' } \| …` in `webview/docs.ts` | `const scope = source?.kind === 'working' ? (source.scope ?? 'all') : 'all'` — read **optionally**, so this lane compiles and behaves correctly (All-scope rule) even if D has not landed. |
| The card knows whether the file has a staged side | `ChangeDTO.staged` — already on `main` (`src/protocol.ts:53`); a path modified in both index and worktree produces **two** entries | Review derives `new Set(effectiveChanges.filter((c) => c.staged).map((c) => c.path))` from the `changes` prop it already has. The editor gets the same set through the `app.tsx`-populated host store. |

E adds no field to `ReviewSource`, no field to `ChangeDTO`, and no parameter to `readDiff`.

## Global Constraints

Copied from the spec and from `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Patches are built by the host from git's own diff — never from renderer text.** The renderer sends a *line range*; the host selects git's hunks. (§2 Lane E)
- **The three ops and their exact git pairs** (§2 Lane E):
  - `stageHunk` → `git diff -U3 -- <rel>` (index→worktree), keep the intersecting hunks, `git apply --cached`.
  - `unstageHunk` → `git diff --cached -U3 -- <rel>` (HEAD→index), keep the intersecting hunks, `git apply --cached --reverse`.
  - `discardHunk` → `git diff -U3 -- <rel>`, keep the intersecting hunks, `git apply --reverse` — revert the worktree to the **index**, the same target as `discardTracked`.
- **`range = { new: [start, end], old: [start, end] }`**, 1-based inclusive; a pure deletion has an **empty** `new` span and matches on `old`. (§2 Lane E)
- **`GitActionPlan` gains `stdin`.** (§2 Lane E, §3)
- **Nothing renderer-side is trusted:** `path` containment as today (`isInsideRoot`, `src/git-actions.ts`), and the range is just numbers. (§2 Lane E)
- **Baseline rule.** Stage/Discard act on the **index→worktree** hunks. Under **Unstaged** scope the ranges map 1:1. Under **All** they map 1:1 only when the file has no staged side; when `ChangeDTO.staged` exists for the path the hunk buttons are **disabled** with the tooltip **"Switch to Unstaged scope to stage hunks"**. **Unstage is offered only under Staged scope.** (§2 Lane E, §4)
- **Where the actions live:** the Review hunk header (Stage / Discard; Unstage under Staged), the editor **change peek**, and the scoped keys `s` / `d`. (§2 Lane E, §9)
- **Change peek:** click a gutter marker → Monaco view zone (`changeViewZones`) under the hunk; a React portal into `domNode`, owned by a `usePeekZone` hook that removes the zone and unmounts the portal on **close / model swap / editor dispose**. Shows the removed lines in Review row styling, **"Change 2 of 5"**, and **Stage · Discard · ↑ ↓ ×**. **One at a time.** Esc closes and returns focus to the editor. Peek actions obey the same baseline rule. (§2 Lane E, §8)
- **Discard confirms** via `webview/components/confirm-dialog.tsx` with the spec's copy: "Discard this change? 12 lines in `src/foo.ts` will be reverted to the index. This can't be undone." [Discard] [Cancel]. **Stage/Unstage don't confirm.** (§2 Lane E)
- **After any op:** normal git refresh; the card re-requests its diff; the file's reviewed mark prunes by hash; the current-hunk index clamps. (§2 Lane E)
- **Conflict:** file changed after the diff loaded → `git apply` rejects → toast **"The file changed since this diff was loaded — refreshed."** + card reload. **No partial apply** (`git apply` is atomic per invocation); **no blind retry.** (§2 Lane E, §4)
- **Untracked file: Stage = existing `stageFile`.** (§2 Lane E, §4)
- **A range spanning two git hunks applies both** — git's split is an artefact. (§4, §12 #8)
- **CRLF / no-EOF-newline:** the host patch is git's own bytes, so it applies; unit fixtures cover both. (§4)
- **`--change-peek-bg`** token, per theme (Aero / Aero Dark / Neon), beside the existing `--diff-*` / `--change-*` block. (§11)
- **Accessibility (§9, §10):** peek is `role="dialog"` with `aria-label="Change 2 of 5"`; it **traps focus and returns it**; every pointer action has a keyboard path; every destructive action confirms; live-region announcements "Staged hunk" / "Discarded hunk"; the peek opens **without animation** under `prefers-reduced-motion`; the removed-line wash reuses `--diff-remove` with the glyph carrying the signal.
- **Review stays plain rows** — no Monaco inside Review (`review-view.tsx:56`).
- **All git spawns go through `src/git-exec.ts`.** It already accepts `stdin`.
- **NEVER write redundant comments.** A comment explains *why* (a non-obvious constraint or gotcha), never restates *what* the code says. Don't re-explain a decision that lives in the spec — link to it (`// see spec 2026-08-27-review-supercharge §2 Lane E`). (`CLAUDE.md`)
- **Fix root causes, no band-aids.** No `!important`, no specificity escalation, no `as any` / `@ts-ignore`. (`CLAUDE.md`)
- **Two tsconfigs.** `npm run typecheck` runs both. Never put a `node:` import in a module the renderer imports at runtime — `src/hunk-patch.ts` is imported by the renderer, so it stays node-free. (`CLAUDE.md`)
- **CI `verify` runs on `ubuntu-latest`.** Never let a unit test depend on `process.platform`, `path.sep`, or drive-letter casing. Normalise explicitly inside the code under test. (`CLAUDE.md`)
- **`npm run verify` is the gate.** Never disable, downgrade, narrow, or defer one of its checks. (`CLAUDE.md`)
- **The e2e scenario runs hidden** on the shared harness (`test/e2e/harness.mjs`, `CONDUIT_E2E=1` → `show:false`). Run it **alone on a quiet machine**; a loaded machine fails PTY-adjacent e2es the way a broken PTY does. (`CLAUDE.md`)
- **Scratch artifacts never land in the repo.** Screenshots go to an absolute path under `%TEMP%\claude-scratch`. (`CLAUDE.md`)
- **Docs layout is a contract (ADR 0003).** User-facing changes go in root `CHANGELOG.md`.
- **i18n:** none — English literals, repo convention.

## Assumptions

Recorded because this is an unattended pipeline — no questions were asked.

1. **Lane ordering is the spec's: A → B → D → E.** Lane A has landed on `main` (`webview/use-change-markers.ts`, `webview/change-decorations.ts`, `webview/change-nav-registry.ts`, `test/unit/use-change-markers.test.ts` all exist). Lane B and Lane D are assumed landed when this lane starts. Every Lane B / Lane D touch point below is written so a **missing** piece degrades rather than breaks (Task 7's keymap edits are the one hard dependency; see assumption 3).
2. **The empty span is encoded `[start, start - 1]`.** A `[number, number]` tuple has no "absent" value, and a nullable side would force every consumer to branch. `end < start` ⇒ empty, and `start` still names the position the (zero-length) span sits at — which is exactly what a pure insertion's old side and a pure deletion's new side need to carry. `spansOverlap` treats an empty span as intersecting nothing.
3. **The Lane B keymap table is `ACTIONS`, not `KEYMAP`.** The task brief named `KEYMAP: Record<string, ReviewKeyAction>`; the Lane B plan (`git show feat/review-lane-b-keymap-persist:docs/plans/2026-08-27-review-lane-b-keymap-persist.plan.md`, Task 1) actually defines `const ACTIONS: Readonly<Record<string, ReviewAction>>` plus a `ReviewAction` union and a `REVIEW_KEY_HELP` array, and its own test asserts that `s` and `d` map to **null** ("s/d are Lane E"). Task 7 edits those three exports by their real names and **flips that Lane B test case**, which is the intended hand-off. If `webview/review-keymap.ts` does not exist when this lane starts, Lane B has not landed: skip Task 7 and record it, rather than inventing the module here.
4. **A hunk is matched on its CHANGED lines, not its `@@` header span.** The header span includes up to 3 lines of context on each side, so header-span matching would let a range that touches only context select a hunk the user never pointed at. Matching the `+`/`-` line spans is strictly more precise and still satisfies §4's "a range intersecting two git hunks applies both", because two runs close enough to share context are already one git hunk.
5. **Selection is `newOverlap || oldOverlap`, not "new, falling back to old".** The brief's rule ("new-side, or for empty new spans old-side") is the special case; the OR is the general one and is what makes a pure-deletion *hunk* (`@@ -5,2 +4,0 @@`, empty new span) reachable from a range whose new span is non-empty but whose old span covers the removal. Under every baseline this lane supports, the old-side coordinates of the range and of the diff come from the same two trees, so the OR cannot select an unrelated hunk.
6. **`git diff` is pinned to a canonical shape:** `--no-ext-diff --no-color --src-prefix=a/ --dst-prefix=b/ -U3`. A user's `diff.external`, `color.diff = always`, or `diff.noPrefix = true` would otherwise produce output `git apply -p1` cannot read. `git apply` gets `--whitespace=nowarn` so a whitespace-dirty repo does not fill `stderr` with warnings that would be reported as a failure message.
7. **`git apply` reads the patch from stdin with NO file argument.** `git apply -` treats `-` as a filename; git reads stdin when no path is given. `runGitBin` already closes stdin (`child.stdin?.end(opts.stdin)`), so an apply always terminates.
8. **`GitActionResult.error` becomes a stable CODE for hunk ops and stays human text for the legacy ops**, with a new optional `message` carrying git's stderr. `app.tsx`'s existing `runGit` toasts `Git: ${res.error}` for the legacy ops only; hunk ops route through `applyHunkAction`, which maps the code to the spec's copy. Adding a separate result type would fork the IPC channel for one caller.
9. **`no-hunk` and `apply-failed` show the same toast.** The spec gives copy for the conflict only, and both codes have the same cause from the user's side — the diff on screen no longer describes the file — and the same remedy, which the copy already states ("refreshed"). A second, subtly different sentence would be a distinction without a difference.
10. **`ChangeMarker` gains `oldRange` and `removedText`.** Lane A deliberately dropped both ("that was peek-only and is gone" — Lane A self-review), and this is the lane that needs them: the peek renders the removed lines, and a stage/discard from the editor needs the old-side span for a pure deletion. Both are **required** fields, so a marker built by hand cannot silently omit them; Task 8 updates the six Lane A literals that this widens.
11. **App-level capabilities reach both surfaces through a module-scope store, not props.** The editor peek sits four prop hops from `app.tsx` (`app` → `center-pane` → `doc-view` → `DocBody` → `CodeViewer`), and the existing `onGitAction` prop is fire-and-forget while a hunk op must be **awaited** (invalidate the diff, announce, clamp the cursor). `webview/save-registry.ts` and `webview/change-nav-registry.ts` are the same pattern for the same reason. One store serves both callers.
12. **`pushToast` is imported directly** (`webview/toast-store.ts` is a module-scope store, already used that way across the renderer), so the toast is not part of the injected host.
13. **Discard is not offered under the Staged scope, and not on an untracked file.** Under Staged the visible hunks are HEAD→index, whose ranges do not describe the index→worktree diff a discard reverses; under Unstaged and All they do. An untracked file has no index entry to revert to, so `git apply -R` cannot express "discard this hunk" — the whole-file `discardUntracked` in the Changes panel remains the path, and the button says so.
14. **`s` runs the header's PRIMARY action for the current mode** (Stage under `stage`, Unstage under `unstage`) and announces the blocked reason under `blocked`; `d` runs Discard and announces when Discard is not offered. The spec's key table says "stage / discard current hunk"; binding `s` to a button that is not on screen would be worse than binding it to the one that is.
15. **The reviewed mark prunes itself.** Lane B keys a mark by an FNV-1a hash of the new-side text; a staged or discarded hunk changes that text, so the mark stops matching and Lane B's own reconcile drops it. Lane E writes nothing to the marks store.
16. **The e2e locates Lane D's scope control by ACCESSIBLE NAME** (`getByRole('radio', { name: 'Unstaged' })`), which §9 fixes (`role="radiogroup"`) even though the class name is D's to choose.
17. **`useChangeMarkers` re-exposes `untracked`.** Lane A removed it with the peek; §8's "untracked" peek state needs it back. One boolean on `ChangeMarkersApi`, read off the same `head.reason` the hook already branches on.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/hunk-patch.ts` | Pure, node-free: `parseUnifiedDiff`, `selectHunks`, `spansOverlap`, `hunkRange`, the `HunkRange` type. Byte-faithful (`\r` is content). |
| `webview/hunk-actions.ts` | Pure: button-mode rule, all user-facing copy, `applyHunkAction` with its capabilities injected — plus the tiny module-scope host store both surfaces read. |
| `webview/use-peek-zone.ts` | The view-zone + portal lifecycle hook: add/remove `changeViewZones`, `createPortal` into `domNode`, close on Esc / model swap / editor dispose / another marker. |
| `webview/components/change-peek.tsx` | The peek's contents: removed lines, "Change N of M", Stage · Discard · ↑ ↓ ×, focus trap. |
| `test/unit/hunk-patch.test.ts` | LF / CRLF / no-EOF-newline / rename-header / binary fixtures for the parser and the selector. |
| `test/unit/hunk-patch-integration.test.ts` | Real `git diff -U3` on a temp repo → `selectHunks` → `git apply --check` and `--cached --check`. |
| `test/unit/git-actions-hunks.test.ts` | The planner: arg arrays, containment, rejections. |
| `test/unit/hunk-actions.test.ts` | Mode rule, copy, and the full `applyHunkAction` matrix against injected fakes. |
| `test/unit/use-peek-zone.test.ts` | jsdom: zone add/remove, portal mount/unmount, Esc, model swap (mirrors `test/unit/use-change-markers.test.ts`). |
| `test/e2e/hunk-staging.e2e.mjs` | The lane's host-boundary scenario. |

**Modified**

| File | Change |
|---|---|
| `src/git-actions.ts` | `HunkOp`; three new `GitOp` members; `GitActionRequest.range`; `GitActionPlan` `stdin` + `hunk` kind; `buildHunkPlan`; the executor's hunk branch. |
| `src/git-exec.ts` | Nothing — `stdin` already exists. (Listed so nobody re-adds it.) |
| `webview/change-decorations.ts` | `ChangeMarker.oldRange` + `.removedText`; `markerRange`, `markerIndexAtLine`, `peekAfterLine`, `peekHeightInLines`, `reducePeek`. |
| `webview/use-change-markers.ts` | Populate the two new marker fields on the untracked whole-file marker; expose `untracked` on `ChangeMarkersApi`. |
| `webview/components/code-viewer.tsx` | Gutter-click → peek; `usePeekZone` wiring; a second polite live region for hunk announcements. |
| `webview/components/review-view.tsx` | `.rhunk__head` row with Stage / Unstage / Discard; scope + staged-side derivation; post-op invalidate; `s` / `d` handling; cursor clamp on a hunk-count change. |
| `webview/review-keymap.ts` | `ReviewAction` gains `stageHunk` / `discardHunk`; `ACTIONS` gains `s` / `d`; `REVIEW_KEY_HELP` gains a row. |
| `webview/app.tsx` | Populate the hunk-action host (root, staged paths, confirm, refresh, diff invalidation); resolve the confirm promise on Cancel/Esc. |
| `webview/styles.css` | `--change-peek-bg` per theme; `.rhunk__head` / `.rhunk__act`; `.peek*`; reduced-motion and forced-colors rules. |
| `test/unit/change-decorations.test.ts` | Widen the six marker literals; cover the new pure helpers. |
| `test/unit/review-keymap.test.ts` | `s` / `d` now map; drop them from the "keys this lane does not own" list. |
| `test/unit/git-actions-integration.test.ts` | Real-repo hunk staging / unstaging / discard / conflict. |
| `test/unit/theme-tokens.test.ts` | `--change-peek-bg` declared and legible in all three themes. |
| `CHANGELOG.md` | `[Unreleased]` → `### Added`. |

---

## Task 1: The pure patch selector (`src/hunk-patch.ts`)

**Files:**
- Create: `src/hunk-patch.ts`
- Test: `test/unit/hunk-patch.test.ts`

**Interfaces:**
- Consumes: `ReviewHunk` from `src/review-hunks.ts` (**type-only**).
- Produces:
  - `export interface HunkRange { new: [number, number]; old: [number, number] }`
  - `export interface DiffHunk { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; text: string; changedNew: [number, number]; changedOld: [number, number] }`
  - `export interface ParsedDiff { header: string; hunks: DiffHunk[]; binary: boolean }`
  - `export function parseUnifiedDiff(text: string): ParsedDiff`
  - `export function spansOverlap(a: [number, number], b: [number, number]): boolean`
  - `export function selectsHunk(hunk: DiffHunk, range: HunkRange): boolean`
  - `export function selectHunks(diffText: string, range: HunkRange): string`
  - `export function hunkRange(hunk: ReviewHunk): HunkRange`

Node-free on purpose: the renderer imports `HunkRange` and `hunkRange`, the host imports `selectHunks`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/hunk-patch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  type HunkRange,
  hunkRange,
  parseUnifiedDiff,
  selectHunks,
  spansOverlap,
} from '../../src/hunk-patch';
import { computeFileReview } from '../../src/review-hunks';

/** Two separate hunks in one file, LF throughout. */
const TWO_HUNKS = [
  'diff --git a/two.txt b/two.txt',
  'index 1111111..2222222 100644',
  '--- a/two.txt',
  '+++ b/two.txt',
  '@@ -1,5 +1,6 @@',
  ' l1',
  ' l2',
  '+ADDED-A',
  ' l3',
  ' l4',
  ' l5',
  '@@ -18,6 +19,6 @@',
  ' l18',
  ' l19',
  ' l20',
  '-l21',
  '+CHANGED-B',
  ' l22',
  ' l23',
  '',
].join('\n');

const range = (n: [number, number], o: [number, number]): HunkRange => ({ new: n, old: o });

describe('parseUnifiedDiff', () => {
  it('splits the file header from the hunks and re-reads both @@ headers', () => {
    const p = parseUnifiedDiff(TWO_HUNKS);
    expect(p.binary).toBe(false);
    expect(p.header).toBe(
      'diff --git a/two.txt b/two.txt\nindex 1111111..2222222 100644\n--- a/two.txt\n+++ b/two.txt\n',
    );
    expect(p.hunks).toHaveLength(2);
    expect(p.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 5, newStart: 1, newCount: 6 });
    expect(p.hunks[1]).toMatchObject({ oldStart: 18, oldCount: 6, newStart: 19, newCount: 6 });
  });

  it('spans only the CHANGED lines, not the context the @@ header covers', () => {
    const p = parseUnifiedDiff(TWO_HUNKS);
    // Hunk 1 adds new line 3 only; nothing is removed.
    expect(p.hunks[0].changedNew).toEqual([3, 3]);
    expect(p.hunks[0].changedOld).toEqual([3, 2]); // empty, anchored where the insertion sits
    // Hunk 2 replaces old 21 with new 22.
    expect(p.hunks[1].changedNew).toEqual([22, 22]);
    expect(p.hunks[1].changedOld).toEqual([21, 21]);
  });

  it('keeps every hunk body line verbatim, trailing newline included', () => {
    const p = parseUnifiedDiff(TWO_HUNKS);
    expect(p.hunks[0].text).toBe('@@ -1,5 +1,6 @@\n l1\n l2\n+ADDED-A\n l3\n l4\n l5\n');
    expect(`${p.header}${p.hunks[0].text}${p.hunks[1].text}`).toBe(TWO_HUNKS);
  });

  it('treats a missing count as 1', () => {
    const p = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -4 +4 @@\n-a\n+b\n');
    expect(p.hunks[0]).toMatchObject({ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 });
  });

  it('keeps CR bytes as content — \\n is the only separator', () => {
    const crlf = '--- a/x\r\n+++ b/x\r\n@@ -1,1 +1,1 @@\n-one\r\n+two\r\n';
    const p = parseUnifiedDiff(crlf);
    expect(p.header).toBe('--- a/x\r\n+++ b/x\r\n');
    expect(p.hunks[0].text).toBe('@@ -1,1 +1,1 @@\n-one\r\n+two\r\n');
  });

  it('keeps the no-newline-at-EOF marker inside its hunk', () => {
    const src = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+two\n';
    const p = parseUnifiedDiff(src);
    expect(p.hunks[0].text).toContain('\\ No newline at end of file\n');
    // The marker line is not a content line: it must not advance either side's counter.
    expect(p.hunks[0].changedOld).toEqual([1, 1]);
    expect(p.hunks[0].changedNew).toEqual([1, 1]);
  });

  it('reads a rename header without inventing a hunk', () => {
    const src = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 87%',
      'rename from old.txt',
      'rename to new.txt',
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1,1 +1,1 @@',
      '-one',
      '+two',
      '',
    ].join('\n');
    const p = parseUnifiedDiff(src);
    expect(p.header).toContain('rename from old.txt\n');
    expect(p.header).toContain('rename to new.txt\n');
    expect(p.hunks).toHaveLength(1);
  });

  it('flags a binary diff and yields no hunks', () => {
    const p = parseUnifiedDiff(
      'diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n',
    );
    expect(p.binary).toBe(true);
    expect(p.hunks).toEqual([]);
  });

  it('flags a GIT binary patch', () => {
    expect(parseUnifiedDiff('diff --git a/x b/x\nGIT binary patch\nliteral 4\n').binary).toBe(true);
  });

  it('returns nothing for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual({ header: '', hunks: [], binary: false });
  });
});

describe('spansOverlap', () => {
  it('is true for touching and overlapping spans', () => {
    expect(spansOverlap([3, 5], [5, 9])).toBe(true);
    expect(spansOverlap([3, 5], [1, 3])).toBe(true);
    expect(spansOverlap([3, 5], [4, 4])).toBe(true);
  });

  it('is false for disjoint spans', () => {
    expect(spansOverlap([3, 5], [6, 9])).toBe(false);
  });

  it('an empty span (end < start) intersects nothing, including itself', () => {
    expect(spansOverlap([5, 4], [1, 10])).toBe(false);
    expect(spansOverlap([1, 10], [5, 4])).toBe(false);
    expect(spansOverlap([5, 4], [5, 4])).toBe(false);
  });
});

describe('selectHunks', () => {
  it('keeps only the hunk the new-side range touches, with the file header verbatim', () => {
    const patch = selectHunks(TWO_HUNKS, range([22, 22], [21, 21]));
    expect(patch).toBe(
      'diff --git a/two.txt b/two.txt\nindex 1111111..2222222 100644\n--- a/two.txt\n+++ b/two.txt\n' +
        '@@ -18,6 +19,6 @@\n l18\n l19\n l20\n-l21\n+CHANGED-B\n l22\n l23\n',
    );
  });

  it('keeps the other hunk for the other range', () => {
    const patch = selectHunks(TWO_HUNKS, range([3, 3], [3, 2]));
    expect(patch).toContain('@@ -1,5 +1,6 @@');
    expect(patch).not.toContain('@@ -18,6 +19,6 @@');
  });

  it('applies BOTH when the range spans two git hunks (spec §4)', () => {
    const patch = selectHunks(TWO_HUNKS, range([1, 40], [1, 40]));
    expect(patch).toContain('@@ -1,5 +1,6 @@');
    expect(patch).toContain('@@ -18,6 +19,6 @@');
  });

  it('does not select a hunk the range only touches through its context', () => {
    // New lines 1-2 are hunk 1's leading CONTEXT; its only changed line is 3.
    expect(selectHunks(TWO_HUNKS, range([1, 2], [1, 2]))).toBe('');
  });

  it('matches a pure-deletion hunk on the old side when the new span is empty', () => {
    const src = '--- a/x\n+++ b/x\n@@ -4,5 +4,3 @@\n c3\n-d4\n-d5\n c6\n c7\n c8\n';
    // A deletion anchored after new line 4: new span empty at 5, old span 5-6.
    const patch = selectHunks(src, range([5, 4], [5, 6]));
    expect(patch).toContain('@@ -4,5 +4,3 @@');
  });

  it('returns an empty patch for a binary diff', () => {
    const src = 'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n';
    expect(selectHunks(src, range([1, 10], [1, 10]))).toBe('');
  });

  it('returns an empty patch when nothing intersects', () => {
    expect(selectHunks(TWO_HUNKS, range([900, 910], [900, 910]))).toBe('');
  });

  it('returns an empty patch for an empty diff', () => {
    expect(selectHunks('', range([1, 1], [1, 1]))).toBe('');
  });

  it('preserves CRLF and the no-EOF marker in what it re-emits', () => {
    const src = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-one\r\n+two\r\n\\ No newline at end of file\n';
    expect(selectHunks(src, range([1, 1], [1, 1]))).toBe(src);
  });
});

describe('hunkRange', () => {
  const lines = (n: number, prefix = 'l') =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n');

  it('spans the changed lines of a replacement on both sides', () => {
    const review = computeFileReview(lines(10), lines(10).replace('l5', 'CHANGED'));
    expect(hunkRange(review.hunks[0])).toEqual({ new: [5, 5], old: [5, 5] });
  });

  it('gives a pure insertion an empty old span anchored after the previous old line', () => {
    const head = lines(10);
    const work = `${lines(5)}\nNEW1\nNEW2\n${['l6', 'l7', 'l8', 'l9', 'l10'].join('\n')}`;
    const r = hunkRange(computeFileReview(head, work).hunks[0]);
    expect(r.new).toEqual([6, 7]);
    expect(r.old[1]).toBeLessThan(r.old[0]);
    expect(r.old[0]).toBe(6);
  });

  it('gives a pure deletion an empty new span and a real old span', () => {
    const work = ['l1', 'l2', 'l3', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n');
    const r = hunkRange(computeFileReview(lines(10), work).hunks[0]);
    expect(r.old).toEqual([4, 5]);
    expect(r.new[1]).toBeLessThan(r.new[0]);
    expect(r.new[0]).toBe(4);
  });

  it('spans every run when one Review hunk holds two of them', () => {
    // A 4-line unchanged gap is <= 2*context, so both runs stay in ONE hunk.
    const r = hunkRange(
      computeFileReview(lines(12), lines(12).replace('l4', 'A').replace('l9', 'B')).hunks[0],
    );
    expect(r.new).toEqual([4, 9]);
    expect(r.old).toEqual([4, 9]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/hunk-patch.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/hunk-patch"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/hunk-patch.ts`:

```ts
import type { ReviewHunk } from './review-hunks';

/**
 * Unified-diff surgery for hunk-level stage / unstage / discard
 * (spec 2026-08-27-review-supercharge §2 Lane E).
 *
 * BYTE-FAITHFUL BY CONSTRUCTION. The input is git's own `git diff` stdout and the output is fed
 * straight back to `git apply`, so `\r` is CONTENT: the only separator this module knows is
 * `\n`, nothing is trimmed, and `\ No newline at end of file` rides along inside its hunk. That
 * is the whole reason patches are built here from git's bytes rather than re-rendered from the
 * renderer's LF-normalised text (§0 "a renderer-built patch can never be byte-correct").
 *
 * Node-free: the renderer imports HunkRange and hunkRange; the host imports selectHunks.
 */

/**
 * A line range on both sides of a diff, 1-based inclusive. `end < start` marks an EMPTY span,
 * with `start` naming the position it sits at — a pure deletion has no new-side lines, a pure
 * insertion no old-side ones, and a tuple has no other way to say so.
 */
export interface HunkRange {
  new: [number, number];
  old: [number, number];
}

export interface DiffHunk {
  /** The `@@ …` line verbatim, section heading included. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Header + body, each line followed by `\n`. Concatenating these after `ParsedDiff.header`
   *  reproduces the input exactly. */
  text: string;
  /** Span of the `+` lines. Empty for a pure deletion. */
  changedNew: [number, number];
  /** Span of the `-` lines. Empty for a pure insertion. */
  changedOld: [number, number];
}

export interface ParsedDiff {
  /** Everything before the first `@@`: `diff --git`, mode/index/rename lines, `---`, `+++`. */
  header: string;
  hunks: DiffHunk[];
  /** git refused to diff the contents; nothing here is selectable. */
  binary: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const emptyAt = (n: number): [number, number] => [n, n - 1];

const extend = (span: [number, number], line: number): [number, number] =>
  span[1] < span[0] ? [line, line] : [Math.min(span[0], line), Math.max(span[1], line)];

/** Lines of `text`, with the artefact of a trailing `\n` dropped. `\r` is left on every line. */
function rawLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = rawLines(text);
  const headerLines: string[] = [];
  const hunks: DiffHunk[] = [];
  let binary = false;
  let i = 0;

  for (; i < lines.length && !HUNK_HEADER.test(lines[i]); i++) {
    const l = lines[i];
    if (l.startsWith('Binary files ') || l.startsWith('GIT binary patch')) binary = true;
    headerLines.push(l);
  }

  while (i < lines.length) {
    const m = HUNK_HEADER.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const header = lines[i];
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    i++;

    const body: string[] = [];
    for (; i < lines.length && !HUNK_HEADER.test(lines[i]); i++) body.push(lines[i]);

    let oldLine = oldStart;
    let newLine = newStart;
    let changedOld = emptyAt(oldStart);
    let changedNew = emptyAt(newStart);
    for (const l of body) {
      // "\ No newline at end of file" annotates the PREVIOUS line; it is not content.
      if (l.startsWith('\\')) continue;
      const c = l.charAt(0);
      if (c === '+') {
        changedNew = extend(changedNew, newLine);
        newLine++;
      } else if (c === '-') {
        changedOld = extend(changedOld, oldLine);
        oldLine++;
      } else {
        oldLine++;
        newLine++;
      }
    }

    hunks.push({
      header,
      oldStart,
      oldCount,
      newStart,
      newCount,
      text: [header, ...body].map((l) => `${l}\n`).join(''),
      changedNew,
      changedOld,
    });
  }

  return {
    header: headerLines.map((l) => `${l}\n`).join(''),
    hunks,
    binary,
  };
}

/** True when both spans are non-empty and share at least one line. */
export function spansOverlap(a: [number, number], b: [number, number]): boolean {
  if (a[1] < a[0] || b[1] < b[0]) return false;
  return a[0] <= b[1] && a[1] >= b[0];
}

/**
 * Match on the CHANGED lines, never the `@@` header span: the header covers up to 3 context
 * lines a side, so header matching would select a hunk a range merely brushes past. Either side
 * may carry the match — a pure-deletion hunk has no new-side lines at all, and a pure insertion
 * no old-side ones (see §12 assumptions 4 and 5 of the Lane E plan).
 */
export function selectsHunk(hunk: DiffHunk, range: HunkRange): boolean {
  return (
    spansOverlap(hunk.changedNew, range.new) || spansOverlap(hunk.changedOld, range.old)
  );
}

/**
 * The sub-patch of `diffText` covering `range`: the original file header verbatim plus every
 * hunk the range touches, in file order. Empty string when nothing matches (including a binary
 * diff) — the caller reports that as `no-hunk` rather than running an empty apply.
 */
export function selectHunks(diffText: string, range: HunkRange): string {
  const parsed = parseUnifiedDiff(diffText);
  if (parsed.binary) return '';
  const picked = parsed.hunks.filter((h) => selectsHunk(h, range));
  if (picked.length === 0) return '';
  return `${parsed.header}${picked.map((h) => h.text).join('')}`;
}

/** The line range one Review hunk covers. A hunk can hold several change runs separated by a
 *  short unchanged gap (computeFileReview keeps gaps of up to 2*context inside one hunk), and
 *  the header's Stage button acts on the hunk the user sees — so the span covers them all. */
export function hunkRange(hunk: ReviewHunk): HunkRange {
  let changedNew: [number, number] = emptyAt(hunk.startNewLine);
  let changedOld: [number, number] = emptyAt(hunk.startOldLine ?? 1);
  let lastOld = (hunk.startOldLine ?? 1) - 1;
  let sawAdd = false;
  let sawDel = false;

  for (const l of hunk.lines) {
    if (l.oldLine !== null) lastOld = l.oldLine;
    if (l.kind === 'add' && l.newLine !== null) {
      changedNew = extend(changedNew, l.newLine);
      sawAdd = true;
    } else if (l.kind === 'del' && l.oldLine !== null) {
      changedOld = extend(changedOld, l.oldLine);
      sawDel = true;
    }
  }

  return {
    new: sawAdd ? changedNew : emptyAt(hunk.startNewLine),
    // An insertion sits AFTER the last old line before it; anchoring the empty span there is
    // what lets a caller point at the seam rather than at line 1.
    old: sawDel ? changedOld : emptyAt(lastOld + 1),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/hunk-patch.test.ts`
Expected: PASS — 26 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: both projects exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/hunk-patch.ts test/unit/hunk-patch.test.ts
git commit -m "feat(git): add byte-faithful unified-diff hunk selection"
```

---

## Task 2: Prove the patches against real git (`git apply --check`)

**Files:**
- Create: `test/unit/hunk-patch-integration.test.ts`

**Interfaces:**
- Consumes: `selectHunks`, `hunkRange` (Task 1); `computeFileReview` (`src/review-hunks.ts`).
- Produces: nothing.

A parser that produces plausible-looking output is worthless; the contract is that **git accepts it**. This drives a real `git diff -U3` on a throwaway repo through `selectHunks` and hands the result to `git apply --check` and `git apply --cached --check`, over the three fixtures §4 names (LF, CRLF, no-EOF-newline) plus the two-hunk selection case. It mirrors `test/unit/git-actions-integration.test.ts`'s skip-if-no-git shape and never touches the project repo.

- [ ] **Step 1: Write the test**

Create `test/unit/hunk-patch-integration.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hunkRange, selectHunks } from '../../src/hunk-patch';
import { computeFileReview } from '../../src/review-hunks';

/**
 * The real contract for src/hunk-patch.ts: whatever it emits, `git apply` must take. Everything
 * here runs against a throwaway repo in the OS temp dir — never the project repo.
 */

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const d = hasGit() ? describe : describe.skip;

d('hunk-patch against real git', () => {
  let root: string;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

  /** git's own index→worktree diff for one path, canonicalised the way the host asks for it. */
  const diffFor = (rel: string, cached = false) =>
    git(
      'diff',
      ...(cached ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U3',
      '--',
      rel,
    );

  /** Feed a patch to `git apply <extra> --check`; returns null on success, stderr on rejection. */
  const applyCheck = (patch: string, extra: string[] = []): string | null => {
    try {
      execFileSync('git', ['apply', ...extra, '--whitespace=nowarn', '--check'], {
        cwd: root,
        input: patch,
        encoding: 'utf8',
      });
      return null;
    } catch (e) {
      return String((e as { stderr?: string }).stderr ?? e);
    }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-hunkpatch-'));
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    run(['init']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    run(['config', 'commit.gpgsign', 'false']);
    run(['config', 'core.autocrlf', 'false']);
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  const commit = (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files))
      fs.writeFileSync(path.join(root, name), content);
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  };

  const numbered = (n: number, f: (i: number) => string, eol = '\n') =>
    Array.from({ length: n }, (_, i) => f(i + 1)).join(eol) + eol;

  it('selects exactly one of two hunks and git accepts it for the index', () => {
    commit({ 'two.txt': numbered(30, (i) => `l${i}`) });
    const before = numbered(30, (i) => `l${i}`).split('\n');
    before[2] = 'CHANGED-A'; // new line 3
    before[24] = 'CHANGED-B'; // new line 25
    fs.writeFileSync(path.join(root, 'two.txt'), before.join('\n'));

    const raw = diffFor('two.txt');
    expect(raw.match(/^@@ /gm)).toHaveLength(2);

    const patch = selectHunks(raw, { new: [25, 25], old: [25, 25] });
    expect(patch.match(/^@@ /gm)).toHaveLength(1);
    expect(patch).toContain('CHANGED-B');
    expect(patch).not.toContain('CHANGED-A');
    expect(applyCheck(patch, ['--cached'])).toBeNull();
  });

  it('accepts a range derived from computeFileReview via hunkRange', () => {
    const head = numbered(20, (i) => `l${i}`);
    commit({ 'derived.txt': head });
    const work = head.replace('l7\n', 'SEVEN\n');
    fs.writeFileSync(path.join(root, 'derived.txt'), work);

    const review = computeFileReview(head, work);
    const patch = selectHunks(diffFor('derived.txt'), hunkRange(review.hunks[0]));
    expect(patch).toContain('SEVEN');
    expect(applyCheck(patch, ['--cached'])).toBeNull();
  });

  it('round-trips a CRLF file for both the index and a reverse worktree apply', () => {
    const head = numbered(12, (i) => `c${i}`, '\r\n');
    commit({ 'crlf.txt': head });
    fs.writeFileSync(path.join(root, 'crlf.txt'), head.replace('c6\r\n', 'CRLF-CHANGED\r\n'));

    const patch = selectHunks(diffFor('crlf.txt'), { new: [6, 6], old: [6, 6] });
    expect(patch).toContain('+CRLF-CHANGED\r\n');
    expect(applyCheck(patch, ['--cached'])).toBeNull();
    expect(applyCheck(patch, ['--reverse'])).toBeNull();
  });

  it('round-trips a file with no newline at EOF', () => {
    commit({ 'noeof.txt': 'alpha\nbeta\ngamma' });
    fs.writeFileSync(path.join(root, 'noeof.txt'), 'alpha\nbeta\nGAMMA');

    const raw = diffFor('noeof.txt');
    expect(raw).toContain('\\ No newline at end of file');
    const patch = selectHunks(raw, { new: [3, 3], old: [3, 3] });
    expect(patch).toContain('\\ No newline at end of file');
    expect(applyCheck(patch, ['--cached'])).toBeNull();
    expect(applyCheck(patch, ['--reverse'])).toBeNull();
  });

  it('selects a pure deletion by its old-side span', () => {
    commit({ 'del.txt': numbered(15, (i) => `d${i}`) });
    const kept = numbered(15, (i) => `d${i}`)
      .split('\n')
      .filter((l) => l !== 'd8' && l !== 'd9')
      .join('\n');
    fs.writeFileSync(path.join(root, 'del.txt'), kept);

    // Deletion of old 8-9; nothing on the new side, so the empty span sits at new line 8.
    const patch = selectHunks(diffFor('del.txt'), { new: [8, 7], old: [8, 9] });
    expect(patch).toContain('-d8');
    expect(patch).toContain('-d9');
    expect(applyCheck(patch, ['--cached'])).toBeNull();
  });

  it('a patch built before the file moved is REJECTED, not half-applied', () => {
    commit({ 'race.txt': numbered(20, (i) => `r${i}`) });
    fs.writeFileSync(path.join(root, 'race.txt'), numbered(20, (i) => `r${i}`).replace('r10', 'TEN'));
    const patch = selectHunks(diffFor('race.txt'), { new: [10, 10], old: [10, 10] });
    // The file changes underneath: every context line around the hunk is gone.
    fs.writeFileSync(path.join(root, 'race.txt'), 'totally different content\n');
    expect(applyCheck(patch, ['--cached'])).not.toBeNull();
  });

  it('reads git HEAD→index hunks for an unstage and reverses them cleanly', () => {
    const head = numbered(16, (i) => `u${i}`);
    commit({ 'staged.txt': head });
    fs.writeFileSync(path.join(root, 'staged.txt'), head.replace('u4', 'STAGED-FOUR'));
    execFileSync('git', ['add', 'staged.txt'], { cwd: root, stdio: 'ignore' });

    const patch = selectHunks(diffFor('staged.txt', true), { new: [4, 4], old: [4, 4] });
    expect(patch).toContain('+STAGED-FOUR');
    expect(applyCheck(patch, ['--cached', '--reverse'])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/unit/hunk-patch-integration.test.ts`
Expected: PASS — 7 tests (or the whole block SKIPPED where git is unavailable).

If a case fails, the defect is in Task 1, not here. **Do not relax an assertion to make it pass** — `git apply --check` accepting the output is the entire point of this lane's host-side design.

- [ ] **Step 3: Commit**

```bash
git add test/unit/hunk-patch-integration.test.ts
git commit -m "test(git): prove selected hunks pass git apply --check on real repos"
```

---

## Task 3: Host ops — `stageHunk` / `unstageHunk` / `discardHunk`

**Files:**
- Modify: `src/git-actions.ts` (the `GitOp` union `:22-30`, `GitActionRequest` `:32-37`, `GitActionPlan` `:41-45`, `planGitAction` `:92`, `gitExec` `:135`, `executeGitAction` `:150`)
- Test: `test/unit/git-actions-hunks.test.ts` (new), `test/unit/git-actions-integration.test.ts` (extend)

**Interfaces:**
- Consumes: `selectHunks`, `HunkRange` (Task 1); `runGit`, `GIT_TIMEOUT` (`src/git-exec.ts`).
- Produces:
  - `export type HunkOp = 'stageHunk' | 'unstageHunk' | 'discardHunk'`
  - `GitOp` gains those three members.
  - `GitActionRequest` gains `range?: HunkRange`.
  - `GitActionPlan` gains `stdin?: string` on the `git` variant and a new `{ kind: 'hunk'; op: HunkOp; diffArgs: string[]; applyArgs: string[]; range: HunkRange }` variant.
  - `GitActionResult` gains an optional `message`.
  - `export function buildHunkPlan(op: HunkOp, relPath: string): { diffArgs: string[]; applyArgs: string[] }`

Containment is unchanged: hunk ops go through the same `isInsideRoot` gate as the per-file ops, so a `..` escape is rejected before git runs. The range needs no validation — it is only ever compared against numbers the host read out of git's own output.

- [ ] **Step 1: Write the failing planner test**

Create `test/unit/git-actions-hunks.test.ts`:

```ts
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHunkPlan, type GitActionPlan, planGitAction } from '../../src/git-actions';
import type { HunkRange } from '../../src/hunk-patch';

const ROOT = path.resolve('/work/repo');
const RANGE: HunkRange = { new: [10, 12], old: [10, 11] };

const plan = (op: 'stageHunk' | 'unstageHunk' | 'discardHunk', p = 'src/a.ts'): GitActionPlan =>
  planGitAction({ root: ROOT, op, path: p, range: RANGE });

describe('buildHunkPlan', () => {
  it('reads index-to-worktree for a stage and applies to the index', () => {
    expect(buildHunkPlan('stageHunk', 'src/a.ts')).toEqual({
      diffArgs: [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '-U3',
        '--',
        'src/a.ts',
      ],
      applyArgs: ['apply', '--cached', '--whitespace=nowarn'],
    });
  });

  it('reads HEAD-to-index for an unstage and reverses it in the index', () => {
    const { diffArgs, applyArgs } = buildHunkPlan('unstageHunk', 'src/a.ts');
    expect(diffArgs).toContain('--cached');
    expect(diffArgs.slice(-2)).toEqual(['--', 'src/a.ts']);
    expect(applyArgs).toEqual(['apply', '--cached', '--reverse', '--whitespace=nowarn']);
  });

  it('reads index-to-worktree for a discard and reverses it in the WORKTREE', () => {
    const { diffArgs, applyArgs } = buildHunkPlan('discardHunk', 'src/a.ts');
    expect(diffArgs).not.toContain('--cached');
    expect(applyArgs).toEqual(['apply', '--reverse', '--whitespace=nowarn']);
  });

  it('never passes a path or a dash to git apply — the patch arrives on stdin', () => {
    for (const op of ['stageHunk', 'unstageHunk', 'discardHunk'] as const) {
      expect(buildHunkPlan(op, 'src/a.ts').applyArgs).not.toContain('src/a.ts');
      expect(buildHunkPlan(op, 'src/a.ts').applyArgs).not.toContain('-');
    }
  });

  it('puts the pathspec after -- so a leading dash cannot be read as an option', () => {
    const { diffArgs } = buildHunkPlan('stageHunk', '--evil.ts');
    expect(diffArgs[diffArgs.length - 2]).toBe('--');
    expect(diffArgs[diffArgs.length - 1]).toBe('--evil.ts');
  });
});

describe('planGitAction for hunk ops', () => {
  it('yields a hunk plan carrying both arg arrays and the range', () => {
    expect(plan('stageHunk')).toEqual({
      kind: 'hunk',
      op: 'stageHunk',
      ...buildHunkPlan('stageHunk', 'src/a.ts'),
      range: RANGE,
    });
  });

  it('normalises a windows-style relative path to a posix pathspec', () => {
    const p = plan('stageHunk', 'src\\nested\\a.ts');
    expect(p.kind === 'hunk' && p.diffArgs[p.diffArgs.length - 1]).toBe('src/nested/a.ts');
  });

  it('accepts an absolute path inside the root', () => {
    const p = plan('discardHunk', path.join(ROOT, 'src', 'a.ts'));
    expect(p.kind === 'hunk' && p.diffArgs[p.diffArgs.length - 1]).toBe('src/a.ts');
  });

  it('rejects a path that escapes the root', () => {
    expect(plan('stageHunk', '../../etc/passwd')).toEqual({
      kind: 'reject',
      error: 'Refusing to act outside the repository: ../../etc/passwd',
    });
  });

  it('rejects a missing path', () => {
    expect(planGitAction({ root: ROOT, op: 'stageHunk', range: RANGE })).toEqual({
      kind: 'reject',
      error: 'No file path provided.',
    });
  });

  it('rejects a missing range — a hunk op without one would stage the whole file', () => {
    expect(planGitAction({ root: ROOT, op: 'stageHunk', path: 'src/a.ts' })).toEqual({
      kind: 'reject',
      error: 'No hunk range provided.',
    });
  });

  it('rejects a range that is empty on both sides', () => {
    expect(
      planGitAction({
        root: ROOT,
        op: 'stageHunk',
        path: 'src/a.ts',
        range: { new: [5, 4], old: [5, 4] },
      }),
    ).toEqual({ kind: 'reject', error: 'No hunk range provided.' });
  });

  it('leaves the existing per-file ops exactly as they were', () => {
    expect(planGitAction({ root: ROOT, op: 'stageFile', path: 'src/a.ts' })).toEqual({
      kind: 'git',
      args: ['add', '--', 'src/a.ts'],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/git-actions-hunks.test.ts`
Expected: FAIL — `buildHunkPlan` is not exported.

- [ ] **Step 3: Extend the types**

In `src/git-actions.ts`, widen the existing `git-exec` import and add one:

```ts
import { GIT_TIMEOUT, runGit } from './git-exec';
import { type HunkRange, selectHunks } from './hunk-patch';
```

Replace the `GitOp` union (`:22-30`) with:

```ts
/** Hunk-scoped ops. The host builds their patch from git's own diff — see
 *  spec 2026-08-27-review-supercharge §2 Lane E and src/hunk-patch.ts. */
export type HunkOp = 'stageHunk' | 'unstageHunk' | 'discardHunk';

export type GitOp =
  | 'stageFile'
  | 'unstageFile'
  | 'discardTracked'
  | 'discardUntracked'
  | 'stageAll'
  | 'unstageAll'
  | 'stashPush'
  | 'stashPop'
  | HunkOp;
```

Add `range` to `GitActionRequest` (keep the existing field order; only this member is new):

```ts
  /** Hunk ops only: the line range the user pointed at. Untrusted, and it never needs to be
   *  trusted — it is only ever compared against numbers read out of git's own diff. */
  range?: HunkRange;
```

Replace `GitActionResult` and `GitActionPlan`:

```ts
/** `error` is human-readable text for the file/bulk ops and a stable CODE for the hunk ops
 *  (`no-hunk`, `apply-failed`), which the renderer maps to the spec's copy; `message` carries
 *  git's own stderr for the failure detail. */
export type GitActionResult = { ok: true } | { ok: false; error: string; message?: string };

/** A validated plan the executor can run without further checks. */
export type GitActionPlan =
  | { kind: 'git'; args: string[]; stdin?: string }
  | { kind: 'hunk'; op: HunkOp; diffArgs: string[]; applyArgs: string[]; range: HunkRange }
  | { kind: 'delete'; absPath: string }
  | { kind: 'reject'; error: string };

const HUNK_OPS = new Set<GitOp>(['stageHunk', 'unstageHunk', 'discardHunk']);
```

- [ ] **Step 4: Build the hunk plan**

Add above `planGitAction`:

```ts
/**
 * The two git invocations a hunk op needs. The diff is pinned to a canonical shape because a
 * user's `diff.external`, `color.diff = always` or `diff.noPrefix` would otherwise produce
 * output `git apply -p1` cannot read. `git apply` gets NO path argument: it reads the patch
 * from stdin, and `-` would be taken as a filename.
 */
export function buildHunkPlan(
  op: HunkOp,
  relPath: string,
): { diffArgs: string[]; applyArgs: string[] } {
  return {
    diffArgs: [
      'diff',
      ...(op === 'unstageHunk' ? ['--cached'] : []),
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U3',
      '--',
      relPath,
    ],
    applyArgs: [
      'apply',
      // stage/unstage rewrite the INDEX; discard reverts the WORKTREE to the index.
      ...(op === 'discardHunk' ? [] : ['--cached']),
      ...(op === 'stageHunk' ? [] : ['--reverse']),
      '--whitespace=nowarn',
    ],
  };
}

const emptyRange = (r: HunkRange | undefined): boolean =>
  !r || (r.new[1] < r.new[0] && r.old[1] < r.old[0]);
```

- [ ] **Step 5: Route hunk ops through `planGitAction`**

In `planGitAction`, immediately before the `if (PER_FILE_OPS.has(op))` block:

```ts
  if (HUNK_OPS.has(op)) {
    if (!rawPath) return { kind: 'reject', error: 'No file path provided.' };
    if (emptyRange(req.range)) return { kind: 'reject', error: 'No hunk range provided.' };
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
    if (!isInsideRoot(abs, root)) {
      return { kind: 'reject', error: `Refusing to act outside the repository: ${rawPath}` };
    }
    const hunkOp = op as HunkOp;
    return {
      kind: 'hunk',
      op: hunkOp,
      ...buildHunkPlan(hunkOp, toRelPathspec(rawPath, root)),
      // Non-null: emptyRange() already rejected the undefined case.
      range: req.range as HunkRange,
    };
  }
```

- [ ] **Step 6: Teach the executor to run one**

Change `gitExec` (`:135`) to take a plan (so `stdin` travels with the args), and add the hunk runner beside it:

```ts
async function gitExec(plan: { args: string[]; stdin?: string }, cwd: string): Promise<void> {
  const r = await runGit(plan.args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
  });
  if (!r.ok) {
    throw new Error(
      r.stderr.trim() || (r.notFound ? 'git not found' : `git exited with code ${r.code}`),
    );
  }
}

/**
 * Read git's own diff for one path, keep the hunks the range touches, hand the result back to
 * git on stdin. Two invocations, atomic in the one that matters: `git apply` takes the whole
 * patch or none of it, which is what makes "the file moved under the diff" a clean failure
 * rather than a half-applied file (spec 2026-08-27-review-supercharge §2 Lane E, §4).
 */
async function runHunkPlan(
  plan: Extract<GitActionPlan, { kind: 'hunk' }>,
  root: string,
): Promise<GitActionResult> {
  const diff = await runGit(plan.diffArgs, {
    cwd: root,
    timeoutMs: GIT_TIMEOUT.diff,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!diff.ok) {
    return {
      ok: false,
      error: 'apply-failed',
      message: diff.stderr.trim() || `git diff exited with code ${diff.code}`,
    };
  }
  const patch = selectHunks(diff.stdout, plan.range);
  if (!patch) return { ok: false, error: 'no-hunk' };
  try {
    await gitExec({ args: plan.applyArgs, stdin: patch }, root);
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: 'apply-failed', message: e instanceof Error ? e.message : String(e) };
  }
}
```

Inside `executeGitAction`, before the `if (plan.kind === 'git')` branch:

```ts
    if (plan.kind === 'hunk') return await runHunkPlan(plan, req.root);
```

and change the existing call `await gitExec(plan.args, req.root);` to `await gitExec(plan, req.root);`.

- [ ] **Step 7: Run the planner tests**

Run: `npx vitest run test/unit/git-actions-hunks.test.ts test/unit/git-actions.test.ts`
Expected: PASS — the new file plus the existing planner suite unchanged.

- [ ] **Step 8: Extend the real-repo integration test**

Append to `test/unit/git-actions-integration.test.ts`, inside the existing `d(...)` block:

```ts
  const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
  const cachedDiff = () =>
    execFileSync('git', ['diff', '--cached', '-U3'], { cwd: root, encoding: 'utf8' });

  /** 30 numbered lines, with the given 1-based lines replaced. */
  const numbered = (edits: Record<number, string>) =>
    `${Array.from({ length: 30 }, (_, i) => edits[i + 1] ?? `l${i + 1}`).join('\n')}\n`;

  /** A committed 30-line file with two separated edits in the worktree. */
  const seedTwoHunks = () => {
    fs.writeFileSync(path.join(root, 'two.txt'), numbered({}));
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'two'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'two.txt'), numbered({ 3: 'HUNK-A', 25: 'HUNK-B' }));
  };

  it('stages ONE of two hunks — git diff --cached holds exactly it', async () => {
    seedTwoHunks();
    const res = await executeGitAction({
      root,
      op: 'stageHunk',
      path: 'two.txt',
      range: { new: [25, 25], old: [25, 25] },
    });
    expect(res).toEqual({ ok: true });
    const staged = cachedDiff();
    expect(staged).toContain('HUNK-B');
    expect(staged).not.toContain('HUNK-A');
    // Staging moved nothing on disk — the worktree still carries both.
    expect(read('two.txt')).toContain('HUNK-A');
    expect(read('two.txt')).toContain('HUNK-B');
  });

  it('unstages one hunk back out of the index', async () => {
    seedTwoHunks();
    execFileSync('git', ['add', 'two.txt'], { cwd: root, stdio: 'ignore' });
    expect(cachedDiff()).toContain('HUNK-A');
    const res = await executeGitAction({
      root,
      op: 'unstageHunk',
      path: 'two.txt',
      range: { new: [3, 3], old: [3, 3] },
    });
    expect(res).toEqual({ ok: true });
    const staged = cachedDiff();
    expect(staged).not.toContain('HUNK-A');
    expect(staged).toContain('HUNK-B');
  });

  it('discards one hunk — the worktree returns to the index there and keeps the rest', async () => {
    seedTwoHunks();
    const res = await executeGitAction({
      root,
      op: 'discardHunk',
      path: 'two.txt',
      range: { new: [3, 3], old: [3, 3] },
    });
    expect(res).toEqual({ ok: true });
    expect(read('two.txt')).not.toContain('HUNK-A');
    expect(read('two.txt')).toContain('l3');
    expect(read('two.txt')).toContain('HUNK-B');
  });

  it('reports no-hunk when the range matches nothing, and stages nothing', async () => {
    seedTwoHunks();
    const res = await executeGitAction({
      root,
      op: 'stageHunk',
      path: 'two.txt',
      range: { new: [900, 910], old: [900, 910] },
    });
    expect(res).toEqual({ ok: false, error: 'no-hunk' });
    expect(cachedDiff()).toBe('');
  });

  it('changes nothing when the file moved under the range', async () => {
    seedTwoHunks();
    // The diff the renderer is holding describes a file that no longer exists on disk.
    fs.writeFileSync(path.join(root, 'two.txt'), 'entirely different content\n');
    const res = await executeGitAction({
      root,
      op: 'stageHunk',
      path: 'two.txt',
      range: { new: [3, 3], old: [3, 3] },
    });
    expect(res.ok).toBe(false);
    expect(cachedDiff()).toBe('');
    expect(read('two.txt')).toBe('entirely different content\n');
  });

  it('refuses a hunk op whose path escapes the root', async () => {
    const res = await executeGitAction({
      root,
      op: 'stageHunk',
      path: '../escape.txt',
      range: { new: [1, 1], old: [1, 1] },
    });
    expect(res.ok).toBe(false);
    expect(cachedDiff()).toBe('');
  });
```

> **Why the "file moved" case only asserts `res.ok === false`.** Rewriting the file wholesale
> makes git's *new* diff carry no hunk at line 3 at all, so the host stops at `no-hunk` before it
> ever runs `apply` — a stronger guarantee than a rejected apply, but a different code. The
> `apply-failed` path (a hunk still there, its context drifted) is covered by Task 2's
> `git apply --check` rejection case and by the e2e in Task 12; pinning a code here would make the
> test brittle against git's own hunk-splitting.

- [ ] **Step 9: Run the integration suite**

Run: `npx vitest run test/unit/git-actions-integration.test.ts`
Expected: PASS — the existing cases plus 6 new ones.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: both projects exit 0. `electron/preload.ts` and `webview/bridge.ts` pass `GitActionRequest` / `GitActionResult` through by type only, so the widened shapes need no edit there; `electron/main.ts`'s `git-action` handler is likewise unchanged (it validates the root and delegates).

- [ ] **Step 11: Commit**

```bash
git add src/git-actions.ts test/unit/git-actions-hunks.test.ts test/unit/git-actions-integration.test.ts
git commit -m "feat(git): add hunk-level stage, unstage and discard ops"
```

---

## Task 4: The renderer's hunk-action module (`webview/hunk-actions.ts`)

**Files:**
- Create: `webview/hunk-actions.ts`
- Test: `test/unit/hunk-actions.test.ts`

**Interfaces:**
- Consumes: `GitActionRequest`, `GitActionResult`, `HunkOp` (`src/git-actions.ts`); `HunkRange` (`src/hunk-patch.ts`); `ConfirmState` (`webview/components/confirm-dialog.tsx`, **type-only**).
- Produces:
  - `export type ReviewScope = 'all' | 'staged' | 'unstaged'`
  - `export type HunkButtonMode = 'stage' | 'unstage' | 'blocked'`
  - `export function hunkButtonMode(scope: ReviewScope, hasStagedSide: boolean): HunkButtonMode`
  - `export const BLOCKED_TOOLTIP`, `CONFLICT_TOAST`, `UNTRACKED_DISCARD_TOOLTIP`, `STAGED_DISCARD_TOOLTIP`
  - `export function discardConfirm(relPath: string, lineCount: number): Omit<ConfirmState, 'onConfirm'>`
  - `export interface HunkActionHost`, `export interface HunkActionRequest`, `export type HunkOutcome`
  - `export async function applyHunkAction(deps: HunkActionDeps, req: HunkActionRequest): Promise<HunkOutcome>`
  - `export function setHunkActionHost(host: HunkActionHost | null): () => void`
  - `export function getHunkActionHost(): HunkActionHost | null`
  - `export function subscribeHunkActionHost(cb: () => void): () => void`

Everything above the store is pure and injected, so the whole decision matrix — confirm, op mapping, failure codes, announcements, refresh — is unit-tested in node with no React, no jsdom and no Electron.

- [ ] **Step 1: Write the failing test**

Create `test/unit/hunk-actions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitActionRequest, GitActionResult } from '../../src/git-actions';
import {
  applyHunkAction,
  BLOCKED_TOOLTIP,
  CONFLICT_TOAST,
  discardConfirm,
  getHunkActionHost,
  type HunkActionHost,
  type HunkActionRequest,
  hunkButtonMode,
  setHunkActionHost,
  subscribeHunkActionHost,
} from '../../webview/hunk-actions';

describe('hunkButtonMode', () => {
  it('offers Stage under the Unstaged scope, always', () => {
    expect(hunkButtonMode('unstaged', false)).toBe('stage');
    expect(hunkButtonMode('unstaged', true)).toBe('stage');
  });

  it('offers Unstage under the Staged scope, always', () => {
    expect(hunkButtonMode('staged', false)).toBe('unstage');
    expect(hunkButtonMode('staged', true)).toBe('unstage');
  });

  it('offers Stage under All only while the file has no staged side', () => {
    expect(hunkButtonMode('all', false)).toBe('stage');
    expect(hunkButtonMode('all', true)).toBe('blocked');
  });

  it('names the scope to switch to when it blocks', () => {
    expect(BLOCKED_TOOLTIP).toBe('Switch to Unstaged scope to stage hunks');
  });
});

describe('discardConfirm', () => {
  it('quotes the line count, the path and the index as the target', () => {
    const c = discardConfirm('src/foo.ts', 12);
    expect(c.title).toBe('Discard this change?');
    expect(c.message).toBe(
      "12 lines in src/foo.ts will be reverted to the index. This can't be undone.",
    );
    expect(c.confirmLabel).toBe('Discard');
    expect(c.danger).toBe(true);
    // An accidental Enter must not discard work.
    expect(c.focusCancel).toBe(true);
  });

  it('says "1 line" for a one-line change', () => {
    expect(discardConfirm('a.ts', 1).message).toContain('1 line in a.ts');
  });
});

describe('the hunk-action host store', () => {
  beforeEach(() => setHunkActionHost(null));

  it('starts empty', () => {
    expect(getHunkActionHost()).toBeNull();
  });

  it('publishes a host and notifies subscribers', () => {
    const seen = vi.fn();
    const off = subscribeHunkActionHost(seen);
    const host = makeHost();
    setHunkActionHost(host);
    expect(getHunkActionHost()).toBe(host);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("a teardown only clears the host it published", () => {
    const first = makeHost();
    const clearFirst = setHunkActionHost(first);
    const second = makeHost();
    setHunkActionHost(second);
    clearFirst();
    expect(getHunkActionHost()).toBe(second);
  });
});

const REQ: HunkActionRequest = {
  op: 'stageHunk',
  absPath: '/repo/src/foo.ts',
  relPath: 'src/foo.ts',
  range: { new: [10, 12], old: [10, 11] },
  lineCount: 5,
  untracked: false,
};

function makeHost(over: Partial<HunkActionHost> = {}): HunkActionHost {
  return {
    root: '/repo',
    stagedPaths: new Set<string>(),
    confirmDiscard: async () => true,
    refreshChanges: () => {},
    invalidateDiff: () => {},
    ...over,
  };
}

function makeDeps(
  result: GitActionResult = { ok: true },
  hostOver: Partial<HunkActionHost> = {},
) {
  const calls: GitActionRequest[] = [];
  const toasts: { message: string; variant: string }[] = [];
  const announced: string[] = [];
  const host = makeHost(hostOver);
  return {
    calls,
    toasts,
    announced,
    host,
    deps: {
      host,
      gitAction: async (r: GitActionRequest) => {
        calls.push(r);
        return result;
      },
      toast: (t: { message: string; variant: 'error' | 'info' }) => {
        toasts.push(t);
      },
      announce: (t: string) => {
        announced.push(t);
      },
    },
  };
}

describe('applyHunkAction', () => {
  it('sends the op, the root, the repo-relative path and the range', async () => {
    const { deps, calls } = makeDeps();
    expect(await applyHunkAction(deps, REQ)).toEqual({ kind: 'done', op: 'stageHunk' });
    expect(calls).toEqual([
      { root: '/repo', op: 'stageHunk', path: 'src/foo.ts', range: REQ.range },
    ]);
  });

  it('announces, invalidates the cached diff and refreshes after a success', async () => {
    const invalidateDiff = vi.fn();
    const refreshChanges = vi.fn();
    const { deps, announced } = makeDeps({ ok: true }, { invalidateDiff, refreshChanges });
    await applyHunkAction(deps, REQ);
    expect(announced).toEqual(['Staged hunk']);
    expect(invalidateDiff).toHaveBeenCalledWith('/repo/src/foo.ts');
    expect(refreshChanges).toHaveBeenCalledTimes(1);
  });

  it('announces the right verb per op', async () => {
    for (const [op, said] of [
      ['unstageHunk', 'Unstaged hunk'],
      ['discardHunk', 'Discarded hunk'],
    ] as const) {
      const { deps, announced } = makeDeps();
      await applyHunkAction(deps, { ...REQ, op });
      expect(announced).toEqual([said]);
    }
  });

  it('does not confirm a stage or an unstage', async () => {
    const confirmDiscard = vi.fn(async () => true);
    const { deps } = makeDeps({ ok: true }, { confirmDiscard });
    await applyHunkAction(deps, REQ);
    await applyHunkAction(deps, { ...REQ, op: 'unstageHunk' });
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('confirms a discard with the spec copy and runs it on accept', async () => {
    const confirmDiscard = vi.fn(async () => true);
    const { deps, calls } = makeDeps({ ok: true }, { confirmDiscard });
    const out = await applyHunkAction(deps, { ...REQ, op: 'discardHunk', lineCount: 12 });
    expect(confirmDiscard).toHaveBeenCalledWith(discardConfirm('src/foo.ts', 12));
    expect(out).toEqual({ kind: 'done', op: 'discardHunk' });
    expect(calls).toHaveLength(1);
  });

  it('runs nothing when the discard is cancelled', async () => {
    const { deps, calls, toasts } = makeDeps({ ok: true }, { confirmDiscard: async () => false });
    expect(await applyHunkAction(deps, { ...REQ, op: 'discardHunk' })).toEqual({
      kind: 'cancelled',
    });
    expect(calls).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it('maps Stage on an untracked file onto the whole-file stageFile op', async () => {
    const { deps, calls } = makeDeps();
    await applyHunkAction(deps, { ...REQ, untracked: true });
    expect(calls).toEqual([{ root: '/repo', op: 'stageFile', path: 'src/foo.ts' }]);
  });

  it('refuses to discard a hunk of an untracked file — there is no index to revert to', async () => {
    const { deps, calls } = makeDeps();
    const out = await applyHunkAction(deps, { ...REQ, op: 'discardHunk', untracked: true });
    expect(out).toEqual({ kind: 'unsupported' });
    expect(calls).toEqual([]);
  });

  it('shows the conflict copy and reloads the card on apply-failed', async () => {
    const invalidateDiff = vi.fn();
    const refreshChanges = vi.fn();
    const { deps, toasts } = makeDeps(
      { ok: false, error: 'apply-failed', message: 'patch does not apply' },
      { invalidateDiff, refreshChanges },
    );
    expect(await applyHunkAction(deps, REQ)).toEqual({
      kind: 'failed',
      reason: 'apply-failed',
      message: 'patch does not apply',
    });
    expect(toasts).toEqual([{ message: CONFLICT_TOAST, variant: 'error' }]);
    expect(invalidateDiff).toHaveBeenCalledWith('/repo/src/foo.ts');
    expect(refreshChanges).toHaveBeenCalledTimes(1);
  });

  it('shows the same copy for no-hunk — the cause and the fix are identical', async () => {
    const { deps, toasts } = makeDeps({ ok: false, error: 'no-hunk' });
    expect(await applyHunkAction(deps, REQ)).toMatchObject({ kind: 'failed', reason: 'no-hunk' });
    expect(toasts).toEqual([{ message: CONFLICT_TOAST, variant: 'error' }]);
  });

  it('passes any other host error through verbatim', async () => {
    const { deps, toasts } = makeDeps({ ok: false, error: 'Unknown or untrusted repository root.' });
    expect(await applyHunkAction(deps, REQ)).toMatchObject({ kind: 'failed', reason: 'other' });
    expect(toasts).toEqual([
      { message: 'Git: Unknown or untrusted repository root.', variant: 'error' },
    ]);
  });

  it('does nothing without a host', async () => {
    const { deps, calls } = makeDeps();
    expect(await applyHunkAction({ ...deps, host: null }, REQ)).toEqual({ kind: 'noHost' });
    expect(calls).toEqual([]);
  });

  it('does nothing without a repo root', async () => {
    const { deps, calls } = makeDeps({ ok: true }, { root: '' });
    expect(await applyHunkAction(deps, REQ)).toEqual({ kind: 'noHost' });
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/hunk-actions.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/hunk-actions"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview/hunk-actions.ts`:

```ts
import type { GitActionRequest, GitActionResult, HunkOp } from '../src/git-actions';
import type { HunkRange } from '../src/hunk-patch';
import type { ConfirmState } from './components/confirm-dialog';

/**
 * Hunk-level stage / unstage / discard, renderer side
 * (spec 2026-08-27-review-supercharge §2 Lane E).
 *
 * One module for BOTH surfaces — the Review hunk header and the editor's change peek — because
 * the rule about which button is offered, the copy, and the after-op sequence are the same in
 * each, and a second copy of any of the three would drift. The app-level capabilities the
 * sequence needs (the repo root, the confirm dialog, the change refresh, the diff cache) arrive
 * through the store at the bottom rather than as props: the peek sits four prop hops from
 * app.tsx, and the existing onGitAction prop is fire-and-forget where these must be awaited.
 */

/** Review's working-source scope. Lane D owns the control; E only reads the value. */
export type ReviewScope = 'all' | 'staged' | 'unstaged';

export type HunkButtonMode = 'stage' | 'unstage' | 'blocked';

export const BLOCKED_TOOLTIP = 'Switch to Unstaged scope to stage hunks';
export const CONFLICT_TOAST = 'The file changed since this diff was loaded — refreshed.';
export const UNTRACKED_DISCARD_TOOLTIP =
  'A new file has no previous version — discard it from the Changes panel';
export const STAGED_DISCARD_TOOLTIP = 'Switch to Unstaged scope to discard hunks';

/**
 * Stage and Discard act on the index→worktree hunks. Under Unstaged the displayed ranges map
 * onto those 1:1; under All they do only while the file has no staged side. This is the whole
 * reason Lane D lands before Lane E (§2 Lane E "Baseline rule").
 */
export function hunkButtonMode(scope: ReviewScope, hasStagedSide: boolean): HunkButtonMode {
  if (scope === 'staged') return 'unstage';
  if (scope === 'unstaged') return 'stage';
  return hasStagedSide ? 'blocked' : 'stage';
}

export function discardConfirm(
  relPath: string,
  lineCount: number,
): Omit<ConfirmState, 'onConfirm'> {
  return {
    title: 'Discard this change?',
    message: `${lineCount} line${lineCount === 1 ? '' : 's'} in ${relPath} will be reverted to the index. This can't be undone.`,
    confirmLabel: 'Discard',
    danger: true,
    focusCancel: true,
  };
}

/** App-level capabilities one hunk op needs, published by app.tsx. */
export interface HunkActionHost {
  /** Active repo root; '' when there is no repo (every op is then a no-op). */
  root: string;
  /** Repo-relative posix paths that currently have a STAGED side (ChangeDTO.staged). */
  stagedPaths: ReadonlySet<string>;
  /** Resolves false on Cancel or Esc. */
  confirmDiscard(state: Omit<ConfirmState, 'onConfirm'>): Promise<boolean>;
  refreshChanges(): void;
  /** Drop the cached working diff for an ABSOLUTE path so its Review card refetches. */
  invalidateDiff(absPath: string): void;
}

export interface HunkActionRequest {
  op: HunkOp;
  /** Absolute path — what the diff cache is keyed by. */
  absPath: string;
  /** Repo-relative posix path — what git and the confirm copy want. */
  relPath: string;
  range: HunkRange;
  /** Lines this op touches; the discard confirm quotes it. */
  lineCount: number;
  untracked: boolean;
}

export type HunkOutcome =
  | { kind: 'done'; op: HunkOp }
  | { kind: 'cancelled' }
  | { kind: 'unsupported' }
  | { kind: 'noHost' }
  | { kind: 'failed'; reason: 'no-hunk' | 'apply-failed' | 'other'; message?: string };

export interface HunkActionDeps {
  host: HunkActionHost | null;
  gitAction(req: GitActionRequest): Promise<GitActionResult>;
  toast(input: { message: string; variant: 'error' | 'info' }): void;
  announce(text: string): void;
}

const SAID: Record<HunkOp, string> = {
  stageHunk: 'Staged hunk',
  unstageHunk: 'Unstaged hunk',
  discardHunk: 'Discarded hunk',
};

export async function applyHunkAction(
  deps: HunkActionDeps,
  req: HunkActionRequest,
): Promise<HunkOutcome> {
  const { host } = deps;
  if (!host || !host.root) return { kind: 'noHost' };
  // An untracked file has no index entry, so `git apply --reverse` cannot express "put this
  // hunk back"; the whole-file discard in the Changes panel is the path (assumption 13).
  if (req.op === 'discardHunk' && req.untracked) return { kind: 'unsupported' };

  if (req.op === 'discardHunk') {
    const go = await host.confirmDiscard(discardConfirm(req.relPath, req.lineCount));
    if (!go) return { kind: 'cancelled' };
  }

  // §2 Lane E: "Untracked file: Stage = existing stageFile" — the whole file IS the hunk.
  const request: GitActionRequest =
    req.op === 'stageHunk' && req.untracked
      ? { root: host.root, op: 'stageFile', path: req.relPath }
      : { root: host.root, op: req.op, path: req.relPath, range: req.range };

  const res = await deps.gitAction(request);
  if (res.ok) {
    deps.announce(SAID[req.op]);
    host.invalidateDiff(req.absPath);
    host.refreshChanges();
    return { kind: 'done', op: req.op };
  }

  const stale = res.error === 'no-hunk' || res.error === 'apply-failed';
  deps.toast({ message: stale ? CONFLICT_TOAST : `Git: ${res.error}`, variant: 'error' });
  // Even a rejected apply can coincide with a real on-disk change, so the card reloads either
  // way — the spec's "toast + card reload", never a blind retry (§2 Lane E).
  host.invalidateDiff(req.absPath);
  host.refreshChanges();
  return {
    kind: 'failed',
    reason: res.error === 'no-hunk' ? 'no-hunk' : res.error === 'apply-failed' ? 'apply-failed' : 'other',
    ...(res.message === undefined ? {} : { message: res.message }),
  };
}

// --- The host store ---------------------------------------------------------------------
// Same shape as webview/change-nav-registry.ts: a module-scope slot app.tsx fills and the two
// consuming surfaces read through useSyncExternalStore.

let current: HunkActionHost | null = null;
const listeners = new Set<() => void>();

/** Publish `host`; the returned teardown is identity-checked so a later publisher wins. */
export function setHunkActionHost(host: HunkActionHost | null): () => void {
  current = host;
  for (const cb of listeners) cb();
  return () => {
    if (current === host) {
      current = null;
      for (const cb of listeners) cb();
    }
  };
}

export function getHunkActionHost(): HunkActionHost | null {
  return current;
}

export function subscribeHunkActionHost(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/hunk-actions.test.ts`
Expected: PASS — 22 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: both projects exit 0.

- [ ] **Step 6: Commit**

```bash
git add webview/hunk-actions.ts test/unit/hunk-actions.test.ts
git commit -m "feat(review): add the renderer hunk-action rule, copy and orchestration"
```

---

## Task 5: Publish the host from `app.tsx`

**Files:**
- Modify: `webview/app.tsx` — imports (beside `./toast-store`, `:121`); a ref beside `quitCancelRef` (`:194`); one effect beside `refreshChanges` (`:859-862`); the `ConfirmDialog` `onClose` wrapper (`:2747-2758`)

**Interfaces:**
- Consumes: `setHunkActionHost`, `HunkActionHost` (Task 4); the existing `active`, `projectData`, `gitRootForSession`, `refreshChanges`, `setDiffs`, `setConfirm`.
- Produces: a published `HunkActionHost` for as long as a session is active.

The confirm bridge mirrors the quit-guard's (`quitCancelRef`, W2) exactly: the dialog's own
`onClose` is the only place Cancel and Esc both land, so that is where the promise resolves false.

- [ ] **Step 1: Add the imports and the pending-resolver ref**

Beside the existing `./toast-store` import:

```ts
import { type HunkActionHost, setHunkActionHost } from './hunk-actions';
```

Beside `quitCancelRef` (`:194`):

```ts
  // Holds the resolver of an open hunk-discard confirm. Called with `false` by the ConfirmDialog
  // onClose wrapper so Cancel and Esc both settle the promise the caller is awaiting.
  const hunkConfirmRef = useRef<((ok: boolean) => void) | null>(null);
```

- [ ] **Step 2: Publish the host**

Immediately after `refreshChanges` (`:862`):

```ts
  // Hunk-level stage/unstage/discard reach app-level capabilities through a module store rather
  // than props — the editor's change peek is four prop hops away, and the ops must be awaited.
  // See webview/hunk-actions.ts and spec 2026-08-27-review-supercharge §2 Lane E.
  // biome-ignore lint/correctness/useExhaustiveDependencies: active is read via its fine-grained fields, as everywhere else in this file
  useEffect(() => {
    const host: HunkActionHost = {
      root: active ? gitRootForSession(active) : '',
      stagedPaths: new Set(
        (projectData?.changes ?? []).filter((c) => c.staged).map((c) => c.path),
      ),
      confirmDiscard: (state) =>
        new Promise<boolean>((resolve) => {
          hunkConfirmRef.current = resolve;
          setConfirm({
            ...state,
            onConfirm: () => {
              hunkConfirmRef.current = null;
              resolve(true);
            },
          });
        }),
      refreshChanges,
      invalidateDiff: (absPath) =>
        setDiffs((m) => {
          if (!m.has(absPath)) return m;
          const next = new Map(m);
          next.delete(absPath);
          return next;
        }),
    };
    return setHunkActionHost(host);
  }, [
    active?.projectPath,
    active?.cwd,
    active?.activeRepoRoot,
    projectData?.changes,
    refreshChanges,
  ]);
```

- [ ] **Step 3: Settle the promise on Cancel / Esc**

In the `ConfirmDialog` `onClose` wrapper (`:2747-2758`), beside the quit-guard reply:

```tsx
          onClose={() => {
            // W2: if a quit-confirm is open, reply cancel to the host before closing.
            const cancelFn = quitCancelRef.current;
            quitCancelRef.current = null;
            cancelFn?.();
            // A hunk discard was awaiting an answer; Cancel and Esc both arrive here.
            const hunkReply = hunkConfirmRef.current;
            hunkConfirmRef.current = null;
            hunkReply?.(false);
            setConfirm(null);
          }}
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add webview/app.tsx
git commit -m "feat(review): publish the hunk-action host from the app shell"
```

---

## Task 6: Stage / Unstage / Discard on the Review hunk header

**Files:**
- Modify: `webview/components/review-view.tsx` — imports; the `files` memo region (`:195-206`); `ReviewFileCard`'s props and its `HunkList` call (`:1061-1068`); `HunkList` (`:1076`); `Hunk` (`:1233-1268`)
- Modify: `webview/styles.css` — `.rhunk__jump` (`:9351-9363`), new `.rhunk__head` / `.rhunk__acts` / `.rhunk__act`

**Interfaces:**
- Consumes: `hunkButtonMode`, `applyHunkAction`, `getHunkActionHost`, `subscribeHunkActionHost`, `BLOCKED_TOOLTIP`, `STAGED_DISCARD_TOOLTIP`, `UNTRACKED_DISCARD_TOOLTIP`, `ReviewScope`, `HunkButtonMode` (Task 4); `hunkRange` (Task 1); `gitAction` (`webview/bridge.ts`); `pushToast` (`webview/toast-store.ts`).
- Produces: a `runHunkOp(op, hunk, change, abs)` callback threaded from `ReviewView` down to `Hunk`, and `mode` / `untracked` on `Hunk`.

The scope and the staged-side set come from Lane D's contract and nothing else: `source.scope`
(optional, defaulting to `'all'`) and `ChangeDTO.staged` off the `changes` prop already in hand.

- [ ] **Step 1: Add the imports**

```ts
import { gitAction } from '../bridge';
import { hunkRange } from '../../src/hunk-patch';
import {
  applyHunkAction,
  BLOCKED_TOOLTIP,
  getHunkActionHost,
  type HunkButtonMode,
  hunkButtonMode,
  type ReviewScope,
  STAGED_DISCARD_TOOLTIP,
  subscribeHunkActionHost,
  UNTRACKED_DISCARD_TOOLTIP,
} from '../hunk-actions';
import { pushToast } from '../toast-store';
```

and widen the existing React import with `useSyncExternalStore`.

- [ ] **Step 2: Derive the scope, the staged-side set and the op runner**

In `ReviewView`, immediately after the `files` memo (`:206`):

```ts
  // Lane D's contract, read optionally so this lane behaves correctly (the All-scope rule)
  // whether or not the scope control has shipped yet.
  const scope: ReviewScope = source?.kind === 'working' ? (source.scope ?? 'all') : 'all';
  // A path modified in BOTH the index and the worktree produces two ChangeDTOs (protocol.ts);
  // `files` dedupes them for rendering, so the staged side is read off the undeduped list.
  const stagedSide = useMemo(
    () => new Set(effectiveChanges.filter((c) => c.staged).map((c) => c.path)),
    [effectiveChanges],
  );
  // Hunk ops exist for the working source only — a commit or a comparison has nothing to stage.
  const hunkOpsAvailable = !preloaded;

  const hunkHost = useSyncExternalStore(
    subscribeHunkActionHost,
    getHunkActionHost,
    getHunkActionHost,
  );

  const runHunkOp = useCallback(
    async (op: 'stageHunk' | 'unstageHunk' | 'discardHunk', change: ChangeDTO, hunk: ReviewHunk) => {
      const abs = absOf(change.path);
      const lineCount = hunk.lines.filter((l) => l.kind !== 'context').length;
      const outcome = await applyHunkAction(
        { host: hunkHost, gitAction, toast: pushToast, announce: setAnnounce },
        {
          op,
          absPath: abs,
          relPath: change.path,
          range: hunkRange(hunk),
          lineCount,
          untracked: change.kind === 'U',
        },
      );
      // The card re-requests its diff: app.tsx dropped the cached entry, and clearing the
      // request-once guard is what lets the card's mount effect ask again (§2 Lane E "the card
      // re-requests its diff"). The reviewed mark prunes itself — Lane B keys it by content hash.
      if (outcome.kind === 'done' || outcome.kind === 'failed') requestedRef.current.delete(abs);
      if (outcome.kind === 'unsupported') setAnnounce(UNTRACKED_DISCARD_TOOLTIP);
    },
    [absOf, hunkHost],
  );
```

- [ ] **Step 3: Thread it to the card and the hunk**

`ReviewFileCard` gains three props — add them to the destructure, the type literal and the call site (`:700-716`):

```ts
  mode: HunkButtonMode;
  /** False for a commit or a comparison: there is nothing to stage. */
  hunkOpsAvailable: boolean;
  onHunkOp: (
    op: 'stageHunk' | 'unstageHunk' | 'discardHunk',
    change: ChangeDTO,
    hunk: ReviewHunk,
  ) => void;
```

passed from the card list as:

```tsx
                mode={hunkButtonMode(scope, stagedSide.has(change.path))}
                hunkOpsAvailable={hunkOpsAvailable}
                onHunkOp={runHunkOp}
```

`HunkList` forwards them unchanged, adding to its own props and to the `<Hunk …>` it renders:

```tsx
          hunkIndex={i}
          mode={mode}
          untracked={change.kind === 'U'}
          hunkOpsAvailable={hunkOpsAvailable}
          onHunkOp={(op) => onHunkOp(op, change, hunk)}
```

`HunkList` needs the `ChangeDTO` itself (for `change.kind` and for the `onHunkOp` closure), so
give it a `change: ChangeDTO` prop **beside** the `abs: string` it already takes — `abs` still
feeds `onJumpToHunk`, and the card computes both exactly as it does today.

- [ ] **Step 4: Rebuild the hunk header as a row**

Replace `Hunk`'s returned header (`:1252-1260`) with:

```tsx
    <div className="rhunk">
      <div className="rhunk__head">
        <button
          type="button"
          className="rhunk__jump"
          data-hunk={hunkIndex}
          title="Open this hunk in the editor"
          onClick={() => onJumpToHunk(abs, hunk.startNewLine)}
        >
          {formatHunkHeader(hunk)}
        </button>
        {hunkOpsAvailable && (
          <div className="rhunk__acts">
            {mode === 'unstage' ? (
              <button
                type="button"
                className="rhunk__act"
                title="Unstage this hunk (s)"
                onClick={() => onHunkOp('unstageHunk')}
              >
                Unstage
              </button>
            ) : (
              <button
                type="button"
                className="rhunk__act"
                disabled={mode === 'blocked'}
                title={mode === 'blocked' ? BLOCKED_TOOLTIP : 'Stage this hunk (s)'}
                onClick={() => onHunkOp('stageHunk')}
              >
                Stage
              </button>
            )}
            <button
              type="button"
              className="rhunk__act rhunk__act--danger"
              disabled={mode !== 'stage' || untracked}
              title={discardTitle(mode, untracked)}
              onClick={() => onHunkOp('discardHunk')}
            >
              Discard
            </button>
          </div>
        )}
      </div>
```

with, above the component:

```ts
/** Discard reverts the WORKTREE to the index, so it is only meaningful where the hunks on
 *  screen describe that diff: not under the Staged scope, and never for an untracked file
 *  (there is no index entry to revert to). */
function discardTitle(mode: HunkButtonMode, untracked: boolean): string {
  if (untracked) return UNTRACKED_DISCARD_TOOLTIP;
  if (mode === 'unstage') return STAGED_DISCARD_TOOLTIP;
  if (mode === 'blocked') return BLOCKED_TOOLTIP;
  return 'Discard this hunk (d)';
}
```

`Hunk`'s prop type gains `hunkIndex: number`, `mode: HunkButtonMode`, `untracked: boolean`,
`hunkOpsAvailable: boolean`, `onHunkOp: (op: 'stageHunk' | 'unstageHunk' | 'discardHunk') => void`.

> `data-hunk` is Lane B's hook for `jumpToCurrent`; it moves with the button, so wrapping the
> header in a row does not disturb `.rcard[data-path=…] .rhunk__jump[data-hunk=…]`.

- [ ] **Step 5: Move the band onto the row**

In `webview/styles.css`, strip `background` and `border-bottom` from `.rhunk__jump` (`:9351`) and
put them on the new row so the two controls share one band instead of fighting over it:

```css
/* The hunk's header row: the `@@` range (the jump target) plus its actions. The band and the
   rule live HERE now that the row has two children — moving them keeps the jump button a plain
   transparent control instead of a second painted surface inside a painted one. */
.rhunk__head {
  display: flex;
  align-items: stretch;
  gap: 4px;
  background: var(--diff-hunk-band);
  border-bottom: 1px solid var(--border);
}
.rhunk__jump {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  font-family: var(--font-mono);
  font-size: calc(11px * var(--font-scale));
  color: var(--blue);
  background: none;
  border: none;
  padding: 4px 12px 4px calc(2 * var(--density-rgutter-w) + 14px);
  cursor: pointer;
}
.rhunk__acts {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 6px;
  flex: 0 0 auto;
}
.rhunk__act {
  font-size: calc(10px * var(--font-scale));
  color: var(--text-dim);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 1px 6px;
  cursor: pointer;
}
.rhunk__act:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border);
}
.rhunk__act--danger:hover:not(:disabled) {
  color: var(--danger);
}
.rhunk__act:disabled {
  opacity: 0.45;
  cursor: default;
}
```

- [ ] **Step 6: Typecheck, build and eyeball**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

Behaviour is asserted end-to-end by the e2e in Task 12 (this is a host-boundary feature — the
mock shell has no git), so there is no unit test to add here; the decision logic it renders is
already covered by Task 4.

- [ ] **Step 7: Commit**

```bash
git add webview/components/review-view.tsx webview/styles.css
git commit -m "feat(review): add Stage, Unstage and Discard to the hunk header"
```

---

## Task 7: The `s` / `d` keys

**Files:**
- Modify: `webview/review-keymap.ts` — `ReviewAction`, `ACTIONS`, `REVIEW_KEY_HELP`, the module header comment
- Modify: `webview/components/review-view.tsx` — the `onKeyDown` switch; the cursor-clamp effect
- Modify: `test/unit/review-keymap.test.ts`

**Interfaces:**
- Consumes: Lane B's keymap module.
- Produces: `ReviewAction` gains `'stageHunk' | 'discardHunk'`; `ACTIONS` gains `s` and `d`.

> **Hard dependency.** This task edits Lane B's `webview/review-keymap.ts`. If that file does not
> exist, Lane B has not landed: **skip this task and record it in the run report** rather than
> creating the module here — its cursor walk, help panel and persistence are Lane B's to own.

- [ ] **Step 1: Flip the Lane B test case**

In `test/unit/review-keymap.test.ts`, remove `'s'` and `'d'` from the "ignores keys this lane
does not own" list, and add beside the existing action-key cases:

```ts
  it('maps the hunk-op keys (Lane E)', () => {
    expect(press('s')).toBe('stageHunk');
    expect(press('d')).toBe('discardHunk');
  });

  it('still ignores them under a modifier', () => {
    expect(press('s', { ctrlKey: true })).toBeNull();
    expect(press('d', { metaKey: true })).toBeNull();
    expect(press('s', { shiftKey: true })).toBeNull();
  });

  it('prints the hunk-op keys in the help table', () => {
    expect(REVIEW_KEY_HELP.some((r) => r.keys === 's / d')).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-keymap.test.ts`
Expected: FAIL — `expected null to be 'stageHunk'`.

- [ ] **Step 3: Extend the keymap**

In `webview/review-keymap.ts`, add both members to the `ReviewAction` union, add the two rows to
`ACTIONS` (`s: 'stageHunk'`, `d: 'discardHunk'`), add

```ts
  { keys: 's / d', description: 'Stage / discard the current change' },
```

to `REVIEW_KEY_HELP` after the `o / Enter` row, and update the module header's "Keys this lane
does NOT bind" line to drop `s`/`d` (leaving `c` for Lane F and `/` + `Mod+F` for Lane C).

- [ ] **Step 4: Handle them in the scroller**

In `review-view.tsx`'s `onKeyDown` switch, after `case 'openHunk':`:

```ts
        case 'stageHunk':
          // 'stageHunk' is upgraded to 'unstageHunk' inside runCurrentHunkOp when that is the
          // action the header is showing — the mode rule stays in exactly one place.
          runCurrentHunkOp('stageHunk');
          break;
        case 'discardHunk':
          runCurrentHunkOp('discardHunk');
          break;
```

with, beside `jumpToCurrent`:

```ts
  // `s` runs whichever primary action the header is actually showing; binding it to a button
  // that is not on screen would be worse than binding it to the one that is (assumption 14).
  const runCurrentHunkOp = useCallback(
    (op: 'stageHunk' | 'unstageHunk' | 'discardHunk') => {
      if (!current || current.hunkIndex < 0) return;
      const change = files[current.fileIndex];
      if (!change) return;
      const hunk = effectiveDiffs.get(absOf(change.path))
        ? computeFileReview(
            effectiveDiffs.get(absOf(change.path))?.head ?? '',
            effectiveDiffs.get(absOf(change.path))?.work ?? '',
          ).hunks[current.hunkIndex]
        : undefined;
      if (!hunk) return;
      const mode = hunkButtonMode(scope, stagedSide.has(change.path));
      if (!hunkOpsAvailable || mode === 'blocked') {
        setAnnounce(BLOCKED_TOOLTIP);
        return;
      }
      if (op === 'discardHunk' && (mode === 'unstage' || change.kind === 'U')) {
        setAnnounce(discardTitle(mode, change.kind === 'U'));
        return;
      }
      // `s` means "the primary action this header is showing" (assumption 14), so the mode rule
      // is applied HERE and nowhere else — the switch above stays a plain key→op mapping.
      const effective = op === 'stageHunk' && mode === 'unstage' ? 'unstageHunk' : op;
      void runHunkOp(effective, change, hunk);
    },
    [absOf, current, effectiveDiffs, files, hunkOpsAvailable, runHunkOp, scope, stagedSide],
  );
```

> **Recomputing the hunk here is deliberate.** `computeFileReview` is the same memoised call the
> card makes and is cheap for one file; the alternative is publishing every card's `FileReview`
> up to the parent purely so the keyboard path can read it, which would tie Lane B's cursor to
> the render tree.

- [ ] **Step 5: Clamp the cursor when a file loses a hunk**

Lane B clamps on `[files.length]`, which does not fire when a file keeps its place but loses a
hunk — exactly what a stage or a discard does. Beside that effect:

```ts
  // A staged or discarded hunk shortens ONE file without changing the file count, so the
  // cursor has to be brought back inside the list on the hunk count too (§2 Lane E).
  const hunkCountKey = useMemo(
    () => fileHunks.map((f) => f.hunkCount).join(','),
    [fileHunks],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the trigger; the list itself is read live.
  useEffect(() => {
    setCursor((cur) => ({ ...cur, ref: clampRef(cur.ref, fileHunksRef.current) }));
  }, [hunkCountKey]);
```

(`fileHunks` is Lane B's `ReviewFileHunks[]` memo — the one `fileHunksRef` mirrors. If Lane B
named it differently, use that name; do not introduce a second list.)

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/unit/review-keymap.test.ts`
Expected: PASS — Lane B's cases plus the 3 new ones.

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add webview/review-keymap.ts webview/components/review-view.tsx test/unit/review-keymap.test.ts
git commit -m "feat(review): bind s and d to stage and discard the current hunk"
```

---

## Task 8: Give a marker its old side, its removed text, and the peek's pure helpers

**Files:**
- Modify: `webview/change-decorations.ts` — `ChangeMarker` (`:20-28`), `hunksToMarkers` (`:51-90`), new exports at the end
- Modify: `webview/use-change-markers.ts` — the untracked whole-file marker; `ChangeMarkersApi`
- Modify: `test/unit/change-decorations.test.ts` — widen six marker literals, add the new helpers' cases

**Interfaces:**
- Consumes: `HunkRange` (Task 1); `ReviewHunk`, `ReviewLine` (`src/review-hunks.ts`).
- Produces:
  - `ChangeMarker` gains `oldRange: [number, number]` and `removedText: string[]`.
  - `export function markerRange(m: ChangeMarker): HunkRange`
  - `export function markerIndexAtLine(markers: ChangeMarker[], line: number): number`
  - `export function peekAfterLine(m: ChangeMarker): number`
  - `export function peekHeightInLines(removedCount: number): number`
  - `export type PeekEvent`, `export function reducePeek(index: number | null, event: PeekEvent, total: number): number | null`
  - `ChangeMarkersApi` gains `untracked: boolean`.

Lane A deliberately dropped the removed text ("that was peek-only and is gone" — Lane A
self-review). This is the lane that needs it: the peek renders those lines, and a stage or
discard from the editor needs the old-side span, which is the ONLY thing a pure deletion has.
Both fields are **required**, so nothing can build a marker that silently cannot be acted on.

- [ ] **Step 1: Write the failing test**

In `test/unit/change-decorations.test.ts`, widen the existing marker expectations and literals:

- the three `expect(markers[0]).toEqual({…})` blocks (added `:28`, modified `:42`, deleted `:56`)
  gain the two new fields:

```ts
    // added, lines 6-7 inserted after old line 5
    expect(markers[0]).toEqual({
      kind: 'added',
      startLine: 6,
      endLine: 7,
      addedLines: 2,
      removedLines: 0,
      oldRange: [6, 5],
      removedText: [],
    });
```

```ts
    // modified: l5 replaced
    expect(markers[0]).toEqual({
      kind: 'modified',
      startLine: 5,
      endLine: 5,
      addedLines: 1,
      removedLines: 1,
      oldRange: [5, 5],
      removedText: ['l5'],
    });
```

```ts
    // deleted: old l4 and l5 removed, anchored on the line that follows them
    expect(markers[0]).toEqual({
      kind: 'deleted',
      startLine: 4,
      endLine: 4,
      addedLines: 0,
      removedLines: 2,
      oldRange: [4, 5],
      removedText: ['l4', 'l5'],
    });
```

- the `m(...)` factory in `describe('markerTooltip')` (`:89-96`) gains `oldRange: [1, 0]` and
  `removedText: []` to its base object;
- the two typed `const markers: ChangeMarker[] = [...]` literals (`:115-118`, `:148-152`) gain
  the same two fields on every entry (`oldRange: [n, n-1]`, `removedText: []` for the added and
  modified rows; `oldRange: [9, 9]`, `removedText: ['gone']` for the deleted rows).

Then append the new suites:

```ts
describe('markerRange', () => {
  it('spans the added lines on the new side and the removed lines on the old', () => {
    const markers = hunksToMarkers(
      computeFileReview(lines(10), lines(10).replace('l5', 'CHANGED')).hunks,
      10,
    );
    expect(markerRange(markers[0])).toEqual({ new: [5, 5], old: [5, 5] });
  });

  it('gives a pure addition an empty old span', () => {
    const head = lines(10);
    const work = `${lines(5)}\nnew1\nnew2\nl6\nl7\nl8\nl9\nl10`;
    const r = markerRange(hunksToMarkers(computeFileReview(head, work).hunks, 12)[0]);
    expect(r.new).toEqual([6, 7]);
    expect(r.old[1]).toBeLessThan(r.old[0]);
  });

  it('gives a pure deletion an empty new span anchored on the marker line', () => {
    const work = ['l1', 'l2', 'l3', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n');
    const r = markerRange(hunksToMarkers(computeFileReview(lines(10), work).hunks, 8)[0]);
    expect(r.old).toEqual([4, 5]);
    expect(r.new).toEqual([4, 3]);
  });
});

describe('markerIndexAtLine', () => {
  const markers: ChangeMarker[] = [
    {
      kind: 'added',
      startLine: 10,
      endLine: 12,
      addedLines: 3,
      removedLines: 0,
      oldRange: [10, 9],
      removedText: [],
    },
    {
      kind: 'deleted',
      startLine: 30,
      endLine: 30,
      addedLines: 0,
      removedLines: 1,
      oldRange: [31, 31],
      removedText: ['gone'],
    },
  ];

  it('finds the marker covering a line inside a multi-line run', () => {
    expect(markerIndexAtLine(markers, 11)).toBe(0);
    expect(markerIndexAtLine(markers, 12)).toBe(0);
  });

  it('finds a single-line marker', () => {
    expect(markerIndexAtLine(markers, 30)).toBe(1);
  });

  it('returns -1 off any marker', () => {
    expect(markerIndexAtLine(markers, 20)).toBe(-1);
    expect(markerIndexAtLine([], 1)).toBe(-1);
  });

  it('takes the FIRST marker when a deletion shares an addition’s line', () => {
    const overlapping: ChangeMarker[] = [
      { ...markers[0], startLine: 5, endLine: 5 },
      { ...markers[1], startLine: 5, endLine: 5 },
    ];
    expect(markerIndexAtLine(overlapping, 5)).toBe(0);
  });
});

describe('peek geometry', () => {
  const m = (removed: number): ChangeMarker => ({
    kind: 'deleted',
    startLine: 12,
    endLine: 12,
    addedLines: 0,
    removedLines: removed,
    oldRange: [12, 11 + removed],
    removedText: Array.from({ length: removed }, (_, i) => `r${i}`),
  });

  it('opens the zone above the change, so the removed lines sit where they were', () => {
    expect(peekAfterLine(m(2))).toBe(11);
  });

  it('never asks for a zone above line zero', () => {
    expect(peekAfterLine({ ...m(1), startLine: 1 })).toBe(0);
  });

  it('grows with the removed lines, with a floor and a ceiling', () => {
    expect(peekHeightInLines(0)).toBe(3);
    expect(peekHeightInLines(1)).toBe(3);
    expect(peekHeightInLines(5)).toBe(7);
    expect(peekHeightInLines(200)).toBe(14);
  });
});

describe('reducePeek', () => {
  it('opens on a marker index', () => {
    expect(reducePeek(null, { type: 'open', index: 2 }, 5)).toBe(2);
  });

  it('refuses to open when there is nothing to show', () => {
    expect(reducePeek(null, { type: 'open', index: 0 }, 0)).toBeNull();
  });

  it('clamps an out-of-range open', () => {
    expect(reducePeek(null, { type: 'open', index: 9 }, 3)).toBe(2);
    expect(reducePeek(null, { type: 'open', index: -1 }, 3)).toBe(0);
  });

  it('closes', () => {
    expect(reducePeek(2, { type: 'close' }, 5)).toBeNull();
  });

  it('walks and wraps in both directions', () => {
    expect(reducePeek(0, { type: 'next' }, 3)).toBe(1);
    expect(reducePeek(2, { type: 'next' }, 3)).toBe(0);
    expect(reducePeek(0, { type: 'prev' }, 3)).toBe(2);
  });

  it('a single change wraps to itself', () => {
    expect(reducePeek(0, { type: 'next' }, 1)).toBe(0);
  });

  it('ignores navigation while closed', () => {
    expect(reducePeek(null, { type: 'next' }, 3)).toBeNull();
  });

  it('clamps or closes when a recompute changes the marker count', () => {
    expect(reducePeek(4, { type: 'sync' }, 2)).toBe(1);
    expect(reducePeek(1, { type: 'sync' }, 0)).toBeNull();
    expect(reducePeek(null, { type: 'sync' }, 5)).toBeNull();
  });
});
```

Widen the file's import list with `markerIndexAtLine`, `markerRange`, `peekAfterLine`,
`peekHeightInLines`, `reducePeek`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/change-decorations.test.ts`
Expected: FAIL — the new exports are missing and the widened literals do not typecheck.

- [ ] **Step 3: Widen `ChangeMarker` and populate it**

In `webview/change-decorations.ts`, add to the interface:

```ts
  /** 1-based old-side (baseline) span of the removed lines; `[k, k-1]` (empty) when none. It is
   *  the ONLY span a pure deletion has, so a stage or a discard from the editor needs it. */
  oldRange: [number, number];
  /** The removed lines, in order — what the change peek renders (spec §2 Lane E). */
  removedText: string[];
```

Add the two helpers beside `nextNewLine`:

```ts
/** Last old-side line number before `before`, or 0 when the run starts the hunk. */
function lastOldLineBefore(lines: ReviewLine[], before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    const o = lines[i].oldLine;
    if (o !== null) return o;
  }
  return 0;
}

const emptyAt = (n: number): [number, number] => [n, n - 1];
```

In `hunksToMarkers`, compute both fields per run. The adds branch becomes:

```ts
      const delLines = run.filter((l) => l.kind === 'del');
      const removedText = delLines.map((l) => l.text);
      const oldRange: [number, number] =
        delLines.length > 0
          ? [delLines[0].oldLine ?? 1, delLines[delLines.length - 1].oldLine ?? 1]
          : // A pure insertion sits AFTER the last old line before it — the seam, not line 1.
            emptyAt(lastOldLineBefore(lines, start) + 1);

      if (adds.length > 0) {
        const first = adds[0].newLine ?? 1;
        const last = adds[adds.length - 1].newLine ?? first;
        markers.push({
          kind: dels > 0 ? 'modified' : 'added',
          startLine: clamp(first, modelLineCount),
          endLine: clamp(last, modelLineCount),
          addedLines: adds.length,
          removedLines: dels,
          oldRange,
          removedText,
        });
        continue;
      }
```

and the deletion branch gains `oldRange` and `removedText` from the same two locals.

Append the new exports:

```ts
/** The line range a hunk op needs for this marker. A deletion has no new-side lines, so its new
 *  span is empty at the anchor — see src/hunk-patch.ts for the empty-span encoding. */
export function markerRange(m: ChangeMarker): HunkRange {
  return {
    new: m.addedLines > 0 ? [m.startLine, m.endLine] : [m.startLine, m.startLine - 1],
    old: m.oldRange,
  };
}

/** Which marker a gutter click on `line` landed on, or -1. First match wins: a deletion can be
 *  anchored on an addition's first line, and the peek shows one change at a time regardless. */
export function markerIndexAtLine(markers: ChangeMarker[], line: number): number {
  return markers.findIndex((m) => line >= m.startLine && line <= m.endLine);
}

/** View zones attach AFTER a line, and the removed lines belong above the change. */
export function peekAfterLine(m: ChangeMarker): number {
  return Math.max(0, m.startLine - 1);
}

/** Header + removed lines, floored so an empty peek is still legible and capped so a 400-line
 *  deletion cannot swallow the editor; the list scrolls inside the zone past that. */
export function peekHeightInLines(removedCount: number): number {
  return Math.min(Math.max(removedCount, 1) + 2, 14);
}

export type PeekEvent =
  | { type: 'open'; index: number }
  | { type: 'close' }
  | { type: 'next' }
  | { type: 'prev' }
  /** A recompute changed the marker list under an open peek. */
  | { type: 'sync' };

export function reducePeek(
  index: number | null,
  event: PeekEvent,
  total: number,
): number | null {
  // Closing, and having nothing left to show, are the same answer.
  if (event.type === 'close' || total === 0) return null;
  switch (event.type) {
    case 'open':
      return Math.min(Math.max(event.index, 0), total - 1);
    case 'next':
      return index === null ? null : (index + 1) % total;
    case 'prev':
      return index === null ? null : (index - 1 + total) % total;
    case 'sync':
      return index === null ? null : Math.min(index, total - 1);
  }
}
```

Add `import type { HunkRange } from '../src/hunk-patch';` to the top.

- [ ] **Step 4: Fix the untracked marker and expose `untracked`**

In `webview/use-change-markers.ts`, the whole-file added marker gains the two fields:

```ts
      apply([
        {
          kind: 'added',
          startLine: 1,
          endLine: count,
          addedLines: count,
          removedLines: 0,
          oldRange: [1, 0],
          removedText: [],
        },
      ]);
```

Add `untracked: boolean` to `ChangeMarkersApi` (documented as "the file has no HEAD blob — the
peek says so instead of offering a diff"), track it as state set alongside each `setState` call
(`true` only on the `head.reason === 'untracked'` branch, `false` everywhere else), and include
it in the returned `useMemo` and its dependency list.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/unit/change-decorations.test.ts test/unit/use-change-markers.test.ts`
Expected: PASS — the widened Lane A cases plus 19 new ones.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: both projects exit 0.

- [ ] **Step 7: Commit**

```bash
git add webview/change-decorations.ts webview/use-change-markers.ts test/unit/change-decorations.test.ts
git commit -m "feat(editor): carry removed lines and the old-side span on a change marker"
```

---

## Task 9: The view-zone lifecycle hook (`webview/use-peek-zone.ts`)

**Files:**
- Create: `webview/use-peek-zone.ts`
- Test: `test/unit/use-peek-zone.test.ts`

**Interfaces:**
- Consumes: `ChangeMarker`, `peekAfterLine`, `peekHeightInLines`, `reducePeek` (Task 8); `monaco-editor` (runtime, for nothing but types here — the hook takes the editor it is given).
- Produces:
  - `export interface PeekZoneApi { index: number | null; open(index: number): void; close(): void; next(): void; prev(): void; portal: ReactNode }`
  - `export function usePeekZone(opts: { editor; markers; render }): PeekZoneApi`

This is the codebase's **first view zone**. The hook owns exactly one thing — the zone's
lifetime and the portal host inside it — so the peek's contents stay an ordinary React component
with no Monaco knowledge, and every teardown path (`close`, model swap, editor dispose, a marker
list that shrank) runs through the same effect cleanup.

- [ ] **Step 1: Write the failing test**

Create `test/unit/use-peek-zone.test.ts`:

```ts
// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeMarker } from '../../webview/change-decorations';
import { type PeekZoneApi, usePeekZone } from '../../webview/use-peek-zone';

/**
 * Same shape as test/unit/use-change-markers.test.ts: a hand-written stub of the few Monaco
 * surfaces the hook touches, driven through react-dom in jsdom. The regression this guards is
 * the one every view zone ships with — a zone (or its portal) left behind after the thing that
 * owned it went away.
 */

const marker = (over: Partial<ChangeMarker> = {}): ChangeMarker => ({
  kind: 'deleted',
  startLine: 10,
  endLine: 10,
  addedLines: 0,
  removedLines: 2,
  oldRange: [10, 11],
  removedText: ['gone one', 'gone two'],
  ...over,
});

interface ZoneProbe {
  zones: Map<string, { afterLineNumber: number; heightInLines: number; domNode: HTMLElement }>;
  changeModelHandlers: Set<() => void>;
  focused: number;
}

function makeEditor() {
  const probe: ZoneProbe = { zones: new Map(), changeModelHandlers: new Set(), focused: 0 };
  let nextId = 1;
  const editor = {
    changeViewZones: (cb: (a: unknown) => void) =>
      cb({
        addZone: (z: { afterLineNumber: number; heightInLines: number; domNode: HTMLElement }) => {
          const id = `z${nextId++}`;
          probe.zones.set(id, z);
          return id;
        },
        removeZone: (id: string) => {
          probe.zones.delete(id);
        },
      }),
    onDidChangeModel: (cb: () => void) => {
      probe.changeModelHandlers.add(cb);
      return {
        dispose: () => {
          probe.changeModelHandlers.delete(cb);
        },
      };
    },
    revealLineInCenterIfOutsideViewport: () => {},
    focus: () => {
      probe.focused++;
    },
  };
  return { editor, probe };
}

let api: PeekZoneApi | null = null;
let root: Root | null = null;

function Probe({ editor, markers }: { editor: unknown; markers: ChangeMarker[] }): ReactNode {
  // biome-ignore lint/suspicious/noExplicitAny: the stub above is the whole editor surface the hook uses.
  api = usePeekZone({
    editor: editor as any,
    markers,
    render: (index) => createElement('div', { className: 'peek-probe' }, `change ${index}`),
  });
  return api.portal;
}

const render = async (editor: unknown, markers: ChangeMarker[]) => {
  await act(async () => {
    root?.render(createElement(Probe, { editor, markers }));
  });
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  api = null;
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
});

describe('usePeekZone', () => {
  it('adds no zone until something opens one', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    expect(probe.zones.size).toBe(0);
    expect(api?.index).toBeNull();
    expect(api?.portal).toBeNull();
  });

  it('opens one zone above the change and mounts the portal into its dom node', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    expect(probe.zones.size).toBe(1);
    const zone = [...probe.zones.values()][0];
    expect(zone.afterLineNumber).toBe(9);
    expect(zone.heightInLines).toBe(4);
    expect(zone.domNode.querySelector('.peek-probe')?.textContent).toBe('change 0');
  });

  it('keeps exactly one zone when another marker is opened', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker(), marker({ startLine: 40, endLine: 40 })]);
    await act(async () => api?.open(0));
    await act(async () => api?.open(1));
    expect(probe.zones.size).toBe(1);
    expect([...probe.zones.values()][0].afterLineNumber).toBe(39);
  });

  it('removes the zone and unmounts the portal on close, and returns focus', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    const node = [...probe.zones.values()][0].domNode;
    await act(async () => api?.close());
    expect(probe.zones.size).toBe(0);
    expect(api?.portal).toBeNull();
    expect(node.querySelector('.peek-probe')).toBeNull();
    expect(probe.focused).toBeGreaterThan(0);
  });

  it('closes when the model is swapped underneath it', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    expect(probe.zones.size).toBe(1);
    await act(async () => {
      for (const cb of probe.changeModelHandlers) cb();
    });
    expect(probe.zones.size).toBe(0);
    expect(api?.index).toBeNull();
  });

  it('removes the zone when the editor goes away', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    await render(null, [marker()]);
    expect(probe.zones.size).toBe(0);
  });

  it('walks to the next and previous change, wrapping', async () => {
    const { editor } = makeEditor();
    await render(editor, [marker(), marker({ startLine: 40, endLine: 40 })]);
    await act(async () => api?.open(1));
    await act(async () => api?.next());
    expect(api?.index).toBe(0);
    await act(async () => api?.prev());
    expect(api?.index).toBe(1);
  });

  it('clamps an open peek when a recompute shortens the marker list', async () => {
    const { editor } = makeEditor();
    await render(editor, [marker(), marker({ startLine: 40, endLine: 40 })]);
    await act(async () => api?.open(1));
    await render(editor, [marker()]);
    expect(api?.index).toBe(0);
  });

  it('closes when a recompute leaves no markers at all', async () => {
    const { editor, probe } = makeEditor();
    await render(editor, [marker()]);
    await act(async () => api?.open(0));
    await render(editor, []);
    expect(api?.index).toBeNull();
    expect(probe.zones.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/use-peek-zone.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/use-peek-zone"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview/use-peek-zone.ts`:

```ts
import type * as monaco from 'monaco-editor';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type ChangeMarker,
  peekAfterLine,
  peekHeightInLines,
  reducePeek,
} from './change-decorations';

/**
 * The change peek's Monaco half (spec 2026-08-27-review-supercharge §2 Lane E).
 *
 * The codebase's first view zone, so the rule is set here: ONE zone at a time, created by the
 * effect that also destroys it, with the React contents living in a portal into the zone's own
 * domNode. Every way the peek can end — close, another marker, a model swap, the editor going
 * away, a recompute that shortened the marker list — reduces to the same effect re-running, so
 * there is no second teardown path to forget.
 */

export interface PeekZoneApi {
  /** Index into `markers`, or null when nothing is open. */
  index: number | null;
  open(index: number): void;
  close(): void;
  next(): void;
  prev(): void;
  /** Render this from the consuming component; null while closed. */
  portal: ReactNode;
}

export function usePeekZone({
  editor,
  markers,
  render,
}: {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  markers: ChangeMarker[];
  render: (index: number, total: number, close: () => void) => ReactNode;
}): PeekZoneApi {
  const [index, setIndex] = useState<number | null>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const total = markers.length;

  const close = useCallback(() => {
    setIndex((i) => (i === null ? null : reducePeek(i, { type: 'close' }, total)));
    // Esc must land the caret back where the reader was, not leave focus on a removed node.
    editorRef.current?.focus();
  }, [total]);

  const open = useCallback(
    (next: number) => setIndex((i) => reducePeek(i, { type: 'open', index: next }, total)),
    [total],
  );
  const next = useCallback(
    () => setIndex((i) => reducePeek(i, { type: 'next' }, total)),
    [total],
  );
  const prev = useCallback(
    () => setIndex((i) => reducePeek(i, { type: 'prev' }, total)),
    [total],
  );

  // A recompute can shorten or empty the marker list under an open peek.
  useEffect(() => {
    setIndex((i) => reducePeek(i, { type: 'sync' }, total));
  }, [total]);

  const marker = index === null ? undefined : markers[index];

  // The zone itself. Keyed on the editor and the anchor line, so opening a different marker
  // tears the old zone down before building the new one — never two at once.
  useEffect(() => {
    if (!editor || !marker) {
      setHost(null);
      return;
    }
    const node = document.createElement('div');
    node.className = 'peekzone';
    let zoneId = '';
    editor.changeViewZones((accessor) => {
      zoneId = accessor.addZone({
        afterLineNumber: peekAfterLine(marker),
        heightInLines: peekHeightInLines(marker.removedText.length),
        domNode: node,
      });
    });
    setHost(node);
    editor.revealLineInCenterIfOutsideViewport(Math.max(1, marker.startLine));
    return () => {
      editor.changeViewZones((accessor) => {
        if (zoneId) accessor.removeZone(zoneId);
      });
      setHost(null);
    };
  }, [editor, marker]);

  // A model swap replaces every line number the open peek was anchored to.
  useEffect(() => {
    if (!editor) return;
    const sub = editor.onDidChangeModel(() => setIndex(null));
    return () => sub.dispose();
  }, [editor]);

  const portal = host && index !== null ? createPortal(render(index, total, close), host) : null;

  return useMemo(
    () => ({ index, open, close, next, prev, portal }),
    [index, open, close, next, prev, portal],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/use-peek-zone.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add webview/use-peek-zone.ts test/unit/use-peek-zone.test.ts
git commit -m "feat(editor): add the change-peek view-zone and portal lifecycle hook"
```

---

## Task 10: The peek panel, the gutter click, and the tokens

**Files:**
- Create: `webview/components/change-peek.tsx`
- Modify: `webview/components/code-viewer.tsx` — a mouse-down effect beside the existing one (`:362-371` is inside the mount effect; this one is its own, keyed on `editor`); the `useChangeMarkers` call site (`:573`); the returned JSX (`:610-628`)
- Modify: `webview/styles.css` — `--change-peek-bg` in the three theme blocks (`:189`, `:279`, `:373`); `.peekzone` / `.peek*` rules beside the `.cdec*` block (`:9428`)
- Modify: `test/unit/theme-tokens.test.ts` — the `change-marker tokens` describe

**Interfaces:**
- Consumes: `usePeekZone` (Task 9); `markerRange`, `markerIndexAtLine`, `ChangeMarker` (Task 8); `applyHunkAction`, `hunkButtonMode`, `getHunkActionHost`, `subscribeHunkActionHost`, the tooltips (Task 4); `repoRelPath` (`src/repo-rel.ts`, Lane A); `gitAction` (`webview/bridge.ts`); `pushToast` (`webview/toast-store.ts`).
- Produces: `export function ChangePeek(props): JSX.Element`.

The editor peek uses the **All-scope** rule, because that is the editor's baseline: markers are
HEAD→worktree, so its ranges map onto the index→worktree hunks only while the file has no staged
side — `hunkButtonMode('all', hasStagedSide)`, the same function the Review header calls.

- [ ] **Step 1: Write the panel**

Create `webview/components/change-peek.tsx`:

```tsx
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { repoRelPath } from '../../src/repo-rel';
import { gitAction } from '../bridge';
import { type ChangeMarker, markerRange } from '../change-decorations';
import {
  applyHunkAction,
  BLOCKED_TOOLTIP,
  getHunkActionHost,
  hunkButtonMode,
  subscribeHunkActionHost,
  UNTRACKED_DISCARD_TOOLTIP,
} from '../hunk-actions';
import { pushToast } from '../toast-store';

/**
 * The change peek's contents (spec 2026-08-27-review-supercharge §2 Lane E, §8).
 *
 * Knows nothing about Monaco — usePeekZone owns the zone and portals this in — so the removed
 * lines can reuse Review's own row classes and the whole thing stays an ordinary component.
 */
export function ChangePeek({
  marker,
  index,
  total,
  path,
  untracked,
  onClose,
  onNext,
  onPrev,
  onAnnounce,
}: {
  marker: ChangeMarker;
  /** 0-based; the label and the aria-label are 1-based. */
  index: number;
  total: number;
  /** Absolute path of the open file. */
  path: string;
  untracked: boolean;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  onAnnounce: (text: string) => void;
}) {
  const host = useSyncExternalStore(
    subscribeHunkActionHost,
    getHunkActionHost,
    getHunkActionHost,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const label = `Change ${index + 1} of ${total}`;

  const rel = host?.root ? repoRelPath(host.root, path) : null;
  // The editor's baseline is HEAD→worktree, which is Review's All scope — so the same rule.
  const mode = hunkButtonMode('all', rel !== null && host?.stagedPaths.has(rel) === true);
  const canAct = rel !== null && mode === 'stage';

  useEffect(() => {
    // Opening moves focus into the dialog; usePeekZone's close() puts it back on the editor.
    rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // A focus TRAP, not a focus hint: Tab must not walk out into the editor's own widgets
      // while a dialog is open (§10).
      const focusable = [
        ...(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  const run = useCallback(
    async (op: 'stageHunk' | 'discardHunk') => {
      if (rel === null) return;
      const outcome = await applyHunkAction(
        { host, gitAction, toast: pushToast, announce: onAnnounce },
        {
          op,
          absPath: path,
          relPath: rel,
          range: markerRange(marker),
          lineCount: marker.addedLines + marker.removedLines,
          untracked,
        },
      );
      // The markers recompute on their own: a discard rewrites the worktree, which the file
      // watcher already turns into a refetch. A stage changes neither the worktree nor HEAD,
      // so the markers are correctly unchanged — but the change is gone from the peek's point
      // of view either way, so it closes.
      if (outcome.kind === 'done') onClose();
      if (outcome.kind === 'unsupported') onAnnounce(UNTRACKED_DISCARD_TOOLTIP);
    },
    [host, marker, onAnnounce, onClose, path, rel, untracked],
  );

  return (
    <div
      ref={rootRef}
      className="peek"
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      <div className="peek__head">
        <span className="peek__title">{label}</span>
        <button
          type="button"
          className="peek__act"
          disabled={!canAct}
          title={mode === 'blocked' ? BLOCKED_TOOLTIP : 'Stage this change'}
          onClick={() => void run('stageHunk')}
        >
          {untracked ? 'Stage file' : 'Stage'}
        </button>
        <button
          type="button"
          className="peek__act peek__act--danger"
          disabled={!canAct || untracked}
          title={
            untracked
              ? UNTRACKED_DISCARD_TOOLTIP
              : mode === 'blocked'
                ? BLOCKED_TOOLTIP
                : 'Discard this change'
          }
          onClick={() => void run('discardHunk')}
        >
          Discard
        </button>
        <button type="button" className="peek__nav" aria-label="Previous change" onClick={onPrev}>
          ↑
        </button>
        <button type="button" className="peek__nav" aria-label="Next change" onClick={onNext}>
          ↓
        </button>
        <button type="button" className="peek__nav" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="peek__lines">
        {untracked ? (
          <p className="peek__note">New file — no previous version.</p>
        ) : marker.removedText.length === 0 ? (
          <p className="peek__note">Nothing was removed here — these lines are new.</p>
        ) : (
          marker.removedText.map((text, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: removed lines are positional and stable for the life of this peek
            <pre key={i} className="rline rline--del">
              <span className="rline__gutter">{marker.oldRange[0] + i}</span>
              <span className="rline__gutter" />
              <span className="rline__sign">-</span>
              <span className="rline__text">{text === '' ? ' ' : text}</span>
            </pre>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `CodeViewer`**

Add the imports:

```ts
import { markerIndexAtLine } from '../change-decorations';
import { usePeekZone } from '../use-peek-zone';
import { ChangePeek } from './change-peek';
```

After the `useChangeMarkers` call (`:573-581`) and its `changesRef` assignment:

```ts
  // Announcements the peek makes ("Staged hunk"), kept apart from the marker hook's own live
  // region so a navigation announcement and an op announcement cannot overwrite each other.
  const [hunkAnnounce, setHunkAnnounce] = useState('');

  const peek = usePeekZone({
    editor,
    markers: changes.markers,
    render: (index, total, close) => (
      <ChangePeek
        marker={changes.markers[index]}
        index={index}
        total={total}
        path={doc.path}
        untracked={changes.untracked}
        onClose={close}
        onNext={() => peekRef.current?.next()}
        onPrev={() => peekRef.current?.prev()}
        onAnnounce={setHunkAnnounce}
      />
    ),
  });
  const peekRef = useRef(peek);
  peekRef.current = peek;
  const markersRef = useRef(changes.markers);
  markersRef.current = changes.markers;

  // Clicking a gutter marker opens the peek. Its own effect rather than a branch inside the
  // mount effect: `editor` is state, so this re-binds with a new instance without dragging the
  // 300-line mount effect along, and the two refs keep it from re-binding on every recompute.
  useEffect(() => {
    if (!editor) return;
    const sub = editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
      const line = e.target.position?.lineNumber;
      if (line === undefined) return;
      const i = markerIndexAtLine(markersRef.current, line);
      if (i >= 0) peekRef.current?.open(i);
    });
    return () => sub.dispose();
  }, [editor]);
```

In the returned JSX, render the portal beside the Monaco host and add the second live region:

```tsx
      <div className="viewer__monaco" ref={ref} />
      {peek.portal}
      …
      <div className="sr-only viewer__announce" role="status" aria-live="polite">
        {changes.announcement}
      </div>
      <div className="sr-only viewer__announce" role="status" aria-live="polite">
        {hunkAnnounce}
      </div>
```

- [ ] **Step 3: Add the token and the styles**

In `webview/styles.css`, add to each of the three theme blocks, beside the `--change-*` trio:

```css
  /* The change peek's surface — a raised plate on the code base so the removed lines read as
     a quotation of the past, not as part of the file (spec §11). */
  --change-peek-bg: #1e2029;   /* :root — Aero Dark, over --code-base #15161b */
```

```css
  --change-peek-bg: #252939;   /* aero, over --code-base #1b1e2b */
```

```css
  --change-peek-bg: #120e22;   /* neon, over --code-base #06050c */
```

and, beside the `.cdec*` block:

```css
/* The change peek: a Monaco view zone, so the zone itself is just a host — every visual is on
   .peek. Removed lines reuse the Review row classes verbatim (spec §2 Lane E). */
.peekzone {
  display: flex;
}
.peek {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  background: var(--change-peek-bg);
  border-left: 3px solid var(--change-deleted);
  animation: peek-in 110ms ease-out;
}
.peek__head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-bottom: 1px solid var(--border);
}
.peek__title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: calc(11px * var(--font-scale));
  color: var(--text-dim);
}
.peek__act,
.peek__nav {
  font-size: calc(10px * var(--font-scale));
  color: var(--text-dim);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  padding: 1px 6px;
  cursor: pointer;
}
.peek__act:hover:not(:disabled),
.peek__nav:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border);
}
.peek__act--danger:hover:not(:disabled) {
  color: var(--danger);
}
.peek__act:disabled,
.peek__nav:disabled {
  opacity: 0.45;
  cursor: default;
}
.peek__lines {
  overflow: auto;
  flex: 1 1 auto;
}
.peek__note {
  margin: 0;
  padding: 4px 10px;
  font-size: calc(11px * var(--font-scale));
  color: var(--text-faint);
}
@keyframes peek-in {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .peek {
    animation: none;
  }
}
@media (forced-colors: active) {
  .peek {
    border: 1px solid CanvasText;
  }
}
```

- [ ] **Step 4: Assert the token in every theme**

In `test/unit/theme-tokens.test.ts`, inside `describe('change-marker tokens')`:

```ts
  for (const { id } of THEMES) {
    const tokens = theme(id);
    it(`${id}: the change peek's surface keeps its text legible`, () => {
      // The peek quotes removed lines in the editor's own type, so the code text tier is what
      // has to read on it.
      expect(contrast(resolve(tokens, '--syn-default'), resolve(tokens, '--change-peek-bg')))
        .toBeGreaterThanOrEqual(4.5);
    });
  }

  it('opens the peek without motion where motion is unwelcome', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}\.peek\s*\{[^}]*animation:\s*none/);
  });
```

If a theme's chosen `--change-peek-bg` fails the ratio, **retune the colour, never the check** —
the token exists to be legible.

- [ ] **Step 5: Run the tests, typecheck and build**

Run: `npx vitest run test/unit/theme-tokens.test.ts test/unit/change-decorations.test.ts test/unit/use-peek-zone.test.ts`
Expected: PASS.

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add webview/components/change-peek.tsx webview/components/code-viewer.tsx webview/styles.css test/unit/theme-tokens.test.ts
git commit -m "feat(editor): open a change peek from a gutter marker with stage and discard"
```

---

## Task 11: Changelog entry

**Files:**
- Modify: `CHANGELOG.md` — the existing `## [Unreleased]` section (Lane A added it; add to it rather than starting a second one)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the entry**

Under `## [Unreleased]` → `### Added`:

```markdown
- **Stage, unstage or throw away one change at a time.** Every hunk in the Review tab now carries
  its own Stage and Discard, and under the Staged scope, Unstage — so a review that used to mean
  "take the whole file or none of it" can go change by change. The same two buttons live in the
  editor: click a change marker in the gutter and a panel opens in place showing the lines that
  were removed, with Stage · Discard and arrows to walk to the next one. `s` and `d` do it from
  the keyboard while Review has focus, and Discard always asks first.
- The patch is built from git's own diff of the file, not from what's on screen, so files with
  Windows line endings or no newline at the end come through exactly right — and if the file has
  changed since the diff you're looking at was loaded, the operation is refused and the card
  reloads rather than applying half of it.
```

- [ ] **Step 2: Confirm the formatting**

Run: `npx biome check CHANGELOG.md`
Expected: no diagnostics.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for hunk-level staging and the change peek"
```

---

## Task 12: The `hunk-staging` e2e scenario

**Files:**
- Create: `test/e2e/hunk-staging.e2e.mjs`

**Interfaces:**
- Consumes: `assert`, `closeApp`, `openSession`, `runScenario` from `test/e2e/harness.mjs`; `execFileSync` for the fixture repo and the git assertions.
- Produces: nothing.

Every path in this lane crosses the host boundary — `git-action` spawns `git diff` and
`git apply` — so per `CLAUDE.md` it gets a scenario on the shared harness. The runner launches
hidden; run it **alone on a quiet machine**.

- [ ] **Step 1: Write the scenario**

Create `test/e2e/hunk-staging.e2e.mjs`:

```js
/**
 * hunk-staging — Lane E of spec 2026-08-27-review-supercharge. Real-app only: the whole feature
 * is `git diff` → selectHunks → `git apply` on the host, which the mock shell cannot fake.
 *
 * Fixtures, all committed then edited in the worktree:
 *   two.txt    LF, two separated edits → two git hunks (the headline case)
 *   crlf.txt   CRLF line endings, one edit
 *   noeof.txt  no trailing newline, one edit
 *   staged.txt one edit, ALREADY STAGED → the All-scope "blocked" case
 *
 * Flow: stage hunk 2 of two.txt under Unstaged scope → discard on the CRLF and no-EOF fixtures
 * → the blocked buttons under All → a conflict → the editor peek.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

const numbered = (n, edits = {}, eol = '\n') =>
  Array.from({ length: n }, (_, i) => edits[i + 1] ?? `l${i + 1}`).join(eol) + eol;

runScenario('hunk-staging', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-hunkstage-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });

  git('init', '-q');
  git('config', 'user.email', 'e2e@conduit.test');
  git('config', 'user.name', 'e2e');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');

  writeFileSync(join(root, 'two.txt'), numbered(30));
  writeFileSync(join(root, 'crlf.txt'), numbered(12, {}, '\r\n'));
  writeFileSync(join(root, 'noeof.txt'), 'alpha\nbeta\ngamma');
  writeFileSync(join(root, 'staged.txt'), numbered(14));
  git('add', '.');
  git('commit', '-qm', 'seed');

  writeFileSync(join(root, 'two.txt'), numbered(30, { 3: 'HUNK-A', 25: 'HUNK-B' }));
  writeFileSync(join(root, 'crlf.txt'), numbered(12, { 6: 'CRLF-EDIT' }, '\r\n'));
  writeFileSync(join(root, 'noeof.txt'), 'alpha\nbeta\nGAMMA');
  writeFileSync(join(root, 'staged.txt'), numbered(14, { 5: 'STAGED-EDIT' }));
  git('add', 'staged.txt');

  const cached = () => git('diff', '--cached', '-U3');
  const worktreeDirty = (f) => git('diff', '--', f).trim() !== '';

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 20000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review .rcard', { state: 'visible', timeout: 20000 });
  log('review open ✓');

  const card = (name) => page.locator(`.review .rcard[data-path="${name}"]`);
  const hunks = (name) => card(name).locator('.rhunk');
  const act = (name, i, label) =>
    hunks(name).nth(i).locator('.rhunk__act', { hasText: new RegExp(`^${label}$`) });

  // ---- (1) Unstaged scope, stage the SECOND of two hunks -------------------------------
  // Lane D owns the control's markup; §9 fixes its role, so drive it by accessible name.
  const unstaged = page.getByRole('radio', { name: 'Unstaged' });
  await unstaged.waitFor({ state: 'visible', timeout: 15000 });
  await unstaged.click();
  await page.waitForFunction(
    () => document.querySelectorAll('.review .rcard[data-path="two.txt"] .rhunk').length === 2,
    null,
    { timeout: 15000 },
  );
  log('two.txt shows two hunks ✓');

  await act('two.txt', 1, 'Stage').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.review .rcard[data-path="two.txt"] .rhunk').length === 1,
    null,
    { timeout: 15000 },
  );
  const staged = cached();
  assert(staged.includes('HUNK-B'), 'the staged diff must contain the hunk that was staged');
  assert(!staged.includes('HUNK-A'), `only hunk 2 may be staged; got:\n${staged}`);
  const remaining = await hunks('two.txt').first().textContent();
  assert(
    (remaining ?? '').length > 0 && !(remaining ?? '').includes('HUNK-B'),
    'the card must now show the OTHER hunk',
  );
  log('staged exactly hunk 2; the card kept hunk 1 ✓');

  // ---- (2) Discard, on the CRLF and the no-EOF fixtures ---------------------------------
  for (const file of ['crlf.txt', 'noeof.txt']) {
    await act(file, 0, 'Discard').click();
    await page.waitForSelector('.confirm', { state: 'visible', timeout: 10000 });
    const msg = (await page.textContent('.confirm__msg')) ?? '';
    assert(msg.includes('reverted to the index'), `confirm copy should name the index; got "${msg}"`);
    await page.locator('.confirm .btn--danger').click();
    await page.waitForFunction(
      (f) => !document.querySelector(`.review .rcard[data-path="${f}"] .rhunk`),
      file,
      { timeout: 15000 },
    );
    assert(!worktreeDirty(file), `${file} must equal the index after a discard`);
    log(`${file} discarded and back to the index ✓`);
  }
  const crlfBytes = readFileSync(join(root, 'crlf.txt'), 'utf8');
  assert(crlfBytes.includes('\r\n'), 'discarding must not rewrite CRLF line endings');
  const noeofBytes = readFileSync(join(root, 'noeof.txt'), 'utf8');
  assert(!noeofBytes.endsWith('\n'), 'discarding must not add a trailing newline');
  log('line endings survived the round trip ✓');

  // ---- (3) All scope: a file with a staged side is blocked ------------------------------
  await page.getByRole('radio', { name: 'All' }).click();
  await page.waitForSelector('.review .rcard[data-path="staged.txt"] .rhunk__act', {
    timeout: 15000,
  });
  const blocked = await page.evaluate(() => {
    const btns = [
      ...document.querySelectorAll('.review .rcard[data-path="staged.txt"] .rhunk__act'),
    ];
    return btns.map((b) => ({ text: b.textContent?.trim(), disabled: b.disabled, title: b.title }));
  });
  assert(blocked.length >= 2, `expected the staged file's hunk buttons, got ${blocked.length}`);
  assert(
    blocked.every((b) => b.disabled),
    `every hunk button must be disabled for a file with a staged side; got ${JSON.stringify(blocked)}`,
  );
  assert(
    blocked.some((b) => b.title === 'Switch to Unstaged scope to stage hunks'),
    `the tooltip must name the scope to switch to; got ${JSON.stringify(blocked)}`,
  );
  log('All scope + staged side → disabled with the tooltip ✓');

  // ---- (4) Conflict: the file moves after the diff loaded -------------------------------
  const before = cached();
  writeFileSync(join(root, 'two.txt'), 'entirely different content\n');
  await page.getByRole('radio', { name: 'Unstaged' }).click();
  await page.waitForSelector('.review .rcard[data-path="two.txt"] .rhunk__act', { timeout: 15000 });
  await act('two.txt', 0, 'Stage').click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.toast')].some((t) =>
        (t.textContent ?? '').includes('changed since this diff was loaded'),
      ),
    null,
    { timeout: 15000 },
  );
  assert(cached() === before, 'a conflicted op must stage nothing');
  log('conflict toasted and staged nothing ✓');

  // ---- (5) The editor peek --------------------------------------------------------------
  writeFileSync(join(root, 'peek.txt'), numbered(20));
  git('add', 'peek.txt');
  git('commit', '-qm', 'peek');
  writeFileSync(
    join(root, 'peek.txt'),
    numbered(20)
      .split('\n')
      .filter((l) => l !== 'l8' && l !== 'l9')
      .join('\n'),
  );

  await page.locator('.rtab', { hasText: 'Files' }).click();
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: /^peek\.txt$/ }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();
  await page.waitForSelector('.margin-view-overlays .cdec--deleted', { timeout: 20000 });
  await page.locator('.margin-view-overlays .cdec--deleted').first().click();

  await page.waitForSelector('.peek[role="dialog"]', { state: 'visible', timeout: 15000 });
  const peekLines = await page.locator('.peek .rline--del').count();
  assert(peekLines === 2, `the peek should quote both removed lines, got ${peekLines}`);
  const peekLabel = await page.getAttribute('.peek[role="dialog"]', 'aria-label');
  assert(/^Change \d+ of \d+$/.test(peekLabel ?? ''), `peek aria-label was "${peekLabel}"`);
  log(`peek open: "${peekLabel}" with ${peekLines} removed lines ✓`);

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'hunk-staging.png') }).catch(() => {});

  await page.keyboard.press('Escape');
  await page.waitForSelector('.peek[role="dialog"]', { state: 'detached', timeout: 10000 });
  const focusReturned = await page.evaluate(
    () => document.activeElement?.closest('.viewer__monaco') !== null,
  );
  assert(focusReturned, 'Esc must return focus to the editor');
  log('peek closed and focus returned to the editor ✓');

  await closeApp(app, page);
});
```

- [ ] **Step 2: Run the scenario alone**

Run: `node test/e2e/run-smoke.mjs hunk-staging`
Expected: `PASS hunk-staging`. Run it on a **quiet** machine — leftover `cmd.exe` / `conhost`
from an earlier run starves ConPTY and makes every scenario look broken (`CLAUDE.md`). Never
clean up by killing processes by name; the harness's teardown is PID-scoped.

If step (1) cannot find the Unstaged radio, Lane D shipped a different accessible name — read the
control's markup and fix the locator here. **Do not delete the scope assertions**: "under
Unstaged scope" is the spec's first acceptance criterion for this lane.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/hunk-staging.e2e.mjs
git commit -m "test(e2e): cover hunk staging, discard, the blocked case and the editor peek"
```

---

## Task 13: Full gate + evidence

**Files:**
- Create (gitignored, not committed): `.autoloop/evidence/lane-e-verify.log`, `.autoloop/evidence/lane-e-e2e.log`

**Interfaces:**
- Consumes: everything above.
- Produces: a green lane and its evidence.

- [ ] **Step 1: Run the full verify gate, capturing evidence**

```bash
mkdir -p .autoloop/evidence
npm run verify 2>&1 | tee .autoloop/evidence/lane-e-verify.log
```

Expected: exit 0. **Read the whole output** — never judge it by the tail, which has twice hidden
a "Found N errors" line in this repo. If `fallow:check` reports an unused export, delete the
export rather than suppressing the check; if any check fails, fix the code, never the check.

- [ ] **Step 2: Run this lane's scenario, capturing evidence**

```bash
node test/e2e/run-smoke.mjs hunk-staging 2>&1 | tee .autoloop/evidence/lane-e-e2e.log
```

Expected: `PASS hunk-staging`.

- [ ] **Step 3: Run the full smoke suite**

```bash
npm run test:smoke 2>&1 | tee .autoloop/evidence/lane-e-smoke.log
```

Expected: every scenario PASS or SKIP, zero FAIL. Re-run any single failure **alone** before
believing it — `review-navigator`, `review-keymap-persist` and this lane's scenario all drive the
same Review surface, and a loaded machine fails them together for reasons that have nothing to do
with the code.

- [ ] **Step 4: Confirm the working tree is clean of scratch**

```bash
git status --ignored --short
```

Expected: only the intended files. `.autoloop/` is gitignored (`.gitignore:19`); screenshots live
under `%TEMP%\claude-scratch`. Nothing from this lane belongs in the repo.

- [ ] **Step 5: Commit anything the gate corrected**

```bash
git add -A
git commit -m "chore: verify green for hunk-level staging and the change peek"
```

(Skip if `git status` is already clean.)

---

## Self-Review

Run against the spec with fresh eyes.

**1. Spec coverage (revision note, §2 Lane E, §2 Lane D as consumed, §3, §4, §5, §7 Lane E, §8–§11, §12 #8)**

| Spec requirement | Task |
|---|---|
| Patches built host-side from git's own diff, never renderer text | 1 (`selectHunks`), 3 (`runHunkPlan`) |
| `stageHunk` = `git diff -U3` + `git apply --cached` | 3 (`buildHunkPlan`), proved in 2 and 3's integration cases |
| `unstageHunk` = `git diff --cached -U3` + `git apply --cached --reverse` | 3, proved in 2 and 3 |
| `discardHunk` = `git diff -U3` + `git apply --reverse` (revert to the **index**) | 3, proved in 3's discard case and the e2e |
| `range = { new: [s,e], old: [s,e] }`, 1-based inclusive, empty new span for a pure deletion | 1 (encoding + `hunkRange`), 8 (`markerRange`) |
| Pure `selectHunks` unit-tested on LF, CRLF and no-EOF-newline **with `git apply --check`** | 1 (fixtures), **2** (real `git apply --check` and `--cached --check`) |
| Rename header re-emitted verbatim; binary → empty selection | 1 |
| `GitActionPlan` gains `stdin` | 3 (`{ kind: 'git'; args; stdin? }`, used by `runHunkPlan`) |
| Path containment as today; the range is just numbers | 3 (`isInsideRoot` gate + its escape test) |
| `no-hunk` / `apply-failed` result codes | 3 (executor), 4 (renderer mapping) |
| Baseline rule: Unstaged 1:1; All only without a staged side; Unstage only under Staged | 4 (`hunkButtonMode` + its matrix), 6 (header), 10 (peek), 12 (e2e) |
| "Switch to Unstaged scope to stage hunks", disabled + tooltip | 4 (constant), 6, 10, 12 |
| Where: Review hunk header · editor peek · keys `s` / `d` | 6, 10, 7 |
| Change peek: `changeViewZones`, React portal into `domNode`, removed lines in Review styling, "Change 2 of 5", Stage · Discard · ↑ ↓ ×, one at a time | 9 (zone + portal + one-at-a-time), 10 (contents) |
| Peek closes on Esc / model swap / editor dispose / another marker; focus returns to the editor | 9 (all four paths, each asserted), 10 (Esc handler + trap), 12 (e2e Esc + focus) |
| Peek actions obey the baseline rule | 10 (`hunkButtonMode('all', …)`) |
| Discard confirms with the spec's exact copy; Stage/Unstage do not | 4 (`discardConfirm` + its test), 6, 10, 12 |
| After any op: refresh · card re-requests its diff · mark prunes · cursor clamps | 4 (`refreshChanges` + `invalidateDiff`), 6 (`requestedRef.delete`), assumption 15 (mark), 7 (clamp on hunk count) |
| Conflict → the spec's toast + card reload; no partial apply; no blind retry | 4 (`CONFLICT_TOAST`, reload on failure, no retry), 3 (`git apply` atomicity), 12 (e2e) |
| Untracked: Stage = `stageFile` | 4 (op mapping + its test), 10 ("Stage file") |
| A range spanning two git hunks applies both (§4, §12 #8) | 1 (its own test case) |
| CRLF / no-EOF fixtures apply | 1, 2, 12 |
| §8 peek states: open · untracked · staged-side present | 10 |
| §9 keyboard path for every pointer action; `role="dialog"` + `aria-label="Change 2 of 5"` | 7, 10, 12 |
| §10 focus trap and return; "Staged hunk" / "Discarded hunk" announcements; reduced motion; forced colors | 9, 10 (trap, live region), 4 (`SAID`), 10 (CSS) |
| §11 `--change-peek-bg` in all three themes | 10 (tokens + the contrast test) |
| §7 Lane E e2e `hunk-staging` — all six criteria | 12 |
| Lane D consumed and nothing more (readDiff base/side, `scope`, `ChangeDTO.staged`) | the "Lane D contract" section; 6 reads `scope` optionally and `staged` off `changes`; nothing sends `readDiff` |
| CHANGELOG | 11 |

No gaps. Lanes B, C and F are untouched apart from Task 7's two additive rows in Lane B's keymap,
which Lane B's own plan explicitly reserves for this lane.

**2. Placeholder scan**

No "TBD", no "similar to Task N", no "add error handling here". Every implementation step carries
real code; every test step carries real assertions with real expected values. The two places that
depend on a sibling lane's naming (`fileHunks` in Task 7 Step 5, the scope radio's accessible name
in Task 12) say so explicitly and name the fallback rather than leaving a blank.

**3. Type consistency**

- `HunkRange` is declared once in `src/hunk-patch.ts` (Task 1) and imported by `src/git-actions.ts`
  (Task 3), `webview/change-decorations.ts` (Task 8) and `webview/hunk-actions.ts` (Task 4).
  Its `[number, number]` tuples and the `end < start` empty encoding are used identically in
  `hunkRange`, `markerRange`, `spansOverlap` and `emptyRange`.
- `HunkOp` is declared in `src/git-actions.ts` (Task 3) and re-used verbatim by
  `HunkActionRequest.op`, `HunkOutcome`, and the `SAID` record (Task 4) — three ops, no fourth.
- `GitActionPlan`'s `hunk` variant (`op`, `diffArgs`, `applyArgs`, `range`) is produced by
  `planGitAction` and consumed by `runHunkPlan` with the same four fields; `buildHunkPlan` returns
  exactly the two arrays that variant spreads.
- `GitActionResult` gains `message?: string` in Task 3 and is read as `res.message` in Task 4;
  the legacy `{ ok: false; error }` callers in `app.tsx` are unaffected.
- `HunkActionHost`'s five members (`root`, `stagedPaths`, `confirmDiscard`, `refreshChanges`,
  `invalidateDiff`) are produced in Task 5 and consumed in Tasks 4, 6 and 10 — `confirmDiscard`
  takes `Omit<ConfirmState, 'onConfirm'>`, which is exactly what `discardConfirm` returns and what
  Task 5 spreads into `setConfirm` alongside its own `onConfirm`.
- `HunkActionDeps` (`host`, `gitAction`, `toast`, `announce`) is satisfied in Task 6 by
  `{ host: hunkHost, gitAction, toast: pushToast, announce: setAnnounce }` and in Task 10 by the
  same four with `announce: onAnnounce`; `pushToast`'s `PushToastInput` accepts
  `{ message, variant }`.
- `ChangeMarker` gains `oldRange: [number, number]` and `removedText: string[]` in Task 8; every
  construction site is updated there (`hunksToMarkers`'s two branches, the untracked marker in
  `use-change-markers.ts`) and every literal in `test/unit/change-decorations.test.ts` and
  `test/unit/use-peek-zone.test.ts` carries both.
- `ChangeMarkersApi` gains `untracked: boolean` (Task 8) and is read as `changes.untracked` in
  Task 10; `state`, `markers`, `announcement` and `goToChange` are unchanged, so
  `change-nav-registry`'s consumers in `app.tsx` need no edit.
- `PeekZoneApi` (`index`, `open`, `close`, `next`, `prev`, `portal`) is declared in Task 9 and used
  exactly as declared in Tasks 9 and 10; `render(index, total, close)` matches the three arguments
  `CodeViewer` destructures.
- `PeekEvent`'s five variants are exhaustive in `reducePeek`'s switch (Task 8) and are the only
  values `usePeekZone` constructs (Task 9).
- `ReviewScope`'s three values match Lane D's `scope` union; Task 6 narrows `undefined` to `'all'`
  at the single read site.
- `ReviewAction` gains `'stageHunk' | 'discardHunk'` in Task 7 and both appear in
  `review-view.tsx`'s switch, so the switch stays exhaustive.
- CSS class names `.rhunk__head`, `.rhunk__acts`, `.rhunk__act`, `.peekzone`, `.peek`,
  `.peek__head`, `.peek__act`, `.peek__nav`, `.peek__lines`, `.peek__note` are produced in Tasks 6,
  9 and 10 and asserted in Tasks 10 and 12.

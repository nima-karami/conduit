# Review navigation, keyboard model & persistence (Review supercharge — Lane B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a whole review doable from the keyboard and make its state survive a restart. `j`/`k` walk hunks across files, `J`/`K` walk files, `m` marks the current file reviewed, `o`/`Enter` open it in the editor, `e`/`Shift+E` expand/collapse everything, `?` shows the map. Reviewed marks stop dying with the tab: they live in `userData/review-marks.json`, broadcast to every window, and self-retire when the file changes again. Plus the polish the inventory found: Collapse/Expand all, a file header that actually sticks, source quick-picks (Last commit · Unpushed · Since branch point), an ignore-whitespace toggle, and the dead "Open file" button on an oversize diff.

**Architecture:** Four pure modules carry the logic and are unit-tested in Node — `webview/review-keymap.ts` (key → action, and the hunk/file cursor walk), `src/review-marks.ts` (the marks file model, its FNV-1a content hash and its 2 000/repo cap), `src/range-preset.ts` (the `unpushed` / `branchPoint` resolver with git injected), `webview/review-picker-rows.ts` (which pinned rows the picker shows). The host gains one new persisted file with the exact `sessions.json` treatment (in-memory + `persistFile` + `flushStateSync`), one new broadcast (`review:marks`) and one new request (`git:resolveRange`). `review-view.tsx` stops owning reviewed state — it reads a renderer-side external store fed by that broadcast — and gains one scoped keydown handler on its scroller.

**Tech Stack:** TypeScript (two tsconfigs: host `tsconfig.json`, renderer `tsconfig.webview.json`), React 18, Electron IPC via `src/protocol.ts`, Vitest for unit tests, Playwright-Electron for the e2e scenario, Biome for lint/format.

**Spec:** `docs/specs/2026-08-27-review-supercharge.md` — read the revision note at the top, §0, §2 "Lane B", §3, §4, §5, §7 "Lane B", §8–§12. This plan implements **Lane B only**.

> **What is NOT in this lane.** `s` / `d` (stage / discard a hunk) are **Lane E**; `c` (note on a hunk) is **Lane F**; `/` and `Mod+F` (search in diff) and the navigator's file filter are **Lane C**; the working-source **Scope** control is **Lane D**. Do not bind those keys, do not render disabled buttons for them, and do not list them in the `?` help panel — a help panel that advertises keys that do nothing is worse than one that is short. The keymap module must not carry their action names either.

## Global Constraints

Copied from the spec and from `CLAUDE.md`. Every task's requirements implicitly include this section.

- **The scoped keymap is active only while focus is inside the Review scroller.** Review is a non-editable surface, so single letters are safe there; History owns local arrow keys the same way. **Handled keys stop propagation** so nothing reaches `webview/decide-shortcut.ts` / the window-level app shortcuts. Typing entries (`webview/typing-guard.ts`'s `isTypingEntry`) and Ctrl/Cmd/Alt combinations are ignored. (§2 Lane B, §5)
- **The key table is exactly:** `j`/`k` next/previous hunk (across files, wraps) · `J`/`K` next/previous file · `m` toggle reviewed on the current file · `o`/`Enter` open the current hunk in the editor (the existing `onJumpToHunk`) · `e`/`Shift+E` expand all / collapse all · `?` help · `Esc` closes the help panel first, then Review. (§2 Lane B)
- **"Current hunk" = the hunk header nearest the scroller's anchor** (`computeReviewAnchor`, `webview/review-window.ts`); a visible focus ring marks it; clicking a header also makes it current. It carries `aria-current`. (§2 Lane B, §8, §9)
- **Collapse all / Expand all header buttons with `aria-pressed`; the current file stays in view.** (§2 Lane B, §9)
- **Sticky file header inside each card** (`position: sticky`; the measured-height cache is unaffected). (§2 Lane B)
- **Reviewed marks persist in `userData/review-marks.json`** — per-user, per-machine, high-frequency state, the same home as `sessions.json`; atomic write + sync flush on quit. The host holds it in memory and **broadcasts** `review:marks` to every window on change (windows share one main process — no FS round trip). (§2 Lane B, §5)
  ```ts
  interface ReviewMarksFile {
    version: 1;
    repos: Record<string /* repo root, posix */, Array<{ source: string; path: string; contentHash: string; at: string }>>;
  }
  ```
- **`source` = `'working'` | `commit:<sha>` | `range:<rangeKey>`** — byte-identical to the `sourceKey` `review-view.tsx:272-277` already computes. (§2 Lane B)
- **`contentHash` = FNV-1a of the new-side text** (fast, dependency-free; a collision only yields a stale "reviewed"). **A mismatched hash is ignored and pruned.** **Newest 2 000 per repo kept.** (§2 Lane B, §5)
- **Load gate: mark controls are disabled until the first `review:marks` push arrives.** (§2 Lane B, §4)
- **The `reviewed` array leaves `view-state-store.ts`'s `reviewAnchor` kind**; the scroll anchor stays exactly as it is. (task brief; §2 Lane B makes the store authoritative)
- **`git:resolveRange { sessionId, preset: 'unpushed' | 'branchPoint' }` → `{ base, head }` as SHA endpoints, or `{ error }`.** `rev-parse --abbrev-ref @{upstream}`, `merge-base <default> HEAD`, default = `origin/HEAD` → `main` → `master`. **Sha endpoints, not a preset-shaped `RefEndpoint`,** so `rangeKey` stays a stable cache key and `git:rangeDiff`'s `validateCommits` accepts them. **A row is hidden when unresolvable.** (§2 Lane B, §3, §12.9)
- **Pinned picker rows:** *Last commit* maps onto the existing **commit** source for `HEAD` — no new render path · *Unpushed* · *Since branch point*. (§2 Lane B)
- **Every git spawn goes through `src/git-exec.ts`'s `runGit`.** The renderer never spawns git. (§0)
- **`doc-view.tsx` passes `onOpenFile` to `DiffViewer`** — the oversize notice's "Open file" is dead today because no caller passes it. (§0, §2 Lane B)
- **Ignore whitespace:** header toggle, persisted as `reviewIgnoreWhitespace`, **default off**; `computeFileReview` gains an equality option comparing whitespace-collapsed lines **while rendering real text**. (§2 Lane B, §5)
- **`computeFileReview` already took a 4th positional `maxLcsCells` in Lane A** (`feat/review-lane-a-editor-markers`). Do not renumber or repurpose it.
- **Announcements** go through the existing `sr-only` `role="status"` `aria-live="polite"` region in `review-view.tsx:720-722`: "Marked reviewed" / "Unmarked". (§10)
- **i18n:** none — English literals, repo convention. (§1, §10)
- **NEVER write redundant comments.** A comment explains *why* (a non-obvious constraint or gotcha), never restates *what* the code says. Don't re-explain a decision that lives in the spec — link to it (`// see spec 2026-08-27-review-supercharge §2 Lane B`). (`CLAUDE.md`)
- **Fix root causes, no band-aids.** No `!important`, no specificity escalation, no `as any` / `@ts-ignore`. (`CLAUDE.md`)
- **Two tsconfigs.** `npm run typecheck` runs both. Never put a `node:` import in a module the renderer imports at runtime — `src/review-marks.ts` and `src/range-preset.ts` are imported by BOTH sides, so they stay node-free. (`CLAUDE.md`)
- **CI `verify` runs on `ubuntu-latest`.** Never let a unit test depend on `process.platform`, `path.sep`, or drive-letter casing. Repo roots are normalised to posix inside the code under test. (`CLAUDE.md`)
- **`npm run verify` is the gate.** Never disable, downgrade, narrow, or defer one of its checks. (`CLAUDE.md`)
- **The e2e scenario runs hidden** on the shared harness (`test/e2e/harness.mjs`, `CONDUIT_E2E=1` → `show:false`). Run it **alone** on a quiet machine; a loaded machine fails PTY-adjacent e2es the way a broken PTY does. (`CLAUDE.md`)
- **Scratch artifacts never land in the repo.** Screenshots go to an absolute path under `%TEMP%\claude-scratch`. (`CLAUDE.md`)
- **Docs layout is a contract (ADR 0003).** User-facing changes go in root `CHANGELOG.md`.

## Assumptions

Recorded because this is an unattended pipeline — no questions were asked.

1. **`review:marks` carries a LIST of per-repo entries, not §3's single `{ root, marks }`.**
   `{ type: 'review:marks'; repos: Array<{ root: string; marks: ReviewMark[] }> }`. A per-root push has no defined trigger for a repo that has *no* marks yet, so the load gate (§2 Lane B: "controls disabled until the first push arrives") would never open in the commonest case — a fresh install. As a list, one message type covers both the initial full load (every repo in the file, possibly zero) and a single-repo change, and the change payload stays small (one repo, capped at 2 000). The renderer merges by root and flips `loaded` on the first message of either kind.
2. **The initial push is a `reply`, not a `broadcast`.** It is sent from `case 'ready'` to the window that just loaded, exactly like `restoreDocs` (`electron/main.ts:1754`). Broadcasting a full snapshot every time any window reloads would re-push it to windows that already have it. Changes still broadcast.
3. **`git:resolveRange` carries a `requestId`** even though §3 doesn't list it. Every other latest-wins host request in this repo carries one (`git:history`, `git:rangeDiff`, `git:commitDiff`); the picker fires two presets on open and must be able to drop a stale reply.
4. **`resolveRangePreset` reports "resolved but empty" as an `error`.** `base === head` for *Unpushed* (nothing unpushed) and `merge-base === HEAD` for *Since branch point* (this IS the default branch) both produce a comparison with no content. §2 Lane B says a row is hidden when unresolvable, and a row that opens an empty Review is worse than no row.
5. **`computeFileReview` takes ignore-whitespace as an options object in a 5th parameter**, `opts: ReviewOptions = {}`, not a 5th positional boolean. Lane A's 4th positional `maxLcsCells` stays exactly where it is; a fifth positional `boolean` would be a boolean trap and the next option would make it six.
6. **Ignore-whitespace collapses runs of whitespace and trims the ends** (`\s+` → one space, then trim) — git's `-b`, plus leading/trailing. Full `-w` (ignore *all* whitespace, including between tokens) would call `a + b` and `a+b` identical, which is a real change in most languages this repo's users write.
7. **Under ignore-whitespace, a context line renders the NEW side's text.** Today both sides of a `context` op are byte-identical so the choice is invisible; once lines match loosely, only the new side is what the file actually contains. This is what "rendering real text" means in the task brief.
8. **The reviewed toggle needs the file's diff.** The mark's hash is taken from the new-side text, so a file whose diff hasn't streamed in yet (the working source loads per card) cannot be marked: its checkbox is disabled with the title "Loading diff…". Every keyboard path (`m` acts on the *current* file, which is on screen and therefore loaded) is unaffected.
9. **A hash-mismatched mark is retired by the renderer**, which posts `review:setMark { on: false }` for it once the file's diff is loaded and disagrees. The host has no file text, so it cannot prune by hash on its own, and inventing a "prune" message would be a second way to say `setMark(off)`.
10. **The unknown hunk count of an unmounted card is seeded from the change's own `added + removed`.** Only mounted cards have run `computeFileReview`; re-running it in the parent for every file would undo the virtualization the Review list exists for. `added + removed > 0` answers the only question navigation asks of an unloaded file — does it have a hunk at all — and a mounted card corrects the count the moment it reports.
11. **The scroller takes `tabIndex={-1}` and claims focus once on mount.** Opening Review from a tab click leaves focus on the tab, so a keymap scoped to "focus inside the scroller" would be dead until the user clicked. A modal claims focus the same way.
12. **Collapse all / Expand all report the LAST BULK ACTION through `aria-pressed`**, not a live "are all cards collapsed" fold. Deriving the live answer would mean the parent re-rendering on every individual card's collapse toggle, which the per-path `uiCacheRef` exists to avoid.
13. **`.rcard`'s `overflow: hidden` is the reason the sticky header never sticks.** `.rcard__head` already declares `position: sticky; top: 0` (`webview/styles.css:9182-9192`), but `overflow: hidden` makes `.rcard` its own scroll container, and a sticky box is offset against its nearest scrollport — a scrollport that never scrolls. `overflow: clip` clips identically (the border-radius still holds) without creating one. That is the root-cause fix; adding a second sticky wrapper would be the band-aid.
14. **The bulk-collapse "keep the current file in view" re-anchors on each measurement until the offset stops moving.** Collapsing every card at once invalidates the scroll offset entirely, and the `ResizeObserver` reports the new heights over the next frame or two. Re-resolving the anchor inside `onMeasure` until it agrees converges without a timer.
15. **The header action row lives in the navigator aside.** With the navigator collapsed to its rail there is no room for four controls; the keyboard (`e` / `Shift+E` / `?`) still reaches all of them, and the rail is a deliberate "get the chrome out of my way" state.
16. **The e2e's "no upstream" fixture is a plain `git init` repo.** With no remote, `@{upstream}` fails *and* `origin/HEAD` doesn't resolve, and `main`/`master` (whichever `init.defaultBranch` produced) merge-bases to HEAD itself — so **both** Unpushed and Since branch point are correctly hidden, and *Last commit* is present. That covers §7's "fixture without upstream hides Unpushed" without needing a second repo to push to.
17. **`review-marks.json` is asserted to exist on disk in the e2e**, and the fixture repo's `git status --porcelain` is asserted unchanged by marking — that is §7's "the mark shall not appear as a change in the repo".
18. **Moving the ring and *revealing* it are separate.** The cursor is `{ ref, reveal }` and only an explicit move (a key, a header click for the ref alone) touches `reveal`; following the scroll anchor never does. Without the split, scrolling with the mouse would move the ring to the newly-anchored file, and the reveal effect would immediately scroll that file's first hunk header back into view — the viewport would fight the wheel.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `webview/review-keymap.ts` | Pure: key → `ReviewAction`; the hunk/file cursor walk with wrapping; anchor sync; ref clamping. |
| `src/review-marks.ts` | Pure, node-free: `ReviewMarksFile` model, FNV-1a `contentHash`, per-repo cap, parse/serialize, add/remove, the renderer's merge reducer. |
| `src/range-preset.ts` | Pure, node-free: `resolveRangePreset` with the three git primitives injected. |
| `webview/review-picker-rows.ts` | Pure: which pinned source rows the commit picker shows, and what each selects. |
| `webview/review-marks-store.ts` | Renderer external store (mirrors `dirty-store.ts`): subscribes to `review:marks`, exposes a snapshot + `setMark`. |
| `test/unit/review-keymap.test.ts`, `test/unit/review-marks.test.ts`, `test/unit/range-preset.test.ts`, `test/unit/review-picker-rows.test.ts`, `test/unit/review-hunks-whitespace.test.ts`, `test/unit/review-sticky-header.test.ts` | Unit coverage. |
| `test/e2e/review-keymap-persist.e2e.mjs` | The lane's host-boundary scenario (two launches, one `userDataDir`). |

**Modified**

| File | Change |
|---|---|
| `src/protocol.ts` | `ReviewMark`, `RangePreset`; `review:marks` + `git:resolveRangeResult` replies; `review:setMark` + `git:resolveRange` requests. |
| `electron/main.ts` | `reviewMarksFile()`; in-memory marks + `persistFile` + `flushStateSync`; initial push in `case 'ready'`; `case 'review:setMark'`; `case 'git:resolveRange'`. |
| `webview/bridge.ts` | Preview (no-host) replies for the two new requests. |
| `src/review-hunks.ts` | `ReviewOptions` / `ignoreWhitespace`; `diffLines` compares keys and emits new-side context text. |
| `src/settings.ts` | `reviewIgnoreWhitespace` — type, default, coercion. |
| `webview/view-state-store.ts` | Drop `reviewed` from the `reviewAnchor` kind and from `mergeReviewViewState`. |
| `webview/components/review-view.tsx` | Marks store; scoped keymap; current-hunk ring; help panel; Collapse/Expand all; ignore-whitespace toggle. |
| `webview/components/commit-picker-menu.tsx` | Pinned rows fed by `git:resolveRange`. |
| `webview/components/doc-view.tsx` | Pass `onOpenFile` to `DiffViewer`. |
| `webview/styles.css` | `.rcard` `overflow: clip`; `.review__actions`; current-hunk ring; help panel. |
| `test/unit/view-state-store.test.ts`, `test/unit/coerce-settings.test.ts` | Extend / trim for the changed shapes. |
| `CHANGELOG.md` | `[Unreleased]` → `### Added` / `### Fixed`. |

---

## Task 1: The pure Review keymap (`webview/review-keymap.ts`)

**Files:**
- Create: `webview/review-keymap.ts`
- Test: `test/unit/review-keymap.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type ReviewAction = 'nextHunk' | 'prevHunk' | 'nextFile' | 'prevFile' | 'toggleReviewed' | 'openHunk' | 'expandAll' | 'collapseAll' | 'toggleHelp'`
  - `export interface ReviewKeyEvent { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }`
  - `export interface ReviewFileHunks { path: string; hunkCount: number }`
  - `export interface HunkRef { fileIndex: number; hunkIndex: number }`
  - `export const REVIEW_KEY_HELP: ReadonlyArray<{ keys: string; description: string }>`
  - `export function reviewActionFor(e: ReviewKeyEvent): ReviewAction | null`
  - `export function firstRef(files: readonly ReviewFileHunks[]): HunkRef | null`
  - `export function clampRef(ref: HunkRef | null, files: readonly ReviewFileHunks[]): HunkRef | null`
  - `export function nextHunk / prevHunk / nextFile / prevFile (files, current: HunkRef | null): HunkRef | null`
  - `export function syncToAnchor(current: HunkRef | null, files: readonly ReviewFileHunks[], anchorIndex: number): HunkRef | null`

`hunkIndex === -1` means "this file is current but has no hunk to point at" — a binary file, or one whose diff hasn't loaded. `j`/`k` skip such files; `J`/`K` do not, because they navigate *files*.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review-keymap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  clampRef,
  firstRef,
  type HunkRef,
  nextFile,
  nextHunk,
  prevFile,
  prevHunk,
  REVIEW_KEY_HELP,
  reviewActionFor,
  type ReviewFileHunks,
  syncToAnchor,
} from '../../webview/review-keymap';

const press = (key: string, mods: Partial<Omit<Parameters<typeof reviewActionFor>[0], 'key'>> = {}) =>
  reviewActionFor({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

/** a.ts: 2 hunks · bin.png: none (binary) · c.ts: 1 hunk. */
const FILES: ReviewFileHunks[] = [
  { path: 'a.ts', hunkCount: 2 },
  { path: 'bin.png', hunkCount: 0 },
  { path: 'c.ts', hunkCount: 1 },
];
const ref = (fileIndex: number, hunkIndex: number): HunkRef => ({ fileIndex, hunkIndex });

describe('reviewActionFor', () => {
  it('maps the navigation keys', () => {
    expect(press('j')).toBe('nextHunk');
    expect(press('k')).toBe('prevHunk');
    expect(press('J', { shiftKey: true })).toBe('nextFile');
    expect(press('K', { shiftKey: true })).toBe('prevFile');
  });

  it('maps the action keys', () => {
    expect(press('m')).toBe('toggleReviewed');
    expect(press('o')).toBe('openHunk');
    expect(press('Enter')).toBe('openHunk');
    expect(press('e')).toBe('expandAll');
    expect(press('E', { shiftKey: true })).toBe('collapseAll');
    expect(press('?', { shiftKey: true })).toBe('toggleHelp');
  });

  it('accepts ? without shift, for layouts that do not need it', () => {
    expect(press('?')).toBe('toggleHelp');
  });

  it('ignores every Ctrl / Cmd / Alt combination', () => {
    expect(press('j', { ctrlKey: true })).toBeNull();
    expect(press('j', { metaKey: true })).toBeNull();
    expect(press('j', { altKey: true })).toBeNull();
    expect(press('Enter', { ctrlKey: true })).toBeNull();
  });

  it('ignores a shifted press of an unshifted binding', () => {
    expect(press('Enter', { shiftKey: true })).toBeNull();
    expect(press('m', { shiftKey: true })).toBeNull();
  });

  it('ignores keys this lane does not own', () => {
    // s/d are Lane E, c is Lane F, / and f are Lane C. Binding them here would advertise
    // behaviour that does not exist yet.
    for (const key of ['s', 'd', 'c', '/', 'f', 'g', 'ArrowDown', ' ']) {
      expect(press(key)).toBeNull();
    }
  });

  it('publishes a help table covering exactly the bound keys', () => {
    const described = REVIEW_KEY_HELP.map((r) => r.keys).join(' ');
    for (const token of ['j', 'k', 'J', 'K', 'm', 'o', 'e', '?', 'Esc']) {
      expect(described).toContain(token);
    }
    expect(described).not.toContain('Stage');
  });
});

describe('firstRef / clampRef', () => {
  it('starts on the first file that has a hunk', () => {
    expect(firstRef(FILES)).toEqual(ref(0, 0));
    expect(firstRef([{ path: 'bin.png', hunkCount: 0 }])).toEqual(ref(0, -1));
    expect(firstRef([])).toBeNull();
  });

  it('clamps a file index past the end of a shrunken list', () => {
    expect(clampRef(ref(9, 0), FILES)).toEqual(ref(2, 0));
  });

  it('clamps a hunk index past the end of its file', () => {
    expect(clampRef(ref(0, 7), FILES)).toEqual(ref(0, 1));
  });

  it('drops a hunk index for a file that has none, and adopts one for a file that does', () => {
    expect(clampRef(ref(1, 0), FILES)).toEqual(ref(1, -1));
    expect(clampRef(ref(2, -1), FILES)).toEqual(ref(2, 0));
  });

  it('is null for an empty list or a null ref', () => {
    expect(clampRef(ref(0, 0), [])).toBeNull();
    expect(clampRef(null, FILES)).toBeNull();
  });
});

describe('nextHunk / prevHunk', () => {
  it('walks within a file, then crosses to the next file that has hunks', () => {
    expect(nextHunk(FILES, ref(0, 0))).toEqual(ref(0, 1));
    // bin.png has no hunk — j skips it entirely.
    expect(nextHunk(FILES, ref(0, 1))).toEqual(ref(2, 0));
  });

  it('wraps forward to the first file with hunks', () => {
    expect(nextHunk(FILES, ref(2, 0))).toEqual(ref(0, 0));
  });

  it('walks back into the LAST hunk of the previous file with hunks', () => {
    expect(prevHunk(FILES, ref(2, 0))).toEqual(ref(0, 1));
    expect(prevHunk(FILES, ref(0, 1))).toEqual(ref(0, 0));
  });

  it('wraps backward from the first hunk to the last hunk in the list', () => {
    expect(prevHunk(FILES, ref(0, 0))).toEqual(ref(2, 0));
  });

  it('starts from the first hunk when nothing is current', () => {
    expect(nextHunk(FILES, null)).toEqual(ref(0, 0));
    expect(prevHunk(FILES, null)).toEqual(ref(0, 0));
  });

  it('a single hunk wraps to itself', () => {
    const one: ReviewFileHunks[] = [{ path: 'a.ts', hunkCount: 1 }];
    expect(nextHunk(one, ref(0, 0))).toEqual(ref(0, 0));
    expect(prevHunk(one, ref(0, 0))).toEqual(ref(0, 0));
  });

  it('stays put when no file in the list has a hunk', () => {
    const none: ReviewFileHunks[] = [{ path: 'bin.png', hunkCount: 0 }];
    expect(nextHunk(none, ref(0, -1))).toEqual(ref(0, -1));
    expect(prevHunk(none, ref(0, -1))).toEqual(ref(0, -1));
  });

  it('is null for an empty list', () => {
    expect(nextHunk([], null)).toBeNull();
    expect(prevHunk([], ref(0, 0))).toBeNull();
  });
});

describe('nextFile / prevFile', () => {
  it('moves by file INCLUDING files with no hunks, landing on their first hunk', () => {
    expect(nextFile(FILES, ref(0, 1))).toEqual(ref(1, -1));
    expect(nextFile(FILES, ref(1, -1))).toEqual(ref(2, 0));
  });

  it('wraps in both directions', () => {
    expect(nextFile(FILES, ref(2, 0))).toEqual(ref(0, 0));
    expect(prevFile(FILES, ref(0, 0))).toEqual(ref(2, 0));
  });

  it('starts from the first file when nothing is current', () => {
    expect(nextFile(FILES, null)).toEqual(ref(0, 0));
  });
});

describe('syncToAnchor', () => {
  it('adopts the anchored file when the cursor is somewhere else', () => {
    expect(syncToAnchor(ref(0, 1), FILES, 2)).toEqual(ref(2, 0));
  });

  it('leaves the cursor alone while it is already inside the anchored file', () => {
    expect(syncToAnchor(ref(0, 1), FILES, 0)).toEqual(ref(0, 1));
  });

  it('seeds the cursor from the anchor when there is none', () => {
    expect(syncToAnchor(null, FILES, 1)).toEqual(ref(1, -1));
  });

  it('falls back to clamping when the anchor index is out of range', () => {
    expect(syncToAnchor(ref(0, 9), FILES, -1)).toEqual(ref(0, 1));
    expect(syncToAnchor(null, FILES, -1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-keymap.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/review-keymap"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview/review-keymap.ts`:

```ts
/**
 * The Review surface's scoped keyboard model (spec 2026-08-27-review-supercharge §2 Lane B).
 * DOM-free: `reviewActionFor` takes the four modifier flags and a `key`, and the cursor walk is
 * a fold over `{ path, hunkCount }` — so the whole model is unit-testable in Node exactly like
 * review-window.ts, and the React layer only owns focus, scrolling and propagation.
 *
 * Keys this lane does NOT bind: `s`/`d` (Lane E), `c` (Lane F), `/` and `Mod+F` (Lane C).
 */

export type ReviewAction =
  | 'nextHunk'
  | 'prevHunk'
  | 'nextFile'
  | 'prevFile'
  | 'toggleReviewed'
  | 'openHunk'
  | 'expandAll'
  | 'collapseAll'
  | 'toggleHelp';

/** The subset of a KeyboardEvent the mapping reads. */
export interface ReviewKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const ACTIONS: Readonly<Record<string, ReviewAction>> = {
  j: 'nextHunk',
  k: 'prevHunk',
  J: 'nextFile',
  K: 'prevFile',
  m: 'toggleReviewed',
  o: 'openHunk',
  Enter: 'openHunk',
  e: 'expandAll',
  E: 'collapseAll',
  '?': 'toggleHelp',
};

/** What the `?` panel prints. Kept beside the table so the two can't drift. */
export const REVIEW_KEY_HELP: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: 'j / k', description: 'Next / previous change' },
  { keys: 'J / K', description: 'Next / previous file' },
  { keys: 'm', description: 'Mark the current file reviewed' },
  { keys: 'o / Enter', description: 'Open the current change in the editor' },
  { keys: 'e / Shift+E', description: 'Expand / collapse every file' },
  { keys: '?', description: 'Show this list' },
  { keys: 'Esc', description: 'Close this list, then close Review' },
];

export function reviewActionFor(e: ReviewKeyEvent): ReviewAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  // `key` already encodes shift for letters (`J` is the shifted `j`), so the only shifted press
  // left to reject is one of an UNSHIFTED binding — Shift+Enter, Shift+m.
  if (e.shiftKey && (e.key === 'Enter' || /^[a-z]$/.test(e.key))) return null;
  return ACTIONS[e.key] ?? null;
}

/** One file as the cursor sees it. `hunkCount` 0 ⇒ binary, or a diff that hasn't loaded. */
export interface ReviewFileHunks {
  path: string;
  hunkCount: number;
}

/** `hunkIndex` -1 ⇒ the file is current but has no hunk to point at. */
export interface HunkRef {
  fileIndex: number;
  hunkIndex: number;
}

const atFile = (files: readonly ReviewFileHunks[], i: number): HunkRef => ({
  fileIndex: i,
  hunkIndex: files[i].hunkCount > 0 ? 0 : -1,
});

export function firstRef(files: readonly ReviewFileHunks[]): HunkRef | null {
  if (files.length === 0) return null;
  for (let i = 0; i < files.length; i++) if (files[i].hunkCount > 0) return { fileIndex: i, hunkIndex: 0 };
  return atFile(files, 0);
}

/** Bring a ref back inside a list that has since changed (files added, removed, reordered). */
export function clampRef(
  ref: HunkRef | null,
  files: readonly ReviewFileHunks[],
): HunkRef | null {
  if (!ref || files.length === 0) return null;
  const fileIndex = Math.min(Math.max(ref.fileIndex, 0), files.length - 1);
  const count = files[fileIndex].hunkCount;
  if (count <= 0) return { fileIndex, hunkIndex: -1 };
  return { fileIndex, hunkIndex: Math.min(Math.max(ref.hunkIndex, 0), count - 1) };
}

/** The next/previous file index that has at least one hunk, or -1 when none does. */
function stepToHunkFile(
  files: readonly ReviewFileHunks[],
  from: number,
  delta: 1 | -1,
): number {
  const n = files.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + delta * step) % n) + n) % n;
    if (files[i].hunkCount > 0) return i;
  }
  return -1;
}

export function nextHunk(
  files: readonly ReviewFileHunks[],
  current: HunkRef | null,
): HunkRef | null {
  const cur = clampRef(current, files);
  if (!cur) return firstRef(files);
  const count = files[cur.fileIndex].hunkCount;
  if (cur.hunkIndex >= 0 && cur.hunkIndex + 1 < count) {
    return { fileIndex: cur.fileIndex, hunkIndex: cur.hunkIndex + 1 };
  }
  const i = stepToHunkFile(files, cur.fileIndex, 1);
  // A single hunk in the whole changeset wraps to itself; nothing to walk at all stays put.
  return i < 0 ? cur : { fileIndex: i, hunkIndex: 0 };
}

export function prevHunk(
  files: readonly ReviewFileHunks[],
  current: HunkRef | null,
): HunkRef | null {
  const cur = clampRef(current, files);
  if (!cur) return firstRef(files);
  if (cur.hunkIndex > 0) return { fileIndex: cur.fileIndex, hunkIndex: cur.hunkIndex - 1 };
  const i = stepToHunkFile(files, cur.fileIndex, -1);
  return i < 0 ? cur : { fileIndex: i, hunkIndex: Math.max(0, files[i].hunkCount - 1) };
}

function stepFile(
  files: readonly ReviewFileHunks[],
  current: HunkRef | null,
  delta: 1 | -1,
): HunkRef | null {
  const cur = clampRef(current, files);
  if (!cur) return firstRef(files);
  const n = files.length;
  return atFile(files, (((cur.fileIndex + delta) % n) + n) % n);
}

export function nextFile(files: readonly ReviewFileHunks[], current: HunkRef | null) {
  return stepFile(files, current, 1);
}

export function prevFile(files: readonly ReviewFileHunks[], current: HunkRef | null) {
  return stepFile(files, current, -1);
}

/**
 * Follow the scroller: once the top-visible card is a DIFFERENT file from the one the cursor
 * sits in, the cursor moves to it. Scrolling is how the user says "I'm looking at this now",
 * and a ring left three files behind would make the next `j` jump somewhere unexpected.
 */
export function syncToAnchor(
  current: HunkRef | null,
  files: readonly ReviewFileHunks[],
  anchorIndex: number,
): HunkRef | null {
  if (anchorIndex < 0 || anchorIndex >= files.length) return clampRef(current, files);
  if (current && current.fileIndex === anchorIndex) return clampRef(current, files);
  return atFile(files, anchorIndex);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/review-keymap.test.ts`
Expected: PASS — 25 tests.

- [ ] **Step 5: Commit**

```bash
git add webview/review-keymap.ts test/unit/review-keymap.test.ts
git commit -m "feat(review): add the pure scoped keymap and hunk/file cursor walk"
```

---

## Task 2: The reviewed-marks model (`src/review-marks.ts`)

**Files:**
- Create: `src/review-marks.ts`
- Test: `test/unit/review-marks.test.ts`

**Interfaces:**
- Consumes: `ReviewMark` from `src/protocol.ts` — **added in Task 4**. To keep this task independently green, declare and export `ReviewMark` **here** in Task 2 and have Task 4 re-export it from `src/protocol.ts` (`export type { ReviewMark } from './review-marks'`), which is also the honest direction of ownership: the wire shape is the file shape.
- Produces:
  - `export interface ReviewMark { source: string; path: string; contentHash: string; at: string }`
  - `export interface ReviewMarksFile { version: 1; repos: Record<string, ReviewMark[]> }`
  - `export interface ReviewMarksRepo { root: string; marks: ReviewMark[] }`
  - `export const MAX_MARKS_PER_REPO = 2000`
  - `export function contentHash(text: string): string`
  - `export function normalizeRoot(root: string): string`
  - `export function emptyMarksFile(): ReviewMarksFile`
  - `export function parseMarksFile(blob: string | undefined): ReviewMarksFile`
  - `export function serializeMarksFile(file: ReviewMarksFile): string`
  - `export function marksFor(file: ReviewMarksFile, root: string): ReviewMark[]`
  - `export function setMarkList(marks: readonly ReviewMark[], mark: ReviewMark, on: boolean): ReviewMark[]`
  - `export function setMark(file: ReviewMarksFile, root: string, mark: ReviewMark, on: boolean): ReviewMarksFile`
  - `export function reviewedPaths(marks: readonly ReviewMark[], source: string, hashes: ReadonlyMap<string, string>): Set<string>`
  - `export function staleMarks(marks: readonly ReviewMark[], source: string, hashes: ReadonlyMap<string, string>): ReviewMark[]`
  - `export function applyMarksPush(byRoot: ReadonlyMap<string, readonly ReviewMark[]>, repos: readonly ReviewMarksRepo[]): Map<string, readonly ReviewMark[]>`

Node-free: the host reads/writes the file with it and the renderer hashes + folds with it, so a `node:` import would break the webview tsconfig.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review-marks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  applyMarksPush,
  contentHash,
  emptyMarksFile,
  MAX_MARKS_PER_REPO,
  marksFor,
  normalizeRoot,
  parseMarksFile,
  type ReviewMark,
  reviewedPaths,
  serializeMarksFile,
  setMark,
  setMarkList,
  staleMarks,
} from '../../src/review-marks';

const mark = (over: Partial<ReviewMark> = {}): ReviewMark => ({
  source: 'working',
  path: 'src/a.ts',
  contentHash: 'deadbeef',
  at: '2026-08-27T10:00:00.000Z',
  ...over,
});

describe('contentHash', () => {
  it('is stable, 8 hex chars, and differs for different text', () => {
    expect(contentHash('hello')).toMatch(/^[0-9a-f]{8}$/);
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('hellp'));
  });

  it('notices a whitespace-only difference — a re-indent IS a change to a mark', () => {
    expect(contentHash('  a\n')).not.toBe(contentHash('\ta\n'));
  });

  it('hashes the empty string without throwing', () => {
    expect(contentHash('')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is not platform-dependent: it reads UTF-16 units, never bytes', () => {
    expect(contentHash('é')).toBe(contentHash('\u00e9'));
  });
});

describe('normalizeRoot', () => {
  it('makes a windows root posix and drops a trailing separator', () => {
    expect(normalizeRoot('C:\\work\\repo\\')).toBe('C:/work/repo');
    expect(normalizeRoot('/home/u/repo/')).toBe('/home/u/repo');
  });
});

describe('parseMarksFile / serializeMarksFile', () => {
  it('round-trips', () => {
    const file = setMark(emptyMarksFile(), '/repo', mark(), true);
    expect(parseMarksFile(serializeMarksFile(file))).toEqual(file);
  });

  it('treats absent, empty, malformed and wrong-version blobs as empty', () => {
    expect(parseMarksFile(undefined)).toEqual(emptyMarksFile());
    expect(parseMarksFile('')).toEqual(emptyMarksFile());
    expect(parseMarksFile('{oh no')).toEqual(emptyMarksFile());
    expect(parseMarksFile('[]')).toEqual(emptyMarksFile());
    expect(parseMarksFile(JSON.stringify({ version: 2, repos: {} }))).toEqual(emptyMarksFile());
  });

  it('drops entries that are not marks and keeps the rest of the repo', () => {
    const blob = JSON.stringify({
      version: 1,
      repos: { '/repo': [mark(), { path: 'b.ts' }, null, 'nope'] },
    });
    expect(marksFor(parseMarksFile(blob), '/repo')).toEqual([mark()]);
  });

  it('normalises repo keys on read so a windows root can only be stored once', () => {
    const blob = JSON.stringify({ version: 1, repos: { 'C:\\work\\repo': [mark()] } });
    expect(marksFor(parseMarksFile(blob), 'C:/work/repo')).toEqual([mark()]);
  });

  it('caps an over-long repo on read, newest first', () => {
    const many = Array.from({ length: MAX_MARKS_PER_REPO + 5 }, (_, i) =>
      mark({ path: `f${i}.ts`, at: `2026-08-27T10:00:${String(i % 60).padStart(2, '0')}.000Z` }),
    );
    const parsed = parseMarksFile(JSON.stringify({ version: 1, repos: { '/repo': many } }));
    expect(marksFor(parsed, '/repo')).toHaveLength(MAX_MARKS_PER_REPO);
  });
});

describe('setMarkList', () => {
  it('adds a mark', () => {
    expect(setMarkList([], mark(), true)).toEqual([mark()]);
  });

  it('replaces the existing mark for the same source+path rather than duplicating it', () => {
    const next = setMarkList([mark()], mark({ contentHash: 'cafe0000', at: 'z' }), true);
    expect(next).toHaveLength(1);
    expect(next[0].contentHash).toBe('cafe0000');
  });

  it('keeps the same path under a different source as a separate mark', () => {
    const next = setMarkList([mark()], mark({ source: 'commit:abc' }), true);
    expect(next).toHaveLength(2);
  });

  it('removes a mark, matching on source+path only', () => {
    expect(setMarkList([mark()], mark({ contentHash: 'whatever' }), false)).toEqual([]);
  });

  it('removing something absent is a no-op', () => {
    expect(setMarkList([mark()], mark({ path: 'other.ts' }), false)).toEqual([mark()]);
  });

  it('keeps the NEWEST 2 000 when the cap is exceeded', () => {
    const old = Array.from({ length: MAX_MARKS_PER_REPO }, (_, i) =>
      mark({ path: `f${i}.ts`, at: '2020-01-01T00:00:00.000Z' }),
    );
    const next = setMarkList(old, mark({ path: 'fresh.ts', at: '2030-01-01T00:00:00.000Z' }), true);
    expect(next).toHaveLength(MAX_MARKS_PER_REPO);
    expect(next.some((m) => m.path === 'fresh.ts')).toBe(true);
  });
});

describe('setMark', () => {
  it('keys repos by their normalised root', () => {
    const file = setMark(emptyMarksFile(), 'C:\\work\\repo\\', mark(), true);
    expect(Object.keys(file.repos)).toEqual(['C:/work/repo']);
  });

  it('does not mutate the file it was given', () => {
    const before = emptyMarksFile();
    setMark(before, '/repo', mark(), true);
    expect(before.repos).toEqual({});
  });

  it('drops a repo key once its last mark is cleared', () => {
    const one = setMark(emptyMarksFile(), '/repo', mark(), true);
    expect(setMark(one, '/repo', mark(), false).repos).toEqual({});
  });
});

describe('reviewedPaths / staleMarks', () => {
  const marks = [
    mark({ path: 'a.ts', contentHash: 'aaaa1111' }),
    mark({ path: 'b.ts', contentHash: 'bbbb2222' }),
    mark({ path: 'c.ts', contentHash: 'cccc3333', source: 'commit:abc' }),
  ];
  const hashes = new Map([
    ['a.ts', 'aaaa1111'],
    ['b.ts', 'CHANGED0'],
  ]);

  it('counts only marks of THIS source whose hash still matches', () => {
    expect([...reviewedPaths(marks, 'working', hashes)]).toEqual(['a.ts']);
  });

  it('an unloaded file (no hash yet) is neither reviewed nor stale', () => {
    expect(reviewedPaths(marks, 'commit:abc', new Map()).size).toBe(0);
    expect(staleMarks(marks, 'commit:abc', new Map())).toEqual([]);
  });

  it('reports exactly the marks whose loaded file has changed since', () => {
    expect(staleMarks(marks, 'working', hashes).map((m) => m.path)).toEqual(['b.ts']);
  });
});

describe('applyMarksPush', () => {
  it('replaces the pushed roots and leaves the others alone', () => {
    const before = new Map<string, readonly ReviewMark[]>([
      ['/one', [mark()]],
      ['/two', [mark({ path: 'x.ts' })]],
    ]);
    const after = applyMarksPush(before, [{ root: '/one', marks: [] }]);
    expect(after.get('/one')).toEqual([]);
    expect(after.get('/two')).toEqual([mark({ path: 'x.ts' })]);
  });

  it('normalises the pushed root', () => {
    const after = applyMarksPush(new Map(), [{ root: 'C:\\work\\repo', marks: [mark()] }]);
    expect(after.get('C:/work/repo')).toEqual([mark()]);
  });

  it('an empty push is still a push — it returns a map, not the same reference', () => {
    const before = new Map<string, readonly ReviewMark[]>();
    expect(applyMarksPush(before, [])).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-marks.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/review-marks"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/review-marks.ts`:

```ts
/**
 * The reviewed-marks model (spec 2026-08-27-review-supercharge §2 Lane B). Node-free on purpose:
 * the HOST reads/writes userData/review-marks.json with it and the RENDERER hashes the new-side
 * text and folds the marks into a path set with it, so both sides can only ever disagree by
 * disagreeing with this file.
 *
 * Marks are per-user, per-machine, high-frequency state — the same home as sessions.json — and
 * deliberately NOT `.conduit/` (§5): marking a file read must never show up as a change in the
 * tree the user is reviewing.
 */

/** One "I've read this file" mark. Identity is `source` + `path`; `contentHash` is the receipt. */
export interface ReviewMark {
  /** The Review source it was made under: 'working' | `commit:<sha>` | `range:<rangeKey>`. */
  source: string;
  /** Repo-relative posix path, exactly as ChangeDTO carries it. */
  path: string;
  /** FNV-1a of the new-side text at the moment of marking; a mismatch retires the mark. */
  contentHash: string;
  /** ISO-8601 UTC — also the cap's sort key. */
  at: string;
}

export interface ReviewMarksFile {
  version: 1;
  /** Keyed by repo root, posix, no trailing separator. */
  repos: Record<string, ReviewMark[]>;
}

/** One repo's slice, as it crosses the wire. */
export interface ReviewMarksRepo {
  root: string;
  marks: ReviewMark[];
}

/** Newest-N bound per repo (§5 "Budgets"). */
export const MAX_MARKS_PER_REPO = 2000;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a (32-bit) over UTF-16 code units, as 8 lowercase hex chars. Dependency-free and cheap
 * enough to run on every diff arrival. A collision only produces a stale "reviewed" badge — it
 * can't lose work — which is what makes 32 bits enough here (§2 Lane B).
 */
export function contentHash(text: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Repo roots reach us from three platforms and two APIs; one spelling per repo or the file
 *  would grow a second key for the same directory. */
export function normalizeRoot(root: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function emptyMarksFile(): ReviewMarksFile {
  return { version: 1, repos: {} };
}

const isMark = (v: unknown): v is ReviewMark => {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.source === 'string' &&
    typeof m.path === 'string' &&
    typeof m.contentHash === 'string' &&
    typeof m.at === 'string'
  );
};

/** Newest first, then cut to the bound. */
const capped = (marks: readonly ReviewMark[]): ReviewMark[] =>
  [...marks].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, MAX_MARKS_PER_REPO);

/** A corrupt or foreign-version file is an EMPTY set of marks, never an error: the next write
 *  replaces it and the user loses a badge, not their work (§4). */
export function parseMarksFile(blob: string | undefined): ReviewMarksFile {
  if (!blob) return emptyMarksFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return emptyMarksFile();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyMarksFile();
  const { version, repos } = parsed as { version?: unknown; repos?: unknown };
  if (version !== 1 || typeof repos !== 'object' || repos === null) return emptyMarksFile();

  const out = emptyMarksFile();
  for (const [root, value] of Object.entries(repos as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const marks = capped(value.filter(isMark));
    if (marks.length > 0) out.repos[normalizeRoot(root)] = marks;
  }
  return out;
}

export function serializeMarksFile(file: ReviewMarksFile): string {
  return JSON.stringify(file, null, 2);
}

export function marksFor(file: ReviewMarksFile, root: string): ReviewMark[] {
  return file.repos[normalizeRoot(root)] ?? [];
}

const sameMark = (a: ReviewMark, b: ReviewMark) => a.source === b.source && a.path === b.path;

/** Add (replacing any prior mark for the same source+path) or remove one mark, capped. */
export function setMarkList(
  marks: readonly ReviewMark[],
  mark: ReviewMark,
  on: boolean,
): ReviewMark[] {
  const without = marks.filter((m) => !sameMark(m, mark));
  return on ? capped([mark, ...without]) : without;
}

export function setMark(
  file: ReviewMarksFile,
  root: string,
  mark: ReviewMark,
  on: boolean,
): ReviewMarksFile {
  const key = normalizeRoot(root);
  const next: ReviewMarksFile = { version: 1, repos: { ...file.repos } };
  const marks = setMarkList(next.repos[key] ?? [], mark, on);
  // An empty repo entry is noise in the file and in every broadcast that carries it.
  if (marks.length > 0) next.repos[key] = marks;
  else delete next.repos[key];
  return next;
}

/**
 * The paths that should read as reviewed: this source's marks whose file is LOADED and still
 * hashes to what it hashed to when marked. A file with no entry in `hashes` hasn't streamed in
 * yet — it is neither reviewed nor stale, because we can't tell.
 */
export function reviewedPaths(
  marks: readonly ReviewMark[],
  source: string,
  hashes: ReadonlyMap<string, string>,
): Set<string> {
  const out = new Set<string>();
  for (const m of marks) {
    if (m.source !== source) continue;
    if (hashes.get(m.path) === m.contentHash) out.add(m.path);
  }
  return out;
}

/** Marks whose loaded file has changed since — the renderer retires these (§2 Lane B). */
export function staleMarks(
  marks: readonly ReviewMark[],
  source: string,
  hashes: ReadonlyMap<string, string>,
): ReviewMark[] {
  return marks.filter((m) => {
    if (m.source !== source) return false;
    const h = hashes.get(m.path);
    return h !== undefined && h !== m.contentHash;
  });
}

/** Fold a `review:marks` push into the renderer's per-root map. Pushed roots are REPLACED
 *  wholesale (the host is authoritative); untouched roots survive. */
export function applyMarksPush(
  byRoot: ReadonlyMap<string, readonly ReviewMark[]>,
  repos: readonly ReviewMarksRepo[],
): Map<string, readonly ReviewMark[]> {
  const next = new Map(byRoot);
  for (const r of repos) next.set(normalizeRoot(r.root), r.marks);
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/review-marks.test.ts`
Expected: PASS — 24 tests.

- [ ] **Step 5: Commit**

```bash
git add src/review-marks.ts test/unit/review-marks.test.ts
git commit -m "feat(review): add the reviewed-marks model with an FNV-1a content receipt"
```

---

## Task 3: The range-preset resolver (`src/range-preset.ts`)

**Files:**
- Create: `src/range-preset.ts`
- Test: `test/unit/range-preset.test.ts`

**Interfaces:**
- Consumes: `RefEndpoint` (type only) from `src/git-range.ts`.
- Produces:
  - `export type RangePreset = 'unpushed' | 'branchPoint'`
  - `export interface RangePresetDeps { upstreamRef(): Promise<string | null>; revParse(ref: string): Promise<string | null>; mergeBase(a: string, b: string): Promise<string | null> }`
  - `export interface ResolvedRange { base: RefEndpoint; head: RefEndpoint }`
  - `export const DEFAULT_BRANCH_REFS: readonly string[]`
  - `export async function resolveRangePreset(preset: RangePreset, deps: RangePresetDeps): Promise<ResolvedRange | { error: string }>`

Every endpoint comes back as `{ kind: 'commit', sha }` — never a branch name — so `rangeKey` stays a stable cache key across a later `git fetch` and `firstInvalidEndpoint`'s `validateCommits` path accepts it unchanged (§2 Lane B). Git is injected; this module spawns nothing, so it runs under vitest in Node and on CI's ubuntu.

- [ ] **Step 1: Write the failing test**

Create `test/unit/range-preset.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BRANCH_REFS,
  type RangePresetDeps,
  resolveRangePreset,
} from '../../src/range-preset';

const HEAD = 'h'.repeat(40);
const UP = 'u'.repeat(40);
const MAIN = 'm'.repeat(40);
const BASE = 'b'.repeat(40);

const deps = (over: Partial<RangePresetDeps> = {}): RangePresetDeps => ({
  upstreamRef: async () => 'origin/feature',
  revParse: async (ref) => (ref === 'HEAD' ? HEAD : ref === 'origin/feature' ? UP : null),
  mergeBase: async () => BASE,
  ...over,
});

describe('resolveRangePreset — unpushed', () => {
  it('resolves upstream…HEAD as two sha endpoints', async () => {
    expect(await resolveRangePreset('unpushed', deps())).toEqual({
      base: { kind: 'commit', sha: UP },
      head: { kind: 'commit', sha: HEAD },
    });
  });

  it('errors when the branch has no upstream', async () => {
    const r = await resolveRangePreset('unpushed', deps({ upstreamRef: async () => null }));
    expect(r).toEqual({ error: 'This branch has no upstream' });
  });

  it('errors when the upstream ref name does not resolve to a commit', async () => {
    const r = await resolveRangePreset(
      'unpushed',
      deps({ revParse: async (ref) => (ref === 'HEAD' ? HEAD : null) }),
    );
    expect(r).toEqual({ error: 'This branch has no upstream' });
  });

  it('errors when everything is already pushed', async () => {
    const r = await resolveRangePreset(
      'unpushed',
      deps({ revParse: async () => HEAD }),
    );
    expect(r).toEqual({ error: 'Nothing unpushed' });
  });

  it('errors on an unborn HEAD without asking for an upstream', async () => {
    const upstreamRef = vi.fn(async () => 'origin/feature');
    const r = await resolveRangePreset(
      'unpushed',
      deps({ revParse: async () => null, upstreamRef }),
    );
    expect(r).toEqual({ error: 'This branch has no commits yet' });
    expect(upstreamRef).not.toHaveBeenCalled();
  });
});

describe('resolveRangePreset — branchPoint', () => {
  it('resolves merge-base(default, HEAD)…HEAD', async () => {
    const r = await resolveRangePreset(
      'branchPoint',
      deps({ revParse: async (ref) => (ref === 'HEAD' ? HEAD : ref === 'origin/HEAD' ? MAIN : null) }),
    );
    expect(r).toEqual({
      base: { kind: 'commit', sha: BASE },
      head: { kind: 'commit', sha: HEAD },
    });
  });

  it('prefers origin/HEAD, then main, then master', async () => {
    expect([...DEFAULT_BRANCH_REFS]).toEqual(['origin/HEAD', 'main', 'master']);
    const seen: string[] = [];
    await resolveRangePreset(
      'branchPoint',
      deps({
        revParse: async (ref) => {
          if (ref === 'HEAD') return HEAD;
          seen.push(ref);
          return ref === 'master' ? MAIN : null;
        },
      }),
    );
    expect(seen).toEqual(['origin/HEAD', 'main', 'master']);
  });

  it('errors when no default branch exists at all', async () => {
    const r = await resolveRangePreset(
      'branchPoint',
      deps({ revParse: async (ref) => (ref === 'HEAD' ? HEAD : null) }),
    );
    expect(r).toEqual({ error: 'No default branch to compare against' });
  });

  it('falls through to the next candidate when merge-base finds no common ancestor', async () => {
    const mergeBase = vi.fn(async (a: string) => (a === MAIN ? BASE : null));
    const r = await resolveRangePreset(
      'branchPoint',
      deps({
        revParse: async (ref) =>
          ref === 'HEAD' ? HEAD : ref === 'origin/HEAD' ? 'o'.repeat(40) : ref === 'main' ? MAIN : null,
        mergeBase,
      }),
    );
    expect(r).toEqual({ base: { kind: 'commit', sha: BASE }, head: { kind: 'commit', sha: HEAD } });
    expect(mergeBase).toHaveBeenCalledTimes(2);
  });

  it('errors when HEAD IS the default branch — the comparison would be empty', async () => {
    const r = await resolveRangePreset(
      'branchPoint',
      deps({
        revParse: async (ref) => (ref === 'HEAD' ? HEAD : ref === 'origin/HEAD' ? HEAD : null),
        mergeBase: async () => HEAD,
      }),
    );
    expect(r).toEqual({ error: 'This branch has no commits of its own' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/range-preset.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/range-preset"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/range-preset.ts`:

```ts
import type { RefEndpoint } from './git-range';

/**
 * The two Review source quick-picks that aren't a single commit (spec 2026-08-27-review-supercharge
 * §2 Lane B). Node-free and git-free — the three primitives are injected, so electron/main.ts stays
 * the only place that spawns, and the decision table is testable on CI's ubuntu.
 *
 * Both presets resolve to SHA endpoints rather than a preset-shaped RefEndpoint: `rangeKey` is the
 * renderer's diff cache key, and a name-shaped endpoint would silently point at different content
 * after a fetch. Shas also pass git:rangeDiff's existing validateCommits path unchanged (§3).
 */

export type RangePreset = 'unpushed' | 'branchPoint';

export interface RangePresetDeps {
  /** `git rev-parse --abbrev-ref @{upstream}` — the upstream's name, or null when unset. */
  upstreamRef(): Promise<string | null>;
  /** `git rev-parse --verify --quiet <ref>^{commit}` — a 40-char sha, or null. */
  revParse(ref: string): Promise<string | null>;
  /** `git merge-base <a> <b>` — a sha, or null when there is no common ancestor. */
  mergeBase(a: string, b: string): Promise<string | null>;
}

export interface ResolvedRange {
  base: RefEndpoint;
  head: RefEndpoint;
}

/** In order. `origin/HEAD` is the symbolic ref a clone gets; the literals cover a remote-less repo.
 *  See spec §12 assumption 9. */
export const DEFAULT_BRANCH_REFS = ['origin/HEAD', 'main', 'master'] as const;

const at = (sha: string): RefEndpoint => ({ kind: 'commit', sha });

export async function resolveRangePreset(
  preset: RangePreset,
  deps: RangePresetDeps,
): Promise<ResolvedRange | { error: string }> {
  const head = await deps.revParse('HEAD');
  if (!head) return { error: 'This branch has no commits yet' };

  if (preset === 'unpushed') {
    const upstream = await deps.upstreamRef();
    const base = upstream ? await deps.revParse(upstream) : null;
    if (!base) return { error: 'This branch has no upstream' };
    // A resolved-but-empty comparison is treated as unresolvable: the row is hidden rather than
    // opening a Review with nothing in it (§12 assumption 4).
    if (base === head) return { error: 'Nothing unpushed' };
    return { base: at(base), head: at(head) };
  }

  for (const ref of DEFAULT_BRANCH_REFS) {
    const sha = await deps.revParse(ref);
    if (!sha) continue;
    const base = await deps.mergeBase(sha, head);
    if (!base) continue;
    if (base === head) return { error: 'This branch has no commits of its own' };
    return { base: at(base), head: at(head) };
  }
  return { error: 'No default branch to compare against' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/range-preset.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/range-preset.ts test/unit/range-preset.test.ts
git commit -m "feat(git): add the unpushed / branch-point range resolver"
```

---

## Task 4: The two protocol pairs + the preview fallbacks

**Files:**
- Modify: `src/protocol.ts` — a re-export + `RangePreset` beside the other git types; two members in `HostToWebview`; two in `WebviewToHost`
- Modify: `webview/bridge.ts` — two preview branches after the `git:blame` branch (ends `:837`)

**Interfaces:**
- Consumes: `ReviewMark`, `ReviewMarksRepo` (Task 2); `RangePreset` (Task 3); `RefEndpoint` (already imported by `protocol.ts` for `git:rangeDiff`).
- Produces:
  - `export type { ReviewMark, ReviewMarksRepo } from './review-marks'`
  - `export type { RangePreset } from './range-preset'`
  - Host→web: `{ type: 'review:marks'; repos: ReviewMarksRepo[] }`
  - Host→web: `{ type: 'git:resolveRangeResult'; sessionId: string; preset: RangePreset; requestId: number; base?: RefEndpoint; head?: RefEndpoint; error?: string }`
  - Web→host: `{ type: 'review:setMark'; root: string; mark: ReviewMark; on: boolean }`
  - Web→host: `{ type: 'git:resolveRange'; sessionId: string; preset: RangePreset; requestId: number }`

- [ ] **Step 1: Re-export the two model types**

In `src/protocol.ts`, immediately after the `BlameLine` interface (ends `:172`), add:

```ts
// The reviewed-mark shapes live with their model (src/review-marks.ts) because the disk shape and
// the wire shape are the same object; re-exported here so renderer code that only talks protocol
// doesn't have to reach past it. See spec 2026-08-27-review-supercharge §2 Lane B.
export type { ReviewMark, ReviewMarksRepo } from './review-marks';
export type { RangePreset } from './range-preset';
```

- [ ] **Step 2: Add the two replies**

In the `HostToWebview` union, immediately after the `git:blameResult` member (ends `:324`):

```ts
  // Reviewed marks from userData/review-marks.json. A LIST of per-repo slices: every repo on the
  // first push after load — including none at all, which is what opens the renderer's mark
  // controls — and just the changed repo on every push after that (§2 Lane B).
  | { type: 'review:marks'; repos: ReviewMarksRepo[] }
  // Endpoints for a Review source quick-pick, as shas. `error` set => the picker hides the row.
  | {
      type: 'git:resolveRangeResult';
      sessionId: string;
      preset: RangePreset;
      requestId: number;
      base?: RefEndpoint;
      head?: RefEndpoint;
      error?: string;
    }
```

- [ ] **Step 3: Add the two requests**

In the `WebviewToHost` union, immediately after the `git:rangeDiff` member (ends `:571`):

```ts
  // Set or clear ONE reviewed mark. The host owns the file and echoes the repo's new list to
  // every window, so two windows on one repo converge on the last writer (§4).
  | { type: 'review:setMark'; root: string; mark: ReviewMark; on: boolean }
  // Resolve `unpushed` / `branchPoint` to sha endpoints for the picker's pinned rows.
  // `requestId` is latest-wins: the picker fires both presets when it opens.
  | { type: 'git:resolveRange'; sessionId: string; preset: RangePreset; requestId: number }
```

- [ ] **Step 4: Add the preview fallbacks**

In `webview/bridge.ts`, directly after the `if (msg.type === 'git:blame') { ... return; }` block
(ends `:837`), insert:

```ts
  if (msg.type === 'git:resolveRange') {
    // Preview (no host git): every quick-pick is unresolvable, so the picker shows only the rows
    // it can build itself instead of waiting on a reply that never comes.
    setTimeout(
      () =>
        emit({
          type: 'git:resolveRangeResult',
          sessionId: msg.sessionId,
          preset: msg.preset,
          requestId: msg.requestId,
          error: 'No repository',
        }),
      15,
    );
    return;
  }
  if (msg.type === 'review:setMark') {
    // Preview (no host store): echo the write back so the checkbox still answers the click.
    setTimeout(() => emit({ type: 'review:marks', repos: [{ root: msg.root, marks: [] }] }), 15);
    return;
  }
```

- [ ] **Step 5: Open the preview's load gate at startup**

The preview shell never receives the `ready` push, so `review:marks` would only ever arrive after a
write the gate forbids. Find where the fake shell answers `ready` / emits its initial `state` in
`webview/bridge.ts` and emit one empty marks push beside it:

```ts
    // Opens the mark controls' load gate in the preview shell (§4: they stay disabled until the
    // first review:marks arrives).
    emit({ type: 'review:marks', repos: [] });
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: both projects exit 0. A message added to one union and not handled where the compiler
requires exhaustiveness fails here — that is the check.

- [ ] **Step 7: Commit**

```bash
git add src/protocol.ts webview/bridge.ts
git commit -m "feat(review): add the review:marks and git:resolveRange protocol pairs"
```

---

## Task 5: Host wiring — marks persistence, broadcast, and `git:resolveRange`

**Files:**
- Modify: `electron/main.ts` — `reviewMarksFile()` beside `reposFile()` (`:278`); in-memory state beside `let repos = ...` (`:1335`); a push in `case 'ready'` (`:1744-1757`); `flushStateSync` (`:1432-1452`); two new cases after `case 'git:rangeDiff'` (ends `:1977`)

**Interfaces:**
- Consumes: `parseMarksFile`, `serializeMarksFile`, `setMark`, `marksFor`, `normalizeRoot` (Task 2); `resolveRangePreset` (Task 3); existing `readBlob`, `persistFile`, `broadcast`, `replyHere`, `runGit`, `GIT_TIMEOUT`, `gitRoot`, `mgr`.
- Produces: `review:marks` pushes; `git:resolveRangeResult` replies; `userData/review-marks.json` written atomically on change and synchronously on quit.

- [ ] **Step 1: Add the imports and the file path**

In `electron/main.ts`, beside the other `../src/` imports:

```ts
import { resolveRangePreset } from '../src/range-preset';
import {
  marksFor,
  normalizeRoot,
  parseMarksFile,
  serializeMarksFile,
  setMark as setReviewMark,
} from '../src/review-marks';
```

Beside `reposFile` (`:278`):

```ts
// Per-file "I've reviewed this" marks (spec 2026-08-27-review-supercharge §2 Lane B). Lives in
// userData beside sessions.json — never in the reviewed repo, where it would read as a change.
const reviewMarksFile = () => path.join(userData(), 'review-marks.json');
```

- [ ] **Step 2: Hold the marks in memory**

In the app-ready closure, immediately after `let repos = restoreRepos(readBlob(reposFile()));` (`:1335`):

```ts
  // Held in memory and pushed to windows directly: two windows share one main process, so a
  // change never needs an FS round trip to reach the other one (spec §2 Lane B).
  let reviewMarks = parseMarksFile(readBlob(reviewMarksFile()));

  /** Every repo in the file — the snapshot a freshly loaded window needs to open its load gate. */
  const allMarkRepos = () =>
    Object.keys(reviewMarks.repos).map((root) => ({ root, marks: marksFor(reviewMarks, root) }));
```

- [ ] **Step 3: Push the snapshot when a window is ready**

In `case 'ready':` (`:1744`), after the `restoreDocs` block and before `break;`:

```ts
          // Reviewed marks, to the window that just loaded (like restoreDocs above). An EMPTY
          // list is a real answer: it is what opens the renderer's mark controls (§4).
          replyHere({ type: 'review:marks', repos: allMarkRepos() });
```

- [ ] **Step 4: Handle the write and the preset resolution**

Immediately after the `case 'git:rangeDiff'` block (ends `:1977`), insert:

```ts
        case 'review:setMark': {
          const root = normalizeRoot(m.root);
          if (!root) break;
          reviewMarks = setReviewMark(reviewMarks, root, m.mark, m.on);
          persistFile(reviewMarksFile(), serializeMarksFile(reviewMarks), 'review-marks.json');
          // Every window, not just the sender: both may be showing the same repo (§4).
          broadcast({
            type: 'review:marks',
            repos: [{ root, marks: marksFor(reviewMarks, root) }],
          });
          break;
        }
        case 'git:resolveRange': {
          const session = mgr.get(m.sessionId);
          if (!session) break;
          const cwd = gitRoot(session);
          const revParse = async (ref: string): Promise<string | null> => {
            // Never let an option-like token reach the arg array (mirrors git:switch / refExists).
            if (!ref || ref.startsWith('-')) return null;
            const r = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
              cwd,
              timeoutMs: GIT_TIMEOUT.metadata,
            });
            return r.ok ? r.stdout.trim() || null : null;
          };
          const res = await resolveRangePreset(m.preset, {
            revParse,
            upstreamRef: async () => {
              const r = await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], {
                cwd,
                timeoutMs: GIT_TIMEOUT.metadata,
              });
              return r.ok ? r.stdout.trim() || null : null;
            },
            mergeBase: async (a, b) => {
              const r = await runGit(['merge-base', a, b], {
                cwd,
                timeoutMs: GIT_TIMEOUT.metadata,
              });
              return r.ok ? r.stdout.trim() || null : null;
            },
          });
          replyHere({
            type: 'git:resolveRangeResult',
            sessionId: m.sessionId,
            preset: m.preset,
            requestId: m.requestId,
            ...res,
          });
          break;
        }
```

- [ ] **Step 5: Flush on quit**

In `flushStateSync` (`:1432`), after the `docs.json` write:

```ts
    // Same force-kill-on-update hazard as sessions.json: an interrupted async write would leave
    // the marks file truncated and the next launch would show a finished review as unread.
    write(reviewMarksFile(), serializeMarksFile(reviewMarks), 'review-marks.json');
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add electron/main.ts
git commit -m "feat(review): persist reviewed marks in userData and resolve range presets host-side"
```

---

## Task 6: The renderer marks store (`webview/review-marks-store.ts`)

**Files:**
- Create: `webview/review-marks-store.ts`

**Interfaces:**
- Consumes: `post`, `subscribe` from `webview/bridge.ts`; `applyMarksPush`, `normalizeRoot`, `setMarkList` from `src/review-marks.ts`.
- Produces:
  - `export interface MarksSnapshot { loaded: boolean; byRoot: ReadonlyMap<string, readonly ReviewMark[]> }`
  - `export function subscribeMarks(cb: () => void): () => void`
  - `export function getMarksSnapshot(): MarksSnapshot`
  - `export function setMark(root: string, mark: ReviewMark, on: boolean): void`

An external store rather than context, exactly like `webview/dirty-store.ts`: Review reads it with
`useSyncExternalStore` and nothing else has to thread it. Everything worth unit-testing already
lives in `src/review-marks.ts` (Task 2); this file is bridge glue and is covered by the e2e.

- [ ] **Step 1: Write the implementation**

Create `webview/review-marks-store.ts`:

```ts
import type { ReviewMark, ReviewMarksRepo } from '../src/protocol';
import { applyMarksPush, normalizeRoot, setMarkList } from '../src/review-marks';
import { post, subscribe } from './bridge';

/**
 * Renderer mirror of the host's reviewed marks (spec 2026-08-27-review-supercharge §2 Lane B).
 * A module-singleton external store, mirroring dirty-store.ts: the Review view reads it with
 * useSyncExternalStore, and the host stays the single owner of the file.
 *
 * `loaded` is the LOAD GATE (§4): every mark control is disabled until the first push lands, so a
 * click during startup can't be silently dropped or overwritten by the snapshot that follows.
 */

export interface MarksSnapshot {
  loaded: boolean;
  byRoot: ReadonlyMap<string, readonly ReviewMark[]>;
}

type Listener = () => void;

let snapshot: MarksSnapshot = { loaded: false, byRoot: new Map() };
const listeners = new Set<Listener>();

function apply(repos: readonly ReviewMarksRepo[]): void {
  snapshot = { loaded: true, byRoot: applyMarksPush(snapshot.byRoot, repos) };
  listeners.forEach((l) => {
    l();
  });
}

subscribe((msg) => {
  if (msg.type === 'review:marks') apply(msg.repos);
});

export function subscribeMarks(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getMarksSnapshot(): MarksSnapshot {
  return snapshot;
}

/**
 * Toggle one mark. Applied locally first so the checkbox answers the click in the same frame; the
 * host's echo replaces the optimistic list a tick later and wins any cross-window race.
 */
export function setMark(root: string, mark: ReviewMark, on: boolean): void {
  const key = normalizeRoot(root);
  apply([{ root: key, marks: setMarkList(snapshot.byRoot.get(key) ?? [], mark, on) }]);
  post({ type: 'review:setMark', root: key, mark, on });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: both projects exit 0.

- [ ] **Step 3: Note the expected dead-code report**

Run: `npm run fallow:check`
Expected: the three exports are reported unused — they are, until Task 10 wires them. **Do not
delete them and do not narrow the check.** Task 10 makes this green; Task 15 is where it must be.

- [ ] **Step 4: Commit**

```bash
git add webview/review-marks-store.ts
git commit -m "feat(review): add the renderer marks store fed by the host broadcast"
```

---

## Task 7: Ignore whitespace — the `computeFileReview` option + the setting

**Files:**
- Modify: `src/review-hunks.ts` — `diffLines` (signature, three comparisons, three context emissions) and `computeFileReview`
- Modify: `src/settings.ts` — `AppSettings` (`:104`), `DEFAULT_SETTINGS` (`:186`), the coercer (`:415`)
- Test: `test/unit/review-hunks-whitespace.test.ts` (new); `test/unit/coerce-settings.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface ReviewOptions { ignoreWhitespace?: boolean }`
  - `export function collapseWhitespace(line: string): string`
  - `export function computeFileReview(head, work, context?, maxLcsCells?, opts?: ReviewOptions): FileReview`
  - `AppSettings['reviewIgnoreWhitespace']: boolean` (default `false`)

Lane A's 4th positional `maxLcsCells` is untouched; the option arrives as a 5th **options object**
(assumption 5). Equality runs over a per-line KEY while every op still carries real text — and under
ignore-whitespace a `context` op emits the **new** side, which is what the file actually holds.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review-hunks-whitespace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { collapseWhitespace, computeFileReview } from '../../src/review-hunks';

const IGNORE = { ignoreWhitespace: true };

describe('collapseWhitespace', () => {
  it('collapses runs and trims the ends', () => {
    expect(collapseWhitespace('\tconst  a   =  1;  ')).toBe('const a = 1;');
  });

  it('keeps a token boundary — a+b is NOT a + b', () => {
    expect(collapseWhitespace('a+b')).not.toBe(collapseWhitespace('a + b'));
  });

  it('collapses a blank line to empty', () => {
    expect(collapseWhitespace('   \t ')).toBe('');
  });
});

describe('computeFileReview with ignoreWhitespace', () => {
  const head = 'function f() {\nreturn 1;\n}\n';
  const reindented = 'function f() {\n  return 1;\n}\n';

  it('reports an indent-only change by default', () => {
    const r = computeFileReview(head, reindented);
    expect(r.hunks.length).toBeGreaterThan(0);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
  });

  it('reports NO hunks for an indent-only change when the option is on', () => {
    const r = computeFileReview(head, reindented, 3, undefined, IGNORE);
    expect(r.hunks).toEqual([]);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it('still reports a real change in a re-indented file, and only that change', () => {
    const work = 'function f() {\n  return 2;\n}\n';
    const r = computeFileReview(head, work, 3, undefined, IGNORE);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    const changed = r.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context');
    expect(changed.map((l) => l.text.trim())).toEqual(['return 1;', 'return 2;']);
  });

  it('renders the NEW side of a loosely-matched context line, not the old one', () => {
    const work = 'function f() {\n\t\treturn 1;\n}\nconst extra = 1;\n';
    const r = computeFileReview(head, work, 3, undefined, IGNORE);
    const context = r.hunks.flatMap((h) => h.lines).find((l) => l.text.includes('return 1;'));
    expect(context?.kind).toBe('context');
    expect(context?.text).toBe('\t\treturn 1;');
  });

  it('leaves a trailing-whitespace-only change invisible', () => {
    expect(computeFileReview('a\nb\n', 'a   \nb\n', 3, undefined, IGNORE).hunks).toEqual([]);
  });

  it('does not let a collapsed blank line swallow a real deletion', () => {
    const r = computeFileReview('a\n\nb\n', 'a\nb\n', 3, undefined, IGNORE);
    expect(r.removed).toBe(1);
  });

  it('honours the Lane A cell budget alongside the option', () => {
    const a = Array.from({ length: 600 }, (_, i) => `  a${i}`).join('\n');
    const b = Array.from({ length: 600 }, (_, i) => `\tb${i}`).join('\n');
    expect(computeFileReview(a, b, 3, 250_000, IGNORE).approx).toBe(true);
  });

  it('an unchanged file is unchanged either way', () => {
    expect(computeFileReview(head, head, 3, undefined, IGNORE).hunks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-hunks-whitespace.test.ts`
Expected: FAIL — `collapseWhitespace` is not exported, and the 5th argument is ignored.

- [ ] **Step 3: Add the option type and the key function**

In `src/review-hunks.ts`, beside `MAX_LCS_CELLS`:

```ts
/** Options that change what counts as a CHANGE (as opposed to how much of one we can afford). */
export interface ReviewOptions {
  /** Compare lines with their whitespace runs collapsed and their ends trimmed — git's `-b`, plus
   *  leading/trailing. Full `-w` would call `a+b` and `a + b` identical, which is a real edit in
   *  most languages (spec 2026-08-27-review-supercharge §2 Lane B). */
  ignoreWhitespace?: boolean;
}

export const collapseWhitespace = (line: string): string => line.replace(/\s+/g, ' ').trim();
```

- [ ] **Step 4: Compare keys, emit real text**

Change `diffLines`'s signature and add the key arrays at the top of its body:

```ts
function diffLines(
  a: string[],
  b: string[],
  maxLcsCells: number,
  keyOf: ((line: string) => string) | null,
): { ops: Op[]; approx: boolean } {
  // Equality runs over KEYS; every op still carries real text. Identity keying allocates nothing,
  // so the default path stays byte-for-byte what it was.
  const ka = keyOf ? a.map(keyOf) : a;
  const kb = keyOf ? b.map(keyOf) : b;
```

Then, inside the same function:

- leading trim → `while (lo < a.length && lo < b.length && ka[lo] === kb[lo]) lo++;`
- trailing trim → `while (hiA > lo && hiB > lo && ka[hiA - 1] === kb[hiB - 1]) {`
- leading context emission → `ops.push({ kind: 'context', text: b[k], oldLine: k + 1, newLine: k + 1 });`
- beside `coreA` / `coreB`, add `const kCoreA = ka.slice(lo, hiA);` and `const kCoreB = kb.slice(lo, hiB);`
- the LCS table's comparison → `kCoreA[i] === kCoreB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(...)`
- the backtrack's match test → `if (kCoreA[i] === kCoreB[j]) {` and its emission →
  `ops.push({ kind: 'context', text: coreB[j], oldLine: lo + i + 1, newLine: lo + j + 1 });`
- trailing context emission → `ops.push({ kind: 'context', text: b[k - hiA + hiB], oldLine: k + 1, newLine: k - hiA + hiB + 1 });`

The degenerate (`approx`) branch is untouched: it emits every core line as a del plus an add and
never claims two lines match.

- [ ] **Step 5: Add the option to `computeFileReview`**

```ts
export function computeFileReview(
  head: string,
  work: string,
  context = 3,
  maxLcsCells = MAX_LCS_CELLS,
  opts: ReviewOptions = {},
): FileReview {
  const a = splitLines(head);
  const b = splitLines(work);
  const { ops, approx } = diffLines(
    a,
    b,
    maxLcsCells,
    opts.ignoreWhitespace ? collapseWhitespace : null,
  );
```

and extend its JSDoc with a final line:

```
 * `opts.ignoreWhitespace` compares whitespace-collapsed lines while every emitted line keeps its
 * real text — a loosely-matched context line renders the NEW side, which is what the file holds.
```

- [ ] **Step 6: Add the setting**

In `src/settings.ts`, after `reviewFileListOpen` in `AppSettings` (`:104`):

```ts
  // Review: compare lines with whitespace collapsed, so a re-indent stops drowning the real
  // change. Off by default — whitespace IS the change often enough that hiding it unasked would
  // be a lie (spec 2026-08-27-review-supercharge §5).
  reviewIgnoreWhitespace: boolean;
```

after `reviewFileListOpen: true,` in `DEFAULT_SETTINGS` (`:186`):

```ts
  reviewIgnoreWhitespace: false,
```

after the `reviewFileListOpen` line in the coercer (`:415`):

```ts
    reviewIgnoreWhitespace: bool(
      payload.reviewIgnoreWhitespace,
      DEFAULT_SETTINGS.reviewIgnoreWhitespace,
    ),
```

- [ ] **Step 7: Extend the settings test**

In `test/unit/coerce-settings.test.ts`, matching the neighbouring cases' call style:

```ts
  it('defaults reviewIgnoreWhitespace off and only accepts a real boolean', () => {
    expect(coerceSettings({}).reviewIgnoreWhitespace).toBe(false);
    expect(coerceSettings({ reviewIgnoreWhitespace: true }).reviewIgnoreWhitespace).toBe(true);
    expect(coerceSettings({ reviewIgnoreWhitespace: 'yes' }).reviewIgnoreWhitespace).toBe(false);
  });
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/unit/review-hunks-whitespace.test.ts test/unit/review-hunks.test.ts test/unit/review-hunks-bounds.test.ts test/unit/coerce-settings.test.ts`
Expected: PASS. The two existing `review-hunks` suites are the regression check that the default
path is unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/review-hunks.ts src/settings.ts test/unit/review-hunks-whitespace.test.ts test/unit/coerce-settings.test.ts
git commit -m "feat(review): compare whitespace-collapsed lines behind reviewIgnoreWhitespace"
```

---

## Task 8: Make the sticky file header actually stick

**Files:**
- Modify: `webview/styles.css` — the `.rcard` block (`:9155-9165`)
- Test: `test/unit/review-sticky-header.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

`.rcard__head` has declared `position: sticky; top: 0` since the card-collapse spec and it has never
stuck. The cause is one line up: `.rcard { overflow: hidden }` makes the card its own scroll
container, and a sticky box is offset against its **nearest scrollport** — one that, being exactly as
tall as its content, never scrolls. `overflow: clip` clips identically (the border-radius still
holds) **without** creating a scrollport, so the header resolves against `.review__scroll` again.
Wrapping the header in a second sticky element would be the band-aid.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review-sticky-header.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `.rcard__head` is `position: sticky`, and a sticky box is offset against its nearest SCROLLPORT.
 * `overflow: hidden` on the card makes the card that scrollport — one exactly as tall as its
 * content, so it never scrolls — and the header silently never sticks. `overflow: clip` clips the
 * same way without creating a scroll container.
 *
 * The behaviour itself is asserted in test/e2e/review-keymap-persist.e2e.mjs; this guards the
 * one-word declaration that makes it possible from being "tidied" back.
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'webview', 'styles.css'), 'utf8');
/** Comments blanked so prose quoting a property can't be read as a declaration. */
const SRC = CSS.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/** The declarations of the block headed by exactly `selector`. */
function blockFor(selector: string): string {
  const at = SRC.search(new RegExp(`(^|\\})\\s*\\${selector}\\s*\\{`, 'm'));
  expect(at, `no "${selector} {" block in styles.css`).toBeGreaterThanOrEqual(0);
  const open = SRC.indexOf('{', at);
  return SRC.slice(open + 1, SRC.indexOf('}', open));
}

describe('review card / sticky file header', () => {
  it('the card clips without becoming a scroll container', () => {
    const card = blockFor('.rcard');
    expect(card).toMatch(/overflow:\s*clip\s*;/);
    expect(card).not.toMatch(/overflow:\s*(hidden|auto|scroll)\s*;/);
  });

  it('the card header is still sticky at the top of the scroller', () => {
    const head = blockFor('.rcard__head');
    expect(head).toMatch(/position:\s*sticky\s*;/);
    expect(head).toMatch(/top:\s*0\s*;/);
    expect(head).toMatch(/z-index:\s*\d+\s*;/);
  });

  it('the review scroller is the scrollport the header resolves against', () => {
    expect(blockFor('.review__scroll')).toMatch(/overflow-y:\s*auto\s*;/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-sticky-header.test.ts`
Expected: FAIL — `.rcard` declares `overflow: hidden`.

- [ ] **Step 3: Make the card clip instead of scroll**

In `webview/styles.css`, in the `.rcard` block (`:9155`), replace `overflow: hidden;` with:

```css
  /* clip, NOT hidden: `hidden` makes the card its own scroll container, and .rcard__head's
     `position: sticky` then resolves against a box that never scrolls — which is why the file
     header never stuck. `clip` clips the border-radius identically without a scrollport. */
  overflow: clip;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/review-sticky-header.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Format check**

Run: `npx biome check webview/styles.css test/unit/review-sticky-header.test.ts`
Expected: no diagnostics.

- [ ] **Step 6: Commit**

```bash
git add webview/styles.css test/unit/review-sticky-header.test.ts
git commit -m "fix(review): let a card's file header actually stick while you scroll it"
```

---

## Task 9: Source quick-picks in the commit picker

**Files:**
- Create: `webview/review-picker-rows.ts`
- Test: `test/unit/review-picker-rows.test.ts`
- Modify: `webview/components/commit-picker-menu.tsx` — the `STR` table (`:21-32`), a new resolve effect, the `rows` memo (`:159-217`)

**Interfaces:**
- Consumes: `RefEndpoint`, `rangeKey`, `shortSha` from `src/git-range.ts`; `ReviewSource` from `webview/docs.ts`.
- Produces:
  - `export interface PinnedSourceRow { id: 'lastCommit' | 'unpushed' | 'branchPoint'; label: string; hint: string; source: ReviewSource }`
  - `export interface PinnedSourceInput { head: { sha: string; subject: string } | null; unpushed: ResolvedRange | null; branchPoint: ResolvedRange | null; current?: ReviewSource }`
  - `export function buildPinnedSources(input: PinnedSourceInput): PinnedSourceRow[]`
  - `export function isPinnedRowChecked(row: PinnedSourceRow, current: ReviewSource | undefined): boolean`

*Last commit* selects the **existing commit source** for HEAD's sha — no new render path (§2 Lane B).
The other two select the existing **range** source with the sha endpoints the host resolved. A row
whose input is `null` is absent, which is what "hidden when unresolvable" means.

- [ ] **Step 1: Write the failing test**

Create `test/unit/review-picker-rows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RefEndpoint } from '../../src/git-range';
import {
  buildPinnedSources,
  isPinnedRowChecked,
  type PinnedSourceInput,
} from '../../webview/review-picker-rows';

const sha = (c: string) => c.repeat(40);
const at = (c: string): RefEndpoint => ({ kind: 'commit', sha: sha(c) });

const input = (over: Partial<PinnedSourceInput> = {}): PinnedSourceInput => ({
  head: { sha: sha('h'), subject: 'Fix the thing' },
  unpushed: { base: at('u'), head: at('h') },
  branchPoint: { base: at('b'), head: at('h') },
  ...over,
});

describe('buildPinnedSources', () => {
  it('offers all three rows, in order, when everything resolves', () => {
    expect(buildPinnedSources(input()).map((r) => r.id)).toEqual([
      'lastCommit',
      'unpushed',
      'branchPoint',
    ]);
  });

  it('maps Last commit onto the existing COMMIT source, subject included', () => {
    const [row] = buildPinnedSources(input());
    expect(row.source).toEqual({ kind: 'commit', sha: sha('h'), subject: 'Fix the thing' });
    expect(row.label).toBe('Last commit');
    expect(row.hint).toContain('hhhhhhh');
  });

  it('maps the two ranges onto the existing RANGE source with sha endpoints', () => {
    const rows = buildPinnedSources(input());
    expect(rows[1].source).toEqual({ kind: 'range', base: at('u'), head: at('h') });
    expect(rows[2].source).toEqual({ kind: 'range', base: at('b'), head: at('h') });
  });

  it('hides a row the host could not resolve', () => {
    expect(buildPinnedSources(input({ unpushed: null })).map((r) => r.id)).toEqual([
      'lastCommit',
      'branchPoint',
    ]);
    expect(buildPinnedSources(input({ branchPoint: null })).map((r) => r.id)).toEqual([
      'lastCommit',
      'unpushed',
    ]);
  });

  it('hides Last commit in a repo with no commits', () => {
    expect(buildPinnedSources(input({ head: null })).map((r) => r.id)).toEqual([
      'unpushed',
      'branchPoint',
    ]);
  });

  it('is empty when nothing resolves — the picker simply shows its usual rows', () => {
    expect(buildPinnedSources({ head: null, unpushed: null, branchPoint: null })).toEqual([]);
  });

  it('drops the subject when the commit has none, rather than printing "undefined"', () => {
    const [row] = buildPinnedSources(input({ head: { sha: sha('h'), subject: '' } }));
    expect(row.source).toEqual({ kind: 'commit', sha: sha('h') });
    expect(row.hint).toBe('hhhhhhh');
  });
});

describe('isPinnedRowChecked', () => {
  const [last, unpushed, branchPoint] = buildPinnedSources(input());

  it('checks Last commit when the current source is that commit', () => {
    expect(isPinnedRowChecked(last, { kind: 'commit', sha: sha('h') })).toBe(true);
    expect(isPinnedRowChecked(last, { kind: 'commit', sha: sha('x') })).toBe(false);
  });

  it('checks a range row by rangeKey, so the endpoints must match on both sides', () => {
    expect(isPinnedRowChecked(unpushed, { kind: 'range', base: at('u'), head: at('h') })).toBe(true);
    expect(isPinnedRowChecked(unpushed, { kind: 'range', base: at('b'), head: at('h') })).toBe(false);
    expect(isPinnedRowChecked(branchPoint, { kind: 'range', base: at('b'), head: at('h') })).toBe(
      true,
    );
  });

  it('checks nothing against the working tree or an absent source', () => {
    expect(isPinnedRowChecked(last, { kind: 'working' })).toBe(false);
    expect(isPinnedRowChecked(unpushed, undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-picker-rows.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/review-picker-rows"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview/review-picker-rows.ts`:

```ts
import type { ResolvedRange } from '../src/range-preset';
import { rangeKey, shortSha } from '../src/git-range';
import type { ReviewSource } from './docs';

/**
 * The Review source picker's pinned quick-picks (spec 2026-08-27-review-supercharge §2 Lane B).
 * Pure: the picker fetches, this decides. Each row selects an EXISTING source kind — Last commit
 * is the commit source for HEAD, the two ranges are the range source with the sha endpoints the
 * host resolved — so no new render path enters Review for any of them.
 *
 * A row whose input is null is simply absent: "hidden when unresolvable".
 */

export interface PinnedSourceRow {
  id: 'lastCommit' | 'unpushed' | 'branchPoint';
  label: string;
  /** Secondary line: the sha7 + subject, or what the comparison covers. */
  hint: string;
  source: ReviewSource;
}

export interface PinnedSourceInput {
  /** HEAD's commit, from the history the picker already loads. */
  head: { sha: string; subject: string } | null;
  unpushed: ResolvedRange | null;
  branchPoint: ResolvedRange | null;
}

export function buildPinnedSources(input: PinnedSourceInput): PinnedSourceRow[] {
  const rows: PinnedSourceRow[] = [];
  if (input.head) {
    const { sha, subject } = input.head;
    rows.push({
      id: 'lastCommit',
      label: 'Last commit',
      hint: subject ? `${shortSha(sha)} ${subject}` : shortSha(sha),
      source: { kind: 'commit', sha, ...(subject ? { subject } : {}) },
    });
  }
  if (input.unpushed) {
    rows.push({
      id: 'unpushed',
      label: 'Unpushed',
      hint: 'Commits that are not on the upstream branch yet',
      source: { kind: 'range', base: input.unpushed.base, head: input.unpushed.head },
    });
  }
  if (input.branchPoint) {
    rows.push({
      id: 'branchPoint',
      label: 'Since branch point',
      hint: 'Everything since this branch left the default branch',
      source: { kind: 'range', base: input.branchPoint.base, head: input.branchPoint.head },
    });
  }
  return rows;
}

export function isPinnedRowChecked(
  row: PinnedSourceRow,
  current: ReviewSource | undefined,
): boolean {
  if (!current) return false;
  if (row.source.kind === 'commit') {
    return current.kind === 'commit' && current.sha === row.source.sha;
  }
  if (row.source.kind === 'range' && current.kind === 'range') {
    return rangeKey(current.base, current.head) === rangeKey(row.source.base, row.source.head);
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/review-picker-rows.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Resolve the presets when the picker opens**

In `webview/components/commit-picker-menu.tsx`, add to the imports:

```ts
import type { ResolvedRange } from '../../src/range-preset';
import { buildPinnedSources, isPinnedRowChecked } from '../review-picker-rows';
```

Add to `STR` (`:21-32`):

```ts
  pinnedHeading: 'Quick picks',
```

Add state beside the existing `commits` state (`:66`):

```ts
  const [presets, setPresets] = useState<{ unpushed: ResolvedRange | null; branchPoint: ResolvedRange | null }>({
    unpushed: null,
    branchPoint: null,
  });
```

and, after the history effect (ends `:111`), a resolve effect:

```ts
  // Both presets are asked for once, when the menu opens. Each reply is latest-wins on its own
  // preset — the two races are independent, and an unresolvable one simply never sets a row.
  useEffect(() => {
    if (!sessionId) return;
    const ids = { unpushed: reqCounter.current + 1, branchPoint: reqCounter.current + 2 };
    reqCounter.current += 2;
    const unsub = subscribe((msg) => {
      if (msg.type !== 'git:resolveRangeResult' || msg.sessionId !== sessionId) return;
      if (msg.requestId !== ids[msg.preset]) return;
      const resolved = msg.base && msg.head ? { base: msg.base, head: msg.head } : null;
      setPresets((p) => ({ ...p, [msg.preset]: resolved }));
    });
    post({ type: 'git:resolveRange', sessionId, preset: 'unpushed', requestId: ids.unpushed });
    post({ type: 'git:resolveRange', sessionId, preset: 'branchPoint', requestId: ids.branchPoint });
    return unsub;
  }, [sessionId]);
```

- [ ] **Step 6: Render the pinned rows**

In the `rows` memo (`:159`), immediately after the Working tree row is pushed (`:161-166`):

```ts
    const pinned = buildPinnedSources({
      head: commits[0] ? { sha: commits[0].sha, subject: commits[0].subject } : null,
      unpushed: presets.unpushed,
      branchPoint: presets.branchPoint,
    });
    for (const p of pinned) {
      out.push({
        id: `${baseId}-p-${p.id}`,
        source: p.source,
        checked: isPinnedRowChecked(p, source),
        render: () => (
          <>
            <span className="commit-picker__pinned">{p.label}</span>
            <span className="commit-picker__subject" title={p.hint}>
              {p.hint}
            </span>
          </>
        ),
      });
    }
```

and extend the memo's dependency list with `commits` and `presets`.

`filterCommitsForPicker` still feeds the commit rows below, so typing in the filter narrows the
commit list while the quick-picks stay put — they are not commits and are not searchable.

- [ ] **Step 7: Style the pinned label**

In `webview/styles.css`, beside `.commit-picker__working`:

```css
/* Quick-pick rows (Last commit / Unpushed / Since branch point): a label where a commit row
   carries its sha, so the two read as one column. */
.commit-picker__pinned {
  flex: none;
  font-weight: 600;
  color: var(--text);
}
```

- [ ] **Step 8: Typecheck and run the suite**

Run: `npm run typecheck && npx vitest run test/unit/review-picker-rows.test.ts`
Expected: both exit 0 / PASS.

- [ ] **Step 9: Commit**

```bash
git add webview/review-picker-rows.ts webview/components/commit-picker-menu.tsx webview/styles.css test/unit/review-picker-rows.test.ts
git commit -m "feat(review): offer Last commit / Unpushed / Since branch point in the source picker"
```

---

## Task 10: Reviewed marks come from the host store

**Files:**
- Modify: `webview/view-state-store.ts` — the `reviewAnchor` kind (`:19`), `mergeReviewViewState` (`:66-89`)
- Modify: `webview/components/review-view.tsx` — the reviewed state (`:252-267`), the source-reset effect (`:279-295`), `progress`, `ReviewFileNav` / `ReviewFileRow` / `ReviewFileCard` props
- Test: `test/unit/view-state-store.test.ts` (trim)

**Interfaces:**
- Consumes: `getMarksSnapshot`, `subscribeMarks`, `setMark` (Task 6); `contentHash`, `normalizeRoot`, `reviewedPaths`, `staleMarks` (Task 2).
- Produces: nothing new; `webview/review-stats.ts`'s `toggleReviewed` becomes unused and is **deleted** along with its test cases (the store owns the toggle now; leaving a second one would be exactly the drift `fallow:check` exists to catch). `computeReviewProgress` stays — the meter still folds the set against the file list.

- [ ] **Step 1: Take `reviewed` out of the view-state store**

In `webview/view-state-store.ts`, change the union member (`:19`):

```ts
  | { kind: 'reviewAnchor'; topPath: string; offset: number };
```

drop `reviewed` from `mergeReviewViewState`'s patch type and body (`:75-89`), and replace the second
paragraph of its doc comment with:

```
 * The reviewed set used to live here too (decision D9). It doesn't any more: marks are durable,
 * per-user state owned by the host (spec 2026-08-27-review-supercharge §2 Lane B), and a
 * tab-lifetime copy beside them could only disagree.
```

In `test/unit/view-state-store.test.ts`, delete the cases that write or read `reviewed` through
`mergeReviewViewState` and keep every anchor case.

- [ ] **Step 2: Read the marks in `ReviewView`**

In `webview/components/review-view.tsx`, add to the imports:

```ts
import { contentHash, normalizeRoot, reviewedPaths, staleMarks } from '../../src/review-marks';
import { getMarksSnapshot, setMark, subscribeMarks } from '../review-marks-store';
```

(and add `useSyncExternalStore` to the `react` import), then replace the whole reviewed-state block
(`:252-267`) with:

```ts
  // Per-file reviewed marks. Durable, host-owned and shared across windows (spec
  // 2026-08-27-review-supercharge §2 Lane B) — this view only reads them and toggles one.
  const marks = useSyncExternalStore(subscribeMarks, getMarksSnapshot, getMarksSnapshot);
  const marksRoot = effectiveRoot ? normalizeRoot(effectiveRoot) : '';
  const rootMarks = marks.byRoot.get(marksRoot) ?? EMPTY_MARKS;

  // The receipt a mark is checked against: the new-side text of every file whose diff HAS loaded.
  // A file that isn't loaded has no entry, and is therefore neither reviewed nor stale.
  const hashes = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of files) {
      const d = effectiveDiffs.get(absOf(f.path));
      if (d) m.set(f.path, contentHash(d.work));
    }
    return m;
  }, [files, effectiveDiffs, absOf]);

  const reviewed = useMemo(
    () => reviewedPaths(rootMarks, sourceKey, hashes),
    [rootMarks, sourceKey, hashes],
  );

  /** A mark can only be made once we can hash what is being marked (§12 assumption 8). */
  const canMark = useCallback(
    (path: string) => marks.loaded && marksRoot !== '' && hashes.has(path),
    [marks.loaded, marksRoot, hashes],
  );

  const onToggleReviewed = useCallback(
    (path: string) => {
      const hash = hashes.get(path);
      if (!canMark(path) || hash === undefined) return;
      const on = !reviewed.has(path);
      setMark(
        marksRoot,
        { source: sourceKey, path, contentHash: hash, at: new Date().toISOString() },
        on,
      );
      setAnnounce(on ? `Marked ${path} reviewed` : `Unmarked ${path}`);
    },
    [hashes, canMark, reviewed, marksRoot, sourceKey],
  );

  // A mark whose file has changed since is RETIRED, not merely hidden (§2 Lane B). The host has
  // no file text, so the side that can tell is the one that does it.
  useEffect(() => {
    if (!marks.loaded || marksRoot === '') return;
    for (const m of staleMarks(rootMarks, sourceKey, hashes)) setMark(marksRoot, m, false);
  }, [marks.loaded, marksRoot, rootMarks, sourceKey, hashes]);
```

Add the stable empty list beside `EMPTY_FILES` (`:94`):

```ts
/** Stable empty list so a repo with no marks doesn't re-identify the memo on every render. */
const EMPTY_MARKS: ReviewMark[] = [];
```

(with `import type { ChangeDTO, FileDiffDTO, ReviewMark } from '../../src/protocol';`).

`sourceKey` is declared at `:272` today, *after* this block — move its declaration up to just above
it. It has no dependencies beyond `source`.

- [ ] **Step 3: Stop resetting and stop persisting the set**

In the source-change effect (`:279-295`), delete `setReviewedState(new Set());` — the marks are
keyed by `source`, so switching sources already shows a different set, and clearing here would wipe
durable state. Update the effect's `biome-ignore` reason line if it names the setter.

Delete the `setReviewed` callback and the `mergeReviewViewState(id, { reviewed: … })` write; the
anchor capture at `:309-312` stays untouched.

- [ ] **Step 4: Gate the controls**

Thread `canMark` down so a control the user cannot honour is disabled rather than silently inert:

- `ReviewFileNav` gains `canMark: (path: string) => boolean` and passes `canMark(c.path)` to each row.
- `ReviewFileRow` gains `canMark: boolean`; its checkbox becomes:

```tsx
      <input
        type="checkbox"
        className="review__check"
        checked={reviewed}
        disabled={!canMark}
        title={canMark ? undefined : 'Loading diff…'}
        aria-label={`Mark ${c.path} reviewed`}
        onChange={() => onToggleReviewed(c.path)}
      />
```

- `ReviewFileCard` gains `canMark: boolean`; its header button becomes:

```tsx
        <button
          type="button"
          className="rcard__reviewed"
          aria-pressed={reviewed}
          disabled={!canMark}
          title={
            canMark
              ? reviewed
                ? 'Clear the reviewed mark'
                : 'Mark this file reviewed (m)'
              : 'Loading diff…'
          }
          onClick={() => onToggleReviewed(change.path)}
        >
          {reviewed ? 'Reviewed' : 'Mark reviewed'}
        </button>
```

- [ ] **Step 5: Delete the now-duplicated toggle**

Remove `toggleReviewed` from `webview/review-stats.ts` and its import in `review-view.tsx`, and drop
its `describe` block from `test/unit/review-stats.test.ts`. `src/review-marks.ts`'s `setMarkList` is
the only place a mark is added or removed now.

- [ ] **Step 6: Typecheck, build and run the affected suites**

Run: `npm run typecheck && npm run build && npx vitest run test/unit/review-stats.test.ts test/unit/view-state-store.test.ts`
Expected: exit 0 / PASS.

- [ ] **Step 7: Commit**

```bash
git add webview/view-state-store.ts webview/components/review-view.tsx webview/review-stats.ts test/unit/review-stats.test.ts test/unit/view-state-store.test.ts
git commit -m "feat(review): reviewed marks survive a restart and follow the file's content"
```

---

## Task 11: The scoped keymap, the current-hunk ring, and the header controls

**Files:**
- Modify: `webview/components/review-view.tsx`
- Modify: `webview/styles.css` — a `.review__actions` block, the current-hunk ring, the help panel

**Interfaces:**
- Consumes: `reviewActionFor`, `nextHunk`, `prevHunk`, `nextFile`, `prevFile`, `syncToAnchor`, `clampRef`, `REVIEW_KEY_HELP`, types `HunkRef` / `ReviewFileHunks` (Task 1); `isTypingEntry` from `webview/typing-guard.ts`; `useSettings` (already imported); `computeFileReview` with `ReviewOptions` (Task 7).
- Produces: no new exports — this is the React layer for the modules above.

Everything below is inside `review-view.tsx`. The keydown handler lives on `.review__scroll`, which
is the surface the spec scopes the keymap to.

- [ ] **Step 1: Hunk counts, without re-diffing the world**

Only a mounted card has run `computeFileReview`. Cards report their count up; every other file is
seeded from its own `added + removed`, which answers the only question navigation asks of it
(§12 assumption 10).

Add beside the other refs (`:219-233`):

```ts
  // path → real hunk count, reported by the card that computed it. A file the window hasn't
  // mounted has no entry: its change's own +/- counts stand in (§12 assumption 10). Re-running
  // computeFileReview here for every file would undo the virtualization this list exists for.
  const hunkCountsRef = useRef<Map<string, number>>(new Map());
  const [, setHunkTick] = useState(0);
  const reportHunkCount = useCallback((path: string, count: number) => {
    if (hunkCountsRef.current.get(path) === count) return;
    hunkCountsRef.current.set(path, count);
    setHunkTick((t) => t + 1);
  }, []);
```

and, beside `pathIndex` (`:209`), the cursor's view of the list — computed inline so it reads the
fresh ref on every render, exactly like `win`:

```ts
  const fileHunks: ReviewFileHunks[] = files.map((c) => ({
    path: c.path,
    hunkCount: hunkCountsRef.current.get(c.path) ?? (c.added + c.removed > 0 ? 1 : 0),
  }));
  const fileHunksRef = useRef(fileHunks);
  fileHunksRef.current = fileHunks;
```

In `ReviewFileCard`, beside the measure effect (`:939-947`):

```ts
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the computed review, not to the callback's identity.
  useEffect(() => {
    if (review) onHunkCount(change.path, review.hunks.length);
  }, [change.path, review]);
```

with a new `onHunkCount: (path: string, count: number) => void` prop, wired to `reportHunkCount`.

- [ ] **Step 2: The cursor, and following the scroller**

The cursor is `{ ref, reveal }`, not a bare ref. `reveal` is a counter that **only explicit
navigation bumps**: following the scroll anchor must move the ring without scrolling anything, or a
plain mouse scroll would yank the viewport back to the hunk header the ring just landed on.

Add beside the other state (`:235-250`):

```ts
  // The current hunk: what `j`/`k` move, what the ring marks, and what `m` / `o` act on. `reveal`
  // is bumped ONLY by an explicit move (a key, a header click) — following the scroll anchor must
  // never scroll, or a mouse scroll would fight the reveal below for the viewport.
  const [cursor, setCursor] = useState<{ ref: HunkRef | null; reveal: number }>({
    ref: null,
    reveal: 0,
  });
  const [helpOpen, setHelpOpen] = useState(false);
  const current = cursor.ref;

  const navigate = useCallback(
    (step: (list: ReviewFileHunks[], c: HunkRef | null) => HunkRef | null) => {
      setCursor((cur) => ({ ref: step(fileHunksRef.current, cur.ref), reveal: cur.reveal + 1 }));
    },
    [],
  );
```

and, after `activePath` is computed (`:502-506`):

```ts
  const activeIndex = activePath ? (pathIndex.get(activePath) ?? -1) : -1;
  // Scrolling is how the user says "I'm looking at this file now" — the ring follows, or the next
  // `j` would jump back to wherever they last pressed a key. `reveal` is deliberately untouched.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires on an anchor CHANGE; fileHunks is read live through its ref.
  useEffect(() => {
    setCursor((cur) => ({ ...cur, ref: syncToAnchor(cur.ref, fileHunksRef.current, activeIndex) }));
  }, [activeIndex]);

  const currentPath = current ? (files[current.fileIndex]?.path ?? null) : null;
```

- [ ] **Step 3: Reveal and focus the current hunk**

Add after `scrollToFile` (`:340-352`):

```ts
  // The last reveal this effect actually landed. A card outside the window isn't in the DOM yet, so
  // the first pass only scrolls to it and the effect re-runs once the window change mounts it —
  // hence the window deps, and hence this guard, so an unrelated window change can't re-fire a
  // reveal that already happened and steal focus back.
  const revealedRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: view.startIndex/endIndex are the "did the card mount yet" trigger.
  useLayoutEffect(() => {
    if (cursor.reveal === 0 || revealedRef.current === cursor.reveal) return;
    if (!current || !currentPath) return;
    const card = scrollerRef.current?.querySelector<HTMLElement>(
      `.rcard[data-path="${CSS.escape(currentPath)}"]`,
    );
    if (!card) {
      scrollToFile(currentPath);
      return;
    }
    const target =
      current.hunkIndex >= 0
        ? card.querySelector<HTMLElement>(`.rhunk__jump[data-hunk="${current.hunkIndex}"]`)
        : card.querySelector<HTMLElement>('.rcard__toggle');
    if (!target) return;
    revealedRef.current = cursor.reveal;
    target.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  }, [cursor.reveal, current, currentPath, scrollToFile, view.startIndex, view.endIndex]);
```

- [ ] **Step 4: Collapse all / Expand all**

Add beside `setCardUi` (`:450-452`):

```ts
  // A bulk toggle has to reach cards the window hasn't mounted, so it writes the per-path cache
  // (which a fresh mount seeds from) AND bumps a nonce the mounted cards react to.
  const [bulk, setBulk] = useState<{ collapsed: boolean; nonce: number }>({
    collapsed: false,
    nonce: 0,
  });
  // Collapsing every card at once invalidates the scroll offset outright. Re-anchor to the file
  // the user was on after each measurement until the offset stops moving — the ResizeObserver
  // reports the new heights over the next frame or two (§12 assumption 14).
  const keepInViewRef = useRef<string | null>(null);
  const activePathRef = useRef<string | null>(null);

  const setAllCollapsed = useCallback(
    (collapsed: boolean) => {
      for (const f of files) {
        const prev = uiCacheRef.current.get(f.path) ?? emptyUi(collapsed);
        uiCacheRef.current.set(f.path, { ...prev, collapsed });
      }
      keepInViewRef.current = activePathRef.current;
      setBulk((b) => ({ collapsed, nonce: b.nonce + 1 }));
      setAnnounce(collapsed ? 'Collapsed every file' : 'Expanded every file');
    },
    [files],
  );
```

Set `activePathRef.current = activePath;` on the line after `activePath` is computed.

Change `emptyUi` (`:889`) to take the seed:

```ts
const emptyUi = (collapsed = false): CardUiState => ({
  folds: new Map(),
  showRemaining: false,
  collapsed,
});
```

At the end of `onMeasure` (`:433`), before `setMeasureTick`:

```ts
      const keep = keepInViewRef.current;
      if (keep !== null && el) {
        const want = resolveReviewAnchor({ topPath: keep, offset: 0 }, files.length, heightOf, (p) =>
          pathIndex.get(p),
        );
        if (Math.abs(el.scrollTop - want) > 1) {
          el.scrollTop = want;
          setScrollTop(want);
        } else {
          keepInViewRef.current = null;
        }
      }
```

In `ReviewFileCard`, add props `bulkCollapsed: boolean` and `bulkNonce: number`, seed from them:

```ts
  const [ui, setUiState] = useState<CardUiState>(
    () => uiCache.get(change.path) ?? emptyUi(bulkNonce > 0 && bulkCollapsed),
  );
```

and react to a bump beside the reveal effect (`:966-968`):

```ts
  // biome-ignore lint/correctness/useExhaustiveDependencies: applied on the nonce bump alone.
  useEffect(() => {
    if (bulkNonce > 0) {
      setUi((prev) => (prev.collapsed === bulkCollapsed ? prev : { ...prev, collapsed: bulkCollapsed }));
    }
  }, [bulkNonce]);
```

Pass `bulkCollapsed={bulk.collapsed}` and `bulkNonce={bulk.nonce}` from the card list (`:700-716`).

- [ ] **Step 5: The keydown handler**

Add after `setAllCollapsed`:

```ts
  const jumpToCurrent = useCallback(() => {
    if (!current || !currentPath) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `.rcard[data-path="${CSS.escape(currentPath)}"] .rhunk__jump[data-hunk="${current.hunkIndex}"]`,
    );
    // The header button already knows its own work line; clicking it is the same path a mouse takes.
    el?.click();
  }, [current, currentPath]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // A find field or a Monaco surface inside Review owns its own letters.
      if (isTypingEntry(e.target as Element)) return;
      const action = reviewActionFor(e);
      if (!action) return;
      e.preventDefault();
      // Nothing outside Review may also act on a key Review just consumed: app shortcuts listen on
      // window and decide-shortcut.ts has no notion of this surface (spec 2026-07-03 §1).
      e.stopPropagation();
      switch (action) {
        case 'nextHunk':
          navigate(nextHunk);
          break;
        case 'prevHunk':
          navigate(prevHunk);
          break;
        case 'nextFile':
          navigate(nextFile);
          break;
        case 'prevFile':
          navigate(prevFile);
          break;
        case 'toggleReviewed':
          if (currentPath) onToggleReviewed(currentPath);
          break;
        case 'openHunk':
          jumpToCurrent();
          break;
        case 'expandAll':
          setAllCollapsed(false);
          break;
        case 'collapseAll':
          setAllCollapsed(true);
          break;
        case 'toggleHelp':
          setHelpOpen((v) => !v);
          break;
      }
    },
    [currentPath, navigate, onToggleReviewed, jumpToCurrent, setAllCollapsed],
  );
```

Add the imports this needs:

```ts
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  clampRef,
  type HunkRef,
  nextFile,
  nextHunk,
  prevFile,
  prevHunk,
  REVIEW_KEY_HELP,
  reviewActionFor,
  type ReviewFileHunks,
  syncToAnchor,
} from '../review-keymap';
import { isTypingEntry } from '../typing-guard';
```

Keep the list honest when files come and go — beside the `files` memo's consumers:

```ts
  // biome-ignore lint/correctness/useExhaustiveDependencies: a file-list change is the trigger; the list itself is read live.
  useEffect(() => {
    setCursor((cur) => ({ ...cur, ref: clampRef(cur.ref, fileHunksRef.current) }));
  }, [files.length]);
```

- [ ] **Step 6: Escape closes the help panel first**

Replace `useEscapeKey(onClose);` (`:147`) with:

```ts
  // Esc unwinds the surface one layer at a time (spec §2 Lane B): the help panel, then Review.
  // `helpOpen` is read through a ref so the window listener isn't re-bound on every toggle.
  const helpOpenRef = useRef(false);
  useEscapeKey(
    useCallback(() => {
      if (helpOpenRef.current) {
        setHelpOpen(false);
        return;
      }
      onClose();
    }, [onClose]),
  );
```

and set `helpOpenRef.current = helpOpen;` beside the `helpOpen` state. (`setHelpOpen` is declared in
Step 2, above this line — move the two `useState` calls above `useEscapeKey` if the linter objects
to use-before-declare.)

- [ ] **Step 7: Wire the scroller**

Change the scroller element (`:616-634`) to claim focus and carry the handler:

```tsx
        <div
          ref={scrollerRef}
          className="review__scroll"
          // The keymap is scoped to focus inside this element, and opening Review from a tab click
          // leaves focus on the tab — so the scroller is focusable and claims it once (assumption 11).
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onScroll={() => { /* unchanged */ }}
          onFocus={onFocusCapture}
          onBlur={onBlurCapture}
          aria-busy={anyInFlight}
        >
```

and, beside the viewport-observer effect (`:388-395`):

```ts
  useEffect(() => {
    scrollerRef.current?.focus({ preventScroll: true });
  }, []);
```

- [ ] **Step 8: The header action row**

In the aside header (`:548-563`), after `{navToggle}`:

```tsx
              <div className="review__actions">
                <button
                  type="button"
                  className="review__act review__collapseall"
                  aria-pressed={bulk.nonce > 0 && bulk.collapsed}
                  title="Collapse every file (Shift+E)"
                  onClick={() => setAllCollapsed(true)}
                >
                  Collapse all
                </button>
                <button
                  type="button"
                  className="review__act review__expandall"
                  aria-pressed={bulk.nonce > 0 && !bulk.collapsed}
                  title="Expand every file (E)"
                  onClick={() => setAllCollapsed(false)}
                >
                  Expand all
                </button>
                <button
                  type="button"
                  className="review__act review__wstoggle"
                  aria-pressed={ignoreWhitespace}
                  title="Ignore whitespace-only changes"
                  onClick={() => update({ reviewIgnoreWhitespace: !ignoreWhitespace })}
                >
                  Ignore whitespace
                </button>
                <button
                  type="button"
                  className="review__act review__helpbtn"
                  aria-pressed={helpOpen}
                  aria-haspopup="dialog"
                  title="Keyboard shortcuts (?)"
                  onClick={() => setHelpOpen((v) => !v)}
                >
                  ?
                </button>
              </div>
```

with `const ignoreWhitespace = settings.reviewIgnoreWhitespace;` beside `navOpen` (`:246`).

- [ ] **Step 9: The help panel**

Add the component at the bottom of the file:

```tsx
/** The `?` panel. Its content is REVIEW_KEY_HELP so the printed table and the bound keys are one
 *  source (webview/review-keymap.ts) and can't drift apart. */
function ReviewKeyHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="review__help" role="dialog" aria-label="Review keyboard shortcuts">
      <div className="review__helphead">
        <span>Keyboard</span>
        <button type="button" className="review__helpclose" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <dl className="review__helplist">
        {REVIEW_KEY_HELP.map((row) => (
          <div key={row.keys} className="review__helprow">
            <dt>
              <kbd>{row.keys}</kbd>
            </dt>
            <dd>{row.description}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
```

and render it inside `.review` (after `.review__body`):

```tsx
      {helpOpen && <ReviewKeyHelp onClose={() => setHelpOpen(false)} />}
```

- [ ] **Step 10: The ring on the hunk header**

`HunkList` gains `currentHunkIndex: number` and passes `index === currentHunkIndex` down as
`current`. `Hunk` gains `index: number` and `current: boolean`, and its button becomes:

```tsx
      <button
        type="button"
        className={`rhunk__jump${current ? ' rhunk__jump--current' : ''}`}
        data-hunk={index}
        aria-current={current ? 'true' : undefined}
        title="Open this hunk in the editor (o)"
        onClick={() => {
          onSetCurrent(index);
          onJumpToHunk(abs, hunk.startNewLine);
        }}
      >
```

with `onSetCurrent: (hunkIndex: number) => void` threaded from the card (which knows its own path)
up to the view — clicking a header makes it current, which is what §2 Lane B asks for:

```ts
  // A clicked header is already on screen, so this moves the ring WITHOUT bumping `reveal` —
  // scrolling to what the user just clicked would only jerk the viewport.
  const setCurrentFromCard = useCallback(
    (path: string, hunkIndex: number) => {
      const fileIndex = pathIndex.get(path);
      if (fileIndex !== undefined) setCursor((cur) => ({ ...cur, ref: { fileIndex, hunkIndex } }));
    },
    [pathIndex],
  );
```

`ReviewFileCard` gains `currentHunkIndex: number` (`-1` when this card isn't the current file) and
`onSetCurrent: (path: string, hunkIndex: number) => void`. Pass from the list:

```tsx
                  currentHunkIndex={c.path === currentPath ? (current?.hunkIndex ?? -1) : -1}
                  onSetCurrent={setCurrentFromCard}
```

The card's own header button gets `aria-current={currentHunkIndex === -1 && change.path === … }` —
simpler: give `ReviewFileCard` one more prop `isCurrentFile: boolean` and put
`aria-current={isCurrentFile && currentHunkIndex < 0 ? 'true' : undefined}` on `.rcard__toggle`, so a
binary file can still be the ring's target.

- [ ] **Step 11: Pass the whitespace option into the diff**

In `ReviewFileCard`, add an `ignoreWhitespace: boolean` prop and use it:

```ts
  const review: FileReview | null = useMemo(() => {
    if (!diff || diff.binary) return null;
    return computeFileReview(diff.head, diff.work, undefined, undefined, { ignoreWhitespace });
  }, [diff, ignoreWhitespace]);
```

(Passing `undefined` for `context` and `maxLcsCells` keeps their defaults; do NOT hard-code 3 or
`MAX_LCS_CELLS` here — Lane A owns that argument.)

- [ ] **Step 12: Styles**

In `webview/styles.css`, beside the other `.review__*` rules:

```css
/* Header action row. Sits in the navigator aside: with the aside collapsed to its rail there is
   no room for four controls, and the keyboard (e / Shift+E / ?) still reaches all of them. */
.review__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  width: 100%;
  order: 3;
}
.review__act {
  font-size: calc(11px * var(--font-scale));
  color: var(--text-dim);
  background: var(--raise);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 2px 8px;
  cursor: pointer;
}
.review__act[aria-pressed='true'] {
  color: var(--text);
  background: var(--panel-2);
  border-color: var(--accent);
}
.review__helpbtn {
  margin-left: auto;
}
/* The current hunk. Colour is not the only signal — the ring is a border, so it survives forced
   colors, and aria-current carries it to AT. */
.rhunk__jump--current {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.review__help {
  position: absolute;
  right: 18px;
  bottom: 18px;
  z-index: 5;
  min-width: 260px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r);
  box-shadow: var(--shadow);
}
.review__helphead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: calc(11px * var(--font-scale));
  color: var(--text-dim);
  margin-bottom: 6px;
}
.review__helpclose {
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
}
.review__helplist {
  margin: 0;
}
.review__helprow {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: calc(12px * var(--font-scale));
}
.review__helprow dt {
  flex: 0 0 88px;
}
.review__helprow dd {
  margin: 0;
  color: var(--text-dim);
}
```

`.review` needs `position: relative` for the panel to anchor to it — add it to the existing
`.review` rule if it isn't there.

- [ ] **Step 13: Typecheck, build, and run the unit suite**

Run: `npm run typecheck && npm run build && npx vitest run`
Expected: exit 0 / all green. If `fallow:check` still reports anything from Task 6, it means a store
export went unused — wire it rather than deleting the feature.

- [ ] **Step 14: Commit**

```bash
git add webview/components/review-view.tsx webview/styles.css
git commit -m "feat(review): scoped keymap, current-hunk ring, help panel and bulk collapse"
```

---

## Task 12: The oversize diff's "Open file" stops being dead

**Files:**
- Modify: `webview/components/doc-view.tsx:74`

**Interfaces:**
- Consumes: `onOpenFile`, already a prop of both `DocView` and `DocBody`.
- Produces: nothing.

`DiffViewer` has taken an `onOpenFile` since the oversize notice was written, and no caller has ever
passed one — so the only escape hatch out of "This file is too large to diff" has never worked (§0).

- [ ] **Step 1: Pass the callback**

In `webview/components/doc-view.tsx`, in `DocBody`, change:

```tsx
    return <DiffViewer doc={diff} viewStateId={doc.id} />;
```

to:

```tsx
    return <DiffViewer doc={diff} viewStateId={doc.id} onOpenFile={onOpenFile} />;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. `DiffViewer`'s prop is already optional and already typed
`(path: string) => void`, matching `DocBody`'s.

- [ ] **Step 3: Commit**

```bash
git add webview/components/doc-view.tsx
git commit -m "fix(diff): make the oversize notice's Open file button actually open the file"
```

---

## Task 13: Changelog entry

**Files:**
- Modify: `CHANGELOG.md` — the existing `## [Unreleased]` section (`:7`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the entries**

Append to the existing `### Added` list under `## [Unreleased]`:

```markdown
- **Review has a keyboard.** With the Review tab focused, `j` and `k` walk change to change across
  the whole changeset, `J` and `K` jump file to file, `m` marks the file you are on as reviewed,
  `o` (or Enter) opens the current change in the editor, and `e` / `Shift+E` expand or collapse
  every file at once. A ring marks where you are, and `?` prints the list without you having to
  remember any of it. Escape closes the list, then Review, as it always did.
- **Reviewed marks survive a restart.** Ticking a file used to last until you closed the tab; now
  it is remembered per repository and per changeset, and it comes back when you reopen Review —
  including in a second window, which updates as you tick. It is deliberately kept outside your
  project, so marking a file read never shows up as a change in the tree you are reviewing. If the
  file changes again after you marked it, the mark clears itself: it was a receipt for the version
  you actually read.
- **Collapse all / Expand all**, in the Review header, with the file you were on kept in view.
- **Review source quick-picks.** The source picker now offers **Last commit**, **Unpushed** (what
  is not on your upstream branch yet) and **Since branch point** (everything since this branch left
  the default branch) above the commit list. Rows that don't apply to the repository — no upstream,
  no default branch, nothing to compare — are simply not shown.
- **Ignore whitespace**, a toggle in the Review header, so a re-indent stops burying the two lines
  that actually changed. Off by default, and remembered.
```

and add, in a `### Fixed` list under the same heading:

```markdown
- **The file header now stays put while you scroll through a long file** in Review, instead of
  scrolling away and leaving you looking at a diff you can no longer name.
- **"Open file" on a too-large-to-diff file works.** The button has been there, and inert, since
  the notice was written.
```

- [ ] **Step 2: Confirm nothing else broke**

Run: `npx biome check CHANGELOG.md`
Expected: no diagnostics.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entries for the Review keyboard model and durable marks"
```

---

## Task 14: The `review-keymap-persist` e2e scenario

**Files:**
- Create: `test/e2e/review-keymap-persist.e2e.mjs`

**Interfaces:**
- Consumes: `assert`, `closeApp`, `loadPlaywright`, `makeLog`, `openSession`, `REPO`, `tapBridge` from `test/e2e/harness.mjs`.
- Produces: nothing.

This scenario **launches twice against one `userDataDir`**, so it drives Playwright directly like
`test/e2e/durability.e2e.mjs` rather than going through `runScenario` (which owns the launch).
Everything it asserts crosses the host boundary: the marks file is written and re-read by the main
process, `git:resolveRange` spawns git, and the mock shell answers neither.

- [ ] **Step 1: Write the scenario**

Create `test/e2e/review-keymap-persist.e2e.mjs`:

```js
/**
 * Review keyboard model + durable reviewed marks (real-app smoke, spec
 * 2026-08-27-review-supercharge §7 Lane B). Two launches against ONE user-data dir, because the
 * whole point is that a mark outlives the process: it is written to userData/review-marks.json by
 * the main process and pushed back to a fresh renderer on `ready`.
 *
 * Also covers the four pieces of polish that only exist in the real app: the sticky file header
 * (a CSS scrollport question no unit test can answer), the oversize diff's "Open file" button, the
 * ignore-whitespace toggle, and the source picker's quick-pick rows — which are HIDDEN here on
 * purpose: the fixture has no remote and no branch of its own, so `git:resolveRange` fails for
 * both presets and only "Last commit" may appear.
 *
 * Windows only. Run it ALONE on a quiet machine.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, loadPlaywright, makeLog, REPO, tapBridge } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('[review-keymap-persist] SKIP — suite is Windows-only');
  process.exit(0);
}

const log = makeLog('review-keymap-persist');
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

// ── Fixture ────────────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'conduit-rkp-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'conduit-rkp-ud-'));

const committed = {
  // Three changes far enough apart to become three separate hunks — that is what j/k walk.
  'alpha.ts': `${lines(40, (i) => `const a${i} = ${i};`)}\n`,
  'beta.ts': `${lines(8, (i) => `export const b${i} = ${i};`)}\n`,
  // Only ever re-indented — the ignore-whitespace case.
  'indent.ts': 'function f() {\nreturn 1;\n}\n',
  // Tall enough, once uncapped, to scroll THROUGH — the sticky-header case.
  'long.ts': `${lines(200, (i) => `const L${i} = ${i};`)}\n`,
  // Past readDiff's 2 MB cap — the oversize "Open file" case.
  'huge.ts': `${lines(60_000, (i) => `// padding line ${i} ${'x'.repeat(30)}`)}\n`,
};

git(root, 'init', '-q');
for (const [f, c] of Object.entries(committed)) writeFileSync(join(root, f), c);
git(root, 'add', '.');
git(root, '-c', 'user.email=e2e@conduit.test', '-c', 'user.name=e2e', 'commit', '-qm', 'base');

const alphaChanged = committed['alpha.ts']
  .replace('const a5 = 5;', 'const a5 = 500;')
  .replace('const a20 = 20;', 'const a20 = 2000;')
  .replace('const a35 = 35;', 'const a35 = 3500;');
writeFileSync(join(root, 'alpha.ts'), alphaChanged);
writeFileSync(join(root, 'beta.ts'), committed['beta.ts'].replace('b3 = 3', 'b3 = 300'));
writeFileSync(join(root, 'indent.ts'), 'function f() {\n    return 1;\n}\n');
writeFileSync(
  join(root, 'long.ts'),
  `${lines(200, (i) => (i % 3 === 0 ? `const L${i} = ${i * 2};` : `const L${i} = ${i};`))}\n`,
);
writeFileSync(join(root, 'huge.ts'), `${committed['huge.ts']}// one more line\n`);

const porcelainBefore = git(root, 'status', '--porcelain');
log(`fixture: ${root}`);

// ── Launch plumbing (two launches, one profile — see test/e2e/durability.e2e.mjs) ───────────────
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
  return { app, page };
}

/** Open the fixture repo and put the Review tab on screen with its cards rendered. */
async function openReview(page) {
  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.waitForSelector('.git-indicator__review', { state: 'visible', timeout: 25000 });
  await page.click('.git-indicator__review');
  await page.waitForSelector('.review .rcard', { state: 'visible', timeout: 20000 });
  // Every mark control is gated on the first review:marks push; nothing below may click early.
  await page.waitForFunction(
    () => document.querySelector('.review__check')?.disabled === false,
    null,
    { timeout: 15000 },
  );
}

const focusScroller = (page) =>
  page.evaluate(() => document.querySelector('.review__scroll')?.focus());

/** { path, hunk } of whatever currently carries the ring inside the card list. */
const ring = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.review__scroll [aria-current="true"]');
    if (!el) return null;
    return {
      path: el.closest('.rcard')?.getAttribute('data-path') ?? null,
      hunk: el.getAttribute('data-hunk'),
    };
  });

const meter = (page) => page.textContent('.review__count').then((t) => (t ?? '').trim());

const scrollToCard = async (page, path) => {
  await page.locator(`.review__nav .review__navrow[data-path="${path}"] .review__navbtn`).click();
  await page.waitForSelector(`.review .rcard[data-path="${path}"]`, { timeout: 10000 });
};

let firstApp;
let secondApp;
try {
  // ── Launch 1 ─────────────────────────────────────────────────────────────────────────────────
  const first = await launch();
  firstApp = first.app;
  const page = first.page;
  await openReview(page);
  log('Review open with the fixture changeset ✓');

  // (1) j / k walk hunks INSIDE a file; J / K walk files. Both wrap.
  await focusScroller(page);
  await page.keyboard.press('j');
  await page.waitForFunction(() => !!document.querySelector('.review__scroll [aria-current="true"]'), null, {
    timeout: 8000,
  });
  const r1 = await ring(page);
  assert(r1?.path, `j must put the ring on a hunk header; got ${JSON.stringify(r1)}`);
  await page.keyboard.press('j');
  const r2 = await ring(page);
  assert(
    r2 && (r2.path !== r1.path || r2.hunk !== r1.hunk),
    `a second j must move the ring; stayed at ${JSON.stringify(r1)}`,
  );
  await page.keyboard.press('k');
  const r3 = await ring(page);
  assert(
    r3 && r3.path === r1.path && r3.hunk === r1.hunk,
    `k must undo j; ${JSON.stringify(r3)} !== ${JSON.stringify(r1)}`,
  );
  await page.keyboard.press('J');
  const r4 = await ring(page);
  assert(r4 && r4.path !== r1.path, `J must move to another FILE; stayed on ${r1.path}`);
  await page.keyboard.press('K');
  const r5 = await ring(page);
  assert(r5 && r5.path === r1.path, `K must come back to ${r1.path}; got ${r5?.path}`);
  log(`j/k/J/K move the ring (${r1.path} #${r1.hunk} ⇄ ${r4.path}) ✓`);

  // (2) `?` opens the help panel and Esc closes it WITHOUT closing Review.
  await page.keyboard.press('?');
  await page.waitForSelector('.review__help', { state: 'visible', timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.review__help', { state: 'detached', timeout: 5000 });
  await page.waitForSelector('.review .rcard', { state: 'visible', timeout: 5000 });
  log('? opens the key list; Esc closes it and leaves Review open ✓');

  // (3) `m` marks the file the ring is on; the navigator checkbox marks another.
  assert((await meter(page)) === `0 / 5 reviewed`, `meter should start empty; got "${await meter(page)}"`);
  await scrollToCard(page, 'alpha.ts');
  await focusScroller(page);
  await page.keyboard.press('J'); // land the ring somewhere deterministic first
  await page.evaluate(() => {
    const el = document.querySelector('.review__scroll [aria-current="true"]');
    el?.closest('.rcard')?.setAttribute('data-ringed', '1');
  });
  const markedByKey = await page.evaluate(
    () => document.querySelector('.rcard[data-ringed="1"]')?.getAttribute('data-path') ?? '',
  );
  assert(markedByKey, 'the ring must sit inside a card before pressing m');
  await page.keyboard.press('m');
  await page.waitForFunction(() => /^1 \/ 5 reviewed$/.test(document.querySelector('.review__count')?.textContent ?? ''), null, { timeout: 8000 });
  await page.locator('.review__nav .review__navrow[data-path="alpha.ts"] .review__check').click();
  await page.waitForFunction(() => /^2 \/ 5 reviewed$/.test(document.querySelector('.review__count')?.textContent ?? ''), null, { timeout: 8000 });
  log(`m marked "${markedByKey}"; the checkbox marked alpha.ts ✓`);

  // (4) Collapse all / Expand all.
  await page.click('.review__collapseall');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.review__scroll .rcard__toggle')].every(
        (b) => b.getAttribute('aria-expanded') === 'false',
      ),
    null,
    { timeout: 8000 },
  );
  assert(
    (await page.getAttribute('.review__collapseall', 'aria-pressed')) === 'true',
    'Collapse all must report itself pressed',
  );
  await page.click('.review__expandall');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.review__scroll .rcard__toggle')].every(
        (b) => b.getAttribute('aria-expanded') === 'true',
      ),
    null,
    { timeout: 8000 },
  );
  log('Collapse all / Expand all reach every mounted card ✓');

  // (5) The file header sticks while you scroll THROUGH a long card.
  await scrollToCard(page, 'long.ts');
  await page.locator('.rcard[data-path="long.ts"] .rcard__showrest').click();
  await page.evaluate(() => {
    const el = document.querySelector('.review__scroll');
    if (el) el.scrollTop += 400;
  });
  await page.waitForTimeout(200);
  const stuck = await page.evaluate(() => {
    const card = document.querySelector('.rcard[data-path="long.ts"]');
    const head = card?.querySelector('.rcard__head');
    const scroll = document.querySelector('.review__scroll');
    if (!card || !head || !scroll) return null;
    return {
      card: card.getBoundingClientRect().top,
      head: head.getBoundingClientRect().top,
      port: scroll.getBoundingClientRect().top,
    };
  });
  assert(stuck, 'long.ts card, its header and the scroller must all be present');
  assert(
    stuck.card < stuck.port - 20,
    `the card's own top must be scrolled above the viewport; card ${stuck.card} vs port ${stuck.port}`,
  );
  assert(
    Math.abs(stuck.head - stuck.port) < 8,
    `the file header must stay pinned at the scroller's top; head ${stuck.head} vs port ${stuck.port}`,
  );
  log('the file header stays pinned while its card scrolls past ✓');

  // (6) Ignore whitespace hides an indent-only change.
  await scrollToCard(page, 'indent.ts');
  await page.click('.review__wstoggle');
  await page.waitForFunction(
    () =>
      (document.querySelector('.rcard[data-path="indent.ts"]')?.textContent ?? '').includes(
        'No textual changes.',
      ),
    null,
    { timeout: 8000 },
  );
  await page.click('.review__wstoggle');
  await page.waitForFunction(
    () => !!document.querySelector('.rcard[data-path="indent.ts"] .rhunk'),
    null,
    { timeout: 8000 },
  );
  log('ignore-whitespace hides an indent-only change and restores it ✓');

  // (7) The source picker offers Last commit, and hides the two rows this repo can't resolve.
  await page.click('.gitband__source');
  await page.waitForSelector('.commit-picker__row', { state: 'visible', timeout: 10000 });
  // Both presets need a round trip; give the replies a beat before asserting an ABSENCE.
  await page.waitForTimeout(600);
  const pickerText = await page.textContent('.commit-picker__list');
  assert(pickerText.includes('Last commit'), 'the picker must offer Last commit');
  assert(
    !pickerText.includes('Unpushed'),
    'a repo with no upstream must not offer Unpushed',
  );
  assert(
    !pickerText.includes('Since branch point'),
    'a repo that IS its default branch must not offer Since branch point',
  );
  // Close by re-clicking the trigger: Escape here would also reach Review's own handler.
  await page.click('.gitband__source');
  await page.waitForSelector('.commit-picker__row', { state: 'detached', timeout: 8000 });
  log('picker shows Last commit only ✓');

  // (8) The marks file exists, and marking left the repo alone.
  const marksPath = join(userDataDir, 'review-marks.json');
  await page.waitForFunction(() => true, null, { timeout: 1 });
  assert(existsSync(marksPath), `review-marks.json was not written to ${userDataDir}`);
  const stored = JSON.parse(readFileSync(marksPath, 'utf8'));
  assert(stored.version === 1, `marks file version should be 1; got ${stored.version}`);
  assert(
    git(root, 'status', '--porcelain') === porcelainBefore,
    'marking a file reviewed must not change anything in the repo',
  );
  assert(!existsSync(join(root, '.conduit')), 'marks must never be written into the project');
  log('marks live in userData and the repo is untouched ✓');

  // (9) The oversize notice's "Open file" opens the file. Done LAST: it leaves the Review tab.
  await scrollToCard(page, 'huge.ts');
  await page.locator('.rcard[data-path="huge.ts"] .rcard__split').click();
  await page.waitForSelector('.viewer__notice--oversize .viewer__notice-action', { timeout: 20000 });
  await page.click('.viewer__notice--oversize .viewer__notice-action');
  await page.waitForFunction(
    () => (window.monaco?.editor.getModels() ?? []).some((m) => m.uri.toString().endsWith('huge.ts')),
    null,
    { timeout: 25000 },
  );
  log('the oversize notice’s Open file button opens the file ✓');

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'review-keymap-persist-1.png') }).catch(() => {});

  await closeApp(firstApp, page);
  firstApp = null;
  log('first launch closed (before-quit flushed review-marks.json)');

  // ── Between launches: one of the two marked files changes on disk ───────────────────────────
  writeFileSync(join(root, 'beta.ts'), committed['beta.ts'].replace('b3 = 3', 'b3 = 999'));

  // ── Launch 2 ─────────────────────────────────────────────────────────────────────────────────
  const second = await launch();
  secondApp = second.app;
  const page2 = second.page;
  await openReview(page2);

  await page2.waitForFunction(
    () => /^1 \/ 5 reviewed$/.test(document.querySelector('.review__count')?.textContent ?? ''),
    null,
    { timeout: 20000 },
  );
  const survived = await page2.evaluate(() => ({
    alpha: document
      .querySelector('.review__nav .review__navrow[data-path="alpha.ts"] .review__check')
      ?.checked,
    beta: document
      .querySelector('.review__nav .review__navrow[data-path="beta.ts"] .review__check')
      ?.checked,
  }));
  assert(survived.alpha === true, 'an unchanged file must still read as reviewed after a restart');
  assert(survived.beta === false, 'a file that changed since must lose its mark');
  log('marks survived the restart; the changed file retired its own ✓');

  await page2.screenshot({ path: join(shotDir, 'review-keymap-persist-2.png') }).catch(() => {});
  await closeApp(secondApp, page2);
  secondApp = null;

  log('PASS ✓ review-keymap-persist');
  process.exit(0);
} catch (e) {
  const isAssertion = e?.name === 'AssertionError';
  if (isAssertion) log('FAIL ✗', e.message);
  else {
    console.error('[review-keymap-persist] ERROR:', e?.message || e);
    if (e?.stack) console.error(e.stack);
  }
  try {
    if (firstApp) await firstApp.close();
    if (secondApp) await secondApp.close();
  } catch {
    /* already gone */
  }
  process.exit(isAssertion ? 1 : 2);
}
```

- [ ] **Step 2: Reconcile the two selectors this scenario depends on**

Confirm the four controls Task 11 Step 8 renders still carry their own class alongside the shared
`review__act` — `review__collapseall`, `review__expandall`, `review__wstoggle`, `review__helpbtn` —
and that `.rhunk__jump` carries `data-hunk`. The scenario locates every one of them by name; a test
that finds a control by its position in a row breaks the first time a control is added beside it.

- [ ] **Step 3: Run the scenario alone**

Run: `node test/e2e/run-smoke.mjs review-keymap-persist`
Expected: `PASS review-keymap-persist`. Run it on a **quiet** machine — leftover `cmd.exe` /
`conhost` from an earlier run starves ConPTY and makes every scenario look broken (`CLAUDE.md`).
Never clean up by killing processes by name; the harness teardown is PID-scoped.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/review-keymap-persist.e2e.mjs
git commit -m "test(e2e): cover the Review keymap, durable marks, sticky header and quick-picks"
```

---

## Task 15: Full gate

**Files:** none.

**Interfaces:**
- Consumes: everything above.
- Produces: a green lane.

- [ ] **Step 1: Run the full verify gate**

Run: `npm run verify`
Expected: exit 0. Read the WHOLE output — never pipe it through `tail`, which has twice hidden a
"Found N errors" line in this repo. If `fallow:check` reports an unused export, delete the export
rather than suppressing the check; if a check fails, fix the code, never the check.

- [ ] **Step 2: Run the full smoke suite**

Run: `npm run test:smoke`
Expected: every scenario PASS or SKIP, zero FAIL. `review-navigator`, `review-card-collapse`,
`review-commit-picker`, `review-commit-source`, `review-compare`, `review-virtualize` and
`tab-scroll-state` are the regression surface for this lane — re-run any single failure **alone**
before believing it.

- [ ] **Step 3: Capture the evidence**

```bash
mkdir -p .autoloop/evidence
npm run verify              > .autoloop/evidence/lane-b-verify.log 2>&1
node test/e2e/run-smoke.mjs review-keymap-persist > .autoloop/evidence/lane-b-e2e.log 2>&1
```

`.autoloop/` is already outside the tracked tree; confirm with Step 4 rather than assuming.

- [ ] **Step 4: Confirm the working tree is clean of scratch**

Run: `git status --ignored --short`
Expected: only the intended files. Screenshots live under `%TEMP%\claude-scratch`; nothing from this
lane belongs in the repo.

- [ ] **Step 5: Commit anything the gate corrected**

```bash
git add -A
git commit -m "chore: verify green for the Review keyboard model and durable marks"
```

(Skip if `git status` is already clean.)

---

## Self-Review

Run against the spec with fresh eyes.

**1. Spec coverage (revision note, §2 Lane B, §3, §4, §5, §7 Lane B, §8–§12)**

| Spec requirement | Task |
|---|---|
| Scoped keymap, active only inside the Review scroller; handled keys stop propagation | 1 (`reviewActionFor`), 11 (handler on `.review__scroll`, `stopPropagation`, `isTypingEntry`, `tabIndex={-1}`) |
| `j`/`k` next/previous hunk across files, wrapping; scrolls + focuses the hunk header | 1 (`nextHunk`/`prevHunk`), 11 (reveal effect) |
| `J`/`K` next/previous file | 1 (`nextFile`/`prevFile`), 11 |
| `m` toggle reviewed on the current file | 10 (`onToggleReviewed`), 11 (`toggleReviewed` case) |
| `o`/`Enter` open the current hunk via the existing `jumpToHunk` | 11 (`jumpToCurrent` clicks the same header button a mouse would) |
| `e` / `Shift+E` expand / collapse all | 1, 11 (`setAllCollapsed`) |
| `?` shows the key list | 1 (`REVIEW_KEY_HELP`), 11 (`ReviewKeyHelp`) |
| `Esc` closes the panel, then Review | 11 (Step 6) |
| **`s`/`d`/`c`, `/` and `Mod+F` are NOT bound** | 1 (asserted absent in the unit test), 11 (not in the switch), 13 (absent from the changelog), plan header |
| "Current hunk" = the header nearest the anchor; a ring marks it; clicking a header makes it current | 1 (`syncToAnchor`), 11 (anchor effect, `rhunk__jump--current`, `onSetCurrent`) |
| `aria-current` on the current hunk header | 11 (Step 10), 14 (asserted) |
| Collapse all / Expand all header buttons, `aria-pressed`; current file stays in view | 11 (Steps 4 + 8, `keepInViewRef`), 14 |
| Sticky file header; height cache unaffected | 8 (root cause: `overflow: clip`), 14 (asserted against the real scrollport) |
| Marks in `userData/review-marks.json`, `ReviewMarksFile` shape, atomic write + quit flush | 2 (model), 5 (host: `persistFile` + `flushStateSync`) |
| Host holds them in memory and **broadcasts** to every window | 5 (`broadcast` on change, `replyHere` on ready), 6 (store) |
| `source` = `working` / `commit:<sha>` / `range:<rangeKey>` | 10 (reuses the existing `sourceKey`) |
| `contentHash` = FNV-1a of the new-side text; mismatch ignored **and pruned**; 2 000/repo newest | 2 (`contentHash`, `reviewedPaths`, `staleMarks`, `MAX_MARKS_PER_REPO`), 10 (the retire effect) |
| Load gate: mark controls disabled until the first push | 6 (`loaded`), 10 (`canMark`), 4 (preview also opens it), 14 (waits for it) |
| `reviewed` leaves the `view-state-store` `reviewAnchor` kind; the anchor stays | 10 (Step 1) |
| Meter reads from the new store | 10 (`computeReviewProgress(files, reviewed)` unchanged, fed from `reviewedPaths`) |
| `git:resolveRange { sessionId, preset }` → sha endpoints or `{ error }`; `@{upstream}`, `merge-base`, `origin/HEAD` → `main` → `master`; through `git-exec` | 3 (pure resolver + fallback order), 4 (protocol), 5 (`runGit` deps) |
| Pinned rows *Last commit* (existing commit source for HEAD) · *Unpushed* · *Since branch point*; hidden when unresolvable | 9 (`buildPinnedSources` + wiring), 14 (absence asserted) |
| `doc-view.tsx` passes `onOpenFile` to `DiffViewer` | 12, 14 |
| Ignore whitespace: setting, header toggle, `computeFileReview` option, real text rendered | 7 (option + setting), 11 (toggle + the card's call), 14 |
| §4 two windows on one repo → last writer wins | 5 (broadcast on every change), 6 (host echo replaces the optimistic list) |
| §4 corrupt marks file → empty + a next write that replaces it | 2 (`parseMarksFile` tolerance) |
| §4 truncated source → `j`/`k` cover shipped files only | 1 (the cursor walks the `files` array it is given, which is already the truncated list) |
| §10 live-region announcements "Marked reviewed" / "Unmarked" | 10 (`setAnnounce`) |
| §7 e2e `review-keymap-persist` | 14 |
| CHANGELOG | 13 |

No gaps. Lanes A and C–F are absent by construction, and the one place they touch this lane —
`computeFileReview`'s 4th positional argument, which Lane A added — is explicitly preserved
(Task 7 Step 5, Task 11 Step 11).

**2. Placeholder scan**

No "TBD", no "similar to Task N", no "add error handling here". Every implementation step carries the
actual code or the exact edit (old text → new text) with the file and line anchor; every test step
carries real assertions with real expected values. The two steps that say "match the neighbouring
style" (Task 7 Step 7's `coerceSettings` call form, Task 4 Step 5's preview `ready` branch) name the
exact file and what to look for, because those two call sites vary within their own files.

**3. Type consistency**

- `ReviewMark` is declared once, in `src/review-marks.ts` (Task 2), and re-exported by
  `src/protocol.ts` (Task 4). `review-marks-store.ts` and `review-view.tsx` import it from
  `protocol`, the host from `review-marks` — one shape either way.
- `ReviewMarksRepo` (`{ root, marks }`) is the element type of `review:marks`'s `repos` (Task 4), the
  argument of `applyMarksPush` (Task 2) and what `allMarkRepos()` builds (Task 5). All three agree.
- `ReviewMarksFile` never crosses the wire — only `parseMarksFile` / `serializeMarksFile` /
  `setMark` / `marksFor` touch it, all host-side in Task 5.
- `RangePreset` is declared in `src/range-preset.ts` (Task 3) and re-exported by `protocol.ts`;
  `git:resolveRange`, `git:resolveRangeResult`, `resolveRangePreset` and the picker's `presets` state
  all key on the same two literals.
- `ResolvedRange` (`{ base: RefEndpoint; head: RefEndpoint }`) is produced by `resolveRangePreset`
  (Task 3) and consumed by `PinnedSourceInput` (Task 9); the reply's optional `base`/`head` are
  narrowed to it in the picker's subscribe (`msg.base && msg.head`).
- `...res` spread into the `git:resolveRangeResult` reply (Task 5) is sound: `ResolvedRange` supplies
  `base` + `head`, the failure branch supplies `error`, and the message declares all three optional.
- `HunkRef` (`{ fileIndex, hunkIndex }`) and `ReviewFileHunks` (`{ path, hunkCount }`) are declared in
  `webview/review-keymap.ts` (Task 1) and used unchanged in Task 11 — `hunkIndex === -1` means the
  same thing in the module, in the reveal effect and in the `aria-current` branch.
- The cursor state is `{ ref: HunkRef | null; reveal: number }` throughout Task 11: `navigate` and
  the keydown switch bump `reveal`, the anchor effect / `clampRef` effect / `setCurrentFromCard`
  spread it unchanged, and the reveal layout effect is the only reader — `setCurrent` appears
  nowhere. `current` is a derived alias (`cursor.ref`) so every downstream read is one field.
- `ReviewOptions` (Task 7) is the 5th parameter of `computeFileReview` and the object Task 11's card
  passes; the 3rd and 4th arguments are passed as `undefined` there so Lane A's defaults hold.
- `MarksSnapshot` (`{ loaded, byRoot }`) is what `getMarksSnapshot` returns (Task 6) and what
  `useSyncExternalStore` yields in Task 10; `marks.loaded` and `marks.byRoot` are the only fields read.
- `CardUiState` is unchanged; only `emptyUi`'s signature gains a defaulted parameter (Task 11 Step 4),
  so every existing call site still compiles.
- CSS class names `.rhunk__jump--current`, `.review__actions`, `.review__act`,
  `.review__collapseall`, `.review__expandall`, `.review__wstoggle`, `.review__help` are produced in
  Task 11 and asserted in Task 14; `.rcard`'s `overflow: clip` is produced in Task 8 and asserted in
  both Task 8 and Task 14.

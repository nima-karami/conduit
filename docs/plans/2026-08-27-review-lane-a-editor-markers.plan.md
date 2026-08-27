# Editor Change Decorations (Review supercharge — Lane A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, live in the Monaco editor, every line that differs from HEAD — a gutter bar/triangle per change, matching overview-ruler and minimap marks, a hover tooltip naming the kind and line count, and `Alt+F5` / `Shift+Alt+F5` next/previous-change navigation with a spoken "Change N of M".

**Architecture:** The host gains one new request (`git:headBlob`) that returns a file's HEAD blob text plus its HEAD sha. It reuses `readDiff`'s existing plumbing — the single `git show HEAD:<rel>` path in `electron/main.ts`, `MAX_BYTES`, `toLf` — with the `rev-parse` lookups memoised so N open editors on one HEAD change cost N `show`s rather than 4N spawns. The renderer caches the blob per `path + headSha`, diffs it against the live Monaco model with the existing pure `computeFileReview` (the same function Review uses, so the editor and Review's "All" scope can never disagree) under a **smaller, decoration-specific LCS budget**, and turns the resulting hunks into Monaco decorations through a new pure module. One React hook owns the fetch/debounce/recompute/decoration-collection lifecycle inside `CodeViewer`.

**Tech Stack:** TypeScript (two tsconfigs: host `tsconfig.json`, renderer `tsconfig.webview.json`), React 18, monaco-editor, Electron IPC via `src/protocol.ts`, Vitest for unit tests, Playwright-Electron for the e2e scenario, Biome for lint/format.

**Spec:** `docs/specs/2026-08-27-review-supercharge.md` — read the revision note at the top, §0, §2 "Lane A", §3, §4, §5, §7 "Lane A", §8–§11. This plan implements **Lane A only**. Lanes B–F are out of scope; do not build them.

> **The change peek is NOT in this lane.** Post-review revision (2026-08-27): the click-to-peek view zone, its removed-line list and its Stage/Discard buttons moved to **Lane E** — it is the codebase's first view zone and only earns its keep with actions attached. Do not build `usePeekZone`, a `ChangePeekPanel`, an `agentdeck.peekChange` action, a "Peek change" menu row, or a `--change-peek-bg` token. The gutter marker's only interaction in Lane A is **hover → tooltip**.

## Global Constraints

Copied from the spec and from `CLAUDE.md`. Every task's requirements implicitly include this section.

- **Baseline is working tree vs HEAD, always.** Not configurable. (§2 Lane A, §5)
- **`git:headBlob` contract:** `{ path }` → `{ path, headSha: string|null, text: string|null, reason?: 'untracked'|'binary'|'oversize'|'notRepo'|'error' }`; **`readDiff` plumbing** — no second `git show` path; containment as `git:blame`; LF-normalised; 2 MB `MAX_BYTES`. (§3)
- **The toplevel lookup is memoised per directory** so one HEAD change with N editors is N `show`s, not 2N spawns. (§2 Lane A)
- **Debounce is 300 ms** after the last edit; also recompute on mount and on save. (§2 Lane A, §5)
- **Hunks are computed in the renderer** with `computeFileReview` (`src/review-hunks.ts`).
- **The editor gets its own, smaller cell budget:** `MAX_DECORATION_LCS_CELLS = 250_000` (≈500×500 changed region), exposed as an **option on `computeFileReview`**; exceeding it → `degraded`. (§2 Lane A, §5 "Budgets")
- **Recompute performance:** a 2 000-line file with a 50-line change must cost **< 16 ms** — asserted as a unit benchmark. (§7 Lane A)
- **One `editor.createDecorationsCollection()` per editor instance**, `.set()` wholesale on recompute, `.clear()` on model swap, disposed with the editor. (§2 Lane A)
- **Decoration shape per hunk:** added = `linesDecorationsClassName` solid bar + `overviewRuler` mark + `minimap` mark; modified = dashed bar + marks; deleted = triangle on the line after the deletion (last line at EOF) + marks; `hoverMessage` "Added 3 lines" / "Modified 2 lines" / "Deleted 2 lines". (§2 Lane A)
- **Next/prev reuse `webview/diff-nav.ts`.** Wraps; announces "Change N of M" via the live region. (§2 Lane A)
- **Minimap default:** `minimap: { enabled: true, renderCharacters: false, showSlider: 'mouseover' }`. Reverses spec 2026-06-11-minimap — user decision 2026-08-27. (§2 Lane A, §5)
- **Settings:** `editorMinimap` (default on) and `editorChangeMarkers` (default on), Settings › **Appearance** › Editor & code, beside `wordWrap`. (§5)
- **Keys:** `Alt+F5` / `Shift+Alt+F5`, registered via `editor.addAction`, rebindable through `webview/shortcuts.ts`'s **Editor** group, plus explicit palette rows and `buildEditorMenuItems` rows gated on a new `hasChanges` field of `EditorMenuContext`. Lane A's menu rows are **Next change** and **Previous change** only. (§2 Lane A, §9)
- **States:** `none` (binary / oversize / not a repo / any non-ok `GitResult` — notFound, timeout, aborted — → no markers, one host log line, no UI error) · `loading` (no markers, no spinner) · `live` · `degraded` (budget hit → markers off + one status hint "Change markers off — file changed too much to line-match") · `stale` (HEAD moved → refetch; the old collection is held until the new one is ready, so no all-added flash). **Untracked file = `live` with one whole-file added hunk.** (§2 Lane A, §8)
- **Colour never alone:** added = solid bar, modified = dashed bar, deleted = triangle. (§10)
- **Forced colors: markers use `border`, not `background`.** (§10)
- **Tokens:** `--change-added`, `--change-modified`, `--change-deleted` (≥ **3:1** on the gutter), per theme (Aero / Aero Dark / Neon), beside the existing `--diff-*` block (`webview/styles.css:176`). Monaco cannot read CSS vars for `overviewRuler.color` / `minimap.color`: resolve via `getComputedStyle` and re-`set()` the collection on theme change. (§11)
- **Live-region announcements** via `aria-live="polite"`: "Change N of M", "No changes", "Change markers are off". (§7, §10)
- **i18n:** none — English literals, repo convention. (§1, §10)
- **NEVER write redundant comments.** A comment explains *why* (a non-obvious constraint or gotcha), never restates *what* the code says. Don't re-explain a decision that lives in the spec — link to it (`// see spec 2026-08-27-review-supercharge §2 Lane A`). (`CLAUDE.md`)
- **Fix root causes, no band-aids.** No `!important`, no specificity escalation, no `as any` / `@ts-ignore`. (`CLAUDE.md`)
- **Two tsconfigs.** `npm run typecheck` runs both — a change can pass one and fail the other. Never put a `node:` import in a module the renderer imports at runtime. (`CLAUDE.md`)
- **CI `verify` runs on `ubuntu-latest`.** Never let a unit test depend on `process.platform`, `path.sep`, `Uri.file`'s backslash handling, or drive-letter casing. Normalise explicitly inside the code under test. (`CLAUDE.md`)
- **`npm run verify` is the gate.** Never disable, downgrade, narrow, or defer one of its checks. (`CLAUDE.md`)
- **The e2e scenario runs hidden** on the shared harness (`test/e2e/harness.mjs`, `CONDUIT_E2E=1` → `show:false`). Run it alone on a quiet machine; a loaded machine fails PTY-adjacent e2es the way a broken PTY does. (`CLAUDE.md`)
- **Scratch artifacts never land in the repo.** Screenshots go to an absolute path under `%TEMP%\claude-scratch`, matching `test/e2e/git-blame.e2e.mjs:60-62`. (`CLAUDE.md`)
- **Docs layout is a contract (ADR 0003).** User-facing changes go in root `CHANGELOG.md`.

## Assumptions

Recorded because this is an unattended pipeline — no questions were asked.

1. **`requestId` is added to the `git:headBlob` pair** even though §3 doesn't list it. Every other latest-wins host request in this repo carries one (`git:commitDiff`, `git:rangeDiff`, `contentSearchResults`), and without it a slow reply for an old model can clobber a newer one. The spec's `error?` field is **dropped**: `reason` already carries the outcome and §2 says a failure surfaces no UI error, so a second human-readable string would have no consumer.
2. **`git:headBlob` carries no `sessionId`.** `git:blame` needs one only to find a session; the repo here is resolved from the file's own directory (§2 Lane A says exactly that), so requiring a live session would break markers for a doc whose session was closed.
3. **The HEAD-change signal is the existing `fsChanged` broadcast**, not a new field on `GitInfo`. `src/watch-filter.ts:36-40` deliberately does *not* ignore `.git/HEAD` or `.git/refs/**`, so a commit, checkout, or reset already emits `fsChanged` for the root. Threading a full HEAD sha through `GitInfo` would touch `makeGitInfo`'s invariants and every consumer — out of proportion for this lane.
4. **`ls-files --error-unmatch` is not spawned.** "Untracked" is read off `git show HEAD:<rel>`'s own exit code (128, "does not exist in HEAD"), distinguished from a genuine failure by `GitResult`'s `notFound` / `timedOut` / `aborted` / `truncated` flags. That is what makes the per-file cost exactly **one** `show` spawn, which is what §2 Lane A asks for.
5. **Both `rev-parse` lookups are memoised**, not just the toplevel: `--show-toplevel` per directory (30 s TTL) and `HEAD` per repo root (1 s TTL). One HEAD change with N editors then costs one `rev-parse HEAD` plus N `show`s. Concurrent callers share one in-flight promise, which is what actually collapses a burst.
6. **Markers are emitted per contiguous change run, not per whole hunk.** `computeFileReview` keeps unchanged gaps of ≤ 2×context *inside* one hunk, so a per-hunk bar would paint lines the agent never touched. Per-run is what §2's "added / modified / deleted" describes visually.
7. **"Change N of M" counts distinct anchor lines.** A pure deletion anchors to the line after it, which can coincide with an added run's first line; the navigation list is deduped so `Alt+F5` can't stall on a repeated target.
8. **`hasChanges` on `EditorMenuContext` is optional** (`hasChanges?: boolean`), matching the file's existing optional fields. Making it required would force a mechanical edit of twelve unrelated literals in `test/unit/editor-menu.test.ts` for no behavioural gain; the field exists and gates the rows either way.
9. **`computeFileReview` takes the budget as an optional 4th positional parameter**, `maxLcsCells = MAX_LCS_CELLS`, rather than becoming an options object. Every existing caller is untouched, and `context` already sits in that position style.
10. **The e2e's "deletion" fixture is deleted *lines* inside a tracked file**, not a deleted file. A file removed from the working tree cannot be opened in the editor, so it has no gutter to assert on.
11. **The e2e asserts decorations through `window.monaco.editor.getEditors()`.** `webview/monaco-setup.ts:34` already exposes `window.monaco` unconditionally and `test/e2e/git-blame.e2e.mjs:43-47` already drives it — no `window.__conduitEditor` seam is needed, and adding one under `CONDUIT_E2E` would be a second, weaker path to the same object.
12. **`--change-*` tokens are declared in all three theme blocks.** Aero and Aero Dark share a hue family with values retuned for each theme's `--code-base`; Neon takes its own palette. Every value is verified ≥ 3:1 against that theme's `--code-base` by the test in Task 7.
13. **`gitShow`'s failure path changes shape slightly.** Today `electron/main.ts:688-694` returns whatever the `git()` helper resolves and callers `.catch(() => '')`. The refactor makes it return `''` explicitly on a non-ok result and bounds it with `GIT_TIMEOUT.diff` — same observable behaviour for `readDiff`, with a timeout it previously lacked.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/repo-rel.ts` | Pure, node-free path containment: repo-relative path + under-root test, platform-independent. |
| `src/git-memo.ts` | Bounded, TTL'd async memo with in-flight dedupe — the `rev-parse` collapse. |
| `src/head-blob.ts` | Host-side `readHeadBlob`: containment, unborn HEAD, untracked-vs-error classification, cap, binary, LF. All git primitives injected; no spawn of its own. |
| `webview/head-blob-cache.ts` | Renderer cache of HEAD blobs keyed `path + headSha`, with a per-path "latest" pointer and a bound. |
| `webview/change-decorations.ts` | Pure: hunks → markers, markers → Monaco decoration descriptors, tooltip text, nav-line adapter, `MAX_DECORATION_LCS_CELLS`. Monaco imported **type-only**. |
| `webview/monaco-keybinding.ts` | Pure: a `shortcuts.ts` combo string → a Monaco keybinding number, given injected keycode tables. |
| `webview/change-nav-registry.ts` | Tiny external store letting the command palette route next/previous-change to the active doc's editor (mirrors `webview/save-registry.ts`). |
| `webview/use-change-markers.ts` | The hook: fetch, cache, debounce, recompute, decoration collection, states, navigation, announcements. |
| `test/unit/repo-rel.test.ts`, `test/unit/git-memo.test.ts`, `test/unit/head-blob.test.ts`, `test/unit/change-decorations.test.ts`, `test/unit/head-blob-cache.test.ts`, `test/unit/monaco-keybinding.test.ts` | Unit coverage for the pure modules. |
| `test/e2e/editor-change-markers.e2e.mjs` | The lane's host-boundary scenario. |

**Modified**

| File | Change |
|---|---|
| `src/protocol.ts` | `HeadBlobReason` type; `git:headBlob` request; `git:headBlobResult` reply. |
| `src/file-service.ts` | Export the existing `MAX_BYTES` and `toLf`. |
| `src/review-hunks.ts` | `computeFileReview` / `diffLines` take an optional `maxLcsCells`. |
| `electron/main.ts` | Memoised `repoTopLevel` / `headShaFor`; a single `gitShowHead` primitive behind `gitShow` / `gitShowBuffer`; `case 'git:headBlob'`. |
| `webview/bridge.ts` | Preview (no-host) reply for `git:headBlob`. |
| `src/settings.ts` | `editorMinimap`, `editorChangeMarkers` — type, defaults, coercion. |
| `webview/appearance-sections.ts` | Two new control ids in the `editor` section. |
| `webview/components/settings-modal.tsx` | Two `Toggle` rows. |
| `webview/components/code-viewer.tsx` | Minimap default; hook wiring; actions; live region; degraded hint; menu context. |
| `webview/editor-menu.ts` | `hasChanges?`, `'compare'` icon key, two rows. |
| `webview/shortcuts.ts` | `nextChange` / `prevChange` in the Editor group. |
| `webview/app.tsx` | Two palette entries. |
| `webview/styles.css` | Tokens per theme; `.cdec*` gutter marks; forced-colors. |
| `test/unit/theme-tokens.test.ts` | Contrast assertions for the three new tokens. |
| `test/unit/review-hunks-bounds.test.ts` | The `maxLcsCells` option. |
| `test/unit/coerce-settings.test.ts`, `test/unit/appearance-sections.test.ts`, `test/unit/editor-menu.test.ts` | Extend for the new fields/rows. |
| `CHANGELOG.md` | `[Unreleased]` → `### Added`. |

---

## Task 1: Pure path containment (`src/repo-rel.ts`)

**Files:**
- Create: `src/repo-rel.ts`
- Test: `test/unit/repo-rel.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function repoRelPath(root: string, absPath: string): string | null`
  - `export function isUnderRoot(root: string, absPath: string): boolean`

Both are **node-free** so the renderer can import them. `src/path-guard.ts` already has `isInsideRoot`, but it imports `node:fs` and branches on `process.platform` — unusable in the renderer and untestable on CI's ubuntu. This module decides case-sensitivity from the *shape of the root* (a `C:/`-style drive prefix) rather than from the host platform, so the same test runs identically on Windows and Linux.

- [ ] **Step 1: Write the failing test**

Create `test/unit/repo-rel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isUnderRoot, repoRelPath } from '../../src/repo-rel';

describe('repoRelPath', () => {
  it('returns a posix relative path for a posix root', () => {
    expect(repoRelPath('/home/u/repo', '/home/u/repo/src/a.ts')).toBe('src/a.ts');
  });

  it('normalises backslashes on a windows root', () => {
    expect(repoRelPath('C:\\work\\repo', 'C:\\work\\repo\\src\\a.ts')).toBe('src/a.ts');
  });

  it('ignores drive-letter case on a windows root', () => {
    expect(repoRelPath('c:/work/repo', 'C:/Work/Repo/src/a.ts')).toBe('src/a.ts');
  });

  it('is case-sensitive on a posix root', () => {
    expect(repoRelPath('/home/u/repo', '/home/u/Repo/src/a.ts')).toBeNull();
  });

  it('tolerates a trailing separator on the root', () => {
    expect(repoRelPath('/home/u/repo/', '/home/u/repo/a.ts')).toBe('a.ts');
  });

  it('rejects a sibling directory sharing the root prefix', () => {
    expect(repoRelPath('/work', '/work-evil/a.ts')).toBeNull();
  });

  it('rejects the root itself', () => {
    expect(repoRelPath('/home/u/repo', '/home/u/repo')).toBeNull();
  });

  it('rejects a path that climbs out with ..', () => {
    expect(repoRelPath('/home/u/repo', '/home/u/repo/../secret.ts')).toBeNull();
  });
});

describe('isUnderRoot', () => {
  it('is true for a contained file and false for a sibling', () => {
    expect(isUnderRoot('/home/u/repo', '/home/u/repo/src/a.ts')).toBe(true);
    expect(isUnderRoot('/home/u/repo', '/home/u/other/a.ts')).toBe(false);
  });

  it('matches a windows root regardless of separator style', () => {
    expect(isUnderRoot('C:\\work\\repo', 'C:/work/repo/src/a.ts')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/repo-rel.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/repo-rel"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/repo-rel.ts`:

```ts
/**
 * Repo-relative path resolution, node-free so BOTH the host and the renderer can use it.
 * `src/path-guard.ts`'s isInsideRoot is the write-guard's backbone but pulls node:fs and
 * branches on process.platform — the renderer can't import it, and a platform branch goes
 * red on CI's ubuntu (CLAUDE.md). Case-sensitivity is derived from the ROOT's shape instead:
 * a drive-letter prefix means a Windows filesystem, wherever the code happens to run.
 */

const toPosix = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

const isWindowsRoot = (root: string): boolean => /^[a-zA-Z]:\//.test(root);

/**
 * `absPath` expressed relative to `root`, with forward slashes — the form git wants for
 * `HEAD:<rel>`. Null when the path is the root itself, escapes it, or lives elsewhere.
 */
export function repoRelPath(root: string, absPath: string): string | null {
  const r = toPosix(root);
  const p = toPosix(absPath);
  if (!r || !p) return null;
  const fold = isWindowsRoot(r) ? (s: string) => s.toLowerCase() : (s: string) => s;
  if (fold(p) === fold(r)) return null;
  if (!fold(p).startsWith(`${fold(r)}/`)) return null;
  const rel = p.slice(r.length + 1);
  if (!rel || rel.split('/').includes('..')) return null;
  return rel;
}

/** True when `absPath` names a file nested under `root`. */
export function isUnderRoot(root: string, absPath: string): boolean {
  return repoRelPath(root, absPath) !== null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/repo-rel.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/repo-rel.ts test/unit/repo-rel.test.ts
git commit -m "feat(git): add node-free repo-relative path helpers"
```

---

## Task 2: Bounded async memo (`src/git-memo.ts`)

**Files:**
- Create: `src/git-memo.ts`
- Test: `test/unit/git-memo.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface AsyncMemo<T> { get(key: string, load: () => Promise<T>): Promise<T>; clear(): void }`
  - `export function createAsyncMemo<T>(opts: { ttlMs: number; max: number; now?: () => number }): AsyncMemo<T>`

This is what turns "one HEAD change with N open editors" into one `rev-parse HEAD` instead of N (§2 Lane A). The **promise** is cached, not the value, so N concurrent callers share one in-flight spawn — which is the case that actually matters, since every editor reacts to the same `fsChanged` in the same tick.

- [ ] **Step 1: Write the failing test**

Create `test/unit/git-memo.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createAsyncMemo } from '../../src/git-memo';

describe('createAsyncMemo', () => {
  it('loads once and serves the cached value inside the TTL', async () => {
    let clock = 0;
    const memo = createAsyncMemo<string>({ ttlMs: 100, max: 10, now: () => clock });
    const load = vi.fn(async () => 'root');
    expect(await memo.get('a', load)).toBe('root');
    clock = 99;
    expect(await memo.get('a', load)).toBe('root');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads after the TTL expires', async () => {
    let clock = 0;
    const memo = createAsyncMemo<string>({ ttlMs: 100, max: 10, now: () => clock });
    const load = vi.fn(async () => `v${clock}`);
    await memo.get('a', load);
    clock = 101;
    expect(await memo.get('a', load)).toBe('v101');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const memo = createAsyncMemo<string>({ ttlMs: 1000, max: 10 });
    let resolve: (v: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const all = Promise.all([memo.get('a', load), memo.get('a', load), memo.get('a', load)]);
    resolve('shared');
    expect(await all).toEqual(['shared', 'shared', 'shared']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keys entries independently', async () => {
    const memo = createAsyncMemo<string>({ ttlMs: 1000, max: 10 });
    expect(await memo.get('a', async () => 'A')).toBe('A');
    expect(await memo.get('b', async () => 'B')).toBe('B');
    expect(await memo.get('a', async () => 'NEW')).toBe('A');
  });

  it('evicts the oldest entry past the bound', async () => {
    const memo = createAsyncMemo<string>({ ttlMs: 1000, max: 2 });
    await memo.get('a', async () => 'A');
    await memo.get('b', async () => 'B');
    await memo.get('c', async () => 'C');
    const reload = vi.fn(async () => 'A2');
    expect(await memo.get('a', reload)).toBe('A2');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected load', async () => {
    const memo = createAsyncMemo<string>({ ttlMs: 1000, max: 10 });
    await expect(
      memo.get('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await memo.get('a', async () => 'recovered')).toBe('recovered');
  });

  it('clear drops everything', async () => {
    const memo = createAsyncMemo<string>({ ttlMs: 1000, max: 10 });
    await memo.get('a', async () => 'A');
    memo.clear();
    expect(await memo.get('a', async () => 'B')).toBe('B');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/git-memo.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/git-memo"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/git-memo.ts`:

```ts
/**
 * Bounded, TTL'd memo for cheap-but-repeated git interrogations (`rev-parse --show-toplevel`,
 * `rev-parse HEAD`). The PROMISE is cached rather than the value, so N callers arriving in the
 * same tick — which is exactly what one `fsChanged` with N open editors produces — share a
 * single spawn instead of racing N of them. See spec 2026-08-27-review-supercharge §2 Lane A.
 */

export interface AsyncMemo<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
}

interface Entry<T> {
  at: number;
  value: Promise<T>;
}

export function createAsyncMemo<T>({
  ttlMs,
  max,
  now = Date.now,
}: {
  ttlMs: number;
  max: number;
  now?: () => number;
}): AsyncMemo<T> {
  const entries = new Map<string, Entry<T>>();

  return {
    get(key, load) {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;

      const value = load();
      const entry: Entry<T> = { at: now(), value };
      entries.set(key, entry);
      // A failure must not be remembered — the next caller retries rather than inheriting it.
      value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/git-memo.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/git-memo.ts test/unit/git-memo.test.ts
git commit -m "feat(git): add a bounded async memo with in-flight dedupe"
```

---

## Task 3: Host HEAD-blob classifier (`src/head-blob.ts`) + protocol pair

**Files:**
- Create: `src/head-blob.ts`
- Modify: `src/protocol.ts` (add `HeadBlobReason` after the `BlameLine` interface, which ends at `:172`; add the reply after the `git:blameResult` member, `:318-324`; add the request after the `git:blame` member, `:562`)
- Modify: `src/file-service.ts:15` (export `MAX_BYTES`) and `:258` (export `toLf`)
- Test: `test/unit/head-blob.test.ts`

**Interfaces:**
- Consumes: `repoRelPath` (Task 1); `MAX_BYTES`, `toLf` from `src/file-service.ts`.
- Produces:
  - `export type HeadBlobReason = 'untracked' | 'binary' | 'oversize' | 'notRepo' | 'error'` (in `src/protocol.ts`)
  - `export interface HeadBlobShow { ok: boolean; bytes: Buffer; code: number | null; failed: boolean }`
  - `export interface HeadBlobDeps { repoRoot(dir: string): Promise<string>; headSha(root: string): Promise<string | null>; showBlob(root: string, rel: string): Promise<HeadBlobShow> }`
  - `export interface HeadBlobResult { headSha: string | null; text: string | null; reason?: HeadBlobReason }`
  - `export async function readHeadBlob(absPath: string, deps: HeadBlobDeps): Promise<HeadBlobResult>`
  - Protocol messages: `{ type: 'git:headBlob'; path: string; requestId: number }` and `{ type: 'git:headBlobResult'; requestId: number; path: string; headSha: string | null; text: string | null; reason?: HeadBlobReason }`

`readHeadBlob` spawns nothing. It owns the *decisions* — containment, unborn HEAD, untracked-vs-error, cap, binary, LF — and takes the three git primitives from the caller, which is what keeps `electron/main.ts` the single owner of the `git show HEAD:<rel>` path (§3 "readDiff plumbing").

- [ ] **Step 1: Write the failing test**

Create `test/unit/head-blob.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { MAX_BYTES } from '../../src/file-service';
import { type HeadBlobDeps, type HeadBlobShow, readHeadBlob } from '../../src/head-blob';

const REPO = '/home/u/repo';
const FILE = '/home/u/repo/src/a.ts';
const SHA = 'a'.repeat(40);

const shown = (bytes: Buffer | string): HeadBlobShow => ({
  ok: true,
  bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'),
  code: 0,
  failed: false,
});

const missing: HeadBlobShow = { ok: false, bytes: Buffer.alloc(0), code: 128, failed: false };
const crashed: HeadBlobShow = { ok: false, bytes: Buffer.alloc(0), code: null, failed: true };
const broke: HeadBlobShow = { ok: false, bytes: Buffer.alloc(0), code: 1, failed: false };

const deps = (over: Partial<HeadBlobDeps> = {}): HeadBlobDeps => ({
  repoRoot: async () => REPO,
  headSha: async () => SHA,
  showBlob: async () => shown('one\r\ntwo\r\n'),
  ...over,
});

describe('readHeadBlob', () => {
  it('returns the LF-normalised blob text and the head sha', async () => {
    expect(await readHeadBlob(FILE, deps())).toEqual({ headSha: SHA, text: 'one\ntwo\n' });
  });

  it('reports notRepo when no toplevel resolves', async () => {
    const d = deps({ repoRoot: async () => '' });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: null, text: null, reason: 'notRepo' });
  });

  it('reports notRepo when the path escapes the resolved root', async () => {
    const d = deps({ repoRoot: async () => '/home/u/other' });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: null, text: null, reason: 'notRepo' });
  });

  it('reports untracked on an unborn HEAD without asking for a blob', async () => {
    const showBlob = vi.fn(async () => shown('x'));
    const d = deps({ headSha: async () => null, showBlob });
    expect(await readHeadBlob(FILE, d)).toEqual({
      headSha: null,
      text: null,
      reason: 'untracked',
    });
    expect(showBlob).not.toHaveBeenCalled();
  });

  it('reads untracked off git exit 128, not a second ls-files spawn', async () => {
    const d = deps({ showBlob: async () => missing });
    expect(await readHeadBlob(FILE, d)).toEqual({
      headSha: SHA,
      text: null,
      reason: 'untracked',
    });
  });

  it('reports error when git could not run or was killed', async () => {
    const d = deps({ showBlob: async () => crashed });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: SHA, text: null, reason: 'error' });
  });

  it('reports error for a non-128 failure exit', async () => {
    const d = deps({ showBlob: async () => broke });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: SHA, text: null, reason: 'error' });
  });

  it('reports binary when the blob contains a NUL byte', async () => {
    const d = deps({ showBlob: async () => shown(Buffer.from([0x61, 0x00, 0x62])) });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: SHA, text: null, reason: 'binary' });
  });

  it('reports oversize past readDiff\u2019s cap without shipping the bytes', async () => {
    const d = deps({ showBlob: async () => shown(Buffer.alloc(MAX_BYTES + 1, 0x61)) });
    expect(await readHeadBlob(FILE, d)).toEqual({ headSha: SHA, text: null, reason: 'oversize' });
  });

  it('passes git a posix rel path even from a windows absolute path', async () => {
    const showBlob = vi.fn(async () => shown('ok\n'));
    const d = deps({ repoRoot: async () => 'C:/work/repo', showBlob });
    const res = await readHeadBlob('C:\\work\\repo\\src\\a.ts', d);
    expect(res).toEqual({ headSha: SHA, text: 'ok\n' });
    expect(showBlob).toHaveBeenCalledWith('C:/work/repo', 'src/a.ts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/head-blob.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/head-blob"`.

- [ ] **Step 3: Export the two `readDiff` primitives**

In `src/file-service.ts`, change line `:15`:

```ts
const MAX_BYTES = 2 * 1024 * 1024;
```

to:

```ts
/** Text-file ceiling shared by readDiff and the editor's HEAD-blob read — the two must agree,
 *  or the editor would mark a file Review refuses to diff. */
export const MAX_BYTES = 2 * 1024 * 1024;
```

and line `:258`:

```ts
const toLf = (s: string): string => s.replace(/\r\n/g, '\n');
```

to:

```ts
/** CRLF→LF for DISPLAY only, never a write path. Shared with src/head-blob.ts. */
export const toLf = (s: string): string => s.replace(/\r\n/g, '\n');
```

- [ ] **Step 4: Add the protocol pair**

In `src/protocol.ts`, immediately after the `BlameLine` interface (ends `:172`), add:

```ts
/**
 * Why `git:headBlobResult` carries no text. `untracked` (incl. an unborn HEAD) is the only
 * non-error one — the renderer renders the whole file as added for it. Every other value
 * means "no markers, no UI error, one host log line" (spec 2026-08-27-review-supercharge §2).
 */
export type HeadBlobReason = 'untracked' | 'binary' | 'oversize' | 'notRepo' | 'error';
```

In the `HostToWebview` union, immediately after the `git:blameResult` member (ends `:324`):

```ts
  // A file's HEAD blob, for the editor's change decorations. `headSha` pins the cache key
  // (path + sha) so split panes and re-mounts don't refetch; `requestId` is latest-wins.
  | {
      type: 'git:headBlobResult';
      requestId: number;
      path: string;
      headSha: string | null;
      text: string | null;
      reason?: HeadBlobReason;
    }
```

In the `WebviewToHost` union, immediately after the `git:blame` member (`:562`):

```ts
  // The HEAD version of one open file (absolute `path`). The host resolves the repo from the
  // FILE's own directory (like git:blame), asserts containment, caps at 2 MB and LF-normalises.
  | { type: 'git:headBlob'; path: string; requestId: number }
```

- [ ] **Step 5: Write minimal implementation**

Create `src/head-blob.ts`:

```ts
import * as path from 'node:path';
import { MAX_BYTES, toLf } from './file-service';
import type { HeadBlobReason } from './protocol';
import { repoRelPath } from './repo-rel';

/** One `git show HEAD:<rel>` outcome, narrowed to what the classification below needs. */
export interface HeadBlobShow {
  ok: boolean;
  /** Raw stdout bytes; empty unless ok. */
  bytes: Buffer;
  /** Process exit code; null when killed. */
  code: number | null;
  /** git could not be run, timed out, was aborted, or overflowed maxBuffer — a real failure
   *  rather than "HEAD has no such blob". */
  failed: boolean;
}

/**
 * Git primitives, injected. This module spawns nothing: `electron/main.ts` stays the single
 * owner of the `git show HEAD:<rel>` path that readDiff already uses (spec §3), and the
 * rev-parse lookups it supplies are memoised there.
 */
export interface HeadBlobDeps {
  /** Repo top level for a directory; '' when the directory is not in a repo. */
  repoRoot(dir: string): Promise<string>;
  /** Current HEAD sha for a repo root; null on an unborn HEAD. */
  headSha(root: string): Promise<string | null>;
  showBlob(root: string, rel: string): Promise<HeadBlobShow>;
}

export interface HeadBlobResult {
  headSha: string | null;
  text: string | null;
  reason?: HeadBlobReason;
}

/** git's exit code when a path resolves but HEAD holds no blob for it. */
const NO_SUCH_BLOB = 128;

export async function readHeadBlob(
  absPath: string,
  deps: HeadBlobDeps,
): Promise<HeadBlobResult> {
  const root = await deps.repoRoot(path.dirname(absPath));
  if (!root) return { headSha: null, text: null, reason: 'notRepo' };

  const rel = repoRelPath(root, absPath);
  if (rel === null) return { headSha: null, text: null, reason: 'notRepo' };

  const headSha = await deps.headSha(root);
  // An unborn HEAD has no blob for anything, so every file in the repo is new.
  if (headSha === null) return { headSha: null, text: null, reason: 'untracked' };

  const show = await deps.showBlob(root, rel);
  if (show.failed) return { headSha, text: null, reason: 'error' };
  if (!show.ok) {
    // Exit 128 IS the tracked check — spawning `ls-files --error-unmatch` for it would double
    // the per-file cost the memo above exists to avoid.
    return { headSha, text: null, reason: show.code === NO_SUCH_BLOB ? 'untracked' : 'error' };
  }
  if (show.bytes.length > MAX_BYTES) return { headSha, text: null, reason: 'oversize' };
  if (show.bytes.includes(0)) return { headSha, text: null, reason: 'binary' };
  return { headSha, text: toLf(show.bytes.toString('utf8')) };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/unit/head-blob.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: both projects exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/head-blob.ts src/protocol.ts src/file-service.ts test/unit/head-blob.test.ts
git commit -m "feat(git): add git:headBlob protocol pair and HEAD-blob classifier"
```

---

## Task 4: Wire the handler on the host (one `git show`, memoised rev-parse)

**Files:**
- Modify: `electron/main.ts` — the `gitShow` / `gitShowBuffer` helpers (`:688-716`); new `case 'git:headBlob'` immediately after the `git:blame` case (which ends `:1947`)
- Modify: `webview/bridge.ts` — new preview branch immediately after the `git:blame` branch (`:829-836`)

**Interfaces:**
- Consumes: `readHeadBlob`, `HeadBlobShow` (Task 3); `createAsyncMemo` (Task 2); `repoRelPath` (Task 1); existing `runGit` (`src/git-exec.ts`), `GIT_TIMEOUT`, `replyHere`, `log`.
- Produces: a `git:headBlobResult` reply for every `git:headBlob` request, in both the real host and the browser preview. `gitShow` and `gitShowBuffer` keep their existing signatures — `readDiff`'s callers are untouched.

- [ ] **Step 1: Add the imports**

In `electron/main.ts`, beside the existing `src/` imports (the `git-info` import sits at `:49`):

```ts
import { createAsyncMemo } from '../src/git-memo';
import { type HeadBlobShow, readHeadBlob } from '../src/head-blob';
import { repoRelPath } from '../src/repo-rel';
```

- [ ] **Step 2: Replace `gitShow` / `gitShowBuffer` with one memoised path**

In `electron/main.ts`, replace the whole block from `async function gitShow(absPath: string)` (`:688`) through the end of `gitShowBuffer` (`:716`) with:

```ts
/** Room for a 2 MB blob plus git's framing; the text cap itself is readDiff's MAX_BYTES. */
const HEAD_BLOB_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * A directory's repo top level, and a root's HEAD sha. Memoised because one `fsChanged` wakes
 * EVERY open editor at once: without this, N editors meant N `rev-parse --show-toplevel` plus
 * N `rev-parse HEAD` before the first blob was read. See spec 2026-08-27-review-supercharge
 * §2 Lane A ("N shows, not 2N spawns"). The toplevel of a directory is effectively immutable
 * for a session; HEAD is not, hence the much shorter TTL — long enough to collapse one burst.
 */
const repoRootMemo = createAsyncMemo<string>({ ttlMs: 30_000, max: 200 });
const headShaMemo = createAsyncMemo<string | null>({ ttlMs: 1_000, max: 50 });

function repoTopLevel(dir: string): Promise<string> {
  return repoRootMemo.get(dir, async () => {
    const r = await runGit(['rev-parse', '--show-toplevel'], {
      cwd: dir,
      timeoutMs: GIT_TIMEOUT.metadata,
    });
    return r.ok ? r.stdout.trim() : '';
  });
}

function headShaFor(root: string): Promise<string | null> {
  return headShaMemo.get(root, async () => {
    const r = await runGit(['rev-parse', 'HEAD'], { cwd: root, timeoutMs: GIT_TIMEOUT.metadata });
    return r.ok ? r.stdout.trim() || null : null;
  });
}

/**
 * THE `git show HEAD:<rel>` path for this process — readDiff's text and image sides and the
 * editor's change decorations all come through here, so there is one cap, one timeout and one
 * set of outcome flags rather than a second implementation per caller.
 */
async function gitShowHead(root: string, rel: string): Promise<HeadBlobShow> {
  const res = await runGit(['show', `HEAD:${rel}`], {
    cwd: root,
    timeoutMs: GIT_TIMEOUT.diff,
    maxBuffer: HEAD_BLOB_MAX_BUFFER,
  });
  return {
    ok: res.ok,
    bytes: res.stdoutBuffer,
    code: res.code,
    failed: res.notFound || res.timedOut || res.aborted || res.truncated,
  };
}

async function gitShow(absPath: string): Promise<string> {
  const root = await repoTopLevel(path.dirname(absPath));
  const rel = root ? repoRelPath(root, absPath) : null;
  if (!rel) return '';
  const res = await gitShowHead(root, rel);
  return res.ok ? res.bytes.toString('utf8') : '';
}

/**
 * Binary-safe HEAD blob read. Resolves `null` when the path has no HEAD blob (new/untracked
 * file) or the read fails — the caller treats that as "added".
 */
async function gitShowBuffer(absPath: string): Promise<Buffer | null> {
  const root = await repoTopLevel(path.dirname(absPath));
  const rel = root ? repoRelPath(root, absPath) : null;
  if (!rel) return null;
  const res = await gitShowHead(root, rel);
  return res.ok ? res.bytes : null;
}
```

- [ ] **Step 3: Add the handler**

In `electron/main.ts`, directly after the `break;` closing `case 'git:blame':` (`:1947`), insert:

```ts
        case 'git:headBlob': {
          const res = await readHeadBlob(m.path, {
            repoRoot: repoTopLevel,
            headSha: headShaFor,
            showBlob: gitShowHead,
          });
          // An untracked file is a normal outcome (whole-file added), not a failure.
          if (res.reason && res.reason !== 'untracked')
            log.debug('git', 'headBlob', { path: m.path, reason: res.reason });
          replyHere({
            type: 'git:headBlobResult',
            requestId: m.requestId,
            path: m.path,
            headSha: res.headSha,
            text: res.text,
            ...(res.reason ? { reason: res.reason } : {}),
          });
          break;
        }
```

- [ ] **Step 4: Add the preview fallback**

In `webview/bridge.ts`, directly after the `if (msg.type === 'git:blame') { … return; }` block (ends `:836`), insert:

```ts
  if (msg.type === 'git:headBlob') {
    // Preview (no host git): answer with notRepo so the editor settles on `none` — no markers,
    // no error — instead of sitting in `loading` forever.
    setTimeout(
      () =>
        emit({
          type: 'git:headBlobResult',
          requestId: msg.requestId,
          path: msg.path,
          headSha: null,
          text: null,
          reason: 'notRepo',
        }),
      15,
    );
    return;
  }
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0. (A missing branch in either message union fails here — that is the check.)

- [ ] **Step 6: Regression-check the diff path**

Run: `npx vitest run test/unit/file-service-diff.test.ts`
Expected: PASS. `readDiff` still calls `gitShow` / `gitShowBuffer` with the same signatures.

- [ ] **Step 7: Commit**

```bash
git add electron/main.ts webview/bridge.ts
git commit -m "feat(git): serve git:headBlob through readDiff's show path with memoised rev-parse"
```

---

## Task 5: A caller-supplied LCS budget on `computeFileReview`

**Files:**
- Modify: `src/review-hunks.ts` — `diffLines` (`:94`, `:115`), `computeFileReview` (`:170-173`)
- Test: `test/unit/review-hunks-bounds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function computeFileReview(head: string, work: string, context?: number, maxLcsCells?: number): FileReview` — `maxLcsCells` defaults to `MAX_LCS_CELLS`, so every existing caller is unchanged.

The Review view diffs once per file per load and can afford the 4 000 000-cell table. The editor re-diffs on a keystroke debounce and must stay inside a frame, so it needs a far smaller ceiling — hence a budget the caller owns rather than a constant baked into the module (§2 Lane A).

- [ ] **Step 1: Write the failing test**

Append to `test/unit/review-hunks-bounds.test.ts`, inside the existing `describe('bounded diffLines')`:

```ts
  it('accepts a caller budget lower than MAX_LCS_CELLS and degrades at it', () => {
    // 601 x 601 = 361 201 cells: over a 250 000 budget, well under MAX_LCS_CELLS.
    const head = lines(600, 'a');
    const work = lines(600, 'b');
    expect(computeFileReview(head, work).approx).toBeUndefined();
    expect(computeFileReview(head, work, 3, 250_000).approx).toBe(true);
  });

  it('an exact diff under the caller budget is unaffected by it', () => {
    const head = lines(600, 'a');
    const work = head.replace('a-300', 'EDITED');
    const r = computeFileReview(head, work, 3, 250_000);
    expect(r.approx).toBeUndefined();
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
  });

  it('defaults to MAX_LCS_CELLS when no budget is given', () => {
    const n = 1500; // 1501^2 = 2 253 001 cells — under MAX_LCS_CELLS, over any editor budget.
    expect(MAX_LCS_CELLS).toBeGreaterThan((n + 1) * (n + 1));
    expect(computeFileReview(lines(n, 'a'), lines(n, 'b')).approx).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/review-hunks-bounds.test.ts`
Expected: FAIL — `expected undefined to be true` on the first new case (the 4th argument is ignored today).

- [ ] **Step 3: Thread the budget through**

In `src/review-hunks.ts`, change the `diffLines` signature (`:94`):

```ts
function diffLines(a: string[], b: string[]): { ops: Op[]; approx: boolean } {
```

to:

```ts
function diffLines(
  a: string[],
  b: string[],
  maxLcsCells: number,
): { ops: Op[]; approx: boolean } {
```

and its budget check (`:115`):

```ts
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
```

to:

```ts
  if ((n + 1) * (m + 1) > maxLcsCells) {
```

Update the `MAX_LCS_CELLS` doc comment (`:86-89`) to:

```ts
/** Default dense-LCS cell budget (~32 MB of number cells). Past it `diffLines` degrades to a
 *  whole-core replacement rather than allocating a multi-GB table — see
 *  docs/specs/2026-08-20-commit-review-memory-bounds.md §1. Callers that re-diff far more
 *  often than Review does pass a smaller one (spec 2026-08-27-review-supercharge §2 Lane A). */
export const MAX_LCS_CELLS = 4_000_000;
```

Change `computeFileReview` (`:170-173`):

```ts
export function computeFileReview(head: string, work: string, context = 3): FileReview {
  const a = splitLines(head);
  const b = splitLines(work);
  const { ops, approx } = diffLines(a, b);
```

to:

```ts
export function computeFileReview(
  head: string,
  work: string,
  context = 3,
  maxLcsCells = MAX_LCS_CELLS,
): FileReview {
  const a = splitLines(head);
  const b = splitLines(work);
  const { ops, approx } = diffLines(a, b, maxLcsCells);
```

and extend its JSDoc (`:163-169`) with a final line:

```
 * `maxLcsCells` caps the dense table; past it the changed core is emitted degenerately
 * (`approx`), which the editor renders as its `degraded` state.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/review-hunks-bounds.test.ts test/unit/review-hunks.test.ts`
Expected: PASS — including the 3 new cases.

- [ ] **Step 5: Commit**

```bash
git add src/review-hunks.ts test/unit/review-hunks-bounds.test.ts
git commit -m "feat(review): let computeFileReview take a caller-supplied LCS cell budget"
```

---

## Task 6: Pure change decorations (`webview/change-decorations.ts`)

**Files:**
- Create: `webview/change-decorations.ts`
- Test: `test/unit/change-decorations.test.ts`

**Interfaces:**
- Consumes: `computeFileReview`, `ReviewHunk`, `ReviewLine` from `src/review-hunks.ts`; `nextChange`, `prevChange` from `webview/diff-nav.ts`.
- Produces:
  - `export const MAX_DECORATION_LCS_CELLS = 250_000`
  - `export type ChangeKind = 'added' | 'modified' | 'deleted'`
  - `export interface ChangeMarker { kind: ChangeKind; startLine: number; endLine: number; addedLines: number; removedLines: number }`
  - `export interface ChangeDecorationStyle { colors: Record<ChangeKind, string>; rulerLane: number; minimapPosition: number }`
  - `export function hunksToMarkers(hunks: ReviewHunk[], modelLineCount: number): ChangeMarker[]`
  - `export function hunksToDecorations(markers: ChangeMarker[], style: ChangeDecorationStyle): editor.IModelDeltaDecoration[]`
  - `export function markerTooltip(m: ChangeMarker): string`
  - `export function markerLines(markers: ChangeMarker[]): number[]`
  - `export function navigateMarkers(markers: ChangeMarker[], currentLine: number, direction: 'next' | 'prev'): { line: number; index: number; total: number } | null`

Monaco is imported **type-only**; the two enum values Monaco needs (`OverviewRulerLane.Left`, `MinimapPosition.Gutter`) are injected through `ChangeDecorationStyle`, so this module runs under vitest in node. The marker carries no removed *text* — that is the peek's need, and the peek is Lane E.

- [ ] **Step 1: Write the failing test**

Create `test/unit/change-decorations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeFileReview } from '../../src/review-hunks';
import {
  type ChangeMarker,
  hunksToDecorations,
  hunksToMarkers,
  markerLines,
  markerTooltip,
  MAX_DECORATION_LCS_CELLS,
  navigateMarkers,
} from '../../webview/change-decorations';

const STYLE = {
  colors: { added: '#0f0', modified: '#fa0', deleted: '#f00' },
  rulerLane: 1,
  minimapPosition: 2,
};

const lines = (n: number, prefix = 'l') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n');

describe('hunksToMarkers', () => {
  it('marks a pure insertion as added over the inserted lines', () => {
    const head = lines(10);
    const work = `${lines(5)}\nnew1\nnew2\nl6\nl7\nl8\nl9\nl10`;
    const markers = hunksToMarkers(computeFileReview(head, work).hunks, 12);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      kind: 'added',
      startLine: 6,
      endLine: 7,
      addedLines: 2,
      removedLines: 0,
    });
  });

  it('marks a replacement as modified', () => {
    const head = lines(10);
    const work = lines(10).replace('l5', 'CHANGED');
    const markers = hunksToMarkers(computeFileReview(head, work).hunks, 10);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      kind: 'modified',
      startLine: 5,
      endLine: 5,
      addedLines: 1,
      removedLines: 1,
    });
  });

  it('anchors a deletion on the line that follows it', () => {
    const head = lines(10);
    const work = ['l1', 'l2', 'l3', 'l6', 'l7', 'l8', 'l9', 'l10'].join('\n');
    const markers = hunksToMarkers(computeFileReview(head, work).hunks, 8);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual({
      kind: 'deleted',
      startLine: 4,
      endLine: 4,
      addedLines: 0,
      removedLines: 2,
    });
  });

  it('anchors a deletion at EOF on the last model line', () => {
    const markers = hunksToMarkers(computeFileReview(lines(10), lines(8)).hunks, 8);
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('deleted');
    expect(markers[0].startLine).toBe(8);
  });

  it('splits two change runs inside one hunk into two markers', () => {
    // A 4-line unchanged gap is <= 2*context, so computeFileReview keeps both runs in ONE hunk.
    const head = lines(12);
    const work = lines(12).replace('l4', 'A').replace('l9', 'B');
    const markers = hunksToMarkers(computeFileReview(head, work).hunks, 12);
    expect(markers.map((m) => m.startLine)).toEqual([4, 9]);
    expect(markers.every((m) => m.kind === 'modified')).toBe(true);
  });

  it('clamps a marker to the model line count', () => {
    const markers = hunksToMarkers(computeFileReview(lines(10), `${lines(10)}\nextra`).hunks, 3);
    expect(markers[0].startLine).toBeGreaterThanOrEqual(1);
    expect(markers[0].endLine).toBeLessThanOrEqual(3);
  });

  it('returns nothing for an unchanged file', () => {
    expect(hunksToMarkers(computeFileReview(lines(5), lines(5)).hunks, 5)).toEqual([]);
  });
});

describe('markerTooltip', () => {
  const m = (over: Partial<ChangeMarker>): ChangeMarker => ({
    kind: 'added',
    startLine: 1,
    endLine: 1,
    addedLines: 1,
    removedLines: 0,
    ...over,
  });

  it('names the kind and the line count, singular and plural', () => {
    expect(markerTooltip(m({ kind: 'added', addedLines: 3 }))).toBe('Added 3 lines');
    expect(markerTooltip(m({ kind: 'added', addedLines: 1 }))).toBe('Added 1 line');
    expect(markerTooltip(m({ kind: 'modified', addedLines: 2, removedLines: 2 }))).toBe(
      'Modified 2 lines',
    );
    expect(markerTooltip(m({ kind: 'deleted', addedLines: 0, removedLines: 2 }))).toBe(
      'Deleted 2 lines',
    );
  });
});

describe('hunksToDecorations', () => {
  const markers: ChangeMarker[] = [
    { kind: 'added', startLine: 3, endLine: 4, addedLines: 2, removedLines: 0 },
    { kind: 'deleted', startLine: 9, endLine: 9, addedLines: 0, removedLines: 1 },
  ];

  it('emits one range decoration per marker with a kind class', () => {
    const decos = hunksToDecorations(markers, STYLE);
    expect(decos).toHaveLength(2);
    expect(decos[0].range).toEqual({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
    });
    expect(decos[0].options.linesDecorationsClassName).toBe('cdec cdec--added');
    expect(decos[1].options.linesDecorationsClassName).toBe('cdec cdec--deleted');
  });

  it('carries the injected ruler and minimap colours', () => {
    const decos = hunksToDecorations(markers, STYLE);
    expect(decos[0].options.overviewRuler).toEqual({ color: '#0f0', position: 1 });
    expect(decos[0].options.minimap).toEqual({ color: '#0f0', position: 2 });
    expect(decos[1].options.overviewRuler).toEqual({ color: '#f00', position: 1 });
  });

  it('carries the tooltip as a hover message', () => {
    expect(hunksToDecorations(markers, STYLE)[0].options.hoverMessage).toEqual({
      value: 'Added 2 lines',
    });
  });
});

describe('markerLines / navigateMarkers', () => {
  const markers: ChangeMarker[] = [
    { kind: 'added', startLine: 10, endLine: 12, addedLines: 3, removedLines: 0 },
    { kind: 'deleted', startLine: 10, endLine: 10, addedLines: 0, removedLines: 1 },
    { kind: 'modified', startLine: 30, endLine: 30, addedLines: 1, removedLines: 1 },
  ];

  it('dedupes and sorts anchor lines', () => {
    expect(markerLines(markers)).toEqual([10, 30]);
  });

  it('advances and wraps forward', () => {
    expect(navigateMarkers(markers, 1, 'next')).toEqual({ line: 10, index: 1, total: 2 });
    expect(navigateMarkers(markers, 10, 'next')).toEqual({ line: 30, index: 2, total: 2 });
    expect(navigateMarkers(markers, 30, 'next')).toEqual({ line: 10, index: 1, total: 2 });
  });

  it('retreats and wraps backward', () => {
    expect(navigateMarkers(markers, 30, 'prev')).toEqual({ line: 10, index: 1, total: 2 });
    expect(navigateMarkers(markers, 10, 'prev')).toEqual({ line: 30, index: 2, total: 2 });
  });

  it('a single change wraps to itself', () => {
    const one = markers.slice(2);
    expect(navigateMarkers(one, 30, 'next')).toEqual({ line: 30, index: 1, total: 1 });
  });

  it('returns null when there is nothing to navigate', () => {
    expect(navigateMarkers([], 5, 'next')).toBeNull();
  });
});

describe('decoration budget', () => {
  it('is far below the Review budget, because the editor re-diffs on every keystroke burst', () => {
    expect(MAX_DECORATION_LCS_CELLS).toBe(250_000);
  });

  it('degrades a wholesale rewrite that the Review budget would still diff exactly', () => {
    const head = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n');
    const work = Array.from({ length: 600 }, (_, i) => `b${i}`).join('\n');
    expect(computeFileReview(head, work).approx).toBeUndefined();
    expect(computeFileReview(head, work, 3, MAX_DECORATION_LCS_CELLS).approx).toBe(true);
  });

  // Acceptance criterion, spec §7 Lane A: this runs on a 300 ms keystroke debounce, so it has
  // to fit inside a frame. Median of five, so one scheduling hiccup on CI can't fail the build.
  it('recomputes a 2 000-line file with a 50-line change in under 16 ms', () => {
    const head = Array.from({ length: 2000 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const workLines = head.split('\n');
    for (let i = 900; i < 950; i++) workLines[i] = `const changed${i} = ${i * 2};`;
    const work = workLines.join('\n');

    const run = () =>
      hunksToMarkers(computeFileReview(head, work, 3, MAX_DECORATION_LCS_CELLS).hunks, 2000);

    expect(run().length).toBeGreaterThan(0);

    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      run();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    expect(samples[2]).toBeLessThan(16);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/change-decorations.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/change-decorations"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview/change-decorations.ts`:

```ts
import type { editor } from 'monaco-editor';
import type { ReviewHunk, ReviewLine } from '../src/review-hunks';
import { nextChange, prevChange } from './diff-nav';

/**
 * The editor's own LCS ceiling (~500x500 changed region). Review diffs a file once per load
 * and can afford MAX_LCS_CELLS; this runs on a 300 ms keystroke debounce and must fit inside a
 * frame. See spec 2026-08-27-review-supercharge §2 Lane A.
 */
export const MAX_DECORATION_LCS_CELLS = 250_000;

export type ChangeKind = 'added' | 'modified' | 'deleted';

/**
 * One contiguous run of changed lines, in MODEL (new-side) coordinates.
 *
 * Per RUN, not per hunk: computeFileReview keeps unchanged gaps of up to 2*context inside a
 * single hunk, so a per-hunk bar would paint lines the agent never touched.
 */
export interface ChangeMarker {
  kind: ChangeKind;
  /** 1-based model line the marker starts on. For `deleted`, the line AFTER the removal. */
  startLine: number;
  /** 1-based model line the marker ends on (=== startLine for `deleted`). */
  endLine: number;
  addedLines: number;
  removedLines: number;
}

/** Monaco's enum values, injected so this module needs no runtime monaco import. */
export interface ChangeDecorationStyle {
  colors: Record<ChangeKind, string>;
  /** monaco.editor.OverviewRulerLane */
  rulerLane: number;
  /** monaco.editor.MinimapPosition */
  minimapPosition: number;
}

const clamp = (n: number, max: number): number => Math.min(Math.max(n, 1), Math.max(max, 1));

/** First model line at or after `from` within a hunk, or null when the hunk has none. */
function nextNewLine(lines: ReviewLine[], from: number): number | null {
  for (let i = from; i < lines.length; i++) {
    const n = lines[i].newLine;
    if (n !== null) return n;
  }
  return null;
}

export function hunksToMarkers(hunks: ReviewHunk[], modelLineCount: number): ChangeMarker[] {
  const markers: ChangeMarker[] = [];
  for (const hunk of hunks) {
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === 'context') {
        i++;
        continue;
      }
      const start = i;
      while (i < lines.length && lines[i].kind !== 'context') i++;
      const run = lines.slice(start, i);
      const adds = run.filter((l) => l.kind === 'add');
      const dels = run.length - adds.length;

      if (adds.length > 0) {
        const first = adds[0].newLine ?? 1;
        const last = adds[adds.length - 1].newLine ?? first;
        markers.push({
          kind: dels > 0 ? 'modified' : 'added',
          startLine: clamp(first, modelLineCount),
          endLine: clamp(last, modelLineCount),
          addedLines: adds.length,
          removedLines: dels,
        });
        continue;
      }

      // Pure deletion: nothing on the new side, so anchor on the line that follows it —
      // the last model line when the removal ran to EOF.
      const anchor = clamp(nextNewLine(lines, i) ?? modelLineCount, modelLineCount);
      markers.push({
        kind: 'deleted',
        startLine: anchor,
        endLine: anchor,
        addedLines: 0,
        removedLines: dels,
      });
    }
  }
  return markers;
}

const plural = (n: number): string => (n === 1 ? 'line' : 'lines');

export function markerTooltip(m: ChangeMarker): string {
  if (m.kind === 'deleted') return `Deleted ${m.removedLines} ${plural(m.removedLines)}`;
  if (m.kind === 'modified') return `Modified ${m.addedLines} ${plural(m.addedLines)}`;
  return `Added ${m.addedLines} ${plural(m.addedLines)}`;
}

export function hunksToDecorations(
  markers: ChangeMarker[],
  style: ChangeDecorationStyle,
): editor.IModelDeltaDecoration[] {
  return markers.map((m) => ({
    range: {
      startLineNumber: m.startLine,
      startColumn: 1,
      endLineNumber: m.endLine,
      endColumn: 1,
    },
    options: {
      linesDecorationsClassName: `cdec cdec--${m.kind}`,
      hoverMessage: { value: markerTooltip(m) },
      overviewRuler: { color: style.colors[m.kind], position: style.rulerLane },
      minimap: { color: style.colors[m.kind], position: style.minimapPosition },
    },
  }));
}

/** Ascending, deduped anchor lines — a deletion can land on an addition's first line. */
export function markerLines(markers: ChangeMarker[]): number[] {
  return [...new Set(markers.map((m) => m.startLine))].sort((a, b) => a - b);
}

export function navigateMarkers(
  markers: ChangeMarker[],
  currentLine: number,
  direction: 'next' | 'prev',
): { line: number; index: number; total: number } | null {
  const lines = markerLines(markers);
  if (lines.length === 0) return null;
  const line =
    direction === 'next' ? nextChange(lines, currentLine) : prevChange(lines, currentLine);
  return { line, index: lines.indexOf(line) + 1, total: lines.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/change-decorations.test.ts`
Expected: PASS — 21 tests, including the < 16 ms benchmark.

- [ ] **Step 5: Commit**

```bash
git add webview/change-decorations.ts test/unit/change-decorations.test.ts
git commit -m "feat(editor): add pure hunk-to-decoration mapping with its own LCS budget"
```

---

## Task 7: Design tokens and marker styling

**Files:**
- Modify: `webview/styles.css` — `:root` (after `--diff-hunk-band`, `:183`), `:root[data-theme="aero"]` (after `--syn-default`, `:269`), `:root[data-theme="neon"]` (after `--diff-marker`, `:361`); a new rule block appended after the `.rline--del` rule (`:9405`)
- Modify: `test/unit/theme-tokens.test.ts` — a new `describe` after the `theme registry` block

**Interfaces:**
- Consumes: nothing.
- Produces: `--change-added`, `--change-modified`, `--change-deleted` in all three themes; CSS classes `.cdec`, `.cdec--added`, `.cdec--modified`, `.cdec--deleted`.

- [ ] **Step 1: Write the failing test**

Insert into `test/unit/theme-tokens.test.ts`, after the `describe('theme registry', …)` block and before `describe('coupleThemeDefaults', …)`:

```ts
/**
 * Lane A's gutter marks. §11 sets the bar at 3:1 against the gutter, which paints on
 * --code-base; §10 says colour never carries the signal alone, so the shapes are asserted too.
 */
describe('change-marker tokens', () => {
  const CHANGE_TOKENS = ['--change-added', '--change-modified', '--change-deleted'];

  for (const { id } of THEMES) {
    const tokens = theme(id);
    const surface = resolve(tokens, '--code-base');
    for (const token of CHANGE_TOKENS) {
      it(`${id}: ${token} clears 3:1 on ${surface}`, () => {
        expect(contrast(resolve(tokens, token), surface)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('distinguishes the three kinds by shape, not colour alone', () => {
    expect(CSS).toMatch(/\.cdec--modified\s*\{[^}]*border-left-style:\s*dashed/);
    expect(CSS).toMatch(/\.cdec--deleted::after\s*\{/);
  });

  it('falls back to system colours under forced colors', () => {
    expect(CSS).toMatch(/@media \(forced-colors: active\)[\s\S]{0,400}\.cdec--added/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/theme-tokens.test.ts`
Expected: FAIL — `token --change-added is not declared`.

- [ ] **Step 3: Add the tokens**

In `webview/styles.css`, after `--diff-hunk-band: rgba(255, 255, 255, 0.035);` (`:183`) inside `:root`:

```css
  /* Editor change decorations (spec 2026-08-27-review-supercharge §11). Measured against
     --code-base, which is what the gutter paints on; >= 3:1 in every theme. */
  --change-added: #5fbe86;
  --change-modified: #d99a52;
  --change-deleted: #e0645a;
```

Inside `:root[data-theme="aero"]`, after `--syn-default: #d3d7e4;` (`:269`):

```css
  --change-added: #6cc793;
  --change-modified: #e3a55f;
  --change-deleted: #e87066;
```

Inside `:root[data-theme="neon"]`, after `--diff-marker: #9a92c8;` (`:361`):

```css
  --change-added: #00ff96;
  --change-modified: #ffd23d;
  --change-deleted: #ff2d9b;
```

- [ ] **Step 4: Add the marker styles**

Append after the `.rline--del { background: var(--diff-remove); }` rule (`:9405`):

```css
/* ---- editor change decorations (spec 2026-08-27-review-supercharge §2 Lane A) ----
   Monaco writes an inline `left`/`width` onto every linesDecorationsClassName element, so the
   mark is drawn with BORDERS rather than a background — which is also exactly what §10's
   forced-colors rule requires. */
.cdec {
  position: relative;
  border-left: 3px solid transparent;
  box-sizing: border-box;
}
.cdec--added {
  border-left-color: var(--change-added);
}
.cdec--modified {
  border-left-color: var(--change-modified);
  border-left-style: dashed;
}
/* A deletion has no lines of its own to bar, so it is a triangle pointing at the seam. */
.cdec--deleted::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: -3px;
  border-left: 5px solid var(--change-deleted);
  border-top: 3px solid transparent;
  border-bottom: 3px solid transparent;
}
@media (forced-colors: active) {
  .cdec--added,
  .cdec--modified {
    border-left-color: CanvasText;
  }
  .cdec--deleted::after {
    border-left-color: CanvasText;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/theme-tokens.test.ts`
Expected: PASS — including 9 new contrast assertions and 2 structural ones.

- [ ] **Step 6: Format check**

Run: `npx biome check webview/styles.css`
Expected: no diagnostics. If formatting differs, run `npx biome format --write webview/styles.css` and re-check.

- [ ] **Step 7: Commit**

```bash
git add webview/styles.css test/unit/theme-tokens.test.ts
git commit -m "feat(theme): add change-marker tokens and gutter styling"
```

---

## Task 8: Minimap + change-marker settings

**Files:**
- Modify: `src/settings.ts` — `AppSettings` (after `wordWrap`, `:96`), `DEFAULT_SETTINGS` (after `wordWrap: false`, `:179`), `coerceSettings` (after the `wordWrap` line, `:405`)
- Modify: `webview/appearance-sections.ts:12-27` (control ids) and `:58` (the `editor` section)
- Modify: `webview/components/settings-modal.tsx` — two new `case`s in `renderControl`, after the `wordWrap` case (`:476-485`)
- Test: `test/unit/coerce-settings.test.ts`, `test/unit/appearance-sections.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppSettings['editorMinimap']: boolean` (default `true`), `AppSettings['editorChangeMarkers']: boolean` (default `true`); `AppearanceControlId` gains `'editorMinimap' | 'editorChangeMarkers'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/coerce-settings.test.ts`:

```ts
describe('editor marker settings', () => {
  it('defaults the minimap and change markers to on', () => {
    const s = coerceSettings({});
    expect(s.editorMinimap).toBe(true);
    expect(s.editorChangeMarkers).toBe(true);
  });

  it('honours an explicit off for each', () => {
    const s = coerceSettings({ editorMinimap: false, editorChangeMarkers: false });
    expect(s.editorMinimap).toBe(false);
    expect(s.editorChangeMarkers).toBe(false);
  });

  it('falls back to the default for a non-boolean value', () => {
    const s = coerceSettings({ editorMinimap: 'yes', editorChangeMarkers: 0 });
    expect(s.editorMinimap).toBe(true);
    expect(s.editorChangeMarkers).toBe(true);
  });
});
```

In `test/unit/appearance-sections.test.ts`, add `'editorMinimap'` and `'editorChangeMarkers'` to `EXPECTED_CONTROLS` (after `'wordWrap'`), and replace the body of the "groups code-block + word-wrap controls under Editor & code" test with:

```ts
    const editor = APPEARANCE_SECTIONS.find((s) => s.id === 'editor');
    expect(editor?.controls).toEqual([
      'wordWrap',
      'editorMinimap',
      'editorChangeMarkers',
      'surfaceColor',
      'codeOpacity',
    ]);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/coerce-settings.test.ts test/unit/appearance-sections.test.ts`
Expected: FAIL — `expected undefined to be true` and an array mismatch on the editor section.

- [ ] **Step 3: Extend `AppSettings`**

In `src/settings.ts`, after `wordWrap: boolean; // soft-wrap long lines in the code editor (Alt+Z toggles)` (`:96`):

```ts
  // Minimap in the code editor. Default ON as of spec 2026-08-27-review-supercharge §5, which
  // deliberately reverses spec 2026-06-11-minimap: the change marks in the minimap are half
  // the point of Lane A, so a hidden minimap hides them.
  editorMinimap: boolean;
  // Git change decorations (gutter bar / triangle + ruler + minimap marks) in the editor.
  // Default ON; gutter marks read as noise to some, hence the durable preference.
  editorChangeMarkers: boolean;
```

In `DEFAULT_SETTINGS`, after `wordWrap: false,` (`:179`):

```ts
  editorMinimap: true,
  editorChangeMarkers: true,
```

In `coerceSettings`, after the `wordWrap:` line (`:405`):

```ts
    editorMinimap: bool(payload.editorMinimap, DEFAULT_SETTINGS.editorMinimap),
    editorChangeMarkers: bool(payload.editorChangeMarkers, DEFAULT_SETTINGS.editorChangeMarkers),
```

- [ ] **Step 4: Extend the Appearance taxonomy**

In `webview/appearance-sections.ts`, add to `AppearanceControlId` after `| 'wordWrap'`:

```ts
  | 'editorMinimap'
  | 'editorChangeMarkers'
```

and change the `editor` section (`:58`) to:

```ts
  {
    id: 'editor',
    title: 'Editor & code',
    controls: ['wordWrap', 'editorMinimap', 'editorChangeMarkers', 'surfaceColor', 'codeOpacity'],
  },
```

- [ ] **Step 5: Render the two toggles**

In `webview/components/settings-modal.tsx`, after the `case 'wordWrap':` block (ends `:485`):

```tsx
      case 'editorMinimap':
        return (
          <Section
            key={id}
            title="Minimap"
            desc="Show the document map beside the scrollbar, with change marks"
          >
            <Toggle value={settings.editorMinimap} onChange={(v) => update({ editorMinimap: v })} />
          </Section>
        );
      case 'editorChangeMarkers':
        return (
          <Section
            key={id}
            title="Change markers"
            desc="Mark lines that differ from HEAD in the gutter, ruler and minimap"
          >
            <Toggle
              value={settings.editorChangeMarkers}
              onChange={(v) => update({ editorChangeMarkers: v })}
            />
          </Section>
        );
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/coerce-settings.test.ts test/unit/appearance-sections.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: both projects exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/settings.ts webview/appearance-sections.ts webview/components/settings-modal.tsx test/unit/coerce-settings.test.ts test/unit/appearance-sections.test.ts
git commit -m "feat(settings): add editorMinimap and editorChangeMarkers preferences"
```

---

## Task 9: Renderer HEAD-blob cache

**Files:**
- Create: `webview/head-blob-cache.ts`
- Test: `test/unit/head-blob-cache.test.ts`

**Interfaces:**
- Consumes: `HeadBlobReason` from `src/protocol.ts`.
- Produces:
  - `export interface HeadBlob { headSha: string | null; text: string | null; reason?: HeadBlobReason }`
  - `export const HEAD_BLOB_CACHE_MAX = 40`
  - `export function putHeadBlob(path: string, blob: HeadBlob): void`
  - `export function getHeadBlob(path: string, headSha: string | null): HeadBlob | undefined`
  - `export function getLatestHeadBlob(path: string): HeadBlob | undefined`
  - `export function invalidateHeadBlob(path: string): void`
  - `export function clearHeadBlobCache(): void`

Keyed `path + headSha` per §2 Lane A, so two panes on the same file share one blob. The per-path "latest" pointer is what lets a re-mount skip the round trip entirely; `invalidateHeadBlob` drops only that pointer, so a HEAD that moves and moves back still hits the keyed entry.

- [ ] **Step 1: Write the failing test**

Create `test/unit/head-blob-cache.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearHeadBlobCache,
  getHeadBlob,
  getLatestHeadBlob,
  HEAD_BLOB_CACHE_MAX,
  invalidateHeadBlob,
  putHeadBlob,
} from '../../webview/head-blob-cache';

describe('head blob cache', () => {
  beforeEach(() => clearHeadBlobCache());

  it('returns a blob under its own path + sha', () => {
    putHeadBlob('/r/a.ts', { headSha: 'sha1', text: 'x' });
    expect(getHeadBlob('/r/a.ts', 'sha1')).toEqual({ headSha: 'sha1', text: 'x' });
  });

  it('misses on a different sha for the same path', () => {
    putHeadBlob('/r/a.ts', { headSha: 'sha1', text: 'x' });
    expect(getHeadBlob('/r/a.ts', 'sha2')).toBeUndefined();
  });

  it('keys an untracked (null-sha) entry separately from a tracked one', () => {
    putHeadBlob('/r/a.ts', { headSha: null, text: null, reason: 'untracked' });
    putHeadBlob('/r/a.ts', { headSha: 'sha1', text: 'x' });
    expect(getHeadBlob('/r/a.ts', null)?.reason).toBe('untracked');
    expect(getHeadBlob('/r/a.ts', 'sha1')?.text).toBe('x');
  });

  it('serves the most recent blob for a path without knowing its sha', () => {
    putHeadBlob('/r/a.ts', { headSha: 'sha1', text: 'old' });
    putHeadBlob('/r/a.ts', { headSha: 'sha2', text: 'new' });
    expect(getLatestHeadBlob('/r/a.ts')).toEqual({ headSha: 'sha2', text: 'new' });
  });

  it('invalidate drops the latest pointer but keeps the keyed entry', () => {
    putHeadBlob('/r/a.ts', { headSha: 'sha1', text: 'x' });
    invalidateHeadBlob('/r/a.ts');
    expect(getLatestHeadBlob('/r/a.ts')).toBeUndefined();
    expect(getHeadBlob('/r/a.ts', 'sha1')).toEqual({ headSha: 'sha1', text: 'x' });
  });

  it('evicts the oldest entry past the bound', () => {
    for (let i = 0; i <= HEAD_BLOB_CACHE_MAX; i++) {
      putHeadBlob(`/r/f${i}.ts`, { headSha: 's', text: `t${i}` });
    }
    expect(getHeadBlob('/r/f0.ts', 's')).toBeUndefined();
    expect(getHeadBlob(`/r/f${HEAD_BLOB_CACHE_MAX}.ts`, 's')?.text).toBe(
      `t${HEAD_BLOB_CACHE_MAX}`,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/head-blob-cache.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/head-blob-cache"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview/head-blob-cache.ts`:

```ts
import type { HeadBlobReason } from '../src/protocol';

export interface HeadBlob {
  headSha: string | null;
  text: string | null;
  reason?: HeadBlobReason;
}

/** Bounded so a long session over many files can't hold every blob it ever read. */
export const HEAD_BLOB_CACHE_MAX = 40;

const SEP = '\u0000';
const keyed = new Map<string, HeadBlob>();
/** Which sha a path was last seen at — the reason a re-mount needs no round trip. */
const latest = new Map<string, string | null>();

const cacheKey = (path: string, headSha: string | null): string => `${path}${SEP}${headSha ?? ''}`;

export function putHeadBlob(path: string, blob: HeadBlob): void {
  const key = cacheKey(path, blob.headSha);
  // Re-insert so this entry becomes the newest in the Map's iteration order.
  keyed.delete(key);
  keyed.set(key, blob);
  latest.set(path, blob.headSha);
  while (keyed.size > HEAD_BLOB_CACHE_MAX) {
    const oldest = keyed.keys().next().value;
    if (oldest === undefined) break;
    keyed.delete(oldest);
  }
}

export function getHeadBlob(path: string, headSha: string | null): HeadBlob | undefined {
  return keyed.get(cacheKey(path, headSha));
}

export function getLatestHeadBlob(path: string): HeadBlob | undefined {
  if (!latest.has(path)) return undefined;
  return keyed.get(cacheKey(path, latest.get(path) ?? null));
}

/** HEAD or the working tree moved: the path's last-known sha is no longer trustworthy. */
export function invalidateHeadBlob(path: string): void {
  latest.delete(path);
}

/** Test-only: reset both maps between cases. */
export function clearHeadBlobCache(): void {
  keyed.clear();
  latest.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/head-blob-cache.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add webview/head-blob-cache.ts test/unit/head-blob-cache.test.ts
git commit -m "feat(editor): cache HEAD blobs per path and head sha in the renderer"
```

---

## Task 10: Rebindable Monaco keybindings + shortcut registry entries

**Files:**
- Create: `webview/monaco-keybinding.ts`
- Modify: `webview/shortcuts.ts` — two entries in the Editor group, after `reopenClosedTab` (`:90-95`)
- Test: `test/unit/monaco-keybinding.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface MonacoKeyTables { CtrlCmd: number; Shift: number; Alt: number; WinCtrl: number; keyCodes: Record<string, number> }`
  - `export function monacoKeybindingFor(combo: string, tables: MonacoKeyTables): number | null`
  - `SHORTCUT_ACTIONS` entries with ids `'nextChange'` (default `'Alt+F5'`) and `'prevChange'` (default `'Shift+Alt+F5'`), both `group: 'Editor'`.

A registry row that Settings lets you rebind, but which the editor ignores, would be a lie — so the combo string is translated into a real Monaco keybinding number. `monaco.KeyMod` / `monaco.KeyCode` are injected so this module carries no runtime monaco import.

- [ ] **Step 1: Write the failing test**

Create `test/unit/monaco-keybinding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { type MonacoKeyTables, monacoKeybindingFor } from '../../webview/monaco-keybinding';

/** Stand-ins for monaco.KeyMod / monaco.KeyCode; the real values are injected at runtime. */
const TABLES: MonacoKeyTables = {
  CtrlCmd: 1 << 11,
  Shift: 1 << 10,
  Alt: 1 << 9,
  WinCtrl: 1 << 8,
  keyCodes: { F5: 68, F12: 75, KeyS: 49, KeyZ: 56, Digit1: 22 },
};

describe('monacoKeybindingFor', () => {
  it('maps a bare function key', () => {
    expect(monacoKeybindingFor('F5', TABLES)).toBe(68);
  });

  it('maps Alt+F5 and Shift+Alt+F5', () => {
    expect(monacoKeybindingFor('Alt+F5', TABLES)).toBe(TABLES.Alt | 68);
    expect(monacoKeybindingFor('Shift+Alt+F5', TABLES)).toBe(TABLES.Shift | TABLES.Alt | 68);
  });

  it('maps Mod to CtrlCmd and a literal Ctrl to WinCtrl', () => {
    expect(monacoKeybindingFor('Mod+S', TABLES)).toBe(TABLES.CtrlCmd | 49);
    expect(monacoKeybindingFor('Ctrl+S', TABLES)).toBe(TABLES.WinCtrl | 49);
  });

  it('maps a single letter case-insensitively', () => {
    expect(monacoKeybindingFor('Alt+z', TABLES)).toBe(TABLES.Alt | 56);
  });

  it('maps a bare digit', () => {
    expect(monacoKeybindingFor('Mod+1', TABLES)).toBe(TABLES.CtrlCmd | 22);
  });

  it('returns null for a key monaco has no code for', () => {
    expect(monacoKeybindingFor('Alt+F19', TABLES)).toBeNull();
  });

  it('returns null for the navGoToTab digit family, which monaco cannot express', () => {
    expect(monacoKeybindingFor('Mod+1…9', TABLES)).toBeNull();
  });

  it('returns null for an empty combo', () => {
    expect(monacoKeybindingFor('', TABLES)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/monaco-keybinding.test.ts`
Expected: FAIL — `Failed to resolve import "../../webview/monaco-keybinding"`.

- [ ] **Step 3: Write minimal implementation**

Create `webview/monaco-keybinding.ts`:

```ts
/**
 * Translate a `webview/shortcuts.ts` combo string into a Monaco keybinding number, so a rebound
 * editor-scoped action actually changes what the editor listens for instead of only changing
 * what Settings prints. monaco.KeyMod / monaco.KeyCode are INJECTED so this module needs no
 * runtime monaco import and stays testable in node.
 */

export interface MonacoKeyTables {
  /** monaco.KeyMod.CtrlCmd */
  CtrlCmd: number;
  /** monaco.KeyMod.Shift */
  Shift: number;
  /** monaco.KeyMod.Alt */
  Alt: number;
  /** monaco.KeyMod.WinCtrl — the literal control key, distinct from CtrlCmd on macOS. */
  WinCtrl: number;
  /** monaco.KeyCode entries by NAME, e.g. { F5: 68, KeyS: 49, Digit1: 22 }. */
  keyCodes: Record<string, number>;
}

/** The combo's final token → the monaco.KeyCode NAME to look up. */
function keyCodeName(token: string): string | null {
  if (/^F\d{1,2}$/i.test(token)) return token.toUpperCase();
  if (/^[a-z]$/i.test(token)) return `Key${token.toUpperCase()}`;
  if (/^\d$/.test(token)) return `Digit${token}`;
  return null;
}

export function monacoKeybindingFor(combo: string, tables: MonacoKeyTables): number | null {
  if (!combo) return null;
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));

  const name = keyCodeName(key);
  if (name === null) return null;
  const code = tables.keyCodes[name];
  if (code === undefined) return null;

  let binding = code;
  if (mods.has('Mod')) binding |= tables.CtrlCmd;
  if (mods.has('Ctrl')) binding |= tables.WinCtrl;
  if (mods.has('Alt')) binding |= tables.Alt;
  if (mods.has('Shift')) binding |= tables.Shift;
  return binding;
}
```

- [ ] **Step 4: Add the registry entries**

In `webview/shortcuts.ts`, after the `reopenClosedTab` entry (`:90-95`):

```ts
  // Editor-scoped (Monaco owns the keystroke), but rebindable here like everything else —
  // code-viewer translates the effective combo through webview/monaco-keybinding.ts.
  { id: 'nextChange', description: 'Next change', group: 'Editor', defaultCombo: 'Alt+F5' },
  {
    id: 'prevChange',
    description: 'Previous change',
    group: 'Editor',
    defaultCombo: 'Shift+Alt+F5',
  },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/monaco-keybinding.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Run the full unit suite for regressions**

Run: `npx vitest run`
Expected: PASS. If a shortcut-registry count or snapshot assertion now fails, update it to include the two new actions — never delete the assertion.

- [ ] **Step 7: Commit**

```bash
git add webview/monaco-keybinding.ts webview/shortcuts.ts test/unit/monaco-keybinding.test.ts
git commit -m "feat(editor): make next/previous change rebindable through the shortcut registry"
```

---

## Task 11: The change-marker hook and its wiring into `CodeViewer`

**Files:**
- Create: `webview/use-change-markers.ts`
- Modify: `webview/components/code-viewer.tsx` — editor options (`:143`), refs and an `editorEpoch` state (near `:106`), a live-apply effect (near `:441`), the hook call (after `:485`), the live region and degraded hint in the JSX (`:504-520`)

**Interfaces:**
- Consumes: `computeFileReview` (`src/review-hunks.ts`); `hunksToMarkers`, `hunksToDecorations`, `navigateMarkers`, `MAX_DECORATION_LCS_CELLS`, `ChangeMarker`, `ChangeDecorationStyle` (Task 6); `getLatestHeadBlob`, `getHeadBlob`, `putHeadBlob`, `invalidateHeadBlob`, `HeadBlob` (Task 9); `isUnderRoot` (Task 1); `post`, `subscribe` (`webview/bridge.ts`); `onFileSaved` (`webview/save-registry.ts`); `makeDebouncedFlush` (`webview/use-debounced-flush.ts`); `cssVar` (`webview/css-var.ts`).
- Produces:

```ts
export type ChangeMarkersState = 'none' | 'loading' | 'live' | 'degraded';

export interface ChangeMarkersApi {
  state: ChangeMarkersState;
  markers: ChangeMarker[];
  /** Live-region text; '' when there is nothing to announce. */
  announcement: string;
  goToChange(direction: 'next' | 'prev'): void;
}

export function useChangeMarkers(params: {
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  editorEpoch: number;
  path: string;
  enabled: boolean;
  themeId: string;
}): ChangeMarkersApi
```

- [ ] **Step 1: Write the hook**

Create `webview/use-change-markers.ts`:

```ts
import * as monaco from 'monaco-editor';
import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostToWebview } from '../src/protocol';
import { computeFileReview } from '../src/review-hunks';
import { isUnderRoot } from '../src/repo-rel';
import { post, subscribe } from './bridge';
import {
  type ChangeDecorationStyle,
  type ChangeMarker,
  hunksToDecorations,
  hunksToMarkers,
  MAX_DECORATION_LCS_CELLS,
  navigateMarkers,
} from './change-decorations';
import { cssVar } from './css-var';
import {
  getHeadBlob,
  getLatestHeadBlob,
  type HeadBlob,
  invalidateHeadBlob,
  putHeadBlob,
} from './head-blob-cache';
import { onFileSaved } from './save-registry';
import { makeDebouncedFlush } from './use-debounced-flush';

export type ChangeMarkersState = 'none' | 'loading' | 'live' | 'degraded';

export interface ChangeMarkersApi {
  state: ChangeMarkersState;
  markers: ChangeMarker[];
  announcement: string;
  goToChange(direction: 'next' | 'prev'): void;
}

/** Long enough to skip a keystroke burst, short enough to feel live (spec §2 Lane A). */
const RECOMPUTE_DEBOUNCE_MS = 300;

let nextRequestId = 1;

/** Monaco takes literal colours for the ruler and minimap, so the tokens are resolved here. */
function readStyle(): ChangeDecorationStyle {
  const cs = getComputedStyle(document.documentElement);
  return {
    colors: {
      added: cssVar(cs, '--change-added', '#5fbe86'),
      modified: cssVar(cs, '--change-modified', '#d99a52'),
      deleted: cssVar(cs, '--change-deleted', '#e0645a'),
    },
    rulerLane: monaco.editor.OverviewRulerLane.Left,
    minimapPosition: monaco.editor.MinimapPosition.Gutter,
  };
}

export function useChangeMarkers({
  editorRef,
  editorEpoch,
  path,
  enabled,
  themeId,
}: {
  editorRef: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
  /** Bumped by CodeViewer every time a new editor instance is created. */
  editorEpoch: number;
  path: string;
  enabled: boolean;
  /** Theme id — re-resolves the marker colours and re-sets the collection. */
  themeId: string;
}): ChangeMarkersApi {
  const [state, setState] = useState<ChangeMarkersState>('none');
  const [markers, setMarkers] = useState<ChangeMarker[]>([]);
  const [announcement, setAnnouncement] = useState('');

  const collectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const headRef = useRef<HeadBlob | null>(null);
  const requestRef = useRef(0);
  const markersRef = useRef<ChangeMarker[]>([]);

  const apply = useCallback((next: ChangeMarker[]) => {
    markersRef.current = next;
    setMarkers(next);
    collectionRef.current?.set(hunksToDecorations(next, readStyle()));
  }, []);

  const clear = useCallback(() => {
    markersRef.current = [];
    setMarkers([]);
    collectionRef.current?.clear();
  }, []);

  const recompute = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model || !enabled) {
      clear();
      setState('none');
      return;
    }
    const head = headRef.current;
    // No blob yet: hold the previous decorations rather than flashing an empty gutter, and hold
    // them across a HEAD move too — spec §2 Lane A's `stale` rule.
    if (!head) {
      setState('loading');
      return;
    }
    if (head.reason && head.reason !== 'untracked') {
      clear();
      setState('none');
      return;
    }
    if (head.reason === 'untracked') {
      const count = model.getLineCount();
      apply([
        { kind: 'added', startLine: 1, endLine: count, addedLines: count, removedLines: 0 },
      ]);
      setState('live');
      return;
    }
    const review = computeFileReview(
      head.text ?? '',
      model.getValue(),
      3,
      MAX_DECORATION_LCS_CELLS,
    );
    if (review.approx) {
      clear();
      setState('degraded');
      return;
    }
    apply(hunksToMarkers(review.hunks, model.getLineCount()));
    setState('live');
  }, [apply, clear, editorRef, enabled]);

  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;

  const fetchHead = useCallback(() => {
    const cached = getLatestHeadBlob(path);
    if (cached) {
      headRef.current = cached;
      recomputeRef.current();
      return;
    }
    const requestId = nextRequestId++;
    requestRef.current = requestId;
    post({ type: 'git:headBlob', path, requestId });
  }, [path]);

  // Own the collection for this editor instance; cleared and dropped with it.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const collection = editor.createDecorationsCollection([]);
    collectionRef.current = collection;
    return () => {
      collection.clear();
      collectionRef.current = null;
    };
  }, [editorRef, editorEpoch]);

  // Mount + live recompute: the model's own edits, debounced.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const debounced = makeDebouncedFlush(() => recomputeRef.current(), RECOMPUTE_DEBOUNCE_MS);
    const sub = model.onDidChangeContent(() => debounced.schedule());
    headRef.current = null;
    setState(enabled ? 'loading' : 'none');
    if (enabled) fetchHead();
    else recomputeRef.current();
    return () => {
      debounced.cancel();
      sub.dispose();
    };
  }, [editorRef, editorEpoch, enabled, fetchHead]);

  // The host's reply. `requestId` is latest-wins: a slow answer for a superseded model must not
  // overwrite a newer one.
  useEffect(() => {
    return subscribe((msg: HostToWebview) => {
      if (msg.type !== 'git:headBlobResult') return;
      if (msg.path !== path || msg.requestId !== requestRef.current) return;
      const blob: HeadBlob = {
        headSha: msg.headSha,
        text: msg.text,
        ...(msg.reason ? { reason: msg.reason } : {}),
      };
      putHeadBlob(path, blob);
      headRef.current = getHeadBlob(path, msg.headSha) ?? blob;
      recomputeRef.current();
    });
  }, [path]);

  // HEAD moved, or the file changed on disk. `.git/HEAD` and `.git/refs/**` are deliberately
  // NOT filtered out of the watch (src/watch-filter.ts), so a commit or checkout arrives here.
  useEffect(() => {
    if (!enabled) return;
    const debounced = makeDebouncedFlush(() => {
      invalidateHeadBlob(path);
      fetchHead();
    }, RECOMPUTE_DEBOUNCE_MS);
    const unsubscribe = subscribe((msg: HostToWebview) => {
      if (msg.type !== 'fsChanged') return;
      if (!isUnderRoot(msg.root, path)) return;
      debounced.schedule();
    });
    const offSaved = onFileSaved((saved) => {
      if (saved !== path) return;
      invalidateHeadBlob(path);
      fetchHead();
    });
    return () => {
      debounced.cancel();
      unsubscribe();
      offSaved();
    };
  }, [enabled, fetchHead, path]);

  // Monaco can't read a CSS var for the ruler/minimap colour, so a theme switch has to
  // re-resolve them and re-set the collection (spec §11).
  useEffect(() => {
    if (markersRef.current.length === 0) return;
    collectionRef.current?.set(hunksToDecorations(markersRef.current, readStyle()));
  }, [themeId]);

  const goToChange = useCallback(
    (direction: 'next' | 'prev') => {
      const editor = editorRef.current;
      if (!editor) return;
      if (!enabled) {
        setAnnouncement('Change markers are off');
        return;
      }
      const current = editor.getPosition()?.lineNumber ?? 1;
      const hit = navigateMarkers(markersRef.current, current, direction);
      if (!hit) {
        setAnnouncement('No changes');
        return;
      }
      editor.setPosition({ lineNumber: hit.line, column: 1 });
      editor.revealLineInCenter(hit.line);
      editor.focus();
      setAnnouncement(`Change ${hit.index} of ${hit.total}`);
    },
    [editorRef, enabled],
  );

  return useMemo(
    () => ({ state, markers, announcement, goToChange }),
    [state, markers, announcement, goToChange],
  );
}
```

- [ ] **Step 2: Flip the minimap default and expose the editor epoch**

In `webview/components/code-viewer.tsx`, replace line `:143`:

```ts
      minimap: { enabled: false },
```

with:

```ts
      minimap: {
        enabled: minimapRef.current,
        // Character rendering makes the map a texture; Lane A needs it to be a MAP, with the
        // change marks legible on it (spec 2026-08-27-review-supercharge §2 Lane A).
        renderCharacters: false,
        showSlider: 'mouseover',
      },
```

Beside `wordWrapRef` (`:106-107`), add:

```ts
  const minimapRef = useRef(settings.editorMinimap);
  minimapRef.current = settings.editorMinimap;
  // Read via a ref so a rebind can't re-create the editor; the combos are resolved at
  // action-registration time, which is what Monaco actually binds.
  const shortcutsRef = useRef(settings.shortcuts);
  shortcutsRef.current = settings.shortcuts;
  // Bumped whenever the mount effect builds a NEW editor, so the marker hook re-binds to it
  // instead of holding a disposed instance.
  const [editorEpoch, setEditorEpoch] = useState(0);
```

At the end of the mount effect body, immediately before the `// Don't dispose models we keep…` comment (`:424`), add:

```ts
    setEditorEpoch((n) => n + 1);
```

Add a live-apply effect beside the existing `wordWrap` one (`:441-443`):

```ts
  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: settings.editorMinimap } });
  }, [settings.editorMinimap]);
```

- [ ] **Step 3: Call the hook and render its output**

Add the import at the top of `webview/components/code-viewer.tsx`:

```ts
import { type ChangeMarkersApi, useChangeMarkers } from '../use-change-markers';
```

After the theme effect (ends `:485`), add:

```ts
  const changes = useChangeMarkers({
    editorRef,
    editorEpoch,
    path: doc.path,
    enabled: settings.editorChangeMarkers && !doc.binary,
    themeId: settings.theme,
  });
  changesRef.current = changes;
```

and declare the ref beside `minimapRef`:

```ts
  // Read by the mount-bound Alt+F5 actions and the context menu, which are built once.
  const changesRef = useRef<ChangeMarkersApi | null>(null);
```

In the JSX, immediately after the `doc.truncated` banner (`:505`):

```tsx
      {changes.state === 'degraded' && (
        <div className="viewer__banner">
          Change markers off — file changed too much to line-match.
        </div>
      )}
```

and immediately after the `{menu && …}` line (`:519`):

```tsx
      <div className="sr-only" role="status" aria-live="polite">
        {changes.announcement}
      </div>
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 5: Run the unit suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add webview/use-change-markers.ts webview/components/code-viewer.tsx
git commit -m "feat(editor): compute and render live change decorations against HEAD"
```

---

## Task 12: Navigation entry points — actions, menu rows, palette

**Files:**
- Create: `webview/change-nav-registry.ts`
- Modify: `webview/editor-menu.ts` — `EditorMenuContext` (`:19-26`), `EditorMenuIconKey` (`:35-42`), a new group in `buildEditorMenuItems` after the navigation group (`:150`)
- Modify: `webview/components/code-viewer.tsx` — `MENU_ICONS` (`:40-48`), two `editor.addAction` registrations, the `buildEditorMenuItems` call (`:279`), registry registration
- Modify: `webview/app.tsx` — two palette entries inside the `if (activeDoc)` block (`:2267`)
- Test: `test/unit/editor-menu.test.ts`

**Interfaces:**
- Consumes: `ChangeMarkersApi` (Task 11); `monacoKeybindingFor` (Task 10); `effectiveCombo`, `SHORTCUT_ACTIONS` (`webview/shortcuts.ts`); `activeDocPath` (`webview/save-registry.ts`).
- Produces:
  - `export interface ChangeNavEntry { next(): void; prev(): void; hasChanges(): boolean }`
  - `export function registerChangeNav(path: string, entry: ChangeNavEntry): () => void`
  - `export function changeNavForActiveDoc(docs: readonly { id: string; path: string }[], activeId: string | null): ChangeNavEntry | undefined`
  - `EditorMenuContext` gains `hasChanges?: boolean`; `EditorMenuIconKey` gains `'compare'`; item ids `'nextChange'`, `'prevChange'`.
  - Monaco action ids: `agentdeck.nextChange`, `agentdeck.prevChange`.

- [ ] **Step 1: Write the failing test**

Append inside `describe('buildEditorMenuItems')` in `test/unit/editor-menu.test.ts`:

```ts
  it('omits the change rows when the file has no changes', () => {
    const list = ids({ readOnly: false, hasSelection: false, canGoToDefinition: true });
    expect(list).not.toContain('nextChange');
    expect(list).not.toContain('prevChange');
  });

  it('offers next / previous change when the file has changes', () => {
    const list = ids({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: true,
    });
    expect(list).toEqual(expect.arrayContaining(['nextChange', 'prevChange']));
  });

  it('does not offer a peek row — the change peek is Lane E', () => {
    const list = ids({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: true,
    });
    expect(list).not.toContain('peekChange');
  });

  it('prints the VS Code accelerators on the change rows', () => {
    const items = buildEditorMenuItems({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: true,
    });
    expect(items.find((i) => i.id === 'nextChange')?.hint).toBe('Alt+F5');
    expect(items.find((i) => i.id === 'prevChange')?.hint).toBe('Shift+Alt+F5');
  });

  it('starts the change group with a separator', () => {
    const items = buildEditorMenuItems({
      readOnly: false,
      hasSelection: false,
      canGoToDefinition: true,
      hasChanges: true,
    });
    expect(items.find((i) => i.id === 'nextChange')?.separatorBefore).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/editor-menu.test.ts`
Expected: FAIL — the array does not contain `nextChange`.

- [ ] **Step 3: Extend the menu builder**

In `webview/editor-menu.ts`, add to `EditorMenuContext` after `canGoToDefinition` (`:25`):

```ts
  /** The file has uncommitted changes — gates the change-navigation group entirely. */
  hasChanges?: boolean;
```

Add `| 'compare'` to `EditorMenuIconKey`.

After the navigation group `items.push(...)` (ends `:150`), insert:

```ts
  // Change navigation (spec 2026-08-27-review-supercharge §9). The whole group is absent on an
  // unchanged file — two permanently-disabled rows would be noise, not information. "Peek
  // change" joins this group in Lane E, with the view zone it needs.
  if (ctx.hasChanges) {
    items.push(
      {
        id: 'nextChange',
        label: 'Next change',
        action: { kind: 'action', actionId: 'agentdeck.nextChange' },
        iconKey: 'compare',
        separatorBefore: true,
        hint: 'Alt+F5',
      },
      {
        id: 'prevChange',
        label: 'Previous change',
        action: { kind: 'action', actionId: 'agentdeck.prevChange' },
        hint: 'Shift+Alt+F5',
      },
    );
  }
```

- [ ] **Step 4: Add the nav registry**

Create `webview/change-nav-registry.ts`:

```ts
import { activeDocPath } from './save-registry';

/**
 * Change-navigation registry — the same shape as save-registry, and for the same reason: the
 * command palette lives in app.tsx and has no handle on the active editor, so the CodeViewer
 * registers its own next/prev under its doc PATH and the palette routes through here.
 */
export interface ChangeNavEntry {
  next(): void;
  prev(): void;
  hasChanges(): boolean;
}

const registry = new Map<string, ChangeNavEntry>();

/** Register `entry` for `path`; the returned teardown is identity-checked so a remount that
 *  already replaced the entry can't have it deleted out from under it. */
export function registerChangeNav(path: string, entry: ChangeNavEntry): () => void {
  registry.set(path, entry);
  return () => {
    if (registry.get(path) === entry) registry.delete(path);
  };
}

export function changeNavForActiveDoc(
  docs: readonly { id: string; path: string }[],
  activeId: string | null,
): ChangeNavEntry | undefined {
  const path = activeDocPath(docs, activeId);
  return path === null ? undefined : registry.get(path);
}
```

- [ ] **Step 5: Register the Monaco actions**

In `webview/components/code-viewer.tsx`, add to `MENU_ICONS` (`:40-48`):

```tsx
  compare: <IconCompare size={14} />,
```

and add `IconCompare` to the `../icons` import. Add:

```ts
import { registerChangeNav } from '../change-nav-registry';
import { monacoKeybindingFor } from '../monaco-keybinding';
import { effectiveCombo, SHORTCUT_ACTIONS } from '../shortcuts';
```

Inside the mount effect, after the `agentdeck.toggleWordWrap` action (`:268`):

```ts
    // Monaco owns these keystrokes, but the combo comes from the app's rebindable registry
    // (spec 2026-08-27-review-supercharge §5) — translated because monaco wants a number.
    const keyTables = {
      CtrlCmd: monaco.KeyMod.CtrlCmd,
      Shift: monaco.KeyMod.Shift,
      Alt: monaco.KeyMod.Alt,
      WinCtrl: monaco.KeyMod.WinCtrl,
      keyCodes: monaco.KeyCode as unknown as Record<string, number>,
    };
    const comboKey = (actionId: string): number[] => {
      const action = SHORTCUT_ACTIONS.find((a) => a.id === actionId);
      if (!action) return [];
      const binding = monacoKeybindingFor(effectiveCombo(action, shortcutsRef.current), keyTables);
      return binding === null ? [] : [binding];
    };
    editor.addAction({
      id: 'agentdeck.nextChange',
      label: 'Go to Next Change',
      keybindings: comboKey('nextChange'),
      run: () => changesRef.current?.goToChange('next'),
    });
    editor.addAction({
      id: 'agentdeck.prevChange',
      label: 'Go to Previous Change',
      keybindings: comboKey('prevChange'),
      run: () => changesRef.current?.goToChange('prev'),
    });
```

- [ ] **Step 6: Feed the hook into the menu and the registry**

After the `changesRef.current = changes;` line added in Task 11:

```ts
  useEffect(() => {
    return registerChangeNav(doc.path, {
      next: () => changes.goToChange('next'),
      prev: () => changes.goToChange('prev'),
      hasChanges: () => changes.markers.length > 0,
    });
  }, [doc.path, changes]);
```

In the `onContextMenu` handler (`:279`), change:

```ts
      const specs = buildEditorMenuItems({ readOnly: false, hasSelection, canGoToDefinition });
```

to:

```ts
      const specs = buildEditorMenuItems({
        readOnly: false,
        hasSelection,
        canGoToDefinition,
        hasChanges: (changesRef.current?.markers.length ?? 0) > 0,
      });
```

- [ ] **Step 7: Add the palette entries**

In `webview/app.tsx`, inside the `if (activeDoc) { … }` block (starting `:2268`), after the `cmd:copyFile` entry:

```tsx
      if (activeDoc.kind === 'file') {
        const nav = changeNavForActiveDoc(docState.docs, docState.activeId);
        if (nav?.hasChanges()) {
          cmds.push(
            {
              id: 'cmd:nextChange',
              title: 'Go to next change',
              group: 'Commands',
              icon: <IconCompare size={14} />,
              combo: comboFor('nextChange'),
              run: () => nav.next(),
            },
            {
              id: 'cmd:prevChange',
              title: 'Go to previous change',
              group: 'Commands',
              icon: <IconCompare size={14} />,
              combo: comboFor('prevChange'),
              run: () => nav.prev(),
            },
          );
        }
      }
```

Add `changeNavForActiveDoc` from `./change-nav-registry` and `IconCompare` to the existing `./icons` import in `webview/app.tsx`.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/unit/editor-menu.test.ts`
Expected: PASS — including the 5 new cases.

- [ ] **Step 9: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 10: Commit**

```bash
git add webview/change-nav-registry.ts webview/editor-menu.ts webview/components/code-viewer.tsx webview/app.tsx test/unit/editor-menu.test.ts
git commit -m "feat(editor): add next/previous change to keys, context menu and palette"
```

---

## Task 13: Changelog entry

**Files:**
- Modify: `CHANGELOG.md` — new `## [Unreleased]` section above `## [0.34.0] — 2026-08-27` (`:7`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Add the entry**

Insert immediately before `## [0.34.0] — 2026-08-27`:

```markdown
## [Unreleased]

### Added
- **The editor now shows what changed.** Open any file with uncommitted work and the gutter
  marks it: a solid bar on added lines, a dashed bar where a line was rewritten, and a small
  triangle where lines were removed — with matching marks on the scroll map and in the minimap,
  so you can see at a glance where an agent has been in a file you haven't scrolled through yet.
  The marks are live: they follow your typing, they follow a commit or a branch switch, and a
  brand-new file reads as added end to end. `Alt+F5` and `Shift+Alt+F5` walk the changes (both
  rebindable in Settings › Shortcuts), and hovering a mark says what it is. Everything is
  measured against HEAD, the same baseline the Review tab uses, so the two can't disagree.
- **The minimap is on by default**, without character rendering — it is where the change marks
  for the parts of a file you can't see actually live. Settings › Appearance › Editor & code has
  a switch for it, and one for the change markers themselves.
```

- [ ] **Step 2: Confirm nothing else broke**

Run: `npx biome check CHANGELOG.md`
Expected: no diagnostics.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for editor change decorations"
```

---

## Task 14: The `editor-change-markers` e2e scenario

**Files:**
- Create: `test/e2e/editor-change-markers.e2e.mjs`

**Interfaces:**
- Consumes: `assert`, `closeApp`, `openSession`, `runScenario` from `test/e2e/harness.mjs`; `window.monaco` (exposed by `webview/monaco-setup.ts:34`).
- Produces: nothing.

Every Lane A path crosses the host/IPC boundary (`git:headBlob` spawns git), so per `CLAUDE.md` it gets a scenario on the shared harness. The runner launches hidden; run it alone on a quiet machine. The overview ruler is a canvas with no assertable DOM — it is verified through the decoration's `overviewRuler.color` instead.

- [ ] **Step 1: Write the scenario**

Create `test/e2e/editor-change-markers.e2e.mjs`:

```js
/**
 * Editor change decorations (real-app smoke). Crosses the renderer/host boundary: `git:headBlob`
 * runs `rev-parse` and `show HEAD:<rel>` on the host, and the renderer diffs that blob against
 * the live Monaco model. The preview mock answers `notRepo`, so only the built app proves it.
 *
 * Flow: temp repo with a committed file → modify it (an insertion, a replacement, a deletion)
 * plus one untracked file → open the tracked file → assert gutter DOM + decoration options
 * (ruler and minimap colours; the ruler is a canvas and has no assertable DOM) → Alt+F5
 * announcement → screenshot → open the untracked file → whole-file added.
 *
 * The change PEEK is Lane E and is deliberately not asserted here.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, closeApp, openSession, runScenario } from './harness.mjs';

const line = (n) => `const v${n} = ${n};`;
const committed = Array.from({ length: 14 }, (_, i) => line(i + 1)).join('\n');

/** Lines 4-5 removed; line 8 rewritten; two lines inserted after line 11. */
const modified = [
  line(1),
  line(2),
  line(3),
  line(6),
  line(7),
  'const v8 = 800;',
  line(9),
  line(10),
  line(11),
  'const inserted1 = 1;',
  'const inserted2 = 2;',
  line(12),
  line(13),
  line(14),
].join('\n');

/** Read every change decoration Monaco holds for the model whose uri ends with `suffix`. */
const readDecorations = (suffix) => {
  const eds = window.monaco.editor.getEditors?.() ?? [];
  const ed = eds.find((e) => e.getModel()?.uri.toString().endsWith(suffix));
  const model = ed?.getModel();
  if (!model) return null;
  return model
    .getAllDecorations()
    .filter((d) => (d.options.linesDecorationsClassName ?? '').includes('cdec'))
    .map((d) => ({
      cls: d.options.linesDecorationsClassName,
      start: d.range.startLineNumber,
      end: d.range.endLineNumber,
      hover: d.options.hoverMessage?.value ?? '',
      ruler: d.options.overviewRuler?.color ?? '',
      minimap: d.options.minimap?.color ?? '',
    }));
};

const openInEditor = async (page, name) => {
  const row = page.locator('.filerow', {
    has: page.locator('.filerow__name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }),
  });
  await row.first().waitFor({ state: 'attached', timeout: 20000 });
  await row.first().click();
  await page.waitForFunction(
    (suffix) =>
      (window.monaco?.editor.getModels() ?? []).some((m) => m.uri.toString().endsWith(suffix)),
    name,
    { timeout: 20000 },
  );
};

runScenario('editor-change-markers', async ({ app, page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-marks-'));
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'marks@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Marks Author'], { cwd: root });
  writeFileSync(join(root, 'tracked.ts'), `${committed}\n`);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: root });
  writeFileSync(join(root, 'tracked.ts'), `${modified}\n`);
  writeFileSync(join(root, 'brandnew.ts'), 'const fresh = true;\nconst alsoFresh = 1;\n');

  await openSession(page, { path: root.replace(/\\/g, '/') });
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await openInEditor(page, 'tracked.ts');
  log('tracked file opened in the editor ✓');

  // Gutter DOM — the three shapes the accessibility contract relies on (§10).
  await page.locator('.margin-view-overlays .cdec--added').first().waitFor({ timeout: 15000 });
  await page.locator('.margin-view-overlays .cdec--modified').first().waitFor({ timeout: 15000 });
  await page.locator('.margin-view-overlays .cdec--deleted').first().waitFor({ timeout: 15000 });
  log('gutter shows added, modified and deleted marks ✓');

  const decos = await page.evaluate(readDecorations, 'tracked.ts');
  assert(
    Array.isArray(decos) && decos.length >= 3,
    `expected >=3 change decorations, got ${decos?.length}`,
  );
  const kinds = new Set(decos.map((d) => d.cls));
  for (const cls of ['cdec cdec--added', 'cdec cdec--modified', 'cdec cdec--deleted']) {
    assert(kinds.has(cls), `missing a "${cls}" decoration; got ${[...kinds].join(', ')}`);
  }
  assert(
    decos.every((d) => d.ruler !== '' && d.minimap !== ''),
    'every change decoration must carry an overview-ruler and a minimap colour',
  );
  assert(
    decos.every((d) => /^(Added|Modified|Deleted) \d+ lines?$/.test(d.hover)),
    `hover text must state kind + line count, got ${JSON.stringify(decos.map((d) => d.hover))}`,
  );
  log(`${decos.length} decorations, all with ruler + minimap marks and tooltips ✓`);

  // Alt+F5 announces through the polite live region.
  await page.evaluate(() => {
    const eds = window.monaco.editor.getEditors?.() ?? [];
    const ed = eds.find((e) => e.getModel()?.uri.toString().endsWith('tracked.ts')) ?? eds[0];
    ed?.focus();
    ed?.setPosition({ lineNumber: 1, column: 1 });
  });
  await page.keyboard.press('Alt+F5');
  await page.waitForFunction(
    () =>
      /Change \d+ of \d+/.test(
        document.querySelector('.viewer [role="status"][aria-live="polite"]')?.textContent ?? '',
      ),
    null,
    { timeout: 10000 },
  );
  const announced =
    (await page.locator('.viewer [role="status"][aria-live="polite"]').first().textContent())?.trim() ??
    '';
  log(`live region announced: "${announced}"`);

  const shotDir = join(process.env.TEMP || tmpdir(), 'claude-scratch');
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: join(shotDir, 'editor-change-markers.png') }).catch(() => {});

  // An untracked file reads as one whole-file addition.
  await page.locator('.rtab', { hasText: 'Files' }).click();
  await openInEditor(page, 'brandnew.ts');
  await page.waitForFunction(
    () => {
      const eds = window.monaco.editor.getEditors?.() ?? [];
      const ed = eds.find((e) => e.getModel()?.uri.toString().endsWith('brandnew.ts'));
      const model = ed?.getModel();
      if (!model) return false;
      const d = model
        .getAllDecorations()
        .filter((x) => (x.options.linesDecorationsClassName ?? '').includes('cdec'));
      return d.length === 1 && d[0].options.linesDecorationsClassName.includes('cdec--added');
    },
    null,
    { timeout: 15000 },
  );
  const fresh = await page.evaluate(readDecorations, 'brandnew.ts');
  assert(fresh.length === 1, `untracked file should have ONE marker, got ${fresh.length}`);
  assert(fresh[0].start === 1, `untracked marker should start at line 1, got ${fresh[0].start}`);
  log('untracked file marked as one whole-file addition ✓');

  await closeApp(app, page);
});
```

- [ ] **Step 2: Run the scenario alone**

Run: `node test/e2e/run-smoke.mjs editor-change-markers`
Expected: `PASS editor-change-markers`. Run it on a quiet machine — leftover `cmd.exe`/`conhost` from an earlier run starves ConPTY and makes every scenario look broken (`CLAUDE.md`).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/editor-change-markers.e2e.mjs
git commit -m "test(e2e): cover editor change markers and next-change navigation"
```

---

## Task 15: Full gate

**Files:** none.

**Interfaces:**
- Consumes: everything above.
- Produces: a green lane.

- [ ] **Step 1: Run the full verify gate**

Run: `npm run verify`
Expected: exit 0. Read the WHOLE output — never pipe it through `tail`, which has twice hidden a "Found N errors" line in this repo. If `fallow:check` reports an unused export, delete the export rather than suppressing the check; if a check fails, fix the code, never the check.

- [ ] **Step 2: Run the full smoke suite**

Run: `npm run test:smoke`
Expected: every scenario PASS or SKIP, zero FAIL. Re-run any single failure alone before believing it.

- [ ] **Step 3: Confirm the working tree is clean of scratch**

Run: `git status --ignored --short`
Expected: only the intended files. Screenshots live under `%TEMP%\claude-scratch`; nothing from this lane belongs in the repo.

- [ ] **Step 4: Commit anything the gate corrected**

```bash
git add -A
git commit -m "chore: verify green for editor change decorations"
```

(Skip if `git status` is already clean.)

---

## Self-Review

Run against the revised spec with fresh eyes.

**1. Spec coverage (revision note, §2 Lane A, §3, §4, §5, §7 Lane A, §8–§11)**

| Spec requirement | Task |
|---|---|
| Baseline HEAD, same as Review's All scope | 3 (host reads `HEAD:<rel>`), 11 (`computeFileReview` — the same function Review uses) |
| `git:headBlob` on mount / HEAD change / `fsChanged` | 11 (mount effect; `fsChanged` + `onFileSaved` effect) |
| **`readDiff` plumbing — no second `git show` path**; `MAX_BYTES`; `toLf`; repo-from-file-dir with `git:blame`-style containment | 3 (exported `MAX_BYTES`/`toLf`, `repoRelPath` containment), 4 (`gitShowHead` is the single show path behind `gitShow`, `gitShowBuffer` and the handler) |
| **Toplevel lookup memoised per directory; N shows, not 2N spawns** | 2 (`createAsyncMemo` with in-flight dedupe), 4 (`repoTopLevel` + `headShaFor`; exit-128 replaces the `ls-files` spawn, so it is exactly one `show` per file) |
| Renderer caches `text` per `path+headSha` | 9 |
| Hunks in the renderer via `computeFileReview` | 11 |
| **Own budget `MAX_DECORATION_LCS_CELLS = 250_000`, exposed as an option on `computeFileReview`; exceeding → `degraded`** | 5 (the option), 6 (the constant + its degradation test), 11 (passed on every recompute; `approx` → `degraded`) |
| **Unit benchmark: 2 000-line file, 50-line change, < 16 ms** | 6 |
| Debounce 300 ms after the last edit; also on save | 11 |
| Pure `hunksToDecorations` with unit tests | 6 |
| added = solid bar, modified = dashed, deleted = triangle after the deletion (last line at EOF) | 6 (markers), 7 (CSS) |
| ruler + minimap marks per change; `hoverMessage` copy | 6, 11 (`readStyle`) |
| One `createDecorationsCollection` per editor, `.set()` wholesale, `.clear()` on swap, disposed with the editor | 11 |
| Next/prev reuse `diff-nav.ts`; wraps | 6 (`navigateMarkers`) |
| Minimap default flip (`enabled`, `renderCharacters:false`, `showSlider:'mouseover'`) | 11 |
| `Alt+F5` / `Shift+Alt+F5` via `editor.addAction`, palette rows, editor-menu rows with `hasChanges`, rebindable registry entries | 10, 12 |
| Announces "Change N of M" via the live region | 11 |
| **Change peek deferred to Lane E** | Called out in the plan header, in Task 12's menu comment and test (`does not offer a peek row`), and in the e2e's header; no `usePeekZone`, no `--change-peek-bg`, no `agentdeck.peekChange` anywhere |
| States none / loading / live / degraded / stale; untracked = whole-file added | 11 |
| `editorMinimap`, `editorChangeMarkers` in Appearance | 8 |
| §4 rapid edits, HEAD change with a file open, two panes on one file, untracked, not-a-repo/binary/oversize/error, budget exceeded, 0/1/many hunks | 11 (debounce, hold-old-collection, cache, reason handling), 6 (`navigateMarkers` null / single-change wrap) |
| §7 "no markers and no error"; "one host log line" | 4 (`log.debug`), 11 (`none`) |
| §10 colour never alone, ≥ 3:1, live region, forced colors, English literals | 7, 11 |
| §11 three tokens per theme, `getComputedStyle` + re-`set()` on theme change | 7, 11 |
| §7 e2e `editor-change-markers` (no peek assertions) | 14 |
| CHANGELOG | 13 |

No gaps. Lanes B–F are deliberately absent, and every Lane E item the earlier draft carried (peek zone, peek panel, peek anchor/height helpers, peek CSS, peek token, peek action, peek menu row, peek e2e assertions) has been removed.

**2. Placeholder scan**

No "TBD", no "similar to Task N", no "add error handling". Every code step carries the actual code; every test step carries real assertions with real expected values.

**3. Type consistency**

- `HeadBlobReason` is declared once in `src/protocol.ts` (Task 3) and imported by `src/head-blob.ts` (Task 3) and `webview/head-blob-cache.ts` (Task 9).
- `HeadBlobShow` is declared in `src/head-blob.ts` (Task 3) and is the exact return type of `gitShowHead` in Task 4 (`ok`, `bytes`, `code`, `failed` — all four set).
- `HeadBlobDeps`'s three members (`repoRoot`, `headSha`, `showBlob`) are satisfied by `repoTopLevel`, `headShaFor`, `gitShowHead` in Task 4; the signatures match (`(dir) => Promise<string>`, `(root) => Promise<string | null>`, `(root, rel) => Promise<HeadBlobShow>`).
- `HeadBlob` (renderer, Task 9) and `HeadBlobResult` (host, Task 3) are structurally identical but deliberately distinct names — the hook converts the message into a `HeadBlob` explicitly.
- `ChangeMarker` fields (`kind`, `startLine`, `endLine`, `addedLines`, `removedLines`) are identical in Tasks 6, 11 and 12. No `removed` text field anywhere — that was peek-only and is gone.
- `ChangeDecorationStyle` (`colors`, `rulerLane`, `minimapPosition`) is produced by `readStyle()` in Task 11 and consumed by `hunksToDecorations` in Task 6.
- `ChangeMarkersApi` members (`state`, `markers`, `announcement`, `goToChange`) are used exactly as declared in Tasks 11 and 12 — no `peekIndex` / `openPeek` / `closePeek` / `untracked` remain.
- `navigateMarkers` returns `{ line, index, total }`; Task 11 reads `hit.index` / `hit.total`.
- `MonacoKeyTables` fields (`CtrlCmd`, `Shift`, `Alt`, `WinCtrl`, `keyCodes`) match Task 12's `keyTables` literal.
- `ChangeNavEntry` (`next`, `prev`, `hasChanges`) is registered in Task 12 and read by Task 12's palette block.
- Shortcut ids `'nextChange'` / `'prevChange'` appear in Task 10 (registry) and Task 12 (`comboKey`, `comboFor`); Monaco action ids `agentdeck.nextChange` / `agentdeck.prevChange` appear in Task 12's registration and its menu specs.
- `computeFileReview(head, work, context, maxLcsCells)` — the 4-argument form used in Tasks 5, 6 and 11 matches the signature defined in Task 5.
- CSS class names `.cdec`, `.cdec--added|modified|deleted` are produced in Tasks 6/7 and asserted in Tasks 7 and 14.

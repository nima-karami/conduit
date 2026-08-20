# Commit Review Memory Bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A commit review of ANY commit is memory-bounded and fast: no quadratic LCS allocation, badges from host `--numstat`, an error channel instead of an eternal "Loading commit changes…", and a 10 s diff timeout.

**Architecture:** All heavy-math changes land in the pure module `src/review-hunks.ts` (prefix/suffix trim + cell budget + `approx` flag), so both call sites (`webview/review-commit.ts` badges, `webview/components/review-view.tsx` per-card) are fixed at the source. The host (`src/git-history.ts`) gains per-file counts via one extra `diff-tree --numstat -z` spawn; the renderer prefers them. The loader `webview/use-commit-files.ts` is upgraded to the exact shape of its sibling `webview/use-range-files.ts` (error + requestId + retry).

**Tech Stack:** TypeScript, React 18, Electron main-process git spawns (`src/git-exec.ts` `runGit`), vitest (`test/unit/`), Playwright-Electron e2e (`test/e2e/harness.mjs`).

**Spec:** `docs/specs/2026-08-20-commit-review-memory-bounds.md`

## Global Constraints

- `npm run verify` must stay fully green; never weaken/narrow/disable any gate.
- Comments: WHY only; link the spec (`// see docs/specs/2026-08-20-commit-review-memory-bounds.md`), never restate it. Hard repo rule.
- Two tsconfigs (host + webview): `npm run typecheck` runs both; `src/` modules must not import node builtins if the renderer imports them (`review-hunks.ts` is renderer-shared; `git-history.ts` is host-only).
- Biome: `lint/suspicious/noControlCharactersInRegex` is an error — no `\x1b`-style chars in regexes; split on strings instead.
- E2E runs strictly serially; a PTY-ish failure on a loaded machine must be re-run ALONE before being believed.
- All commands run inside the task worktree, never the main checkout.

---

### Task 1: Bounded `diffLines` — trim + cell budget + `approx`

**Files:**
- Modify: `src/review-hunks.ts` (function `diffLines` at ~:83; interface `FileReview` at ~:53; `computeFileReview` at ~:127; `computeReplacementEmphasis` at ~:335)
- Test: `test/unit/review-hunks-bounds.test.ts` (new; the existing `test/unit/` has `word-diff.test.ts` etc. — follow their style)

**Interfaces:**
- Consumes: existing `Op`, `splitLines`.
- Produces (later tasks rely on these exact names):
  - `export const MAX_LCS_CELLS = 4_000_000;`
  - `FileReview` gains `approx?: true;`
  - `computeFileReview(head, work, context?)` unchanged signature; sets `approx: true` when the degenerate path fired.
  - `export const EMPHASIS_MAX_LINES = 4000;` — `computeReplacementEmphasis` returns an empty map when `lines.length > EMPHASIS_MAX_LINES`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { computeFileReview, MAX_LCS_CELLS } from '../../src/review-hunks';

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}-${i}`).join('\n');

describe('bounded diffLines', () => {
  it('big file with a small mid-file edit diffs EXACTLY via prefix/suffix trim', () => {
    const n = 30000;
    const head = lines(n, 'x');
    const work = head.replace('x-15000', 'EDITED');
    const r = computeFileReview(head, work);
    expect(r.approx).toBeUndefined();
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
    expect(r.hunks).toHaveLength(1);
  });

  it('two unrelated large sides degrade to an approx whole-replacement, not a quadratic alloc', () => {
    const n = 8000; // 8000*8000 = 64M cells > MAX_LCS_CELLS — would be ~512MB dense
    const r = computeFileReview(lines(n, 'a'), lines(n, 'b'));
    expect(r.approx).toBe(true);
    expect(r.added).toBe(n);
    expect(r.removed).toBe(n);
  });

  it('trim handles pure-append and pure-truncate without approx', () => {
    const head = lines(20000, 'x');
    const r = computeFileReview(head, `${head}\nnew-1\nnew-2`);
    expect(r.approx).toBeUndefined();
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
  });

  it('identical sides stay a no-op regardless of size', () => {
    const head = lines(50000, 'x');
    const r = computeFileReview(head, head);
    expect(r.hunks).toHaveLength(0);
    expect(r.approx).toBeUndefined();
  });

  it('small files behave exactly as before (budget invisible)', () => {
    const r = computeFileReview('a\nb\nc', 'a\nX\nc');
    expect(r.approx).toBeUndefined();
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
  });

  it('cell budget is the documented constant', () => {
    expect(MAX_LCS_CELLS).toBe(4_000_000);
  });
});
```

Also (same file) the emphasis guard:

```ts
import { computeReplacementEmphasis, EMPHASIS_MAX_LINES } from '../../src/review-hunks';
import type { ReviewLine } from '../../src/review-hunks';

it('computeReplacementEmphasis bails on a giant hunk', () => {
  const mk = (kind: 'del' | 'add', i: number): ReviewLine => ({
    kind, text: `t${i}`, oldLine: kind === 'del' ? i + 1 : null,
    newLine: kind === 'add' ? i + 1 : null, seq: i,
  });
  const big: ReviewLine[] = [
    ...Array.from({ length: EMPHASIS_MAX_LINES / 2 + 1 }, (_, i) => mk('del', i)),
    ...Array.from({ length: EMPHASIS_MAX_LINES / 2 + 1 }, (_, i) => mk('add', i + 100000)),
  ];
  expect(computeReplacementEmphasis(big).size).toBe(0);
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/review-hunks-bounds.test.ts`. Expected: FAIL — `MAX_LCS_CELLS` not exported; the 8000×8000 case either OOM-pressures or returns `approx: undefined`. (If the 8000² case is slow rather than failing, that IS the pre-fix behavior — the assertion on `approx` still fails.)

- [ ] **Step 3: Implement in `src/review-hunks.ts`**

Replace the body of `diffLines` (keep name/signature — both `computeFileReview` and nothing else call it; have it return `{ ops: Op[]; approx: boolean }` and update the one caller):

```ts
export const MAX_LCS_CELLS = 4_000_000;

function diffLines(a: string[], b: string[]): { ops: Op[]; approx: boolean } {
  // Common prefix/suffix trim — see the spec: the dominant huge-file case (a small
  // edit in a generated file) reduces to a tiny core that diffs exactly.
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; }

  const ops: Op[] = [];
  for (let i = 0; i < lo; i++) {
    ops.push({ kind: 'context', text: a[i], oldLine: i + 1, newLine: i + 1 });
  }

  const coreA = a.slice(lo, hiA);
  const coreB = b.slice(lo, hiB);
  const n = coreA.length;
  const m = coreB.length;
  let approx = false;

  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    // see docs/specs/2026-08-20-commit-review-memory-bounds.md — degenerate
    // whole-core replacement instead of a multi-GB dense LCS table.
    approx = true;
    for (let i = 0; i < n; i++) {
      ops.push({ kind: 'del', text: coreA[i], oldLine: lo + i + 1, newLine: null });
    }
    for (let j = 0; j < m; j++) {
      ops.push({ kind: 'add', text: coreB[j], oldLine: null, newLine: lo + j + 1 });
    }
  } else {
    // existing dense-LCS body, applied to the core with line numbers offset by `lo`
    // (oldLine: lo + i + 1, newLine: lo + j + 1)
  }

  for (let i = hiA; i < a.length; i++) {
    // suffix context: old/new line numbers differ when the sides changed length
    ops.push({ kind: 'context', text: a[i], oldLine: i + 1, newLine: i - hiA + hiB + 1 });
  }
  return { ops, approx };
}
```

Port the existing LCS body into the `else` branch verbatim, with the `lo` offset applied to `oldLine`/`newLine`. In `computeFileReview`, destructure `const { ops, approx } = diffLines(a, b)` and include `...(approx ? { approx: true as const } : {})` in BOTH return sites (the early empty return can't be approx — an approx result always has ops). Add `approx?: true;` to `FileReview` with a one-line doc pointing at the spec.

In `computeReplacementEmphasis`, add at the top:

```ts
export const EMPHASIS_MAX_LINES = 4000;
// ...
if (lines.length > EMPHASIS_MAX_LINES) return map;
```

(guard placed after `const map = new Map...`).

- [ ] **Step 4: Run the new tests + the existing suite for this module** — `npx vitest run test/unit/review-hunks-bounds.test.ts test/unit/review-hunks.test.ts test/unit/word-diff.test.ts` (adjust to the actual existing filenames covering review-hunks; find them with `grep -rl review-hunks test/unit`). Expected: ALL PASS — the trim must not change any existing expected output (context/fold/hunk-header tests are the regression net for the offset math).

- [ ] **Step 5: Commit** — `git add src/review-hunks.ts test/unit/review-hunks-bounds.test.ts && git commit -m "fix(review): bound diffLines memory with prefix/suffix trim + LCS cell budget"`

### Task 2: Host `--numstat` counts + 10 s timeout

**Files:**
- Modify: `src/git-history.ts` (`getCommitDiff` ~:436; add `parseNumstatZ` near `parseNameStatusZ`)
- Modify: `src/protocol.ts` (`FileDiffDTO` ~:99)
- Modify: `electron/main.ts` (`case 'git:commitDiff'` ~:1736 — pass `timeoutMs: GIT_TIMEOUT.diff`)
- Test: `test/unit/git-numstat.test.ts` (new)

**Interfaces:**
- Produces:
  - `FileDiffDTO` gains `counts?: { added: number; removed: number };`
  - `export function parseNumstatZ(stdout: string): Map<string, { added: number; removed: number }>` in `src/git-history.ts` (exported for tests; key = the file's CURRENT rel path, matching `parseNameStatusZ`'s `rel`).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { parseNumstatZ } from '../../src/git-history';

const NUL = '\0';

describe('parseNumstatZ', () => {
  it('parses plain records', () => {
    const out = `12\t3\tsrc/a.ts${NUL}0\t7\tsrc/b.ts${NUL}`;
    const m = parseNumstatZ(out);
    expect(m.get('src/a.ts')).toEqual({ added: 12, removed: 3 });
    expect(m.get('src/b.ts')).toEqual({ added: 0, removed: 7 });
  });

  it('skips binary records (dash counts)', () => {
    const m = parseNumstatZ(`-\t-\tassets/logo.png${NUL}`);
    expect(m.has('assets/logo.png')).toBe(false);
  });

  it('keys a -z rename record by its NEW path', () => {
    // with -M and -z, a rename emits: added TAB removed TAB NUL old NUL new NUL
    const m = parseNumstatZ(`5\t2\t${NUL}old/name.ts${NUL}new/name.ts${NUL}`);
    expect(m.get('new/name.ts')).toEqual({ added: 5, removed: 2 });
    expect(m.has('old/name.ts')).toBe(false);
  });

  it('tolerates empty/garbage input', () => {
    expect(parseNumstatZ('').size).toBe(0);
    expect(parseNumstatZ('not-a-record').size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/unit/git-numstat.test.ts`. Expected: FAIL, `parseNumstatZ` not exported.

- [ ] **Step 3: Implement**

`parseNumstatZ` in `src/git-history.ts` (near `parseNameStatusZ` — read that function first and mirror its tokenizing discipline). The `-z` numstat stream is NUL-separated records; a rename's pathless first token ends with a trailing empty path field then old NUL new. Parse defensively: split on NUL, walk tokens; a token matching `/^(\d+|-)\t(\d+|-)\t(.*)$/` with a non-empty third field is a plain record; with an EMPTY third field it consumes the next two tokens as old/new and keys by new. `-` counts ⇒ skip the record.

In `getCommitDiff`, after the existing `nameStatus` call succeeds, add:

```ts
const numstat = await runGit(
  gitBin,
  ['diff-tree', '-M', '-r', '--no-commit-id', '--numstat', '-z', base, sha],
  cwd,
  timeoutMs,
);
const counts = numstat.ok ? parseNumstatZ(numstat.stdout) : new Map();
```

and in the `mapWithConcurrency` callback attach `...(counts.has(file.rel) ? { counts: counts.get(file.rel) } : {})` to the built DTO — do it in `getCommitDiff`'s callback (wrap `buildFileDiff`'s result), NOT inside `buildFileDiff` (which `getRangeDiff` shares and which has no numstat map — see the spec's out-of-scope note).

`src/protocol.ts`: add to `FileDiffDTO`:

```ts
  /** Host-computed per-file line counts (`diff-tree --numstat`); absent for binary/
   *  image records. Lets the renderer badge files without diffing them — see
   *  docs/specs/2026-08-20-commit-review-memory-bounds.md. */
  counts?: { added: number; removed: number };
```

`electron/main.ts` `case 'git:commitDiff'`: change the `getCommitDiff(cwd, m.sha, { log: ... })` call to also pass `timeoutMs: GIT_TIMEOUT.diff` (import already present at the top of the file).

- [ ] **Step 4: Run** — `npx vitest run test/unit/git-numstat.test.ts test/unit/git-history.test.ts` (again: locate the real existing git-history test filename via grep and include it). Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(git): per-file numstat counts on commit diffs; 10s diff timeout"` (add the three source files + test).

### Task 3: Renderer consumes counts + approx notice

**Files:**
- Modify: `webview/review-commit.ts` (`commitChangesFromFiles` ~:30)
- Modify: `webview/components/review-view.tsx` (ReviewFileCard body ~:1022-1032 — the notice branch chain)
- Modify: `webview/styles.css` only if a new notice class is needed (reuse `rcard__notice` / `rcard__notice--oversize` styling patterns; check what exists before adding anything)
- Test: `test/unit/review-commit.test.ts` (extend the existing file — locate via `grep -l commitChangesFromFiles test/unit`)

**Interfaces:**
- Consumes: `FileDiffDTO.counts` (Task 2), `FileReview.approx` (Task 1).

- [ ] **Step 1: Write the failing test**

```ts
it('prefers host counts over recomputing the diff', () => {
  const changes = commitChangesFromFiles([
    { path: 'big.lock', head: 'a\nb', work: 'c\nd', binary: false, counts: { added: 7, removed: 5 } },
  ]);
  expect(changes[0]).toMatchObject({ added: 7, removed: 5, kind: 'M' });
});

it('falls back to computing when counts are absent', () => {
  const changes = commitChangesFromFiles([
    { path: 'x.ts', head: 'a\nb\nc', work: 'a\nX\nc', binary: false },
  ]);
  expect(changes[0]).toMatchObject({ added: 1, removed: 1 });
});
```

- [ ] **Step 2: Run to verify the first fails** (`counts` ignored today; it will recompute 2/2 from the tiny texts — assert values that differ from the recompute, as above: 7/5 vs 2/2). `npx vitest run test/unit/review-commit.test.ts`.

- [ ] **Step 3: Implement**

`commitChangesFromFiles`: inside the map, before the compute branch:

```ts
if (f.counts) {
  return { path: f.path, added: f.counts.added, removed: f.counts.removed, kind: kindOf(f), staged: false };
}
```

(keep the existing compute as the fallback — it is now bounded by Task 1).

`review-view.tsx` ReviewFileCard: the `review` memo already produces `approx` (it's on `FileReview`). In the body branch chain (`diff?.image ? ... : diff?.oversize ? ... : diff?.binary ? ...`), the approx case must NOT replace the hunks — render the notice ABOVE the hunk list when `review?.approx`:

```tsx
{review?.approx && (
  <div className="rcard__notice rcard__notice--oversize">
    This file changed too much to line-match — showing it as a whole-file
    replacement.
  </div>
)}
```

placed at the top of the hunks-rendering branch (find where `review.hunks` is mapped and put the notice immediately before that list inside the same container).

- [ ] **Step 4: Run** — `npx vitest run test/unit/review-commit.test.ts`; then `npm run typecheck` (webview tsconfig must see the new DTO field). Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(review): host-count badges + approx-diff notice"`

### Task 4: Error channel for `useCommitFiles`

**Files:**
- Modify: `src/protocol.ts` (`git:commitDiffResult` member ~:266-273 — add `error?: string; requestId: number;`; the REQUEST message `git:commitDiff` in the webview→host union — find it via grep — gains `requestId: number;`)
- Modify: `src/git-history.ts` (`MultiFileDiff` ~:48 gains `error?: string`; `getCommitDiff` failure paths return it)
- Modify: `electron/main.ts` (`case 'git:commitDiff'` ~:1736: session-miss now REPLIES with `error`; echo `requestId`)
- Modify: `webview/use-commit-files.ts` (mirror `webview/use-range-files.ts` exactly: `status: 'error'`, `latestReq`, `retryCommitDiff`)
- Modify: `webview/components/review-view.tsx` (~:640-671: extend the existing error EmptyState + Retry to commit mode)
- Test: extend `test/unit/` coverage for the loader if a test exists for use-range-files' reducer logic (grep first; if the sibling has none, add none — parity, not gold-plating). Add `getCommitDiff` error-path assertions to the existing git-history unit test.

**Interfaces:**
- Produces: `export function retryCommitDiff(sessionId: string, sha: string, root?: string): void` in `webview/use-commit-files.ts`; `CommitFilesStatus = 'loading' | 'ready' | 'error'`; `CommitFiles.error?: string`.

- [ ] **Step 1: Write failing test for the host side** (in the git-history unit test file):

```ts
it('reports an error (not an empty commit) when diff-tree fails', async () => {
  // drive getCommitDiff with a nonexistent cwd or an opts.gitBin pointing at a
  // missing binary is the notFound latch — instead use a real temp dir that is
  // NOT a git repo: rev-parse/diff-tree fail, and the result must carry error.
  const r = await getCommitDiff(tmpNonRepoDir, 'deadbeef'.repeat(5));
  expect(r.files).toEqual([]);
  expect(r.error).toBeTruthy();
});
```

(Follow the existing test file's temp-dir fixture pattern; `__resetHistoryGitAvailableForTest` exists for the latch.)

- [ ] **Step 2: Run to verify it fails** — today `error` is undefined on that path.

- [ ] **Step 3: Implement host side**

`getCommitDiff`: the `!gitAvailable || !cwd || !sha` early return stays `{ files: [] }` (caller misuse, not a repo failure). The `rev-parse` hard-fail (not `notFound`, not ok, AND `parents` empty because the sha didn't resolve) is ambiguous — leave it. The two clear failure paths get errors: `notFound` → `{ files: [], error: 'git not found' }`; `!nameStatus.ok` → `{ files: [], error: 'git diff-tree failed or timed out' }`.

`electron/main.ts`:

```ts
case 'git:commitDiff': {
  const session = mgr.get(m.sessionId);
  if (!session) {
    replyHere({ type: 'git:commitDiffResult', sessionId: m.sessionId, sha: m.sha,
      files: [], error: 'session not found', requestId: m.requestId,
      ...(m.root ? { root: m.root } : {}) });
    break;
  }
  // ... existing body; add requestId + error to the success reply:
  replyHere({ ..., requestId: m.requestId, ...(error ? { error } : {}) });
```

- [ ] **Step 4: Implement the loader + UI**

Rewrite `webview/use-commit-files.ts` to the `use-range-files.ts` shape (read both files side by side; keep the commit key `${sessionId}\0${sha}\0${root ?? ''}` and the doc comment's intent, add `latestReq`/`reqCounter`, `error` mapping, and `retryCommitDiff`). In `review-view.tsx`, find the existing `preloadError` / error EmptyState used by range mode (~:630-650) and extend its condition + Retry `onClick` to commit mode (`retryCommitDiff(sessionId, source.sha, root)` — check how `root` reaches the component; `useCommitFiles` is called at ~:169 with the values you need, reuse those).

- [ ] **Step 5: Run** — `npx vitest run` (full unit suite — protocol change ripples; fix any type fallout honestly, no casts). `npm run typecheck`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -m "fix(review): error channel for commit diffs — no more eternal loading"`

### Task 5: E2E runtime proof + full verify

**Files:**
- Create: `test/e2e/commit-review-bounds.e2e.mjs`
- Modify: `docs/specs/INDEX.md` (add the row for the spec), `CHANGELOG.md` (`## [Unreleased]` → Fixed entry: huge commits no longer freeze/crash the app when opened in Review)

**Interfaces:** consumes everything above through the real app.

- [ ] **Step 1: Write the scenario** — base it on `test/e2e/terminal-commit-link.e2e.mjs` (the click path) and `review-commit-source.e2e.mjs` (commit review assertions); reuse their temp-repo seeding helpers. Seed a temp git repo with two commits:
  - commit 1: `gen.txt` = 15000 numbered lines; `other.ts` small.
  - commit 2: edit 3 mid-file lines of `gen.txt` AND fully replace `blob.txt` (8000 lines `a-i` → 8000 lines `b-i`), plus a 2-line edit in `other.ts`.
  Open a session in that repo, `echo` commit 2's sha so it linkifies, click it, and assert within a 20 s budget: the Review tab reaches ready (not loading), the renderer is alive (`page.evaluate(() => 1)` works), the `gen.txt` card shows an EXACT small diff (its badge from numstat: `+3 −3`), the `blob.txt` card shows the approx notice, and scrolling the list stays responsive. Then kill the loading-error leg: request a commit review for a bogus-but-hex sha via the picker or a direct `post` — assert the error EmptyState with Retry appears rather than eternal loading (drive it however the existing review e2es drive the picker; if only reachable via internal post, use `page.evaluate` with `window.agentDeck`).
- [ ] **Step 2: Red proof** — `git stash push src/review-hunks.ts webview/review-commit.ts` (the two renderer bounds), rebuild, run the scenario: expect the 20 s responsiveness/ready assertion to FAIL (the 8000×8000 core ≈ 64M-cell ≈ 512MB alloc + quadratic fill makes the tab hang far past budget — deliberately sized to prove the hang WITHOUT OOM-killing the host machine). Unstash, rebuild, rerun green. Capture both outputs.
- [ ] **Step 3: Serial regression** — run, one at a time: `review-commit-source`, `review-virtualize`, `review-compare`, `terminal-commit-link`, `word-diff`. Any failure: re-run ALONE before believing it.
- [ ] **Step 4: Full gate** — `npm run verify` in the worktree, complete unfiltered output captured to evidence; check the tail yourself.
- [ ] **Step 5: Commit** — `git commit -m "test(review): e2e memory-bounds proof for huge commit reviews"` (scenario + INDEX row + CHANGELOG).

## Self-review notes (already applied)

- Spec §1 trim/budget → Task 1; §2 approx surfacing + emphasis guard → Tasks 1+3; §3 numstat → Tasks 2+3; §4 error channel → Task 4; §5 timeout → Task 2. No gaps.
- Type names cross-checked: `FileReview.approx`, `FileDiffDTO.counts`, `MAX_LCS_CELLS`, `EMPHASIS_MAX_LINES`, `retryCommitDiff` used consistently.
- Line numbers are anchors, not gospel — re-locate by symbol before editing.

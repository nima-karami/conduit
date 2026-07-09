# Git Host Resource Discipline (Robustness Phase 1) — Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task
> ends green (`npm run verify`) and is committed. Spec: `docs/specs/2026-07-07-git-host-robustness.md`.

**Goal:** Make every git surface bounded, cancellable, and payload-capped so it can never hang the
host or freeze on a big file/changeset.

**Architecture:** One runner (`src/git-exec.ts`) wraps `child_process.execFile` with a timeout, a
`maxBuffer`, and an `AbortSignal`, returning a typed `GitResult` (never throws). The five existing
git runners migrate onto it. Read paths gain a 2 MB per-file cap (typed `oversize` marker instead of
shipping the file); the multi-file diff loops gain bounded concurrency + a file-count cap. A small
renderer placeholder shows oversize/truncated outcomes.

**Tech Stack:** TypeScript, Node `child_process`/`fs`, Electron host, React renderer, Vitest,
the stress lane (`test/e2e/stress/`).

## Global Constraints

- `npm run verify` must stay green (biome + 2 tsconfigs + build + vitest + fallow + audit + security).
- No new npm dependency (fallow gates unlisted deps; Playwright stays path-resolved in the stress lane).
- Preserve git security discipline exactly: arg arrays only (never a shell string), keep every `--`
  separator and containment check as-is. This is a resource change, not a surface change.
- Per-file text cap = `MAX_BYTES` = `2 * 1024 * 1024` (reuse `src/file-service.ts`'s value/semantics).
- No redundant comments (CLAUDE.md): comments explain *why* only.
- The stress lane is NOT added to `verify` (Windows-only, GUI); it runs via `npm run test:stress`.

---

## File Structure

- **Create** `src/git-exec.ts` — the one bounded/cancellable runner + shared timeout tiers + the
  bounded-concurrency helper. One responsibility: run git safely with resource limits.
- **Create** `test/unit/git-exec.test.ts` — runner unit tests (deterministic, using `node` as a fake
  slow/large "binary", no real-git dependency).
- **Modify** the five runners to call `git-exec`: `src/git-info.ts`, `src/git-history.ts`,
  `src/git-actions.ts`, `src/project-info.ts`, and the `electron/main.ts` helpers (`git`,
  `gitShowBuffer`, `ignoredEntries`, `gitBatchCheck`, `refExists`).
- **Modify** `src/protocol.ts` — add `oversize?` to `FileDiffDTO`; add a `truncated?` field to the
  commit/range diff result path (new small result wrapper).
- **Modify** `src/file-service.ts` (`readDiff` cap) and `src/project-info.ts` (`gitChanges` async +
  streamed line count).
- **Modify** `src/git-history.ts` (`getCommitDiff`, `getRangeDiff`) — concurrency + count cap + per-file cap.
- **Modify** renderer: `webview/components/diff-viewer.tsx` (oversize placeholder + Open file) and the
  review/commit surfaces for the "N of M files" banner.
- **Create** `test/e2e/stress/git-changes-huge.stress.mjs`, `git-commit-huge.stress.mjs`,
  `git-diff-huge.stress.mjs`, `git-wedged.stress.mjs`.

---

## Task 1: `src/git-exec.ts` — the bounded, cancellable runner

**Files:**
- Create: `src/git-exec.ts`
- Test: `test/unit/git-exec.test.ts`

**Interfaces produced:**
```ts
export const GIT_TIMEOUT = { metadata: 2000, diff: 10000, history: 5000, blame: 10000 } as const;
export interface GitResult {
  ok: boolean;            // true iff the process exited 0 within limits
  stdout: string;         // utf8; '' unless ok
  stdoutBuffer: Buffer;   // raw bytes (empty Buffer unless ok); for blob reads
  code: number | null;    // exit code; null if killed
  notFound: boolean;      // ENOENT — git missing from PATH
  timedOut: boolean;      // killed by our timeout
  aborted: boolean;       // killed by the caller's AbortSignal
  truncated: boolean;     // hit maxBuffer
}
export interface GitOpts { cwd: string; timeoutMs?: number; maxBuffer?: number; signal?: AbortSignal; stdin?: string; }
export function runGit(args: string[], opts: GitOpts): Promise<GitResult>;
export function runGitBin(gitBin: string, args: string[], opts: GitOpts): Promise<GitResult>;
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>;
```

- [ ] **Step 1: Write the failing tests** (`test/unit/git-exec.test.ts`). Use `node` as a fake binary
  via `runGitBin(process.execPath, ['-e', script], …)` so tests are deterministic and need no git.

```ts
import { describe, expect, it } from 'vitest';
import { GIT_TIMEOUT, mapWithConcurrency, runGitBin } from '../../src/git-exec';

const node = process.execPath;
const cwd = process.cwd();

describe('runGit (via node as a fake binary)', () => {
  it('returns ok + stdout on a clean exit', async () => {
    const r = await runGitBin(node, ['-e', 'process.stdout.write("hello")'], { cwd });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('hello');
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('flags a nonzero exit without throwing', async () => {
    const r = await runGitBin(node, ['-e', 'process.exit(3)'], { cwd });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.notFound).toBe(false);
  });

  it('times out and flags timedOut on a hang', async () => {
    const r = await runGitBin(node, ['-e', 'setTimeout(()=>{}, 60000)'], { cwd, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  });

  it('aborts and flags aborted when the signal fires', async () => {
    const ac = new AbortController();
    const p = runGitBin(node, ['-e', 'setTimeout(()=>{}, 60000)'], { cwd, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.aborted).toBe(true);
  });

  it('flags truncated when output exceeds maxBuffer', async () => {
    const r = await runGitBin(node, ['-e', 'process.stdout.write("x".repeat(5000))'], {
      cwd,
      maxBuffer: 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
  });

  it('flags notFound for a missing binary', async () => {
    const r = await runGitBin('definitely-not-a-real-binary-xyz', ['--version'], { cwd });
    expect(r.notFound).toBe(true);
  });

  it('feeds stdin when provided', async () => {
    const script = 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d.toUpperCase()))';
    const r = await runGitBin(node, ['-e', script], { cwd, stdin: 'abc' });
    expect(r.stdout).toBe('ABC');
  });

  it('exposes timeout tiers', () => {
    expect(GIT_TIMEOUT.metadata).toBeLessThan(GIT_TIMEOUT.diff);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and caps in-flight count', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fn = async (n: number) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--; return n * 2;
    };
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, fn);
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('returns [] for an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/git-exec.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/git-exec.ts`.**

```ts
// One bounded, cancellable git runner. Every git spawn in the app routes through here so timeouts,
// output caps, and cancellation are uniform (see docs/specs/2026-07-07-git-host-robustness.md).
import { execFile } from 'node:child_process';

export const GIT_TIMEOUT = { metadata: 2000, diff: 10000, history: 5000, blame: 10000 } as const;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export interface GitResult {
  ok: boolean;
  stdout: string;
  stdoutBuffer: Buffer;
  code: number | null;
  notFound: boolean;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

export interface GitOpts {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  stdin?: string;
}

const EMPTY = Buffer.alloc(0);

export function runGitBin(gitBin: string, args: string[], opts: GitOpts): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      gitBin,
      args,
      {
        cwd: opts.cwd,
        windowsHide: true,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: opts.timeoutMs ?? 0, // 0 = no execFile timeout; our killer handles it below when set
        encoding: 'buffer',
        signal: opts.signal,
      },
      (err, stdout) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const buf = Buffer.isBuffer(stdout) ? stdout : EMPTY;
        if (!e) {
          resolve({
            ok: true, stdout: buf.toString('utf8'), stdoutBuffer: buf, code: 0,
            notFound: false, timedOut: false, aborted: false, truncated: false,
          });
          return;
        }
        const notFound = e.code === 'ENOENT';
        const truncated = e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(e.message ?? '');
        const timedOut = e.killed === true && e.signal === 'SIGTERM' && (opts.timeoutMs ?? 0) > 0 && opts.signal?.aborted !== true;
        const aborted = opts.signal?.aborted === true;
        resolve({
          ok: false, stdout: '', stdoutBuffer: EMPTY,
          code: typeof e.code === 'number' ? e.code : null,
          notFound, timedOut, aborted, truncated,
        });
      },
    );
    if (opts.stdin != null) child.stdin?.end(opts.stdin);
  });
}

export function runGit(args: string[], opts: GitOpts): Promise<GitResult> {
  return runGitBin('git', args, opts);
}

// Run `fn` over `items` with at most `limit` in flight, preserving input order in the result.
export async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
```

> Note during execution: `execFile`'s own `timeout` sends SIGTERM and sets `err.killed`. Verify the
> flag derivation against the actual `err` shape when the test runs; adjust the `timedOut`/`truncated`
> discrimination to whatever Node reports on this version (the tests are the source of truth — make
> them pass without weakening them).

- [ ] **Step 4: Run to verify pass** — `npx vitest run test/unit/git-exec.test.ts` → PASS (10 tests).
- [ ] **Step 5: Commit** — `git add src/git-exec.ts test/unit/git-exec.test.ts && git commit -m "feat(git): bounded + cancellable git runner (git-exec)"`.

---

## Task 2: Migrate the five runners onto `git-exec`

Mechanical, one file per step. Each caller keeps its own result *adapter* (its existing return shape)
but delegates the spawn to `runGit`/`runGitBin`. **After each file, run that module's existing tests
and `npm run typecheck`; behavior must be unchanged except for the new bounds.**

**Interfaces consumed:** `runGit`, `runGitBin`, `GIT_TIMEOUT`, `GitResult` from Task 1.

- [ ] **Step 1: `src/git-history.ts`.** Replace the local `runGit`/`runGitBuffer` (lines ~72-117) with
  thin adapters over `git-exec` that preserve `RunResult`/`RunBufferResult`:

```ts
import { runGit as execGit, type GitResult } from './git-exec';

function runGit(gitBin: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return runGitBin(gitBin, args, cwd, timeoutMs).then((r) =>
    r.ok ? { ok: true as const, stdout: r.stdout } : { ok: false as const, notFound: r.notFound },
  );
}
function runGitBuffer(gitBin: string, args: string[], cwd: string, timeoutMs: number): Promise<RunBufferResult> {
  return runGitBin(gitBin, args, cwd, timeoutMs).then((r) =>
    r.ok ? { ok: true as const, stdout: r.stdoutBuffer } : { ok: false as const, notFound: r.notFound },
  );
}
// where:
import { runGitBin as _runGitBin } from './git-exec';
const runGitBin = (bin: string, args: string[], cwd: string, timeoutMs: number) =>
  _runGitBin(bin, args, { cwd, timeoutMs, maxBuffer: MAX_BUFFER });
```

  Run: `npx vitest run test/unit/git-history.test.ts` → PASS (32). Commit.

- [ ] **Step 2: `src/git-info.ts`.** Replace its `runGit` (lines ~46-68) with the same adapter over
  `_runGitBin` (keep its `RunResult`, `MAX_BUFFER`, and the 1500ms default the caller passes). Run any
  git-info unit test + typecheck. Commit.

- [ ] **Step 3: `src/project-info.ts` `run`** (lines ~10-16). Replace with:

```ts
import { runGit } from './git-exec';
function run(_cmd: string, args: string[], cwd: string): Promise<string> {
  return runGit(args, { cwd, timeoutMs: GIT_TIMEOUT.diff, maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout);
}
```
  (All `run('git', …)` callers keep working; a timeout now yields `''` like any other failure.)
  Run: `npx vitest run test/unit/*project* ` (if any) + typecheck. Commit.

- [ ] **Step 4: `src/git-actions.ts` `gitExec`** (lines ~140-152). Route through `runGit` with
  `GIT_TIMEOUT.metadata` (actions are quick porcelain ops) preserving its current return contract.
  Run git-actions tests + typecheck. Commit.

- [ ] **Step 5: `electron/main.ts` helpers.** Replace `git` (260-266), `gitShowBuffer` (453-473),
  `ignoredEntries` (426-437 — pass `stdin`), `gitBatchCheck` (340-350 — pass `stdin`), `refExists`
  (386-394) to call `runGit`/`runGitBin` with the appropriate `GIT_TIMEOUT` tier and their existing
  `maxBuffer`. Keep `gitShow` (439-445) delegating to the new `git`. Run `npm run test:smoke branch-switch git-blame git-history` (a few git smokes) + `npm run typecheck`. Commit.

- [ ] **Step 6: Full `npm run verify`** → green. Commit if anything was fixed.

---

## Task 3: Per-file text cap on `readDiff` (working-tree diff)

**Files:** Modify `src/protocol.ts`, `src/file-service.ts`; Test: `test/unit/file-service-diff.test.ts` (create).

**Interfaces produced:** `FileDiffDTO.oversize?: { bytes: number }`.

- [ ] **Step 1: Failing test.**

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDiff } from '../../src/file-service';

describe('readDiff oversize cap', () => {
  it('marks a >2MB working file oversize instead of shipping it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rd-'));
    const p = join(dir, 'big.txt');
    writeFileSync(p, 'x'.repeat(2 * 1024 * 1024 + 10));
    const dto = await readDiff(p, async () => '', async () => null);
    expect(dto.oversize?.bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(dto.work).toBe('');
    expect(dto.head).toBe('');
  });
});
```

- [ ] **Step 2: Verify fail** — `npx vitest run test/unit/file-service-diff.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In `src/protocol.ts` add to `FileDiffDTO`:
  `oversize?: { bytes: number };` (with a one-line comment: over the 2 MB text cap; renderer shows a
  placeholder, never the content). In `src/file-service.ts` `readDiff`, before reading text, stat the
  working file; if `size > MAX_BYTES`, return `{ path: absPath, head: '', work: '', binary: false, oversize: { bytes: size } }`.
  Also guard the head side: if `gitShow` returns text longer than `MAX_BYTES`, treat as oversize.

```ts
// inside readDiff, text branch (replaces the current fs.readFile of the whole file):
try {
  const stat = await fs.promises.stat(absPath);
  if (stat.size > MAX_BYTES) return { path: absPath, head: '', work: '', binary: false, oversize: { bytes: stat.size } };
} catch { /* deleted in working tree ⇒ fall through, head-only */ }
```

- [ ] **Step 4: Verify pass** + `npm run typecheck`. → PASS.
- [ ] **Step 5: Commit** — `feat(git): 2MB oversize cap on working-tree diff`.

---

## Task 4: `gitChanges` async + streamed line count (kill the readFileSync freeze)

**Files:** Modify `src/project-info.ts`; Test: `test/unit/git-changes-count.test.ts` (create).

**Interfaces produced:** `countLinesOfFile(abs: string, capBytes: number): Promise<{ lines: number; oversize: boolean }>` (exported for test).

- [ ] **Step 1: Failing test** — a small file counts its lines; a >cap file resolves `oversize:true`
  without loading it whole; a binary (NUL) file → `lines: 0`.

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countLinesOfFile } from '../../src/project-info';

const MB = 1024 * 1024;
describe('countLinesOfFile', () => {
  it('counts newlines in a small file', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'cl-')), 'a.txt');
    writeFileSync(p, 'a\nb\nc\n');
    expect(await countLinesOfFile(p, 2 * MB)).toEqual({ lines: 3, oversize: false });
  });
  it('flags oversize past the cap without erroring', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'cl-')), 'big.txt');
    writeFileSync(p, `${'x'.repeat(2 * MB + 5)}\n`);
    const r = await countLinesOfFile(p, 2 * MB);
    expect(r.oversize).toBe(true);
  });
  it('treats NUL-containing (binary) files as 0 lines', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'cl-')), 'bin');
    writeFileSync(p, Buffer.from([1, 0, 2, 0, 3]));
    expect((await countLinesOfFile(p, 2 * MB)).lines).toBe(0);
  });
});
```

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement `countLinesOfFile`** (streamed, bounded memory, async — never blocks the
  event loop), then replace the `readFileSync` loop in `gitChanges` (lines 137-151) to `await` it with
  bounded concurrency via `mapWithConcurrency(…, 8, …)`. Line counts feed `resolveLineCounts` as
  before; oversize files contribute their counted lines up to the cap (or 0 if the head/added path
  can't be counted). Use `fs.createReadStream`, count `0x0a`, short-circuit binary on a NUL in the
  first chunk, stop counting once `capBytes` is exceeded but drain to EOF (set `oversize`).

- [ ] **Step 4: Verify pass** — vitest + `npm run typecheck`.
- [ ] **Step 5: Commit** — `perf(git): async + streamed gitChanges (no readFileSync host freeze)`.

---

## Task 5: Multi-file diff caps — commit-diff & compare-refs

**Files:** Modify `src/git-history.ts` (`getCommitDiff`, `getRangeDiff`), `src/protocol.ts`; Test: extend `test/unit/git-history.test.ts`.

**Interfaces produced:** both diff functions return `{ files: FileDiffDTO[]; truncated?: { shown: number; total: number } }` (was `FileDiffDTO[]`). Add `MAX_DIFF_FILES = 1000`, per-file oversize via the 2 MB cap on each blob buffer.

- [ ] **Step 1: Failing test** — a synthetic commit touching >MAX_DIFF_FILES files returns
  `truncated.total > shown` and `files.length === MAX_DIFF_FILES`; a committed 3 MB file yields a
  `FileDiffDTO` with `oversize` set and empty `head`/`work`. (Build the repo with `execFileSync('git', …)`
  in a tmpdir, as `git-history.test.ts` already does.)

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement.** In both functions: cap `changed` to `MAX_DIFF_FILES` (record `total`),
  replace the sequential `for` loop with `mapWithConcurrency(cappedChanged, 8, buildOneFileDiff)`, and
  inside `buildOneFileDiff` check each blob buffer's `.length > MAX_BYTES` → emit
  `{ path, head: '', work: '', binary: false, oversize: { bytes } }`. Return `{ files, truncated }`.
  Update `getCommitDiff`/`getRangeDiff` callers in `electron/main.ts` (the `git:commitDiff` /
  `git:rangeDiff` handlers) to forward `{ files, truncated }`; update the DTOs
  (`CommitDiffResult`/`RangeDiffResult` or equivalent) in `src/protocol.ts`, and the renderer hooks
  `webview/use-commit-files.ts` / `webview/use-range-files.ts` to read `.files` (+ stash `truncated`).

- [ ] **Step 4: Verify pass** — `npx vitest run test/unit/git-history.test.ts` + `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(git): bound commit/range diff (concurrency + file-count cap + per-file oversize)`.

---

## Task 6: Renderer — oversize placeholder + truncation banner

**Files:** Modify `webview/components/diff-viewer.tsx` (oversize placeholder), the review/commit views
for the "Showing N of M files" banner.

- [ ] **Step 1:** In `diff-viewer.tsx`, when `doc.oversize` is set, render a placeholder instead of the
  Monaco diff: text "This file is too large to diff (N MB)" + an **Open file** button that routes to
  the existing file open (opens the capped 2 MB viewer) via the same handler the surface already uses
  to open a file. Match existing empty/placeholder styling in the file (reuse a `.diff-…` class; add
  one minimal class in `webview/styles.css` if none fits).
- [ ] **Step 2:** Where a commit/range result carries `truncated`, show a one-line banner above the
  file list: "Showing {shown} of {total} files — the rest were omitted to stay responsive." (Reuse the
  review header/sub styling.)
- [ ] **Step 3:** `npm run build` + a quick manual sanity via an existing review smoke
  (`npm run test:smoke review-navigator`) → still green. Commit — `feat(git): oversize/truncation UI in diff + review`.

---

## Task 7: Stress scenarios + final verify

**Files:** Create `test/e2e/stress/git-changes-huge.stress.mjs`, `git-commit-huge.stress.mjs`,
`git-diff-huge.stress.mjs`, `git-wedged.stress.mjs`. Reuse `harness-stress.mjs`
(`runStress`, `openSession`, `startPerf`/`stopPerf`, `emitReport`, `assertInvariant`,
`waitForShellReady`) and the `review-virtualize.e2e.mjs` git-repo corpus pattern (`execFileSync('git', …)`
in a `mkdtempSync` repo).

- [ ] **Step 1: `git-changes-huge`** — make a repo, write a >2 MB untracked file, open the session,
  open Review "Changes". `startPerf`; wait for the change list; `stopPerf`. Invariant: host responsive
  (`report.lag.maxMs` under a generous bound, e.g. < 4000 ms) AND the big file is present in the change
  list. Advisory: block/load ms. (Proves the readFileSync freeze is gone.)
- [ ] **Step 2: `git-commit-huge`** — commit ~2000 small files, open that commit's diff (via the commit
  picker / terminal-commit-link path or `git:commitDiff` through the review surface). Invariant: the
  result returns within the scenario timeout with `truncated` set (file-count cap) OR files.length
  bounded; no forever-spinner. Advisory: load ms.
- [ ] **Step 3: `git-diff-huge`** — commit a 100k-line file, modify it, open its working diff.
  Invariant: the diff surface shows either a capped diff or the oversize placeholder (assert one
  is present), host responsive. Advisory: open ms.
- [ ] **Step 4: `git-wedged`** — put a stub `git` earlier on PATH that sleeps forever (a tiny
  `.cmd`/script written to a tmp dir prepended to `PATH` for the launched app via `launchApp`
  `extraArgs`/env — extend `launchApp` to accept an `env` override), trigger a git surface, and assert
  it **degrades within the timeout** (no forever-hang): the runner's timeout fires and the surface
  shows its (host-empty) result rather than pinning. Invariant: the operation completes/returns within
  ~2× the diff timeout. (Proves timeout + no-hang end to end.)
- [ ] **Step 5:** Run each: `node test/e2e/stress/run-stress.mjs git-` → all pass. Then full
  `npm run test:stress` (kill orphaned electrons first). Update `docs/runs/2026-07-07-stress-load/`
  with the new numbers if desired.
- [ ] **Step 6: Final `npm run verify`** green. Commit — `test(stress): git hang/perf scenarios`.

---

## Self-review (done)

- **Spec coverage:** runner (T1+T2), per-file cap (T3), gitChanges async (T4), multi-file caps (T5),
  oversize UI (T6), stress scenarios git-changes/commit/diff/wedged (T7) — all mapped.
- **Types:** `GitResult`/`GitOpts`/`runGit`/`runGitBin`/`mapWithConcurrency` (T1) are consumed with the
  same names in T2/T5; `FileDiffDTO.oversize` (T3) reused in T5/T6; `{ files, truncated }` (T5) consumed
  by T6.
- **Open detail for execution:** the exact `timedOut`/`truncated` discrimination in `git-exec` depends
  on the Node/Electron `execFile` error shape — the Task 1 tests pin the behavior; make them pass
  without weakening. `git-wedged` needs a small `launchApp({ env })` addition (note in T7 Step 4).

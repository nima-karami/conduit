# Multi-repo Awareness (active-repo picker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a session is opened at a parent folder containing several git repos, give each git surface (branch indicator, history, Changes, branch switch) a dedicated **repo picker** that scopes them to one **active repo** — auto-following context (terminal `cd`, file focus, explorer click) with manual **pin-until-unpinned**, while the Files explorer keeps browsing the whole tree.

**Architecture:** Two new **pure** host modules — `src/repo-scan.ts` (bounded recursive `.git` detection) and `src/active-repo.ts` (path→repo longest-prefix match + pinned/auto/fallback precedence). The active-repo state lives on the `Session` object (runtime-only, like `git`/`cwd`) and is derived centrally in `SessionManager`; it rides the existing `state` broadcast. The host re-keys every git surface from `activeCwd(session)` to the session's active repo root; the renderer adds a `RepoPicker` beside `GitIndicatorBar` and feeds auto-follow triggers via a new `repo:context` message.

**Tech Stack:** TypeScript, Electron (host `electron/main.ts` + `src/*`), React webview (`webview/*`), vitest (unit), the `test/e2e` Playwright-on-real-app harness. Biome for format/lint.

## Global Constraints

- Spec: `docs/specs/2026-06-25-multi-repo-awareness.md` (FULL). Link decisions there; do not restate rationale in code comments.
- All host state lives in the Electron main process; the renderer holds no source of truth (CLAUDE.md). The renderer↔host global is `window.agentDeck`.
- Git is spawned host-side only, ALWAYS via `execFile('git', [argArray])` (never a shell string), bounded by a timeout, non-throwing, gated by the module `gitAvailable` latch (mirror `src/git-info.ts` / `src/git-history.ts`).
- Pure modules (`repo-scan`, `active-repo`) take no renderer imports and are unit-tested; host/IPC/PTY-boundary behavior is verified by a real-app `test/e2e` scenario, NOT the mock preview (mock has no `window.agentDeck`).
- No redundant comments — explain WHY only; never restate the code or the spec.
- Use existing `$variable` design tokens for any CSS; no raw hex.
- Scan depth constant = **4**; result cap = **200**; skip-list = `node_modules`, `.git`, `dist`, `out`, `.next`, `.vscode-test`.
- Gate: `npm run verify` must be green before "done". Inner-loop a single e2e via `node test/e2e/run-smoke.mjs <filter>`.
- Branch: `multi-repo` (already created off `main`; the design spec commit `15d824e` is already on it).
- Commit message trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: `src/repo-scan.ts` — bounded sub-repo detection

**Files:**
- Create: `src/repo-scan.ts`
- Test: `test/repo-scan.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module). `RepoInfo` is defined here and re-exported from `src/protocol.ts` in Task 3 — define it here first.
- Produces:
  - `export interface RepoInfo { root: string; name: string }` (`root` = absolute repo path with forward slashes; `name` = `root` relative to the opened root, or `'.'` when the opened root is itself the repo).
  - `export function detectRepos(openedRoot: string, opts?: { maxDepth?: number; cap?: number }): Promise<RepoInfo[]>`
  - `export const MAX_REPO_SCAN_DEPTH = 4;`
  - `export const REPO_SCAN_CAP = 200;`

- [ ] **Step 1: Write the failing test**

```ts
// test/repo-scan.test.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectRepos } from '../src/repo-scan';

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'reposcan-'));
  tmps.push(d);
  return d;
}
function gitInit(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
}
afterAll(() => {
  // best-effort; OS temp is cleaned anyway
});

describe('detectRepos', () => {
  it('finds direct-child repos and names them relative to the opened root', async () => {
    const root = tmp();
    gitInit(join(root, 'repo-a'));
    gitInit(join(root, 'repo-b'));
    const repos = await detectRepos(root);
    expect(repos.map((r) => r.name).sort()).toEqual(['repo-a', 'repo-b']);
    expect(repos.every((r) => r.root.replace(/\\/g, '/').endsWith(r.name))).toBe(true);
  });

  it('includes the opened root itself when it is a repo, named "."', async () => {
    const root = tmp();
    gitInit(root);
    const repos = await detectRepos(root);
    expect(repos.map((r) => r.name)).toContain('.');
  });

  it('finds nested repos within the depth bound but not beyond it', async () => {
    const root = tmp();
    gitInit(join(root, 'group', 'repo-c')); // depth 2 — within 4
    gitInit(join(root, 'a', 'b', 'c', 'd', 'e', 'deep')); // depth 6 — beyond 4
    const repos = await detectRepos(root);
    const names = repos.map((r) => r.name.replace(/\\/g, '/'));
    expect(names).toContain('group/repo-c');
    expect(names.some((n) => n.endsWith('deep'))).toBe(false);
  });

  it('does not descend into a repo once found (no repos-inside-repos)', async () => {
    const root = tmp();
    gitInit(join(root, 'repo-a'));
    gitInit(join(root, 'repo-a', 'nested')); // should NOT be reported separately
    const repos = await detectRepos(root);
    const names = repos.map((r) => r.name.replace(/\\/g, '/'));
    expect(names).toContain('repo-a');
    expect(names).not.toContain('repo-a/nested');
  });

  it('skips node_modules and treats a .git FILE (submodule/worktree) as a repo', async () => {
    const root = tmp();
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
    const sub = join(root, 'submod');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), 'gitdir: /elsewhere/.git/modules/submod');
    const repos = await detectRepos(root);
    const names = repos.map((r) => r.name.replace(/\\/g, '/'));
    expect(names).toContain('submod');
    expect(names.some((n) => n.startsWith('node_modules'))).toBe(false);
  });

  it('returns [] for a non-existent root and never throws on a symlink cycle', async () => {
    expect(await detectRepos(join(tmpdir(), 'does-not-exist-xyz'))).toEqual([]);
    const root = tmp();
    gitInit(join(root, 'repo-a'));
    try {
      symlinkSync(root, join(root, 'loop'), 'dir'); // self-referential dir symlink
    } catch {
      return; // symlink may be unavailable (Windows w/o privilege) — cycle case skipped
    }
    const repos = await detectRepos(root);
    expect(repos.map((r) => r.name)).toContain('repo-a'); // terminated, no hang
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/repo-scan.test.ts`
Expected: FAIL — `detectRepos` is not exported / module missing.

- [ ] **Step 3: Write the implementation**

```ts
// src/repo-scan.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RepoInfo {
  /** Absolute repo root, forward-slashed. */
  root: string;
  /** Repo root relative to the opened root ('.' when the opened root IS the repo). */
  name: string;
}

export const MAX_REPO_SCAN_DEPTH = 4;
export const REPO_SCAN_CAP = 200;

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', '.vscode-test']);

const slash = (p: string): string => p.replace(/\\/g, '/');

/** A `.git` dir OR file marks a repo (the file form covers submodules / linked worktrees). */
function isRepoRoot(dir: string): boolean {
  const marker = path.join(dir, '.git');
  try {
    fs.statSync(marker); // dir or file — either is a repo marker
    return true;
  } catch {
    return false;
  }
}

/**
 * Bounded recursive scan under `openedRoot` for git repos. Stops descending once a repo is
 * found (a repo's own subtree is not re-scanned). Skips heavy/uninteresting dirs, guards
 * symlink cycles by tracking visited real paths, caps the result, and never throws.
 */
export async function detectRepos(
  openedRoot: string,
  opts: { maxDepth?: number; cap?: number } = {},
): Promise<RepoInfo[]> {
  const maxDepth = opts.maxDepth ?? MAX_REPO_SCAN_DEPTH;
  const cap = opts.cap ?? REPO_SCAN_CAP;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(openedRoot);
  } catch {
    return [];
  }

  const out: RepoInfo[] = [];
  const seen = new Set<string>();

  const nameFor = (repoRoot: string): string => {
    const rel = slash(path.relative(openedRoot, repoRoot));
    return rel === '' ? '.' : rel;
  };

  const walk = (dir: string, depth: number) => {
    if (out.length >= cap) return;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return; // symlink-cycle guard
    seen.add(real);

    if (isRepoRoot(dir)) {
      out.push({ root: slash(path.resolve(dir)), name: nameFor(path.resolve(dir)) });
      return; // do not descend into a found repo
    }
    if (depth >= maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  // The opened root counts as depth 0 and may itself be a repo.
  walk(openedRoot, 0);
  return out;
}
```

> NOTE on the opened-root case: `walk(openedRoot, 0)` checks `isRepoRoot(openedRoot)` first; if the root is a repo it returns just `[{ name: '.' }]` and never scans children. That matches the spec (a single-repo project shows no picker). If you also want nested repos *alongside* a root repo, that is explicitly out of scope (§11) — keep this behavior.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/repo-scan.test.ts`
Expected: PASS (the symlink case may early-return on Windows without symlink privilege — that's fine).

- [ ] **Step 5: Commit**

```bash
git add src/repo-scan.ts test/repo-scan.test.ts
git commit -m "feat(repo-scan): bounded sub-repo detection" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `src/active-repo.ts` — path→repo match + active-repo precedence

**Files:**
- Create: `src/active-repo.ts`
- Test: `test/active-repo.test.ts`

**Interfaces:**
- Consumes: `RepoInfo` from `src/repo-scan` (type-only import).
- Produces:
  - `export function repoForPath(repos: RepoInfo[], absPath: string): string | undefined` — longest-prefix (segment-aware) repo `root` containing `absPath`, else `undefined`.
  - `export function resolveActiveRepo(input: { repos: RepoInfo[]; pinnedRoot?: string; autoRoot?: string; openedRoot: string }): string | undefined` — precedence: a `pinnedRoot` that still exists in `repos` → it; else an `autoRoot` that still exists → it; else fallback = the repo whose `root` equals `openedRoot` if present, else the first repo, else `undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// test/active-repo.test.ts
import { describe, expect, it } from 'vitest';
import { repoForPath, resolveActiveRepo } from '../src/active-repo';
import type { RepoInfo } from '../src/repo-scan';

const repos: RepoInfo[] = [
  { root: '/work/A', name: '.' },
  { root: '/work/A/sub', name: 'sub' },
  { root: '/work/B', name: 'B' },
];

describe('repoForPath', () => {
  it('returns the longest-prefix (segment-aware) repo containing the path', () => {
    expect(repoForPath(repos, '/work/A/sub/x.ts')).toBe('/work/A/sub');
    expect(repoForPath(repos, '/work/A/file.ts')).toBe('/work/A');
    expect(repoForPath(repos, '/work/B/y.ts')).toBe('/work/B');
  });
  it('does not match on a false (non-segment) prefix', () => {
    expect(repoForPath(repos, '/work/Bbb/y.ts')).toBeUndefined();
  });
  it('matches a repo root path itself', () => {
    expect(repoForPath(repos, '/work/B')).toBe('/work/B');
  });
  it('handles Windows backslashes', () => {
    expect(repoForPath([{ root: 'C:/work/A', name: '.' }], 'C:\\work\\A\\x.ts')).toBe('C:/work/A');
  });
});

describe('resolveActiveRepo', () => {
  const openedRoot = '/work/A';
  it('prefers a still-existing pinned root over everything', () => {
    expect(
      resolveActiveRepo({ repos, pinnedRoot: '/work/B', autoRoot: '/work/A', openedRoot }),
    ).toBe('/work/B');
  });
  it('ignores a pinned root that no longer exists and falls back to auto', () => {
    expect(
      resolveActiveRepo({ repos, pinnedRoot: '/work/GONE', autoRoot: '/work/B', openedRoot }),
    ).toBe('/work/B');
  });
  it('uses auto when no pin', () => {
    expect(resolveActiveRepo({ repos, autoRoot: '/work/A/sub', openedRoot })).toBe('/work/A/sub');
  });
  it('falls back to the opened-root repo when no pin/auto', () => {
    expect(resolveActiveRepo({ repos, openedRoot })).toBe('/work/A');
  });
  it('falls back to the first repo when opened root is not itself a repo', () => {
    const r: RepoInfo[] = [{ root: '/work/X/r1', name: 'r1' }, { root: '/work/X/r2', name: 'r2' }];
    expect(resolveActiveRepo({ repos: r, openedRoot: '/work/X' })).toBe('/work/X/r1');
  });
  it('returns undefined when there are no repos', () => {
    expect(resolveActiveRepo({ repos: [], openedRoot })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/active-repo.test.ts`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: Write the implementation**

```ts
// src/active-repo.ts
import type { RepoInfo } from './repo-scan';

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

function isAncestorOf(root: string, child: string): boolean {
  if (root === child) return true;
  return child.startsWith(`${root}/`);
}

/** Longest segment-aware prefix repo root containing `absPath`, else undefined. */
export function repoForPath(repos: RepoInfo[], absPath: string): string | undefined {
  const p = norm(absPath);
  let best: string | undefined;
  let bestLen = -1;
  for (const r of repos) {
    const root = norm(r.root);
    if (!isAncestorOf(root, p)) continue;
    if (root.length > bestLen) {
      bestLen = root.length;
      best = r.root; // return the original (un-normalized trailing) root
    }
  }
  return best;
}

const exists = (repos: RepoInfo[], root: string | undefined): root is string =>
  !!root && repos.some((r) => norm(r.root) === norm(root));

/** pinned (if still present) → auto (if still present) → opened-root repo → first repo → none. */
export function resolveActiveRepo(input: {
  repos: RepoInfo[];
  pinnedRoot?: string;
  autoRoot?: string;
  openedRoot: string;
}): string | undefined {
  const { repos, pinnedRoot, autoRoot, openedRoot } = input;
  if (repos.length === 0) return undefined;
  if (exists(repos, pinnedRoot)) return pinnedRoot;
  if (exists(repos, autoRoot)) return autoRoot;
  const rootRepo = repos.find((r) => norm(r.root) === norm(openedRoot));
  return rootRepo ? rootRepo.root : repos[0].root;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/active-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/active-repo.ts test/active-repo.test.ts
git commit -m "feat(active-repo): path->repo match + active-repo precedence" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Data layer — protocol/types fields, messages, and SessionManager derivation

**Files:**
- Modify: `src/protocol.ts` (re-export `RepoInfo`; add three messages)
- Modify: `src/types.ts` (`Session` runtime repo fields)
- Modify: `src/session-manager.ts` (repo-state setters + central derivation)
- Modify: `src/persistence.ts` (strip the new runtime fields on serialize — find the existing `git`/`cwd` strip)
- Test: `test/session-manager.test.ts` (add cases; create the file if absent — check first with the existing test dir)

**Interfaces:**
- Consumes: `resolveActiveRepo` (Task 2), `RepoInfo` (Task 1).
- Produces (used by Tasks 4/6/7):
  - `Session` gains runtime-only: `repos?: RepoInfo[]`, `activeRepoRoot?: string`, `repoPinned?: boolean`, and internal `pinnedRepoRoot?: string`, `autoRepoRoot?: string`.
  - `SessionManager`:
    - `setRepos(id: string, repos: RepoInfo[]): void`
    - `setAutoRepo(id: string, root: string | undefined): void`
    - `pinRepo(id: string, root: string): void`
    - `unpinRepo(id: string): void`
    - private `recomputeActiveRepo(s: Session): boolean` (returns whether derived fields changed)
  - Protocol messages: `{ type: 'repo:pin'; sessionId: string; repoRoot: string }`, `{ type: 'repo:unpin'; sessionId: string }`, `{ type: 'repo:context'; sessionId: string; path: string }` (all `WebviewToHost`).
  - `requestProject` gains an optional `changesRoot`: `{ type: 'requestProject'; path: string; changesRoot?: string }`.

- [ ] **Step 1: Add the runtime fields to `Session` (`src/types.ts`)** — after the `git?: GitInfo;` field:

```ts
  /**
   * Detected sub-repos under projectPath (multi-repo awareness). Runtime-only, host-derived
   * (src/repo-scan.ts); rides the `state` broadcast like `git`. NEVER persisted.
   */
  repos?: import('./repo-scan').RepoInfo[];
  /** Effective active repo root (see src/active-repo.ts). Runtime-only. */
  activeRepoRoot?: string;
  /** True when activeRepoRoot is held by a manual pick. Runtime-only. */
  repoPinned?: boolean;
  /** Manual pin target; cleared by unpin. Internal/runtime-only (not read by the renderer). */
  pinnedRepoRoot?: string;
  /** Last auto-follow target (cd / file focus / explorer click). Internal/runtime-only. */
  autoRepoRoot?: string;
```

> Use a top-level `import type { RepoInfo } from './repo-scan';` at the top of `types.ts` and reference `RepoInfo[]` instead of the inline `import(...)` form if the file already groups its imports — match the file's existing style.

- [ ] **Step 2: Re-export `RepoInfo` and add messages (`src/protocol.ts`)**

At the top with the other shared type re-exports add:

```ts
export type { RepoInfo } from './repo-scan';
```

In the `WebviewToHost` union (near the `git:refs` / `git:switch` entries ~line 447) add:

```ts
  | { type: 'repo:pin'; sessionId: string; repoRoot: string }
  | { type: 'repo:unpin'; sessionId: string }
  | { type: 'repo:context'; sessionId: string; path: string }
```

Change the existing `requestProject` line (~line 328) to:

```ts
  | { type: 'requestProject'; path: string; changesRoot?: string } // git changes (changesRoot) + file tree (path)
```

- [ ] **Step 3: Write the failing SessionManager test**

Check whether `test/session-manager.test.ts` exists; if it does, append this `describe`, else create the file with the standard imports used by sibling tests.

```ts
// test/session-manager.test.ts (add)
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agent-registry';
import { SessionManager } from '../src/session-manager';
import type { RepoInfo } from '../src/repo-scan';

function mgrWithSession() {
  const reg = new AgentRegistry();
  reg.register({ id: 'shell:test', label: 'T', command: 'sh', args: [], icon: '', color: '', cwdStrategy: 'workspaceFolder' });
  const mgr = new SessionManager(reg, () => 's1', () => 0);
  mgr.create('shell:test', '/work/A');
  return mgr;
}
const repos: RepoInfo[] = [
  { root: '/work/A', name: '.' },
  { root: '/work/A/sub', name: 'sub' },
  { root: '/work/B', name: 'B' },
];

describe('SessionManager repo state', () => {
  it('derives activeRepoRoot from repos with opened-root fallback', () => {
    const mgr = mgrWithSession();
    mgr.setRepos('s1', repos);
    expect(mgr.get('s1')?.activeRepoRoot).toBe('/work/A');
    expect(mgr.get('s1')?.repoPinned).toBe(false);
  });
  it('auto-follow sets the active repo when unpinned', () => {
    const mgr = mgrWithSession();
    mgr.setRepos('s1', repos);
    mgr.setAutoRepo('s1', '/work/B');
    expect(mgr.get('s1')?.activeRepoRoot).toBe('/work/B');
  });
  it('a pin holds the active repo across auto-follow until unpinned', () => {
    const mgr = mgrWithSession();
    mgr.setRepos('s1', repos);
    mgr.pinRepo('s1', '/work/A/sub');
    expect(mgr.get('s1')?.repoPinned).toBe(true);
    mgr.setAutoRepo('s1', '/work/B'); // ignored while pinned
    expect(mgr.get('s1')?.activeRepoRoot).toBe('/work/A/sub');
    mgr.unpinRepo('s1');
    expect(mgr.get('s1')?.repoPinned).toBe(false);
    expect(mgr.get('s1')?.activeRepoRoot).toBe('/work/B'); // resumes following auto
  });
  it('a deleted pinned repo falls back when repos refresh', () => {
    const mgr = mgrWithSession();
    mgr.setRepos('s1', repos);
    mgr.pinRepo('s1', '/work/B');
    mgr.setRepos('s1', repos.filter((r) => r.root !== '/work/B')); // B removed
    expect(mgr.get('s1')?.activeRepoRoot).not.toBe('/work/B');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/session-manager.test.ts`
Expected: FAIL — `setRepos`/`pinRepo`/etc. not defined.

- [ ] **Step 5: Implement the SessionManager methods**

Add `import { resolveActiveRepo } from './active-repo';` and `import type { RepoInfo } from './repo-scan';` to `src/session-manager.ts`, then add to the class (near `setGit`):

```ts
  /** Recompute derived active-repo fields from repos+pin+auto. Returns whether anything changed. */
  private recomputeActiveRepo(s: Session): boolean {
    const next = resolveActiveRepo({
      repos: s.repos ?? [],
      pinnedRoot: s.pinnedRepoRoot,
      autoRoot: s.autoRepoRoot,
      openedRoot: s.projectPath,
    });
    const pinned = !!s.pinnedRepoRoot && (s.repos ?? []).some((r) => r.root === s.pinnedRepoRoot);
    if (!pinned && s.pinnedRepoRoot) delete s.pinnedRepoRoot; // pin target vanished
    let changed = false;
    if (s.activeRepoRoot !== next) {
      s.activeRepoRoot = next;
      changed = true;
    }
    if (s.repoPinned !== pinned) {
      s.repoPinned = pinned;
      changed = true;
    }
    return changed;
  }

  setRepos(id: string, repos: RepoInfo[]) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.repos = repos;
    if (this.recomputeActiveRepo(s) || true) this.emit(); // repos themselves changed → always broadcast
  }

  setAutoRepo(id: string, root: string | undefined) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.autoRepoRoot = root;
    if (this.recomputeActiveRepo(s)) this.emit();
  }

  pinRepo(id: string, root: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.pinnedRepoRoot = root;
    if (this.recomputeActiveRepo(s)) this.emit();
  }

  unpinRepo(id: string) {
    const s = this.sessions.get(id);
    if (!s || !s.pinnedRepoRoot) return;
    delete s.pinnedRepoRoot;
    if (this.recomputeActiveRepo(s)) this.emit();
  }
```

> The `|| true` in `setRepos` is deliberate: even when the derived active root is unchanged, the `repos` array contents changed (picker list), so the renderer needs the broadcast. Add a one-line WHY comment to that effect.

- [ ] **Step 6: Strip runtime fields on persist (`src/persistence.ts`)**

Find where `serializeSessions` (or equivalent) drops `git`/`cwd`/`busy`. Add `repos`, `activeRepoRoot`, `repoPinned`, `pinnedRepoRoot`, `autoRepoRoot` to the omitted set (same mechanism). If it uses an explicit pick-list, they simply won't be added; if it spreads-and-deletes, delete them too. Confirm with a quick read of the function.

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run test/session-manager.test.ts && npm run typecheck`
Expected: PASS / no type errors in either tsconfig.

- [ ] **Step 8: Commit**

```bash
git add src/protocol.ts src/types.ts src/session-manager.ts src/persistence.ts test/session-manager.test.ts
git commit -m "feat(repo): session active-repo state + protocol fields" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Host wiring — detection, auto-follow, IPC, and re-keying git surfaces

**Files:**
- Modify: `electron/main.ts`
- Modify: `src/project-info.ts` (split changes-root from file-tree-root)

**Interfaces:**
- Consumes: `detectRepos` (Task 1), `repoForPath` (Task 2), SessionManager setters (Task 3), the new messages (Task 3).
- Produces: host now serves all git surfaces from the session's `activeRepoRoot`; broadcasts `repos`/`activeRepoRoot`/`repoPinned` via the existing `state` push (automatic — they're on `Session`).

- [ ] **Step 1: Split `getProjectInfo` (`src/project-info.ts`)**

Change the signature so changes come from the active repo root while the file tree stays on the opened root:

```ts
export async function getProjectInfo(
  cwd: string,
  changesRoot: string = cwd,
): Promise<{ changes: ChangeDTO[]; files: FileNodeDTO[]; customizations: CustomizationCount[] }> {
  if (!cwd || !fs.existsSync(cwd)) return { changes: [], files: [], customizations: [] };
  const [changes, files] = await Promise.all([
    fs.existsSync(changesRoot) ? gitChanges(changesRoot) : Promise.resolve<ChangeDTO[]>([]),
    Promise.resolve(fileTree(cwd)),
  ]);
  // status tags still match by basename (unchanged); they reflect the active repo's changes.
  ...
}
```

Keep the existing status-tagging block. Add/extend the unit test in `test/project-info.test.ts` (if present) for `getProjectInfo(root, subRepoRoot)` returning the sub-repo's changes with the root's file tree.

- [ ] **Step 2: Wire `changesRoot` through `sendProject` (`electron/main.ts` ~line 1111)**

```ts
  async function sendProject(dispatch: Dispatch, p: string, changesRoot?: string) {
    if (p) projectWatcher.watch(p);
    try {
      const info = await getProjectInfo(p, changesRoot ?? p);
      dispatch({ type: 'project', path: p, changes: info.changes, files: info.files, customizations: info.customizations });
    } catch {
      dispatch({ type: 'project', path: p, changes: [], files: [], customizations: [] });
    }
  }
```

And the `requestProject` handler (~line 1204): `await sendProject(replyHere, m.path, m.changesRoot);`

- [ ] **Step 3: Add a helper to resolve a session's git root, and re-key the git handlers**

Near `activeCwd` usage, add a host-local helper:

```ts
  // The git surfaces target the session's active repo when known, else its activeCwd.
  const gitRoot = (s: Session): string => s.activeRepoRoot ?? activeCwd(s);
```

Replace `const cwd = activeCwd(session);` with `const cwd = gitRoot(session);` in the handlers for `git:history` (~1241), `git:commitDiff` (~1261), `git:refs` (~1269), and `git:switch` (find it just after). Also in `runGitRefresh` (~599) replace `const cwd = activeCwd(session);` with `const cwd = gitRoot(session);` AND update the stale-guard compare on ~609 to `gitRoot(latest) !== cwd`. Leave the path-token resolver at ~1779 on `activeCwd` (it resolves terminal-relative paths, not git).

- [ ] **Step 4: Detect repos on open + refresh; feed auto-follow from `cd`**

Add a debounced scan keyed per session:

```ts
  const repoScanDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleRepoScan = (sessionId: string) => {
    const existing = repoScanDebounce.get(sessionId);
    if (existing) clearTimeout(existing);
    repoScanDebounce.set(sessionId, setTimeout(async () => {
      repoScanDebounce.delete(sessionId);
      const s = mgr.get(sessionId);
      if (!s) return;
      try {
        mgr.setRepos(sessionId, await detectRepos(s.projectPath));
      } catch (e) {
        log.error('repo', `scan failed for ${sessionId}: ${String(e)}`);
      }
    }, 150));
  };
```

- Call `scheduleRepoScan(session.id)` right after a session is created/opened in `openRepo` (find where `mgr.create(...)` is called there) and on relaunch.
- In the cwd-scanner block (~line 695, where `setCwd` is called when the OSC cwd report changes), after updating cwd, map it to a repo and set auto:
  ```ts
  // Multi-repo: a cd inside a detected sub-repo auto-follows (unless pinned — SessionManager guards).
  const sCwd = mgr.get(msg.sessionId);
  if (sCwd) mgr.setAutoRepo(msg.sessionId, repoForPath(sCwd.repos ?? [], activeCwd(sCwd)));
  ```
- Add `import { detectRepos } from '../src/repo-scan';` and `import { repoForPath } from '../src/active-repo';`. Clear `repoScanDebounce` for a session in `disposeSession` (~1148).

- [ ] **Step 5: Handle the three new messages (in `handle`, near the other `git:*` cases)**

```ts
        case 'repo:pin':
          if (mgr.get(m.sessionId)?.repos?.some((r) => r.root === m.repoRoot)) {
            mgr.pinRepo(m.sessionId, m.repoRoot); // validated against the detected allow-list
          }
          break;
        case 'repo:unpin':
          mgr.unpinRepo(m.sessionId);
          break;
        case 'repo:context': {
          const s = mgr.get(m.sessionId);
          if (s) mgr.setAutoRepo(m.sessionId, repoForPath(s.repos ?? [], m.path));
          break;
        }
```

When the active repo changes, the `state` broadcast carries the new `activeRepoRoot`; the renderer re-requests its project (Task 6) so Changes/history re-scope. Also trigger a git refresh so the branch indicator updates: in `runGitRefresh`'s scheduling, ensure `scheduleGitRefresh` is called when active repo changes — add a `mgr.onChange`-driven check, OR simplest: call `scheduleGitRefresh(m.sessionId)` at the end of each `repo:*` case and after `setAutoRepo` in the cwd-scanner. Prefer the explicit calls (cheap, debounced).

- [ ] **Step 6: Typecheck + run host-touching unit tests**

Run: `npm run typecheck && npx vitest run test/project-info.test.ts`
Expected: no type errors; project-info tests pass.

- [ ] **Step 7: Commit**

```bash
git add electron/main.ts src/project-info.ts test/project-info.test.ts
git commit -m "feat(repo): host detection, auto-follow + git surfaces keyed to active repo" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Settings toggle — `multiRepoPicker`

**Files:**
- Modify: `src/settings.ts`
- Modify: `webview/appearance-sections.ts` (add the control to the Explorer/behavior section)
- Modify: `webview/components/settings-modal.tsx` (only if a new control *type* is needed — a boolean reuses the existing toggle case)
- Test: `test/settings.test.ts` and `test/appearance-sections.test.ts` (update EXPECTED_CONTROLS — these snapshots broke last time a control was added)

**Interfaces:**
- Produces: `AppSettings.multiRepoPicker: boolean` (default `true`); the host reads it to gate detection/picker.

- [ ] **Step 1: Add the field + coercion (`src/settings.ts`)** — add to `AppSettings` (near `showGitIndicator`):

```ts
  // Behaviour: detect sub-repos under the opened folder and show a repo picker that scopes
  // the git surfaces to one active repo. Default ON (self-hides for single-repo projects).
  multiRepoPicker: boolean;
```

Add to `DEFAULT_SETTINGS`: `multiRepoPicker: true,` and to `coerceSettings`: `multiRepoPicker: bool(payload.multiRepoPicker, DEFAULT_SETTINGS.multiRepoPicker),`.

- [ ] **Step 2: Update settings test** — add `multiRepoPicker` to whatever exhaustive default/coercion assertions exist in `test/settings.test.ts` (run it first to see the exact failing assertion).

- [ ] **Step 3: Add the appearance control** — in `webview/appearance-sections.ts`, add a `multiRepoPicker` toggle control to the Explorer section (alongside `iconPack`) or the Behaviour section, matching the existing entry shape; update `EXPECTED_CONTROLS` in `test/appearance-sections.test.ts`.

- [ ] **Step 4: Gate host detection on the setting (`electron/main.ts`)** — in `scheduleRepoScan`, early-return clearing repos when off:

```ts
      if (!settings.multiRepoPicker) { mgr.setRepos(sessionId, []); return; }
```

Place this inside the timer callback before `detectRepos`.

- [ ] **Step 5: Run the affected tests + typecheck**

Run: `npx vitest run test/settings.test.ts test/appearance-sections.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/settings.ts webview/appearance-sections.ts webview/components/settings-modal.tsx test/settings.test.ts test/appearance-sections.test.ts
git commit -m "feat(settings): multiRepoPicker toggle (default on)" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `RepoPicker` component + placement beside the git indicator

**Files:**
- Create: `webview/components/repo-picker.tsx`
- Modify: `webview/components/center-pane.tsx` (render `RepoPicker` next to `GitIndicatorBar`; find where `GitIndicatorBar` is rendered)
- Modify: `webview/app.tsx` (re-request project when `activeRepoRoot` changes — pass `changesRoot`)
- Modify: `webview/styles.css` (picker chrome via design tokens)

**Interfaces:**
- Consumes: `RepoInfo` (type-only from `../../src/protocol`), the active session's `repos` / `activeRepoRoot` / `repoPinned` (already on the session in `state`), `post` from `../bridge`.
- Produces: `export function RepoPicker({ sessionId, repos, activeRepoRoot, pinned }: { sessionId: string; repos: RepoInfo[]; activeRepoRoot?: string; pinned?: boolean }): JSX.Element | null`. Renders `null` when `repos.length < 2`.

- [ ] **Step 1: Write the component** (model the dropdown on `branch-switcher-menu.tsx`: portaled `.ctxmenu`, `clampMenuPosition`, `useEscapeKey`, arrow/Enter/Esc, outside-click close). The trigger shows a folder glyph + active repo `name` + a 📌 when `pinned`. The list has each repo by `name` plus a top **"Auto"** row that unpins.

```tsx
// webview/components/repo-picker.tsx
import { useRef, useState } from 'react';
import type { RepoInfo } from '../../src/protocol';
import { post } from '../bridge';
import { IconChevronDown, IconFolder, IconPin } from '../icons'; // add IconPin/IconFolder to icons.ts if absent
import { RepoPickerMenu } from './repo-picker-menu';

const STR = {
  label: 'Active repo',
  auto: 'Auto (follow context)',
  pinnedHint: 'pinned',
} as const;

export function RepoPicker({
  sessionId,
  repos,
  activeRepoRoot,
  pinned,
}: {
  sessionId: string;
  repos: RepoInfo[];
  activeRepoRoot?: string;
  pinned?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (repos.length < 2) return null; // self-hide for 0/1 repo

  const active = repos.find((r) => r.root === activeRepoRoot);
  const onPick = (root: string | null) => {
    if (root === null) post({ type: 'repo:unpin', sessionId });
    else post({ type: 'repo:pin', sessionId, repoRoot: root });
    setOpen(false);
  };

  return (
    <div className="repo-picker" role="group" aria-label={STR.label}>
      <button
        ref={triggerRef}
        type="button"
        className="repo-picker__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${STR.label}: ${active?.name ?? '—'}${pinned ? `, ${STR.pinnedHint}` : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconFolder size={12} className="repo-picker__glyph" />
        <span className="repo-picker__name" dir="ltr">{active?.name ?? '—'}</span>
        {pinned && <IconPin size={11} className="repo-picker__pin" aria-hidden />}
        <IconChevronDown size={11} className="repo-picker__caret" aria-hidden />
      </button>
      {open && (
        <RepoPickerMenu
          repos={repos}
          activeRepoRoot={activeRepoRoot}
          pinned={pinned}
          autoLabel={STR.auto}
          triggerRef={triggerRef}
          onPick={onPick}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
```

Create `webview/components/repo-picker-menu.tsx` mirroring `BranchSwitcherMenu` (portal + `clampMenuPosition` + `useEscapeKey` + keyboard nav + outside-click). Rows are `role="menuitemradio"`; the active repo gets `aria-checked`; a top "Auto" row (also `menuitemradio`, checked when `!pinned`) calls `onPick(null)`; each repo row calls `onPick(repo.root)`. Reuse `.ctxmenu` classes.

> If adding two new menu files duplicates too much of `branch-switcher-menu.tsx`, the fallow duplication gate is non-gating — but prefer extracting the shared portal/positioning/keyboard shell only if it's clean. Do NOT over-abstract; a focused second menu is acceptable.

- [ ] **Step 2: Add icons if missing** — ensure `IconFolder` and `IconPin` exist in `webview/icons.ts` (Lucide `folder` / `pin`); add them following the existing icon export pattern if absent.

- [ ] **Step 3: Render it beside the indicator (`center-pane.tsx`)** — where `<GitIndicatorBar git={...} sessionId={...} .../>` renders, add before it:

```tsx
{session && (
  <RepoPicker
    sessionId={session.id}
    repos={session.repos ?? []}
    activeRepoRoot={session.activeRepoRoot}
    pinned={session.repoPinned}
  />
)}
```

- [ ] **Step 4: Re-request project on active-repo change (`app.tsx`)** — find the effect that posts `requestProject` (on open/focus/cwd change). Add `session.activeRepoRoot` to its dependency list and pass it as `changesRoot`:

```ts
post({ type: 'requestProject', path: projectPath, changesRoot: activeSession?.activeRepoRoot });
```

- [ ] **Step 5: Style the picker (`webview/styles.css`)** — add `.repo-picker*` rules reusing the same tokens/sizing as `.git-indicator` (spacing, radius, color vars). No raw hex.

- [ ] **Step 6: Visual check in the mock preview** — the mock has no `window.agentDeck`, so `repos` is empty and the picker self-hides (expected). Build the webview and confirm no crash:

Run: `npm run typecheck`
Expected: both tsconfigs clean.

- [ ] **Step 7: Commit**

```bash
git add webview/components/repo-picker.tsx webview/components/repo-picker-menu.tsx webview/components/center-pane.tsx webview/app.tsx webview/icons.ts webview/styles.css
git commit -m "feat(repo): RepoPicker UI + re-scope project on active-repo change" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Renderer auto-follow triggers (file focus + explorer click)

**Files:**
- Modify: `webview/app.tsx` (or wherever editor-tab focus + explorer selection are handled — locate the doc-open and file-row-click paths)

**Interfaces:**
- Consumes: `post` from `../bridge`; the active session id.
- Produces: posts `{ type: 'repo:context', sessionId, path }` on (a) opening/focusing an editor tab and (b) clicking a file/folder in the explorer.

- [ ] **Step 1: Emit `repo:context` on editor-tab focus/open** — at the point a doc becomes the active editor tab (the same place that already knows the file's absolute path), add:

```ts
if (activeSession) post({ type: 'repo:context', sessionId: activeSession.id, path: absPath });
```

- [ ] **Step 2: Emit `repo:context` on explorer file/folder click** — in the `FilesView`/file-row click handler (`webview/components/right-pane.tsx`), add the same post with the clicked node's absolute path. Keep it additive — do not change existing open behavior.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add webview/app.tsx webview/components/right-pane.tsx
git commit -m "feat(repo): auto-follow active repo on file focus + explorer click" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Real-app e2e — picker, re-scope, pin survives cd

**Files:**
- Create: `test/e2e/multi-repo.e2e.mjs`

**Interfaces:**
- Consumes: the `test/e2e/harness.mjs` helpers (`launchApp`/`openSession`/`runScenario`/`assert`/`tapBridge`); the real built app (`CONDUIT_E2E=1` → hidden window).

- [ ] **Step 1: Write the scenario** — build a temp `Project A` with two real repos (each: `git init`, one commit, one uncommitted change), open it, and assert against the real renderer:

```js
// test/e2e/multi-repo.e2e.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, openSession, runScenario } from './harness.mjs';

function repo(dir, file, committed, working) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, file), committed);
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  writeFileSync(join(dir, file), working); // uncommitted change
}

runScenario('multi-repo', async ({ page, log }) => {
  const root = mkdtempSync(join(tmpdir(), 'conduit-multirepo-'));
  repo(join(root, 'repo-a'), 'a.txt', 'a1\n', 'a2\n');
  repo(join(root, 'repo-b'), 'b.txt', 'b1\n', 'b2\n');

  await openSession(page, { path: root.replace(/\\/g, '/') });

  const picker = page.locator('.repo-picker__trigger');
  await picker.waitFor({ state: 'attached', timeout: 20000 });
  log('repo picker present ✓');

  // It lists both repos.
  await picker.click();
  const menu = page.locator('.repo-picker-menu, .ctxmenu');
  await menu.waitFor({ state: 'visible', timeout: 10000 });
  const names = await page.locator('.repo-picker-menu__name, .ctxmenu__item').allInnerTexts();
  assert(names.some((n) => n.includes('repo-a')), 'menu lists repo-a');
  assert(names.some((n) => n.includes('repo-b')), 'menu lists repo-b');

  // Pick repo-a, then assert the active label is repo-a (pinned).
  await page.locator('.repo-picker-menu__row, .ctxmenu__item', { hasText: 'repo-a' }).first().click();
  await page.locator('.repo-picker__name', { hasText: 'repo-a' }).waitFor({ timeout: 10000 });
  log('picked + pinned repo-a ✓');

  // The active repo state is authoritative in the host — assert via the bridge state, not just DOM.
  // (If the harness exposes tapBridge state, assert activeRepoRoot ends with repo-a here.)

  log('PASS ✓ multi-repo picker lists repos and pins selection');
});
```

> The "pin survives cd" assertion requires typing `cd repo-b` into the terminal and confirming the active label stays `repo-a`. Add it if the harness's terminal-input helper is available (see `cwd`/durability scenarios for the pattern); otherwise assert the pin via bridge state and note the cd-survival as covered by the SessionManager unit test (Task 3) + leave a `log()` breadcrumb. Do NOT mark the feature done on the unit test alone if the e2e can drive the terminal — prefer the real assertion.

- [ ] **Step 2: Run the scenario**

Run: `node test/e2e/run-smoke.mjs multi-repo`
Expected: PASS (~30s). If it hangs, check for orphaned electron processes first (known flake cause) before assuming a bug.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/multi-repo.e2e.mjs
git commit -m "test(e2e): multi-repo picker lists repos, pins selection" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Docs, full verify, and integrate

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` → Added: multi-repo picker)
- Modify: `docs/specs/2026-06-25-multi-repo-awareness.md` (frontmatter `status: implemented`) and `docs/specs/INDEX.md` (move the row to Archived per ADR 0003 via `git mv` to `docs/specs/archive/` — do this at integrate time, not before)

- [ ] **Step 1: CHANGELOG** — add under `[Unreleased]`:

```
- **Multi-repo awareness** — opening a folder that contains several git repos now shows a repo picker (separate from the branch picker) that scopes the branch indicator, history, and Changes to one active repo. The active repo follows your context (terminal `cd`, file focus, explorer click) and a manual pick stays pinned until you choose “Auto”. The Files explorer still browses the whole tree. Single-repo projects are unchanged.
```

- [ ] **Step 2: Run the full gate**

Run: `npm run verify`
Expected: exit 0. If git/FS integration tests flake under load, clear orphaned electron/git processes and re-run the full suite (do NOT narrow the gate). Never `| tail` the output — read it whole (the "Found N errors" line hides under a tail).

- [ ] **Step 3: Run the full e2e suite as the pre-integration regression check**

Run: `node test/e2e/run-smoke.mjs`
Expected: all scenarios pass (or only the documented `attention` opt-out behavior).

- [ ] **Step 4: Archive the spec + commit docs**

```bash
git mv docs/specs/2026-06-25-multi-repo-awareness.md docs/specs/archive/2026-06-25-multi-repo-awareness.md
# set frontmatter status: implemented; move the INDEX row from Active to Archived
git add CHANGELOG.md docs/specs/INDEX.md docs/specs/archive/2026-06-25-multi-repo-awareness.md
git commit -m "docs: multi-repo awareness changelog + archive spec" -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Merge to main, verify the merged tree, then report** — per `finishing-a-development-branch`: merge `multi-repo` into `main`, run `npm run verify` on the merged tree BEFORE any fast-forward/push, and only then consider it done. Do not push/release unless the user asks.

---

## Self-Review

**Spec coverage** (each spec section → task):
- §2 active-repo concept → Tasks 2, 3 (derivation on Session).
- §3 states/transitions (no-repo/single/multi, pin, deleted-pin fallback) → Tasks 2, 3 (unit), 6 (self-hide <2), 8 (e2e).
- §4 detection (depth, skip-list, `.git` file, stop-descend, symlink, cap) → Task 1.
- §5 resolution (`repoForPath`, `resolveActiveRepo`) → Task 2.
- §6 IPC (repos/activeRepoRoot/repoPinned broadcast; repo:pin/unpin/context; requestProject.changesRoot; re-keyed handlers; cd auto-follow) → Tasks 3, 4.
- §7 Changes/Files split → Task 4 Step 1.
- §8 UI picker + a11y + i18n (STR) + tokens → Task 6.
- §9 edge cases → Tasks 1 (scan), 3 (deleted pin), 4 (cd outside repo → undefined).
- §10 defaults/settings (on by default, depth=4 const, pin session-local) → Tasks 1, 3, 5.
- §11 scope (MVP only; per-repo badges = v1, excluded) → not built (correctly deferred).
- §12 acceptance criteria → Tasks 3 (unit) + 8 (e2e).
- §13 verification → Tasks 1,2,3 unit; 8 e2e; 9 full gate.

**Placeholder scan:** No "TBD"/"handle edge cases"-style placeholders; each code step shows code. The two soft spots are intentional and bounded: (a) Task 3 Step 6 / Task 4 Step 1 say "find the existing strip / keep the status block" because the exact lines must be read at execution (the surrounding code is shown); (b) Task 8 Step 1 conditionalizes the cd-survival assertion on a harness helper. Both name the concrete fallback.

**Type consistency:** `RepoInfo { root, name }` is consistent across repo-scan, active-repo, protocol re-export, Session, and RepoPicker. `resolveActiveRepo` input shape matches its call in `SessionManager.recomputeActiveRepo`. Message names (`repo:pin`/`repo:unpin`/`repo:context`) match between protocol (Task 3), host handlers (Task 4), and renderer posts (Tasks 6, 7). `gitRoot(s)` returns `activeRepoRoot ?? activeCwd(s)` consistently across all re-keyed handlers.

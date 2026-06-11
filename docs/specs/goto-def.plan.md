# goto-def Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the 5–10s first-use go-to-definition latency by proactively warming the TypeScript language worker, and show a non-blocking loading indicator while a goto resolves — without replacing the custom `agentdeck.goToDefinition` action (esbuild bundling constraint).

**Architecture:** Two pure, unit-tested seams in a new `webview/monaco-warmup.ts`: (1) a module-scoped once-guard + warm-up orchestrator that acquires the TS worker and issues the *real* `getDefinitionAtPosition` call against the first TS/TSX model, primed from `app.tsx` after the first `projectFiles` index; (2) a ref-counted, observable in-flight tracker that the CodeViewer subscribes to so it can render a busy/loading indicator during a goto. The custom worker-backed action stays; warming is strictly additive.

**Tech Stack:** TypeScript, React, monaco-editor (TS language worker), Vitest (node env), esbuild bundling, Biome (single quotes, semicolons, 2-space, width 100, kebab-case files).

---

### Task 1: Once-guard + in-flight tracker (pure helpers, TDD)

**Files:**
- Create: `webview/monaco-warmup.ts`
- Test: `test/unit/monaco-warmup.test.ts`

This task builds only the *pure* logic (guard state + ref-counted observable tracker).
The Monaco-touching `warmTypeScriptWorker` orchestrator is Task 2 (it depends on these).

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInflightTracker, resetWarmGuardForTests, shouldWarm } from '../../webview/monaco-warmup';

describe('shouldWarm (module-scoped once-guard)', () => {
  beforeEach(() => resetWarmGuardForTests());

  it('returns true the first time, false thereafter', () => {
    expect(shouldWarm()).toBe(true);
    expect(shouldWarm()).toBe(false);
    expect(shouldWarm()).toBe(false);
  });
});

describe('createInflightTracker (ref-counted, observable)', () => {
  it('active() is true while begin > end, false when balanced; never negative', () => {
    const t = createInflightTracker();
    expect(t.active()).toBe(false);
    t.begin();
    expect(t.active()).toBe(true);
    t.begin();
    expect(t.active()).toBe(true);
    t.end();
    expect(t.active()).toBe(true);
    t.end();
    expect(t.active()).toBe(false);
    t.end(); // extra end must not go negative
    expect(t.active()).toBe(false);
  });

  it('notifies subscribers on 0<->>=1 transitions and supports unsubscribe', () => {
    const t = createInflightTracker();
    const seen: boolean[] = [];
    const unsub = t.subscribe(() => seen.push(t.active()));
    t.begin(); // false -> true
    t.begin(); // stays true (no required notify, but allowed)
    t.end(); // stays true
    t.end(); // true -> false
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
    unsub();
    const before = seen.length;
    t.begin();
    expect(seen.length).toBe(before); // no notify after unsubscribe
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/monaco-warmup.test.ts`
Expected: FAIL — module `webview/monaco-warmup` has no such exports.

- [ ] **Step 3: Write minimal implementation**

Create `webview/monaco-warmup.ts` with ONLY the pure parts (Monaco import added in Task 2):

```ts
// Module-scoped once-guard so the TS-worker warm-up runs at most once per session,
// surviving React StrictMode double-invoked effects and component remounts. It only
// latches on a *successful* warm-up (see warmTypeScriptWorker, Task 2); a thrown
// attempt leaves it unlatched so a later trigger can retry.
let warmStarted = false;

/** True only the first time this session; idempotent thereafter. */
export function shouldWarm(): boolean {
  if (warmStarted) return false;
  warmStarted = true;
  return true;
}

/** Test-only: reset the module-scoped guard between cases. */
export function resetWarmGuardForTests(): void {
  warmStarted = false;
}

export interface InflightTracker {
  begin(): void;
  end(): void;
  active(): boolean;
  subscribe(fn: () => void): () => void;
}

/**
 * Ref-counted, observable in-flight tracker. `active()` is true iff `begin` calls
 * outnumber `end` calls; the count never goes negative. Subscribers are notified on
 * every 0<->>=1 transition so a React indicator can re-render.
 */
export function createInflightTracker(): InflightTracker {
  let count = 0;
  const subs = new Set<() => void>();
  const notify = () => {
    for (const fn of subs) fn();
  };
  return {
    begin() {
      const was = count > 0;
      count += 1;
      if (!was) notify();
    },
    end() {
      if (count === 0) return;
      count -= 1;
      if (count === 0) notify();
    },
    active: () => count > 0,
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

/** Shared tracker the CodeViewer subscribes to and goto requests mark begin/end on. */
export const gotoInflight = createInflightTracker();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/monaco-warmup.test.ts`
Expected: PASS (5 assertions across 3 tests).

- [ ] **Step 5: Commit**

```bash
git add webview/monaco-warmup.ts test/unit/monaco-warmup.test.ts
git commit -m "feat(goto-def): once-guard + ref-counted in-flight tracker"
```

---

### Task 2: warmTypeScriptWorker orchestrator (dependency-injected, TDD)

**Files:**
- Modify: `webview/monaco-warmup.ts`
- Test: `test/unit/monaco-warmup.test.ts` (append)

The orchestrator is async and touches Monaco, but its *sequencing/guard* logic is
tested with injected fakes (no real worker). Monaco is only used at the call site
(Task 3) which passes real implementations.

- [ ] **Step 1: Write the failing test (append to the existing file)**

```ts
import { warmTypeScriptWorker } from '../../webview/monaco-warmup';

describe('warmTypeScriptWorker', () => {
  beforeEach(() => resetWarmGuardForTests());

  const tsModel = { uri: 'file:///a.tsx', languageId: 'typescriptreact' };

  it('acquires the worker and issues the real getDefinitionAtPosition on the first TS model', async () => {
    const getDef = vi.fn().mockResolvedValue([]);
    const getWorker = vi.fn().mockResolvedValue(() => Promise.resolve({ getDefinitionAtPosition: getDef }));
    await warmTypeScriptWorker({
      getModels: () => [{ uri: 'file:///x.css', languageId: 'css' }, tsModel],
      isTsLang: (id) => id.startsWith('typescript') || id.startsWith('javascript'),
      getTypeScriptWorker: getWorker,
    });
    expect(getWorker).toHaveBeenCalledTimes(1);
    expect(getDef).toHaveBeenCalledWith('file:///a.tsx', 0);
  });

  it('runs only once even if called again', async () => {
    const getWorker = vi.fn().mockResolvedValue(() => Promise.resolve({ getDefinitionAtPosition: vi.fn() }));
    const deps = {
      getModels: () => [tsModel],
      isTsLang: () => true,
      getTypeScriptWorker: getWorker,
    };
    await warmTypeScriptWorker(deps);
    await warmTypeScriptWorker(deps);
    expect(getWorker).toHaveBeenCalledTimes(1);
  });

  it('no-ops (and does NOT latch the guard) when no TS model exists yet', async () => {
    const getWorker = vi.fn();
    await warmTypeScriptWorker({
      getModels: () => [{ uri: 'file:///x.css', languageId: 'css' }],
      isTsLang: (id) => id.startsWith('typescript'),
      getTypeScriptWorker: getWorker,
    });
    expect(getWorker).not.toHaveBeenCalled();
    expect(shouldWarm()).toBe(true); // guard not latched -> a real warm can still run
  });

  it('does NOT latch the guard when worker acquisition throws (allows retry)', async () => {
    const getWorker = vi.fn().mockRejectedValue(new Error('boom'));
    await warmTypeScriptWorker({
      getModels: () => [tsModel],
      isTsLang: () => true,
      getTypeScriptWorker: getWorker,
    });
    expect(shouldWarm()).toBe(true); // not latched after failure
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/monaco-warmup.test.ts`
Expected: FAIL — `warmTypeScriptWorker` not exported.

- [ ] **Step 3: Write minimal implementation (append to `webview/monaco-warmup.ts`)**

```ts
interface WarmModel {
  uri: string;
  languageId: string;
}
type DefAt = (uri: string, offset: number) => Promise<unknown>;
type WorkerGetter = (uri: unknown) => Promise<{ getDefinitionAtPosition: DefAt }>;

export interface WarmDeps {
  getModels: () => WarmModel[];
  isTsLang: (languageId: string) => boolean;
  getTypeScriptWorker: () => Promise<WorkerGetter>;
}

/**
 * Acquire the TS worker and issue the SAME getDefinitionAtPosition call a real goto
 * makes (against the first TS/TSX model) so the worker pre-loads the cross-file
 * resolution path before the user's first manual goto. Fire-and-forget: failures are
 * swallowed and the once-guard is only latched on a successful start, so a later
 * trigger can retry. No-op if no TS/TSX model is indexed yet.
 */
export async function warmTypeScriptWorker(deps: WarmDeps): Promise<void> {
  const model = deps.getModels().find((m) => deps.isTsLang(m.languageId));
  if (!model) return; // nothing to warm yet; guard stays open for a retry
  if (!shouldWarm()) return; // already warmed this session
  try {
    const getWorker = await deps.getTypeScriptWorker();
    const worker = await getWorker(model.uri);
    await worker.getDefinitionAtPosition(model.uri, 0);
  } catch {
    // Worker not ready / transient: un-latch so a later trigger can retry.
    resetWarmGuardForTests();
  }
}
```

Note: ordering matters — check for a TS model **before** consuming the guard, so a
repo with no TS files yet doesn't burn the one-shot. `resetWarmGuardForTests` is reused
as the internal un-latch (rename is cosmetic; keep one symbol). Add a non-test-named
alias if Biome/lint flags the name — see Step 4.

- [ ] **Step 4: Run test, then fix any lint about the reset name**

Run: `npx vitest run test/unit/monaco-warmup.test.ts`
Expected: PASS.

If reusing `resetWarmGuardForTests` inside production code reads poorly, extract the
body into a private `unlatch()` and have both `resetWarmGuardForTests` and the catch
call it:

```ts
function unlatch(): void {
  warmStarted = false;
}
export function resetWarmGuardForTests(): void {
  unlatch();
}
```
and change the catch to `unlatch();`. Re-run the test — still PASS.

- [ ] **Step 5: Commit**

```bash
git add webview/monaco-warmup.ts test/unit/monaco-warmup.test.ts
git commit -m "feat(goto-def): TS-worker warm-up orchestrator (DI, once-guarded)"
```

---

### Task 3: Prime warm-up from app.tsx after first project index

**Files:**
- Modify: `webview/app.tsx` (the `subscribe` effect, ~line 93 `projectFiles` branch)
- Modify: `webview/monaco-warmup.ts` (add a Monaco-bound convenience entry)

- [ ] **Step 1: Add a Monaco-bound entry point in `webview/monaco-warmup.ts`**

Append (this is the only Monaco import in the file; the pure helpers above stay
Monaco-free so they run in the node test env):

```ts
import * as monaco from 'monaco-editor';
import { typescript as monacoTs } from 'monaco-editor';

/** TS/JS language ids whose worker backs go-to-definition. */
const TS_LANGS = new Set(['typescript', 'javascript', 'typescriptreact', 'javascriptreact']);

/**
 * Convenience wrapper that binds warmTypeScriptWorker to the live Monaco APIs. Call
 * after project files are indexed; safe to call repeatedly (once-guarded inside).
 */
export function warmWorkerFromMonaco(): void {
  void warmTypeScriptWorker({
    getModels: () =>
      monaco.editor.getModels().map((m) => ({ uri: m.uri.toString(), languageId: m.getLanguageId() })),
    isTsLang: (id) => TS_LANGS.has(id),
    getTypeScriptWorker: async () => {
      const getWorker = await monacoTs.getTypeScriptWorker();
      return (uri: unknown) => getWorker(monaco.Uri.parse(uri as string));
    },
  });
}
```

Place the `import * as monaco` / `monacoTs` imports at the TOP of the file with the
other imports (none currently), but keep `shouldWarm`/`createInflightTracker`/
`warmTypeScriptWorker` free of any runtime Monaco use so the node test env never loads
monaco. (Importing monaco at module top is fine for the browser bundle; the test only
imports the pure named exports and Vitest tree-resolves the module — if the test env
chokes on the monaco import, mock it in the test file via `vi.mock('monaco-editor', () => ({}))`
at the top, OR split the Monaco wrapper into `webview/monaco-warmup-bind.ts`. Prefer the
split if the test fails to load — see Step 3.)

- [ ] **Step 2: Wire it into app.tsx**

In `webview/app.tsx`, import and call after the first index. Change the import block to
add:

```ts
import { warmWorkerFromMonaco } from './monaco-warmup';
```

And change the `projectFiles` branch:

```ts
else if (msg.type === 'projectFiles') {
  indexModels(msg.files);
  warmWorkerFromMonaco(); // once-guarded inside: kicks TS-worker warm-up early
}
```

- [ ] **Step 3: Verify the unit test still loads (monaco-in-node guard)**

Run: `npx vitest run test/unit/monaco-warmup.test.ts`
Expected: PASS. If it FAILS to import because `monaco-editor` can't load in the node
env, split the Monaco wrapper into a new `webview/monaco-warmup-bind.ts` (move
`warmWorkerFromMonaco` + the two monaco imports there, re-export `warmTypeScriptWorker`
from the pure module), update the `app.tsx` import to `./monaco-warmup-bind`, and re-run.
The pure test imports only `./monaco-warmup` and stays green.

- [ ] **Step 4: Typecheck both tsconfigs**

Run: `npm run typecheck`
Expected: PASS (host + webview). The DI types in `warmTypeScriptWorker` must line up
with the wrapper's lambdas.

- [ ] **Step 5: Commit**

```bash
git add webview/monaco-warmup.ts webview/app.tsx
git commit -m "feat(goto-def): prime TS-worker warm-up after first project index"
```

---

### Task 4: Loading indicator + begin/end around goto in CodeViewer

**Files:**
- Modify: `webview/components/code-viewer.tsx`
- Modify: `webview/styles.css` (or the app's editor stylesheet — locate the `.viewer` rules)

- [ ] **Step 1: Locate the stylesheet that defines `.viewer` / `.viewer__banner`**

Run: `npx rg -l "viewer__banner|\.viewer\b" webview` (find the CSS file).
You will add a `.viewer__loading` rule there in Step 4.

- [ ] **Step 2: Mark begin/end around the goto request (CodeViewer)**

In `webview/components/code-viewer.tsx`, import the tracker:

```ts
import { gotoInflight } from '../monaco-warmup';
```

Wrap the body of `goToDefinition` so begin/end is ref-counted and `end()` is in a
`finally` (so a throw can never leak the count). Replace the existing `goToDefinition`
async function body's try/catch with:

```ts
const goToDefinition = async () => {
  const mdl = editor.getModel();
  const p = editor.getPosition();
  if (!mdl || !p) return;
  gotoInflight.begin();
  try {
    const getWorker = await monacoTs.getTypeScriptWorker();
    const worker = await getWorker(mdl.uri);
    const defs = await worker.getDefinitionAtPosition(mdl.uri.toString(), mdl.getOffsetAt(p));
    const d = defs?.[0];
    if (!d) return;
    const targetUri = monaco.Uri.parse(d.fileName);
    if (targetUri.toString() === mdl.uri.toString()) {
      const tp = mdl.getPositionAt(d.textSpan.start);
      editor.setPosition(tp);
      editor.revealLineInCenter(tp.lineNumber);
    } else {
      const target = monaco.editor.getModel(targetUri);
      const tp = target ? target.getPositionAt(d.textSpan.start) : { lineNumber: 1, column: 1 };
      const abs = targetUri.path.replace(/^\/+/, '');
      setReveal(abs, { line: tp.lineNumber, column: tp.column });
      openDefinitionFile(abs);
    }
  } catch {
    /* worker not ready / non-TS file */
  } finally {
    gotoInflight.end();
  }
};
```

- [ ] **Step 3: Subscribe to the tracker and render the indicator**

Add state near the other CodeViewer state:

```ts
const [resolving, setResolving] = useState(false);
```

Add an effect (alongside the existing effects) that subscribes:

```ts
useEffect(() => {
  const sync = () => setResolving(gotoInflight.active());
  sync();
  return gotoInflight.subscribe(sync);
}, []);
```

Render a non-blocking, accessible status inside the `.viewer` return, after the monaco
div:

```tsx
return (
  <div className="viewer" data-resolving={resolving || undefined}>
    {doc.truncated && <div className="viewer__banner">Large file — showing the first 2 MB.</div>}
    <div className="viewer__monaco" ref={ref} />
    {resolving && (
      <div className="viewer__loading" role="status" aria-live="polite">
        Resolving definition…
      </div>
    )}
    {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
  </div>
);
```

(The `data-resolving` attribute lets the busy cursor be applied via CSS without
touching Monaco's DOM.)

- [ ] **Step 4: Add the indicator + busy-cursor styles**

In the stylesheet from Step 1, add (reuse existing theme tokens / match
`.viewer__banner`; no raw hex beyond what the file already uses for banners):

```css
.viewer__loading {
  position: absolute;
  bottom: 10px;
  right: 12px;
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  background: var(--panel-bg, rgba(0, 0, 0, 0.6));
  color: var(--text, #ddd);
  pointer-events: none;
  opacity: 0.92;
}
.viewer[data-resolving] .viewer__monaco {
  cursor: progress;
}
```

Ensure `.viewer` is `position: relative` (add it if absent) so the absolutely-positioned
loading badge anchors to the viewer.

- [ ] **Step 5: Typecheck + lint + run the unit tests**

Run: `npm run typecheck` then `npx vitest run test/unit/monaco-warmup.test.ts`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add webview/components/code-viewer.tsx webview/styles.css
git commit -m "feat(goto-def): non-blocking loading indicator during go-to-definition"
```

---

### Task 5: Gates + runtime proof

**Files:** none (verification only). Evidence → `.autoloop/evidence/`.

- [ ] **Step 1: Full verify gate**

Run: `npm run verify` (tee to `.autoloop/evidence/goto-def-verify.log`)
Expected: format-check + lint + typecheck + tests + security all PASS.

- [ ] **Step 2: Build gate (the bundling risk)**

Run: `npm run build` (append to the same log)
Expected: PASS. Then confirm `ts.worker.js` exists in the build output dir (e.g.
`dist/`/`out/`) — the bundling constraint. If absent, STOP: the warm-up change must
not have altered worker bundling; investigate before proceeding.

- [ ] **Step 3: Runtime proof via Playwright over HTTP**

Serve the built webview over HTTP (file:// is blocked — see MEMORY), open a TS/TSX file,
and:
- confirm `warmWorkerFromMonaco` fired before any manual goto (instrument/log warm-up
  start, or assert `window.monaco` + that a definition resolves immediately),
- invoke go-to-definition and confirm it still navigates (in-file and cross-file) — no
  regression,
- confirm the `.viewer__loading` indicator appears for an in-flight request.

Screenshots → `%TEMP%\claude-scratch\` (absolute paths only). Observations + paths →
`.autoloop/evidence/goto-def-runtime.txt`. Note explicitly that the wall-clock
5–10s→fast improvement is best confirmed manually in the desktop app on a fresh large
repo.

- [ ] **Step 4: Code review**

Invoke `superpowers:requesting-code-review`; address blocking findings (re-verify after
changes). Then `superpowers:verification-before-completion`.

- [ ] **Step 5: Hygiene + final status**

Delete scratch; `git status` shows only: source changes, `docs/specs/goto-def.md` +
`.plan.md`, `test/unit/monaco-warmup.test.ts`, evidence under `.autoloop/evidence/`.
(`board.json` may show modified — leave it.)

---

## Self-Review

**1. Spec coverage:**
- Warm-up once, after first index, before manual goto → Tasks 1 (guard), 2 (orchestrator), 3 (prime from app.tsx). ✓
- Same `getDefinitionAtPosition` call as real goto (not trivial poke) → Task 2 Step 3 + test asserting `getDefinitionAtPosition(uri, 0)`. ✓
- Module-scoped guard surviving StrictMode → Task 1 (module-level `warmStarted`) + Task 3 Step 3 note. ✓
- No-TS-file no-op + retry; throw → no latch + retry → Task 2 tests + impl (check model before guard; un-latch on catch). ✓
- Ref-counted, observable tracker; never negative; notify on transitions → Task 1 tests + impl. ✓
- `end()` in `finally` (no leak) → Task 4 Step 2. ✓
- Indicator visible while ≥1 in flight, cleared on success/not-found/error → Task 4 (subscribe + render; finally covers all paths). ✓
- Accessibility: `role="status"`, `aria-live="polite"`, non-interactive, no focus steal → Task 4 Step 3. ✓
- Design tokens / no raw hex → Task 4 Step 4 (CSS vars with fallbacks matching banner). ✓
- Keep custom action; do NOT switch to native → no task touches the action id/mechanism. ✓
- Gates (verify + build, ts.worker.js present) + runtime proof → Task 5. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step has full code. ✓

**3. Type consistency:** `shouldWarm`, `resetWarmGuardForTests`/`unlatch`, `createInflightTracker`/`InflightTracker` (`begin`/`end`/`active`/`subscribe`), `gotoInflight`, `warmTypeScriptWorker(WarmDeps)`, `warmWorkerFromMonaco` — names consistent across Tasks 1–4. ✓

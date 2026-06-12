# Busy / Needs-Attention Indicator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a busy (animated dot) state on a session tab while it produces PTY output, and a needs-attention highlight (with float-to-top in derived sorts) when a background task finishes — so a user juggling sessions sees which one wants input.

**Architecture:** A pure, time-injected `SessionActivity` state machine (`src/session-activity.ts`) tracks per-session `lastOutputAt` + focused id and derives `busy`/`needsAttention`. The host (`electron/main.ts`) feeds it PTY output, runs a low-frequency sweep timer to detect busy→idle, receives a `focus` message, and merges the two flags onto each `Session` in the existing `state` broadcast through a 120 ms trailing coalescer. The renderer animates the existing `.dot` for busy and adds a `.session--attention` highlight, floating attention sessions to the top only in non-manual sorts.

**Tech Stack:** TypeScript, Electron (host), React (webview), Vitest (unit tests), Biome (single quotes, semicolons, 2-space, width 100).

---

## File Structure

- **Create** `src/session-activity.ts` — pure `SessionActivity` class (busy window, sweep, focus, attention, `apply`). No Electron/DOM imports.
- **Create** `test/unit/session-activity.test.ts` — state-machine unit tests.
- **Modify** `src/types.ts` — add optional `busy?`/`needsAttention?` to `Session`.
- **Modify** `src/protocol.ts` — add `{ type: 'focus'; id }` to `WebviewToHost`.
- **Modify** `electron/main.ts` — instantiate `SessionActivity`; record output on `term:data`; sweep timer; handle `focus`; clear on `kill`; merge flags into `postState`; coalesce broadcasts.
- **Modify** `webview/app.tsx` — post `focus` when the active session changes.
- **Modify** `webview/components/sidebar.tsx` — busy dot class + attention class + float-in-derived-sorts.
- **Modify** `webview/styles.css` — busy pulse keyframe + `.dot--busy` + `.session--attention`, with reduced-motion guard.
- **Modify** `webview/mock.ts` — give a mock session `busy`, another `needsAttention`, so the preview exercises both renderer states.

---

## Task 1: Pure `SessionActivity` state machine (TDD)

**Files:**
- Create: `src/session-activity.ts`
- Test: `test/unit/session-activity.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { SessionActivity } from '../../src/session-activity';
import type { Session } from '../../src/types';

const WINDOW = 1500;
const make = () => new SessionActivity({ busyWindowMs: WINDOW });

describe('SessionActivity (pure state machine)', () => {
  it('recordOutput marks a session busy (AC1)', () => {
    const a = make();
    expect(a.recordOutput('s', 0)).toBe(true); // idle -> busy is a change
    expect(a.statusOf('s')).toEqual({ busy: true, needsAttention: false });
  });

  it('busy -> idle while unfocused sets needsAttention (AC2)', () => {
    const a = make();
    a.recordOutput('s', 0);
    expect(a.sweep(WINDOW)).toBe(true);
    expect(a.statusOf('s')).toEqual({ busy: false, needsAttention: true });
  });

  it('finishing while focused does NOT set needsAttention (AC3)', () => {
    const a = make();
    a.recordOutput('s', 0);
    a.focus('s');
    a.sweep(WINDOW);
    expect(a.statusOf('s')).toEqual({ busy: false, needsAttention: false });
  });

  it('focus clears an existing needsAttention (AC4)', () => {
    const a = make();
    a.recordOutput('s', 0);
    a.sweep(WINDOW); // unfocused -> attention
    expect(a.statusOf('s').needsAttention).toBe(true);
    expect(a.focus('s')).toBe(true);
    expect(a.statusOf('s').needsAttention).toBe(false);
  });

  it('recordOutput while already busy reports no change (AC5)', () => {
    const a = make();
    a.recordOutput('s', 0);
    expect(a.recordOutput('s', 100)).toBe(false); // still busy, no flag change
    expect(a.statusOf('s').busy).toBe(true);
  });

  it('recordOutput on a flagged session clears attention (AC6)', () => {
    const a = make();
    a.recordOutput('s', 0);
    a.sweep(WINDOW); // -> needsAttention
    expect(a.recordOutput('s', WINDOW + 10)).toBe(true); // busy again + cleared
    expect(a.statusOf('s')).toEqual({ busy: true, needsAttention: false });
  });

  it('sweep before the window elapses keeps busy and reports no change (AC7)', () => {
    const a = make();
    a.recordOutput('s', 0);
    expect(a.sweep(WINDOW - 1)).toBe(false);
    expect(a.statusOf('s').busy).toBe(true);
  });

  it('forget untracks a session (AC8)', () => {
    const a = make();
    a.recordOutput('s', 0);
    a.forget('s');
    expect(a.statusOf('s')).toEqual({ busy: false, needsAttention: false });
  });

  it('apply merges flags onto sessions, leaving untracked ones unchanged (AC9)', () => {
    const a = make();
    a.recordOutput('busy', 0);
    a.recordOutput('attn', 0);
    a.sweep(WINDOW); // both unfocused -> both attention; re-busy "busy"
    a.recordOutput('busy', WINDOW + 1);
    const sessions = [
      { id: 'busy' } as Session,
      { id: 'attn' } as Session,
      { id: 'untracked' } as Session,
    ];
    const out = a.apply(sessions);
    expect(out.find((s) => s.id === 'busy')).toMatchObject({ busy: true, needsAttention: false });
    expect(out.find((s) => s.id === 'attn')).toMatchObject({ busy: false, needsAttention: true });
    expect(out.find((s) => s.id === 'untracked')).toMatchObject({ busy: false, needsAttention: false });
  });

  it('focus(undefined) clears the focused id without throwing', () => {
    const a = make();
    expect(a.focus(undefined)).toBe(false); // no prior focus -> no change
  });

  it('switching focus away does not retroactively flag the previously focused session', () => {
    const a = make();
    a.recordOutput('s', 0);
    a.focus('s');
    a.focus('other'); // s is no longer focused, but it is still busy (not swept)
    a.sweep(WINDOW); // s goes idle while now-unfocused -> attention
    expect(a.statusOf('s').needsAttention).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/session-activity.test.ts`
Expected: FAIL — `Cannot find module '../../src/session-activity'`.

- [ ] **Step 3: Implement `src/session-activity.ts`**

```ts
import type { Session } from './types';

/**
 * Pure, runtime-only activity tracker for sessions, driven by PTY output.
 *
 * Two derived flags per session, layered on top of the lifecycle `status`:
 * - `busy`: produced output within the rolling busy window.
 * - `needsAttention`: transitioned busy -> idle (a task finished) while it was
 *   NOT the focused session. Cleared on focus, on new output, or on forget.
 *
 * Time is injected (callers pass `now`) so the machine is deterministic and
 * fully unit-testable without timers. The host owns the wall clock + sweep loop.
 */
export interface ActivityOptions {
  busyWindowMs?: number;
}

interface Entry {
  lastOutputAt: number;
  busy: boolean;
  needsAttention: boolean;
}

const NONE = { busy: false, needsAttention: false } as const;

export class SessionActivity {
  private readonly entries = new Map<string, Entry>();
  private focusedId: string | undefined;
  private readonly busyWindowMs: number;

  constructor(opts: ActivityOptions = {}) {
    this.busyWindowMs = opts.busyWindowMs ?? 1500;
  }

  /** Record PTY output for a session. Returns true if public flags changed. */
  recordOutput(id: string, now: number): boolean {
    const e = this.entries.get(id);
    if (!e) {
      this.entries.set(id, { lastOutputAt: now, busy: true, needsAttention: false });
      return true; // idle/untracked -> busy
    }
    e.lastOutputAt = now;
    const wasBusy = e.busy;
    const hadAttention = e.needsAttention;
    e.busy = true;
    e.needsAttention = false; // output means it's working again, not waiting
    return !wasBusy || hadAttention;
  }

  /**
   * Detect busy -> idle transitions at `now`. A session whose last output is
   * older than the busy window goes idle; if it was not the focused session at
   * that moment, it gains needsAttention. Returns true if anything changed.
   */
  sweep(now: number): boolean {
    let changed = false;
    for (const [id, e] of this.entries) {
      if (e.busy && now - e.lastOutputAt >= this.busyWindowMs) {
        e.busy = false;
        if (id !== this.focusedId) e.needsAttention = true;
        changed = true;
      }
    }
    return changed;
  }

  /** Set the focused session; clears its needsAttention. Returns true if changed. */
  focus(id: string | undefined): boolean {
    const focusChanged = this.focusedId !== id;
    this.focusedId = id;
    if (id === undefined) return focusChanged && false ? true : false;
    const e = this.entries.get(id);
    if (e && e.needsAttention) {
      e.needsAttention = false;
      return true;
    }
    return false;
  }

  /** Stop tracking a removed session. */
  forget(id: string): void {
    this.entries.delete(id);
  }

  /** Current public flags for a session (defaults to all-false when untracked). */
  statusOf(id: string): { busy: boolean; needsAttention: boolean } {
    const e = this.entries.get(id);
    if (!e) return { ...NONE };
    return { busy: e.busy, needsAttention: e.needsAttention };
  }

  /** Merge busy/needsAttention onto each session (untracked -> false). */
  apply(sessions: Session[]): Session[] {
    return sessions.map((s) => {
      const { busy, needsAttention } = this.statusOf(s.id);
      return { ...s, busy, needsAttention };
    });
  }
}
```

> Note: the `focus(undefined)` branch must simply return `false` when there is no
> prior focus change worth broadcasting. Simplify to:
> ```ts
> focus(id: string | undefined): boolean {
>   this.focusedId = id;
>   if (id === undefined) return false;
>   const e = this.entries.get(id);
>   if (e?.needsAttention) { e.needsAttention = false; return true; }
>   return false;
> }
> ```
> Use this simplified form in the implementation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/session-activity.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/session-activity.ts test/unit/session-activity.test.ts
git commit -m "feat(D5): pure SessionActivity busy/needs-attention state machine"
```

---

## Task 2: Add runtime flags to the `Session` type

**Files:**
- Modify: `src/types.ts:15-24`

- [ ] **Step 1: Add the optional fields**

In `src/types.ts`, extend the `Session` interface:

```ts
export interface Session {
  id: string;
  name: string;
  agentId: string;
  projectPath: string; // absolute folder used as group key + cwd
  worktree?: string; // optional worktree label
  status: SessionStatus;
  createdAt: number; // epoch ms, set on creation
  lastActiveAt: number; // epoch ms, set on creation, bumped on activity (term start/input)
  busy?: boolean; // produced output within the busy window (runtime-only, host-derived)
  needsAttention?: boolean; // finished a task while unfocused (runtime-only, host-derived)
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (optional fields don't break existing construction sites).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(D5): add runtime busy/needsAttention fields to Session"
```

---

## Task 3: Add the `focus` message to the protocol

**Files:**
- Modify: `src/protocol.ts:98-133`

- [ ] **Step 1: Add the message variant**

In `src/protocol.ts`, add to the `WebviewToHost` union (place it near `reorderSessions`):

```ts
  | { type: 'reorderSessions'; order: string[] } // new global session id order
  | { type: 'focus'; id: string } // renderer's active session changed (clears needs-attention)
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/protocol.ts
git commit -m "feat(D5): add focus message to webview->host protocol"
```

---

## Task 4: Wire the host — record output, sweep, focus, coalesced broadcast

**Files:**
- Modify: `electron/main.ts` (imports; `app.whenReady` body; `handle` switch; cleanup)

- [ ] **Step 1: Import the state machine**

Add near the other `../src` imports in `electron/main.ts`:

```ts
import { SessionActivity } from '../src/session-activity';
```

- [ ] **Step 2: Instantiate activity + a coalesced broadcaster + sweep timer**

Inside `app.whenReady().then(() => { ... })`, after `const mgr = new SessionManager(registry);` and before `const pty = new PtyHost(`, add:

```ts
  // Runtime busy/needs-attention tracker (output-activity heuristic). Pure;
  // host owns the clock + the sweep loop.
  const activity = new SessionActivity();

  // Coalesce activity-driven broadcasts: the first change arms a trailing timer,
  // further changes within the window are absorbed, then one postState fires.
  // Bounds IPC under an output firehose (recordOutput is O(1) per chunk).
  let activityTimer: NodeJS.Timeout | null = null;
  const ACTIVITY_COALESCE_MS = 120;
  const scheduleActivityBroadcast = () => {
    if (activityTimer) return;
    activityTimer = setTimeout(() => {
      activityTimer = null;
      postState();
    }, ACTIVITY_COALESCE_MS);
  };
```

Then change the `PtyHost` construction so PTY output feeds the tracker. Replace:

```ts
  const pty = new PtyHost(
    (msg) => {
      send(msg);
      if (msg.type === 'term:exit') mgr.setStatus(msg.sessionId, 'exited');
    },
    (m) => console.log('[pty]', m),
  );
```

with:

```ts
  const pty = new PtyHost(
    (msg) => {
      send(msg);
      if (msg.type === 'term:data') {
        // Output activity drives the busy/needs-attention machine. Only an
        // idle->busy edge (or an attention clear) is a change worth broadcasting.
        if (activity.recordOutput(msg.sessionId, Date.now())) scheduleActivityBroadcast();
      } else if (msg.type === 'term:exit') {
        mgr.setStatus(msg.sessionId, 'exited');
      }
    },
    (m) => console.log('[pty]', m),
  );

  // Low-frequency sweep detects busy->idle (task finished). Interval is <= half
  // the busy window so detection latency stays bounded; cheap (a Map scan).
  const sweepTimer = setInterval(() => {
    if (activity.sweep(Date.now())) scheduleActivityBroadcast();
  }, 750);
```

- [ ] **Step 3: Merge the flags into `postState`**

Replace the `postState` definition:

```ts
  const postState = () =>
    send({
      type: 'state',
      agents: registry.list(),
      groups: mgr.groupByProject(),
      sessions: mgr.list(),
      repos: reposForState(),
      settings,
    });
```

with one that runs both `groups` and `sessions` through `activity.apply` so the
renderer receives the flags on every session:

```ts
  const postState = () => {
    const sessions = activity.apply(mgr.list());
    const groups = mgr.groupByProject().map((g) => ({
      projectPath: g.projectPath,
      sessions: activity.apply(g.sessions),
    }));
    send({
      type: 'state',
      agents: registry.list(),
      groups,
      sessions,
      repos: reposForState(),
      settings,
    });
  };
```

- [ ] **Step 4: Handle the `focus` message + forget on kill**

In the `handle` switch, add a `focus` case (near `reorderSessions`):

```ts
        case 'focus':
          // Renderer's active session changed; clear its needs-attention.
          if (activity.focus(m.id)) scheduleActivityBroadcast();
          break;
```

And in the existing `kill` case, drop the session from the tracker. Replace:

```ts
        case 'kill':
          pty.dispose(m.id);
          mgr.remove(m.id);
          break;
```

with:

```ts
        case 'kill':
          pty.dispose(m.id);
          mgr.remove(m.id);
          activity.forget(m.id);
          break;
```

- [ ] **Step 5: Clean up the timers on quit**

Replace:

```ts
  app.on('before-quit', () => pty.disposeAll());
```

with:

```ts
  app.on('before-quit', () => {
    clearInterval(sweepTimer);
    if (activityTimer) clearTimeout(activityTimer);
    pty.disposeAll();
  });
```

- [ ] **Step 6: Typecheck (both tsconfigs)**

Run: `npm run typecheck`
Expected: PASS. (`NodeJS.Timeout` is available in the host tsconfig; if the host
config types `setTimeout` as DOM returning `number`, use `ReturnType<typeof setTimeout>`
for `activityTimer`/`sweepTimer` instead.)

- [ ] **Step 7: Commit**

```bash
git add electron/main.ts
git commit -m "feat(D5): host wires PTY output -> busy/attention with coalesced broadcast"
```

---

## Task 5: Renderer posts `focus` on active-session change

**Files:**
- Modify: `webview/app.tsx` (after the `activeId` state + the "keep a valid active session" effect)

- [ ] **Step 1: Post focus whenever the active session id changes**

In `webview/app.tsx`, add an effect right after the existing
`const active = sessions.find((s) => s.id === activeId);` line (or after the
"Keep a valid active session selected" effect):

```ts
  // Tell the host which session is focused so it can clear that session's
  // needs-attention flag (the focused session never needs attention). No-op in
  // the browser preview (the mock ignores `focus`).
  useEffect(() => {
    if (activeId) post({ type: 'focus', id: activeId });
  }, [activeId]);
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add webview/app.tsx
git commit -m "feat(D5): renderer posts focus on active session change"
```

---

## Task 6: Sidebar — busy dot, attention highlight, float in derived sorts

**Files:**
- Modify: `webview/components/sidebar.tsx`

- [ ] **Step 1: Animate the busy dot + add the attention class on the session row**

In `SessionItem`, change the dot to add a `dot--busy` modifier when busy, and add
`session--attention` to the row class. Replace the row open + dot:

```tsx
    <div
      className={`session ${active ? 'session--active' : ''} ${dropTarget ? 'session--dropbefore' : ''}`}
      ...
    >
      <span className={`dot dot--${statusClass(session.status)}`} />
```

with:

```tsx
    <div
      className={`session ${active ? 'session--active' : ''} ${dropTarget ? 'session--dropbefore' : ''} ${session.needsAttention ? 'session--attention' : ''}`}
      ...
    >
      <span
        className={`dot dot--${statusClass(session.status)} ${session.busy ? 'dot--busy' : ''}`}
        title={session.busy ? 'Busy' : session.needsAttention ? 'Finished — needs attention' : undefined}
      />
      {session.needsAttention && <span className="session__attn" aria-hidden="true" />}
```

> The `.session__attn` pip is a non-color shape cue (a11y). It sits between the dot
> and the D4 `SessionGlyph`, so the runtime icon is untouched.

- [ ] **Step 2: Float attention sessions to the top in non-manual sorts**

In the `Sidebar` component, after `const sorted = useMemo(() => sortSessions(filtered, sort), [filtered, sort]);`, add a stable float pass that only applies when sort is not manual:

```ts
  // Float needs-attention sessions toward the top — but only when the order is
  // already derived (sort !== 'manual'), so we never clobber the user's explicit
  // manual order (D2/reorder). Stable: attention sessions keep their relative
  // order, as do the rest.
  const ordered = useMemo(() => {
    if (sort === 'manual') return sorted;
    const attn = sorted.filter((s) => s.needsAttention);
    if (attn.length === 0) return sorted;
    const rest = sorted.filter((s) => !s.needsAttention);
    return [...attn, ...rest];
  }, [sorted, sort]);
```

Then replace every later use of `sorted` in the render-group building + empty-state
checks with `ordered`. Specifically:

In `renderGroups`'s `useMemo`, change `for (const s of sorted)` → `for (const s of ordered)`,
the default-return `return [{ path: null, sessions: sorted }];` → `return [{ path: null, sessions: ordered }];`,
and the dependency array `[sorted, grouped, sort]` → `[ordered, grouped, sort]`.

In the empty-state JSX, change `sessions.length > 0 && sorted.length === 0` →
`sessions.length > 0 && ordered.length === 0`.

> Within grouped mode the float runs over the flat `ordered` list before grouping,
> so an attention session rises to the top of its own project group (groups are
> rebuilt by first appearance in `ordered`). That floats attention within its group
> without reordering whole projects — consistent with the spec.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add webview/components/sidebar.tsx
git commit -m "feat(D5): sidebar busy dot + attention highlight + float in derived sorts"
```

---

## Task 7: Styles — busy pulse + attention highlight (reduced-motion safe)

**Files:**
- Modify: `webview/styles.css` (near the existing `.dot` / `.session` rules ~lines 657-687)

- [ ] **Step 1: Add the busy pulse, attention highlight, and pip**

After the existing `.dot--done { ... }` rule (~line 677), add:

```css
/* D5: busy = recent PTY output. The status dot keeps its color and pulses. */
.dot--busy {
  animation: dot-pulse 1.1s ease-in-out infinite;
}
@keyframes dot-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 var(--accent-soft);
    opacity: 1;
  }
  50% {
    box-shadow: 0 0 0 4px transparent;
    opacity: 0.55;
  }
}

/* D5: a background task finished and wants input — highlight + leading accent bar. */
.session--attention {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 0 var(--accent);
}
.session--attention:hover {
  background: var(--accent-soft);
}
/* Small non-color shape cue (accessibility) alongside the dot. */
.session__attn {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-top: 6px;
  flex: 0 0 auto;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* Respect reduced motion: no pulse; show a steady busy tint instead. */
@media (prefers-reduced-motion: reduce) {
  .dot--busy {
    animation: none;
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
}
```

> Reuses semantic vars (`--accent`, `--accent-soft`) — no raw hex. The app's
> `reduceMotion` setting toggles a `prefers-reduced-motion`-equivalent class on the
> root (verify it maps to this media query; if it sets `data-reduce-motion`, mirror
> the rule under that selector too).

- [ ] **Step 2: Verify reduce-motion wiring**

Run: `npx rg "reduce-motion|reduceMotion|prefers-reduced-motion" webview/styles.css webview/settings.tsx`
Expected: identify whether reduced motion is a CSS media query, a root `data-*`
attribute, or a class. If it is a `data-reduce-motion="true"` attribute on `:root`,
add a mirrored rule:

```css
:root[data-reduce-motion='true'] .dot--busy {
  animation: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}
```

(If reduced motion is purely the media query, the Step 1 rule already covers it; skip this.)

- [ ] **Step 3: Build the webview to confirm CSS is valid**

Run: `npm run build`
Expected: PASS (esbuild copies/bundles styles without error).

- [ ] **Step 4: Commit**

```bash
git add webview/styles.css
git commit -m "feat(D5): busy pulse + attention highlight styles (reduced-motion safe)"
```

---

## Task 8: Mock — exercise busy + needs-attention in the browser preview

**Files:**
- Modify: `webview/mock.ts`

- [ ] **Step 1: Flag two mock sessions**

In `webview/mock.ts`, in `mockGroups`, set `busy: true` on the `portfolio-tests`
session and `needsAttention: true` on the `vscode-ext` session, e.g.:

```ts
      {
        id: 'portfolio-tests',
        name: 'Test Runner',
        agentId: 'shell:gitbash',
        projectPath: 'G:/awby/projects/nextjs-portfolio',
        status: 'running',
        createdAt: ago(30),
        lastActiveAt: ago(1),
        busy: true,
      },
```

```ts
      {
        id: 'vscode-ext',
        name: 'Terminal UI',
        agentId: 'shell:powershell',
        projectPath: 'G:/awby/projects/terminal-ui',
        status: 'running',
        createdAt: ago(4),
        lastActiveAt: ago(4),
        needsAttention: true,
      },
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (the fields are optional on `Session`).

- [ ] **Step 3: Commit**

```bash
git add webview/mock.ts
git commit -m "test(D5): mock sessions exercise busy + needs-attention preview states"
```

---

## Task 9: Full gates + runtime proof

- [ ] **Step 1: Run the verify gate**

Run: `npm run verify`
Expected: format-check + lint + typecheck + tests + security all PASS.
Capture to `.autoloop/evidence/busy-indicator-verify.log`.

- [ ] **Step 2: Run the build gate**

Run: `npm run build`
Expected: PASS. Append to the same evidence log.

- [ ] **Step 3: Runtime proof via Playwright over HTTP**

Build the webview, serve the built output over HTTP (file:// is blocked), drive with
Playwright. Confirm: the busy mock session shows the pulsing dot; the needs-attention
mock session shows the highlight + floats up under a non-manual sort; selecting it
(in the app) clears attention via `focus` (host path — note this needs the real app
for the clear, the renderer highlight + float are mock-driven). Screenshots to
`%TEMP%\claude-scratch\` only. Observations + paths → `.autoloop/evidence/busy-indicator-runtime.txt`.

- [ ] **Step 4: Code review + verification-before-completion**

Invoke `superpowers:requesting-code-review`; address blocking findings; then
`superpowers:verification-before-completion`. Never weaken a gate.

---

## Self-Review

**Spec coverage:**
- Busy = recent output → Task 1 (`recordOutput`/busy window), Task 4 (host wiring). ✓
- Idle = quiescence window → Task 1 (`sweep`), Task 4 (sweep timer). ✓
- needsAttention = busy→idle while unfocused → Task 1 (AC2), incl. focused-no-flag (AC3). ✓
- Focus clears attention → Task 1 (AC4), Task 4 (`focus` handler), Task 5 (renderer posts). ✓
- Throttle/coalesce → Task 4 (120 ms trailing broadcaster; recordOutput change-gate). ✓
- Busy renders (animated dot, composes with D4 icon) → Task 6 Step 1, Task 7. ✓
- Attention renders (highlight + non-color pip) → Task 6 Step 1, Task 7. ✓
- Float to top, non-destructive (only non-manual sort) → Task 6 Step 2. ✓
- Reduced motion → Task 7 (media query + optional data-attr mirror). ✓
- Back-compat / preview (optional flags, mock) → Task 2, Task 8. ✓
- Unit tests for the pure machine incl. all transitions → Task 1. ✓
- Gates + runtime proof → Task 9. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; the `focus`
implementation has an explicit simplified final form. ✓

**Type consistency:** `SessionActivity` methods (`recordOutput`, `sweep`, `focus`,
`forget`, `statusOf`, `apply`) are named identically across Tasks 1, 4. `busy`/
`needsAttention` field names match across types, host, renderer, mock, CSS classes
(`dot--busy`, `session--attention`, `session__attn`). ✓

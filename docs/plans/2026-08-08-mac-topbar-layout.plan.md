# macOS Top Bar Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebase the `macos-window-chrome` branch onto current `main` and rework its mac-only top bar layout so traffic lights + back/forward own the left, the search pill stays centered, and the attention chip + Workspace/Board/Canvas tabs + logo own the right — with no duplicate min/max/close buttons on mac at all.

**Architecture:** One React component (`webview/components/top-bar.tsx`) branches its three flex regions on a single `isMac` boolean instead of rendering the same elements in the same place on every platform. `isMac` becomes a named export of `webview/shortcuts.ts` (already computed there) instead of a second, private declaration in `top-bar.tsx`. Two small config values change alongside it: the native traffic-light y-offset in `electron/main.ts` (stale, tuned for a topbar height that no longer matches reality) and the mac-only CSS inset in `webview/styles.css`.

**Tech Stack:** TypeScript, React 19, Electron 43 (`BrowserWindow` `trafficLightPosition`), plain CSS custom properties (no CSS-in-JS).

## Global Constraints

- macOS only (`isMac`-gated). Windows/Linux render exactly what they render today — same JSX, same CSS, zero behavior change. (Spec: Scope/In, Scope/Out)
- `isMac` has exactly one definition in the codebase (`webview/shortcuts.ts`), imported everywhere it's needed. No second/private copy. (Spec: Acceptance criteria)
- No new main↔renderer IPC for density or fullscreen changes — live re-centering of the traffic lights on density toggle or fullscreen enter/exit is explicitly out of scope for this change. (Spec: Scope/Out, Edge cases)
- Reference spec: `docs/specs/2026-08-08-mac-topbar-layout.md`.

---

### Task 1: Rebase `macos-window-chrome` and rewrite the mac top bar layout

**Files:**
- Modify: `webview/shortcuts.ts:172` (add `export` to the existing `isMac` const)
- Modify: `webview/components/top-bar.tsx` (full rewrite of the conflicted regions — imports, the `logo`/`nav`/`viewswitch`/`attnchipEl` variables, and the three flex regions' JSX)
- Verify (auto-merges without conflict, no manual edit expected in this task): `electron/main.ts`, `webview/styles.css`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the first task).
- Produces: `isMac` (boolean, exported from `webview/shortcuts.ts`) — consumed by `top-bar.tsx` in this same task, and available to any other renderer file going forward. `TopBar`'s own props are unchanged (no signature change), so nothing downstream needs updating.

- [ ] **Step 1: Check out the branch and start the rebase**

```bash
git checkout macos-window-chrome
git rebase main
```

Expected: `electron/main.ts` and `webview/styles.css` auto-merge cleanly (git prints "Auto-merging" for both, no conflict markers). `webview/components/top-bar.tsx` conflicts — git stops with `CONFLICT (content): Merge conflict in webview/components/top-bar.tsx` and leaves the rebase paused.

- [ ] **Step 2: Export `isMac` from `shortcuts.ts`**

In `webview/shortcuts.ts`, change line 172 from:

```typescript
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
```

to:

```typescript
export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
```

Nothing else in that file changes — every other reference to `isMac` in `shortcuts.ts` keeps working since it's the same module-local binding, now also exported.

- [ ] **Step 3: Replace the whole of `webview/components/top-bar.tsx` with the resolved version**

Open the file — it has conflict markers from the paused rebase. Replace its entire contents (imports through the closing `}`) with:

```tsx
import { useEffect, useState } from 'react';
import { attentionChipLabel, attentionSessions } from '../../src/attention';
import type { Session } from '../../src/types';
import { win } from '../bridge';
import { CENTER_VIEWS, type CenterView } from '../center-view';
import {
  IconBoard,
  IconChevron,
  IconClose,
  IconDoc,
  IconGraph,
  IconSearch,
  IconWinMax,
  IconWinMin,
  IconWinRestore,
} from '../icons';
import { isMac } from '../shortcuts';

const VIEW_ICON: Record<CenterView, JSX.Element> = {
  editor: <IconDoc size={14} />,
  board: <IconBoard size={14} />,
  canvas: <IconGraph size={14} />,
};

export function TopBar({
  isDev,
  onOpenSearch,
  onBack,
  onForward,
  canBack,
  canForward,
  centerView,
  onSelectView,
  sessions,
  onFocusAttention,
  onContextMenu,
}: {
  isDev?: boolean;
  // Open the omni-search overlay (also bound to Mod+P). The center pill triggers it.
  onOpenSearch: () => void;
  onBack: () => void;
  onForward: () => void;
  canBack: boolean;
  canForward: boolean;
  centerView: CenterView;
  onSelectView: (view: CenterView) => void;
  /** Every session, for the aggregate attention chip's count. */
  sessions: Session[];
  /** Focus one session — the chip hands it the first one waiting on the user. */
  onFocusAttention: (sessionId: string) => void;
  // Right-click the top bar to open the panel show/hide menu.
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [maxed, setMaxed] = useState(false);

  useEffect(() => {
    if (!win) return;
    void win.isMaximized().then(setMaxed);
    return win.onMaximizeChange(setMaxed);
  }, []);

  const waiting = attentionSessions(sessions);
  const chipLabel = attentionChipLabel(waiting.length);

  const logo = (
    <img
      src={isDev ? './icon-dev.png' : './icon.png'}
      alt={isDev ? 'Conduit (dev)' : 'Conduit'}
      title={isDev ? "Development build — isolated 'Conduit (dev)' profile" : undefined}
      className="topbar__logo"
    />
  );

  // Labelled segmented control: Board and Canvas were unlabelled icons in a corner
  // and nobody found them (brief §7.8), so the words are not optional.
  const viewswitch = (
    <div className="viewswitch" role="tablist" aria-label="Center view">
      {CENTER_VIEWS.map((v) => {
        const active = v.id === centerView;
        return (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`viewswitch__btn${active ? ' viewswitch__btn--on' : ''}`}
            title={v.label}
            onClick={() => onSelectView(v.id)}
          >
            {VIEW_ICON[v.id]}
            <span className="viewswitch__label">{v.short}</span>
          </button>
        );
      })}
    </div>
  );

  const nav = (
    <div className="topbar__nav">
      <button className="iconbtn iconbtn--rot" title="Back" disabled={!canBack} onClick={onBack}>
        <IconChevron />
      </button>
      <button className="iconbtn" title="Forward" disabled={!canForward} onClick={onForward}>
        <IconChevron />
      </button>
    </div>
  );

  const attnchipEl = chipLabel ? (
    <button
      type="button"
      className="attnchip"
      title={`Go to ${waiting[0].name}`}
      onClick={() => onFocusAttention(waiting[0].id)}
    >
      <span className="attnchip__dot" aria-hidden />
      {chipLabel}
    </button>
  ) : null;

  const winctl = (
    <div className="winctl">
      <button className="winctl__btn" title="Minimize" onClick={() => win?.minimize()}>
        <IconWinMin size={12} />
      </button>
      <button
        className="winctl__btn"
        title={maxed ? 'Restore' : 'Maximize'}
        onClick={() => win?.toggleMaximize()}
      >
        {maxed ? <IconWinRestore size={12} /> : <IconWinMax size={12} />}
      </button>
      <button
        className="winctl__btn winctl__btn--close"
        title="Close"
        onClick={() => win?.close()}
      >
        <IconClose size={12} />
      </button>
    </div>
  );

  return (
    <header className={`topbar${isMac ? ' topbar--mac' : ''}`} onContextMenu={onContextMenu}>
      <div className="topbar__left">
        {isMac ? (
          nav
        ) : (
          <>
            {logo}
            {viewswitch}
          </>
        )}
      </div>

      {/* Center omni-search pill (R4.13): click or Mod+P opens the overlay across
          Sessions / Agents / Files (R5.4). */}
      <div className="topbar__center">
        <button
          type="button"
          className="omnibar"
          onClick={onOpenSearch}
          title="Search sessions, agents, files (Ctrl+P)"
          aria-label="Search sessions, agents, files"
          aria-keyshortcuts="Control+P"
        >
          <IconSearch size={14} className="omnibar__icon" />
          <span className="omnibar__placeholder">Search sessions, agents, files…</span>
        </button>
      </div>

      <div className="topbar__right">
        {isMac ? (
          <>
            {attnchipEl}
            {viewswitch}
            {logo}
          </>
        ) : (
          <>
            {nav}
            {attnchipEl}
            {winctl}
          </>
        )}
      </div>
    </header>
  );
}
```

`winctl` is unconditional here — the `isMac` check that skips rendering it lives in the JSX below, not in this variable.

- [ ] **Step 4: Stage and continue the rebase**

```bash
git add webview/shortcuts.ts webview/components/top-bar.tsx
git rebase --continue
```

Expected: `Successfully rebased and updated refs/heads/macos-window-chrome.`

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: exits 0 on both tsconfigs (host + webview — this repo has two, see project CLAUDE.md). If `JSX.Element` (used in `VIEW_ICON`'s type, kept from the pre-conflict original) errors under the webview tsconfig, use `ReactJSX.Element` with `import type { JSX as ReactJSX } from 'react'` restored instead — check what the equivalent current-`main` file (`git show main:webview/components/top-bar.tsx`) uses before deciding, since this is the kind of global-JSX-namespace fix a dependency bump (React 19 / TypeScript 7) can require project-wide.

- [ ] **Step 6: Commit**

The `rebase --continue` in Step 4 already created the commit (it replays the branch's original commit with the new content). Nothing further to commit here — Task 2 adds a second, separate commit for the offset/CSS fixes.

---

### Task 2: Fix the stale traffic-light offset and mac-only CSS padding

**Files:**
- Modify: `electron/main.ts` (the `trafficLightPosition` comment + `y` value, near the `BrowserWindow` constructor — search for `trafficLightPosition` to find it)
- Modify: `webview/styles.css` (the `.topbar--mac` rule and the comment above it — search for `.topbar--mac` to find it)

**Interfaces:**
- Consumes: nothing new — these are standalone constant/CSS tweaks, unrelated to Task 1's component structure.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Fix `electron/main.ts`'s traffic-light comment and offset**

Find:

```typescript
    // macOS only: nudge the native traffic lights to sit vertically centered in the
    // 44px custom top bar (--density-topbar-h). No-op off-darwin (no traffic lights).
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 13, y: 14 } } : {}),
```

Replace with:

```typescript
    // macOS only: nudge the native traffic lights to sit vertically centered in the
    // default 57px custom top bar (--density-topbar-h = round(38px * 1.5, 1px) at the
    // default density — NOT 44px, that was stale). Compact density (~47px) and
    // fullscreen (lights hidden) are knowingly imperfect here — see
    // docs/specs/2026-08-08-mac-topbar-layout.md Edge cases. No-op off-darwin.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 13, y: 20 } } : {}),
```

`y: 20` is a starting estimate for centering in a 57px bar — Task 3's manual verification is where this gets confirmed or nudged against the real rendered window.

- [ ] **Step 2: Drop the now-unneeded right padding in `styles.css`**

Find:

```css
/* macOS: clear the native traffic lights (drawn at top-left by titleBarStyle:'hidden',
   nudged via trafficLightPosition in main.ts) with a comfortable gap before the first
   control (collapse button). The logo moves to topbar__right on mac (see top-bar.tsx). */
.topbar--mac {
  padding-left: 92px;
  padding-right: 24px;
}
```

Replace with:

```css
/* macOS: clear the native traffic lights (drawn at top-left by titleBarStyle:'hidden',
   nudged via trafficLightPosition in main.ts) with a comfortable gap before the first
   control (back/forward nav). Logo + tabs + attention chip move to topbar__right on
   mac (see top-bar.tsx). */
.topbar--mac {
  padding-left: 92px;
}
```

The old `padding-right: 24px` existed only to balance the previous design's right-side-only logo; the new right region (badge → tabs → logo) already has its own `gap` from the existing `.topbar__right` rule, so it's dropped rather than kept and re-tuned.

- [ ] **Step 3: Typecheck + lint (CSS has no typecheck, but confirm nothing else broke)**

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add electron/main.ts webview/styles.css
git commit -m "fix(window): correct stale traffic-light offset and mac topbar padding"
```

---

### Task 3: Verify on real macOS hardware and run the full gate

**Files:** none (verification only — may produce fixup edits to Task 1/2's files if something looks wrong, in which case amend those commits rather than leaving a third throwaway commit)

**Interfaces:**
- Consumes: the finished branch from Tasks 1–2.
- Produces: nothing — this is the last task.

- [ ] **Step 1: Build and launch the app**

Use this project's own run pattern for an Electron app (check for a project `run`-style skill or script first; otherwise `npm run dev` / equivalent from `package.json`).

- [ ] **Step 2: Visually verify the default-density layout**

Check, with the window at default density:
- Traffic lights are vertically centered in the top bar (adjust `y` in `electron/main.ts` from Step 1 of Task 2 and reload if not — there is no formula that guarantees this without eyeballing it against the actual rendered chrome).
- Back/forward buttons sit immediately to the right of the lights, with no overlap.
- The search pill is still centered on the window.
- On the right: the attention chip (if any session needs attention — trigger one if needed to check), then Workspace/Board/Canvas tabs, then the logo flush at the right edge.
- No minimize/maximize/close buttons render anywhere.

- [ ] **Step 3: Verify window drag**

Drag the window by the empty space in the top bar (between the lights/nav and the search pill, and between the search pill and the right-side group). Confirm the window actually moves — this is what `-webkit-app-region: drag` on `.topbar` is for, and it's easy to accidentally break by wrapping something in a non-drag container.

- [ ] **Step 4: Note (don't fix) the known compact-density / fullscreen cosmetic gap**

Switch density to Compact in Settings and glance at the top bar — the lights will likely sit slightly off-center. Toggle fullscreen and glance again — the left inset will look like dead space since the lights are hidden. Both are the explicitly deferred follow-up from the spec (Edge cases). Confirm they're cosmetic only (nothing overlaps, nothing is unusable) and move on — do not build the IPC-driven live-repositioning fix as part of this plan.

- [ ] **Step 5: Run the full verification gate**

```bash
npm run verify
```

Expected: exits 0 (format-check + lint + dead-code + duplication + typecheck + tests + security). Per project CLAUDE.md, never disable/downgrade/narrow any of its checks to make this pass — fix the code instead.

- [ ] **Step 6: If Step 2 needed an offset change, amend Task 2's commit**

```bash
git add electron/main.ts
git commit --amend --no-edit
```

(Only if the `y` value changed — otherwise skip. Amending here is fine since this commit hasn't been pushed to the open PR yet.)

## Self-Review

**Spec coverage:** Scope/In (mac-only rearrangement, remove `.winctl`, `isMac` export, offset/comment fix) → Tasks 1–2. Edge cases (compact/fullscreen deferred, drag region, non-mac untouched) → Task 3 Steps 3–4 verify these explicitly rather than silently assuming them. Acceptance criteria → Task 3 Step 2 checks each bullet directly. Test plan (manual on real hardware, Windows/Linux by inspection) → Task 3 as a whole.

**Placeholder scan:** no TBD/TODO; every step has literal code or a literal command.

**Type consistency:** `TopBar`'s props are untouched (same names/types as current `main`), so no caller elsewhere in the codebase needs a change. `isMac` is `boolean` everywhere it's used (JSX conditional and template string), consistent between `shortcuts.ts`'s definition and `top-bar.tsx`'s two usages.

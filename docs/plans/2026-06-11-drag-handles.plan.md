# Drag Handles (B1) Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax. This plan is executed
> inline by the build agent in one session.

**Goal:** Remove the explicit panel drag-handle widgets (`.panel__grip` strip,
`.tabbar__grip` glyph) and the permanent grab-hand cursor; make a panel-move drag
initiate from the panel's own bar background and the editor tab-bar background,
guarded so it never hijacks in-bar controls or the existing tab/session reorder drags.

**Architecture:** A pure predicate `isPanelDragTarget(target, barEl)` decides whether a
`dragstart` originated on the bar's draggable background vs. an interactive/own-drag
control (via `closest(INTERACTIVE_SELECTOR)`). `PanelFrame` turns its existing
`.panel__grip` element into an empty, chrome-free draggable bar that calls the dock's
`onDragStart` only when the predicate passes. `DocTabs` makes the `.tabbar` itself the
center panel's drag source (the `moveGrip` carries only `onDragStart`/`onDragEnd`; the
drop target stays on `.center` in `center-pane.tsx`, unchanged). CSS for the grip
widgets + permanent `cursor: grab` is removed; `grabbing` shows only while dragging.

**Tech Stack:** React + TypeScript (webview), Vitest unit tests, Biome (single quotes,
semicolons, 2-space, width 100, kebab-case files). Renderer guards `window.agentDeck`
absence (host calls route through `bridge`/`update`, which no-op without the host).

---

### Task 1: Pure drag-target guard + unit test

**Files:**
- Create: `webview/drag-guard.ts`
- Test: `test/unit/drag-guard.test.ts`

- [ ] **Step 1: Write the failing test** (`test/unit/drag-guard.test.ts`)

```ts
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import { isPanelDragTarget } from '../../webview/drag-guard';

describe('isPanelDragTarget', () => {
  let doc: Document;
  beforeEach(() => {
    doc = new JSDOM('<!DOCTYPE html>').window.document;
  });
  const bar = (html: string) => {
    const el = doc.createElement('div');
    el.className = 'bar';
    el.innerHTML = html;
    doc.body.appendChild(el);
    return el;
  };

  it('true when the target is the bar background itself', () => {
    const el = bar('<span class="filler"></span>');
    expect(isPanelDragTarget(el, el)).toBe(true);
  });

  it('true for a plain non-interactive descendant', () => {
    const el = bar('<span class="filler">x</span>');
    expect(isPanelDragTarget(el.querySelector('.filler'), el)).toBe(true);
  });

  it('false when target is a button (even nested)', () => {
    const el = bar('<button><svg><path></path></svg></button>');
    expect(isPanelDragTarget(el.querySelector('path'), el)).toBe(false);
  });

  it('false for an input', () => {
    const el = bar('<input />');
    expect(isPanelDragTarget(el.querySelector('input'), el)).toBe(false);
  });

  it('false for an own-draggable child (a tab/session card)', () => {
    const el = bar('<div class="tab" draggable="true"><span>t</span></div>');
    expect(isPanelDragTarget(el.querySelector('span'), el)).toBe(false);
  });

  it('false for a session card by class even when not currently draggable', () => {
    const el = bar('<div class="session"><span>s</span></div>');
    expect(isPanelDragTarget(el.querySelector('span'), el)).toBe(false);
  });

  it('false for a contenteditable / rename input region', () => {
    const el = bar('<input class="session__edit" />');
    expect(isPanelDragTarget(el.querySelector('input'), el)).toBe(false);
  });

  it('false when target is null or outside the bar', () => {
    const el = bar('');
    const outside = doc.createElement('div');
    doc.body.appendChild(outside);
    expect(isPanelDragTarget(null, el)).toBe(false);
    expect(isPanelDragTarget(outside, el)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `npx vitest run test/unit/drag-guard.test.ts`
  Expected: FAIL (`isPanelDragTarget` not found).

- [ ] **Step 3: Implement** (`webview/drag-guard.ts`)

```ts
// Controls / own-draggable children that must NEVER trigger a panel-move drag.
// `.tab` and `.session` are kept explicitly: a non-draggable session card (manual
// sort off or a filter active) loses `[draggable="true"]`, so the class is the only
// thing that still excludes it from the bar background.
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label,' +
  ' [role="button"], [role="menuitem"], [draggable="true"],' +
  ' [contenteditable="true"], .tab, .session';

/**
 * True only when a drag that started on `target` should move the whole panel: the
 * pointer is on the bar (`barEl`) background, not on an interactive control or a
 * child that owns its own drag. Pure + DOM-read-only so it is unit-testable.
 */
export function isPanelDragTarget(target: Element | null, barEl: Element): boolean {
  if (!target || !barEl.contains(target)) return false;
  return target.closest(INTERACTIVE_SELECTOR) === null;
}
```

- [ ] **Step 4: Run test, verify it passes** — `npx vitest run test/unit/drag-guard.test.ts`
  Expected: PASS. (If `jsdom` import fails, see Task 1 note below.)

> **Note:** Vitest config — check `vitest.config.*` for `environment`. If tests run in
> `node` (no DOM), the explicit `new JSDOM(...)` in the test supplies the document, so
> no global DOM is needed. `jsdom` is already a transitive dev dep via vitest; if the
> import is missing, fall back to constructing elements through the `JSDOM` window only
> (do not add a new dependency without checking `package.json` first).

---

### Task 2: Repurpose `.panel__grip` into a chrome-free draggable bar

**Files:**
- Modify: `webview/components/panel-frame.tsx`

The `.panel__grip` is currently the ONLY bar element (there is no separate header). Keep
it as a slim drag strip but remove the title text + dots + tooltip, and gate `dragstart`
on the guard so a future control placed in it won't hijack the drag.

- [ ] **Step 1: Import the guard** — add at top of `panel-frame.tsx`:

```ts
import { isPanelDragTarget } from '../drag-guard';
```

- [ ] **Step 2: Replace the grip JSX** (currently lines ~83-95). Old:

```tsx
      <div
        className="panel__grip"
        draggable
        title={`Drag to move the ${title} panel`}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          dock.onDragStart();
        }}
        onDragEnd={dock.onDragEnd}
      >
        <span className="panel__griptitle">{title}</span>
        <span className="panel__gripdots">⠿</span>
      </div>
```

New (empty, chrome-free, guarded; keep an accessible label for the drag surface):

```tsx
      <div
        className="panel__bar"
        draggable
        aria-label={`Move ${title} panel`}
        onDragStart={(e) => {
          if (!isPanelDragTarget(e.target as Element, e.currentTarget)) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.effectAllowed = 'move';
          dock.onDragStart();
        }}
        onDragEnd={dock.onDragEnd}
      />
```

> `title` prop is still consumed by `aria-label`; the visible chrome (`panel__griptitle`,
> `panel__gripdots`) is gone. The `e.target`/`e.currentTarget` cast is fine — React's
> synthetic drag event carries DOM nodes.

- [ ] **Step 3: Build to typecheck** — `npm run build` (or `npm run typecheck`).
  Expected: no TS errors in `panel-frame.tsx`.

---

### Task 3: Make `.tabbar` the center panel's drag source (drop the `⠿` grip)

**Files:**
- Modify: `webview/components/doc-tabs.tsx`

`moveGrip` carries only `{ onDragStart, onDragEnd }`. Move those off the deleted
`.tabbar__grip` glyph onto the `.tabbar` container, guarded — so dragging the tab-bar
background moves the panel, but dragging a tab still does the intra-bar reorder (tabs are
`<button class="tab" draggable>`, excluded by the guard).

- [ ] **Step 1: Import the guard** — top of `doc-tabs.tsx`:

```ts
import { isPanelDragTarget } from '../drag-guard';
```

- [ ] **Step 2: Remove the `.tabbar__grip` block** (lines ~30-43) entirely.

- [ ] **Step 3: Wire the guarded drag onto the `.tabbar` div.** Change the opening tag:

```tsx
    <div className="tabbar">
```

to:

```tsx
    <div
      className="tabbar"
      draggable={!!moveGrip}
      onDragStart={
        moveGrip
          ? (e) => {
              if (!isPanelDragTarget(e.target as Element, e.currentTarget)) return;
              e.dataTransfer.effectAllowed = 'move';
              moveGrip.onDragStart();
            }
          : undefined
      }
      onDragEnd={moveGrip?.onDragEnd}
    >
```

> A tab's own `onDragStart` (doc-tabs.tsx) stops the event from being a panel move
> because the guard sees `.tab` / `[draggable="true"]` and returns false; the tab's
> handler sets `dragIdRef` and runs the reorder. Do NOT `e.preventDefault()` on the
> tabbar when the guard fails (that would block the child tab's drag) — just return so
> the child's drag proceeds.
> Update the `moveGrip` JSDoc comment (was "Drag handle to re-dock…") to reflect it is
> now the tab-bar background drag, not a grip widget.

- [ ] **Step 4: Build to typecheck** — `npm run build`. Expected: no TS errors.

---

### Task 4: Remove grip CSS + the permanent grab-hand; add a slim quiet bar

**Files:**
- Modify: `webview/styles.css`

- [ ] **Step 1: Delete the `.panel__grip*` rules** — the blocks at:
  - `.panel__grip { … cursor: grab … }`
  - `.panel__grip:active { cursor: grabbing }`
  - `.panel__grip:hover { … }`
  - `.panel__griptitle { … }`
  - `.panel__gripdots { … }`

  Replace them with a single quiet bar rule (keeps a slim grab surface, no permanent
  hand — `grab` only on hover of the true background, `grabbing` while dragging):

```css
.panel__bar {
  height: 26px;
  flex: 0 0 auto;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.panel__bar:hover {
  cursor: grab;
}
.panel__bar:active {
  cursor: grabbing;
}
```

- [ ] **Step 2: Delete the `.tabbar__grip*` rules** — `.tabbar__grip`,
  `.tabbar__grip:hover`, `.tabbar__grip:active`. Add a hover affordance on the bar
  background that does NOT cover tabs (tabs keep `cursor: pointer`):

```css
/* tab-bar background is the center panel's drag surface (no grip widget) */
.tabbar:active {
  cursor: grabbing;
}
```

> Do NOT add `.tabbar:hover { cursor: grab }` — the tab buttons fill most of the bar and
> already set `cursor: pointer`; a bar-wide grab cursor would flicker over them. Leave
> the empty background with the default cursor; `grabbing` appears only mid-drag. This
> satisfies "no permanent grab-hand."

- [ ] **Step 3: Fix the backdrop-blur selector** — at the `:root:not([data-background="none"])`
  block (~line 2107) replace `.panel__grip` with `.panel__bar` in the comma list so the
  new slim bar still gets the surface background + blur:

```css
:root:not([data-background="none"]) .panel__bar {
```

(keep the other selectors in that group as-is).

- [ ] **Step 4: Search for stragglers** — grep the repo for `panel__grip`, `griptitle`,
  `gripdots`, `tabbar__grip`. Expected: zero matches outside this plan/spec + the old
  dockable-layout spec doc (leave the historical spec doc untouched).

---

### Task 5: Verify + build gates (capture evidence)

**Files:** none (evidence under `.autoloop/evidence/`)

- [ ] **Step 1:** `npm run verify` → tee to `.autoloop/evidence/drag-handles-verify.log`.
  Expected: format-check + lint + typecheck + tests + security all pass; drag-guard test
  green; layout + reorder tests still green.

- [ ] **Step 2:** `npm run build` → append to the same log. Expected: clean build.

- [ ] **Step 3:** If verify flags Biome formatting, run `npm run format` (or the
  project's writer) and re-run verify. Never weaken a gate.

---

### Task 6: Runtime proof (Playwright over HTTP) + review

**Files:** evidence under `.autoloop/evidence/`, screenshots to `%TEMP%\claude-scratch\`.

- [ ] **Step 1:** Build the webview, serve the built `index.html` over HTTP (file:// is
  blocked per project memory), drive with Playwright. Confirm: (a) no `.panel__grip` /
  `.tabbar__grip` in the DOM and no permanent `cursor: grab`; (b) `dragstart` on the
  `.panel__bar` / `.tabbar` background sets the drag state (region drag), while
  `dragstart` synthesized on the three-dot button / a tab does NOT; (c) clicking the
  three-dot button opens the menu, typing in the filter works, tab close works; (d) tab
  reorder still works. Panel drop is hard to simulate — at minimum prove initiator-guard
  + chrome removal via DOM/state inspection + the unit tests. Screenshots to
  `%TEMP%\claude-scratch\` only. Observations + paths → `.autoloop/evidence/drag-handles-runtime.txt`.

- [ ] **Step 2:** Invoke `superpowers:requesting-code-review`; address blocking findings.

- [ ] **Step 3:** `superpowers:verification-before-completion` — re-run the gates, confirm
  green, then report. `git status` shows only intended files (+ pre-existing `board.json`).

---

## Self-Review

- **Spec coverage:** grip removal (T2/T3/T4), tabbar__grip removal (T3/T4), no permanent
  grab-hand (T4), bar-background initiates drag (T2/T3), guard predicate + invariants
  (T1), controls/tab-reorder/session-reorder preserved (T1 selector incl. `.session`,
  `.tab`, inputs), `window.agentDeck`-absent (no new host calls), acceptance criteria
  (T5 unit + T6 runtime). D-1 (tabs keep reorder, panel-move from tab-bar background) =
  T3. D-2 (slim quiet header bar) = T2/T4. All covered.
- **Placeholder scan:** none — every code step shows full code.
- **Type consistency:** `isPanelDragTarget(target, barEl)` signature identical across
  T1/T2/T3; class renamed `panel__grip → panel__bar` consistently in T2/T4; `moveGrip`
  shape `{ onDragStart, onDragEnd }` unchanged.

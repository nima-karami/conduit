# Webview Papercuts (K4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 8 confirmed renderer defects in Conduit's webview layer: palette scroll, global shortcuts while typing, board debounce flush, new-session dep array, confirm-dialog Enter, doc-tabs button-in-button, missing --code-surface CSS var, and duplicate .filerow CSS.

**Architecture:** Each fix is surgical and isolated — no cross-cutting refactors. Two new pure modules are introduced: `webview/typing-guard.ts` (shortcut typing-entry rules) and `webview/use-debounced-flush.ts` (shared debounce-with-flush hook). Evidence written to `.autoloop/evidence/webview-papercuts.md`.

**Tech Stack:** React 18, TypeScript, Vitest, Biome, CSS custom properties, Electron renderer webview

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `webview/components/command-palette.tsx` | Modify | Fix scroll-into-view deps (Fix 1) |
| `webview/typing-guard.ts` | Create | Pure module: isTypingEntry + isComboAllowedWhileTyping (Fix 2) |
| `webview/app.tsx` | Modify | Early-return in global keydown for typing fields (Fix 2) |
| `webview/use-debounced-flush.ts` | Create | Shared hook: debounce timer + flush on unmount (Fix 3) |
| `webview/components/board-view.tsx` | Modify | Use useDebouncedFlush for board saves + pipeline saves (Fix 3) |
| `webview/components/architecture-view.tsx` | Modify | Use useDebouncedFlush for arch saves (Fix 3) |
| `webview/components/new-session-modal.tsx` | Modify | Fix deps from repos.find to repos (Fix 4) |
| `webview/components/confirm-dialog.tsx` | Modify | Skip Enter handler when Cancel is focused (Fix 5) |
| `webview/components/doc-tabs.tsx` | Modify | Replace nested button with span[role=button] for close (Fix 6) |
| `webview/styles.css` | Modify | Define --code-surface in :root (Fix 7), merge .filerow blocks (Fix 8) |
| `test/unit/typing-guard.test.ts` | Create | Tests for typing guard pure functions |
| `test/unit/use-debounced-flush.test.ts` | Create | Tests for debounced-flush core logic |
| `docs/specs/webview-papercuts.md` | Create | One-section-per-fix spec |
| `.autoloop/evidence/webview-papercuts.md` | Create | Per-fix: located-at, fixed-how |

---

## Task 1 — Fix #1: Command palette scroll-into-view

**Files:**
- Modify: `webview/components/command-palette.tsx:87-95`

- [ ] **Step 1: Locate the broken effect**

Current code at line 87-95 of `webview/components/command-palette.tsx`:
```tsx
useEffect(() => {
  setActive(0);
}, []);

// Keep the active row in view.
useEffect(() => {
  const el = listRef.current?.querySelector('[data-active="true"]');
  el?.scrollIntoView({ block: 'nearest' });
}, []);
```
Both effects have empty `[]` deps — the scroll-into-view never re-runs on arrow key navigation. The `setActive(0)` effect is also unnecessary (useState already initializes to 0).

- [ ] **Step 2: Fix the deps**

Replace both effects with a single scroll effect keyed on `active`:
```tsx
// Keep the active row in view whenever active changes (arrow-key nav).
useEffect(() => {
  const el = listRef.current?.querySelector('[data-active="true"]');
  el?.scrollIntoView({ block: 'nearest' });
}, [active]);
```

Remove the `setActive(0)` effect entirely (initial state is already 0).

- [ ] **Step 3: Verify TypeScript passes**

Run: `npx tsc -p tsconfig.webview.json --noEmit`
Expected: 0 errors

---

## Task 2 — Fix #2: Global shortcuts fire while typing

**Files:**
- Create: `webview/typing-guard.ts`
- Modify: `webview/app.tsx:218-230`
- Create: `test/unit/typing-guard.test.ts`

- [ ] **Step 1: Write failing tests for the typing-guard module**

Create `test/unit/typing-guard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isTypingEntry, isComboAllowedWhileTyping } from '../../webview/typing-guard';

// Minimal structural shapes for DOM elements — no DOM dependency needed.
function el(tag: string, attrs: Record<string, string> = {}): Element {
  return { tagName: tag.toUpperCase(), getAttribute: (k: string) => attrs[k] ?? null, isContentEditable: attrs['contenteditable'] === 'true' } as unknown as Element;
}

describe('isTypingEntry', () => {
  it('returns true for input elements', () => {
    expect(isTypingEntry(el('input'))).toBe(true);
  });

  it('returns true for textarea elements', () => {
    expect(isTypingEntry(el('textarea'))).toBe(true);
  });

  it('returns true for contenteditable elements', () => {
    expect(isTypingEntry(el('div', { contenteditable: 'true' }))).toBe(true);
  });

  it('returns false for non-typing elements', () => {
    expect(isTypingEntry(el('div'))).toBe(false);
    expect(isTypingEntry(el('button'))).toBe(false);
    expect(isTypingEntry(el('span'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTypingEntry(null)).toBe(false);
  });
});

describe('isComboAllowedWhileTyping', () => {
  it('allows Mod+S while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+S')).toBe(true);
  });

  it('allows Escape-based combos — none in current set, but Escape key combos are safe', () => {
    // Escape is handled by individual components; the global handler doesn't use it.
    // Still: any combo that starts with Escape is allowed.
    expect(isComboAllowedWhileTyping('Escape')).toBe(true);
  });

  it('blocks Mod+P while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+P')).toBe(false);
  });

  it('blocks Mod+B while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+B')).toBe(false);
  });

  it('blocks Mod+N while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+N')).toBe(false);
  });

  it('blocks Mod+Shift+P while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+Shift+P')).toBe(false);
  });

  it('blocks Mod+, while typing', () => {
    expect(isComboAllowedWhileTyping('Mod+,')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/typing-guard.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `webview/typing-guard.ts`**

```ts
/**
 * Typing-entry guard for global keyboard shortcuts.
 *
 * Rule: most global shortcuts (palette, sidebar, nav) MUST NOT fire when
 * the user is typing in a text-entry element (input, textarea, contenteditable).
 * Exception: Mod+S (save) IS allowed everywhere — it is intentionally global.
 *
 * "Monaco handles its own" — Monaco's editor has focus only when the user is
 * actively in the code editor. When Monaco has focus, this guard is irrelevant
 * because Monaco stops the event before it bubbles to window (it handles
 * Ctrl+S itself via its own onKeyDown). So the guard only needs to cover
 * non-Monaco text fields (session filter input, spec textarea, pipeline inputs).
 */

/** Returns true if the element is a user-text-entry surface. */
export function isTypingEntry(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

/**
 * Returns true if the combo is allowed to fire even while the user is typing
 * in a text-entry element.
 *
 * Allowed while typing:
 *   - Mod+S   (save — intentionally global, same save Monaco handles)
 *   - Escape  (handled per-component via useEscapeKey, not the global handler)
 *
 * Everything else is blocked so typing in a filter/input doesn't accidentally
 * open the palette, toggle the sidebar, open settings, etc.
 */
export function isComboAllowedWhileTyping(combo: string): boolean {
  return combo === 'Mod+S' || combo.startsWith('Escape');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/typing-guard.test.ts`
Expected: all tests pass

- [ ] **Step 5: Wire the guard into app.tsx**

In `webview/app.tsx`, find the global keydown handler (lines 219-230):
```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    for (const action of SHORTCUT_ACTIONS) {
      if (matchCombo(e, effectiveCombo(action, bindingsRef.current)) && actionMap[action.id]) {
        e.preventDefault();
        actionMap[action.id]();
        return;
      }
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [actionMap]);
```

Add the import at the top of the file and modify the handler:
```tsx
import { isComboAllowedWhileTyping, isTypingEntry } from './typing-guard';

// ... inside useEffect:
const onKey = (e: KeyboardEvent) => {
  for (const action of SHORTCUT_ACTIONS) {
    const combo = effectiveCombo(action, bindingsRef.current);
    if (!matchCombo(e, combo)) continue;
    if (!actionMap[action.id]) continue;
    // Block global shortcuts when focus is in a text-entry element,
    // unless the combo is explicitly allowed while typing (e.g. Mod+S).
    if (isTypingEntry(e.target as Element | null) && !isComboAllowedWhileTyping(combo)) continue;
    e.preventDefault();
    actionMap[action.id]();
    return;
  }
};
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npx tsc -p tsconfig.webview.json --noEmit`
Expected: 0 errors

---

## Task 3 — Fix #3: Board/Architecture debounce flush on unmount

**Files:**
- Create: `webview/use-debounced-flush.ts`
- Modify: `webview/components/board-view.tsx:35,88-94,107-115,118-126`
- Modify: `webview/components/architecture-view.tsx:260,286-296`
- Create: `test/unit/use-debounced-flush.test.ts`

- [ ] **Step 1: Write failing tests for the flush hook's core logic**

Create `test/unit/use-debounced-flush.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { makeDebouncedFlush } from '../../webview/use-debounced-flush';

describe('makeDebouncedFlush', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('schedules the callback after the delay', () => {
    const cb = vi.fn();
    const { schedule } = makeDebouncedFlush(cb, 300);
    schedule();
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('debounces: only fires once after multiple rapid calls', () => {
    const cb = vi.fn();
    const { schedule } = makeDebouncedFlush(cb, 300);
    schedule();
    schedule();
    schedule();
    vi.advanceTimersByTime(300);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('flush fires immediately if a call is pending', () => {
    const cb = vi.fn();
    const { schedule, flush } = makeDebouncedFlush(cb, 300);
    schedule();
    expect(cb).not.toHaveBeenCalled();
    flush();
    expect(cb).toHaveBeenCalledTimes(1);
    // After flush, timer is cleared; advancing time must NOT fire again.
    vi.advanceTimersByTime(300);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('flush is a no-op when nothing is pending', () => {
    const cb = vi.fn();
    const { flush } = makeDebouncedFlush(cb, 300);
    flush(); // nothing scheduled
    expect(cb).not.toHaveBeenCalled();
  });

  it('cancel prevents the scheduled callback from firing', () => {
    const cb = vi.fn();
    const { schedule, cancel } = makeDebouncedFlush(cb, 300);
    schedule();
    cancel();
    vi.advanceTimersByTime(300);
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/use-debounced-flush.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `webview/use-debounced-flush.ts`**

```ts
import { useCallback, useEffect, useRef } from 'react';

/**
 * Pure factory for a debounced-with-flush controller.
 * Used in tests and as the implementation backing useDebouncedFlush.
 *
 * Returns { schedule, flush, cancel }:
 *   schedule()  — starts/restarts the timer (the debounce).
 *   flush()     — fires the callback immediately if pending, clears the timer.
 *   cancel()    — clears the timer without firing.
 */
export function makeDebouncedFlush(
  cb: () => void,
  delayMs: number,
): { schedule: () => void; flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    pending = true;
    timer = setTimeout(() => {
      pending = false;
      timer = null;
      cb();
    }, delayMs);
  };

  const flush = () => {
    if (!pending) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
    cb();
  };

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = false;
  };

  return { schedule, flush, cancel };
}

/**
 * React hook: debounced save with flush on unmount.
 *
 * Usage:
 *   const { schedule } = useDebouncedFlush(() => post({ type: 'updateBoard', ... }), 300);
 *   // call schedule() whenever data changes.
 *   // On unmount the hook automatically flushes any pending save.
 *
 * The callback ref pattern ensures the closure always calls the LATEST cb
 * without requiring the hook to be recreated.
 */
export function useDebouncedFlush(
  cb: () => void,
  delayMs: number,
): { schedule: () => void } {
  const cbRef = useRef(cb);
  cbRef.current = cb;

  const controllerRef = useRef<ReturnType<typeof makeDebouncedFlush> | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = makeDebouncedFlush(() => cbRef.current(), delayMs);
  }

  // Flush any pending save on unmount so quick-close never drops data.
  useEffect(() => {
    return () => {
      controllerRef.current?.flush();
    };
  }, []);

  const schedule = useCallback(() => {
    controllerRef.current?.schedule();
  }, []);

  return { schedule };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/use-debounced-flush.test.ts`
Expected: all tests pass

- [ ] **Step 5: Refactor board-view.tsx to use the hook**

In `webview/components/board-view.tsx`:

Add the import:
```tsx
import { useDebouncedFlush } from '../use-debounced-flush';
```

Remove `saveTimer` ref and `pipeSaveTimer` ref (lines ~35, ~48):
```tsx
// REMOVE these lines:
const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
const pipeSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Remove the timer-cleanup effect (lines ~88-94):
```tsx
// REMOVE this useEffect:
useEffect(
  () => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (pipeSaveTimer.current) clearTimeout(pipeSaveTimer.current);
  },
  [],
);
```

Add the two debounced-flush hooks and a toast timer cleanup right after the state declarations (after the `toastTimer` ref):
```tsx
const { schedule: scheduleBoardSave } = useDebouncedFlush(() => {
  if (projectPath) post({ type: 'updateBoard', path: projectPath, board: boardRef.current });
}, 300);

const { schedule: schedulePipeSave } = useDebouncedFlush(() => {
  if (projectPath) post({ type: 'updatePipeline', path: projectPath, config: pipeRef.current });
}, 300);

// Only the toast timer is not debounced-flushed (it's a display timer, not a save).
useEffect(
  () => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  },
  [],
);
```

Add refs for the latest board/pipeline so the flush closure always has fresh data:
```tsx
const boardRef = useRef(board);
boardRef.current = board;
const pipeRef = useRef(pipeline);
pipeRef.current = pipeline;
```

Replace the `apply` function's save logic:
```tsx
const apply = (next: BoardData) => {
  setBoard(next);
  boardRef.current = next;
  if (!projectPath) return;
  scheduleBoardSave();
};
```

Replace `savePipeline`'s save logic:
```tsx
const savePipeline = (next: PipelineConfig) => {
  setPipeline(next);
  pipeRef.current = next;
  if (!projectPath) return;
  schedulePipeSave();
};
```

Also update the existing subscribe handler that cancelled `saveTimer` when an external board update arrived — it now calls `cancel` from the hook. Since we don't expose `cancel` directly from `useDebouncedFlush`, we need to add it. Update `use-debounced-flush.ts` to also expose `cancel`:

Update the return type in `useDebouncedFlush`:
```ts
export function useDebouncedFlush(
  cb: () => void,
  delayMs: number,
): { schedule: () => void; cancel: () => void } {
  // ...
  const cancel = useCallback(() => {
    controllerRef.current?.cancel();
  }, []);
  return { schedule, cancel };
}
```

And update the board-view subscribe handler:
```tsx
const { schedule: scheduleBoardSave, cancel: cancelBoardSave } = useDebouncedFlush(...);

// In the subscribe callback:
if (msg.type === 'board' && msg.path === projectPath) {
  cancelBoardSave(); // external truth wins; cancel the pending local save
  setBoard(msg.board);
  boardRef.current = msg.board;
}
```

- [ ] **Step 6: Check architecture-view.tsx for same pattern**

In `webview/components/architecture-view.tsx`, the `Canvas` component has:
- `saveTimer` ref (line ~260)
- `scheduleSave` callback using `setTimeout` (lines ~286-296)

Apply same fix: add import, create flush hook, replace `scheduleSave`:
```tsx
import { useDebouncedFlush } from '../use-debounced-flush';

// In Canvas component, REMOVE the saveTimer ref and scheduleSave useCallback.
// ADD:
const docRef = useRef(doc); // already exists
docRef.current = doc;

const { schedule: scheduleArchSave } = useDebouncedFlush(() => {
  if (projectPath)
    post({ type: 'updateArchitecture', path: projectPath, doc: docRef.current });
}, 300);

// In applyDoc, replace scheduleSave(next) call:
const applyDoc = useCallback(
  (updater: (d: ArchDoc) => ArchDoc) => {
    const next = updater(docRef.current);
    docRef.current = next;
    setDoc(next);
    if (projectPath) scheduleArchSave();
  },
  [projectPath, scheduleArchSave],
);
```

- [ ] **Step 7: Verify typecheck passes**

Run: `npx tsc -p tsconfig.webview.json --noEmit`
Expected: 0 errors

---

## Task 4 — Fix #4: new-session-modal bogus dep

**Files:**
- Modify: `webview/components/new-session-modal.tsx:31-34`

- [ ] **Step 1: Find and fix the dep array**

Current code (line 31-34):
```tsx
useEffect(() => {
  const r = repos.find((x) => x.path === sel);
  setTermId(r?.lastAgentId ?? defaultTerm);
}, [sel, defaultTerm, repos.find]);
```

`repos.find` is `Array.prototype.find` — a stable built-in that never changes. The actual dependency is the `repos` array itself (its content).

Fix: replace `repos.find` with `repos`:
```tsx
useEffect(() => {
  const r = repos.find((x) => x.path === sel);
  setTermId(r?.lastAgentId ?? defaultTerm);
}, [sel, defaultTerm, repos]);
```

This is correct: the effect re-runs when `repos` content changes (new repos from host), when `sel` changes (user selected a different repo), or when `defaultTerm` changes.

- [ ] **Step 2: Verify typecheck passes**

Run: `npx tsc -p tsconfig.webview.json --noEmit`
Expected: 0 errors

---

## Task 5 — Fix #5: confirm-dialog Enter triggers confirm when Cancel focused

**Files:**
- Modify: `webview/components/confirm-dialog.tsx:12-22`

- [ ] **Step 1: Understand the bug**

Current keydown handler (lines 12-22):
```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'Enter') {
      state.onConfirm();
      onClose();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [state, onClose]);
```

When the Cancel button has focus, pressing Enter fires both the button's native click (closing) AND the window keydown handler (confirming). The fix: only fire `onConfirm` from the keydown when the currently-focused element is NOT the Cancel button.

The Cancel button needs a ref or we need to check `document.activeElement`. The idiomatic fix is to give the Cancel button a ref and check against it:

- [ ] **Step 2: Apply the fix**

Replace the entire `confirm-dialog.tsx` with:
```tsx
import { useEffect, useRef } from 'react';

export interface ConfirmState {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter') {
        // If the Cancel button is focused, native button semantics will handle
        // the click (calling onClose). Don't also fire onConfirm here.
        if (cancelRef.current && document.activeElement === cancelRef.current) return;
        state.onConfirm();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, onClose]);

  return (
    <div className="modal__backdrop" onClick={onClose}>
      <div className="confirm" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <span className="confirm__title">{state.title}</span>
        <p className="confirm__msg">{state.message}</p>
        <div className="confirm__actions">
          <button ref={cancelRef} className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${state.danger ? 'btn--danger' : 'btn--primary'}`}
            autoFocus
            onClick={() => {
              state.onConfirm();
              onClose();
            }}
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npx tsc -p tsconfig.webview.json --noEmit`
Expected: 0 errors

---

## Task 6 — Fix #6: doc-tabs button-in-button

**Files:**
- Modify: `webview/components/doc-tabs.tsx:124-133`

- [ ] **Step 1: Identify the remaining nested button**

From the current code, the dirty-dot close-to-save control is already a `span[role=button]` (fix from K2). But the CLOSE button (`tab__close`) at lines 124-133 is still a `<button>` nested inside the outer tab `<button>`:
```tsx
<button
  className="tab__close"
  aria-label="Close tab"
  onClick={(e) => {
    e.stopPropagation();
    onClose(d.id);
  }}
>
  <IconClose size={12} />
</button>
```

This is inside a `<button key={d.id} className="tab ...">` — invalid DOM nesting.

- [ ] **Step 2: Change the outer tab from button to div[role=tab]**

The outer element must stop being a `<button>` since it contains interactive children. Change it to a `<div role="tab">` with `tabIndex={0}` and keyboard activation, keeping ALL existing behaviors:

```tsx
{docs.map((d) => (
  <div
    key={d.id}
    role="tab"
    tabIndex={0}
    aria-selected={activeId === d.id}
    className={`tab ${activeId === d.id ? 'tab--active' : ''} ${overId === d.id ? 'tab--dropbefore' : ''} ${dirty.has(d.path) ? 'tab--dirty' : ''}`}
    onClick={() => onSelect(d.id)}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(d.id);
      }
    }}
    onContextMenu={onTabContextMenu ? (e) => onTabContextMenu(e, d) : undefined}
    draggable={!!onReorder}
    onDragStart={(e) => {
      dragIdRef.current = d.id;
      e.dataTransfer.effectAllowed = 'move';
    }}
    onDragOver={(e) => {
      const dr = dragIdRef.current;
      if (dr && dr !== d.id) {
        e.preventDefault();
        setOverId(d.id);
      }
    }}
    onDragLeave={() => setOverId((o) => (o === d.id ? null : o))}
    onDrop={(e) => {
      e.preventDefault();
      const dr = dragIdRef.current;
      if (dr) onReorder?.(dr, d.id);
      dragIdRef.current = null;
      setOverId(null);
    }}
    onDragEnd={() => {
      dragIdRef.current = null;
      setOverId(null);
    }}
  >
    {d.kind === 'diff' && <IconBranch size={12} className="tab__spark" />}
    <span>{d.title}</span>
    {dirty.has(d.path) && (
      <span
        className="tab__dirty"
        role="button"
        tabIndex={0}
        aria-label="Unsaved changes — save"
        title="Unsaved changes — Ctrl+S to save"
        onClick={(e) => {
          e.stopPropagation();
          saveDocByPath(d.path);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            saveDocByPath(d.path);
          }
        }}
      />
    )}
    <button
      className="tab__close"
      aria-label="Close tab"
      onClick={(e) => {
        e.stopPropagation();
        onClose(d.id);
      }}
    >
      <IconClose size={12} />
    </button>
  </div>
))}
```

The close button remains a real `<button>` (valid DOM: button inside div). The outer `div[role=tab]` uses keyboard events to activate like a button.

- [ ] **Step 3: Verify typecheck passes**

Run: `npx tsc -p tsconfig.webview.json --noEmit`
Expected: 0 errors

---

## Task 7 — Fix #7: Undefined CSS var --code-surface

**Files:**
- Modify: `webview/styles.css:2274-2291`

- [ ] **Step 1: Locate the issue**

In `webview/styles.css` around lines 2280-2284, the `:root` block already defines `--code-surface`:
```css
--code-bg: #0a0b0e;
--code-alpha: 1;
--code-surface: color-mix(in srgb, var(--code-bg) calc(var(--code-alpha) * 100%), transparent);
```

This means `--code-surface` IS already defined in CSS. But it must be re-evaluated after `--code-bg` and `--code-alpha` are set by JS via `el.style.setProperty`. In `webview/settings.tsx` the `applyToDom` function sets `--code-bg` and `--code-alpha` but NOT `--code-surface` — the CSS `color-mix` derivation should resolve dynamically since it references the CSS vars at paint time.

Let me verify the CSS actually defines it — looking at lines 2280-2290 confirms `--code-surface` IS defined as:
```css
--code-surface: color-mix(in srgb, var(--code-bg) calc(var(--code-alpha) * 100%), transparent);
```

Since `--code-bg` and `--code-alpha` are set via `el.style.setProperty` (inline styles on `:root`), and `color-mix` uses those custom properties at paint time, this SHOULD work in modern browsers. The issue noted in the audit ("references --code-surface but nothing defines it") may have been referring to an earlier state of the code.

**Verify by grep that --code-surface is defined:**
```
grep -n "code-surface" webview/styles.css
```

If the definition already exists (line ~2283), this fix is already in place. Mark as already-fixed and proceed.

---

## Task 8 — Fix #8: Duplicate conflicting .filerow rule blocks

**Files:**
- Modify: `webview/styles.css:1500-1554, 1783-1815`

- [ ] **Step 1: Locate the two blocks**

First block (lines 1500-1554) — the "earlier" block:
```css
.filerow {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px;
  border-radius: var(--r-sm); cursor: pointer; font-size: 12.5px;
}
.filerow:hover { background: var(--panel-2); }
.filerow__chev { color: var(--text-faint); transition: transform 0.12s; }
.filerow__chev--open { transform: rotate(90deg); }
.filerow__chev-spacer { width: 12px; flex: 0 0 auto; }
.filerow__icon { color: var(--text-dim); }
.filerow__name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
// ...badge classes
```

Second block (lines 1783-1815) — the "later/winning" block:
```css
.filerow {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px;
  cursor: pointer; border-radius: var(--r-sm);
}
.filerow:hover { background: var(--raise); }  // <-- DIFFERENT hover
.filerow__chev { color: var(--text-faint); transition: transform 0.1s; flex: 0 0 auto; }
.filerow__chev--open { transform: rotate(90deg); }
.filerow__chev-spacer { width: 12px; flex: 0 0 auto; }
.filerow__icon { color: var(--text-dim); flex: 0 0 auto; }
.filerow__name { font-size: 12.5px; }
```

The later block WINS (CSS cascade). The first block's hover uses `var(--panel-2)` (dead), the second uses `var(--raise)` (live). The second block is missing `flex: 1; white-space/overflow/ellipsis` on `__name` and the badge classes.

- [ ] **Step 2: Merge into one canonical block**

Remove the first block entirely (lines 1500-1554 — from `.filerow {` through the last `.filerow__badge--D` rule).

Replace the second block (lines 1783-1815) with the merged winner:
```css
.filerow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  border-radius: var(--r-sm);
  font-size: 12.5px;
}
.filerow:hover {
  background: var(--raise);
}
.filerow__chev {
  color: var(--text-faint);
  transition: transform 0.1s;
  flex: 0 0 auto;
}
.filerow__chev--open {
  transform: rotate(90deg);
}
.filerow__chev-spacer {
  width: 12px;
  flex: 0 0 auto;
}
.filerow__icon {
  color: var(--text-dim);
  flex: 0 0 auto;
}
.filerow__name {
  flex: 1;
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.filerow--M .filerow__name {
  color: var(--amber);
}
.filerow--A .filerow__name {
  color: var(--green);
}
.filerow--D .filerow__name {
  color: var(--red);
}
.filerow__badge {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
}
.filerow__badge--M {
  color: var(--amber);
}
.filerow__badge--A {
  color: var(--green);
}
.filerow__badge--D {
  color: var(--red);
}
```

---

## Task 9 — Write spec doc + evidence file

**Files:**
- Create: `docs/specs/webview-papercuts.md`
- Create: `.autoloop/evidence/webview-papercuts.md`

- [ ] **Step 1: Write the spec**

Create `docs/specs/webview-papercuts.md` documenting each fix.

- [ ] **Step 2: Write the evidence file**

Create `.autoloop/evidence/webview-papercuts.md` with per-fix: located-at, fixed-how.

---

## Task 10 — Gate check, commit

- [ ] **Step 1: Run full verify**

Run: `npm run verify`
Expected: exit 0 (format + lint + typecheck + tests + security all pass)

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 3: Check test count**

Run: `npm run test:unit`
Expected: >= 441 tests (the new typing-guard + debounced-flush tests should add ~14 more)

- [ ] **Step 4: Confirm git status**

Run: `git status`
Expected: Only intended files staged, NO board.json.

- [ ] **Step 5: Commit**

```bash
git add webview/components/command-palette.tsx \
        webview/typing-guard.ts \
        webview/app.tsx \
        webview/use-debounced-flush.ts \
        webview/components/board-view.tsx \
        webview/components/architecture-view.tsx \
        webview/components/new-session-modal.tsx \
        webview/components/confirm-dialog.tsx \
        webview/components/doc-tabs.tsx \
        webview/styles.css \
        test/unit/typing-guard.test.ts \
        test/unit/use-debounced-flush.test.ts \
        docs/specs/webview-papercuts.md \
        .autoloop/evidence/webview-papercuts.md

git commit -m "fix(renderer): 8 webview papercuts — palette scroll, typing guard, debounce flush, modal deps, confirm Enter, tab DOM, CSS vars

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

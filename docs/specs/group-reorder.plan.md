# Group-Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When sessions are grouped by project, let the user drag a project-group header to reorder whole groups; all sessions in a group move together, preserving their internal order, and the new order persists via the existing session-order channel.

**Architecture:** Project-group order is **implicit** — it is derived from first-appearance of each project in the flat session-id list owned by the host `SessionManager` (persisted via `list()`/`restore()`). No new persisted field. A new pure function `reorderByGroup` relocates a project's whole block of ids before another project's block in that flat list; the sidebar wires a header drag that calls it and posts the result through the existing `onReorderSessions(order)` → `reorderSessions` host message. Card drag and group drag are distinguished by two separate drag-marker refs.

**Tech Stack:** TypeScript, React (webview), Vitest (`test/unit/`), Biome (single quotes, semicolons, 2-space, width 100, kebab-case files).

---

### Task 1: Pure `reorderByGroup` helper (test-first)

**Files:**
- Modify: `src/reorder.ts` (add `reorderByGroup` beside `moveBefore`)
- Test: `test/unit/reorder.test.ts` (add a `describe('reorderByGroup', ...)`)

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/reorder.test.ts` (keep the existing `moveBefore` block):

```ts
import { moveBefore, reorderByGroup } from '../../src/reorder';

describe('reorderByGroup', () => {
  // groupOf: first char of the id is its project key (e.g. 'a1' -> 'a')
  const g = (id: string) => id[0];

  it('moves a whole group before a later group, preserving order', () => {
    // groups [a, b, c]; move a before c -> [b, a, c]
    expect(reorderByGroup(['a1', 'a2', 'b1', 'c1', 'c2'], g, 'a', 'c')).toEqual([
      'b1', 'a1', 'a2', 'c1', 'c2',
    ]);
  });

  it('moves a group to the end when target is null', () => {
    expect(reorderByGroup(['a1', 'b1', 'b2', 'c1'], g, 'a', null)).toEqual([
      'b1', 'b2', 'c1', 'a1',
    ]);
  });

  it('moves a later group before an earlier group', () => {
    // groups [a, b, c]; move c before a -> [c, a, b]
    expect(reorderByGroup(['a1', 'b1', 'c1', 'c2'], g, 'c', 'a')).toEqual([
      'c1', 'c2', 'a1', 'b1',
    ]);
  });

  it('preserves each group internal order', () => {
    const out = reorderByGroup(['a1', 'a2', 'a3', 'b1'], g, 'a', null);
    // a-group ids keep relative order a1,a2,a3 wherever they land
    expect(out.filter((id) => id[0] === 'a')).toEqual(['a1', 'a2', 'a3']);
  });

  it('is a no-op when dragGroup === targetGroup (same ref)', () => {
    const input = ['a1', 'a2', 'b1'];
    expect(reorderByGroup(input, g, 'a', 'a')).toBe(input);
  });

  it('is a no-op when dragGroup has no ids (same ref)', () => {
    const input = ['a1', 'b1'];
    expect(reorderByGroup(input, g, 'z', 'a')).toBe(input);
  });

  it('appends the group when targetGroup is absent', () => {
    expect(reorderByGroup(['a1', 'b1'], g, 'a', 'zzz')).toEqual(['b1', 'a1']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/reorder.test.ts`
Expected: FAIL — `reorderByGroup` is not exported / not a function.

- [ ] **Step 3: Implement `reorderByGroup`**

Append to `src/reorder.ts`:

```ts
/**
 * Reorder a flat id list by whole groups. Moves every id whose group is `dragGroup`
 * as one contiguous block to immediately before the first id whose group is
 * `targetGroup`, preserving each group's internal relative order. `targetGroup`
 * null moves the block to the end. No-op (returns the input array unchanged) when
 * `dragGroup === targetGroup` or `dragGroup` has no ids — so callers can skip a
 * host round-trip. Group order is implicit: a group's position is where its first
 * id sits in `ids`.
 */
export function reorderByGroup(
  ids: string[],
  groupOf: (id: string) => string,
  dragGroup: string,
  targetGroup: string | null,
): string[] {
  if (dragGroup === targetGroup) return ids;
  const block = ids.filter((id) => groupOf(id) === dragGroup);
  if (block.length === 0) return ids;
  const rest = ids.filter((id) => groupOf(id) !== dragGroup);
  if (targetGroup === null) return [...rest, ...block];
  const at = rest.findIndex((id) => groupOf(id) === targetGroup);
  if (at === -1) return [...rest, ...block];
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/reorder.test.ts`
Expected: PASS — all `moveBefore` and `reorderByGroup` cases green.

- [ ] **Step 5: Commit**

(Conductor handles git — skip committing; leave changes in the working tree.)

---

### Task 2: Wire group-header drag in the sidebar

**Files:**
- Modify: `webview/components/sidebar.tsx`
- Modify: `webview/styles.css` (header grab cursor + drop-before indicator)

- [ ] **Step 1: Import the helper**

In `webview/components/sidebar.tsx`, extend the existing import:

```ts
import { moveBefore, reorderByGroup } from '../../src/reorder';
```

- [ ] **Step 2: Add a distinct group-drag marker + over-state**

Beside the existing `dragIdRef` / `dragGroup` / `overId` refs, add a separate group
drag source ref and a group-over state, so a header drag never collides with a card
drag (distinct markers):

```ts
const dragGroupRef = useRef<string | null>(null); // project path of a group being dragged
const [overGroup, setOverGroup] = useState<string | null>(null);
```

Extend `reset()` to clear them:

```ts
const reset = () => {
  dragIdRef.current = null;
  dragGroup.current = null;
  dragGroupRef.current = null;
  setOverId(null);
  setOverGroup(null);
};
```

- [ ] **Step 3: Add group-drag handlers (header is the drag source)**

Add a `groupDrag(path)` factory near `sessionDrag`. It only acts when a **group**
drag is in flight (`dragGroupRef.current` set) — card drags set `dragIdRef` instead,
so the two never interfere:

```ts
const groupDrag = (path: string) => ({
  onDragStart: (e: React.DragEvent) => {
    dragGroupRef.current = path;
    e.dataTransfer.effectAllowed = 'move';
    e.stopPropagation();
  },
  onDragOver: (e: React.DragEvent) => {
    const d = dragGroupRef.current;
    if (d && d !== path) {
      e.preventDefault();
      setOverGroup(path);
    }
  },
  onDrop: (e: React.DragEvent) => {
    e.preventDefault();
    const d = dragGroupRef.current;
    if (d && d !== path) {
      const groupOf = (id: string) =>
        sessions.find((s) => s.id === id)?.projectPath ?? '';
      onReorderSessions(reorderByGroup(allIds(), groupOf, d, path));
    }
    reset();
  },
  onDragEnd: reset,
});
```

- [ ] **Step 4: Make the project header draggable**

In the grouped branch of `renderGroups.map(...)`, attach the handlers to the
`.proj__label` header and mark it draggable when `canDrag` (manual + unfiltered),
matching card-reorder gating. Use the same `--dropbefore` indicator pattern:

```tsx
<div className="proj" key={g.path}>
  <div
    className={`proj__label ${overGroup === g.path ? 'proj__label--dropbefore' : ''}`}
    title={g.path}
    draggable={canDrag}
    {...(canDrag ? groupDrag(g.path) : {})}
  >
    {baseName(g.path)}
  </div>
  {g.sessions.map((s) => renderItem(s, g.path))}
</div>
```

- [ ] **Step 5: Style the header drag affordance**

In `webview/styles.css`, near `.proj__label`, add a grab cursor when draggable and a
drop-before indicator mirroring `.session--dropbefore`:

```css
.proj__label[draggable='true'] {
  cursor: grab;
}
.proj__label--dropbefore {
  box-shadow: inset 0 2px 0 var(--accent);
}
```

(If `.session--dropbefore` uses a different token/shape, match that exact rule so the
two indicators are visually consistent. Check the existing `.session--dropbefore` /
`.tab--dropbefore` rule first and reuse its declaration.)

- [ ] **Step 6: Typecheck + lint + verify the build compiles**

Run: `npm run typecheck`
Expected: PASS (both host + webview tsconfigs).

Run: `npm run verify`
Expected: format-check + lint + typecheck + tests + security all green.

- [ ] **Step 7: Commit**

(Conductor handles git — skip; leave changes in the working tree.)

---

### Task 3: Gates + runtime proof

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`  (capture to `.autoloop/evidence/group-reorder-verify.log`)
Expected: exit 0.

- [ ] **Step 2: Build**

Run: `npm run build`  (append to the same evidence log)
Expected: exit 0.

- [ ] **Step 3: Runtime proof (Playwright over HTTP)**

Build the webview, serve over HTTP (file:// is blocked), open in Playwright, enable
"Group by project", confirm headers are `draggable`, drive a header drop if possible,
and inspect that the rendered group order changed as a unit and a single card drag
still works. HTML5 DnD drops are hard to script headless — at minimum assert headers
carry `draggable="true"` and rely on the `reorderByGroup` unit tests for the move
logic. Screenshots to `%TEMP%\claude-scratch\` (absolute paths) only. Record
observations + paths to `.autoloop/evidence/group-reorder-runtime.txt`.

---

## Self-Review

**1. Spec coverage:**
- AC1/AC2/AC3 (move-as-unit, persist, internal order) → Task 1 tests + Task 2 drop posting through `onReorderSessions`. ✓
- AC4 (card drag unaffected) → Task 2 keeps `sessionDrag` and uses a *separate* `dragGroupRef`. ✓
- AC5 (no drag when sorted/filtered) → Task 2 gates header `draggable` on `canDrag`. ✓
- AC6 (pure fn unit-tested) → Task 1. ✓
- Implicit project order / back-compat → `reorderByGroup` operates on the flat list only; no migration. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code. The one
conditional ("match `.session--dropbefore` if it differs") is a concrete instruction
to read an existing rule, not a placeholder. ✓

**3. Type consistency:** `reorderByGroup(ids, groupOf, dragGroup, targetGroup)` used
identically in Task 1 (def + tests) and Task 2 (call site). `groupOf` maps id →
`projectPath`. `dragGroupRef`/`overGroup` names consistent across Task 2 steps. ✓

No gaps found.

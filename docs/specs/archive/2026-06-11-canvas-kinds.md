# Spec: Architectural node kinds + per-kind icons (canvas)

- **Tier:** LITE
- **Feature type:** UI + model
- **Slug:** canvas-kinds
- **Surface:** `src/architecture.ts` (kind model + migration) · `webview/icons.tsx`
  (per-kind glyphs) · `webview/components/architecture-view.tsx` (node render, kind
  picker, minimap color) · `webview/styles.css` (node icon styling)

## Problem frame

**Job:** When sketching a software architecture on the canvas, a user wants the node
*kinds* to map onto how real systems are described — service, API gateway, database,
cache, queue, etc. — and to see at a glance, from a distinct **icon on each node**,
what each box represents.

Today the kinds are `service | ui | data | external | group | note`. They are too
coarse and overlapping ("data" vs "store", "ui" vs "view") and carry **no icon** — a
node only shows a colored left stripe, so every box looks the same and the diagram is
unreadable at a glance.

- **Actor:** the person editing an architecture diagram in the renderer (and an LLM
  that reads/writes the persisted `architecture.json`).
- **Success:** a coherent, non-overlapping architectural kind set; each kind has a
  stable id, human label, color, and a distinct icon rendered **on the node**; the
  inspector kind picker lists the new kinds (with icons); the minimap still colors
  nodes by kind; **old saved diagrams keep rendering** via an old→new migration map.
- **Non-goals:** free-form / user-defined kinds; per-node custom colors or icons;
  swimlane auto-layout; changing edge semantics; new persistence location.

## The new kind set

Eleven kinds — opinionated, non-overlapping, each a distinct color + icon. Colors use
existing design variables (no raw hex), readable on both the node surface (`--panel-2`)
and the minimap. Where two kinds must share a hue family they are visually separated by
icon (the icon, not just color, carries identity).

| id          | label             | color var      | icon              | meaning |
|-------------|-------------------|----------------|-------------------|---------|
| `service`   | Service           | `--accent`     | `IconService`     | a running service / process |
| `gateway`   | API / Gateway     | `--accent-2`   | `IconGateway`     | entry / edge (API, gateway, ingress) |
| `frontend`  | UI / Frontend     | `--blue`       | `IconFrontend`    | client / presentation layer |
| `database`  | Database          | `--green`      | `IconDatabase`    | relational / document datastore |
| `cache`     | Cache             | `--amber`      | `IconCache`       | in-memory cache (Redis, etc.) |
| `queue`     | Queue / Event bus | `--violet`     | `IconQueue`       | async messaging / event bus |
| `worker`    | Job / Worker      | `--blue`       | `IconWorker`      | background / scheduled work |
| `storage`   | Storage / Blob    | `--green`      | `IconStorage`     | files / objects / blobs |
| `library`   | Library / Module  | `--text-dim`   | `IconLibrary`     | code unit / shared module |
| `external`  | External system   | `--red`        | `IconExternalSystem` | 3rd-party / outside the boundary |
| `group`     | Group / Boundary  | `--text-faint` | `IconGroup`       | grouping / layer / boundary container |

`note` is **dropped** as a node kind (it was a free-floating annotation, not an
architectural element); old `note` nodes migrate to `group` (a neutral container) so
nothing disappears. Rationale: the canvas already has edge labels and node subtitles
for annotation; a "note" kind muddied the architectural vocabulary.

Color reuse is deliberate and safe because identity is icon-led: `frontend`/`worker`
share `--blue` (client vs. background compute — very different glyphs); `database`/
`storage` share `--green` (both persistence, distinguished by cylinder vs. box glyph).

## Migration (back-compat) map old→new

Applied on **load** (`validGraph` in `restoreArchitecture`) and to any node whose
stored `kind` is not a current kind id. Pure, exported, unit-tested.

| old id     | → new id   |
|------------|------------|
| `service`  | `service`  |
| `logic`    | `service`  |
| `ui`       | `frontend` |
| `view`     | `frontend` |
| `data`     | `database` |
| `store`    | `database` |
| `external` | `external` |
| `group`    | `group`    |
| `layer`    | `group`    |
| `note`     | `group`    |

- A kind id that is **already** a valid new kind passes through unchanged.
- An **unknown / missing** kind → default `service` (the most common element, and the
  pre-existing fallback in `addNode`/`validGraph`).
- The function name is `migrateKind(kind: unknown): ArchKind`.

## Data / interface contract

In `src/architecture.ts`:

```
export type ArchKind =
  | 'service' | 'gateway' | 'frontend' | 'database' | 'cache'
  | 'queue' | 'worker' | 'storage' | 'library' | 'external' | 'group';

export const ARCH_KINDS: { id: ArchKind; label: string }[]   // 11 entries, ordered as table
export function migrateKind(kind: unknown): ArchKind          // old→new + default
```

- `isKind` continues to gate “is this already a current kind”.
- `validGraph` resolves each node’s `kind` via `migrateKind(n.kind)` (was: `isKind ?
  n.kind : 'service'`) so **old saved docs load with migrated kinds** and unknowns fall
  back to `service`.
- `addNode` default kind stays `service`.
- The seed graph (`seedArchitecture`) is updated to use new ids (`frontend`,
  `service`, `database`, `external`) so a fresh doc demonstrates the new set. (Old
  seeds on disk still migrate.)

In `webview/icons.tsx`: one exported glyph per kind (16px grid, `currentColor`,
matching the existing `glyph(...)`/`base(...)` pattern). A `KIND_ICON: Record<ArchKind,
Icon>` map lets the node + picker look up an icon by kind.

In `architecture-view.tsx`:

- `KIND_VAR: Record<ArchKind, string>` extended to all 11 kinds (drives node stripe +
  `archNodeColor` minimap). `archNodeColor` is unchanged in logic — it already reads
  `KIND_VAR[kind]` and resolves the CSS var to a concrete color.
- `ArchNodeCard` renders `KIND_ICON[kind]` on the node (a small kind badge tinted with
  the kind color), alongside the existing stripe + title.
- Inspector kind `<select>` lists `ARCH_KINDS` (already does — just picks up the new
  entries). Each option shows its label; the selected kind’s icon shows on the node.

## Behavior & states

- A node always has exactly one kind from the current set. Selecting a new kind in the
  inspector updates the node’s stripe color, minimap color, **and icon** immediately
  (single `updateNode` → re-render).
- Loading a doc with an old/unknown kind silently migrates it; the user sees a valid
  new kind, never a blank/broken node.
- No transient states; kind change is a pure model update through the existing
  `applyDoc` → debounced save path.

## Edge cases & failure modes

- **Unknown kind string** (hand-edited json, future kind) → `service`; no throw, no
  blank node.
- **Missing kind** (undefined) → `service`.
- **Color var unresolved** (SSR/preview) → `archNodeColor` already falls back to
  `MINIMAP_FALLBACK_COLOR`; node stripe falls back to the CSS var (transparent-safe via
  panel background).
- **Old doc round-trip:** load migrates `note`→`group` etc.; re-serialize writes the
  new ids. A subsequent load is a no-op (idempotent migration).
- **Icon legibility at min zoom:** icons are simple single-path-ish glyphs sized to the
  node header (~14px), not zoom-scaled separately — acceptable for LITE.

## Defaults vs settings

- Kind set and colors are **fixed** (design decision, not user setting) — consistent,
  legible, themeable via existing color vars. No new setting.
- Default kind for new/duplicated/unknown nodes = `service`.

## Scope slicing

- **MVP / this change:** new 11-kind set (ids/labels/colors), `migrateKind` map applied
  on load, distinct icon per kind on the node + in the picker, minimap still colors by
  kind, seed updated, unit tests, existing tests updated for renamed kinds (not
  weakened).
- **Out of scope:** user-defined kinds, per-node color/icon override, legend UI, icon
  zoom-scaling, kind-based auto-layout.

## Acceptance criteria

- AC1: `ARCH_KINDS` lists the 11 new kinds, each with a non-empty label; every kind id
  has an entry in `KIND_VAR` and `KIND_ICON`.
- AC2: `migrateKind` maps each old id to the expected new id per the table; an id that
  is already a new kind passes through; unknown/`undefined` → `service`.
- AC3: Loading a doc whose nodes use old kind ids (`ui`, `data`, `store`, `note`,
  `layer`, …) yields a doc where **every** node’s kind is a valid current kind.
- AC4: On the canvas, each node shows a **distinct icon** for its kind; changing a
  node’s kind in the inspector updates its icon **and** color.
- AC5: The minimap colors nodes by kind for all 11 kinds (no transparent silhouettes).
- AC6: Existing architecture unit tests pass (updated for renamed kinds where they
  referenced `'data'`/`'ui'`), and new tests cover AC1–AC3.

## Accessibility & i18n (UI checklist)

- Node icons are **decorative** (the title text carries meaning) → `aria-hidden`,
  consistent with `SessionGlyph`.
- Kind picker is a native `<select>` with text labels — fully keyboard/AT accessible;
  icons augment but never replace the text label.
- i18n: kind labels are short app copy in `ARCH_KINDS`; no new dynamic strings.
- Design tokens: all kind colors are existing CSS variables (`--accent`, `--blue`,
  `--green`, `--amber`, `--violet`, `--red`, `--text-dim`, `--text-faint`, `--accent-2`)
  — no raw hex. Icons use `currentColor` so they tint via the kind color / theme.

## Decisions Needed

- (normal) Dropping `note` as a kind: accepted — annotation is served by subtitles +
  edge labels; old `note` nodes migrate to `group` so no data is lost.
- (normal) Color reuse across `frontend`/`worker` and `database`/`storage`: accepted —
  identity is icon-led; the 9-hue design palette can’t give 11 unique hues without
  introducing off-palette colors, which the design rules forbid.

## Self-audit

Core spine: problem frame ✓, behavior/states ✓, data/interface contract ✓ (kinds +
`migrateKind`), edge cases ✓, defaults vs settings ✓, scope slicing ✓, acceptance
criteria ✓. UI module: state catalog ✓ (kind change), interaction ✓ (picker), a11y ✓,
i18n ✓, design tokens ✓. No unaddressed items.

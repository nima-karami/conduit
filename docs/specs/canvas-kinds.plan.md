# Plan: Architectural node kinds + per-kind icons (canvas-kinds)

Spec: `docs/specs/canvas-kinds.md`. Tier LITE. Test-first.

## Files touched

1. `src/architecture.ts` — new `ArchKind` union (11 kinds), new `ARCH_KINDS`, new
   `migrateKind(kind): ArchKind`; `validGraph` uses `migrateKind`; `seedArchitecture`
   uses new ids.
2. `test/unit/architecture.test.ts` — update refs to old kinds (`'data'`, `'ui'`);
   add tests for `ARCH_KINDS`, `migrateKind`, and old-doc load → all valid kinds.
3. `webview/icons.tsx` — one glyph per kind + exported `KIND_ICON` map.
4. `webview/components/architecture-view.tsx` — extend `KIND_VAR`; render kind icon on
   node; picker already iterates `ARCH_KINDS`.
5. `webview/styles.css` — `.archnode__icon` styling (small tinted badge).

## Steps

### Step 1 — Tests first (red)
- In `architecture.test.ts`:
  - Update the two existing references to removed kinds: `kind: 'data'` → `'database'`,
    seed assertions that assume `'ui'`/`'data'` stay valid. (Do NOT weaken assertions.)
  - Add `describe('kinds & migration')`:
    - `ARCH_KINDS` has 11 entries; ids are unique; each label non-empty; includes
      `service, gateway, frontend, database, cache, queue, worker, storage, library,
      external, group`.
    - `migrateKind` table: each old id → expected new id (per spec table); a new id
      passes through; `'bogus'`, `undefined`, `null`, `42` → `'service'`.
    - Build a doc blob whose nodes use OLD ids (`ui, data, store, note, layer, logic,
      view, external, group, service`); `restoreArchitecture` → every node kind is in
      the current id set.
- Run `npm run test:unit` → expect failures (migrateKind missing, union changed).

### Step 2 — Model (green)
- Rewrite `ArchKind`, `ARCH_KINDS`, add `migrateKind` with `OLD_TO_NEW` map +
  default `'service'`; `isKind` stays.
- `validGraph`: `kind: migrateKind(n.kind)`.
- `seedArchitecture`: node kinds → `frontend`, `service`, `database`, `external`.
- Re-run unit tests → green.

### Step 3 — Icons
- Add 11 glyphs in `icons.tsx` (reuse `glyph(...)`; simple, legible at ~14px). Some can
  reuse/rename existing marks (`IconServer` → service-ish) but each kind gets a visually
  distinct glyph. Export `KIND_ICON: Record<ArchKind, (p)=>JSX.Element>`.

### Step 4 — Node render + picker + minimap
- `KIND_VAR` → 11 entries (per spec color table).
- `ArchNodeCard`: render `<span class="archnode__icon">` with `KIND_ICON[kind]`, tinted
  `color: var(KIND_VAR[kind])`, `aria-hidden`. Keep stripe.
- Inspector picker already maps `ARCH_KINDS` → picks up new kinds. (Optionally show icon
  in the node; the select stays text for a11y.)
- `archNodeColor` unchanged (reads `KIND_VAR`).

### Step 5 — CSS
- `.archnode__icon { display:grid; place-items:center; flex:0 0 auto; }` sized ~18px.

### Step 6 — Gates
- `npm run verify` and `npm run build`; tee to `.autoloop/evidence/canvas-kinds-verify.log`.

### Step 7 — Runtime proof (Playwright over HTTP)
- Build webview, serve, open canvas; confirm icons on nodes, picker lists new kinds,
  kind change updates icon+color, an old-kind node migrates. Screenshots → `%TEMP%`.
  Notes → `.autoloop/evidence/canvas-kinds-runtime.txt`.

### Step 8 — Review + verification-before-completion
- `superpowers:requesting-code-review`; address blocking; final verification.

## Risks
- Color reuse across kinds — mitigated by icon-led identity (spec decision).
- Existing tests referencing old kinds — update, don't weaken.
- esbuild bundling of new icons — they follow the existing pattern; build gate catches.

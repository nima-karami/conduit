# conduit-canvas (F0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Persist the architecture canvas to the committed `.conduit/architecture.json`
envelope (ADR 0002) via the new persistence layer, migrating the legacy bare
`<root>/architecture.json` on read and surfacing write errors instead of swallowing them.

**Architecture:** The renderer's canvas already speaks the `requestArchitecture` /
`updateArchitecture` / `architecture` protocol — unchanged. Only the **host** swaps its
storage backend. A new pure-ish host helper `readArchitectureForProject(root)` encodes
the read+legacy-migration decision (so it's unit-testable against a temp dir); the
`electron/main.ts` handlers call it for reads and `writeArchitectureArtifactFile` for
writes, propagating rejections to the renderer's existing `{ type:'error' }` channel.

**Tech Stack:** TypeScript, Electron (main process), Vitest, Biome.

---

### Task 1: Read + legacy-migration helper in conduit-fs

**Files:**
- Modify: `electron/conduit-fs.ts` (add `readArchitectureForProject`)
- Test: `test/unit/conduit-fs.test.ts` (add a describe block)

- [ ] **Step 1: Write failing tests** for `readArchitectureForProject(root)` covering:
  `.conduit/` present wins; legacy bare file used when `.conduit/` absent; `.conduit/`
  precedence when both exist; `null` when neither exists; prose fields survive legacy read.

```ts
import { readArchitectureForProject } from '../../electron/conduit-fs';
import { serializeArchitecture, seedArchitecture } from '../../src/architecture';

describe('readArchitectureForProject (read + legacy migration)', () => {
  it('returns null when neither .conduit/ nor legacy file exists', () => {
    expect(readArchitectureForProject(root)).toBeNull();
  });

  it('reads .conduit/architecture.json when present', async () => {
    const doc = seedArchitecture('Conduit Home');
    await writeArchitectureArtifactFile(root, doc);
    expect(readArchitectureForProject(root)).toEqual(doc);
  });

  it('migrates the legacy bare <root>/architecture.json when .conduit/ is absent', () => {
    const doc = seedArchitecture('Legacy');
    fs.writeFileSync(path.join(root, 'architecture.json'), serializeArchitecture(doc));
    expect(fs.existsSync(conduitDir(root))).toBe(false);
    const loaded = readArchitectureForProject(root);
    expect(loaded).toEqual(doc);
    // prose fields survive: seed has edge labels + node subtitles
    const g = loaded?.graphs[loaded.rootGraph];
    expect(g?.edges.some((e) => e.label === 'IPC')).toBe(true);
    expect(g?.nodes.some((n) => n.subtitle === 'React webview')).toBe(true);
  });

  it('prefers .conduit/ over the legacy file when both exist', async () => {
    const legacy = seedArchitecture('Legacy');
    fs.writeFileSync(path.join(root, 'architecture.json'), serializeArchitecture(legacy));
    const canonical = seedArchitecture('Canonical');
    await writeArchitectureArtifactFile(root, canonical);
    expect(readArchitectureForProject(root)?.graphs[canonical.rootGraph].title).toBe('Canonical');
  });

  it('returns null for a falsy root rather than reading the cwd', () => {
    expect(readArchitectureForProject('')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify they fail** — `npx vitest run test/unit/conduit-fs.test.ts`
  Expected: FAIL (`readArchitectureForProject` not exported).

- [ ] **Step 3: Implement the helper** in `electron/conduit-fs.ts`:

```ts
import { restoreArchitecture } from '../src/architecture';

/**
 * Read a project's architecture for the canvas, with one-way legacy migration:
 * prefer the canonical `.conduit/architecture.json`; if it's absent/invalid, fall
 * back to the legacy bare `<root>/architecture.json` (which the next save rewrites
 * into `.conduit/`). `null` when neither yields a valid doc — the caller seeds.
 * A falsy root yields `null` (never reads the cwd).
 */
export function readArchitectureForProject(projectRoot: string): ArchDoc | null {
  if (!projectRoot) return null;
  const canonical = readArchitectureArtifactFile(projectRoot);
  if (canonical) return canonical;
  return restoreArchitecture(readBlob(path.join(projectRoot, 'architecture.json')));
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run test/unit/conduit-fs.test.ts` → PASS.

- [ ] **Step 5: Commit** (conductor handles git; in this loop, skip — leave staged tree).

---

### Task 2: Wire the host IPC handlers onto the persistence layer

**Files:**
- Modify: `electron/main.ts` (the `requestArchitecture` + `updateArchitecture` cases; imports)

- [ ] **Step 1: Replace the two handler cases.** Swap legacy bare-file read/write for
  the persistence layer, with write-error propagation to the `{ type:'error' }` channel:

```ts
case 'requestArchitecture':
  send({
    type: 'architecture',
    path: m.path,
    doc: readArchitectureForProject(m.path),
  });
  break;
case 'updateArchitecture':
  writeArchitectureArtifactFile(m.path, m.doc).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Failed to write .conduit/architecture.json:', message);
    send({ type: 'error', message: `Could not save architecture: ${message}` });
  });
  break;
```

- [ ] **Step 2: Update imports** in `electron/main.ts` — add
  `readArchitectureForProject, writeArchitectureArtifactFile` from `./conduit-fs`. Remove
  the now-unused `restoreArchitecture, serializeArchitecture` import from `../src/architecture`
  if nothing else uses them (grep first; the board/other code may not).

- [ ] **Step 3: Typecheck both tsconfigs** — `npm run typecheck`. Expected: PASS.

---

### Task 3: Gates + runtime proof

- [ ] **Step 1:** `npm run verify` → tee to `.autoloop/evidence/conduit-canvas-verify.log`. Green.
- [ ] **Step 2:** `npm run build` → append to the same log. Exit 0.
- [ ] **Step 3:** Host-temp round-trip already covered by Task 1 tests (write → read-back
  equals; envelope on disk). Record observations to `.autoloop/evidence/conduit-canvas-runtime.txt`.
- [ ] **Step 4:** In-preview canvas no-regression (mock bridge path unchanged) — note in runtime evidence.

---

## Self-Review

- **Spec coverage:** AC1 (`.conduit/` read), AC2 (legacy migration + prose), AC3 (null),
  AC6 (precedence) → Task 1 tests. AC4 (envelope write round-trip), AC5 (error surfacing) →
  Task 1 round-trip test (already in conduit-fs.test.ts) + Task 2 handler. AC7 (no real
  `.conduit/` in repo) → all FS tests use `mkdtempSync` temp dirs. Covered.
- **Placeholder scan:** none — all code shown.
- **Type consistency:** `readArchitectureForProject` / `writeArchitectureArtifactFile` /
  `restoreArchitecture` / `readBlob` / `ArchDoc` names match the existing module.

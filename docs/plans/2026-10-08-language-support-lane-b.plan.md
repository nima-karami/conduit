# Plan: language support — Lane B (C# via csharp-ls)

Spec: [docs/specs/2026-10-08-language-support.md](../specs/2026-10-08-language-support.md) §2.6,
§7 Lane B. Decisions: [goal.md](../runs/2026-10-08-language-support/goal.md) (D1, D6).

**Tier: FULL** — new public seam (`RootProbe.list`, marker grammar), two new generic registry
fields, host + renderer + CI + e2e. One executor, serial (the registry is a shared entry file).

## Locked decisions

- **DOTNET_ROOT realpath lives in `resolveToolDir`, not `childEnv`.** `findBinary` already
  returns `ctx.realpath(candidate)`, so `dirname(findBinary('dotnet', …))` IS the real dotnet dir
  (Homebrew/`/usr/bin` symlinks resolved). `childEnv` stays sync and pure: `DOTNET_ROOT = toolDir`
  when unset. No signature change to `LanguageServerSpec.childEnv`.
- **`requiresMarker` and `watchIgnoreDirs` are required fields** on `LanguageServerSpec` (Go:
  `false` / `[]`), so a future server cannot forget to decide.
- **Marker grammar:** exact basename, or `*.<ext>` where ext matches `[^*?/\\[\]{}]+`; anything
  else throws in `compileRootMarker`. Pattern compare is case-insensitive with a non-empty stem;
  exact stays case-sensitive.
- **Listing:** `resolveServerRoot` lists a directory only when the spec has a pattern marker, at
  most once per ancestor (one lazy `list` shared by the workspace and module checks).
- **Trust prompt `runsTools`** = `registry.map(s => s.runsTools).join(' · ')`, computed in
  `LspManager.raisePrompt`; headline still the requesting spec's `displayName`.
- **Palette trust language:** pure `trustLanguageFor(languageId, langs)` in `webview/lsp-status.ts`
  (served active language, else `langs[0]`); `app.tsx` passes `langFromPath(activeFilePath)`.
- **CI (D1):** csharp-ls `0.28.0` (latest stable; measured: its nupkg ships `tools/net10.0`,
  `runtimeconfig` `Microsoft.NETCore.App 10.0.0`). The runner's preinstalled SDK set is not
  something this repo controls, so the shard installs `actions/setup-dotnet@v4` `10.0.x` before
  `dotnet tool install --global csharp-ls --version 0.28.0` — the same shape as the gopls step's
  `setup-go`. B3/B4 therefore gate; no remote exclusion.
- **Two scenarios, not one (deviation from §7's single `csharp-lsp`).** The harness deadline is
  200 s per scenario (`test/e2e/run-smoke.mjs` `DEADLINE_MS`); B3's ready ceiling (180 s) plus B4's
  idle wait (`IDLE_GRACE_MS` 60 s + 10 s) cannot share one. `csharp-lsp` = B1, B2, B3, B6 + no
  orphans after quit; `csharp-lsp-idle` = B4 idle stop. Both CI-installed, both in the timings seed.

## File map

| File | Change |
|---|---|
| `src/lsp-registry.ts` | `requiresMarker`, `watchIgnoreDirs` fields; `CSHARP_SERVER`; `compileRootMarker`; `compileWatchGlobs(globs, ignoreDirs = [])`; pattern-aware `isRootMarker` |
| `src/lsp-root.ts` | `RootProbe.list`; pattern-aware `anyExists` w/ per-dir lazy list; `requiresMarker` → `null` |
| `electron/main.ts` | probe `list` (`fs.promises.readdir`, `[]` on error); pass `spec.watchIgnoreDirs` |
| `electron/lsp-manager.ts` | `raisePrompt` `runsTools` registry-wide |
| `webview/lsp-status.ts` | `trustLanguageFor` |
| `webview/app.tsx` | palette trust uses `trustLanguageFor(langFromPath(activeFilePath) …)` |
| `test/unit/lsp-registry.test.ts`, `lsp-root.test.ts`, `lsp-binary.test.ts`, `lsp-manager.test.ts`, `lsp-status.test.ts` | AC-B5/B6 units |
| `.github/workflows/e2e.yml` | setup-dotnet + pinned csharp-ls when a shard runs `csharp-lsp`/`csharp-lsp-idle` |
| `test/e2e/csharp-lsp.e2e.mjs`, `test/e2e/csharp-lsp-idle.e2e.mjs`, `test/e2e/csharp-fixture.mjs` | scenarios + shared fixture/process helpers |
| `test/e2e/timings.seed.json` | seed entries for both scenarios |

`test/e2e/core-smoke.json` unchanged (core set is the 4 always-run basics; a ~minute-long
dotnet scenario does not belong there). Coverage map is the nightly artifact — a new scenario is
selected by `--affected` via the `test/e2e/` full trigger until a nightly credits it.

## Contracts

```ts
// src/lsp-root.ts
interface RootProbe { exists(p): Promise<boolean>; realpath(p): Promise<string>; list(dir: string): Promise<string[]> }
resolveServerRoot(file, roots, spec: Pick<LanguageServerSpec,'languageId'|'rootMarkers'|'requiresMarker'>, probe, platform)
// src/lsp-registry.ts
export function compileRootMarker(marker: string): (base: string) => boolean   // throws `unsupported root marker: …`
export function compileWatchGlobs(globs: readonly string[], ignoreDirs: readonly string[] = []): (rel: string) => boolean
export const CSHARP_SERVER: LanguageServerSpec
// webview/lsp-status.ts
export function trustLanguageFor(languageId: string | null, langs: readonly LspLanguageInfo[]): LspLanguageInfo | undefined
```

## Producer/consumer

- Root markers: registry (produce) → `lsp-root` resolve + `isRootMarker` (main.ts watcher) +
  `languageInfo().moduleMarker` (nav-outcome ad-hoc note; never rendered for C# because
  `requiresMarker` means never ad-hoc). All touched.
- `RootProbe`: constructed in `electron/main.ts` and tests only (grep `exists:`/`RootProbe`).
- Watch filter: `compileWatchGlobs` called by main.ts `watchRoot` and tests only.
- Trust prompt `runsTools`: `raisePrompt` → `lsp:trust` → `trust-prompt.tsx` renders as-is.
- Palette trust language: `app.tsx` → `requestTrust` → host `requestTrust` (unchanged).

## Slices

1. **Registry + root (T1–T3)** — check: `npx vitest run test/unit/lsp-registry.test.ts
   test/unit/lsp-root.test.ts test/unit/lsp-binary.test.ts test/unit/lsp-watcher.test.ts`.
2. **Host + renderer wiring (T4–T5)** — check: `lsp-manager.test.ts`, `lsp-status.test.ts`,
   `npm run typecheck`.
3. **CI + e2e (T6)** — check: `npm run e2e:remote -- csharp-lsp csharp-lsp-idle go-lsp`.
4. Gate: `npm run verify` exit 0.

Red first in each slice: the AC-B5/B6 tests fail before the change.

**Deviation rule:** if a task's assumption is wrong (e.g. csharp-ls cannot run on the runner even
with setup-dotnet), that task stops and fixing the misaligned piece becomes the work — never a
shim, special case, `csharp` branch downstream, or a weakened assertion. Only then fall back to
D1's remote-exclusion path, with the measured reason.

#1 Coverage: ok (B1–B6 + CI line mapped to slices 1–3)
#2 Placeholder scan: ok
#3 Signature consistency: ok
#4 Placement: ok
#5 Caller scan: ok (every export has its caller in the same slice)
#6 Producer/consumer: ok
#7 Handoff arithmetic: ok

PLAN: docs/plans/2026-10-08-language-support-lane-b.plan.md
TIER: FULL
SLICES: 4
GROUPS: 1
CLAIMS: src/lsp-registry.ts, electron/main.ts, webview/app.tsx, .github/workflows/e2e.yml
SCRIPT_CANDIDATES: 0

# Gate baseline — written before any mutating command

**Base commit:** `f00a90c` (`chore: ground the gate before the html-viewer run`)
**Branch:** `feat/html-preview`
**Captured:** 2026-09-18, before the first edit of Slice 1.

## Gate result at the base commit

`npm run verify` → **exit 0**, with nothing else running.

Chain, in order: `biome check` → `tsc -p tsconfig.json` → `tsc -p tsconfig.webview.json`
→ `node esbuild.mjs` → `vitest run` → `fallow --skip health` → `npm audit --audit-level=high`
→ `security-scan` → `secret-scan`.

**Failure set: empty.**

Known-tolerated, not failures: biome reports **16 warnings** (descending-specificity CSS
selectors, one `useOptionalChain` in `webview/terminal-bus.ts:106`); `npm audit` reports **2
moderate** advisories (dompurify via monaco-editor, needs a monaco major) which do not trip
`--audit-level=high`.

Any check appearing in a later run's failure set that is not listed above belongs to the slice
until reproduced at `f00a90c`.

## Gate definition hashes (sha1, first 12)

| Hash | File |
|---|---|
| `55113cc61f09` | `vitest.config.ts` |
| `c4375bb1f8c5` | `biome.json` |
| `b2b91ce41ec1` | `package.json` |
| `da2630629b7e` | `tsconfig.json` |
| `28bbbd7cfd6b` | `tsconfig.webview.json` |
| `9237221ec9ef` | `.github/workflows/verify.yml` |
| `0b423080587e` | `tools/security-scan.mjs` |
| `8cf5177f3ac0` | `tools/secret-scan.mjs` |

## Existing test corpus

- `test/unit/*.test.ts`: **258 files**
- Concatenated sha1 (first 12): **`b32736828161`**

Step 6's anti-gaming diff re-computes these. A changed config hash, or a *shrinking* test
corpus, fails the task. New test files are expected and fine — the concatenated hash will change
for that reason, so the check is: config hashes identical, file count ≥ 258, and no existing
test weakened (verified by `git diff` on `test/unit/`, not by the hash alone).

## `vitest.config.ts` note

That file was deliberately changed in the base commit itself (`testTimeout` 5 s → 20 s, with its
reasoning in the commit message and in `report.md`). Its hash above is the **post-change**
value, so any further change to it during this run shows up as a diff.

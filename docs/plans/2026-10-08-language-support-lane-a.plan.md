# Language support, Lane A (renderer + file service) — implementation plan

**Spec:** `docs/specs/2026-10-08-language-support.md` (§2.1–2.5, §2.7, §3, AC-A1…A9)  **Tier:** FULL
(spec is FULL; host + renderer + theme seams, new DTO fields)

## Goal
Logs, goldens and rotated logs resolve and paint correctly on first frame; text files round-trip
byte-exact (BOM kept, invalid UTF-8 / mixed-EOL goldens read-only); oversized files are read through
a bounded window (tail for logs); Markdown source folds by heading.

## Architecture
All language decisions stay in `src/lang.ts` (shared host/renderer). The host's `readFile` becomes
the only producer of the new DTO flags (`window`, `readOnlyReason`); the renderer reads them in one
pure helper (`webview/read-only-doc.ts`) so `code-viewer.tsx` has a single notion of "read-only and
why". BOM fidelity is fixed at the producer of save text — the `SaveModel` adapter in
`webview/file-saves.ts` — never per call site in `file-save-controller.ts`.

## Data flow
```
path ─ langFromPath/isGoldenPath (src/lang.ts) ─┬─ host readFile (src/file-service.ts)
                                                │    stat → ≤cap: readFile → isUtf8 / EOL scan
                                                │         >cap: open+read window (head|tail)
                                                │    → FileContentDTO{truncated, window?, readOnlyReason?}
                                                │       → IPC fileContent → app.tsx files map (untouched)
                                                │          → doc-view DocBody (golden → CodeViewer)
                                                │             → code-viewer: readOnlyNotice(doc) → readOnly,
                                                │                banner, fileSaves.attach(writable), tail reveal
                                                └─ renderer: ensureTokenizer(log) / diff-viewer / review hljs
model ─ file-saves getModel adapter getValue(TextDefined, BOM) ─ file-save-controller ─ host writeFile
disk change (agent append) ─ OpenFileWatcher (log: 1 s trailing throttle) ─ fileChanged ─ app.tsx re-read
```

## Settled decisions — do not re-litigate
- D2 invalid UTF-8 read-only for every file; D3 mixed EOL read-only for goldens only; D4 >cap log
  shows its tail; D5 line navigation into a tail window toasts and shows the end (no mapping).
- Golden strips exactly one `.golden`; goldens never render (always code editor).
- Tail windows are read-only (A4). Change markers stay ON for `readOnlyReason`, OFF for `truncated`.
- Level colours via new `--syn-error` / `--syn-warn` in `:root`, `aero`, `neon` blocks.

## Spec staleness
- §2.4 "`file-saves.ts:14` binds the raw Monaco model" — measured true (`webview/file-saves.ts:14`).
- §2.2 logcat "anchored at line start" — Monarch honours a leading `^` only as
  `matchOnlyAtLineStart` (`monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js:374`);
  it does NOT honour RegExp flags (`compileRegExp` rebuilds from `.source`), so case-insensitive level
  words are built as per-letter classes, keeping the case-sensitive exception-headline rule intact.

## Global constraints
- Gate: `npm run verify` (full, exit code captured directly). Inner loop: related vitest files +
  `npm run verify:quick`.
- WHY-only comments; link the spec (`see spec 2026-10-08-language-support §2.5`) instead of restating.
- Two tsconfigs (host + webview) — `src/lang.ts`/`src/protocol.ts` are compiled by both.
- CI is ubuntu: no platform-dependent path handling in tests (use `path.join` on temp dirs only).
- Copy strings live in `webview/auto-save-copy.ts`.
- Never touch lane B files: `src/lsp-*.ts`, `electron/main.ts`, `electron/lsp-manager.ts`,
  `webview/components/trust-prompt.tsx`, `webview/app.tsx`.

## Out of scope
Lane B (C# LSP). Live follow, encoding picker. LSP sync of goldens (input built in `app.tsx`, see
Decisions Needed).

## Contracts
```ts
// src/lang.ts
export function langFromPath(p: string): string;          // + 'log', golden, rotated logs
export function isGoldenPath(p: string): boolean;          // basename ends with '.golden' (ci)
// DISPLAY_NAMES.log = 'Log'

// src/protocol.ts FileContentDTO (+ optional fields)
window?: 'tail';                                           // only with truncated:true
readOnlyReason?: 'invalid-utf8' | 'mixed-eol';             // only on non-truncated text

// src/file-service.ts
export async function readFile(absPath: string, cap = MAX_BYTES): Promise<FileContentDTO>;
export function eolKinds(buf: Uint8Array): number;         // count of distinct EOL kinds (0..3)

// webview/log-grammar.ts
export const log: Grammar;                                 // Grammar from ./gomod-grammar

// webview/markdown-folding.ts (monaco-free)
export interface FoldRange { start: number; end: number; kind?: 'region' }
export function markdownFoldingRanges(lines: readonly string[]): FoldRange[]; // 1-based lines

// webview/read-only-doc.ts
export function readOnlyNotice(
  doc: Pick<FileContentDTO, 'truncated' | 'window' | 'readOnlyReason' | 'binary'>,
): string | null;                                          // banner copy, null = writable

// webview/auto-save-copy.ts (AUTO_SAVE_COPY additions)
tailBanner, invalidUtf8Banner, mixedEolBanner: string; tailLine(line: number): string;

// electron/open-file-watcher.ts: '.log'-language paths fire at most once per LOG_THROTTLE_MS
// (1000) on the trailing edge; other paths keep the 150 ms debounce.
```
Invariants: for `stat.size > cap` `readFile` never calls `fs.promises.readFile` and allocates ≤ cap;
a tail window never starts mid-line (cut through the first `\n`; a window with no `\n` is kept).

## Producer/consumer map
| Behavior changed | Produced by | Consumed by | Sides touched |
|---|---|---|---|
| language id (`log`, golden) | `src/lang.ts` | host readFile, code-viewer, diff-viewer, review hljs, doc-view, lsp-sync input (app.tsx) | both; lsp-sync unchanged (Decisions Needed) |
| `window` / `readOnlyReason` | `src/file-service.ts` readFile | `code-viewer.tsx` via `read-only-doc.ts`; other host readers (`electron/main.ts:636`, `src/module-resolver-fs.ts:229`, `src/git-history.ts`) read `content` only — optional fields ignored | both |
| save text with BOM | `webview/file-saves.ts` adapter | `file-save-controller.ts` (compare + write), host `writeFile`/`compareOnDisk` (toString keeps BOM) | producer; consumer unchanged by design |
| log re-read cadence | `electron/open-file-watcher.ts` | app.tsx `fileChanged` → readFile (unchanged) | producer |
| fold ranges for markdown | `markdown-folding.ts` via `monaco-languages.ts` | Monaco folding controller | both |

## File map
| Path | Action | Responsibility |
|---|---|---|
| `src/lang.ts` | modify | log id, golden + rotated rules, `isGoldenPath`, display name |
| `src/protocol.ts` | modify | DTO fields |
| `src/file-service.ts` | modify | bounded window read, UTF-8 / EOL checks |
| `webview/log-grammar.ts` | create | Monarch log grammar |
| `webview/markdown-folding.ts` | create | pure heading/region/fence folding |
| `webview/monaco-languages.ts` | modify | register `log`, grammar, markdown folding provider |
| `webview/monaco-theme.ts` | modify | `log-error/warn/info` rules, `comment.log` upright |
| `webview/styles.css` | modify | `--syn-error`, `--syn-warn` in three blocks |
| `webview/syntax-highlight.ts` | modify | `log` → null if the completeness test requires it |
| `webview/file-saves.ts` | modify | BOM-preserving SaveModel adapter + rename copy |
| `webview/read-only-doc.ts` | create | read-only notice from DTO |
| `webview/auto-save-copy.ts` | modify | new banners / toast copy |
| `webview/components/code-viewer.tsx` | modify | readOnly from notice, tail open-at-end / reveal toast / append |
| `webview/components/doc-view.tsx` | modify | golden → CodeViewer, `docPage` false |
| `electron/open-file-watcher.ts` | modify | log throttle |
| `test/unit/{lang,log-grammar,markdown-folding,file-service,file-save-controller,read-only-doc,theme-tokens,open-file-watcher}.test.ts` | create/modify | units below |
| `test/e2e/language-files.e2e.mjs` | create | AC-A1…A6b, A9 runtime |

## Scripts
None — no repeated mechanical edit; fixtures are generated inside the e2e.

## Slices
### Slice 1: language resolution + log grammar + theme tokens
**Check:** `npx vitest run test/unit/lang.test.ts test/unit/log-grammar.test.ts test/unit/theme-tokens.test.ts test/unit/syntax-highlight.test.ts`
- T1.1 `src/lang.ts`: tests for every §2.1 example (`expected.json.golden`→json, `out.txt.golden`→plaintext,
  `x.golden`, `a.golden.golden`, `app.log.1`, `App.Log.1`, `app.log.2026-10-01_13`, `app.log.1.gz`→plaintext,
  `UPPER.LOG`), `isGoldenPath`, `languageDisplayName('log')==='Log'`.
- T1.2 `webview/log-grammar.ts` + test (gomod-test interpreter extended with `^` = line-start only):
  each §2.2 row, negatives `errors=0`, `terror`, `I/O error` (not logcat), `don't` not a string.
- T1.3 theme: styles.css tokens, `FOREGROUNDS` += both, test that each is declared in all three blocks;
  monaco-theme rules; monaco-languages registration.

### Slice 2: host bounded read + UTF-8/EOL flags
**Check:** `npx vitest run test/unit/file-service.test.ts`
- Over-cap head/tail windows exact (tail starts after first `\n`; no-`\n` window kept), `fs.promises.readFile`
  spy never called for over-cap, ≤cap unchanged, binary sniff on window, invalid UTF-8 → `invalid-utf8`,
  mixed EOL golden → `mixed-eol`, mixed EOL non-golden → no reason, BOM kept in content.

### Slice 3: save fidelity + read-only rendering
**Check:** `npx vitest run test/unit/read-only-doc.test.ts test/unit/file-save-controller.test.ts` + typecheck
- `read-only-doc.ts` notices per state; file-saves adapter (`getValue(TextDefined, true)`), rename copy;
  code-viewer uses `readOnlyNotice` for readOnly/banner/announcement/attach; markers off only when truncated;
  doc-view golden routing.

### Slice 4: tail behaviours + log throttle
**Check:** `npx vitest run test/unit/open-file-watcher.test.ts` + e2e AC-A6/A6b
- code-viewer: tail opens at end; staged reveal on tail → toast `tailLine(N)` + end; reseed keeps bottom
  if at bottom else scroll, selection collapsed. Watcher throttle 1 s trailing for log paths.

### Slice 5: Markdown heading folding (v1)
**Check:** `npx vitest run test/unit/markdown-folding.test.ts` + e2e AC-A9 assertion
- headings fold to line before next same-or-higher heading (trailing blank lines excluded), `#` in a fence
  ignored, fences fold, `<!-- #region -->`/`<!-- #endregion -->` pairs fold (kind region).

### Slice 6: e2e `language-files`
**Check:** `npm run e2e:remote -- language-files`

## Verification
Per slice: its named vitest files + `npm run verify:quick`. End: `npm run verify` once (exit code
captured directly), then `npm run e2e:remote -- language-files`.

## Deviation rule
If a task's assumption turns out wrong — the piece it builds on is misaligned, a locked signature
doesn't fit reality — that task stops and fixing the misaligned piece becomes the work. Never a
shim, second copy, special case, widened type, or fallback routed around it.

## Decisions Needed
- [normal] Goldens of a served language (`x.go.golden`, later `x.cs.golden`) still reach the LSP doc
  sync as that language: the sync input is built in `webview/app.tsx` (lane B). Default taken: unchanged
  in lane A; integration should filter `isGoldenPath` there.
- [normal] Save-refusal copy for a non-writable doc stays `partialFile` ("only its first 2 MB…"); it is
  reachable only if a read-only buffer is changed programmatically. Default: unchanged.

# Run report — Markdown viewer/renderer + Mermaid improvements

- **Date:** 2026-06-18
- **Branch:** `autoloop/2026-06-18-markdown` (7 commits ahead of `main` @ 933aede;
  clean fast-forward — **not** merged to main, **not** pushed, per the established
  "review autonomous runs before merging" pattern).
- **Conductor model:** claude-opus-4-8[1m]. Subagents: Opus (code review) only.
- **Driver:** autonomous-build-loop. Spec → build (TDD) → verify (gates + runtime
  observation) → integrate, one feature per commit, serialized (all features share
  `markdown-viewer.tsx` + `styles.css`).

## Outcome

All 6 planned features shipped and verified, plus a Phase-0 security baseline fix.
`npm run verify` is green on the integration tip (final run: see
`.autoloop/evidence/` / verify-final.log). 1385 unit tests pass (up from 1353).

## Observation harness (Phase 0)

A standalone preview (`.autoloop/preview/`, gitignored) mounts the **real**
`<MarkdownViewer>` (renderer falls back to a fake shell without `window.agentDeck`),
served over HTTP and driven with playwright-cli — screenshots captured what a user
would see for every feature. This is the honest stop condition; nothing was claimed
"done" on unit tests alone.

## Shipped (with evidence + commit SHAs)

| Feature | Tier | Commit | Evidence |
|---|---|---|---|
| Security baseline (undici 7.28.0 + dompurify 3.4.11; re-greens `npm audit`) | LITE | `bfec88a` | baseline-verify2.log |
| Mermaid diagrams follow the app theme (base theme + themeVariables from CSS vars; re-render on theme change) | LITE | `8a4bb43` | 01-mermaid-theme-{midnight,paper}.png |
| LaTeX math via KaTeX (inline `$…$` + block `$$…$$`; fonts bundled) | LITE | `64f4523` | 02-md-math.png |
| GitHub-style alerts (`[!NOTE/TIP/IMPORTANT/WARNING/CAUTION]`) as themed callouts | LITE | `0305885` | 03-md-alerts.png |
| YAML frontmatter → metadata card (mid-doc `---` unaffected) | LITE | `9d65457` | 04-md-frontmatter.png |
| Click-to-zoom Mermaid fullscreen overlay (zoom/pan/reset/Esc; reuses image-zoom math) | FULL | `042c47a` | 05-mermaid-zoom.png |
| Document outline / TOC with scroll-spy (≥3 headings; click-jump; active highlight) | FULL | `f31e1d4` | 06-md-toc.png |

Specs: `docs/specs/2026-06-18-*.md` (indexed in `docs/specs/INDEX.md`). Both FULL
features got an independent Opus code review; findings were applied (mermaid-zoom:
use shared `clampZoom`; md-toc: guard the scroll-spy active index when no heading
resolves).

### Bonus fix surfaced by md-toc

`SlugFactory` accumulated dedup state across React re-renders, so heading ids
re-suffixed every render (`x` → `x-1` → …) — a latent bug that broke heading anchors
after any re-render. Fixed with `SlugFactory.reset()` (called once per render);
heading ids are now deterministic and stable.

## Known limitations (documented, not defects)

- **md-math `$`-currency collision:** `$5 and $10` on one prose line parses as math —
  the standard remark-math/micromark semantic (GitHub, Obsidian, Jupyter all do this).
  Escape with `\$` or use View source. See `.autoloop/blockers.md`.

## Not built (queued for a future run)

- **Relative image rendering** (`![](./img.png)`): crosses the host FS/IPC boundary
  (needs the host to load file bytes), so it can't be verified renderer-only and would
  be `needs-human-smoke`. Left out rather than half-built.

## Recommended next step (human)

Review the branch and fast-forward when satisfied:

```
git checkout main && git merge --ff-only autoloop/2026-06-18-markdown
```

No `needs-human-smoke` items: every feature is renderer-only and was verified by
driving the real component in the browser preview. (A pass in the packaged Electron
app is still worthwhile for final visual sign-off, but no host/IPC/PTY boundary was
crossed.)

---
status: active
date: 2026-06-18
tier: LITE
type: UI
---

# YAML frontmatter as a metadata card

## Problem frame

**Job:** Many docs (including this repo's own specs/ADRs) start with a YAML
frontmatter block:

```
---
status: active
date: 2026-06-18
tier: LITE
---
```

Conduit's viewer has no frontmatter handling, so remark renders the leading `---` as
a thematic break (`<hr>`) and the keys as a stray paragraph — visual noise at the top
of every spec/ADR.

**Actor:** anyone opening a `.md` that begins with frontmatter (specs, blog posts,
agent-authored docs, Obsidian notes).

**Success:** leading frontmatter renders as a compact, styled key/value metadata card
at the top of the doc — not an `<hr>` + raw text. Docs without frontmatter are
completely unchanged.

**Non-goals:** editing frontmatter; full YAML spec coverage (anchors, multi-doc,
complex nested maps); TOML/JSON frontmatter.

## Behavior & states

- A YAML frontmatter block (delimited by `---` … `---`) **only at the very start** of
  the document is parsed and rendered as a `div.markdown-frontmatter` containing a
  definition-style list of key → value rows.
- `---` used elsewhere (mid-doc thematic breaks) is **untouched** — remark-frontmatter
  only recognizes a leading block, which is the correct, conservative behavior.
- Scalar values render as text. Flat sequence values (`tags: [a, b]` or a block list)
  render as the raw scalar/inline text (best-effort; not a full YAML renderer).
- Empty/whitespace-only frontmatter (`---\n---`) → no card (nothing to show).

## Data / interface contract

- Add `remark-frontmatter` (unified-team plugin) to parse the block into a `yaml`
  mdast node (added to `package.json` deps for the fallow gate).
- New `webview/md-frontmatter.ts`:
  - `parseFrontmatter(yaml: string): Array<[string, string]>` — a **pure**, minimal
    line-based parser for flat `key: value` pairs (the 95% case). Quoted values are
    unquoted; a key with an empty value followed by `- item` block-list lines collects
    those items into a comma-joined value. Unit-tested. Deliberately NOT a full YAML
    engine — unparseable lines are skipped, never thrown.
  - `remarkFrontmatterCard()` — remark plugin that finds a leading `yaml` node and
    replaces it with a node rendering as `div.markdown-frontmatter` → rows of
    `div.markdown-frontmatter__key` / `__val`. Drops the node if there are no pairs.
- Wire both into `MarkdownViewer` (`remark-frontmatter` must precede the card plugin;
  order in `remarkPlugins`: `[remarkFrontmatter, remarkGfm, remarkMath, remarkAlerts,
  remarkFrontmatterCard]`).

## Edge cases & failure modes

- **No frontmatter** → no `yaml` node exists; plugins are no-ops; doc byte-identical
  to before. (regression-critical — the most common case)
- **`---` thematic breaks mid-doc** → still render as `<hr>`. (remark-frontmatter
  scopes to the leading block.)
- **Malformed YAML** → minimal parser skips unrecognized lines; never throws/blanks
  the doc.
- **Frontmatter with a nested map** → nested keys best-effort flattened or shown as
  raw; never crash.
- **CRLF line endings** → parser tolerates `\r`.

## Defaults vs. settings

No setting — render the card always. Rationale: it's strictly better than a stray
`<hr>`; the source view still shows raw frontmatter when wanted.

## Accessibility / i18n

- The card is a `<dl>`-style structure (key/value) so the relationship is semantic.
  Keys are author content (not localized).

## Scope slicing

- **MVP:** flat `key: value` + simple block lists → metadata card; mid-doc `---`
  unaffected; no-frontmatter docs unchanged.
- **Out of scope:** nested maps rendering, editing, non-YAML frontmatter.

## Acceptance criteria

- AC1: A doc starting with frontmatter (`status`, `date`, `tags`) renders a
  `.markdown-frontmatter` card with those key/value rows and **no** leading `<hr>` or
  raw `status:` text. (playwright + assert `.markdown-frontmatter` exists, no leading
  `<hr>`)
- AC2: A doc with a mid-document `---` thematic break still renders an `<hr>` there.
  (playwright)
- AC3: A doc with NO frontmatter is unchanged — no `.markdown-frontmatter`, same
  content as before. (playwright)
- AC4: `parseFrontmatter` returns correct pairs for flat scalars, quoted values, and
  a simple block list; skips malformed lines without throwing. (unit)
- AC5: `npm run verify` green.

## Decisions Needed

none — minimal-parser tradeoff (cover the common case, degrade gracefully) chosen
deliberately for LITE tier; a full YAML dep can come later if demand appears.

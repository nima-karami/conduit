import { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';

/**
 * Sanitize schema for rendered markdown (the `rehype-raw` → `rehype-sanitize` pair that
 * lets README-style raw HTML render safely). Extends GitHub's default schema — the same
 * one GitHub uses for READMEs — which already permits `<div>`/`<img>`/`<details>`/`<sub>`
 * and the global `align`/`width`/`height`/`alt`/`open` attributes, while stripping
 * `<script>`/`<iframe>`, event handlers (`onerror`…), and `javascript:` URLs.
 *
 * The one thing we must add: sanitize runs BEFORE rehype-highlight and rehype-katex (so
 * their generated output stays trusted), which means their *input* classNames have to
 * survive sanitization — `language-*` on `<code>` and `math-inline`/`math-display` on the
 * math `<span>`/`<div>` placeholders. Without these, code stops highlighting and math
 * renders as raw TeX. See the react-markdown + KaTeX + sanitize guidance.
 *
 * The frontmatter card (`remarkFrontmatterCard`) is the same situation: it is a REMARK
 * plugin, so its `markdown-frontmatter*` classNames also reach sanitize as input. Without
 * them the card still rendered, stripped of every class — so a skill file's `name:` and
 * `description:` ran together as one unstyled blob.
 *
 * We also add `data:` to the `src` protocol allow-list so an inline base64 image
 * (`![](data:image/png;base64,…)` — exactly how an agent embeds a chart in a report)
 * survives sanitization. `src` only lands on `<img>` here (`<script>`/`<iframe>` are
 * stripped entirely), and an SVG loaded via `<img src=data:…>` cannot execute script, so
 * this adds no XSS surface; `javascript:` is still absent from the list and thus stripped.
 */
export const markdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ['className', 'math-inline', 'math-display', /^markdown-frontmatter__/],
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ['className', 'math', 'math-display', 'markdown-frontmatter', /^markdown-frontmatter__/],
    ],
    // The link target `rehypePreserveLinkTarget` stashed before this ran. `href` itself keeps
    // the default protocol policy — this is a data-* attribute, which no browser will follow,
    // so carrying a `file://` or `C:/…` target here makes it readable by our own link
    // component without making it reachable. See md-link-target.ts.
    a: [...(defaultSchema.attributes?.a ?? []), 'dataMdHref'],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), 'data'],
  },
};

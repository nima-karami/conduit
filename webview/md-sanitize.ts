import { defaultSchema } from 'rehype-sanitize';

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
 */
export const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', 'math-inline', 'math-display']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className', 'math', 'math-display']],
  },
};
